import type {
  OutputFileRef,
  PdfInspectResponse,
  TaskRecord,
  ToolId,
  ToolParams,
  UploadedFileRef,
} from '@tool-universal/shared';
import { APP_ENV, isCloudRunConfigured } from '@/config/env';

export interface LocalPickedFile {
  id: string;
  name: string;
  size: number;
  path: string;
  mimeType?: string;
  /** Available in H5 when picked via <input type="file"> */
  browserFile?: File;
}

export function initCloudEnv(): void {
  // #ifdef MP-WEIXIN
  if (APP_ENV.USE_CLOUDRUN && typeof wx !== 'undefined' && wx.cloud && isCloudRunConfigured()) {
    wx.cloud.init({
      env: APP_ENV.CLOUD_ENV_ID,
      traceUser: true,
    });
  }
  // #endif
}

function isWeixinDevtools(): boolean {
  // #ifdef MP-WEIXIN
  try {
    const info =
      typeof wx !== 'undefined' && typeof (wx as any).getDeviceInfo === 'function'
        ? (wx as any).getDeviceInfo()
        : uni.getSystemInfoSync();
    return info?.platform === 'devtools';
  } catch {
    return false;
  }
  // #endif
  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

function shouldUseDevtoolsLocalBackend(): boolean {
  // #ifdef MP-WEIXIN
  return (
    APP_ENV.USE_CLOUDRUN &&
    !isCloudRunConfigured() &&
    Boolean(APP_ENV.DEV_LOCAL_API_BASE) &&
    isWeixinDevtools()
  );
  // #endif
  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

function getHttpBaseUrl(): string {
  // #ifdef MP-WEIXIN
  if (shouldUseDevtoolsLocalBackend()) {
    return APP_ENV.DEV_LOCAL_API_BASE;
  }
  return APP_ENV.HTTPS_API_BASE;
  // #endif
  // #ifndef MP-WEIXIN
  return APP_ENV.H5_API_BASE;
  // #endif
}

export async function callBackendApi<T = any>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  data?: any
): Promise<T> {
  // #ifdef MP-WEIXIN
  if (APP_ENV.USE_CLOUDRUN && !isCloudRunConfigured() && !shouldUseDevtoolsLocalBackend()) {
    throw new Error('尚未在 src/config/env.ts 配置微信云托管环境 ID（CLOUD_ENV_ID），暂无法调用云端引擎；纯离线图像工具可直接使用');
  }
  if (isCloudRunConfigured() && typeof wx !== 'undefined' && wx.cloud) {
    const res = await wx.cloud.callContainer({
      config: { env: APP_ENV.CLOUD_ENV_ID },
      path,
      method,
      header: {
        'X-WX-SERVICE': APP_ENV.CLOUD_SERVICE_NAME,
        'content-type': 'application/json',
      },
      data,
    });
    if (res.statusCode >= 400) {
      throw new Error((res.data as any)?.message || `云托管请求失败 (${res.statusCode})`);
    }
    return res.data as T;
  }
  // #endif

  const useDevLocal = shouldUseDevtoolsLocalBackend();
  const url = `${getHttpBaseUrl()}${path}`;
  return new Promise<T>((resolve, reject) => {
    uni.request({
      url,
      method,
      data,
      header: {
        'content-type': 'application/json',
      },
      success: (res) => {
        if (res.statusCode >= 400) {
          reject(new Error((res.data as any)?.message || `请求失败 (${res.statusCode})`));
          return;
        }
        resolve(res.data as T);
      },
      fail: (err) => {
        if (useDevLocal) {
          reject(
            new Error(
              `无法连接本地调试后端 (${APP_ENV.DEV_LOCAL_API_BASE})：请确认 pnpm dev:backend 已启动且开发者工具已开启「不校验合法域名」`
            )
          );
          return;
        }
        reject(new Error(err?.errMsg || '网络连接失败，请确认后端服务是否已启动'));
      },
    });
  });
}

export async function uploadFileToBackend(picked: LocalPickedFile): Promise<UploadedFileRef> {
  // #ifdef MP-WEIXIN
  if (APP_ENV.USE_CLOUDRUN && !isCloudRunConfigured() && !shouldUseDevtoolsLocalBackend()) {
    throw new Error('尚未在 src/config/env.ts 配置微信云托管环境 ID（CLOUD_ENV_ID），暂无法上传至云端处理');
  }
  if (isCloudRunConfigured() && typeof wx !== 'undefined' && wx.cloud) {
    const safeName = picked.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
    const cloudPath = `tmp-inputs/${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safeName}`;
    const res = await wx.cloud.uploadFile({
      cloudPath,
      filePath: picked.path,
    });
    return {
      fileId: res.fileID,
      fileName: picked.name,
      size: picked.size,
      mimeType: picked.mimeType,
      source: 'cloudbase',
    };
  }
  // #endif

  // H5 multipart upload via native fetch when File object is present
  if (picked.browserFile) {
    const form = new FormData();
    form.append('file', picked.browserFile, picked.name);
    const res = await fetch(`${getHttpBaseUrl()}/api/files/upload`, {
      method: 'POST',
      body: form,
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body?.message || `上传失败 (${res.status})`);
    }
    return body.file as UploadedFileRef;
  }

  const useDevLocal = shouldUseDevtoolsLocalBackend();
  // Fallback uni.uploadFile (App / DevTools local backend / HTTPS ECS)
  return new Promise<UploadedFileRef>((resolve, reject) => {
    uni.uploadFile({
      url: `${getHttpBaseUrl()}/api/files/upload`,
      filePath: picked.path,
      name: 'file',
      formData: {
        originalName: picked.name,
      },
      success: (res) => {
        try {
          const parsed = JSON.parse(res.data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed?.message || `上传失败 (${res.statusCode})`));
            return;
          }
          resolve(parsed.file as UploadedFileRef);
        } catch {
          reject(new Error('解析上传响应失败'));
        }
      },
      fail: (err) => {
        if (useDevLocal) {
          reject(
            new Error(
              `上传至本地后端 (${APP_ENV.DEV_LOCAL_API_BASE}) 失败：请确认 pnpm dev:backend 正在运行且开发者工具已开启「不校验合法域名」`
            )
          );
          return;
        }
        reject(new Error(err?.errMsg || '文件上传失败'));
      },
    });
  });
}

