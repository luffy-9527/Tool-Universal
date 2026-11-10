import fs from 'node:fs/promises';
import path from 'node:path';
import type { OutputFileRef, ToolParams } from '@tool-universal/shared';
import type { ProcessContext } from '../queue/taskManager.js';
import { resolveFfmpegBin, resolveFfprobeBin, runBinary } from '../utils/exec.js';

interface FfprobeStreamsResult {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    duration?: string;
  }>;
  format?: {
    duration?: string;
  };
}

interface MediaProbeInfo {
  streams: NonNullable<FfprobeStreamsResult['streams']>;
  durationSec: number;
}

async function probeMediaInfo(inputPath: string): Promise<MediaProbeInfo> {
  try {
    const ffprobeBin = await resolveFfprobeBin();
    const { stdout } = await runBinary(
      ffprobeBin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
      { timeoutMs: 30_000 }
    );
    const parsed = JSON.parse(stdout) as FfprobeStreamsResult;
    const streams = parsed.streams || [];
    const rawDuration =
      Number(parsed.format?.duration) ||
      streams.map((s) => Number(s.duration)).find((d) => Number.isFinite(d) && d > 0) ||
      0;
    return {
      streams,
      durationSec: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0,
    };
  } catch {
    return { streams: [], durationSec: 0 };
  }
}

async function probeMediaStreams(inputPath: string): Promise<FfprobeStreamsResult['streams']> {
  const info = await probeMediaInfo(inputPath);
  return info.streams;
}

function getAudioEncoderArgs(format: 'mp3' | 'wav' | 'm4a' | 'aac', bitrate: string): string[] {
  switch (format) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', bitrate];
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', bitrate, '-movflags', '+faststart'];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', bitrate, '-f', 'adts'];
    case 'wav':
      return ['-c:a', 'pcm_s16le', '-ar', '44100'];
  }
}

