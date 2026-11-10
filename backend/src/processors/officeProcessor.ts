import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import mime from 'mime-types';
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import type { OutputFileRef, ToolParams } from '@tool-universal/shared';
import type { ProcessContext } from '../queue/taskManager.js';
import { isBinaryAvailable, runBinary } from '../utils/exec.js';
import { fallbackExcelToPdf, fallbackPptToPdf, fallbackWordToPdf } from './officeFallback.js';
import { applyPdfWatermark, renderPdfToImages } from './pdfProcessor.js';

async function convertOfficeToPdf(
  inputPath: string,
  outDir: string,
  profileDir: string,
  params: ToolParams,
  toolId?: string,
  outputStyle?: 'pages' | 'long-image'
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const ext = path.extname(inputPath).toLowerCase();
  const base = path.parse(inputPath).name;
  const fallbackOutPdf = path.join(outDir, `${base}.pdf`);

  if (await isBinaryAvailable('soffice', '--version')) {
    await fs.mkdir(profileDir, { recursive: true });
    const userProfileUrl = pathToFileURL(profileDir).href;
    await runBinary(
      'soffice',
      [
        '--headless',
        '--norestore',
        '--invisible',
        `-env:UserInstallation=${userProfileUrl}`,
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inputPath,
      ],
      { timeoutMs: 180_000 }
    );

    const files = await fs.readdir(outDir);
    const pdfName = files.find((f) => f.toLowerCase().endsWith('.pdf'));
    if (pdfName) {
      return path.join(outDir, pdfName);
    }
  }

  // Zero-dependency pure Node fallback for local development without LibreOffice
  if (ext === '.docx' || ext === '.txt' || ext === '.md') {
    await fallbackWordToPdf(inputPath, fallbackOutPdf, outDir);
    return fallbackOutPdf;
  }
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const excelLandscape = params.landscape ?? 'auto';
    const continuous =
      toolId === 'excel-to-long-image' && (outputStyle ?? 'long-image') === 'long-image';
    await fallbackExcelToPdf(
      inputPath,
      fallbackOutPdf,
      outDir,
      excelLandscape,
      params.fitToPage ?? true,
      continuous
    );
    return fallbackOutPdf;
  }
  if (ext === '.pptx') {
    await fallbackPptToPdf(inputPath, fallbackOutPdf, outDir);
    return fallbackOutPdf;
  }

  throw new Error(`系统未安装 LibreOffice，暂无法转换旧版 ${ext} 文件（Docker/微信云托管环境已内置支持）`);
}

export async function stitchImagesVertically(
  imagePaths: string[],
  outputPath: string,
  format: 'png' | 'jpg' = 'png'
): Promise<void> {
  if (imagePaths.length === 0) {
    throw new Error('没有可拼接的图片');
  }

  if (imagePaths.length === 1) {
    await sharp(imagePaths[0]).toFormat(format === 'jpg' ? 'jpeg' : 'png').toFile(outputPath);
    return;
  }

  const firstMeta = await sharp(imagePaths[0]).metadata();
  const targetWidth = Math.min(1800, firstMeta.width || 1200);

  const resizedBuffers: { buf: Buffer; height: number }[] = [];
  let totalHeight = 0;

  for (const imgPath of imagePaths) {
    const { data, info } = await sharp(imgPath)
      .resize({ width: targetWidth })
      .png()
      .toBuffer({ resolveWithObject: true });
    resizedBuffers.push({ buf: data, height: info.height });
    totalHeight += info.height;
  }

  if (totalHeight > 32000) {
    throw new Error('文档页数过多，单张长图高度超过限制，请在上方「导出形式」改用「逐页高清图片」模式导出');
  }

  let currentTop = 0;
  const composites = resizedBuffers.map((item) => {
    const overlay = { input: item.buf, top: currentTop, left: 0 };
    currentTop += item.height;
    return overlay;
  });

  const canvas = sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).composite(composites);

  if (format === 'jpg') {
    await canvas.jpeg({ quality: 90 }).toFile(outputPath);
  } else {
    await canvas.png({ compressionLevel: 7 }).toFile(outputPath);
  }
}

export async function extractImagesFromOfficeZip(docPath: string, outDir: string): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const zipBytes = await fs.readFile(docPath);
  const zip = await JSZip.loadAsync(zipBytes);
  const mediaRegex = /^(word|xl|ppt)\/media\/.+\.(png|jpe?g|gif|webp|bmp)$/i;

  const extracted: string[] = [];
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && mediaRegex.test(entry.name));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const buf = await entry.async('nodebuffer');
    if (buf.length < 256) continue;
    const ext = path.extname(entry.name) || '.png';
    const targetPath = path.join(outDir, `image_${i + 1}${ext.toLowerCase()}`);
    await fs.writeFile(targetPath, buf);
    extracted.push(targetPath);
  }

  return extracted;
}