export async function inspectPdfRemote(picked: LocalPickedFile): Promise<PdfInspectResponse> {
  const uploaded = await uploadFileToBackend(picked);
  return callBackendApi<PdfInspectResponse>('/api/pdf/inspect', 'POST', {
    file: uploaded,
  });
}

export async function executeCloudToolTask(
  toolId: ToolId,
  pickedFiles: LocalPickedFile[],
  params: ToolParams | undefined,
  onProgress: (progress: number, stageText: string) => void
): Promise<TaskRecord> {
  onProgress(8, `正在上传文件 (0/${pickedFiles.length})...`);
  const uploadedRefs: UploadedFileRef[] = [];

  for (let i = 0; i < pickedFiles.length; i++) {
    const ref = await uploadFileToBackend(pickedFiles[i]);
    uploadedRefs.push(ref);
    onProgress(10 + Math.round(((i + 1) / pickedFiles.length) * 20), `已上传 ${i + 1}/${pickedFiles.length}`);
  }

  onProgress(32, '正在提交云端任务...');
  const created = await callBackendApi<TaskRecord>('/api/tasks', 'POST', {
    toolId,
    files: uploadedRefs,
    params,
  });

  // Poll task status until completed or failed
  const start = Date.now();
  while (Date.now() - start < 5 * 60 * 1000) {
    const latest = await callBackendApi<TaskRecord>(`/api/tasks/${created.taskId}`, 'GET');
    onProgress(Math.max(35, latest.progress), latest.stageText);

    if (latest.status === 'completed') {
      return latest;
    }
    if (latest.status === 'failed') {
      throw new Error(latest.error || '云端处理失败');
    }

    await new Promise((r) => setTimeout(r, 1200));
  }

  throw new Error('处理超时，请稍后重试或缩小文件体积');
}

export function buildDownloadableUrl(output: OutputFileRef): string {
  if (output.source === 'cloudbase' || output.downloadUrl.startsWith('cloud://') || output.downloadUrl.startsWith('blob:') || output.downloadUrl.startsWith('http')) {
    return output.downloadUrl;
  }
  return `${getHttpBaseUrl()}${output.downloadUrl}`;
}

export async function downloadOutputToLocalPath(output: OutputFileRef): Promise<string> {
  if (output.downloadUrl.startsWith('wxfile://') || output.downloadUrl.startsWith('http://tmp/') || output.downloadUrl.startsWith('blob:')) {
    return output.downloadUrl;
  }

  // #ifdef MP-WEIXIN
  if ((output.source === 'cloudbase' || output.downloadUrl.startsWith('cloud://')) && typeof wx !== 'undefined' && wx.cloud) {
    const res = await wx.cloud.downloadFile({
      fileID: output.downloadUrl,
    });
    return res.tempFilePath;
  }
  // #endif

  const url = buildDownloadableUrl(output);
  return new Promise<string>((resolve, reject) => {
    uni.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode >= 400) {
          reject(new Error(`下载失败 (${res.statusCode})`));
          return;
        }
        resolve(res.tempFilePath);
      },
      fail: (err) => reject(new Error(err?.errMsg || '下载结果失败')),
    });
  });
}
