import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({
    port: config.port,
    host: config.host,
  });

  app.log.info(
    `Tool-Universal backend listening on http://${config.host}:${config.port} (storageMode=${config.storageMode}, maxConcurrency=${config.maxConcurrency})`
  );
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
