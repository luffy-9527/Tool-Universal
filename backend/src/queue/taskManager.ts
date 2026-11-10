import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import PQueue from 'p-queue';
import type { CreateTaskRequest, OutputFileRef, TaskRecord } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import type { StorageProvider } from '../storage/index.js';

export interface ProcessContext {
  taskId: string;
  request: CreateTaskRequest;
  workDir: string;
  localInputPaths: string[];
  updateProgress: (progress: number, stageText: string) => void;
  addOutput: (localPath: string, fileName: string, mimeType: string) => Promise<OutputFileRef>;
}

export type TaskExecutor = (ctx: ProcessContext) => Promise<OutputFileRef[]>;

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly queue: PQueue;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: StorageProvider,
    private readonly executor: TaskExecutor
  ) {
    this.queue = new PQueue({ concurrency: config.maxConcurrency });
  }

  startHousekeeping(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      void this.sweepExpiredTasks();
    }, 2 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  stopHousekeeping(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async sweepExpiredTasks(): Promise<void> {
    const now = Date.now();
    for (const [id, task] of this.tasks.entries()) {
      if (now - task.updatedAt > this.config.fileTtlMs) {
        this.tasks.delete(id);
      }
    }
    await this.storage.cleanupExpired(this.config.fileTtlMs);
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  submit(request: CreateTaskRequest): TaskRecord {
    const taskId = `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = Date.now();
    const record: TaskRecord = {
      taskId,
      toolId: request.toolId,
      status: 'queued',
      progress: 5,
      stageText: '任务已入队，等待处理...',
      outputs: [],
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(taskId, record);
    void this.queue.add(() => this.runTask(taskId, request));
    return record;
  }

  private updateRecord(taskId: string, patch: Partial<TaskRecord>): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    Object.assign(existing, patch, { updatedAt: Date.now() });
  }

  private async runTask(taskId: string, request: CreateTaskRequest): Promise<void> {
    const workDir = path.join(this.config.tmpRootDir, 'workdir', taskId);
    const resolvedCleanups: Array<() => Promise<void>> = [];

    try {
      await fs.mkdir(workDir, { recursive: true });
      this.updateRecord(taskId, {
        status: 'processing',
        progress: 15,
        stageText: '正在拉取待处理文件...',
      });

      const localInputPaths: string[] = [];
      for (const fileRef of request.files) {
        const resolved = await this.storage.resolveInputToLocal(fileRef, workDir);
        localInputPaths.push(resolved.localPath);
        resolvedCleanups.push(resolved.cleanup);
      }

      const preferSource: 'local' | 'cloudbase' =
        request.files.some((f) => f.source === 'cloudbase' || f.fileId.startsWith('cloud://'))
          ? 'cloudbase'
          : 'local';

      const ctx: ProcessContext = {
        taskId,
        request,
        workDir,
        localInputPaths,
        updateProgress: (progress, stageText) => {
          this.updateRecord(taskId, {
            progress: Math.min(99, Math.max(15, Math.round(progress))),
            stageText,
          });
        },
        addOutput: async (localPath, fileName, mimeType) => {
          return this.storage.publishOutputFile(localPath, fileName, mimeType, preferSource, taskId);
        },
      };

      const outputs = await this.executor(ctx);
      this.updateRecord(taskId, {
        status: 'completed',
        progress: 100,
        stageText: '处理完成',
        outputs,
      });
    } catch (err: any) {
      this.updateRecord(taskId, {
        status: 'failed',
        progress: 100,
        stageText: '处理失败',
        error: err?.message || '处理过程中出现未知错误',
      });
    } finally {
      for (const fn of resolvedCleanups) {
        await fn().catch(() => {});
      }
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await this.storage.deleteCloudInputFiles(request.files).catch(() => 0);
    }
  }
}
