import fs from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import sharp from 'sharp';
import {
  checkCustomTextComplianceLocal,
  type OutputFileRef,
  type PdfInspectResponse,
  type ToolParams,
  type WatermarkOptions,
} from '@tool-universal/shared';
import type { ProcessContext } from '../queue/taskManager.js';
import { isBinaryAvailable, runBinary } from '../utils/exec.js';
import { findCjkFontPath } from '../utils/fontLoader.js';
import { convertPdfToDocx } from './pdfToDocx.js';

function hexToRgbTuple(hex = '#888888'): [number, number, number] {
  const cleaned = hex.replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return [
      parseInt(cleaned.slice(0, 2), 16) / 255,
      parseInt(cleaned.slice(2, 4), 16) / 255,
      parseInt(cleaned.slice(4, 6), 16) / 255,
    ];
  }
  return [0.53, 0.53, 0.53];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function createWatermarkStampPng(text: string, color: string, opacity: number, fontSize: number): Promise<Buffer> {
  const safeText = escapeXml(text);
  const width = Math.max(240, Math.min(900, text.length * fontSize * 1.4 + 60));
  const height = Math.max(100, fontSize * 3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
      font-family="Noto Sans CJK SC, Microsoft YaHei, PingFang SC, sans-serif"
      font-size="${fontSize}" font-weight="600" fill="${color}" fill-opacity="${opacity}">
      ${safeText}
    </text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function inspectPdfFile(pdfPath: string, fileName: string): Promise<PdfInspectResponse> {
  const bytes = await fs.readFile(pdfPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    return {
      pageNumber: index + 1,
      width: Math.round(width),
      height: Math.round(height),
    };
  });
  return {
    pageCount: pages.length,
    fileName,
    pages,
  };
}

export function parsePageSelection(totalPages: number, pages?: number[], pageRange?: string): number[] {
  const selected = new Set<number>();

  if (pageRange && pageRange.trim()) {
    const segments = pageRange.split(/[,，\s]+/).filter(Boolean);
    for (const seg of segments) {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(seg.trim());
      if (rangeMatch) {
        const start = Math.max(1, Number(rangeMatch[1]));
        const end = Math.min(totalPages, Number(rangeMatch[2]));
        for (let i = start; i <= end; i++) selected.add(i);
      } else if (/^\d+$/.test(seg.trim())) {
        const num = Number(seg.trim());
        if (num >= 1 && num <= totalPages) selected.add(num);
      }
    }
  } else if (Array.isArray(pages) && pages.length > 0) {
    for (const p of pages) {
      if (Number.isInteger(p) && p >= 1 && p <= totalPages) {
        selected.add(p);
      }
    }
  }

  return Array.from(selected).sort((a, b) => a - b);
}

export async function applyPdfWatermark(
  inputPdfPath: string,
  outputPdfPath: string,
  opts?: WatermarkOptions
): Promise<void> {
  const bytes = await fs.readFile(inputPdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const text = (opts?.text || '仅供内部参考 · 禁止外传').trim();
  const localCompliance = checkCustomTextComplianceLocal(text);
  if (!localCompliance.allowed) {
    throw new Error(localCompliance.message);
  }
  const mode = opts?.mode || 'tile';
  const opacity = Math.min(0.85, Math.max(0.08, opts?.opacity ?? 0.25));
  const fontSize = Math.min(64, Math.max(12, opts?.fontSize ?? 22));
  const angle = opts?.angle ?? -30;
  const colorHex = opts?.color || '#666666';
  const [r, g, b] = hexToRgbTuple(colorHex);

  const isAsciiOnly = /^[\x20-\x7E]+$/.test(text);
  let embeddedFont: Awaited<ReturnType<PDFDocument['embedFont']>> | null = null;

  if (isAsciiOnly) {
    embeddedFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  } else {
    const fontPath = await findCjkFontPath();
    if (fontPath && /\.(ttf|otf)$/i.test(fontPath)) {
      try {
        pdfDoc.registerFontkit(fontkit);
        const fontBytes = await fs.readFile(fontPath);
        embeddedFont = await pdfDoc.embedFont(fontBytes, { subset: true });
      } catch {
        embeddedFont = null;
      }
    }
  }

  let stampImage: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null;
  if (!embeddedFont) {
    const pngBuf = await createWatermarkStampPng(text, colorHex, opacity, fontSize);
    stampImage = await pdfDoc.embedPng(pngBuf);
  }

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    if (embeddedFont) {
      if (mode === 'center') {
        const textWidth = embeddedFont.widthOfTextAtSize(text, fontSize * 1.4);
        page.drawText(text, {
          x: Math.max(20, (width - textWidth * 0.7) / 2),
          y: height / 2,
          size: fontSize * 1.4,
          font: embeddedFont,
          color: rgb(r, g, b),
          opacity,
          rotate: degrees(angle),
        });
      } else {
        const stepX = Math.max(180, text.length * fontSize * 1.15);
        const stepY = Math.max(130, fontSize * 5);
        for (let y = 40; y < height + 80; y += stepY) {
          for (let x = -40; x < width + 80; x += stepX) {
            page.drawText(text, {
              x,
              y,
              size: fontSize,
              font: embeddedFont,
              color: rgb(r, g, b),
              opacity,
              rotate: degrees(angle),
            });
          }
        }
      }
    } else if (stampImage) {
      const dims = stampImage.scale(mode === 'center' ? 1.1 : 0.75);
      if (mode === 'center') {
        page.drawImage(stampImage, {
          x: (width - dims.width) / 2,
          y: (height - dims.height) / 2,
          width: dims.width,
          height: dims.height,
          rotate: degrees(angle),
        });
      } else {
        const stepX = Math.max(200, dims.width * 1.1);
        const stepY = Math.max(140, dims.height * 1.6);
        for (let y = 20; y < height + 60; y += stepY) {
          for (let x = -20; x < width + 60; x += stepX) {
            page.drawImage(stampImage, {
              x,
              y,
              width: dims.width,
              height: dims.height,
              rotate: degrees(angle),
            });
          }
        }
      }
    }
  }

  const outBytes = await pdfDoc.save();
  await fs.writeFile(outputPdfPath, outBytes);
}

/**
 * Renders PDF pages to PNG/JPG using poppler pdftoppm when present,
 * falling back seamlessly to bundled MuPDF WebAssembly when running locally without poppler.
 */
export async function renderPdfToImages(
  pdfPath: string,
  outDir: string,
  imageFormat: 'png' | 'jpg' = 'png',
  dpi: number = 200
): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });

  if (await isBinaryAvailable('pdftoppm', '-v')) {
    const prefix = path.join(outDir, 'page');
    const formatFlag = imageFormat === 'jpg' ? '-jpeg' : '-png';

    await runBinary('pdftoppm', [formatFlag, '-r', String(dpi), pdfPath, prefix], {
      timeoutMs: 180_000,
    });

    const entries = await fs.readdir(outDir);
    const ext = imageFormat === 'jpg' ? '.jpg' : '.png';
    const matched = entries
      .filter((f) => f.startsWith('page') && f.toLowerCase().endsWith(ext))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (matched.length > 0) {
      return matched.map((f) => path.join(outDir, f));
    }
  }

  // MuPDF WASM zero-dependency fallback
  const bytes = await fs.readFile(pdfPath);
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const count = doc.countPages();
    if (count === 0) {
      throw new Error('PDF 文档不包含任何页面');
    }

    const scale = dpi / 72;
    const matrix = mupdf.Matrix.scale(scale, scale);
    const results: string[] = [];

    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      let pixmap: mupdf.Pixmap | undefined;
      try {
        pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
        const encoded = imageFormat === 'jpg' ? pixmap.asJPEG(90, false) : pixmap.asPNG();
        const filePath = path.join(outDir, `page_${i + 1}.${imageFormat}`);
        await fs.writeFile(filePath, encoded);
        results.push(filePath);
      } finally {
        pixmap?.destroy();
        page.destroy();
      }
    }

    return results;
  } finally {
    doc.destroy();
  }
}

