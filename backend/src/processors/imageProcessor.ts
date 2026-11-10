import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { OutputFileRef, ToolParams } from '@tool-universal/shared';
import type { AppConfig } from '../config.js';
import type { ProcessContext } from '../queue/taskManager.js';

function parseHexColor(hex = '#438EDB'): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  return [67, 142, 219];
}

/**
 * Separable 1D sliding-window maximum (morphological dilation) + box smoothing
 * over a downsampled luminance grid to estimate local bright paper illumination
 * without dark text or colored stamps dragging the background estimate down.
 */
export function estimateLocalPaperIllumination(
  rgbOrGray: Uint8Array,
  width: number,
  height: number,
  channels: number
): { smallBg: Float32Array; bw: number; bh: number; step: number } {
  const step = 4;
  const bw = Math.max(1, Math.ceil(width / step));
  const bh = Math.max(1, Math.ceil(height / step));
  const cellMax = new Float32Array(bw * bh);

  for (let by = 0; by < bh; by++) {
    const y0 = by * step;
    const y1 = Math.min(height, y0 + step);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * step;
      const x1 = Math.min(width, x0 + step);
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * width + x) * channels;
          const luma =
            channels >= 3
              ? rgbOrGray[o] * 0.299 + rgbOrGray[o + 1] * 0.587 + rgbOrGray[o + 2] * 0.114
              : rgbOrGray[o];
          sum += luma;
          cnt++;
        }
      }
      cellMax[by * bw + bx] = sum / Math.max(1, cnt);
    }
  }

  const radiusPx = Math.max(16, Math.round(Math.min(width, height) / 26));
  const br = Math.max(3, Math.min(28, Math.round(radiusPx / step)));

  // Horizontal max
  const dilH = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const rowOff = y * bw;
    for (let x = 0; x < bw; x++) {
      const lx0 = Math.max(0, x - br);
      const lx1 = Math.min(bw - 1, x + br);
      let mx = 0;
      for (let k = lx0; k <= lx1; k++) {
        const v = cellMax[rowOff + k];
        if (v > mx) mx = v;
      }
      dilH[rowOff + x] = mx;
    }
  }

  // Vertical max
  const dilV = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const ly0 = Math.max(0, y - br);
    const ly1 = Math.min(bh - 1, y + br);
    for (let x = 0; x < bw; x++) {
      let mx = 0;
      for (let k = ly0; k <= ly1; k++) {
        const v = dilH[k * bw + x];
        if (v > mx) mx = v;
      }
      dilV[y * bw + x] = mx;
    }
  }

  // Smooth the dilated envelope with separable box blur so lighting ramps smoothly
  const sr = Math.max(2, Math.round(br * 0.85));
  const smH = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const rowOff = y * bw;
    for (let x = 0; x < bw; x++) {
      const lx0 = Math.max(0, x - sr);
      const lx1 = Math.min(bw - 1, x + sr);
      let sum = 0;
      for (let k = lx0; k <= lx1; k++) sum += dilV[rowOff + k];
      smH[rowOff + x] = sum / (lx1 - lx0 + 1);
    }
  }

  const smallBg = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const ly0 = Math.max(0, y - sr);
    const ly1 = Math.min(bh - 1, y + sr);
    for (let x = 0; x < bw; x++) {
      let sum = 0;
      for (let k = ly0; k <= ly1; k++) sum += smH[k * bw + x];
      smallBg[y * bw + x] = sum / (ly1 - ly0 + 1);
    }
  }

  return { smallBg, bw, bh, step };
}

