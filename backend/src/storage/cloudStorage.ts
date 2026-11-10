import fs from 'node:fs/promises';
import path from 'node:path';

interface BatchDownloadResponse {
  errcode: number;
  errmsg: string;
  file_list?: Array<{
    fileid: string;
    download_url: string;
    status: number;
    errmsg: string;
  }>;
}

interface UploadFileMetaResponse {
  errcode: number;
  errmsg: string;
  url: string;
  token: string;
  authorization: string;
  file_id: string;
  cos_file_id: string;
}

interface BatchDeleteResponse {
  errcode: number;
  errmsg: string;
  delete_list?: Array<{
    fileid: string;
    status: number;
    errmsg: string;
  }>;
}

const BATCH_DELETE_LIMIT = 50;

/**
 * 微信云托管容器内部可直接免 access_token 调用 api.weixin.qq.com/tcb/* 开放接口
 * 参考微信云托管文档：开放接口服务（云调用）
 */
const WX_OPENAPI_BASE = process.env.WX_OPENAPI_BASE || 'http://api.weixin.qq.com';

export function extractEnvFromFileId(fileId: string): string {
  // cloud://prod-xxx.7072-prod-xxx-123/path/to/file
  const match = /^cloud:\/\/([^.]+)\./.exec(fileId);
  return match ? match[1] : '';
}

export async function downloadFromCloudBase(env: string, fileId: string, destPath: string): Promise<void> {
  const res = await fetch(`${WX_OPENAPI_BASE}/tcb/batchdownloadfile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      env,
      file_list: [{ fileid: fileId, max_age: 7200 }],
    }),
  });

  if (!res.ok) {
    throw new Error(`云存储获取下载链接失败 (HTTP ${res.status})`);
  }

  const data = (await res.json()) as BatchDownloadResponse;
  if (data.errcode !== 0 || !data.file_list?.length) {
    throw new Error(`云存储 batchdownloadfile 错误: ${data.errmsg || data.errcode}`);
  }

  const item = data.file_list[0];
  if (item.status !== 0 || !item.download_url) {
    throw new Error(`云存储文件不可用: ${item.errmsg || item.fileid}`);
  }

  const fileRes = await fetch(item.download_url);
  if (!fileRes.ok) {
    throw new Error(`拉取云存储文件失败 (HTTP ${fileRes.status})`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(arrayBuffer));
}

export async function uploadToCloudBase(
  env: string,
  localPath: string,
  cloudPath: string
): Promise<{ fileId: string }> {
  const metaRes = await fetch(`${WX_OPENAPI_BASE}/tcb/uploadfile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      env,
      path: cloudPath,
    }),
  });

  if (!metaRes.ok) {
    throw new Error(`云存储获取上传凭证失败 (HTTP ${metaRes.status})`);
  }

  const meta = (await metaRes.json()) as UploadFileMetaResponse;
  if (meta.errcode !== 0 || !meta.url) {
    throw new Error(`云存储 uploadfile 错误: ${meta.errmsg || meta.errcode}`);
  }

  const fileBytes = await fs.readFile(localPath);
  const form = new FormData();
  form.append('key', cloudPath);
  form.append('Signature', meta.authorization);
  form.append('x-cos-security-token', meta.token);
  form.append('x-cos-meta-fileid', meta.cos_file_id);
  form.append('file', new Blob([fileBytes]), path.basename(localPath));

  const uploadRes = await fetch(meta.url, {
    method: 'POST',
    body: form,
  });

  if (!uploadRes.ok && uploadRes.status !== 204) {
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`上传结果至云存储 COS 失败 (HTTP ${uploadRes.status}): ${errText.slice(0, 200)}`);
  }

  return { fileId: meta.file_id };
}

export async function deleteFromCloudBase(defaultEnv: string, fileIds: string[]): Promise<number> {
  const uniqueCloudIds = Array.from(
    new Set(fileIds.filter((id) => typeof id === 'string' && id.startsWith('cloud://')))
  );
  if (uniqueCloudIds.length === 0) {
    return 0;
  }

  const groupedByEnv = new Map<string, string[]>();
  for (const fileId of uniqueCloudIds) {
    const envId = extractEnvFromFileId(fileId) || defaultEnv;
    if (!envId) continue;
    const list = groupedByEnv.get(envId);
    if (list) {
      list.push(fileId);
    } else {
      groupedByEnv.set(envId, [fileId]);
    }
  }

  let deletedCount = 0;

  for (const [envId, envFileIds] of groupedByEnv.entries()) {
    for (let i = 0; i < envFileIds.length; i += BATCH_DELETE_LIMIT) {
      const chunk = envFileIds.slice(i, i + BATCH_DELETE_LIMIT);
      const res = await fetch(`${WX_OPENAPI_BASE}/tcb/batchdeletefile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: envId,
          fileid_list: chunk,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(
          `云存储批量删除失败 (HTTP ${res.status})${errText ? `: ${errText.slice(0, 120)}` : ''}`
        );
      }

      const data = (await res.json()) as BatchDeleteResponse;
      if (data.errcode !== 0) {
        throw new Error(`云存储 batchdeletefile 错误: ${data.errmsg || data.errcode}`);
      }

      if (Array.isArray(data.delete_list) && data.delete_list.length > 0) {
        deletedCount += data.delete_list.filter((item) => item.status === 0).length;
      } else {
        deletedCount += chunk.length;
      }
    }
  }

  return deletedCount;
}
