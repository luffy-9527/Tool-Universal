import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { renderDocxToPdf } from './docxRenderer.js';
import { renderPptxToPdf } from './pptxRenderer.js';
import { renderXlsxToPdf } from './xlsxRenderer.js';

const FONT_FAMILY = 'Noto Sans CJK SC, Microsoft YaHei, PingFang SC, SimHei, sans-serif';

function escapeXml(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapTextLines(text: string, maxUnitsPerLine: number): string[] {
  const lines: string[] = [];
  for (const rawParagraph of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawParagraph.trimEnd();
    if (!trimmed) {
      lines.push('');
      continue;
    }
    let current = '';
    let units = 0;
    for (const ch of trimmed) {
      const charUnit = ch.charCodeAt(0) > 127 ? 2 : 1.05;
      if (units + charUnit > maxUnitsPerLine && current) {
        lines.push(current);
        current = ch;
        units = charUnit;
      } else {
        current += ch;
        units += charUnit;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

async function renderPlainTextToPdf(rawText: string, outPdfPath: string, workDir: string): Promise<void> {
  const pageW = 794; // A4 @ 96DPI
  const pageH = 1123;
  const fontSize = 15;
  const lineHeight = 25;
  const padX = 56;
  const padY = 64;
  const linesPerPage = Math.floor((pageH - padY * 2) / lineHeight);
  const wrapped = wrapTextLines(rawText.trim() ? rawText : '（空白文档）', 76);

  const pdfDoc = await PDFDocument.create();
  const totalPages = Math.max(1, Math.ceil(wrapped.length / linesPerPage));

  for (let p = 0; p < totalPages; p++) {
    const slice = wrapped.slice(p * linesPerPage, (p + 1) * linesPerPage);
    const tspans = slice
      .map(
        (line, idx) =>
          `<text x="${padX}" y="${padY + idx * lineHeight}" font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#1E293B">${escapeXml(
            line || ' '
          )}</text>`
      )
      .join('\n');

    const footer = `<text x="${pageW / 2}" y="${pageH - 26}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="12" fill="#94A3B8">第 ${
      p + 1
    } 页 / 共 ${totalPages} 页</text>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pageW} ${pageH}" width="${Math.round(
      pageW * 1.5
    )}" height="${Math.round(pageH * 1.5)}">
      <rect width="${pageW}" height="${pageH}" fill="#FFFFFF"/>
      ${tspans}
      ${footer}
    </svg>`;

    const pagePath = path.join(workDir, `fallback_txt_p${p + 1}.png`);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 5 }).toFile(pagePath);
    const pngBytes = await fs.readFile(pagePath);
    const embedded = await pdfDoc.embedPng(pngBytes);
    const page = pdfDoc.addPage([pageW * 0.75, pageH * 0.75]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageW * 0.75, height: pageH * 0.75 });
  }

  await fs.writeFile(outPdfPath, await pdfDoc.save());
}

/**
 * Pure-Node fallback for Word (.docx / .txt / .md) -> PDF when LibreOffice is unavailable.
 * Preserves tables, styles, page breaks, and embedded images inside .docx files.
 */
export async function fallbackWordToPdf(inputPath: string, outPdfPath: string, workDir: string): Promise<void> {
  const ext = path.extname(inputPath).toLowerCase();

  if (ext === '.docx') {
    await renderDocxToPdf(inputPath, outPdfPath);
    return;
  }

  if (ext === '.txt' || ext === '.md') {
    const rawText = await fs.readFile(inputPath, 'utf-8');
    await renderPlainTextToPdf(rawText, outPdfPath, workDir);
    return;
  }

  throw new Error(`本地无 LibreOffice 引擎时仅支持 .docx/.txt，旧版 ${ext} 请部署到 Docker/微信云托管运行`);
}

/**
 * Pure-Node fallback for Excel (.xlsx / .xls / .csv) -> PDF when LibreOffice is unavailable.
 * Preserves merged cells, column widths, row heights, fonts/fills/borders, rich-text colors, and embedded images.
 */
export async function fallbackExcelToPdf(
  inputPath: string,
  outPdfPath: string,
  _workDir: string,
  landscape: boolean | 'auto' = 'auto',
  fitToPage = true,
  continuous = false
): Promise<void> {
  await renderXlsxToPdf(inputPath, outPdfPath, { landscape, fitToPage, continuous });
}

/**
 * Pure-Node fallback for PowerPoint (.pptx) -> PDF when LibreOffice is unavailable.
 * Preserves slide background fills/images, shape geometry/fills/borders, rich typography, tables, and native XML z-order.
 */
export async function fallbackPptToPdf(inputPath: string, outPdfPath: string, _workDir: string): Promise<void> {
  await renderPptxToPdf(inputPath, outPdfPath);
}
