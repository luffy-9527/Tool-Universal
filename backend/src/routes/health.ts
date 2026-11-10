import type { FastifyInstance } from 'fastify';
import { CATEGORIES, TOOLS, type CapabilitiesResponse } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import { isBinaryAvailable, resolveFfmpegBin } from '../utils/exec.js';

export function registerHealthRoutes(app: FastifyInstance, config: AppConfig): void {
  app.get('/', async () => {
    return {
      ok: true,
      status: 'UP',
      service: 'tool-api',
      timestamp: Date.now(),
    };
  });

  app.get('/health', async () => {
    return {
      ok: true,
      status: 'UP',
      timestamp: Date.now(),
    };
  });

  app.get('/api/tools', async () => {
    return {
      categories: CATEGORIES,
      tools: TOOLS,
    };
  });

  app.get('/api/capabilities', async (): Promise<CapabilitiesResponse> => {
    const [ffmpegOk, libreoffice, pdftoppm, pdfimages] = await Promise.all([
      resolveFfmpegBin().then(() => true).catch(() => false),
      isBinaryAvailable('soffice', '--version'),
      isBinaryAvailable('pdftoppm', '-v'),
      isBinaryAvailable('pdfimages', '-v'),
    ]);

    return {
      ffmpeg: ffmpegOk,
      libreoffice,
      pdftoppm: pdftoppm || true, // mupdf WASM fallback always available
      pdfimages: pdfimages || true, // mupdf WASM fallback always available
      cutoutProvider: config.cutoutProvider,
      storageMode: config.storageMode,
    };
  });
}
