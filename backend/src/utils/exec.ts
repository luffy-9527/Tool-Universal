import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function runBinary(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<ExecResult> {
  const timeout = options.timeoutMs ?? 120_000;
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout,
      cwd: options.cwd,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: stdout?.toString() ?? '',
      stderr: stderr?.toString() ?? '',
    };
  } catch (err: any) {
    const code = err?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `系统未安装依赖命令 "${bin}"。若在本地开发，请先安装或使用 Docker / 微信云托管镜像运行。`
      );
    }
    const stderrText = err?.stderr?.toString()?.trim() || err?.message || 'Unknown error';
    throw new Error(`执行 ${bin} 失败: ${stderrText.slice(0, 500)}`);
  }
}

export async function isBinaryAvailable(bin: string, versionArg = '-version'): Promise<boolean> {
  try {
    await execFileAsync(bin, [versionArg], { timeout: 3000, windowsHide: true });
    return true;
  } catch (err: any) {
    return err?.code !== 'ENOENT';
  }
}

let cachedFfmpegPath: string | null | undefined;
let cachedFfprobePath: string | null | undefined;

export async function resolveFfmpegBin(): Promise<string> {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  if (await isBinaryAvailable('ffmpeg', '-version')) {
    cachedFfmpegPath = 'ffmpeg';
    return cachedFfmpegPath;
  }

  try {
    const mod: any = await import('ffmpeg-static');
    const raw = mod?.default?.default ?? mod?.default ?? mod;
    const staticBin: string = typeof raw === 'string' ? raw : '';
    if (staticBin) {
      await fs.access(staticBin);
      cachedFfmpegPath = staticBin;
      return cachedFfmpegPath;
    }
  } catch {
    // ignore
  }

  throw new Error('未检测到 FFmpeg 可执行文件，请安装 ffmpeg 或保留 ffmpeg-static 依赖');
}

export async function resolveFfprobeBin(): Promise<string> {
  if (cachedFfprobePath) return cachedFfprobePath;

  if (await isBinaryAvailable('ffprobe', '-version')) {
    cachedFfprobePath = 'ffprobe';
    return cachedFfprobePath;
  }

  try {
    const mod: any = await import('ffprobe-static');
    const staticBin: string = mod.default?.path || mod.path || '';
    if (staticBin) {
      await fs.access(staticBin);
      cachedFfprobePath = staticBin;
      return cachedFfprobePath;
    }
  } catch {
    // ignore
  }

  throw new Error('未检测到 FFprobe 可执行文件');
}