function sampleBilinearBg(
  smallBg: Float32Array,
  bw: number,
  bh: number,
  step: number,
  x: number,
  y: number
): number {
  const fx = Math.max(0, Math.min(bw - 1, (x + 0.5) / step - 0.5));
  const fy = Math.max(0, Math.min(bh - 1, (y + 0.5) / step - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(bw - 1, x0 + 1);
  const y1 = Math.min(bh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = smallBg[y0 * bw + x0];
  const v10 = smallBg[y0 * bw + x1];
  const v01 = smallBg[y1 * bw + x0];
  const v11 = smallBg[y1 * bw + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

export async function enhanceDocumentScan(inputPath: string, outputPath: string, strength: 'mild' | 'strong' = 'strong'): Promise<void> {
  if (strength === 'strong') {
    const { data, info } = await sharp(inputPath)
      .rotate()
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { smallBg, bw, bh, step } = estimateLocalPaperIllumination(data, info.width, info.height, 1);
    const out = Buffer.alloc(data.length);

    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = y * info.width + x;
        const bg = Math.max(32, sampleBilinearBg(smallBg, bw, bh, step, x, y));
        const normalized = Math.min(255, (data[idx] / bg) * 246);
        let val = 255 - (255 - normalized) * 1.55;
        if (val >= 234) val = 255;
        out[idx] = Math.max(0, Math.min(255, Math.round(val)));
      }
    }

    await sharp(out, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .sharpen({ sigma: 0.9 })
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outputPath);
    return;
  }

  // Color-preserving gentle enhancement ('mild'): removes gray camera paper & shadows
  // while keeping red tax seals, stamps, signatures, and colored borders vivid!
  const { data, info } = await sharp(inputPath)
    .rotate()
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const { smallBg, bw, bh, step } = estimateLocalPaperIllumination(data, width, height, channels);
  const out = Buffer.alloc(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const bg = Math.max(36, sampleBilinearBg(smallBg, bw, bh, step, x, y));
      const gain = Math.min(3.2, 248 / bg);

      let r = Math.min(255, data[o] * gain);
      let g = Math.min(255, data[o + 1] * gain);
      let b = Math.min(255, data[o + 2] * gain);

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      // Smooth neutrality factor: 1 = pure neutral/gray/ink, 0 = clearly chromatic (seal/stamp/border)
      const neutral = chroma <= 10 ? 1 : chroma >= 26 ? 0 : 1 - (chroma - 10) / 16;
      const colorMask = 1 - neutral;

      if (colorMask > 0.01) {
        // Keep colored seals/stamps vivid and crisp against white paper
        const satBoost = 1 + 0.24 * colorMask;
        r = Math.max(0, Math.min(255, luma + (r - luma) * satBoost));
        g = Math.max(0, Math.min(255, luma + (g - luma) * satBoost));
        b = Math.max(0, Math.min(255, luma + (b - luma) * satBoost));
      }

      if (neutral > 0) {
        // Whiten neutral gray paper shadows cleanly while gently darkening black ink
        const whiteBlend = Math.max(0, Math.min(1, (luma - 205) / 28)) * neutral;
        if (whiteBlend > 0) {
          r += (255 - r) * whiteBlend;
          g += (255 - g) * whiteBlend;
          b += (255 - b) * whiteBlend;
        } else if (luma < 195) {
          const inkScale = Math.max(0, 1 - neutral * 0.22 * (1 - luma / 205));
          r *= inkScale;
          g *= inkScale;
          b *= inkScale;
        }
      }

      out[o] = Math.max(0, Math.min(255, Math.round(r)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  await sharp(out, {
    raw: { width, height, channels },
  })
    .sharpen({ sigma: 0.75 })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);
}

/**
 * Built-in zero-cost smart chroma/border-flood ID photo background replacement.
 * Samples border pixels from top/left/right edges and smoothly keys & feathers edges.
 */
export async function replaceIdPhotoBackgroundSmart(
  inputPath: string,
  outputPath: string,
  targetHex: string,
  tolerance = 36,
  feather = 4
): Promise<void> {
  const { data, info } = await sharp(inputPath)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const samples: Array<[number, number, number]> = [];

  // Sample border margins (top row, upper-left, upper-right)
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 30))) {
    const idx = x * channels;
    samples.push([data[idx], data[idx + 1], data[idx + 2]]);
  }
  for (let y = 0; y < Math.floor(height * 0.6); y += Math.max(1, Math.floor(height / 25))) {
    const leftIdx = y * width * channels;
    const rightIdx = (y * width + (width - 1)) * channels;
    samples.push([data[leftIdx], data[leftIdx + 1], data[leftIdx + 2]]);
    samples.push([data[rightIdx], data[rightIdx + 1], data[rightIdx + 2]]);
  }

  // Median-like average of border pixels
  const avgR = Math.round(samples.reduce((s, p) => s + p[0], 0) / samples.length);
  const avgG = Math.round(samples.reduce((s, p) => s + p[1], 0) / samples.length);
  const avgB = Math.round(samples.reduce((s, p) => s + p[2], 0) / samples.length);

  const [targetR, targetG, targetB] = parseHexColor(targetHex);

  // BFS flood-fill from image edges so interior white/blue clothes aren't eaten!
  const visited = new Uint8Array(width * height);
  const bgMask = new Float32Array(width * height); // 1 = pure background, 0 = foreground
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const hardDist = Math.max(14, tolerance);
  const softDist = hardDist + Math.max(8, feather * 5);

  const colorDist = (pixelIndex: number): number => {
    const o = pixelIndex * channels;
    const dr = data[o] - avgR;
    const dg = data[o + 1] - avgG;
    const db = data[o + 2] - avgB;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const enqueue = (idx: number) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + (width - 1));
  }

  while (head < tail) {
    const idx = queue[head++];
    const dist = colorDist(idx);
    if (dist <= softDist) {
      const weight = dist <= hardDist ? 1 : 1 - (dist - hardDist) / (softDist - hardDist);
      bgMask[idx] = Math.max(bgMask[idx], weight);

      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0) enqueue(idx - 1);
      if (x < width - 1) enqueue(idx + 1);
      if (y > 0) enqueue(idx - width);
      if (y < height - 1) enqueue(idx + width);
    }
  }

  const out = Buffer.from(data);
  for (let i = 0; i < width * height; i++) {
    const w = bgMask[i];
    if (w > 0) {
      const o = i * channels;
      out[o] = Math.round(data[o] * (1 - w) + targetR * w);
      out[o + 1] = Math.round(data[o + 1] * (1 - w) + targetG * w);
      out[o + 2] = Math.round(data[o + 2] * (1 - w) + targetB * w);
      out[o + 3] = 255;
    }
  }

  await sharp(out, { raw: { width, height, channels } })
    .jpeg({ quality: 95 })
    .toFile(outputPath);
}

