import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import type { OutputFileRef, UploadedFileRef } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import type { ResolvedInputFile, StorageProvider } from './index.js';
import {
  deleteFromCloudBase,
  downloadFromCloudBase,
  extractEnvFromFileId,
  uploadToCloudBase,
} from './cloudStorage.js';

interface FileIndexEntry {
  path: string;
  fileName: string;
  mimeType: string;
  createdAt: number;
}

interface CloudOutputEntry {
  fileId: string;
  env: string;
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
  private readonly cloudOutputs = new Map<string, CloudOutputEntry>();

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
      this.cloudOutputs.set(fileId, {
        fileId,
        env: envId,
        createdAt: Date.now(),
      });
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

  async deleteCloudInputFiles(refs: UploadedFileRef[]): Promise<number> {
    const cloudIds = refs
      .filter((ref) => ref.source === 'cloudbase' || ref.fileId.startsWith('cloud://'))
      .map((ref) => ref.fileId);

    if (cloudIds.length === 0) {
      return 0;
    }

    try {
      return await deleteFromCloudBase(this.config.wxCloudEnv, cloudIds);
    } catch (err: any) {
      console.warn('[storage] 云存储输入文件自动清理失败:', err?.message || err);
      return 0;
    }
  }

  async cleanupExpired(ttlMs: number): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [token, entry] of this.fileIndex.entries()) {
      if (now - entry.createdAt >= ttlMs) {
        await fs.rm(entry.path, { force: true }).catch(() => {});
        this.fileIndex.delete(token);
        removed++;
      }
    }

    // Sweep stale local uploads on disk
    try {
      const files = await fs.readdir(this.uploadsDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const filePath = path.join(this.uploadsDir, file.name);
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs >= ttlMs) {
          await fs.rm(filePath, { force: true }).catch(() => {});
          removed++;
        }
      }
    } catch {
      // ignore if directory not created yet
    }

    // Also sweep stale task output folders
    try {
      const dirs = await fs.readdir(this.outputsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const dirPath = path.join(this.outputsDir, dir.name);
        const stat = await fs.stat(dirPath);
        if (now - stat.mtimeMs >= ttlMs) {
          await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // ignore if directory not created yet
    }

    // Sweep expired CloudBase output files (tmp-outputs/...)
    const expiredCloudIds: string[] = [];
    for (const [fileId, entry] of this.cloudOutputs.entries()) {
      if (now - entry.createdAt >= ttlMs) {
        expiredCloudIds.push(fileId);
        this.cloudOutputs.delete(fileId);
      }
    }

    if (expiredCloudIds.length > 0) {
      try {
        removed += await deleteFromCloudBase(this.config.wxCloudEnv, expiredCloudIds);
      } catch (err: any) {
        console.warn('[storage] 云存储过期结果自动清理失败:', err?.message || err);
      }
    }

    return removed;
  }
}