export async function processPdfTool(ctx: ProcessContext): Promise<OutputFileRef[]> {
  const { toolId } = ctx.request;
  const params: ToolParams = ctx.request.params || {};
  const outputs: OutputFileRef[] = [];

  if (toolId === 'pdf-to-word') {
    ctx.updateProgress(20, '正在智能解析 PDF 文档结构...');
    const baseName = path.parse(ctx.request.files[0]?.fileName || 'document').name || 'document';
    const outPath = path.join(ctx.workDir, `${baseName}.docx`);
    await convertPdfToDocx(ctx.localInputPaths[0], outPath, {
      preservePageBreaks: params.preservePageBreaks ?? true,
      preserveImages: params.preserveImages ?? true,
      onProgress: (pct, stageText) => ctx.updateProgress(pct, stageText),
    });
    outputs.push(
      await ctx.addOutput(
        outPath,
        `${baseName}.docx`,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    );
    return outputs;
  }

  if (toolId === 'images-to-pdf') {
    ctx.updateProgress(35, '正在合成 PDF 文档...');
    const pdfDoc = await PDFDocument.create();
    const pageSizeMode = params.pageSize || 'A4';
    const margin = Math.max(0, Math.min(60, params.margin ?? 20));
    const A4_W = 595.28;
    const A4_H = 841.89;

    for (let i = 0; i < ctx.localInputPaths.length; i++) {
      const imgPath = ctx.localInputPaths[i];
      const meta = await sharp(imgPath).rotate().metadata();
      let embedded;
      if (meta.format === 'jpeg') {
        const buf = await sharp(imgPath).rotate().jpeg({ quality: 92 }).toBuffer();
        embedded = await pdfDoc.embedJpg(Uint8Array.from(buf));
      } else {
        const buf = await sharp(imgPath).rotate().png().toBuffer();
        embedded = await pdfDoc.embedPng(Uint8Array.from(buf));
      }

      if (pageSizeMode === 'fit') {
        const page = pdfDoc.addPage([embedded.width, embedded.height]);
        page.drawImage(embedded, {
          x: 0,
          y: 0,
          width: embedded.width,
          height: embedded.height,
        });
      } else {
        const page = pdfDoc.addPage([A4_W, A4_H]);
        const availW = A4_W - margin * 2;
        const availH = A4_H - margin * 2;
        const scale = Math.min(availW / embedded.width, availH / embedded.height);
        const drawW = embedded.width * scale;
        const drawH = embedded.height * scale;
        page.drawImage(embedded, {
          x: (A4_W - drawW) / 2,
          y: (A4_H - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      }

      ctx.updateProgress(
        35 + Math.round(((i + 1) / ctx.localInputPaths.length) * 55),
        `已排版 ${i + 1}/${ctx.localInputPaths.length} 张图片`
      );
    }

    const outPath = path.join(ctx.workDir, 'composed.pdf');
    await fs.writeFile(outPath, await pdfDoc.save());
    outputs.push(await ctx.addOutput(outPath, '多图合成文档.pdf', 'application/pdf'));
    return outputs;
  }

  if (toolId === 'pdf-merge') {
    ctx.updateProgress(35, '正在合并多份 PDF...');
    const merged = await PDFDocument.create();
    for (let i = 0; i < ctx.localInputPaths.length; i++) {
      const bytes = await fs.readFile(ctx.localInputPaths[i]);
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const copiedPages = await merged.copyPages(src, src.getPageIndices());
      copiedPages.forEach((p) => merged.addPage(p));
      ctx.updateProgress(
        35 + Math.round(((i + 1) / ctx.localInputPaths.length) * 55),
        `已合并 ${i + 1}/${ctx.localInputPaths.length} 份`
      );
    }
    const outPath = path.join(ctx.workDir, 'merged.pdf');
    await fs.writeFile(outPath, await merged.save());
    outputs.push(await ctx.addOutput(outPath, 'PDF合并文档.pdf', 'application/pdf'));
    return outputs;
  }

  if (toolId === 'pdf-split') {
    const srcPath = ctx.localInputPaths[0];
    const bytes = await fs.readFile(srcPath);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const splitMode = params.splitMode || 'extract-selected';

    if (splitMode === 'each-page') {
      ctx.updateProgress(35, `正在逐页拆分为 ${totalPages} 份文档...`);
      for (let i = 0; i < totalPages; i++) {
        const single = await PDFDocument.create();
        const [copied] = await single.copyPages(srcDoc, [i]);
        single.addPage(copied);
        const outPath = path.join(ctx.workDir, `page_${i + 1}.pdf`);
        await fs.writeFile(outPath, await single.save());
        outputs.push(await ctx.addOutput(outPath, `第${i + 1}页.pdf`, 'application/pdf'));
      }
      return outputs;
    }

    const picked = parsePageSelection(totalPages, params.pages, params.pageRange);
    if (picked.length === 0) {
      throw new Error(`请选择有效的页码（当前 PDF 共 ${totalPages} 页）`);
    }

    ctx.updateProgress(55, `正在提取 ${picked.length} 页...`);
    const outDoc = await PDFDocument.create();
    const indices = picked.map((p) => p - 1);
    const copied = await outDoc.copyPages(srcDoc, indices);
    copied.forEach((p) => outDoc.addPage(p));

    const outPath = path.join(ctx.workDir, 'extracted.pdf');
    await fs.writeFile(outPath, await outDoc.save());
    outputs.push(await ctx.addOutput(outPath, `PDF提取_${picked.length}页.pdf`, 'application/pdf'));
    return outputs;
  }

  if (toolId === 'pdf-watermark') {
    ctx.updateProgress(45, '正在添加防盗水印...');
    const outPath = path.join(ctx.workDir, 'watermarked.pdf');
    await applyPdfWatermark(ctx.localInputPaths[0], outPath, params.watermark);
    outputs.push(await ctx.addOutput(outPath, '已加水印文档.pdf', 'application/pdf'));
    return outputs;
  }

  if (toolId === 'pdf-to-image') {
    ctx.updateProgress(40, '正在高清渲染 PDF 页面...');
    const fmt = params.imageFormat === 'jpg' ? 'jpg' : 'png';
    const dpi = params.dpi || 200;
    const renderedDir = path.join(ctx.workDir, 'rendered');
    const pages = await renderPdfToImages(ctx.localInputPaths[0], renderedDir, fmt, dpi);
    const mimeType = fmt === 'jpg' ? 'image/jpeg' : 'image/png';

    for (let i = 0; i < pages.length; i++) {
      outputs.push(await ctx.addOutput(pages[i], `第${i + 1}页.${fmt}`, mimeType));
    }
    return outputs;
  }

  throw new Error(`未知 PDF 工具: ${toolId}`);
}