export async function processImageTool(ctx: ProcessContext, config: AppConfig): Promise<OutputFileRef[]> {
  const { toolId } = ctx.request;
  const params: ToolParams = ctx.request.params || {};
  const outputs: OutputFileRef[] = [];

  if (toolId === 'invoice-scan-enhance') {
    ctx.updateProgress(45, '正在去除阴影灰底并增强文字...');
    const baseName = path.parse(ctx.request.files[0].fileName).name;
    const outPath = path.join(ctx.workDir, `${baseName}_enhanced.jpg`);
    await enhanceDocumentScan(ctx.localInputPaths[0], outPath, params.enhanceStrength || 'strong');
    outputs.push(await ctx.addOutput(outPath, `${baseName}_扫描增强.jpg`, 'image/jpeg'));
    return outputs;
  }

  if (toolId === 'id-photo-bg') {
    const baseName = path.parse(ctx.request.files[0].fileName).name;
    const outPath = path.join(ctx.workDir, `${baseName}_idbg.jpg`);
    const targetHex = params.bgColor || '#438EDB';

    if (config.cutoutProvider === 'rembg') {
      ctx.updateProgress(40, '正在进行人像精细抠图...');
      const imgBuf = await fs.readFile(ctx.localInputPaths[0]);
      const form = new FormData();
      form.append('file', new Blob([imgBuf]), path.basename(ctx.localInputPaths[0]));
      const res = await fetch(config.rembgEndpoint, { method: 'POST', body: form });
      if (!res.ok) {
        throw new Error(`抠图服务调用失败 (HTTP ${res.status})`);
      }
      const cutoutPng = Buffer.from(await res.arrayBuffer());
      const [r, g, b] = parseHexColor(targetHex);
      await sharp(cutoutPng)
        .flatten({ background: { r, g, b } })
        .jpeg({ quality: 95 })
        .toFile(outPath);
    } else {
      ctx.updateProgress(45, '正在智能边缘识别并替换证件照底色...');
      await replaceIdPhotoBackgroundSmart(
        ctx.localInputPaths[0],
        outPath,
        targetHex,
        params.tolerance ?? 38,
        params.feather ?? 4
      );
    }

    outputs.push(await ctx.addOutput(outPath, `${baseName}_换底.jpg`, 'image/jpeg'));
    return outputs;
  }

  if (toolId === 'image-format-convert') {
    const fmt = params.imageFormat || 'png';
    const mimeType = fmt === 'jpg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    for (let i = 0; i < ctx.localInputPaths.length; i++) {
      const baseName = path.parse(ctx.request.files[i].fileName).name;
      const outPath = path.join(ctx.workDir, `${baseName}.${fmt}`);
      const pipeline = sharp(ctx.localInputPaths[i]).rotate();
      if (fmt === 'jpg') await pipeline.jpeg({ quality: 92 }).toFile(outPath);
      else if (fmt === 'webp') await pipeline.webp({ quality: 90 }).toFile(outPath);
      else await pipeline.png().toFile(outPath);
      outputs.push(await ctx.addOutput(outPath, `${baseName}.${fmt}`, mimeType));
    }
    return outputs;
  }

  if (toolId === 'image-compress') {
    const quality = Math.min(95, Math.max(10, params.quality ?? 75));
    for (let i = 0; i < ctx.localInputPaths.length; i++) {
      const baseName = path.parse(ctx.request.files[i].fileName).name;
      const outPath = path.join(ctx.workDir, `${baseName}_compressed.jpg`);
      let pipeline = sharp(ctx.localInputPaths[i]).rotate();
      if (params.maxWidth && params.maxWidth > 0) {
        pipeline = pipeline.resize({ width: params.maxWidth, withoutEnlargement: true });
      }
      await pipeline.jpeg({ quality, mozjpeg: true }).toFile(outPath);
      outputs.push(await ctx.addOutput(outPath, `${baseName}_压缩.jpg`, 'image/jpeg'));
    }
    return outputs;
  }

  throw new Error(`该图像工具建议直接在小程序端本地 Canvas 处理: ${toolId}`);
}
