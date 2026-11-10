import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  host: string;
  storageMode: 'local' | 'cloudbase';
  wxCloudEnv: string;
  maxConcurrency: number;
  maxFileSize: number;
  fileTtlMs: number;
  tmpRootDir: string;
  cutoutProvider: 'smart-chroma' | 'rembg';
  rembgEndpoint: string;
}

export function loadConfig(): AppConfig {
  const storageEnv = process.env.STORAGE_MODE === 'cloudbase' ? 'cloudbase' : 'local';
  const wxCloudEnv =
    process.env.WX_CLOUD_ENV ||
    process.env.CBR_ENV_ID ||
    process.env.TCB_ENV ||
    '';

  return {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '::',
    storageMode: storageEnv,
    wxCloudEnv,
    maxConcurrency: Math.max(1, Number(process.env.MAX_CONCURRENCY || 2)),
    maxFileSize: Number(process.env.MAX_FILE_SIZE || 100 * 1024 * 1024),
    fileTtlMs: Number(process.env.FILE_TTL_MS || 30 * 60 * 1000),
    tmpRootDir: process.env.TMP_STORAGE_DIR || path.resolve(__dirname, '../tmp_storage'),
    cutoutProvider: process.env.CUTOUT_PROVIDER === 'rembg' ? 'rembg' : 'smart-chroma',
    rembgEndpoint: process.env.REMBG_ENDPOINT || 'http://127.0.0.1:5000/api/remove',
  };
}
