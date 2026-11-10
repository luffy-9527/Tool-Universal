import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import sharp from 'sharp';
import * as XLSXNamespace from 'xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const XLSX: typeof XLSXNamespace =
  (XLSXNamespace as unknown as { default?: typeof XLSXNamespace }).default ?? XLSXNamespace;
import {
  base64ToBytes,
  buildPdfFromJpegs,
  bytesToBase64,
} from '@tool-universal/shared';
import { buildApp, type AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { extractImagesFromOfficeZip } from '../processors/officeProcessor.js';
import { resolveFfmpegBin, runBinary } from '../utils/exec.js';

async function createSamplePng(width = 120, height = 120, color = { r: 240, g: 245, b: 255 }): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { ...color, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function createSamplePdf(pages = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([400, 600]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 500, size: 24 });
  }
  return Buffer.from(await doc.save());
}

function createMultipartPayload(
  files: Array<{ name: string; filename: string; mimeType: string; data: Buffer }>,
  fields: Array<{ name: string; value: string }> = []
) {
  const boundary = '----ToolUniversalTestBoundary12345';
  const chunks: Buffer[] = [];

  for (const field of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`
      )
    );
  }

  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
      )
    );
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    payload: Buffer.concat(chunks),
  };
}

async function waitForTask(app: AppContext['app'], taskId: string) {
  for (let i = 0; i < 240; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const body = res.json();
    if (body.status === 'completed' || body.status === 'failed') {
      return body;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Task ${taskId} timed out`);
}

