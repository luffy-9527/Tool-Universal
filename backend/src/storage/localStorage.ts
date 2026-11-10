import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import type { OutputFileRef, UploadedFileRef } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import type { ResolvedInputFile, StorageProvider } from './index.js';
import { downloadFromCloudBase, extractEnvFromFileId, uploadToCloudBase } from './cloudStorage.js';

interface FileIndexEntry {
  path: string;
  fileName: string;
  mimeType: string;
  createdAt: number;
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return base || `file_${Date.now()}`;
}

export class HybridStorageService implements StorageProvider {
  private readonly uploadsDir: string;
  private readonly outputsDir: string;
  private readonly fileIndex = new Map<string, FileIndexEntry>();

  constructor(private readonly config: AppConfig) {
    this.uploadsDir = path.join(config.tmpRootDir, 'uploads');
    this.outputsDir = path.join(config.tmpRootDir, 'outputs');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.uploadsDir, { recursive: true });
    await fs.mkdir(this.outputsDir, { recursive: true });
  }

  async saveLocalUpload(buffer: Buffer, fileName: string, mimeType?: string): Promise<UploadedFileRef> {
    await this.init();
    const fileId = crypto.randomUUID().replace(/-/g, '');
    const safeName = sanitizeFileName(fileName);
    const storedPath = path.join(this.uploadsDir, `${fileId}_${safeName}`);
    const resolvedMime = mimeType || mime.lookup(safeName) || 'application/octet-stream';

    await fs.writeFile(storedPath, buffer);
    this.fileIndex.set(fileId, {
      path: storedPath,
      fileName: safeName,
      mimeType: resolvedMime,
      createdAt: Date.now(),
    });

    return {
      fileId,
      fileName: safeName,
      size: buffer.length,
      mimeType: resolvedMime,
      source: 'local',
    };
  }

  async resolveInputToLocal(ref: UploadedFileRef, workDir: string): Promise<ResolvedInputFile> {
    await fs.mkdir(workDir, { recursive: true });
    const safeName = sanitizeFileName(ref.fileName);

    if (ref.source === 'cloudbase' || ref.fileId.startsWith('cloud://')) {
      const envId = this.config.wxCloudEnv || extractEnvFromFileId(ref.fileId);
      if (!envId) {
        throw new Error('缺少 WX_CLOUD_ENV 环境变量，无法解析云存储 fileID');
      }
      const destPath = path.join(workDir, `${crypto.randomUUID().slice(0, 8)}_${safeName}`);
      await downloadFromCloudBase(envId, ref.fileId, destPath);
      return {
        localPath: destPath,
        fileName: safeName,
        mimeType: ref.mimeType || mime.lookup(safeName) || 'application/octet-stream',
        cleanup: async () => {
          await fs.rm(destPath, { force: true }).catch(() => {});
        },
      };
    }

    const indexed = this.fileIndex.get(ref.fileId);
    if (!indexed) {
      throw new Error(`输入文件不存在或已过期: ${ref.fileName}`);
    }

    const copiedPath = path.join(workDir, `${crypto.randomUUID().slice(0, 8)}_${safeName}`);
    await fs.copyFile(indexed.path, copiedPath);

    return {
      localPath: copiedPath,
      fileName: indexed.fileName,
      mimeType: indexed.mimeType,
      cleanup: async () => {
        await fs.rm(copiedPath, { force: true }).catch(() => {});
      },
    };
  }

  async publishOutputFile(
    localPath: string,
    fileName: string,
    mimeType: string,
    preferSource: 'local' | 'cloudbase',
    taskId: string
  ): Promise<OutputFileRef> {
    const safeName = sanitizeFileName(fileName);
    const stat = await fs.stat(localPath);
    const isImage = mimeType.startsWith('image/');

    if (preferSource === 'cloudbase') {
      const envId = this.config.wxCloudEnv;
      if (!envId) {
        throw new Error('CloudBase 存储模式下未配置 WX_CLOUD_ENV');
      }
      const cloudPath = `tmp-outputs/${taskId}/${Date.now()}_${safeName}`;
      const { fileId } = await uploadToCloudBase(envId, localPath, cloudPath);
      return {
        fileId,
        fileName: safeName,
        size: stat.size,
        mimeType,
        downloadUrl: fileId,
        source: 'cloudbase',
        previewableImage: isImage,
      };
    }

    await this.init();
    const outToken = crypto.randomUUID().replace(/-/g, '');
    const taskOutDir = path.join(this.outputsDir, taskId);
    await fs.mkdir(taskOutDir, { recursive: true });
    const finalPath = path.join(taskOutDir, `${outToken.slice(0, 8)}_${safeName}`);
    await fs.copyFile(localPath, finalPath);

    this.fileIndex.set(outToken, {
      path: finalPath,
      fileName: safeName,
      mimeType,
      createdAt: Date.now(),
    });

    return {
      fileId: outToken,
      fileName: safeName,
      size: stat.size,
      mimeType,
      downloadUrl: `/api/files/${outToken}`,
      source: 'local',
      previewableImage: isImage,
    };
  }

  async getLocalFileByToken(fileToken: string): Promise<{ path: string; fileName: string; mimeType: string } | null> {
    const entry = this.fileIndex.get(fileToken);
    if (!entry) return null;
    try {
      await fs.access(entry.path);
      return {
        path: entry.path,
        fileName: entry.fileName,
        mimeType: entry.mimeType,
      };
    } catch {
      this.fileIndex.delete(fileToken);
      return null;
    }
  }

  async cleanupExpired(ttlMs: number): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [token, entry] of this.fileIndex.entries()) {
      if (now - entry.createdAt > ttlMs) {
        await fs.rm(entry.path, { force: true }).catch(() => {});
        this.fileIndex.delete(token);
        removed++;
      }
    }

    // Also sweep stale task output folders
    try {
      const dirs = await fs.readdir(this.outputsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = path.join(this.outputsDir, dir.name);
        const stat = await fs.stat(dirPath);
        if (now - stat.mtimeMs > ttlMs) {
          await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // ignore if directory not created yet
    }

    return removed;
  }
}
