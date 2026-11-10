import type { OutputFileRef, UploadedFileRef } from '@tool-universal/shared';

export interface ResolvedInputFile {
  localPath: string;
  fileName: string;
  mimeType: string;
  cleanup: () => Promise<void>;
}

export interface StorageProvider {
  saveLocalUpload(buffer: Buffer, fileName: string, mimeType?: string): Promise<UploadedFileRef>;
  resolveInputToLocal(ref: UploadedFileRef, workDir: string): Promise<ResolvedInputFile>;
  publishOutputFile(
    localPath: string,
    fileName: string,
    mimeType: string,
    preferSource: 'local' | 'cloudbase',
    taskId: string
  ): Promise<OutputFileRef>;
  getLocalFileByToken(fileToken: string): Promise<{ path: string; fileName: string; mimeType: string } | null>;
  deleteCloudInputFiles(refs: UploadedFileRef[]): Promise<number>;
  cleanupExpired(ttlMs: number): Promise<number>;
}