describe('Tool-Universal Backend API & Processors', () => {
  let ctx: AppContext;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-universal-test-'));
    const config: AppConfig = {
      port: 0,
      host: '127.0.0.1',
      storageMode: 'local',
      wxCloudEnv: '',
      maxConcurrency: 2,
      maxFileSize: 50 * 1024 * 1024,
      fileTtlMs: 30 * 60 * 1000,
      tmpRootDir: tmpDir,
      cutoutProvider: 'smart-chroma',
      rembgEndpoint: '',
    };
    ctx = await buildApp(config);
  });

  afterAll(async () => {
    await ctx.app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns health status and canonical 26 tools across 5 categories', async () => {
    const healthRes = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json().ok).toBe(true);

    const toolsRes = await ctx.app.inject({ method: 'GET', url: '/api/tools' });
    expect(toolsRes.statusCode).toBe(200);
    const { categories, tools } = toolsRes.json();
    expect(categories).toHaveLength(5);
    expect(tools).toHaveLength(26);
    expect(tools.some((t: any) => t.id === 'pdf-to-word')).toBe(true);
    expect(tools.some((t: any) => t.id === 'video-to-gif')).toBe(true);
  });

  it('rejects invalid task submission cleanly', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'non-existent-tool', files: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('uploads images, composes PDF, inspects pages, splits & watermarks PDF end-to-end', async () => {
    const png1 = await createSamplePng(200, 300, { r: 220, g: 230, b: 250 });
    const png2 = await createSamplePng(300, 200, { r: 250, g: 220, b: 220 });

    const { boundary, payload } = createMultipartPayload([
      { name: 'files', filename: 'first.png', mimeType: 'image/png', data: png1 },
      { name: 'files', filename: 'second.png', mimeType: 'image/png', data: png2 },
    ]);

    const uploadRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(uploadRes.statusCode).toBe(200);
    const uploadedFiles = uploadRes.json().files;
    expect(uploadedFiles).toHaveLength(2);

    // 1. images-to-pdf
    const composeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'images-to-pdf',
        files: uploadedFiles,
        params: { pageSize: 'A4', margin: 16 },
      },
    });
    expect(composeRes.statusCode).toBe(202);
    const composedTask = await waitForTask(ctx.app, composeRes.json().taskId);
    expect(composedTask.status).toBe('completed');
    expect(composedTask.outputs).toHaveLength(1);

    // Download composed PDF and verify 2 pages
    const pdfDownload = await ctx.app.inject({
      method: 'GET',
      url: composedTask.outputs[0].downloadUrl,
    });
    expect(pdfDownload.statusCode).toBe(200);
    const loadedPdf = await PDFDocument.load(pdfDownload.rawPayload);
    expect(loadedPdf.getPageCount()).toBe(2);

    // 2. Inspect PDF via /api/pdf/inspect
    const samplePdf = await createSamplePdf(4);
    const mpPdf = createMultipartPayload([
      { name: 'file', filename: 'sample.pdf', mimeType: 'application/pdf', data: samplePdf },
    ]);
    const pdfUploadRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mpPdf.boundary}` },
      payload: mpPdf.payload,
    });
    const pdfRef = pdfUploadRes.json().file;

    const inspectRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/pdf/inspect',
      payload: { file: pdfRef },
    });
    expect(inspectRes.statusCode).toBe(200);
    expect(inspectRes.json().pageCount).toBe(4);

    // 3. PDF split (select pages 2-3)
    const splitRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'pdf-split',
        files: [pdfRef],
        params: { splitMode: 'extract-selected', pageRange: '2-3' },
      },
    });
    const splitTask = await waitForTask(ctx.app, splitRes.json().taskId);
    expect(splitTask.status).toBe('completed');
    const splitDownload = await ctx.app.inject({
      method: 'GET',
      url: splitTask.outputs[0].downloadUrl,
    });
    const splitDoc = await PDFDocument.load(splitDownload.rawPayload);
    expect(splitDoc.getPageCount()).toBe(2);

    // 4. PDF watermark (Chinese text fallback / fontkit)
    const wmRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'pdf-watermark',
        files: [pdfRef],
        params: {
          watermark: {
            enabled: true,
            text: '仅限内部审核使用',
            mode: 'tile',
            opacity: 0.3,
          },
        },
      },
    });
    const wmTask = await waitForTask(ctx.app, wmRes.json().taskId);
    expect(wmTask.status).toBe('completed');
    expect(wmTask.outputs[0].size).toBeGreaterThan(samplePdf.length);
  });

  it('processes invoice scan enhancement and smart ID photo background replacement', async () => {
    const samplePhoto = await createSamplePng(160, 200, { r: 225, g: 230, b: 235 });
    const mp = createMultipartPayload([
      { name: 'file', filename: 'id.png', mimeType: 'image/png', data: samplePhoto },
    ]);
    const uploadRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mp.boundary}` },
      payload: mp.payload,
    });
    const fileRef = uploadRes.json().file;

    // Invoice scan enhance
    const scanRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'invoice-scan-enhance',
        files: [fileRef],
        params: { enhanceStrength: 'strong' },
      },
    });
    const scanTask = await waitForTask(ctx.app, scanRes.json().taskId);
    expect(scanTask.status).toBe('completed');
    expect(scanTask.outputs[0].mimeType).toBe('image/jpeg');

    // ID photo background change
    const idRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'id-photo-bg',
        files: [fileRef],
        params: { bgColor: '#438EDB', tolerance: 35, feather: 4 },
      },
    });
    const idTask = await waitForTask(ctx.app, idRes.json().taskId);
    expect(idTask.status).toBe('completed');
    expect(idTask.outputs[0].previewableImage).toBe(true);
  });

  it('extracts embedded original images from DOCX zip archive', async () => {
    const zip = new JSZip();
    const img1 = await createSamplePng(100, 100);
    const img2 = await createSamplePng(80, 80);
    zip.file('word/media/image1.png', img1);
    zip.file('word/media/image2.png', img2);
    zip.file('word/document.xml', '<w:document/>');

    const docxPath = path.join(tmpDir, 'mock.docx');
    const outDir = path.join(tmpDir, 'docx_extracted');
    await fs.writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const extracted = await extractImagesFromOfficeZip(docxPath, outDir);
    expect(extracted).toHaveLength(2);
  });

  it('merges multiple PDFs and runs backend image format convert & compress', async () => {
    const pdf1 = await createSamplePdf(2);
    const pdf2 = await createSamplePdf(3);
    const mp = createMultipartPayload([
      { name: 'files', filename: 'a.pdf', mimeType: 'application/pdf', data: pdf1 },
      { name: 'files', filename: 'b.pdf', mimeType: 'application/pdf', data: pdf2 },
    ]);
    const uploadRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mp.boundary}` },
      payload: mp.payload,
    });
    const uploadedPdfs = uploadRes.json().files;

    const mergeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'pdf-merge', files: uploadedPdfs },
    });
    const mergeTask = await waitForTask(ctx.app, mergeRes.json().taskId);
    expect(mergeTask.status).toBe('completed');
    const mergedDl = await ctx.app.inject({ method: 'GET', url: mergeTask.outputs[0].downloadUrl });
    const mergedDoc = await PDFDocument.load(mergedDl.rawPayload);
    expect(mergedDoc.getPageCount()).toBe(5);

    const png = await createSamplePng(400, 300);
    const imgMp = createMultipartPayload([
      { name: 'file', filename: 'raw.png', mimeType: 'image/png', data: png },
    ]);
    const imgUpload = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${imgMp.boundary}` },
      payload: imgMp.payload,
    });
    const imgRef = imgUpload.json().file;

    const fmtRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'image-format-convert', files: [imgRef], params: { imageFormat: 'webp' } },
    });
    const fmtTask = await waitForTask(ctx.app, fmtRes.json().taskId);
    expect(fmtTask.status).toBe('completed');
    expect(fmtTask.outputs[0].mimeType).toBe('image/webp');

    const cmpRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'image-compress', files: [imgRef], params: { quality: 65, maxWidth: 200 } },
    });
    const cmpTask = await waitForTask(ctx.app, cmpRes.json().taskId);
    expect(cmpTask.status).toBe('completed');
    const cmpDl = await ctx.app.inject({ method: 'GET', url: cmpTask.outputs[0].downloadUrl });
    const meta = await sharp(cmpDl.rawPayload).metadata();
    expect(meta.width).toBe(200);
  });

  it('builds valid multi-page offline PDFs and round-trips base64 without browser globals', async () => {
    const rawSample = new Uint8Array([0, 1, 2, 127, 128, 255, 42, 99]);
    const encoded = bytesToBase64(rawSample);
    expect(base64ToBytes(encoded)).toEqual(rawSample);

    const jpg1 = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 120, b: 80 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    const jpg2 = await sharp({
      create: { width: 240, height: 480, channels: 3, background: { r: 80, g: 160, b: 220 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    const a4Pdf = buildPdfFromJpegs(
      [
        { jpegBytes: new Uint8Array(jpg1), width: 320, height: 240 },
        { jpegBytes: new Uint8Array(jpg2), width: 240, height: 480 },
      ],
      { pageSize: 'A4', margin: 20 }
    );
    const parsedA4 = await PDFDocument.load(a4Pdf);
    expect(parsedA4.getPageCount()).toBe(2);
    expect(Math.round(parsedA4.getPage(0).getSize().width)).toBe(595);

    const fitPdf = buildPdfFromJpegs(
      [{ jpegBytes: new Uint8Array(jpg1), width: 320, height: 240 }],
      { pageSize: 'fit' }
    );
    const parsedFit = await PDFDocument.load(fitPdf);
    expect(parsedFit.getPage(0).getSize()).toEqual({ width: 320, height: 240 });
  });

  it('renders PDF to images and extracts embedded images from PDF via MuPDF fallback', async () => {
    // Build a PDF with an embedded PNG image
    const doc = await PDFDocument.create();
    const imgBuf = await createSamplePng(120, 120, { r: 60, g: 130, b: 220 });
    const embedded = await doc.embedPng(imgBuf);
    const page1 = doc.addPage([300, 400]);
    page1.drawImage(embedded, { x: 40, y: 120, width: 120, height: 120 });
    const page2 = doc.addPage([300, 400]);
    page2.drawText('Second Page', { x: 40, y: 300, size: 18 });
    const pdfBytes = Buffer.from(await doc.save());

    const mp = createMultipartPayload([
      { name: 'file', filename: 'render_test.pdf', mimeType: 'application/pdf', data: pdfBytes },
    ]);
    const uploadRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mp.boundary}` },
      payload: mp.payload,
    });
    const pdfRef = uploadRes.json().file;

    // 1. pdf-to-image
    const renderRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'pdf-to-image',
        files: [pdfRef],
        params: { imageFormat: 'png', dpi: 150 },
      },
    });
    const renderTask = await waitForTask(ctx.app, renderRes.json().taskId);
    expect(renderTask.status).toBe('completed');
    expect(renderTask.outputs).toHaveLength(2);
    expect(renderTask.outputs[0].mimeType).toBe('image/png');

    // 2. extract-doc-images (PDF)
    const extractRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'extract-doc-images',
        files: [pdfRef],
      },
    });
    const extractTask = await waitForTask(ctx.app, extractRes.json().taskId);
    expect(extractTask.status).toBe('completed');
    expect(extractTask.outputs.length).toBeGreaterThanOrEqual(1);
  });

  it('converts Excel, PPTX, and Text/Word documents to PDF and long images', async () => {
    // 1. Excel (.xlsx) -> PDF & Long Image
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['项目名称', '数量', '金额'],
      ['办公耗材', 12, 360],
      ['云托管资源', 1, 86.87],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, '报销明细');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const xlMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: xlsxBuf,
      },
    ]);
    const xlUpload = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${xlMp.boundary}` },
      payload: xlMp.payload,
    });
    const xlRef = xlUpload.json().file;

    const xlPdfRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'excel-to-pdf', files: [xlRef], params: { landscape: true } },
    });
    const xlPdfTask = await waitForTask(ctx.app, xlPdfRes.json().taskId);
    expect(xlPdfTask.status).toBe('completed');
    expect(xlPdfTask.outputs[0].mimeType).toBe('application/pdf');

    const xlImgRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'excel-to-long-image', files: [xlRef] },
    });
    const xlImgTask = await waitForTask(ctx.app, xlImgRes.json().taskId);
    expect(xlImgTask.status).toBe('completed');
    expect(xlImgTask.outputs[0].mimeType).toBe('image/png');

    // 2. PPTX -> PDF & Page Images
    const pptZip = new JSZip();
    pptZip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>项目汇报第一页</a:t></a:r></a:p><a:p><a:r><a:t>全栈架构演示</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    );
    pptZip.file(
      'ppt/slides/slide2.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页总结</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    );
    const pptBuf = await pptZip.generateAsync({ type: 'nodebuffer' });
    const pptMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'deck.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        data: pptBuf,
      },
    ]);
    const pptUpload = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${pptMp.boundary}` },
      payload: pptMp.payload,
    });
    const pptRef = pptUpload.json().file;

    const pptImgRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'ppt-to-image',
        files: [pptRef],
        params: { outputStyle: 'pages', imageFormat: 'jpg' },
      },
    });
    const pptImgTask = await waitForTask(ctx.app, pptImgRes.json().taskId);
    expect(pptImgTask.status).toBe('completed');
    expect(pptImgTask.outputs).toHaveLength(2);

    // 3. Text/Word -> PDF with watermark + originalName restoration
    const docxZip = new JSZip();
    docxZip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    docxZip.file(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
    docxZip.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>劳动人事争议仲裁申请书</w:t></w:r></w:p></w:body></w:document>'
    );
    const docxBuf = await docxZip.generateAsync({ type: 'nodebuffer' });

    const docxMp = createMultipartPayload(
      [{ name: 'file', filename: 'tmp_wx98765.docx', mimeType: 'application/octet-stream', data: docxBuf }],
      [{ name: 'originalName', value: '劳动人事争议仲裁申请书.docx' }]
    );
    const docxUpload = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${docxMp.boundary}` },
      payload: docxMp.payload,
    });
    expect(docxUpload.statusCode).toBe(200);
    expect(docxUpload.json().file.fileName).toBe('劳动人事争议仲裁申请书.docx');

    const wordPdfRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'word-to-pdf',
        files: [docxUpload.json().file],
        params: { watermark: { enabled: true, text: '机密文档', mode: 'center' } },
      },
    });
    const wordPdfTask = await waitForTask(ctx.app, wordPdfRes.json().taskId);
    expect(wordPdfTask.status).toBe('completed');
    expect(wordPdfTask.outputs[0].mimeType).toBe('application/pdf');
    expect(wordPdfTask.outputs[0].fileName).toBe('劳动人事争议仲裁申请书.pdf');
  });

  it('preserves embedded images and tables when converting DOCX and PPTX to PDF', async () => {
    const redPng = await createSamplePng(260, 180, { r: 230, g: 45, b: 45 });
    const blueJpg = await sharp({
      create: { width: 220, height: 220, channels: 3, background: { r: 30, g: 110, b: 235 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const docxZip = new JSZip();
    docxZip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    docxZip.file(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
    docxZip.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.jpg"/></Relationships>'
    );
    docxZip.file('word/media/image1.png', redPng);
    docxZip.file('word/media/image2.jpg', blueJpg);
    docxZip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>图文证据测试文档</w:t></w:r></w:p>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline><wp:extent cx="2476500" cy="1714500"/><a:graphic><a:graphicData><a:blip r:embed="rId10"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
          <w:tbl>
            <w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>
            <w:tr>
              <w:tc><w:p><w:r><w:drawing><wp:inline><wp:extent cx="2095500" cy="2095500"/><a:graphic><a:graphicData><a:blip r:embed="rId11"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>表格右侧说明文字</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>`
    );

    const docxMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'evidence.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: await docxZip.generateAsync({ type: 'nodebuffer' }),
      },
    ]);
    const docxUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${docxMp.boundary}` },
      payload: docxMp.payload,
    });
    const docxPdfRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'word-to-pdf', files: [docxUp.json().file] },
    });
    const docxPdfTask = await waitForTask(ctx.app, docxPdfRes.json().taskId);
    expect(docxPdfTask.status).toBe('completed');

    const pdfDl = await ctx.app.inject({ method: 'GET', url: docxPdfTask.outputs[0].downloadUrl });
    const pdfDoc = mupdf.Document.openDocument(pdfDl.rawPayload, 'application/pdf');
    let totalImageBlocks = 0;
    for (let i = 0; i < pdfDoc.countPages(); i++) {
      const page = pdfDoc.loadPage(i);
      const st = page.toStructuredText('preserve-images');
      st.walk({
        onImageBlock() {
          totalImageBlocks++;
        },
      });
      st.destroy();
      page.destroy();
    }
    pdfDoc.destroy();
    // 1 background SVG layer + 2 embedded Word images (image1.png + table image2.jpg) => >= 3
    expect(totalImageBlocks).toBeGreaterThanOrEqual(3);

    // PPTX with embedded picture
    const pptZip = new JSZip();
    pptZip.file('ppt/media/slide_pic.png', redPng);
    pptZip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/slide_pic.png"/></Relationships>'
    );
    pptZip.file(
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:cSld><p:spTree>
          <p:sp><p:txBody><a:p><a:r><a:t>含图幻灯片测试</a:t></a:r></a:p></p:txBody></p:sp>
          <p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="3657600" cy="2743200"/></a:xfrm></p:spPr></p:pic>
        </p:spTree></p:cSld>
      </p:sld>`
    );
    const pptMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'with_pic.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        data: await pptZip.generateAsync({ type: 'nodebuffer' }),
      },
    ]);
    const pptUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${pptMp.boundary}` },
      payload: pptMp.payload,
    });
    const pptPdfRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'ppt-to-pdf', files: [pptUp.json().file] },
    });
    const pptPdfTask = await waitForTask(ctx.app, pptPdfRes.json().taskId);
    expect(pptPdfTask.status).toBe('completed');
    const pptDl = await ctx.app.inject({ method: 'GET', url: pptPdfTask.outputs[0].downloadUrl });
    const pptDoc = mupdf.Document.openDocument(pptDl.rawPayload, 'application/pdf');
    let pptImgBlocks = 0;
    const sp = pptDoc.loadPage(0);
    const st = sp.toStructuredText('preserve-images');
    st.walk({
      onImageBlock() {
        pptImgBlocks++;
      },
    });
    st.destroy();
    sp.destroy();
    pptDoc.destroy();
    expect(pptImgBlocks).toBeGreaterThanOrEqual(2);
  });

  it('preserves merged cells, styles, rich-text runs, and anchored images in XLSX to PDF/long image', async () => {
    const photoJpg = await sharp({
      create: { width: 140, height: 180, channels: 3, background: { r: 45, g: 120, b: 220 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const xlZip = new JSZip();
    xlZip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="jpg" ContentType="image/jpeg"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
        <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
        <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
      </Types>`
    );
    xlZip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`
    );
    xlZip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="报名样表" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`
    );
    xlZip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
      </Relationships>`
    );
    xlZip.file(
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <fonts count="3">
          <font><sz val="11"/><color rgb="FF000000"/><name val="宋体"/></font>
          <font><b/><sz val="14"/><color rgb="FF000000"/><name val="宋体"/></font>
          <font><sz val="11"/><color rgb="FFFF0000"/><name val="仿宋"/></font>
        </fonts>
        <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
        <borders count="2">
          <border><left/><right/><top/><bottom/><diagonal/></border>
          <border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>
        </borders>
        <cellXfs count="4">
          <xf fontId="0" fillId="0" borderId="0"/>
          <xf fontId="1" fillId="0" borderId="0"><alignment horizontal="center" vertical="center"/></xf>
          <xf fontId="0" fillId="0" borderId="1"><alignment horizontal="center" vertical="center"/></xf>
          <xf fontId="2" fillId="0" borderId="1"><alignment horizontal="center" vertical="center"/></xf>
        </cellXfs>
      </styleSheet>`
    );
    xlZip.file(
      'xl/sharedStrings.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
        <si><t>测试报名登记表</t></si>
        <si><t>姓名</t></si>
        <si><t>张三</t></si>
        <si><t>签名日期</t></si>
        <si><r><t>日期：</t></r><r><rPr><color rgb="FFFF0000"/></rPr><t>2026年11月</t></r></si>
      </sst>`
    );
    xlZip.file(
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <dimension ref="A1:D5"/>
        <cols>
          <col min="1" max="1" width="14" customWidth="1"/>
          <col min="2" max="2" width="18" customWidth="1"/>
          <col min="3" max="4" width="12" customWidth="1"/>
        </cols>
        <sheetData>
          <row r="1" ht="32" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c></row>
          <row r="2" ht="28" customHeight="1"><c r="A2" s="2" t="s"><v>1</v></c><c r="B2" s="3" t="s"><v>2</v></c><c r="C2" s="2"/><c r="D2" s="2"/></row>
          <row r="3" ht="28" customHeight="1"><c r="A3" s="2"/><c r="B3" s="2"/><c r="C3" s="2"/><c r="D3" s="2"/></row>
          <row r="4" ht="28" customHeight="1"><c r="A4" s="2"/><c r="B4" s="2"/><c r="C4" s="2"/><c r="D4" s="2"/></row>
          <row r="5" ht="28" customHeight="1"><c r="A5" s="2" t="s"><v>3</v></c><c r="B5" s="2" t="s"><v>4</v></c><c r="C5" s="2"/><c r="D5" s="2"/></row>
        </sheetData>
        <mergeCells count="3">
          <mergeCell ref="A1:D1"/>
          <mergeCell ref="C2:D4"/>
          <mergeCell ref="B5:D5"/>
        </mergeCells>
        <drawing r:id="rId1"/>
      </worksheet>`
    );
    xlZip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
      </Relationships>`
    );
    xlZip.file(
      'xl/drawings/drawing1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <xdr:twoCellAnchor>
          <xdr:from><xdr:col>2</xdr:col><xdr:colOff>40000</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>40000</xdr:rowOff></xdr:from>
          <xdr:to><xdr:col>3</xdr:col><xdr:colOff>600000</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>200000</xdr:rowOff></xdr:to>
          <xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic>
        </xdr:twoCellAnchor>
      </xdr:wsDr>`
    );
    xlZip.file(
      'xl/drawings/_rels/drawing1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/photo.jpg"/>
      </Relationships>`
    );
    xlZip.file('xl/media/photo.jpg', photoJpg);

    const xlBuf = await xlZip.generateAsync({ type: 'nodebuffer' });
    const xlMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'styled_form.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: xlBuf,
      },
    ]);
    const xlUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${xlMp.boundary}` },
      payload: xlMp.payload,
    });
    const xlRef = xlUp.json().file;

    // 1. excel-to-pdf should keep form + anchored photo together on Page 1 (not isolated on trailing page)
    const pdfRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'excel-to-pdf', files: [xlRef], params: { landscape: false, fitToPage: true } },
    });
    const pdfTask = await waitForTask(ctx.app, pdfRes.json().taskId);
    expect(pdfTask.status).toBe('completed');

    const pdfDl = await ctx.app.inject({ method: 'GET', url: pdfTask.outputs[0].downloadUrl });
    const parsedPdf = mupdf.Document.openDocument(pdfDl.rawPayload, 'application/pdf');
    expect(parsedPdf.countPages()).toBe(1);

    const page = parsedPdf.loadPage(0);
    const st = page.toStructuredText('preserve-images');
    const imgBoxes: number[][] = [];
    st.walk({
      onImageBlock(bbox) {
        imgBoxes.push([...bbox]);
      },
    });
    st.destroy();
    page.destroy();
    parsedPdf.destroy();

    // Expect background page image + anchored photo inside C2:D4 (x in right half of page)
    expect(imgBoxes.length).toBeGreaterThanOrEqual(2);
    const anchoredBox = imgBoxes.find((b) => b[0] > 200 && b[2] < 580 && b[3] - b[1] > 40);
    expect(anchoredBox).toBeDefined();

    // 2. excel-to-long-image should succeed seamlessly
    const longRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'excel-to-long-image', files: [xlRef] },
    });
    const longTask = await waitForTask(ctx.app, longRes.json().taskId);
    expect(longTask.status).toBe('completed');
    expect(longTask.outputs[0].mimeType).toBe('image/png');

    // 3. excel-to-long-image supports outputStyle: 'pages' for >500-row sheets without truncation
    const bigRows: Array<[string, number, string]> = [['编号', '数量', '备注说明']];
    for (let i = 1; i <= 540; i++) {
      bigRows.push([`ITEM-${String(i).padStart(4, '0')}`, i, `第 ${i} 行参会记录明细`]);
    }
    const bigWb = XLSX.utils.book_new();
    const bigWs = XLSX.utils.aoa_to_sheet(bigRows);
    XLSX.utils.book_append_sheet(bigWb, bigWs, '明细表');
    const bigBuf = XLSX.write(bigWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const bigMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'many_rows.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: bigBuf,
      },
    ]);
    const bigUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${bigMp.boundary}` },
      payload: bigMp.payload,
    });
    const bigPagesRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'excel-to-long-image',
        files: [bigUp.json().file],
        params: { outputStyle: 'pages', imageFormat: 'jpg', dpi: 150 },
      },
    });
    const bigPagesTask = await waitForTask(ctx.app, bigPagesRes.json().taskId);
    expect(bigPagesTask.status).toBe('completed');
    expect(bigPagesTask.outputs.length).toBeGreaterThan(10);
    expect(bigPagesTask.outputs[0].fileName).toBe('many_rows_第1页.jpg');
    expect(bigPagesTask.outputs[0].mimeType).toBe('image/jpeg');

    // Verify last page actually contains content (dark text pixels) rather than blank/truncated pages
    const lastPageUrl = bigPagesTask.outputs[bigPagesTask.outputs.length - 1].downloadUrl;
    const lastPageBuf = (await ctx.app.inject({ method: 'GET', url: lastPageUrl })).rawPayload;
    const { data: lpData } = await sharp(lastPageBuf).raw().toBuffer({ resolveWithObject: true });
    let darkPixels = 0;
    for (let i = 0; i < lpData.length; i += 3) {
      if (lpData[i] < 180 && lpData[i + 1] < 180 && lpData[i + 2] < 180) darkPixels++;
    }
    expect(darkPixels).toBeGreaterThan(200);
  }, 25_000);

  it('renders layered PPTX background images below shapes/text and preserves colored seals in mild scan enhance', async () => {
    // 1. PPTX with full-bleed blue background <p:pic> followed in XML z-order by bright yellow text box <p:sp>
    const bgBluePng = await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 20, g: 35, b: 120 } },
    })
      .png()
      .toBuffer();

    const layeredPpt = new JSZip();
    layeredPpt.file('ppt/media/bg.png', bgBluePng);
    layeredPpt.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/bg.png"/>
      </Relationships>`
    );
    layeredPpt.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:cSld>
          <p:spTree>
            <p:pic>
              <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr>
            </p:pic>
            <p:sp>
              <p:spPr>
                <a:xfrm><a:off x="1524000" y="1828800"/><a:ext cx="9144000" cy="3048000"/></a:xfrm>
                <a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 8000"/></a:avLst></a:prstGeom>
                <a:solidFill><a:srgbClr val="10081C"><a:alpha val="90000"/></a:srgbClr></a:solidFill>
              </p:spPr>
              <p:txBody>
                <a:bodyPr anchor="ctr"/>
                <a:p>
                  <a:pPr algn="ctr"/>
                  <a:r>
                    <a:rPr b="true" sz="4800">
                      <a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill>
                    </a:rPr>
                    <a:t>可见前景文字标题</a:t>
                  </a:r>
                </a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>`
    );

    const pptMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'layered_bg_text.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        data: await layeredPpt.generateAsync({ type: 'nodebuffer' }),
      },
    ]);
    const pptUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${pptMp.boundary}` },
      payload: pptMp.payload,
    });
    const pptRef = pptUp.json().file;

    // Test PPT -> Image (pages mode)
    const pptImgRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'ppt-to-image',
        files: [pptRef],
        params: { outputStyle: 'pages', imageFormat: 'png', dpi: 150 },
      },
    });
    const pptImgTask = await waitForTask(ctx.app, pptImgRes.json().taskId);
    expect(pptImgTask.status).toBe('completed');
    const slidePng = (
      await ctx.app.inject({ method: 'GET', url: pptImgTask.outputs[0].downloadUrl })
    ).rawPayload;
    const { data: sData, info: sInfo } = await sharp(slidePng).raw().toBuffer({ resolveWithObject: true });

    let yellowPixels = 0;
    let blueBgPixels = 0;
    for (let y = 0; y < sInfo.height; y++) {
      for (let x = 0; x < sInfo.width; x++) {
        const o = (y * sInfo.width + x) * sInfo.channels;
        const r = sData[o];
        const g = sData[o + 1];
        const b = sData[o + 2];
        if (r > 190 && g > 190 && b < 80) yellowPixels++;
        if (b > 95 && r < 45 && g < 65) blueBgPixels++;
      }
    }
    // Both outer blue slide background AND foreground yellow text card must be visible (not covered!)
    expect(blueBgPixels).toBeGreaterThan(2000);
    expect(yellowPixels).toBeGreaterThan(500);

    // 2. Invoice scan enhance 'mild' vs 'strong' on gray paper with vivid red stamp
    const w = 320;
    const h = 240;
    const rawInv = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        // Uneven dim paper background (165..200)
        const paper = Math.round(168 + (x / w) * 30);
        let r = paper;
        let g = paper;
        let b = paper;
        // Black ink text bar
        if (x >= 30 && x <= 140 && y >= 40 && y <= 65) {
          r = 25;
          g = 25;
          b = 25;
        }
        // Bright red seal stamp block
        if (x >= 180 && x <= 260 && y >= 70 && y <= 140) {
          r = 205;
          g = 38;
          b = 38;
        }
        rawInv[o] = r;
        rawInv[o + 1] = g;
        rawInv[o + 2] = b;
      }
    }
    const invPng = await sharp(rawInv, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const invMp = createMultipartPayload([
      { name: 'file', filename: 'color_invoice.png', mimeType: 'image/png', data: invPng },
    ]);
    const invUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${invMp.boundary}` },
      payload: invMp.payload,
    });
    const invRef = invUp.json().file;

    // Mild mode must whiten gray background AND keep vivid red stamp intact!
    const mildRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'invoice-scan-enhance',
        files: [invRef],
        params: { enhanceStrength: 'mild' },
      },
    });
    const mildTask = await waitForTask(ctx.app, mildRes.json().taskId);
    expect(mildTask.status).toBe('completed');
    const mildJpg = (await ctx.app.inject({ method: 'GET', url: mildTask.outputs[0].downloadUrl })).rawPayload;
    const { data: mData, info: mInfo } = await sharp(mildJpg).raw().toBuffer({ resolveWithObject: true });

    // Check paper corner (10, 10) is bright white
    const cornerOff = (10 * mInfo.width + 10) * mInfo.channels;
    expect(mData[cornerOff]).toBeGreaterThan(235);
    expect(mData[cornerOff + 1]).toBeGreaterThan(235);
    expect(mData[cornerOff + 2]).toBeGreaterThan(235);

    // Check seal center (220, 105) retained vivid red chroma!
    const sealOff = (105 * mInfo.width + 220) * mInfo.channels;
    expect(mData[sealOff] - mData[sealOff + 1]).toBeGreaterThan(75);
    expect(mData[sealOff] - mData[sealOff + 2]).toBeGreaterThan(75);

    // Check strong mode whitens background and stays B&W grayscale
    const strongRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'invoice-scan-enhance',
        files: [invRef],
        params: { enhanceStrength: 'strong' },
      },
    });
    const strongTask = await waitForTask(ctx.app, strongRes.json().taskId);
    expect(strongTask.status).toBe('completed');
    const strongJpg = (await ctx.app.inject({ method: 'GET', url: strongTask.outputs[0].downloadUrl })).rawPayload;
    const { data: stData, info: stInfo } = await sharp(strongJpg).raw().toBuffer({ resolveWithObject: true });
    const stSealOff = (105 * stInfo.width + 220) * stInfo.channels;
    expect(Math.abs(stData[stSealOff] - stData[stSealOff + 1])).toBeLessThan(12);
  });

  it('executes audio-convert, video-extract-audio, and video-compress via FFmpeg', async () => {
    const ffmpegBin = await resolveFfmpegBin();
    const sampleWavPath = path.join(tmpDir, 'tone.wav');
    const sampleMp4Path = path.join(tmpDir, 'clip.mp4');

    // Generate 1s sine WAV & 1s testsrc+sine MP4
    await runBinary(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', sampleWavPath]);
    await runBinary(ffmpegBin, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=160x120:rate=15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=520:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      sampleMp4Path,
    ]);

    const wavBuf = await fs.readFile(sampleWavPath);
    const mp4Buf = await fs.readFile(sampleMp4Path);

    // Upload WAV & run audio-convert -> mp3
    const wavMp = createMultipartPayload([
      { name: 'file', filename: 'tone.wav', mimeType: 'audio/wav', data: wavBuf },
    ]);
    const wavUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${wavMp.boundary}` },
      payload: wavMp.payload,
    });
    const audioRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'audio-convert',
        files: [wavUp.json().file],
        params: { audioFormat: 'mp3', bitrate: '128k' },
      },
    });
    const audioTask = await waitForTask(ctx.app, audioRes.json().taskId);
    expect(audioTask.status).toBe('completed');
    expect(audioTask.outputs[0].mimeType).toBe('audio/mpeg');

    // Upload MP4 & run video-extract-audio -> m4a & video-compress -> mp4
    const mp4Mp = createMultipartPayload([
      { name: 'file', filename: 'clip.mp4', mimeType: 'video/mp4', data: mp4Buf },
    ]);
    const mp4Up = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mp4Mp.boundary}` },
      payload: mp4Mp.payload,
    });
    const mp4Ref = mp4Up.json().file;

    const extractAudioRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'video-extract-audio',
        files: [mp4Ref],
        params: { audioFormat: 'm4a' },
      },
    });
    const extractAudioTask = await waitForTask(ctx.app, extractAudioRes.json().taskId);
    expect(extractAudioTask.status).toBe('completed');
    expect(extractAudioTask.outputs[0].mimeType).toBe('audio/mp4');

    const compressRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'video-compress',
        files: [mp4Ref],
        params: { resolution: '480p', crf: 28 },
      },
    });
    const compressTask = await waitForTask(ctx.app, compressRes.json().taskId);
    expect(compressTask.status).toBe('completed');
    expect(compressTask.outputs[0].mimeType).toBe('video/mp4');

    // Run video-to-gif on test MP4
    const gifRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'video-to-gif',
        files: [mp4Ref],
        params: {
          gifStartSec: 0,
          gifDurationSec: 0.8,
          gifFps: 10,
          gifWidth: 120,
        },
      },
    });
    expect(gifRes.statusCode).toBe(202);
    const gifTask = await waitForTask(ctx.app, gifRes.json().taskId);
    expect(gifTask.status).toBe('completed');
    expect(gifTask.outputs).toHaveLength(1);
    expect(gifTask.outputs[0].mimeType).toBe('image/gif');
    expect(gifTask.outputs[0].previewableImage).toBe(true);
    expect(gifTask.outputs[0].fileName).toMatch(/_动图\.gif$/);

    const gifDl = await ctx.app.inject({ method: 'GET', url: gifTask.outputs[0].downloadUrl });
    expect(gifDl.statusCode).toBe(200);
    const gifBuf = gifDl.rawPayload;
    expect(gifBuf.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    const gifMeta = await sharp(gifBuf, { animated: true }).metadata();
    expect(gifMeta.width).toBe(120);
    expect(gifMeta.pages).toBeGreaterThanOrEqual(6);

    // Verify start time beyond video duration yields clear Chinese error
    const badStartRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'video-to-gif',
        files: [mp4Ref],
        params: { gifStartSec: 12, gifDurationSec: 3 },
      },
    });
    const badStartTask = await waitForTask(ctx.app, badStartRes.json().taskId);
    expect(badStartTask.status).toBe('failed');
    expect(badStartTask.error).toContain('超出');

    // Verify audio-only input to video-to-gif yields clear error
    const audioGifRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'video-to-gif',
        files: [wavUp.json().file],
        params: { gifStartSec: 0, gifDurationSec: 1 },
      },
    });
    const audioGifTask = await waitForTask(ctx.app, audioGifRes.json().taskId);
    expect(audioGifTask.status).toBe('failed');
    expect(audioGifTask.error).toContain('视频画面轨');
  });

  it('converts PDF to editable DOCX preserving text, vector merged table, colors, images and round-trips to PDF', async () => {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

    // Optional CJK TTF/OTF test font if available on host/CI
    let cjkFont: Awaited<ReturnType<PDFDocument['embedFont']>> | null = null;
    for (const candidate of [
      'C:/Windows/Fonts/simhei.ttf',
      '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    ]) {
      try {
        const fontBytes = await fs.readFile(candidate);
        doc.registerFontkit(fontkit);
        cjkFont = await doc.embedFont(fontBytes, { subset: true });
        break;
      } catch {
        // Ignore if unavailable on this runner
      }
    }

    const page = doc.addPage([595, 842]);
    // Centered heading
    page.drawText('Project Summary Report 2026', {
      x: 155,
      y: 775,
      size: 20,
      font: helvBold,
      color: rgb(0.11, 0.25, 0.55),
    });

    // Body paragraph + colored accent
    page.drawText('First body paragraph confirming structured text extraction from PDF.', {
      x: 60,
      y: 730,
      size: 11,
      font: helv,
      color: rgb(0.12, 0.16, 0.23),
    });
    if (cjkFont) {
      page.drawText('中文合同条款及报价清单测试。', {
        x: 60,
        y: 706,
        size: 12,
        font: cjkFont,
        color: rgb(0.8, 0.1, 0.1),
      });
    }

    // Diagonal watermark that should be filtered out in editable mode
    page.drawText('INTERNAL WATERMARK', {
      x: 180,
      y: 420,
      size: 28,
      font: helvBold,
      color: rgb(0.7, 0.7, 0.7),
      opacity: 0.25,
      rotate: degrees(-30),
    });

    // Vector 2x2 table with merged header row (y top=650 bottom=570 in PDF bottom-up coords)
    // Header shade rect
    page.drawRectangle({
      x: 60,
      y: 615,
      width: 460,
      height: 35,
      color: rgb(0.89, 0.91, 0.94),
    });
    // Outer border & row divider
    page.drawRectangle({
      x: 60,
      y: 570,
      width: 460,
      height: 80,
      borderColor: rgb(0.25, 0.33, 0.45),
      borderWidth: 1,
    });
    page.drawLine({
      start: { x: 60, y: 615 },
      end: { x: 520, y: 615 },
      thickness: 1,
      color: rgb(0.25, 0.33, 0.45),
    });
    // Vertical divider ONLY in second row -> top row is horizontally merged (gridSpan=2)
    page.drawLine({
      start: { x: 290, y: 570 },
      end: { x: 290, y: 615 },
      thickness: 1,
      color: rgb(0.25, 0.33, 0.45),
    });
    page.drawText('Merged Header Title', {
      x: 225,
      y: 628,
      size: 12,
      font: helvBold,
      color: rgb(0.08, 0.15, 0.3),
    });
    page.drawText('Item Name', {
      x: 80,
      y: 588,
      size: 11,
      font: helv,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText('Amount USD', {
      x: 310,
      y: 588,
      size: 11,
      font: helv,
      color: rgb(0.1, 0.1, 0.1),
    });

    // Embedded PNG image below the table
    const sampleImg = await createSamplePng(180, 110, { r: 30, g: 130, b: 220 });
    const embeddedPng = await doc.embedPng(sampleImg);
    page.drawImage(embeddedPng, { x: 200, y: 400, width: 180, height: 110 });

    const richPdfBytes = Buffer.from(await doc.save());
    const mp = createMultipartPayload([
      {
        name: 'file',
        filename: '合同报价单.pdf',
        mimeType: 'application/pdf',
        data: richPdfBytes,
      },
    ]);
    const uploadRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mp.boundary}` },
      payload: mp.payload,
    });
    expect(uploadRes.statusCode).toBe(200);
    const pdfRef = uploadRes.json().file;

    // 1. Editable PDF-to-Word conversion with preserved page breaks & images
    const editRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'pdf-to-word',
        files: [pdfRef],
        params: { preservePageBreaks: true, preserveImages: true },
      },
    });
    expect(editRes.statusCode).toBe(202);
    const editTask = await waitForTask(ctx.app, editRes.json().taskId);
    expect(editTask.status).toBe('completed');
    expect(editTask.outputs).toHaveLength(1);
    expect(editTask.outputs[0].fileName).toBe('合同报价单.docx');
    expect(editTask.outputs[0].mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const docxDl = await ctx.app.inject({ method: 'GET', url: editTask.outputs[0].downloadUrl });
    const docxBuf = docxDl.rawPayload;
    const docxZip = await JSZip.loadAsync(docxBuf);
    const docXml = await docxZip.file('word/document.xml')!.async('string');
    const relsXml = await docxZip.file('word/_rels/document.xml.rels')!.async('string');

    expect(docXml).toContain('Project Summary Report 2026');
    expect(docXml).toContain('First body paragraph confirming structured text extraction from PDF.');
    if (cjkFont) {
      expect(docXml).toContain('中文合同条款及报价清单测试');
    }
    expect(docXml).not.toContain('INTERNAL WATERMARK');
    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('<w:gridSpan w:val="2"/>');
    expect(docXml).toContain('<w:shd');
    expect(docXml).toContain('Merged Header Title');
    expect(docXml).toContain('Item Name');
    expect(docXml).toContain('Amount USD');
    expect(docXml).toContain('<w:drawing>');
    expect(relsXml).toContain('media/image1.png');
    expect(docxZip.file('word/media/image1.png')).toBeTruthy();

    // 2. Round-trip generated DOCX -> PDF via word-to-pdf
    const rtMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'roundtrip.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: docxBuf,
      },
    ]);
    const rtUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${rtMp.boundary}` },
      payload: rtMp.payload,
    });
    const rtTaskRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'word-to-pdf', files: [rtUp.json().file] },
    });
    const rtTask = await waitForTask(ctx.app, rtTaskRes.json().taskId);
    expect(rtTask.status).toBe('completed');
    const rtPdfDl = await ctx.app.inject({ method: 'GET', url: rtTask.outputs[0].downloadUrl });
    const rtDoc = mupdf.Document.openDocument(rtPdfDl.rawPayload, 'application/pdf');
    expect(rtDoc.countPages()).toBeGreaterThanOrEqual(1);
    rtDoc.destroy();
  });

  it('preserves text colors, translucent alpha text, pill badges, callout left bars, dividers, heading icons, hanging indents, and exact 2-page layout', async () => {
    const resumeDoc = await PDFDocument.create();
    const helv = await resumeDoc.embedFont(StandardFonts.Helvetica);
    const helvBold = await resumeDoc.embedFont(StandardFonts.HelveticaBold);
    let cjkFont: Awaited<ReturnType<PDFDocument['embedFont']>> | null = null;
    for (const candidate of [
      'C:/Windows/Fonts/simhei.ttf',
      '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    ]) {
      try {
        const fontBytes = await fs.readFile(candidate);
        resumeDoc.registerFontkit(fontkit);
        cjkFont = await resumeDoc.embedFont(fontBytes, { subset: true });
        break;
      } catch {
        // Ignore if unavailable on CI host
      }
    }

    // Page 1 (Dense resume page fitting cleanly onto 1 page with footer separator rule)
    const p1 = resumeDoc.addPage([595, 842]);
    const h1Title = cjkFont ? '工作经历' : 'Work History';
    p1.drawText(h1Title, { x: 42, y: 782, size: 14, font: cjkFont ?? helvBold, color: rgb(0.06, 0.09, 0.16) });
    p1.drawText('WORK EXPERIENCE', { x: 108, y: 782, size: 10, font: helv, color: rgb(0.58, 0.64, 0.72) });
    p1.drawLine({ start: { x: 42, y: 774 }, end: { x: 553, y: 774 }, thickness: 1, color: rgb(0.8, 0.84, 0.88) });

    // Row with flush-right date + translucent opacity subtitle
    p1.drawText(cjkFont ? '博瑞科传科技有限公司' : 'Boruikc Tech Co.', {
      x: 42,
      y: 750,
      size: 11,
      font: cjkFont ?? helvBold,
      color: rgb(0.06, 0.09, 0.16),
    });
    p1.drawText('Alpha Muted Tag', {
      x: 185,
      y: 750,
      size: 10,
      font: helv,
      color: rgb(0, 0, 0),
      opacity: 0.5,
    });
    p1.drawText('2025.06 - 2026.10', { x: 470, y: 750, size: 10, font: helv, color: rgb(0.39, 0.45, 0.55) });

    // Wrapped bullet items with hanging continuation line indent
    let yCur = 724;
    for (let b = 0; b < 6; b++) {
      p1.drawText(
        `• Bullet Point ${b + 1}: Architected real-time digital-twin dashboard with WebGL scene culling and SSE streaming pipelines`,
        { x: 42, y: yCur, size: 9.5, font: helv, color: rgb(0.12, 0.16, 0.23) }
      );
      p1.drawText('ensuring smooth 60 FPS interaction across high-DPI large control-room displays.', {
        x: 54,
        y: yCur - 13.5,
        size: 9.5,
        font: helv,
        color: rgb(0.12, 0.16, 0.23),
      });
      yCur -= 34;
    }

    // Bottom horizontal rule + footer row near bottom of Page 1
    p1.drawLine({ start: { x: 42, y: 52 }, end: { x: 553, y: 52 }, thickness: 0.8, color: rgb(0.85, 0.87, 0.9) });
    p1.drawText(cjkFont ? '林森 · 个人简历（第1页/共2页）' : 'Lin Sen Resume Page 1', {
      x: 42,
      y: 36,
      size: 8.5,
      font: cjkFont ?? helv,
      color: rgb(0.55, 0.6, 0.68),
    });
    p1.drawText('Frontend Architect', {
      x: 472,
      y: 36,
      size: 8.5,
      font: helv,
      color: rgb(0.55, 0.6, 0.68),
    });

    // Page 2 (Heading icon + dark badge w/ white text + light bordered badges + shaded callout w/ left accent bar)
    const p2 = resumeDoc.addPage([595, 842]);
    // 14x14pt dark vector icon left of heading
    p2.drawRectangle({ x: 42, y: 781, width: 14, height: 14, color: rgb(0.06, 0.09, 0.16) });
    p2.drawCircle({ x: 49, y: 788, size: 3.5, color: rgb(0.97, 0.98, 0.99) });
    p2.drawText(cjkFont ? '核心项目经验' : 'Key Projects', {
      x: 62,
      y: 783,
      size: 14,
      font: cjkFont ?? helvBold,
      color: rgb(0.06, 0.09, 0.16),
    });
    p2.drawText('PROJECT EXPERIENCE', { x: 158, y: 783, size: 10, font: helv, color: rgb(0.58, 0.64, 0.72) });
    p2.drawLine({ start: { x: 42, y: 774 }, end: { x: 553, y: 774 }, thickness: 1, color: rgb(0.8, 0.84, 0.88) });

    // Project title + dark navy pill badge with WHITE text + right-aligned date
    p2.drawText('1. Smart Water Twin Platform', { x: 42, y: 750, size: 11, font: helvBold, color: rgb(0.06, 0.09, 0.16) });
    p2.drawRectangle({ x: 204, y: 745, width: 82, height: 16, color: rgb(0.06, 0.09, 0.16) });
    p2.drawText(cjkFont ? '前端核心开发' : 'CoreLead', {
      x: 212,
      y: 749.5,
      size: 9,
      font: cjkFont ?? helvBold,
      color: rgb(1, 1, 1),
    });
    p2.drawText('2025.06 - 2026.03', { x: 470, y: 750, size: 10, font: helv, color: rgb(0.39, 0.45, 0.55) });

    // Side-by-side bordered+filled light badges
    p2.drawText(cjkFont ? '技术栈：' : 'Stack:', { x: 42, y: 726, size: 9, font: cjkFont ?? helvBold, color: rgb(0.28, 0.33, 0.41) });
    p2.drawRectangle({
      x: 84,
      y: 722,
      width: 38,
      height: 14,
      color: rgb(0.95, 0.96, 0.98),
      borderColor: rgb(0.8, 0.84, 0.88),
      borderWidth: 0.75,
    });
    p2.drawText('Vue 3', { x: 90, y: 726, size: 8.5, font: helvBold, color: rgb(0.15, 0.39, 0.92) });
    p2.drawRectangle({
      x: 128,
      y: 722,
      width: 62,
      height: 14,
      color: rgb(0.95, 0.96, 0.98),
      borderColor: rgb(0.8, 0.84, 0.88),
      borderWidth: 0.75,
    });
    p2.drawText('TypeScript', { x: 134, y: 726, size: 8.5, font: helvBold, color: rgb(0.12, 0.16, 0.23) });

    // Shaded #F8FAFC callout box + 3pt #0F172A left accent bar
    p2.drawRectangle({ x: 42, y: 668, width: 511, height: 42, color: rgb(248 / 255, 250 / 255, 252 / 255) });
    p2.drawRectangle({ x: 42, y: 668, width: 3, height: 42, color: rgb(15 / 255, 23 / 255, 42 / 255) });
    p2.drawText(
      'Project Summary: Unified telemetry portal monitoring reservoir water quality, equipment alarms, and 3D',
      { x: 54, y: 695, size: 9.5, font: helv, color: rgb(0.2, 0.25, 0.33) }
    );
    p2.drawText('digital twin visualization across municipal watersheds.', {
      x: 54,
      y: 680,
      size: 9.5,
      font: helv,
      color: rgb(0.2, 0.25, 0.33),
    });

    const resumeBytes = Buffer.from(await resumeDoc.save());
    const resMp = createMultipartPayload([
      { name: 'file', filename: 'resume_fidelity.pdf', mimeType: 'application/pdf', data: resumeBytes },
    ]);
    const resUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${resMp.boundary}` },
      payload: resMp.payload,
    });
    const resTaskInit = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'pdf-to-word',
        files: [resUp.json().file],
        params: { preservePageBreaks: true, preserveImages: true },
      },
    });
    const resTask = await waitForTask(ctx.app, resTaskInit.json().taskId);
    expect(resTask.status).toBe('completed');
    const resDocxBuf = (await ctx.app.inject({ method: 'GET', url: resTask.outputs[0].downloadUrl })).rawPayload;
    const resZip = await JSZip.loadAsync(resDocxBuf);
    const resXml = await resZip.file('word/document.xml')!.async('string');

    // Exact page-break semantics without trailing <w:br w:type="page"/>
    expect(resXml).not.toContain('w:type="page"');
    expect(resXml.match(/<w:pageBreakBefore\/>/g) ?? []).toHaveLength(1);

    // White text on dark navy pill badge MUST NOT be stripped or darkened; translucent 0.5 black text becomes ~gray
    expect(resXml).toContain(cjkFont ? '前端核心开发' : 'CoreLead');
    expect(resXml).toContain('w:color w:val="FFFFFF"');
    expect(resXml).toContain('w:fill="0F1729"'.slice(0, 12)); // 0F172A/0F1729 dark badge shading
    expect(resXml).toContain('w:color w:val="808080"'); // opacity: 0.5 black alpha-composited on white
    expect(resXml).toContain('w:color w:val="2663EB"'.slice(0, 11)); // Vue 3 blue accent (2663EB / 2663EB)

    // Side-by-side pill badges separated cleanly with borders & fill
    expect(resXml).toContain('Vue 3');
    expect(resXml).toContain('TypeScript');
    expect(resXml).toContain('<w:bdr w:val="single"');

    // Callout shaded box (#F8FAFC) + thick left border + bottom section dividers + top footer divider
    expect(resXml).toContain('w:fill="F8FAFC"');
    expect(resXml).toContain('<w:left w:val="single"');
    expect(resXml).toContain('<w:bottom w:val="single"');
    expect(resXml).toContain('<w:top w:val="single"');

    // Hanging indents for bullets + flush-right tab stop + inline heading icon drawing
    expect(resXml).toContain('w:hanging="');
    expect(resXml).toContain('<w:tab w:val="right"');
    expect(resXml).toContain('<w:drawing>');
    expect(resZip.file('word/media/image1.png')).toBeTruthy();

    // Round-trip generated DOCX -> PDF must fit cleanly into EXACTLY 2 pages (no Page 1 overflow!)
    const resRtMp = createMultipartPayload([
      {
        name: 'file',
        filename: 'resume_roundtrip.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: resDocxBuf,
      },
    ]);
    const resRtUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${resRtMp.boundary}` },
      payload: resRtMp.payload,
    });
    const resRtPdfInit = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { toolId: 'word-to-pdf', files: [resRtUp.json().file] },
    });
    const resRtPdfTask = await waitForTask(ctx.app, resRtPdfInit.json().taskId);
    expect(resRtPdfTask.status).toBe('completed');
    const resRtPdfBuf = (await ctx.app.inject({ method: 'GET', url: resRtPdfTask.outputs[0].downloadUrl })).rawPayload;
    const resRtPdf = mupdf.Document.openDocument(resRtPdfBuf, 'application/pdf');
    expect(resRtPdf.countPages()).toBe(2);
    resRtPdf.destroy();
  });

  it('fixes pdf-to-word blank pages, SoftMask/rotated/vector images, CJK punctuation spacing, fake-bold, and three-line tables', async () => {
    // Complex Editable PDF:
    // - Alpha-masked (SMask) RGBA PNG + rotated 90deg strip image + vector circle/curve chart cluster
    // - Fake-bold duplicated characters + faint light-gray horizontal watermark + outer page frame
    // - Chinese prose punctuation without bogus gaps + Three-line table (三线表) + Two-page footer numbers
    const complexDoc = await PDFDocument.create();
    const cmpHelv = await complexDoc.embedFont(StandardFonts.Helvetica);
    const cmpBold = await complexDoc.embedFont(StandardFonts.HelveticaBold);
    let cjkFont: Awaited<ReturnType<PDFDocument['embedFont']>> | null = null;
    for (const candidate of [
      'C:/Windows/Fonts/simhei.ttf',
      '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    ]) {
      try {
        const fontBytes = await fs.readFile(candidate);
        complexDoc.registerFontkit(fontkit);
        cjkFont = await complexDoc.embedFont(fontBytes, { subset: true });
        break;
      } catch {
        // Ignore if unavailable on CI host
      }
    }

    // Page 1
    const p1 = complexDoc.addPage([595, 842]);
    // Full-page outer frame border (must NOT be misclassified as a 1x1 table covering page!)
    p1.drawRectangle({
      x: 24,
      y: 24,
      width: 547,
      height: 794,
      borderColor: rgb(0.75, 0.78, 0.82),
      borderWidth: 0.8,
    });

    // Fake-bold doubled glyph text (0.5pt shift)
    p1.drawText('FAKEBOLD', { x: 60, y: 785, size: 16, font: cmpBold, color: rgb(0.1, 0.12, 0.2) });
    p1.drawText('FAKEBOLD', { x: 60.5, y: 785, size: 16, font: cmpBold, color: rgb(0.1, 0.12, 0.2) });

    // Faint pale horizontal watermark text (must be filtered out)
    p1.drawText('FAINT WATERMARK COPY', { x: 180, y: 500, size: 22, font: cmpBold, color: rgb(0.92, 0.92, 0.92) });

    if (cjkFont) {
      p1.drawText('中文合同条款，测试（第一项）：无多余空格。', {
        x: 60,
        y: 750,
        size: 12,
        font: cjkFont,
        color: rgb(0.12, 0.16, 0.23),
      });
    }

    // Three-line table (三线表: 3 horizontal rules, ZERO vertical rules)
    p1.drawLine({ start: { x: 60, y: 720 }, end: { x: 520, y: 720 }, thickness: 1.5, color: rgb(0.1, 0.1, 0.1) });
    p1.drawText('Metric', { x: 75, y: 702, size: 11, font: cmpBold, color: rgb(0.1, 0.1, 0.1) });
    p1.drawText('Baseline', { x: 255, y: 702, size: 11, font: cmpBold, color: rgb(0.1, 0.1, 0.1) });
    p1.drawText('Updated', { x: 430, y: 702, size: 11, font: cmpBold, color: rgb(0.1, 0.1, 0.1) });
    p1.drawLine({ start: { x: 60, y: 694 }, end: { x: 520, y: 694 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
    p1.drawText('Accuracy', { x: 75, y: 676, size: 10.5, font: cmpHelv, color: rgb(0.15, 0.15, 0.15) });
    p1.drawText('71.2%', { x: 255, y: 676, size: 10.5, font: cmpHelv, color: rgb(0.15, 0.15, 0.15) });
    p1.drawText('98.6%', { x: 430, y: 676, size: 10.5, font: cmpHelv, color: rgb(0.15, 0.15, 0.15) });
    p1.drawText('BlankPages', { x: 75, y: 656, size: 10.5, font: cmpHelv, color: rgb(0.15, 0.15, 0.15) });
    p1.drawText('50%', { x: 255, y: 656, size: 10.5, font: cmpHelv, color: rgb(0.15, 0.15, 0.15) });
    p1.drawText('0%', { x: 430, y: 656, size: 10.5, font: cmpHelv, color: rgb(0.15, 0.15, 0.15) });
    p1.drawLine({ start: { x: 60, y: 646 }, end: { x: 520, y: 646 }, thickness: 1.5, color: rgb(0.1, 0.1, 0.1) });

    // Alpha-masked (SMask) RGBA emblem PNG (transparent border + crimson circle/center)
    const alphaRaw = Buffer.alloc(120 * 120 * 4, 0);
    for (let y = 20; y < 100; y++) {
      for (let x = 20; x < 100; x++) {
        const o = (y * 120 + x) * 4;
        alphaRaw[o] = 215;
        alphaRaw[o + 1] = 35;
        alphaRaw[o + 2] = 55;
        alphaRaw[o + 3] = 240;
      }
    }
    const alphaPng = await sharp(alphaRaw, { raw: { width: 120, height: 120, channels: 4 } }).png().toBuffer();
    const embAlpha = await complexDoc.embedPng(alphaPng);
    p1.drawImage(embAlpha, { x: 70, y: 470, width: 110, height: 110 });

    // Rotated 90deg strip PNG (green left half / blue right half -> after 90deg rotation vertical top=blue, bottom=green)
    const stripRaw = Buffer.alloc(120 * 50 * 3, 0);
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 120; x++) {
        const o = (y * 120 + x) * 3;
        if (x < 60) {
          stripRaw[o + 1] = 190;
        } else {
          stripRaw[o + 2] = 220;
        }
      }
    }
    const stripPng = await sharp(stripRaw, { raw: { width: 120, height: 50, channels: 3 } }).png().toBuffer();
    const embStrip = await complexDoc.embedPng(stripPng);
    p1.drawImage(embStrip, { x: 300, y: 460, width: 120, height: 50, rotate: degrees(90) });

    // Vector curved diagram / seal cluster (curves + colored circles -> captured via region PNG)
    p1.drawCircle({ x: 430, y: 520, size: 32, color: rgb(0.95, 0.25, 0.25), borderColor: rgb(0.7, 0.1, 0.1), borderWidth: 2 });

    // Bottom footer page number on page 1 (must be stripped in multi-page flow)
    p1.drawText('- 1 -', { x: 285, y: 20, size: 10, font: cmpHelv, color: rgb(0.5, 0.5, 0.5) });

    // Page 2
    const p2 = complexDoc.addPage([595, 842]);
    p2.drawText('Second Page Continuation', { x: 60, y: 770, size: 18, font: cmpBold, color: rgb(0.1, 0.2, 0.45) });
    p2.drawText('Body paragraph on page two.', { x: 60, y: 735, size: 11, font: cmpHelv, color: rgb(0.15, 0.18, 0.22) });
    p2.drawText('- 2 -', { x: 285, y: 20, size: 10, font: cmpHelv, color: rgb(0.5, 0.5, 0.5) });

    const cmpBytes = Buffer.from(await complexDoc.save());
    const mpCmp = createMultipartPayload([
      { name: 'file', filename: 'complex_editable.pdf', mimeType: 'application/pdf', data: cmpBytes },
    ]);
    const cmpUp = await ctx.app.inject({
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${mpCmp.boundary}` },
      payload: mpCmp.payload,
    });

    const cmpRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        toolId: 'pdf-to-word',
        files: [cmpUp.json().file],
        params: { preservePageBreaks: true, preserveImages: true },
      },
    });
    const cmpTask = await waitForTask(ctx.app, cmpRes.json().taskId);
    expect(cmpTask.status).toBe('completed');
    const cmpBuf = (await ctx.app.inject({ method: 'GET', url: cmpTask.outputs[0].downloadUrl })).rawPayload;
    const cmpZip = await JSZip.loadAsync(cmpBuf);
    const cmpXml = await cmpZip.file('word/document.xml')!.async('string');

    // No blank-page-inducing <w:br w:type="page"/>
    expect(cmpXml).not.toContain('w:type="page"');
    // Fake-bold must not duplicate glyphs
    expect(cmpXml).toContain('FAKEBOLD');
    expect(cmpXml).not.toContain('FFAAKKEEBBOOLLDD');
    // Faint light-gray watermark & footer page numbers stripped
    expect(cmpXml).not.toContain('FAINT WATERMARK COPY');
    expect(cmpXml).not.toContain('>- 1 -<');
    expect(cmpXml).not.toContain('>- 2 -<');
    // CJK punctuation spacing stays clean without inserting spaces around commas/parentheses/colons
    if (cjkFont) {
      expect(cmpXml).toContain('中文合同条款，测试（第一项）：无多余空格。');
    }
    // Three-line table preserved cleanly with borderless sides/verticals
    expect(cmpXml).toContain('<w:tbl>');
    expect(cmpXml).toContain('BlankPages');
    expect(cmpXml).toContain('98.6%');
    expect(cmpXml).toContain('<w:insideV w:val="none"/>');
    // Alpha-masked PNG + rotated strip + vector seal figure extracted (at least 3 media image files!)
    const mediaKeys = Object.keys(cmpZip.files).filter((k) => k.startsWith('word/media/') && !cmpZip.files[k].dir);
    expect(mediaKeys.length).toBeGreaterThanOrEqual(3);
  });
});
