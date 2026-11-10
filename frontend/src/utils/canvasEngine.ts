import type { OutputFileRef, WatermarkOptions } from '@tool-universal/shared';
import {
  base64ToBytes,
  buildPdfFromJpegs,
  bytesToBase64,
  type LocalPdfImageInput,
} from './localPdf';
import type { LocalPickedFile } from './request';

interface LoadedCanvasImage {
  image: any;
  width: number;
  height: number;
}

interface CanvasSurface {
  canvas: any;
  ctx: any;
  isWeixin: boolean;
}

function createSurface(width: number, height: number): CanvasSurface {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));

  // #ifdef MP-WEIXIN
  if (typeof wx !== 'undefined' && typeof wx.createOffscreenCanvas === 'function') {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width: safeW, height: safeH });
    const ctx = canvas.getContext('2d');
    return { canvas, ctx, isWeixin: true };
  }
  // #endif

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = safeW;
    canvas.height = safeH;
    const ctx = canvas.getContext('2d');
    return { canvas, ctx, isWeixin: false };
  }

  throw new Error('当前环境不支持 Canvas 2D');
}

async function loadImageOntoCanvas(surface: CanvasSurface, src: string): Promise<LoadedCanvasImage> {
  return new Promise<LoadedCanvasImage>((resolve, reject) => {
    const img = surface.isWeixin ? surface.canvas.createImage() : new Image();
    if (!surface.isWeixin && !src.startsWith('blob:') && !src.startsWith('data:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      resolve({
        image: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.onerror = () => reject(new Error(`无法加载图片: ${src}`));
    img.src = src;
  });
}

async function exportSurface(
  surface: CanvasSurface,
  fileName: string,
  format: 'png' | 'jpg' | 'webp' = 'png',
  quality = 0.92
): Promise<OutputFileRef> {
  const mimeType =
    format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';

  // #ifdef MP-WEIXIN
  if (surface.isWeixin && typeof wx !== 'undefined') {
    const dataUrl: string = surface.canvas.toDataURL(mimeType, quality);
    if (format === 'webp' && !dataUrl.startsWith('data:image/webp')) {
      throw new Error('WEBP_UNSUPPORTED_LOCAL');
    }
    const base64 = dataUrl.split(',')[1] || '';
    const fs = wx.getFileSystemManager();
    const outPath = `${wx.env.USER_DATA_PATH}/tu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${format}`;
    fs.writeFileSync(outPath, base64, 'base64');
    const size = Math.round((base64.length * 3) / 4);
    return {
      fileId: outPath,
      fileName,
      size,
      mimeType,
      downloadUrl: outPath,
      source: 'local',
      previewableImage: true,
    };
  }
  // #endif

  const blob = await new Promise<Blob>((resolve, reject) => {
    surface.canvas.toBlob(
      (b: Blob | null) => {
        if (!b) reject(new Error('导出图片失败'));
        else if (format === 'webp' && b.type && b.type !== 'image/webp') {
          reject(new Error('WEBP_UNSUPPORTED_LOCAL'));
        } else resolve(b);
      },
      mimeType,
      quality
    );
  });

  const url = URL.createObjectURL(blob);
  return {
    fileId: url,
    fileName,
    size: blob.size,
    mimeType,
    downloadUrl: url,
    source: 'local',
    previewableImage: true,
  };
}

function baseNameOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 1. 朋友圈九宫格 / 宫格切图 */
export async function runGridSplitLocal(
  file: LocalPickedFile,
  options: { cols: number; rows: number; gapPx?: number }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loaded = await loadImageOntoCanvas(probe, file.path);
  const { cols, rows } = options;

  // Center-crop square/proportional region
  const targetRatio = cols / rows;
  const imgRatio = loaded.width / loaded.height;
  let cropW = loaded.width;
  let cropH = loaded.height;
  let offsetX = 0;
  let offsetY = 0;

  if (imgRatio > targetRatio) {
    cropW = loaded.height * targetRatio;
    offsetX = (loaded.width - cropW) / 2;
  } else {
    cropH = loaded.width / targetRatio;
    offsetY = (loaded.height - cropH) / 2;
  }

  const cellW = Math.max(100, Math.min(900, Math.floor(cropW / cols)));
  const cellH = Math.max(100, Math.min(900, Math.floor(cropH / rows)));
  const srcCellW = cropW / cols;
  const srcCellH = cropH / rows;
  const outputs: OutputFileRef[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = createSurface(cellW, cellH);
      s.ctx.fillStyle = '#FFFFFF';
      s.ctx.fillRect(0, 0, cellW, cellH);
      s.ctx.drawImage(
        loaded.image,
        offsetX + c * srcCellW,
        offsetY + r * srcCellH,
        srcCellW,
        srcCellH,
        0,
        0,
        cellW,
        cellH
      );
      const index = r * cols + c + 1;
      outputs.push(await exportSurface(s, `${baseNameOf(file.name)}_${index}.jpg`, 'jpg', 0.92));
    }
  }

  return outputs;
}

/** 2. 长图反向拆分（按份数或小红书/朋友圈比例垂直切分） */
export async function runLongImageSplitLocal(
  file: LocalPickedFile,
  options: { mode: 'count' | 'ratio'; count?: number; ratioW?: number; ratioH?: number }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loaded = await loadImageOntoCanvas(probe, file.path);
  const w = Math.min(1440, loaded.width);
  const scale = w / loaded.width;
  const totalH = Math.round(loaded.height * scale);

  const sliceHeights: number[] = [];
  if (options.mode === 'ratio' && options.ratioW && options.ratioH) {
    const idealSliceH = Math.max(200, Math.round((w * options.ratioH) / options.ratioW));
    let remaining = totalH;
    while (remaining > 0) {
      const take = Math.min(idealSliceH, remaining);
      sliceHeights.push(take);
      remaining -= take;
    }
  } else {
    const count = Math.max(2, Math.min(12, options.count || 3));
    const each = Math.floor(totalH / count);
    for (let i = 0; i < count; i++) {
      sliceHeights.push(i === count - 1 ? totalH - each * (count - 1) : each);
    }
  }

  let srcY = 0;
  const outputs: OutputFileRef[] = [];
  for (let i = 0; i < sliceHeights.length; i++) {
    const h = Math.max(1, sliceHeights[i]);
    const srcSliceH = h / scale;
    const s = createSurface(w, h);
    s.ctx.fillStyle = '#FFFFFF';
    s.ctx.fillRect(0, 0, w, h);
    s.ctx.drawImage(loaded.image, 0, srcY, loaded.width, srcSliceH, 0, 0, w, h);
    srcY += srcSliceH;
    outputs.push(await exportSurface(s, `${baseNameOf(file.name)}_切片_${i + 1}.jpg`, 'jpg', 0.92));
  }

  return outputs;
}

/** 3. 多图长图拼接 */
export async function runLongStitchLocal(
  files: LocalPickedFile[],
  options: { direction: 'vertical' | 'horizontal'; gap: number; bgColor: string }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loadedList = await Promise.all(files.map((f) => loadImageOntoCanvas(probe, f.path)));
  const gap = Math.max(0, options.gap);

  if (options.direction === 'horizontal') {
    const targetH = Math.min(1200, Math.max(...loadedList.map((i) => i.height)));
    const scaled = loadedList.map((i) => ({
      ...i,
      drawW: Math.round((i.width * targetH) / i.height),
      drawH: targetH,
    }));
    const totalW = scaled.reduce((s, i) => s + i.drawW, 0) + gap * (scaled.length - 1);
    const s = createSurface(Math.min(4800, totalW), targetH);
    s.ctx.fillStyle = options.bgColor || '#FFFFFF';
    s.ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
    let x = 0;
    for (const item of scaled) {
      s.ctx.drawImage(item.image, x, 0, item.drawW, item.drawH);
      x += item.drawW + gap;
    }
    return [await exportSurface(s, `横向拼接_${Date.now()}.jpg`, 'jpg', 0.9)];
  }

  const targetW = Math.min(1200, loadedList[0].width);
  const scaled = loadedList.map((i) => ({
    ...i,
    drawW: targetW,
    drawH: Math.round((i.height * targetW) / i.width),
  }));
  const totalH = scaled.reduce((s, i) => s + i.drawH, 0) + gap * (scaled.length - 1);
  if (totalH > 12000) {
    throw new Error('拼接总高度超过移动端安全上限，请减少图片数量');
  }
  const s = createSurface(targetW, totalH);
  s.ctx.fillStyle = options.bgColor || '#FFFFFF';
  s.ctx.fillRect(0, 0, targetW, totalH);
  let y = 0;
  for (const item of scaled) {
    s.ctx.drawImage(item.image, 0, y, item.drawW, item.drawH);
    y += item.drawH + gap;
  }
  return [await exportSurface(s, `长图拼接_${Date.now()}.jpg`, 'jpg', 0.9)];
}

/** 4. 图片防盗水印 */
export async function runImageWatermarkLocal(
  file: LocalPickedFile,
  opts: WatermarkOptions
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loaded = await loadImageOntoCanvas(probe, file.path);
  const maxDim = 1800;
  const scale = Math.min(1, maxDim / Math.max(loaded.width, loaded.height));
  const w = Math.round(loaded.width * scale);
  const h = Math.round(loaded.height * scale);

  const s = createSurface(w, h);
  s.ctx.drawImage(loaded.image, 0, 0, w, h);

  const text = (opts.text || '仅限办理业务使用 · 他用无效').trim();
  const mode = opts.mode || 'tile';
  const opacity = Math.min(0.9, Math.max(0.08, opts.opacity ?? 0.32));
  const fontSize = Math.round((opts.fontSize ?? 24) * Math.max(1, w / 600));
  const angleRad = ((opts.angle ?? -30) * Math.PI) / 180;

  s.ctx.save();
  s.ctx.globalAlpha = opacity;
  s.ctx.fillStyle = opts.color || '#555555';
  s.ctx.font = `600 ${fontSize}px sans-serif`;
  s.ctx.textAlign = 'center';
  s.ctx.textBaseline = 'middle';

  if (mode === 'center') {
    s.ctx.translate(w / 2, h / 2);
    s.ctx.rotate(angleRad);
    s.ctx.fillText(text, 0, 0);
  } else {
    const stepX = Math.max(180, text.length * fontSize * 1.3);
    const stepY = Math.max(120, fontSize * 4.2);
    for (let y = -h * 0.2; y < h * 1.2; y += stepY) {
      for (let x = -w * 0.2; x < w * 1.2; x += stepX) {
        s.ctx.save();
        s.ctx.translate(x, y);
        s.ctx.rotate(angleRad);
        s.ctx.fillText(text, 0, 0);
        s.ctx.restore();
      }
    }
  }
  s.ctx.restore();

  return [await exportSurface(s, `${baseNameOf(file.name)}_水印.jpg`, 'jpg', 0.92)];
}

/** 5. 图片格式转换 (PNG / JPG / WEBP) */
export async function runImageFormatConvertLocal(
  files: LocalPickedFile[],
  targetFormat: 'png' | 'jpg' | 'webp'
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const outputs: OutputFileRef[] = [];

  for (const file of files) {
    const loaded = await loadImageOntoCanvas(probe, file.path);
    const s = createSurface(loaded.width, loaded.height);
    if (targetFormat === 'jpg') {
      s.ctx.fillStyle = '#FFFFFF';
      s.ctx.fillRect(0, 0, loaded.width, loaded.height);
    }
    s.ctx.drawImage(loaded.image, 0, 0, loaded.width, loaded.height);
    outputs.push(
      await exportSurface(s, `${baseNameOf(file.name)}.${targetFormat}`, targetFormat, 0.92)
    );
  }
  return outputs;
}

/** 6. 图片智能压缩 */
export async function runImageCompressLocal(
  files: LocalPickedFile[],
  options: { quality: number; maxWidth?: number }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const outputs: OutputFileRef[] = [];
  const q = Math.min(0.95, Math.max(0.15, options.quality / 100));

  for (const file of files) {
    const loaded = await loadImageOntoCanvas(probe, file.path);
    let targetW = loaded.width;
    let targetH = loaded.height;
    if (options.maxWidth && options.maxWidth > 0 && targetW > options.maxWidth) {
      const ratio = options.maxWidth / targetW;
      targetW = options.maxWidth;
      targetH = Math.round(loaded.height * ratio);
    }
    const s = createSurface(targetW, targetH);
    s.ctx.fillStyle = '#FFFFFF';
    s.ctx.fillRect(0, 0, targetW, targetH);
    s.ctx.drawImage(loaded.image, 0, 0, targetW, targetH);
    outputs.push(await exportSurface(s, `${baseNameOf(file.name)}_压缩.jpg`, 'jpg', q));
  }

  return outputs;
}

/** 7. 证件照冲印排版 (1寸/2寸标准6寸相纸 1800x1200 @ 300DPI) */
export async function runIdPhotoLayoutLocal(
  file: LocalPickedFile,
  options: { spec: '1inch' | '2inch'; showCutLines: boolean; paperBg: string }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loaded = await loadImageOntoCanvas(probe, file.path);

  // 6 inch photo paper @ 300 DPI: 1800 x 1200 (landscape)
  const sheetW = 1800;
  const sheetH = 1200;
  const s = createSurface(sheetW, sheetH);
  s.ctx.fillStyle = options.paperBg || '#FFFFFF';
  s.ctx.fillRect(0, 0, sheetW, sheetH);

  // 1 inch: 295 x 413 px -> 4 cols x 2 rows = 8 photos
  // 2 inch: 413 x 579 px -> 4 cols x 1 row or 2x2 rotated; 413x579 fits 4x1 or 3x2?
  // Standard 6-inch 2-inch layout: 4 photos (2 cols x 2 rows rotated or 4x1? 413*4=1652 < 1800, 579*2=1158 < 1200 -> 4 cols x 2 rows = 8? Wait: 413*4 + gaps=1652+90=1742, 579*2 + gap=1158+30=1188! Even 2-inch fits 4x2=8 or 2x2=4 cleanly with margins!)
  const isOneInch = options.spec === '1inch';
  const cellW = isOneInch ? 295 : 413;
  const cellH = isOneInch ? 413 : 531; // 35x45mm = 413x531px @ 300DPI
  const cols = isOneInch ? 4 : 3;
  const rows = 2;
  const gap = isOneInch ? 48 : 54;

  const gridW = cols * cellW + (cols - 1) * gap;
  const gridH = rows * cellH + (rows - 1) * gap;
  const startX = Math.round((sheetW - gridW) / 2);
  const startY = Math.round((sheetH - gridH) / 2);

  // Center-crop source image to photo aspect ratio
  const targetRatio = cellW / cellH;
  const srcRatio = loaded.width / loaded.height;
  let sx = 0;
  let sy = 0;
  let sw = loaded.width;
  let sh = loaded.height;
  if (srcRatio > targetRatio) {
    sw = loaded.height * targetRatio;
    sx = (loaded.width - sw) / 2;
  } else {
    sh = loaded.width / targetRatio;
    sy = (loaded.height - sh) / 2;
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = startX + c * (cellW + gap);
      const y = startY + r * (cellH + gap);
      s.ctx.drawImage(loaded.image, sx, sy, sw, sh, x, y, cellW, cellH);

      if (options.showCutLines) {
        s.ctx.strokeStyle = '#CBD5E1';
        s.ctx.lineWidth = 2;
        s.ctx.strokeRect(x, y, cellW, cellH);
      }
    }
  }

  return [
    await exportSurface(
      s,
      `证件照冲印_${isOneInch ? '1寸8张' : '2寸6张'}_6寸相纸.jpg`,
      'jpg',
      0.95
    ),
  ];
}

