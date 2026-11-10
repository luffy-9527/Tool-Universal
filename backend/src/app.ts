import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { createTaskExecutor } from './processors/index.js';
import { TaskManager } from './queue/taskManager.js';
import { registerComplianceRoutes } from './routes/compliance.js';
import { registerFileRoutes } from './routes/files.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { HybridStorageService } from './storage/localStorage.js';

export interface AppContext {
  app: FastifyInstance;
  storage: HybridStorageService;
  taskManager: TaskManager;
}

export async function buildApp(config: AppConfig): Promise<AppContext> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxFileSize,
      files: 30,
    },
  });

  const storage = new HybridStorageService(config);
  await storage.init();

  const executor = createTaskExecutor(config);
  const taskManager = new TaskManager(config, storage, executor);
  taskManager.startHousekeeping();

  registerHealthRoutes(app, config);
  registerComplianceRoutes(app, config);
  registerFileRoutes(app, storage);
  registerTaskRoutes(app, taskManager, storage, config);

  app.setErrorHandler((error: any, _request, reply) => {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    reply.code(statusCode).send({
      message: error?.message || '服务器内部错误',
    });
  });

  app.addHook('onClose', async () => {
    await taskManager.sweepExpiredTasks().catch(() => {});
    taskManager.stopHousekeeping();
  });

  return { app, storage, taskManager };
}

const IPV6_UNSUPPORTED_CODES = new Set([
  'EAFNOSUPPORT',
  'EADDRNOTAVAIL',
  'EINVAL',
  'ENOPROTOOPT',
  'EPROTONOSUPPORT',
  'ENOTSUP',
]);

export async function listenApp(
  app: FastifyInstance,
  config: Pick<AppConfig, 'port' | 'host'>
): Promise<string> {
  if (config.host !== '::') {
    return app.listen({
      port: config.port,
      host: config.host,
    });
  }

  try {
    return await app.listen({
      port: config.port,
      host: '::',
      ipv6Only: false,
    });
  } catch (err: any) {
    if (err && typeof err.code === 'string' && IPV6_UNSUPPORTED_CODES.has(err.code)) {
      app.log.warn(
        { code: err.code },
        'Dual-stack IPv6 listen unavailable, falling back to IPv4 0.0.0.0'
      );
      return app.listen({
        port: config.port,
        host: '0.0.0.0',
      });
    }
    throw err;
  }
}