export async function extractImagesFromPdf(pdfPath: string, outDir: string): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });

  if (await isBinaryAvailable('pdfimages', '-v')) {
    const prefix = path.join(outDir, 'pdfimg');
    await runBinary('pdfimages', ['-png', pdfPath, prefix], { timeoutMs: 120_000 });
    const items = (await fs.readdir(outDir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const results: string[] = [];
    for (const name of items) {
      const full = path.join(outDir, name);
      const stat = await fs.stat(full);
      if (stat.size >= 1024) results.push(full);
    }
    if (results.length > 0) return results;
  }

  // MuPDF WASM embedded image extraction fallback
  const pdfBytes = await fs.readFile(pdfPath);
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  const seenHashes = new Set<string>();
  const results: string[] = [];
  const pendingWrites: Array<{ target: string; bytes: Uint8Array }> = [];

  try {
    const pageCount = doc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      let stext: mupdf.StructuredText | undefined;
      try {
        stext = page.toStructuredText('preserve-images');
        let imgIdx = 0;
        stext.walk({
          onImageBlock(_bbox, _transform, image) {
            if (image.getImageMask()) return;
            if (image.getWidth() < 24 || image.getHeight() < 24) return;
            let pix: mupdf.Pixmap | undefined;
            try {
              pix = image.toPixmap();
              const pngBytes = pix.asPNG();
              const hash = crypto.createHash('sha1').update(pngBytes).digest('hex');
              if (seenHashes.has(hash)) return;
              seenHashes.add(hash);
              imgIdx++;
              const target = path.join(outDir, `pdf_p${i + 1}_img${imgIdx}.png`);
              results.push(target);
              pendingWrites.push({ target, bytes: Uint8Array.from(pngBytes) });
            } finally {
              pix?.destroy();
            }
          },
        });
      } finally {
        stext?.destroy();
        page.destroy();
      }
    }
    await Promise.all(pendingWrites.map((w) => fs.writeFile(w.target, w.bytes)));
    return results;
  } finally {
    doc.destroy();
  }
}

export async function processOfficeTool(ctx: ProcessContext): Promise<OutputFileRef[]> {
  const { toolId } = ctx.request;
  const params: ToolParams = ctx.request.params || {};
  const inputPath = ctx.localInputPaths[0];
  const baseName = path.parse(ctx.request.files[0].fileName).name;
  const outputs: OutputFileRef[] = [];

  if (toolId === 'extract-doc-images') {
    ctx.updateProgress(40, '正在扫描并提取文档原图...');
    const extractDir = path.join(ctx.workDir, 'extracted');

    let imageFiles: string[] = [];
    if (inputPath.toLowerCase().endsWith('.pdf')) {
      imageFiles = await extractImagesFromPdf(inputPath, extractDir);
    } else if (/\.(docx|xlsx|pptx)$/i.test(inputPath)) {
      imageFiles = await extractImagesFromOfficeZip(inputPath, extractDir);
    } else {
      throw new Error('提取原图支持 PDF、DOCX、XLSX、PPTX 格式文档');
    }

    if (imageFiles.length === 0) {
      throw new Error('该文档中未检测到可提取的图片资源');
    }

    for (let i = 0; i < imageFiles.length; i++) {
      const filePath = imageFiles[i];
      const ext = path.extname(filePath).toLowerCase() || '.png';
      const mimeType = mime.lookup(ext) || 'image/png';
      outputs.push(await ctx.addOutput(filePath, `${baseName}_原图_${i + 1}${ext}`, mimeType));
    }
    return outputs;
  }

  const requestedOutputStyle =
    params.outputStyle || (toolId === 'excel-to-long-image' ? 'long-image' : 'pages');

  // Office -> PDF pipeline (LibreOffice or pure-Node fallback)
  ctx.updateProgress(35, '正在高保真排版转换...');
  const pdfOutDir = path.join(ctx.workDir, 'pdf_out');
  const loProfileDir = path.join(ctx.workDir, 'lo_profile');
  const rawPdfPath = await convertOfficeToPdf(
    inputPath,
    pdfOutDir,
    loProfileDir,
    params,
    toolId,
    requestedOutputStyle
  );

  if (toolId === 'word-to-pdf' || toolId === 'excel-to-pdf' || toolId === 'ppt-to-pdf') {
    let finalPdfPath = rawPdfPath;
    if (params.watermark?.enabled && params.watermark.text?.trim()) {
      ctx.updateProgress(70, '正在加盖防盗水印...');
      finalPdfPath = path.join(ctx.workDir, `${baseName}_watermarked.pdf`);
      await applyPdfWatermark(rawPdfPath, finalPdfPath, params.watermark);
    }
    outputs.push(await ctx.addOutput(finalPdfPath, `${baseName}.pdf`, 'application/pdf'));
    return outputs;
  }

  // Office -> Image / Long Image pipeline
  ctx.updateProgress(65, '正在渲染高清页面图像...');
  const fmt = params.imageFormat === 'jpg' ? 'jpg' : 'png';
  const dpi = params.dpi || 150;
  const imgDir = path.join(ctx.workDir, 'pages');
  const pageImages = await renderPdfToImages(rawPdfPath, imgDir, fmt, dpi);

  if (requestedOutputStyle === 'long-image') {
    ctx.updateProgress(85, '正在无缝拼接超清长图...');
    const longPath = path.join(ctx.workDir, `${baseName}_长图.${fmt}`);
    await stitchImagesVertically(pageImages, longPath, fmt);
    outputs.push(
      await ctx.addOutput(longPath, `${baseName}_长图.${fmt}`, fmt === 'jpg' ? 'image/jpeg' : 'image/png')
    );
    return outputs;
  }

  for (let i = 0; i < pageImages.length; i++) {
    outputs.push(
      await ctx.addOutput(
        pageImages[i],
        `${baseName}_第${i + 1}页.${fmt}`,
        fmt === 'jpg' ? 'image/jpeg' : 'image/png'
      )
    );
  }
  return outputs;
}