/** 8. 本地离线多图合成 PDF */
export async function runImagesToPdfLocal(
  files: LocalPickedFile[],
  options: { pageSize: 'A4' | 'fit'; margin: number }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const inputs: LocalPdfImageInput[] = [];

  for (const f of files) {
    const loaded = await loadImageOntoCanvas(probe, f.path);
    const maxW = 1600;
    const scale = Math.min(1, maxW / Math.max(loaded.width, loaded.height));
    const w = Math.round(loaded.width * scale);
    const h = Math.round(loaded.height * scale);

    const s = createSurface(w, h);
    s.ctx.fillStyle = '#FFFFFF';
    s.ctx.fillRect(0, 0, w, h);
    s.ctx.drawImage(loaded.image, 0, 0, w, h);

    let jpegBytes: Uint8Array;
    // #ifdef MP-WEIXIN
    if (s.isWeixin) {
      const dataUrl: string = s.canvas.toDataURL('image/jpeg', 0.9);
      const b64 = dataUrl.split(',')[1] || '';
      jpegBytes = base64ToBytes(b64);
    } else {
      // #endif
      const blob = await new Promise<Blob>((resolve, reject) => {
        s.canvas.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error('编码失败'))), 'image/jpeg', 0.9);
      });
      jpegBytes = new Uint8Array(await blob.arrayBuffer());
      // #ifdef MP-WEIXIN
    }
    // #endif

    inputs.push({ jpegBytes, width: w, height: h });
  }

  const pdfBytes = buildPdfFromJpegs(inputs, options);
  const outName = `多图合成_${files.length}页.pdf`;

  // #ifdef MP-WEIXIN
  if (typeof wx !== 'undefined' && wx.getFileSystemManager) {
    const outPath = `${wx.env.USER_DATA_PATH}/tu_${Date.now()}.pdf`;
    wx.getFileSystemManager().writeFileSync(outPath, bytesToBase64(pdfBytes), 'base64');
    return [
      {
        fileId: outPath,
        fileName: outName,
        size: pdfBytes.length,
        mimeType: 'application/pdf',
        downloadUrl: outPath,
        source: 'local',
        previewableImage: false,
      },
    ];
  }
  // #endif

  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  return [
    {
      fileId: url,
      fileName: outName,
      size: blob.size,
      mimeType: 'application/pdf',
      downloadUrl: url,
      source: 'local',
      previewableImage: false,
    },
  ];
}

