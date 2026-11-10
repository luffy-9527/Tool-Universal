import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TOOL_MAP, type ToolId } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import { inspectPdfFile } from '../processors/pdfProcessor.js';
import type { TaskManager } from '../queue/taskManager.js';
import type { StorageProvider } from '../storage/index.js';

const UploadedFileSchema = z.object({
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().nonnegative(),
  mimeType: z.string().optional(),
  source: z.enum(['local', 'cloudbase']),
});

const CreateTaskSchema = z.object({
  toolId: z.string().refine((val): val is ToolId => val in TOOL_MAP, {
    message: '不支持的工具 ID',
  }),
  files: z.array(UploadedFileSchema).min(1, '请至少上传一个文件'),
  params: z.record(z.any()).optional(),
});

const InspectPdfSchema = z.object({
  file: UploadedFileSchema,
});

export function registerTaskRoutes(
  app: FastifyInstance,
  taskManager: TaskManager,
  storage: StorageProvider,
  config: AppConfig
): void {
  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message || '请求参数无效',
      });
    }

    const tool = TOOL_MAP[parsed.data.toolId];
    if (parsed.data.files.length > tool.maxFiles) {
      return reply.code(400).send({
        message: `${tool.title} 最多支持 ${tool.maxFiles} 个文件`,
      });
    }

    const record = taskManager.submit(parsed.data);
    return reply.code(202).send(record);
  });

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request, reply) => {
    const task = taskManager.getTask(request.params.taskId);
    if (!task) {
      return reply.code(404).send({ message: '任务不存在或已过期' });
    }
    return task;
  });

  app.post('/api/pdf/inspect', async (request, reply) => {
    const parsed = InspectPdfSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: '无效的 PDF 文件引用' });
    }

    const tempDir = path.join(config.tmpRootDir, 'inspect', crypto.randomUUID().slice(0, 12));
    try {
      const resolved = await storage.resolveInputToLocal(parsed.data.file, tempDir);
      const info = await inspectPdfFile(resolved.localPath, resolved.fileName);
      return info;
    } catch (err: any) {
      return reply.code(400).send({ message: err?.message || '解析 PDF 页数失败' });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await storage.deleteCloudInputFiles([parsed.data.file]).catch(() => 0);
    }
  });
}