export async function processMediaTool(ctx: ProcessContext): Promise<OutputFileRef[]> {
  const { toolId } = ctx.request;
  const params: ToolParams = ctx.request.params || {};
  const inputPath = ctx.localInputPaths[0];
  const baseName = path.parse(ctx.request.files[0].fileName).name;
  const outputs: OutputFileRef[] = [];
  const ffmpegBin = await resolveFfmpegBin();

  if (toolId === 'audio-convert') {
    const targetFmt = params.audioFormat || 'mp3';
    const bitrate = params.bitrate || '192k';
    const outPath = path.join(ctx.workDir, `${baseName}.${targetFmt}`);
    const mimeMap: Record<typeof targetFmt, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
    };

    ctx.updateProgress(40, `正在转换为 ${targetFmt.toUpperCase()} 格式...`);
    await runBinary(
      ffmpegBin,
      ['-y', '-i', inputPath, '-vn', ...getAudioEncoderArgs(targetFmt, bitrate), outPath],
      { timeoutMs: 180_000 }
    );

    outputs.push(await ctx.addOutput(outPath, `${baseName}.${targetFmt}`, mimeMap[targetFmt]));
    return outputs;
  }

  if (toolId === 'video-extract-audio') {
    const targetFmt = params.audioFormat || 'mp3';
    const bitrate = params.bitrate || '192k';
    const outPath = path.join(ctx.workDir, `${baseName}_audio.${targetFmt}`);
    const mimeMap: Record<typeof targetFmt, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
    };

    ctx.updateProgress(30, '正在检测视频音轨...');
    const streams = await probeMediaStreams(inputPath);
    const audioStream = streams?.find((s) => s.codec_type === 'audio');
    if (streams && streams.length > 0 && !audioStream) {
      throw new Error('该视频文件中未包含任何音轨，无法提取音频');
    }

    ctx.updateProgress(55, '正在剥离视频画面并导出音频...');
    const canCopyAac =
      audioStream?.codec_name === 'aac' && (targetFmt === 'm4a' || targetFmt === 'aac');

    const codecArgs = canCopyAac
      ? targetFmt === 'm4a'
        ? ['-c:a', 'copy', '-movflags', '+faststart']
        : ['-c:a', 'copy', '-f', 'adts']
      : getAudioEncoderArgs(targetFmt, bitrate);

    await runBinary(
      ffmpegBin,
      ['-y', '-i', inputPath, '-vn', ...codecArgs, outPath],
      { timeoutMs: 180_000 }
    );

    outputs.push(await ctx.addOutput(outPath, `${baseName}_配乐.${targetFmt}`, mimeMap[targetFmt]));
    return outputs;
  }

  if (toolId === 'video-compress') {
    const crf = Math.min(34, Math.max(18, params.crf ?? 26));
    const resolution = params.resolution || '720p';
    const outPath = path.join(ctx.workDir, `${baseName}_compressed.mp4`);

    const args = ['-y', '-i', inputPath];

    if (resolution === '1080p') {
      args.push('-vf', "scale='min(1920,iw)':-2");
    } else if (resolution === '720p') {
      args.push('-vf', "scale='min(1280,iw)':-2");
    } else if (resolution === '480p') {
      args.push('-vf', "scale='min(854,iw)':-2");
    } else {
      args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
    }

    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-threads',
      '2',
      outPath
    );

    ctx.updateProgress(40, '正在转码压缩为高兼容 MP4...');
    await runBinary(ffmpegBin, args, { timeoutMs: 300_000 });
    outputs.push(await ctx.addOutput(outPath, `${baseName}_压缩.mp4`, 'video/mp4'));
    return outputs;
  }

  if (toolId === 'video-to-gif') {
    const MAX_GIF_DURATION_SEC = 20;
    const rawStart = Number(params.gifStartSec ?? 0);
    const startSec = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
    const fps = Math.min(20, Math.max(5, Math.round(Number(params.gifFps ?? 10) || 10)));
    const width = Math.min(720, Math.max(80, Math.round(Number(params.gifWidth ?? 480) || 480)));
    const rawDuration = params.gifDurationSec;

    ctx.updateProgress(25, '正在解析视频画面与时长信息...');
    const info = await probeMediaInfo(inputPath);
    const hasVideo = info.streams.some((s) => s.codec_type === 'video');
    if (info.streams.length > 0 && !hasVideo) {
      throw new Error('该文件中未包含视频画面轨，无法转换为 GIF 动图');
    }

    if (info.durationSec > 0 && startSec >= Math.max(0, info.durationSec - 0.1)) {
      throw new Error(
        `起始时间（${startSec} 秒）超出或接近视频总时长（${info.durationSec.toFixed(1)} 秒），请调小起始秒数`
      );
    }

    let durationSec = 5;
    if (rawDuration === 0) {
      const remaining = info.durationSec > 0 ? Math.max(0.5, info.durationSec - startSec) : MAX_GIF_DURATION_SEC;
      durationSec = Math.min(MAX_GIF_DURATION_SEC, remaining);
    } else if (rawDuration !== undefined && rawDuration !== null) {
      const parsedDur = Number(rawDuration);
      durationSec = Number.isFinite(parsedDur) && parsedDur > 0 ? Math.min(MAX_GIF_DURATION_SEC, Math.max(0.4, parsedDur)) : 5;
    }

    const outPath = path.join(ctx.workDir, `${baseName}.gif`);
    const vf = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;

    const args: string[] = ['-y'];
    if (startSec > 0) {
      args.push('-ss', startSec.toFixed(2));
    }
    args.push('-i', inputPath, '-t', durationSec.toFixed(2), '-an', '-vf', vf, '-loop', '0', outPath);

    ctx.updateProgress(55, `正在生成 ${fps} FPS 高画质调色盘并导出 GIF...`);
    await runBinary(ffmpegBin, args, { timeoutMs: 240_000 });

    const stat = await fs.stat(outPath).catch(() => null);
    if (!stat || stat.size === 0) {
      throw new Error('未能导出有效的 GIF 动图，请确认截取起始时间与片段时长有效');
    }

    outputs.push(await ctx.addOutput(outPath, `${baseName}_动图.gif`, 'image/gif'));
    return outputs;
  }

  throw new Error(`未知音视频工具: ${toolId}`);
}