/** 9. 本地离线发票合同扫描增强 */
export async function runScanEnhanceLocal(
  file: LocalPickedFile,
  strength: 'mild' | 'strong' = 'strong'
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loaded = await loadImageOntoCanvas(probe, file.path);
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(loaded.width, loaded.height));
  const w = Math.round(loaded.width * scale);
  const h = Math.round(loaded.height * scale);

  const s = createSurface(w, h);
  s.ctx.drawImage(loaded.image, 0, 0, w, h);
  const imgData = s.ctx.getImageData(0, 0, w, h);
  const pixels = imgData.data;

  // Estimate bright paper illumination envelope via separable downsampled max + smooth
  const step = 4;
  const bw = Math.max(1, Math.ceil(w / step));
  const bh = Math.max(1, Math.ceil(h / step));
  const cellAvg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y0 = by * step;
    const y1 = Math.min(h, y0 + step);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * step;
      const x1 = Math.min(w, x0 + step);
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 4;
          sum += pixels[o] * 0.299 + pixels[o + 1] * 0.587 + pixels[o + 2] * 0.114;
          cnt++;
        }
      }
      cellAvg[by * bw + bx] = sum / Math.max(1, cnt);
    }
  }

  const radius = Math.max(16, Math.round(Math.min(w, h) / 26));
  const br = Math.max(3, Math.min(28, Math.round(radius / step)));
  const dilH = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const rowOff = y * bw;
    for (let x = 0; x < bw; x++) {
      const lx0 = Math.max(0, x - br);
      const lx1 = Math.min(bw - 1, x + br);
      let mx = 0;
      for (let k = lx0; k <= lx1; k++) {
        if (cellAvg[rowOff + k] > mx) mx = cellAvg[rowOff + k];
      }
      dilH[rowOff + x] = mx;
    }
  }
  const dilV = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const ly0 = Math.max(0, y - br);
    const ly1 = Math.min(bh - 1, y + br);
    for (let x = 0; x < bw; x++) {
      let mx = 0;
      for (let k = ly0; k <= ly1; k++) {
        if (dilH[k * bw + x] > mx) mx = dilH[k * bw + x];
      }
      dilV[y * bw + x] = mx;
    }
  }
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

  const sampleBg = (x: number, y: number): number => {
    const fx = Math.max(0, Math.min(bw - 1, (x + 0.5) / step - 0.5));
    const fy = Math.max(0, Math.min(bh - 1, (y + 0.5) / step - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(bw - 1, x0 + 1);
    const y1 = Math.min(bh - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = smallBg[y0 * bw + x0] + (smallBg[y0 * bw + x1] - smallBg[y0 * bw + x0]) * tx;
    const bot = smallBg[y1 * bw + x0] + (smallBg[y1 * bw + x1] - smallBg[y1 * bw + x0]) * tx;
    return top + (bot - top) * ty;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const bg = Math.max(32, sampleBg(x, y));

      if (strength === 'strong') {
        const yVal = pixels[o] * 0.299 + pixels[o + 1] * 0.587 + pixels[o + 2] * 0.114;
        const normalized = Math.min(255, (yVal / bg) * 246);
        let val = 255 - (255 - normalized) * 1.6;
        if (val >= 234) val = 255;
        val = Math.max(0, Math.min(255, Math.round(val)));
        pixels[o] = val;
        pixels[o + 1] = val;
        pixels[o + 2] = val;
        pixels[o + 3] = 255;
      } else {
        // Gentle color-preserving enhancement: keeps red tax seals, stamps & borders vivid
        const gain = Math.min(3.2, 248 / Math.max(36, bg));
        let r = Math.min(255, pixels[o] * gain);
        let g = Math.min(255, pixels[o + 1] * gain);
        let b = Math.min(255, pixels[o + 2] * gain);

        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const chroma = maxC - minC;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const neutral = chroma <= 8 ? 1 : chroma >= 20 ? 0 : 1 - (chroma - 8) / 12;
        const colorMask = 1 - neutral;

        if (colorMask > 0.01) {
          const satBoost = 1 + 0.28 * colorMask;
          r = Math.max(0, Math.min(255, luma + (r - luma) * satBoost));
          g = Math.max(0, Math.min(255, luma + (g - luma) * satBoost));
          b = Math.max(0, Math.min(255, luma + (b - luma) * satBoost));
        }
        if (neutral > 0) {
          const whiteBlend = Math.max(0, Math.min(1, (luma - 198) / 32)) * neutral;
          if (whiteBlend > 0) {
            r += (255 - r) * whiteBlend;
            g += (255 - g) * whiteBlend;
            b += (255 - b) * whiteBlend;
          } else if (luma < 192) {
            const inkScale = Math.max(0, 1 - neutral * 0.24 * (1 - luma / 200));
            r *= inkScale;
            g *= inkScale;
            b *= inkScale;
          }
        }
        pixels[o] = Math.max(0, Math.min(255, Math.round(r)));
        pixels[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
        pixels[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
        pixels[o + 3] = 255;
      }
    }
  }

  s.ctx.putImageData(imgData, 0, 0);
  return [await exportSurface(s, `${baseNameOf(file.name)}_扫描增强.jpg`, 'jpg', 0.92)];
}

/** 10. 本地证件照换底色 */
export async function runIdPhotoBgLocal(
  file: LocalPickedFile,
  options: { bgColor: string; tolerance?: number; feather?: number; cropRatio?: 'original' | '1inch' | '2inch' }
): Promise<OutputFileRef[]> {
  const probe = createSurface(10, 10);
  const loaded = await loadImageOntoCanvas(probe, file.path);

  let sx = 0;
  let sy = 0;
  let sw = loaded.width;
  let sh = loaded.height;
  let outW = loaded.width;
  let outH = loaded.height;

  if (options.cropRatio === '1inch' || options.cropRatio === '2inch') {
    const targetW = options.cropRatio === '1inch' ? 295 : 413;
    const targetH = options.cropRatio === '1inch' ? 413 : 531;
    const targetRatio = targetW / targetH;
    const srcRatio = loaded.width / loaded.height;
    if (srcRatio > targetRatio) {
      sw = loaded.height * targetRatio;
      sx = (loaded.width - sw) / 2;
    } else {
      sh = loaded.width / targetRatio;
      sy = (loaded.height - sh) / 2;
    }
    outW = targetW * 2;
    outH = targetH * 2;
  }

  const maxDim = 1200;
  const scale = Math.min(1, maxDim / Math.max(outW, outH));
  const w = Math.round(outW * scale);
  const h = Math.round(outH * scale);

  const s = createSurface(w, h);
  s.ctx.drawImage(loaded.image, sx, sy, sw, sh, 0, 0, w, h);
  const imgData = s.ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Sample border background color
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let cnt = 0;
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 25))) {
    const o = x * 4;
    sumR += data[o];
    sumG += data[o + 1];
    sumB += data[o + 2];
    cnt++;
  }
  const avgR = sumR / cnt;
  const avgG = sumG / cnt;
  const avgB = sumB / cnt;

  const cleanHex = options.bgColor.replace('#', '');
  const tr = parseInt(cleanHex.slice(0, 2), 16) || 67;
  const tg = parseInt(cleanHex.slice(2, 4), 16) || 142;
  const tb = parseInt(cleanHex.slice(4, 6), 16) || 219;

  const hardDist = Math.max(14, options.tolerance ?? 38);
  const softDist = hardDist + Math.max(8, (options.feather ?? 4) * 5);

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const enqueue = (idx: number) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  for (let x = 0; x < w; x++) {
    enqueue(x);
    enqueue((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    enqueue(y * w);
    enqueue(y * w + (w - 1));
  }

  while (head < tail) {
    const idx = queue[head++];
    const o = idx * 4;
    const dr = data[o] - avgR;
    const dg = data[o + 1] - avgG;
    const db = data[o + 2] - avgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist <= softDist) {
      const weight = dist <= hardDist ? 1 : 1 - (dist - hardDist) / (softDist - hardDist);
      data[o] = Math.round(data[o] * (1 - weight) + tr * weight);
      data[o + 1] = Math.round(data[o + 1] * (1 - weight) + tg * weight);
      data[o + 2] = Math.round(data[o + 2] * (1 - weight) + tb * weight);

      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0) enqueue(idx - 1);
      if (x < w - 1) enqueue(idx + 1);
      if (y > 0) enqueue(idx - w);
      if (y < h - 1) enqueue(idx + w);
    }
  }

  s.ctx.putImageData(imgData, 0, 0);
  return [await exportSurface(s, `${baseNameOf(file.name)}_换底.jpg`, 'jpg', 0.94)];
}
