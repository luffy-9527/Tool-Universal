import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { UploadedFileRef } from '@tool-universal/shared';
import type { StorageProvider } from '../storage/index.js';

export function registerFileRoutes(app: FastifyInstance, storage: StorageProvider): void {
  app.post('/api/files/upload', async (request, reply) => {
    const parts = request.parts();
    const pendingFiles: Array<{ buffer: Buffer; filename: string; mimetype?: string }> = [];
    let originalName = '';

    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'originalName' && typeof part.value === 'string' && part.value.trim()) {
          originalName = part.value.trim();
        }
        continue;
      }

      const buffer = await part.toBuffer();
      if (buffer.length === 0) {
        continue;
      }
      pendingFiles.push({
        buffer,
        filename: part.filename,
        mimetype: part.mimetype && part.mimetype !== 'application/octet-stream' ? part.mimetype : undefined,
      });
    }

    if (pendingFiles.length === 0) {
      return reply.code(400).send({ message: '未接收到有效文件' });
    }

    const uploaded: UploadedFileRef[] = [];
    for (const item of pendingFiles) {
      const preferredName = pendingFiles.length === 1 && originalName ? originalName : item.filename;
      const saved = await storage.saveLocalUpload(item.buffer, preferredName, item.mimetype);
      uploaded.push(saved);
    }

    return {
      files: uploaded,
      file: uploaded[0],
    };
  });

  app.get<{ Params: { token: string } }>('/api/files/:token', async (request, reply) => {
    const { token } = request.params;
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(token)) {
      return reply.code(400).send({ message: '非法的文件标识' });
    }

    const found = await storage.getLocalFileByToken(token);
    if (!found) {
      return reply.code(404).send({ message: '文件不存在或已自动过期清理' });
    }

    const encodedName = encodeURIComponent(found.fileName);
    reply.header('Content-Type', found.mimeType);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
    return reply.send(fs.createReadStream(found.path));
  });
}
