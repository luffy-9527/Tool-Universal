import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import * as mupdf from 'mupdf';
import sharp from 'sharp';

export interface PdfToDocxOptions {
  preservePageBreaks?: boolean;
  preserveImages?: boolean;
  onProgress?: (pct: number, stageText: string) => void;
}

interface TextRun {
  text: string;
  fontSizePt: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  colorHex: string;
  bgHex?: string;
  borderHex?: string;
  badgeId?: number;
}

interface RawCharSpan {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baselineY: number;
  ch: string;
  fontSizePt: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  colorHex: string;
  angled: boolean;
  bgHex?: string;
  borderHex?: string;
  badgeId?: number;
}

interface BorderRule {
  colorHex: string;
  sizeEighths: number;
}

interface VisualSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baselineY: number;
  fontSizePt: number;
  runs: TextRun[];
  plainText: string;
}

interface VisualRow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baselineY: number;
  fontSizePt: number;
  segments: VisualSegment[];
  leadingIcon?: PageImageBlock;
  bottomBorder?: BorderRule;
  topBorder?: BorderRule;
  leftBorder?: BorderRule;
  shadingHex?: string;
  calloutX0?: number;
}

interface PageImageBlock {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  widthPt: number;
  heightPt: number;
  rId: string;
  target: string;
  docPrId: number;
}

interface PendingImageTask {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bytes: Uint8Array;
  isLargeBackdropCandidate: boolean;
}

interface HVSegment {
  coord: number;
  start: number;
  end: number;
  colorHex: string;
  widthPt: number;
}

interface FillRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fillHex: string;
}

interface StrokeBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  borderHex: string;
  widthPt: number;
}

interface TranslucentTextHint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  effectiveHex: string;
}

interface BadgeBox {
  badgeId: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fillHex?: string;
  borderHex?: string;
}

interface ShapeBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  hasCurve: boolean;
  isColoredFill: boolean;
}

interface DetectedTable {
  kind: 'bordered' | 'three-line';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colBounds: number[];
  rowBounds: number[];
  horizontals: HVSegment[];
  verticals: HVSegment[];
  fills: FillRect[];
}

interface MediaAsset {
  rId: string;
  target: string;
  bytes: Uint8Array;
  ext: 'png' | 'jpg';
  mime: string;
}

interface ClipBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const PT_TO_TWIPS = 20;
const PT_TO_EMU = 12700;

const CJK_CLOSE_PUNCT = new Set([
  '，', '。', '、', '：', '；', '！', '？', '）', '》', '」', '』', '】', '”', '’', '％',
]);
const CJK_OPEN_PUNCT = new Set(['（', '《', '「', '『', '【', '“', '‘']);

function escapeXml(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
}

function colorToHex(
  color: unknown,
  alpha = 1,
  csType?: string,
  bgRgb: [number, number, number] = [255, 255, 255]
): string {
  let rf = 30 / 255;
  let gf = 41 / 255;
  let bf = 59 / 255;

  if (typeof color === 'number' && Number.isFinite(color)) {
    rf = ((color >> 16) & 0xff) / 255;
    gf = ((color >> 8) & 0xff) / 255;
    bf = (color & 0xff) / 255;
  } else {
    const arr: number[] | null = Array.isArray(color)
      ? color
      : ArrayBuffer.isView(color)
      ? Array.from(color as unknown as ArrayLike<number>)
      : null;
    if (!arr || arr.length === 0) return '1E293B';

    if (arr.length === 1) {
      const g = Math.max(0, Math.min(1, Number(arr[0]) || 0));
      rf = g;
      gf = g;
      bf = g;
    } else if (arr.length >= 4) {
      const c = Math.max(0, Math.min(1, Number(arr[0]) || 0));
      const m = Math.max(0, Math.min(1, Number(arr[1]) || 0));
      const y = Math.max(0, Math.min(1, Number(arr[2]) || 0));
      const k = Math.max(0, Math.min(1, Number(arr[3]) || 0));
      rf = (1 - c) * (1 - k);
      gf = (1 - m) * (1 - k);
      bf = (1 - y) * (1 - k);
    } else {
      const c0 = Math.max(0, Math.min(1, Number(arr[0]) || 0));
      const c1 = Math.max(0, Math.min(1, Number(arr[1]) || 0));
      const c2 = Math.max(0, Math.min(1, Number(arr[2]) || 0));
      if (csType === 'BGR') {
        rf = c2;
        gf = c1;
        bf = c0;
      } else {
        rf = c0;
        gf = c1;
        bf = c2;
      }
    }
  }

  if (alpha >= 0 && alpha < 0.99) {
    rf = rf * alpha + (bgRgb[0] / 255) * (1 - alpha);
    gf = gf * alpha + (bgRgb[1] / 255) * (1 - alpha);
    bf = bf * alpha + (bgRgb[2] / 255) * (1 - alpha);
  }

  const r = Math.max(0, Math.min(255, Math.round(rf * 255)));
  const g = Math.max(0, Math.min(255, Math.round(gf * 255)));
  const b = Math.max(0, Math.min(255, Math.round(bf * 255)));
  return `${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  if (hex.length !== 6) return [255, 255, 255];
  return [
    parseInt(hex.slice(0, 2), 16) || 0,
    parseInt(hex.slice(2, 4), 16) || 0,
    parseInt(hex.slice(4, 6), 16) || 0,
  ];
}

function isPureWhiteHex(hex: string): boolean {
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r >= 253 && g >= 253 && b >= 253;
}

function isNearWhiteHex(hex: string): boolean {
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r >= 249 && g >= 249 && b >= 249;
}

function colorLuma(hex: string): number {
  if (hex.length !== 6) return 0;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function normalizeFontFamily(pdfFontName = ''): string {
  const cleaned = pdfFontName.replace(/^[A-Z]{6}\+/, '');
  if (/yahei|msyh|microsoft/i.test(cleaned)) return '微软雅黑';
  if (/simsun|song|stsong|nsimsun/i.test(cleaned)) return '宋体';
  if (/simhei|hei|stxihei/i.test(cleaned)) return '黑体';
  if (/kaiti|kai|stkaiti/i.test(cleaned)) return '楷体';
  if (/fangsong|stfang/i.test(cleaned)) return '仿宋';
  if (/noto|pingfang|sourcehan|harmonyos|cjk/i.test(cleaned)) return '微软雅黑';
  if (/times|serif|georgia|cambria/i.test(cleaned)) return 'Times New Roman';
  if (/courier|consolas|mono/i.test(cleaned)) return 'Consolas';
  return 'Calibri';
}

function isCjkOrFullWidth(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    CJK_CLOSE_PUNCT.has(ch) ||
    CJK_OPEN_PUNCT.has(ch)
  );
}

function sameStyle(a: TextRun, b: TextRun): boolean {
  return (
    Math.abs(a.fontSizePt - b.fontSizePt) < 0.4 &&
    a.fontFamily === b.fontFamily &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.colorHex === b.colorHex &&
    (a.bgHex ?? '') === (b.bgHex ?? '') &&
    (a.borderHex ?? '') === (b.borderHex ?? '') &&
    (a.badgeId ?? 0) === (b.badgeId ?? 0)
  );
}

function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text !== '\t' && r.text !== '\t' && sameStyle(prev, r)) {
      prev.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function runsToXml(runs: TextRun[], paraShadingHex?: string): string {
  const merged = mergeRuns(runs);
  if (merged.length === 0) {
    return `<w:r><w:t></w:t></w:r>`;
  }
  return merged
    .map((r) => {
      if (r.text === '\t') {
        return `<w:r><w:tab/></w:r>`;
      }
      const sz = Math.max(12, Math.min(144, Math.round(r.fontSizePt * 2)));
      const safeText = escapeXml(r.text);
      const isEastAsiaFont = /[^\x20-\x7E]/.test(r.fontFamily);
      const asciiFont = isEastAsiaFont ? 'Calibri' : r.fontFamily;
      const eastAsiaFont = isEastAsiaFont ? r.fontFamily : '微软雅黑';

      const effectiveBg = r.bgHex ?? paraShadingHex;
      const hasDarkBg = Boolean(effectiveBg && colorLuma(effectiveBg) < 175);
      let finalColor = /^[0-9A-F]{6}$/.test(r.colorHex) ? r.colorHex : '1E293B';
      if (colorLuma(finalColor) >= 242 && !hasDarkBg) {
        // Prevent accidental white-on-white invisible text when no dark background covers it
        finalColor = '334155';
      }

      // Follow strict ECMA-376 CT_RPr element order: rFonts -> b -> i -> color -> sz -> bdr -> shd
      const rPrParts = [
        `<w:rFonts w:ascii="${escapeXml(asciiFont)}" w:eastAsia="${escapeXml(eastAsiaFont)}" w:hAnsi="${escapeXml(asciiFont)}"/>`,
        r.bold ? '<w:b/><w:bCs/>' : '',
        r.italic ? '<w:i/><w:iCs/>' : '',
        `<w:color w:val="${finalColor}"/>`,
        `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`,
        r.borderHex ? `<w:bdr w:val="single" w:sz="4" w:space="1" w:color="${r.borderHex}"/>` : '',
        r.bgHex ? `<w:shd w:val="clear" w:color="auto" w:fill="${r.bgHex}"/>` : '',
      ]
        .filter(Boolean)
        .join('');
      return `<w:r><w:rPr>${rPrParts}</w:rPr><w:t xml:space="preserve">${safeText}</w:t></w:r>`;
    })
    .join('');
}

function imageDrawingXml(img: PageImageBlock, maxWidthPt: number, maxHeightPt: number): string {
  let w = Math.max(8, img.widthPt);
  let h = Math.max(8, img.heightPt);
  if (w > maxWidthPt) {
    const s = maxWidthPt / w;
    w *= s;
    h *= s;
  }
  if (h > maxHeightPt) {
    const s = maxHeightPt / h;
    w *= s;
    h *= s;
  }
  const cx = Math.max(PT_TO_EMU, Math.round(w * PT_TO_EMU));
  const cy = Math.max(PT_TO_EMU, Math.round(h * PT_TO_EMU));
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${img.docPrId}" name="Picture ${img.docPrId}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${img.docPrId}" name="Picture ${img.docPrId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${img.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function applyCtm(ctm: number[], x: number, y: number, offX: number, offY: number): [number, number] {
  const px = ctm[0] * x + ctm[2] * y + ctm[4] - offX;
  const py = ctm[1] * x + ctm[3] * y + ctm[5] - offY;
  return [px, py];
}

function intersectBox(a: ClipBox, b: ClipBox): ClipBox {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x1 <= x0 || y1 <= y0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

function clusterCoords(values: number[], tol = 2.5): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    if (sorted[i] - last[last.length - 1] <= tol) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

async function applyImageTransformAndClip(
  rawPngOrRgba: Buffer,
  rawOpts: sharp.Raw | undefined,
  imgW: number,
  imgH: number,
  ctm: number[],
  rawBox: ClipBox,
  clippedBox: ClipBox
): Promise<Uint8Array> {
  let buf = rawPngOrRgba;
  let curRaw = rawOpts;
  let curW = imgW;
  let curH = imgH;

  const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
  const needsFlop = det < 0;
  // Angle of image X-axis (+u) in screen coordinates (x right, y down) after optional horizontal mirror
  const ux = needsFlop ? -ctm[0] : ctm[0];
  const uy = needsFlop ? -ctm[1] : ctm[1];
  let rotDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
  rotDeg = ((rotDeg % 360) + 360) % 360;
  // Snap near-cardinal angles within 1.5 degrees cleanly
  const snappedCardinal = [0, 90, 180, 270].find((a) => Math.abs(rotDeg - a) <= 1.5 || Math.abs(rotDeg - (a + 360)) <= 1.5);
  const finalAngle = snappedCardinal !== undefined ? snappedCardinal % 360 : Math.round(rotDeg * 10) / 10;

  if (needsFlop || finalAngle !== 0) {
    let pipe = curRaw ? sharp(buf, { raw: curRaw }) : sharp(buf);
    if (needsFlop) pipe = pipe.flop();
    if (finalAngle !== 0) {
      pipe = pipe.rotate(finalAngle, { background: { r: 255, g: 255, b: 255, alpha: 0 } });
    }
    const transformed = await pipe.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
    buf = transformed.data;
    curRaw = undefined;
    curW = transformed.info.width;
    curH = transformed.info.height;
  }

  // Crop in a second stage ONLY AFTER transform is materialized so sharp never applies extract before rotate/flop!
  const rawW = rawBox.x1 - rawBox.x0;
  const rawH = rawBox.y1 - rawBox.y0;
  const clipW = clippedBox.x1 - clippedBox.x0;
  const clipH = clippedBox.y1 - clippedBox.y0;
  if (rawW > 4 && rawH > 4 && curW >= 4 && curH >= 4 && (clipW < rawW * 0.92 || clipH < rawH * 0.92)) {
    const fx0 = Math.max(0, Math.min(1, (clippedBox.x0 - rawBox.x0) / rawW));
    const fy0 = Math.max(0, Math.min(1, (clippedBox.y0 - rawBox.y0) / rawH));
    const fx1 = Math.max(fx0, Math.min(1, (clippedBox.x1 - rawBox.x0) / rawW));
    const fy1 = Math.max(fy0, Math.min(1, (clippedBox.y1 - rawBox.y0) / rawH));
    const left = Math.max(0, Math.min(curW - 2, Math.floor(fx0 * curW)));
    const top = Math.max(0, Math.min(curH - 2, Math.floor(fy0 * curH)));
    const width = Math.max(2, Math.min(curW - left, Math.ceil((fx1 - fx0) * curW)));
    const height = Math.max(2, Math.min(curH - top, Math.ceil((fy1 - fy0) * curH)));
    if (width < curW || height < curH) {
      const pipe = curRaw ? sharp(buf, { raw: curRaw }) : sharp(buf);
      return Uint8Array.from(await pipe.extract({ left, top, width, height }).png({ compressionLevel: 6 }).toBuffer());
    }
  }

  if (!curRaw && !needsFlop && finalAngle === 0) {
    return Uint8Array.from(buf);
  }
  const finalPipe = curRaw ? sharp(buf, { raw: curRaw }) : sharp(buf);
  return Uint8Array.from(await finalPipe.png({ compressionLevel: 6 }).toBuffer());
}

async function extractRasterImagePng(
  image: mupdf.Image,
  ctm: number[],
  rawBox: ClipBox,
  clippedBox: ClipBox,
  alphaScalar: number
): Promise<Uint8Array | null> {
  let pix: mupdf.Pixmap | undefined;
  let maskPix: mupdf.Pixmap | undefined;
  let rgbPix: mupdf.Pixmap | undefined;

  try {
    pix = image.toPixmap();
    const cs = pix.getColorSpace();
    let basePng: Buffer;
    if (cs && cs.isRGB() && !pix.getAlpha()) {
      basePng = Buffer.from(pix.asPNG());
    } else {
      rgbPix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, Boolean(pix.getAlpha()));
      basePng = Buffer.from(rgbPix.asPNG());
    }

    const meta = await sharp(basePng).metadata();
    const imgW = meta.width || pix.getWidth();
    const imgH = meta.height || pix.getHeight();
    if (imgW < 2 || imgH < 2) return null;

    // Composite PDF SoftMask / SMask alpha channel when present
    const maskImg = image.getMask();
    if (maskImg) {
      maskPix = maskImg.toPixmap();
      const mw = maskPix.getWidth();
      const mh = maskPix.getHeight();
      const mStride = maskPix.getStride();
      const mComps = maskPix.getNumberOfComponents();
      const srcPx = maskPix.getPixels();
      const alphaBuf = Buffer.alloc(mw * mh);
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          const val = srcPx[y * mStride + x * mComps];
          alphaBuf[y * mw + x] = alphaScalar < 0.99 ? Math.round(val * alphaScalar) : val;
        }
      }
      let maskLayer: Buffer = alphaBuf;
      if (mw !== imgW || mh !== imgH) {
        maskLayer = await sharp(alphaBuf, { raw: { width: mw, height: mh, channels: 1 } })
          .resize(imgW, imgH, { fit: 'fill' })
          .raw()
          .toBuffer();
      }
      const rgbRaw = await sharp(basePng).removeAlpha().raw().toBuffer();
      const rgbaRaw = Buffer.alloc(imgW * imgH * 4);
      for (let i = 0; i < imgW * imgH; i++) {
        rgbaRaw[i * 4] = rgbRaw[i * 3];
        rgbaRaw[i * 4 + 1] = rgbRaw[i * 3 + 1];
        rgbaRaw[i * 4 + 2] = rgbRaw[i * 3 + 2];
        rgbaRaw[i * 4 + 3] = i < maskLayer.length ? maskLayer[i] : 255;
      }
      return await applyImageTransformAndClip(
        rgbaRaw,
        { width: imgW, height: imgH, channels: 4 },
        imgW,
        imgH,
        ctm,
        rawBox,
        clippedBox
      );
    }

    return await applyImageTransformAndClip(basePng, undefined, imgW, imgH, ctm, rawBox, clippedBox);
  } catch {
    return null;
  } finally {
    maskPix?.destroy();
    rgbPix?.destroy();
    pix?.destroy();
  }
}

async function extractImageMaskPng(
  image: mupdf.Image,
  ctm: number[],
  rawBox: ClipBox,
  clippedBox: ClipBox,
  colorHex: string,
  alphaScalar: number
): Promise<Uint8Array | null> {
  let pix: mupdf.Pixmap | undefined;
  try {
    pix = image.toPixmap();
    const w = pix.getWidth();
    const h = pix.getHeight();
    if (w < 2 || h < 2) return null;
    const stride = pix.getStride();
    const comps = pix.getNumberOfComponents();
    const px = pix.getPixels();

    const r = parseInt(colorHex.slice(0, 2), 16) || 30;
    const g = parseInt(colorHex.slice(2, 4), 16) || 41;
    const b = parseInt(colorHex.slice(4, 6), 16) || 59;

    const rgba = Buffer.alloc(w * h * 4);
    let nonZero = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const aVal = Math.round(px[y * stride + x * comps] * alphaScalar);
        const dst = (y * w + x) * 4;
        rgba[dst] = r;
        rgba[dst + 1] = g;
        rgba[dst + 2] = b;
        rgba[dst + 3] = aVal;
        if (aVal > 16) nonZero++;
      }
    }
    if (nonZero === 0) return null;

    return await applyImageTransformAndClip(
      rgba,
      { width: w, height: h, channels: 4 },
      w,
      h,
      ctm,
      rawBox,
      clippedBox
    );
  } catch {
    return null;
  } finally {
    pix?.destroy();
  }
}

async function renderPageRegionPng(
  page: mupdf.Page,
  offX: number,
  offY: number,
  region: ClipBox,
  dpi = 200
): Promise<Uint8Array> {
  const scale = dpi / 72;
  const rx0 = Math.floor((region.x0 + offX) * scale);
  const ry0 = Math.floor((region.y0 + offY) * scale);
  const rx1 = Math.max(rx0 + 4, Math.ceil((region.x1 + offX) * scale));
  const ry1 = Math.max(ry0 + 4, Math.ceil((region.y1 + offY) * scale));

  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [rx0, ry0, rx1, ry1], false);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pix);
  try {
    pix.clear(255);
    page.run(dev, mupdf.Matrix.identity);
    return Uint8Array.from(pix.asPNG());
  } finally {
    dev.close();
    dev.destroy();
    pix.destroy();
  }
}

async function isUniformPaleImage(bytes: Uint8Array): Promise<boolean> {
  try {
    const stats = await sharp(bytes).removeAlpha().stats();
    const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
    const minMean = Math.min(...stats.channels.map((c) => c.mean));
    // Virtually blank white/light pastel sheet background
    return maxStdev < 22 && minMean > 228;
  } catch {
    return false;
  }
}

async function collectPageGraphics(
  page: mupdf.Page,
  offX: number,
  offY: number,
  pageW: number,
  pageH: number,
  preserveImages: boolean
): Promise<{
  horizontals: HVSegment[];
  verticals: HVSegment[];
  fills: FillRect[];
  strokeBoxes: StrokeBox[];
  translucentTextHints: TranslucentTextHint[];
  shapeBoxes: ShapeBox[];
  pendingImages: PendingImageTask[];
  fillTextCount: number;
  ignoreTextCount: number;
  totalVectorOps: number;
}> {
  const horizontals: HVSegment[] = [];
  const verticals: HVSegment[] = [];
  const fills: FillRect[] = [];
  const strokeBoxes: StrokeBox[] = [];
  const translucentTextHints: TranslucentTextHint[] = [];
  const shapeBoxes: ShapeBox[] = [];
  const pendingImagePromises: Array<Promise<PendingImageTask | null>> = [];
  let fillTextCount = 0;
  let ignoreTextCount = 0;
  let totalVectorOps = 0;
  let maskDepth = 0;

  const groupAlphas: number[] = [1];
  const currentGroupAlpha = (): number => groupAlphas[groupAlphas.length - 1] ?? 1;

  const clipStack: ClipBox[] = [{ x0: 0, y0: 0, x1: pageW, y1: pageH }];
  const currentClip = (): ClipBox => clipStack[clipStack.length - 1] ?? { x0: 0, y0: 0, x1: pageW, y1: pageH };

  const getBackdropRgbAt = (cx: number, cy: number): [number, number, number] => {
    for (let i = fills.length - 1; i >= 0; i--) {
      const f = fills[i];
      if (cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1) {
        return hexToRgbTuple(f.fillHex);
      }
    }
    return [255, 255, 255];
  };

  const extractSubpaths = (path: mupdf.Path, ctm: number[]) => {
    const subpaths: Array<{ pts: Array<[number, number]>; closed: boolean; hasCurve: boolean }> = [];
    let current: { pts: Array<[number, number]>; closed: boolean; hasCurve: boolean } | null = null;
    path.walk({
      moveTo(x, y) {
        current = { pts: [applyCtm(ctm, x, y, offX, offY)], closed: false, hasCurve: false };
        subpaths.push(current);
      },
      lineTo(x, y) {
        if (!current) {
          current = { pts: [], closed: false, hasCurve: false };
          subpaths.push(current);
        }
        current.pts.push(applyCtm(ctm, x, y, offX, offY));
      },
      curveTo(_x1, _y1, _x2, _y2, x3, y3) {
        if (current) {
          current.hasCurve = true;
          current.pts.push(applyCtm(ctm, x3, y3, offX, offY));
        }
      },
      closePath() {
        if (current) current.closed = true;
      },
    });
    return subpaths;
  };

  const boundsOfPts = (pts: Array<[number, number]>): ClipBox => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of pts) {
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
    }
    return { x0, y0, x1, y1 };
  };

  const zeroStroke = new mupdf.StrokeState({
    lineCap: 'Butt',
    lineJoin: 'Miter',
    lineWidth: 0,
    miterLimit: 10,
  });

  const dev = new mupdf.Device({
    beginMask() {
      maskDepth++;
    },
    endMask() {
      maskDepth = Math.max(0, maskDepth - 1);
    },
    beginGroup(_area, _cs, _isolated, _knockout, _blendmode, alpha) {
      if (maskDepth > 0) return;
      groupAlphas.push(Math.max(0, Math.min(1, currentGroupAlpha() * (Number.isFinite(alpha) ? alpha : 1))));
    },
    endGroup() {
      if (maskDepth > 0) return;
      if (groupAlphas.length > 1) groupAlphas.pop();
    },
    clipPath(path, _evenOdd, ctm) {
      if (maskDepth > 0) return;
      const allPts = extractSubpaths(path, ctm).flatMap((s) => s.pts);
      if (allPts.length === 0) {
        clipStack.push({ ...currentClip() });
        return;
      }
      clipStack.push(intersectBox(currentClip(), boundsOfPts(allPts)));
    },
    clipStrokePath(path, _stroke, ctm) {
      if (maskDepth > 0) return;
      const allPts = extractSubpaths(path, ctm).flatMap((s) => s.pts);
      clipStack.push(allPts.length > 0 ? intersectBox(currentClip(), boundsOfPts(allPts)) : { ...currentClip() });
    },
    clipText() {
      if (maskDepth > 0) return;
      clipStack.push({ ...currentClip() });
    },
    clipStrokeText() {
      if (maskDepth > 0) return;
      clipStack.push({ ...currentClip() });
    },
    clipImageMask(_im, ctm) {
      if (maskDepth > 0) return;
      const pts: Array<[number, number]> = [
        applyCtm(ctm, 0, 0, offX, offY),
        applyCtm(ctm, 1, 0, offX, offY),
        applyCtm(ctm, 0, 1, offX, offY),
        applyCtm(ctm, 1, 1, offX, offY),
      ];
      const box = intersectBox(currentClip(), boundsOfPts(pts));
      clipStack.push(box);
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      if (preserveImages && w >= 12 && h >= 12 && !(w >= pageW * 0.88 && h >= pageH * 0.88)) {
        shapeBoxes.push({ ...box, hasCurve: true, isColoredFill: true });
      }
    },
    popClip() {
      if (maskDepth > 0) return;
      if (clipStack.length > 1) clipStack.pop();
    },
    fillText(text, ctm, colorspace, color, alpha) {
      if (maskDepth > 0) return;
      fillTextCount++;
      const effAlpha = Math.max(0, Math.min(1, alpha * currentGroupAlpha()));
      if (effAlpha >= 0.04 && effAlpha < 0.96 && color && color.length > 0) {
        try {
          const b = text.getBounds(zeroStroke, ctm);
          const box = { x0: b[0] - offX, y0: b[1] - offY, x1: b[2] - offX, y1: b[3] - offY };
          if (box.x1 > box.x0 && box.y1 > box.y0) {
            const bgRgb = getBackdropRgbAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
            const effectiveHex = colorToHex(color, effAlpha, colorspace?.getType?.(), bgRgb);
            translucentTextHints.push({ ...box, effectiveHex });
          }
        } catch {
          // Ignore text bounds failure
        }
      }
    },
    strokeText() {
      if (maskDepth === 0) fillTextCount++;
    },
    ignoreText() {
      if (maskDepth === 0) ignoreTextCount++;
    },
    strokePath(path, stroke, ctm, colorspace, color, alpha) {
      const effAlpha = Math.max(0, Math.min(1, alpha * currentGroupAlpha()));
      if (maskDepth > 0 || effAlpha < 0.03 || !color || color.length === 0) return;
      const clip = currentClip();
      if (clip.x1 - clip.x0 <= 1 || clip.y1 - clip.y0 <= 1) return;
      totalVectorOps++;
      const csType = colorspace?.getType?.();
      const widthPt = Math.max(0.5, Number(stroke?.getLineWidth?.() ?? 0.75) || 0.75);

      for (const sp of extractSubpaths(path, ctm)) {
        const pts = sp.pts;
        if (pts.length < 2) continue;
        const box = intersectBox(clip, boundsOfPts(pts));
        const bgRgb = effAlpha < 0.99 ? getBackdropRgbAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2) : ([255, 255, 255] as [number, number, number]);
        const colorHex = colorToHex(color, effAlpha, csType, bgRgb);

        let hasHVOnly = !sp.hasCurve;
        const n = sp.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[(i + 1) % pts.length];
          if (Math.abs(ay - by) <= 1.2 && Math.abs(bx - ax) >= 8) {
            const clippedX0 = Math.max(clip.x0, Math.min(ax, bx));
            const clippedX1 = Math.min(clip.x1, Math.max(ax, bx));
            if (clippedX1 - clippedX0 >= 8) {
              horizontals.push({
                coord: (ay + by) / 2,
                start: clippedX0,
                end: clippedX1,
                colorHex,
                widthPt,
              });
            }
          } else if (Math.abs(ax - bx) <= 1.2 && Math.abs(by - ay) >= 8) {
            const clippedY0 = Math.max(clip.y0, Math.min(ay, by));
            const clippedY1 = Math.min(clip.y1, Math.max(ay, by));
            if (clippedY1 - clippedY0 >= 8) {
              verticals.push({
                coord: (ax + bx) / 2,
                start: clippedY0,
                end: clippedY1,
                colorHex,
                widthPt,
              });
            }
          } else if (Math.hypot(bx - ax, by - ay) >= 6) {
            hasHVOnly = false;
          }
        }

        const bw = box.x1 - box.x0;
        const bh = box.y1 - box.y0;
        if (sp.closed && !isPureWhiteHex(colorHex) && bw >= 12 && bw <= 360 && bh >= 9 && bh <= 42) {
          strokeBoxes.push({ ...box, borderHex: colorHex, widthPt });
        }

        if (!hasHVOnly) {
          if (bw >= 6 && bh >= 6 && !(bw >= pageW * 0.88 && bh >= pageH * 0.88)) {
            shapeBoxes.push({ ...box, hasCurve: sp.hasCurve, isColoredFill: false });
          }
        }
      }
    },
    fillPath(path, _evenOdd, ctm, colorspace, color, alpha) {
      const effAlpha = Math.max(0, Math.min(1, alpha * currentGroupAlpha()));
      if (maskDepth > 0 || effAlpha < 0.025 || !color || color.length === 0) return;
      const clip = currentClip();
      if (clip.x1 - clip.x0 <= 1 || clip.y1 - clip.y0 <= 1) return;
      totalVectorOps++;
      const csType = colorspace?.getType?.();

      for (const sp of extractSubpaths(path, ctm)) {
        if (sp.pts.length < 3) continue;
        const box = intersectBox(clip, boundsOfPts(sp.pts));
        const w = box.x1 - box.x0;
        const h = box.y1 - box.y0;
        if (w < 1.5 || h < 1.5) continue;

        const bgRgb = effAlpha < 0.99 ? getBackdropRgbAt((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2) : ([255, 255, 255] as [number, number, number]);
        const colorHex = colorToHex(color, effAlpha, csType, bgRgb);

        // Skip full-page white paper background rectangles
        if (w >= pageW * 0.85 && h >= pageH * 0.85 && isNearWhiteHex(colorHex)) continue;

        if (h <= 5.5 && w >= 10 && w >= h * 2.2) {
          horizontals.push({ coord: (box.y0 + box.y1) / 2, start: box.x0, end: box.x1, colorHex, widthPt: Math.max(0.5, h) });
        } else if (w <= 6.5 && h >= 10 && h >= w * 2.0) {
          verticals.push({ coord: (box.x0 + box.x1) / 2, start: box.y0, end: box.y1, colorHex, widthPt: Math.max(0.5, w) });
        } else {
          if (!isPureWhiteHex(colorHex) && w >= 10 && h >= 8 && !(w >= pageW * 0.9 && h >= pageH * 0.9)) {
            fills.push({ ...box, fillHex: colorHex });
            shapeBoxes.push({
              ...box,
              hasCurve: sp.hasCurve,
              isColoredFill: !isPureWhiteHex(colorHex),
            });
          }
        }
      }
    },
    fillShade(shade, ctm, alpha) {
      const effAlpha = Math.max(0, Math.min(1, alpha * currentGroupAlpha()));
      if (maskDepth > 0 || effAlpha < 0.05) return;
      const clip = currentClip();
      const sb = shade.getBounds();
      const pts: Array<[number, number]> = [
        applyCtm(ctm, sb[0], sb[1], offX, offY),
        applyCtm(ctm, sb[2], sb[1], offX, offY),
        applyCtm(ctm, sb[0], sb[3], offX, offY),
        applyCtm(ctm, sb[2], sb[3], offX, offY),
      ];
      const box = intersectBox(clip, boundsOfPts(pts));
      if (box.x1 - box.x0 >= 24 && box.y1 - box.y0 >= 20 && !(box.x1 - box.x0 >= pageW * 0.9 && box.y1 - box.y0 >= pageH * 0.9)) {
        shapeBoxes.push({ ...box, hasCurve: true, isColoredFill: true });
      }
    },
    fillImage(image, ctm, alpha) {
      const effAlpha = Math.max(0, Math.min(1, alpha * currentGroupAlpha()));
      if (!preserveImages || maskDepth > 0 || effAlpha < 0.04) return;
      const pts: Array<[number, number]> = [
        applyCtm(ctm, 0, 0, offX, offY),
        applyCtm(ctm, 1, 0, offX, offY),
        applyCtm(ctm, 0, 1, offX, offY),
        applyCtm(ctm, 1, 1, offX, offY),
      ];
      const rawBox = boundsOfPts(pts);
      const clipped = intersectBox(currentClip(), rawBox);
      const w = clipped.x1 - clipped.x0;
      const h = clipped.y1 - clipped.y0;
      if (w < 10 || h < 10) return;

      const ctmCopy = [...ctm];
      const isLargeBackdropCandidate = w >= pageW * 0.85 && h >= pageH * 0.85;
      pendingImagePromises.push(
        extractRasterImagePng(image, ctmCopy, rawBox, clipped, effAlpha).then((bytes) => {
          if (!bytes) return null;
          return {
            x0: clipped.x0,
            y0: clipped.y0,
            x1: clipped.x1,
            y1: clipped.y1,
            bytes,
            isLargeBackdropCandidate,
          };
        })
      );
    },
    fillImageMask(image, ctm, colorspace, color, alpha) {
      const effAlpha = Math.max(0, Math.min(1, alpha * currentGroupAlpha()));
      if (!preserveImages || maskDepth > 0 || effAlpha < 0.05) return;
      const pts: Array<[number, number]> = [
        applyCtm(ctm, 0, 0, offX, offY),
        applyCtm(ctm, 1, 0, offX, offY),
        applyCtm(ctm, 0, 1, offX, offY),
        applyCtm(ctm, 1, 1, offX, offY),
      ];
      const rawBox = boundsOfPts(pts);
      const clipped = intersectBox(currentClip(), rawBox);
      const w = clipped.x1 - clipped.x0;
      const h = clipped.y1 - clipped.y0;
      if (w < 10 || h < 10) return;
      const colorHex = colorToHex(color, 1, colorspace?.getType?.());
      const ctmCopy = [...ctm];
      pendingImagePromises.push(
        extractImageMaskPng(image, ctmCopy, rawBox, clipped, colorHex, effAlpha).then((bytes) => {
          if (!bytes) return null;
          return {
            x0: clipped.x0,
            y0: clipped.y0,
            x1: clipped.x1,
            y1: clipped.y1,
            bytes,
            isLargeBackdropCandidate: false,
          };
        })
      );
    },
  });

  try {
    page.run(dev, mupdf.Matrix.identity);
  } finally {
    dev.close();
    dev.destroy();
    zeroStroke.destroy();
  }

  const resolvedImages = (await Promise.all(pendingImagePromises)).filter(
    (x): x is PendingImageTask => x !== null
  );

  return {
    horizontals,
    verticals,
    fills,
    strokeBoxes,
    translucentTextHints,
    shapeBoxes,
    pendingImages: resolvedImages,
    fillTextCount,
    ignoreTextCount,
    totalVectorOps,
  };
}

function hasHorizontalBorderAt(
  horizontals: HVSegment[],
  yCoord: number,
  colX0: number,
  colX1: number
): boolean {
  const spanMid = (colX0 + colX1) / 2;
  return horizontals.some(
    (h) => Math.abs(h.coord - yCoord) <= 3.5 && h.start <= spanMid && h.end >= spanMid
  );
}

function hasVerticalBorderAt(
  verticals: HVSegment[],
  xCoord: number,
  rowY0: number,
  rowY1: number
): boolean {
  const spanMid = (rowY0 + rowY1) / 2;
  return verticals.some(
    (v) => Math.abs(v.coord - xCoord) <= 3.5 && v.start <= spanMid && v.end >= spanMid
  );
}

function findColumnLanes(segments: VisualSegment[], minGap = 12): number[] | null {
  if (segments.length === 0) return null;
  const intervals = segments
    .map((s) => ({ x0: s.x0, x1: s.x1 }))
    .sort((a, b) => a.x0 - b.x0);
  const merged: Array<{ x0: number; x1: number }> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (!last || iv.x0 > last.x1 + minGap) {
      merged.push({ ...iv });
    } else {
      last.x1 = Math.max(last.x1, iv.x1);
    }
  }
  if (merged.length < 2) return null;
  const bounds: number[] = [merged[0].x0 - 4];
  for (let i = 0; i < merged.length - 1; i++) {
    bounds.push((merged[i].x1 + merged[i + 1].x0) / 2);
  }
  bounds.push(merged[merged.length - 1].x1 + 4);
  return bounds;
}

function detectAllTables(
  horizontals: HVSegment[],
  verticals: HVSegment[],
  fills: FillRect[],
  shapeBoxes: ShapeBox[],
  allSegments: VisualSegment[],
  pageW: number,
  pageH: number
): DetectedTable[] {
  const tables: DetectedTable[] = [];

  // 1. Bordered Vector Grid Tables (connected H/V rules)
  if (horizontals.length >= 2 && verticals.length >= 2) {
    const hAdj: number[][] = Array.from({ length: horizontals.length }, () => []);
    const vAdj: number[][] = Array.from({ length: verticals.length }, () => []);
    const tol = 3.5;

    for (let hi = 0; hi < horizontals.length; hi++) {
      const h = horizontals[hi];
      for (let vi = 0; vi < verticals.length; vi++) {
        const v = verticals[vi];
        if (
          v.coord >= h.start - tol &&
          v.coord <= h.end + tol &&
          h.coord >= v.start - tol &&
          h.coord <= v.end + tol
        ) {
          hAdj[hi].push(vi);
          vAdj[vi].push(hi);
        }
      }
    }

    const visitedH = new Set<number>();
    const visitedV = new Set<number>();

    for (let startH = 0; startH < horizontals.length; startH++) {
      if (visitedH.has(startH) || hAdj[startH].length === 0) continue;

      const compH: number[] = [];
      const compV: number[] = [];
      const queue: Array<{ type: 'h' | 'v'; idx: number }> = [{ type: 'h', idx: startH }];
      visitedH.add(startH);

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.type === 'h') {
          compH.push(cur.idx);
          for (const vi of hAdj[cur.idx]) {
            if (!visitedV.has(vi)) {
              visitedV.add(vi);
              queue.push({ type: 'v', idx: vi });
            }
          }
        } else {
          compV.push(cur.idx);
          for (const hi of vAdj[cur.idx]) {
            if (!visitedH.has(hi)) {
              visitedH.add(hi);
              queue.push({ type: 'h', idx: hi });
            }
          }
        }
      }

      const rowBounds = clusterCoords(
        compH.map((i) => horizontals[i].coord),
        3.0
      ).filter((y, i, arr) => i === 0 || y - arr[i - 1] >= 10);
      const colBounds = clusterCoords(
        compV.map((i) => verticals[i].coord),
        3.0
      ).filter((x, i, arr) => i === 0 || x - arr[i - 1] >= 12);

      const numRows = rowBounds.length - 1;
      const numCols = colBounds.length - 1;
      if (numRows < 1 || numCols < 1 || (numRows === 1 && numCols === 1)) continue;

      const x0 = colBounds[0];
      const x1 = colBounds[colBounds.length - 1];
      const y0 = rowBounds[0];
      const y1 = rowBounds[rowBounds.length - 1];
      const tw = x1 - x0;
      const th = y1 - y0;

      // Reject outer page-border frames and tall 1-col callout boxes
      if (tw >= pageW * 0.85 && th >= pageH * 0.85 && numCols < 3) continue;
      if (numCols === 1 && th > pageH * 0.48) continue;

      // Reject vector diagrams/charts disguised as intersecting lines (curve shapes inside + sparse text)
      const curvesInside = shapeBoxes.filter(
        (s) => s.hasCurve && s.x1 > x0 + 2 && s.x0 < x1 - 2 && s.y1 > y0 + 2 && s.y0 < y1 - 2
      ).length;
      const segsInside = allSegments.filter(
        (s) => {
          const cx = (s.x0 + s.x1) / 2;
          const cy = (s.y0 + s.y1) / 2;
          return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
        }
      );
      if (curvesInside >= 3 && segsInside.length < numRows * numCols * 0.35) continue;

      const compHorizontals = compH.map((i) => horizontals[i]);
      const compVerticals = compV.map((i) => verticals[i]);
      const tableFills = fills.filter(
        (f) => f.x1 > x0 + 2 && f.x0 < x1 - 2 && f.y1 > y0 + 2 && f.y0 < y1 - 2
      );

      tables.push({
        kind: 'bordered',
        x0,
        y0,
        x1,
        y1,
        colBounds,
        rowBounds,
        horizontals: compHorizontals,
        verticals: compVerticals,
        fills: tableFills,
      });
    }
  }

  // 2. Three-Line & Horizontal-Rule Tables (三线表 without vertical lines)
  const usedInBordered = (h: HVSegment) =>
    tables.some((t) => h.coord >= t.y0 - 4 && h.coord <= t.y1 + 4 && h.end >= t.x0 - 4 && h.start <= t.x1 + 4);
  const wideHorizontals = horizontals
    .filter((h) => h.end - h.start >= pageW * 0.30 && !usedInBordered(h))
    .sort((a, b) => a.coord - b.coord);

  const usedRuleIdx = new Set<number>();
  for (let i = 0; i < wideHorizontals.length; i++) {
    if (usedRuleIdx.has(i)) continue;
    const base = wideHorizontals[i];
    const group: number[] = [i];
    for (let j = i + 1; j < wideHorizontals.length; j++) {
      if (usedRuleIdx.has(j)) continue;
      const cand = wideHorizontals[j];
      const overlapW = Math.min(base.end, cand.end) - Math.max(base.start, cand.start);
      const maxW = Math.max(base.end - base.start, cand.end - cand.start);
      if (overlapW >= maxW * 0.78 && Math.abs(cand.coord - wideHorizontals[group[group.length - 1]].coord) <= pageH * 0.55) {
        group.push(j);
        if (group.length >= 16) break;
      }
    }
    if (group.length >= 2) {
      const yTop = wideHorizontals[group[0]].coord;
      const yBot = wideHorizontals[group[group.length - 1]].coord;
      if (yBot - yTop < 22 || yBot - yTop > pageH * 0.82) continue;
      if (group.length === 2 && yBot - yTop > 220) continue;

      const x0 = Math.min(...group.map((idx) => wideHorizontals[idx].start));
      const x1 = Math.max(...group.map((idx) => wideHorizontals[idx].end));

      const innerSegs = allSegments.filter((s) => {
        const cx = (s.x0 + s.x1) / 2;
        const cy = (s.y0 + s.y1) / 2;
        return cx >= x0 - 4 && cx <= x1 + 4 && cy >= yTop - 2 && cy <= yBot + 2;
      });
      if (innerSegs.length < 4) continue;
      if (group.length === 2 && innerSegs.some((s) => /^[•●◦▪]/.test(s.plainText.trim()))) continue;

      // Cluster inner baseline rows
      const rowBaselines = clusterCoords(
        innerSegs.map((s) => s.baselineY),
        5.0
      );
      if (rowBaselines.length < 2) continue;

      const colLanes = findColumnLanes(innerSegs, 10);
      if (!colLanes || colLanes.length < 3) continue; // at least 2 cols -> 3 bounds
      if (innerSegs.length < colLanes.length) continue;

      // Verify genuine tabular structure (not prose paragraphs between dividers)
      const colHits = colLanes.slice(0, -1).map((cb, c) =>
        innerSegs.filter((s) => {
          const cx = (s.x0 + s.x1) / 2;
          return cx >= cb && cx <= colLanes[c + 1];
        }).length
      );
      if (colHits.some((cnt) => cnt < 1)) continue;

      // Build row boundaries aligned to horizontal rules where available
      const rowBounds: number[] = [Math.min(yTop, Math.min(...innerSegs.map((s) => s.y0)) - 2)];
      for (let r = 0; r < rowBaselines.length - 1; r++) {
        const mid = (rowBaselines[r] + rowBaselines[r + 1]) / 2;
        const nearRule = group
          .map((idx) => wideHorizontals[idx].coord)
          .find((ry) => Math.abs(ry - mid) <= 10);
        rowBounds.push(nearRule ?? mid);
      }
      rowBounds.push(Math.max(yBot, Math.max(...innerSegs.map((s) => s.y1)) + 2));

      group.forEach((idx) => usedRuleIdx.add(idx));
      const tableHorizontals = group.map((idx) => wideHorizontals[idx]);
      const tableFills = fills.filter(
        (f) => f.x1 > x0 + 2 && f.x0 < x1 - 2 && f.y1 > rowBounds[0] + 2 && f.y0 < rowBounds[rowBounds.length - 1] - 2
      );

      tables.push({
        kind: 'three-line',
        x0: Math.min(x0, colLanes[0]),
        y0: rowBounds[0],
        x1: Math.max(x1, colLanes[colLanes.length - 1]),
        y1: rowBounds[rowBounds.length - 1],
        colBounds: [Math.min(x0, colLanes[0]), ...colLanes.slice(1, -1), Math.max(x1, colLanes[colLanes.length - 1])],
        rowBounds,
        horizontals: tableHorizontals,
        verticals: [],
        fills: tableFills,
      });
    }
  }

  return tables.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

function buildVisualRowsFromLines(rawLines: RawCharSpan[][]): VisualRow[] {
  const rawSegments: VisualSegment[] = [];

  for (const rawChars of rawLines) {
    if (rawChars.length === 0) continue;

    // Deduplicate fake-bold doubled glyphs (exact same char printed <=1.2pt apart)
    const chars: RawCharSpan[] = [];
    for (const ch of rawChars) {
      const prev = chars[chars.length - 1];
      if (
        prev &&
        prev.ch === ch.ch &&
        !/\s/.test(ch.ch) &&
        Math.abs(ch.x0 - prev.x0) <= 1.2 &&
        Math.abs(ch.baselineY - prev.baselineY) <= 1.5
      ) {
        prev.bold = true;
        prev.x1 = Math.max(prev.x1, ch.x1);
        continue;
      }
      chars.push({ ...ch });
    }

    let curGroup: RawCharSpan[] = [chars[0]];
    const splitGroups: RawCharSpan[][] = [curGroup];

    for (let i = 1; i < chars.length; i++) {
      const prev = chars[i - 1];
      const curr = chars[i];
      const gap = curr.x0 - prev.x1;
      const punctExtra = CJK_CLOSE_PUNCT.has(prev.ch) || CJK_OPEN_PUNCT.has(curr.ch) ? prev.fontSizePt * 0.55 : 0;
      const splitThreshold = Math.max(prev.fontSizePt * 1.9, 18) + punctExtra;
      if (gap > splitThreshold) {
        curGroup = [curr];
        splitGroups.push(curGroup);
      } else {
        curGroup.push(curr);
      }
    }

    for (const grp of splitGroups) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let baselineSum = 0;
      let maxFont = 8;
      const runs: TextRun[] = [];

      for (let i = 0; i < grp.length; i++) {
        const ch = grp[i];
        if (ch.x0 < x0) x0 = ch.x0;
        if (ch.y0 < y0) y0 = ch.y0;
        if (ch.x1 > x1) x1 = ch.x1;
        if (ch.y1 > y1) y1 = ch.y1;
        baselineSum += ch.baselineY;
        if (ch.fontSizePt > maxFont) maxFont = ch.fontSizePt;

        if (i > 0) {
          const prev = grp[i - 1];
          const gap = ch.x0 - prev.x1;
          const prevCjk = isCjkOrFullWidth(prev.ch);
          const currCjk = isCjkOrFullWidth(ch.ch);

          let spaceThreshold: number;
          if (CJK_CLOSE_PUNCT.has(prev.ch) || CJK_OPEN_PUNCT.has(ch.ch)) {
            spaceThreshold = prev.fontSizePt * 1.15;
          } else if (prevCjk && currCjk) {
            spaceThreshold = prev.fontSizePt * 0.72;
          } else if (prevCjk || currCjk) {
            spaceThreshold = prev.fontSizePt * 0.45;
          } else {
            spaceThreshold = prev.fontSizePt * 0.23;
          }

          const sameBadge = prev.badgeId !== undefined && ch.badgeId !== undefined && prev.badgeId === ch.badgeId;
          const badgeBoundary = (prev.badgeId ?? 0) !== (ch.badgeId ?? 0);
          if (gap > spaceThreshold && !/\s/.test(prev.ch) && !/\s/.test(ch.ch)) {
            const needDoubleSpace = badgeBoundary && gap >= Math.min(prev.fontSizePt, ch.fontSizePt) * 0.95;
            runs.push({
              text: needDoubleSpace ? '  ' : ' ',
              fontSizePt: prev.fontSizePt,
              fontFamily: prev.fontFamily,
              bold: prev.bold,
              italic: prev.italic,
              colorHex: prev.colorHex,
              ...(sameBadge ? { bgHex: prev.bgHex, borderHex: prev.borderHex, badgeId: prev.badgeId } : {}),
            });
          } else if (badgeBoundary && gap > 0.35 && !/\s/.test(prev.ch) && !/\s/.test(ch.ch)) {
            runs.push({
              text: gap >= Math.min(prev.fontSizePt, ch.fontSizePt) * 0.95 ? '  ' : ' ',
              fontSizePt: Math.min(prev.fontSizePt, ch.fontSizePt),
              fontFamily: 'Calibri',
              bold: false,
              italic: false,
              colorHex: '334155',
            });
          }
        }

        runs.push({
          text: ch.ch,
          fontSizePt: ch.fontSizePt,
          fontFamily: ch.fontFamily,
          bold: ch.bold,
          italic: ch.italic,
          colorHex: ch.colorHex,
          ...(ch.bgHex ? { bgHex: ch.bgHex } : {}),
          ...(ch.borderHex ? { borderHex: ch.borderHex } : {}),
          ...(ch.badgeId !== undefined ? { badgeId: ch.badgeId } : {}),
        });
      }

      const merged = mergeRuns(runs);
      const plain = merged.map((r) => r.text).join('').trim();
      if (!plain) continue;

      rawSegments.push({
        x0,
        y0,
        x1,
        y1,
        baselineY: baselineSum / grp.length,
        fontSizePt: maxFont,
        runs: merged,
        plainText: plain,
      });
    }
  }

  rawSegments.sort((a, b) => a.baselineY - b.baselineY || a.x0 - b.x0);

  const rows: VisualRow[] = [];
  for (const seg of rawSegments) {
    const segH = Math.max(8, seg.y1 - seg.y0);
    const hit = rows.find((r) => {
      const rH = Math.max(8, r.y1 - r.y0);
      return Math.abs(r.baselineY - seg.baselineY) <= Math.min(rH, segH) * 0.45;
    });
    if (hit) {
      hit.segments.push(seg);
      hit.x0 = Math.min(hit.x0, seg.x0);
      hit.y0 = Math.min(hit.y0, seg.y0);
      hit.x1 = Math.max(hit.x1, seg.x1);
      hit.y1 = Math.max(hit.y1, seg.y1);
      hit.fontSizePt = Math.max(hit.fontSizePt, seg.fontSizePt);
    } else {
      rows.push({
        x0: seg.x0,
        y0: seg.y0,
        x1: seg.x1,
        y1: seg.y1,
        baselineY: seg.baselineY,
        fontSizePt: seg.fontSizePt,
        segments: [seg],
      });
    }
  }

  for (const row of rows) {
    row.segments.sort((a, b) => a.x0 - b.x0);
  }
  rows.sort((a, b) => a.y0 - b.y0);
  return rows;
}

function splitRowsByTwoColumns(
  rows: VisualRow[],
  contentLeft: number,
  contentRight: number
): { splitX: number; leftRows: VisualRow[]; rightRows: VisualRow[] } | null {
  if (rows.length < 4) return null;
  const availW = contentRight - contentLeft;
  if (availW < 220) return null;

  // Test clean vertical gutter splits near the middle 30%..70% of content width
  const segs = rows.flatMap((r) => r.segments);
  const midX = (contentLeft + contentRight) / 2;
  let bestSplit: number | null = null;
  let bestDist = Infinity;

  for (let cand = contentLeft + availW * 0.34; cand <= contentLeft + availW * 0.66; cand += 6) {
    const crosses = segs.some((s) => s.x0 < cand - 4 && s.x1 > cand + 4);
    if (!crosses) {
      const d = Math.abs(cand - midX);
      if (d < bestDist) {
        bestDist = d;
        bestSplit = cand;
      }
    }
  }
  if (bestSplit === null) return null;

  const leftRows: VisualRow[] = [];
  const rightRows: VisualRow[] = [];
  for (const r of rows) {
    const ls = r.segments.filter((s) => s.x1 <= bestSplit! + 2);
    const rs = r.segments.filter((s) => s.x0 >= bestSplit! - 2);
    if (ls.length > 0) {
      leftRows.push({
        ...r,
        x0: Math.min(...ls.map((s) => s.x0)),
        x1: Math.max(...ls.map((s) => s.x1)),
        segments: ls,
      });
    }
    if (rs.length > 0) {
      rightRows.push({
        ...r,
        x0: Math.min(...rs.map((s) => s.x0)),
        x1: Math.max(...rs.map((s) => s.x1)),
        segments: rs,
      });
    }
  }

  // Must look like true multi-line prose columns on both sides
  if (leftRows.length < 3 || rightRows.length < 3) return null;
  const leftAvgLen = leftRows.reduce((s, r) => s + r.segments.map((x) => x.plainText).join('').length, 0) / leftRows.length;
  const rightAvgLen = rightRows.reduce((s, r) => s + r.segments.map((x) => x.plainText).join('').length, 0) / rightRows.length;
  if (leftAvgLen < 12 && rightAvgLen < 12) return null;

  return { splitX: bestSplit, leftRows, rightRows };
}

function buildBorderlessAlignedTableXml(
  rows: VisualRow[],
  colBounds: number[],
  bodyFontPt: number
): string {
  const numCols = colBounds.length - 1;
  const totalW = Math.max(400, Math.round((colBounds[numCols] - colBounds[0]) * PT_TO_TWIPS));
  const colWidthsTwips = Array.from({ length: numCols }, (_, c) =>
    Math.max(160, Math.round((colBounds[c + 1] - colBounds[c]) * PT_TO_TWIPS))
  );

  const trList: string[] = [];
  for (const row of rows) {
    const tcList: string[] = [];
    for (let c = 0; c < numCols; c++) {
      const cx0 = colBounds[c];
      const cx1 = colBounds[c + 1];
      const segsInCol = row.segments.filter((s) => {
        const mid = (s.x0 + s.x1) / 2;
        return c === 0 ? mid <= cx1 : c === numCols - 1 ? mid >= cx0 : mid >= cx0 && mid <= cx1;
      });
      const cellRow: VisualRow = {
        ...row,
        segments: segsInCol,
      };
      const paras =
        segsInCol.length > 0
          ? renderVisualRowsToParagraphXml([cellRow], cx0, cx1, cx0 + cx1, bodyFontPt, 2, true)
          : ['<w:p><w:pPr><w:spacing w:before="0" w:after="20"/></w:pPr></w:p>'];
      tcList.push(
        `<w:tc><w:tcPr><w:tcW w:w="${colWidthsTwips[c]}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${paras.join('')}</w:tc>`
      );
    }
    trList.push(`<w:tr>${tcList.join('')}</w:tr>`);
  }

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${totalW}" w:type="dxa"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblBorders>
        <w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/>
        <w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="30" w:type="dxa"/><w:left w:w="60" w:type="dxa"/>
        <w:bottom w:w="30" w:type="dxa"/><w:right w:w="60" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tblGrid>${colWidthsTwips.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
    ${trList.join('')}
  </w:tbl>`;
}

function buildSideBySideLayoutTableXml(
  leftElements: string[],
  rightElements: string[],
  leftW: number,
  rightW: number
): string {
  const wL = Math.max(400, Math.round(leftW * PT_TO_TWIPS));
  const wR = Math.max(400, Math.round(rightW * PT_TO_TWIPS));
  const totalW = wL + wR;
  const safeL = leftElements.length > 0 ? leftElements.join('') : '<w:p/>';
  const safeR = rightElements.length > 0 ? rightElements.join('') : '<w:p/>';
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${totalW}" w:type="dxa"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblBorders>
        <w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/>
        <w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="20" w:type="dxa"/><w:left w:w="40" w:type="dxa"/>
        <w:bottom w:w="20" w:type="dxa"/><w:right w:w="40" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="${wL}"/><w:gridCol w:w="${wR}"/></w:tblGrid>
    <w:tr>
      <w:tc><w:tcPr><w:tcW w:w="${wL}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>${safeL}</w:tc>
      <w:tc><w:tcPr><w:tcW w:w="${wR}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>${safeR}</w:tc>
    </w:tr>
  </w:tbl>`;
}

function renderVisualRowsToParagraphXml(
  rows: VisualRow[],
  contentLeft: number,
  contentRight: number,
  pageW: number,
  bodyFontPt: number,
  defaultGapPt: number,
  suppressTabStops = false
): string[] {
  if (rows.length === 0) return [];

  const availW = Math.max(80, contentRight - contentLeft);
  const pageMid = pageW / 2;

  // Check if free block splits cleanly into 2 side-by-side prose columns (XY-Cut)
  if (!suppressTabStops) {
    const split = splitRowsByTwoColumns(rows, contentLeft, contentRight);
    if (split) {
      return [
        ...renderVisualRowsToParagraphXml(split.leftRows, contentLeft, split.splitX - 4, split.splitX + contentLeft, bodyFontPt, defaultGapPt, false),
        ...renderVisualRowsToParagraphXml(split.rightRows, split.splitX + 4, contentRight, split.splitX + contentRight, bodyFontPt, defaultGapPt, false),
      ];
    }
  }

  const outElements: string[] = [];

  // Process runs of rows, extracting any >=3-row borderless tabular aligned blocks cleanly into borderless tables
  const emitParagraphGroup = (groupRows: VisualRow[]) => {
    const bodyBaselineSteps: number[] = [];
    for (let k = 1; k < groupRows.length; k++) {
      const step = groupRows[k].baselineY - groupRows[k - 1].baselineY;
      if (step >= bodyFontPt * 1.05 && step <= bodyFontPt * 1.65) {
        bodyBaselineSteps.push(step);
      }
    }
    bodyBaselineSteps.sort((a, b) => a - b);
    const groupDefaultPitchPt =
      bodyBaselineSteps.length > 0
        ? bodyBaselineSteps[Math.floor(bodyBaselineSteps.length * 0.45)]
        : Math.max(bodyFontPt * 1.24, bodyFontPt + defaultGapPt * 0.65);

    interface FlowPara {
      runs: TextRun[];
      align: 'left' | 'center' | 'right';
      spaceBeforeTwips: number;
      spaceAfterTwips: number;
      spaceAfterPt: number;
      linePitchPt: number;
      firstLineTwips: number;
      leftIndentTwips: number;
      hangingTwips: number;
      tabStops: Array<{ val: 'left' | 'right'; pos: number }>;
      fontSizePt: number;
      firstSegFontPt: number;
      boldCount: number;
      charCount: number;
      isListStart: boolean;
      isBulletSymbol: boolean;
      hangingTargetX?: number;
      leadingIcon?: PageImageBlock;
      bottomBorder?: BorderRule;
      topBorder?: BorderRule;
      leftBorder?: BorderRule;
      shadingHex?: string;
      calloutX0?: number;
      firstRow: VisualRow;
      lastRow: VisualRow;
      rowBaselines: number[];
    }

    const flowParas: FlowPara[] = [];

    const rowToCombinedRuns = (
      row: VisualRow
    ): { runs: TextRun[]; tabStops: Array<{ val: 'left' | 'right'; pos: number }>; plain: string } => {
      const combined: TextRun[] = [];
      const tabStops: Array<{ val: 'left' | 'right'; pos: number }> = [];

      // If >= 2 segments and the LAST segment hugs the right edge (e.g. title + badge + subtitle   2025.06 - 2026.03)
      // use a clean right-aligned tab stop for the rightmost segment!
      const lastSegIdx = row.segments.length - 1;
      const lastSeg = row.segments[lastSegIdx];
      const prevOfLast = lastSegIdx >= 1 ? row.segments[lastSegIdx - 1] : null;
      const rightEdgeGap = prevOfLast ? lastSeg.x0 - prevOfLast.x1 : 0;
      const hasRightEdgeTab =
        !suppressTabStops &&
        row.segments.length >= 2 &&
        prevOfLast !== null &&
        rightEdgeGap > Math.max(lastSeg.fontSizePt * 2.0, 20) &&
        Math.abs(lastSeg.x1 - contentRight) <= 24 &&
        lastSeg.x0 > pageMid;

      const rowHasBadges = row.segments.some((s) => s.runs.some((r) => r.badgeId !== undefined));
      for (let i = 0; i < row.segments.length; i++) {
        const seg = row.segments[i];
        if (i > 0) {
          const prev = row.segments[i - 1];
          const gap = seg.x0 - prev.x1;
          if (hasRightEdgeTab && i === lastSegIdx) {
            tabStops.push({ val: 'right', pos: Math.max(200, Math.round(availW * PT_TO_TWIPS)) });
            combined.push({
              text: '\t',
              fontSizePt: seg.fontSizePt,
              fontFamily: 'Calibri',
              bold: false,
              italic: false,
              colorHex: '334155',
            });
          } else if (!suppressTabStops && !rowHasBadges && gap > Math.max(seg.fontSizePt * 2.6, 26)) {
            tabStops.push({ val: 'left', pos: Math.max(100, Math.round((seg.x0 - contentLeft) * PT_TO_TWIPS)) });
            combined.push({
              text: '\t',
              fontSizePt: seg.fontSizePt,
              fontFamily: 'Calibri',
              bold: false,
              italic: false,
              colorHex: '334155',
            });
          } else if (gap > Math.min(2.2, seg.fontSizePt * 0.24)) {
            combined.push({
              text: ' ',
              fontSizePt: seg.fontSizePt,
              fontFamily: 'Calibri',
              bold: false,
              italic: false,
              colorHex: '334155',
            });
          }
        }
        combined.push(...seg.runs);
      }
      const plain = combined.map((r) => r.text).join('').trim();
      return { runs: combined, tabStops, plain };
    };

    for (let i = 0; i < groupRows.length; i++) {
      const row = groupRows[i];
      const { runs, tabStops, plain } = rowToCombinedRuns(row);
      if (!plain) continue;

      const lineW = row.x1 - row.x0;
      const lineMid = (row.x0 + row.x1) / 2;
      let align: 'left' | 'center' | 'right' = 'left';
      if (
        !row.leadingIcon &&
        !row.bottomBorder &&
        !row.topBorder &&
        lineW < availW * 0.80 &&
        Math.abs(lineMid - pageMid) <= 20 &&
        row.x0 > contentLeft + 16 &&
        tabStops.length === 0
      ) {
        align = 'center';
      } else if (
        !row.leadingIcon &&
        !row.bottomBorder &&
        !row.topBorder &&
        lineW < availW * 0.52 &&
        Math.abs(row.x1 - contentRight) <= 20 &&
        row.x0 > pageMid &&
        tabStops.length === 0
      ) {
        align = 'right';
      }

      const charCount = plain.length;
      const boldCount = runs.reduce((s, r) => (r.bold ? s + r.text.trim().length : s), 0);
      const isBulletSymbol = /^[•●◦▪]/.test(plain);
      const isListStart = /^([•●◦▪\-*]|(\d{1,2}|[a-zA-Z])[.)、]|[(（](\d{1,2}|[一二三四五六七八九十]+)[)）]|[一二三四五六七八九十]+[、.])/.test(
        plain
      );

      const prevPara = flowParas[flowParas.length - 1];
      const dy = prevPara ? row.y0 - prevPara.lastRow.y1 : 0;

      let canMerge = false;
      if (
        prevPara &&
        prevPara.align === 'left' &&
        align === 'left' &&
        prevPara.tabStops.length === 0 &&
        tabStops.length === 0 &&
        !isListStart &&
        !prevPara.bottomBorder &&
        !row.topBorder &&
        !row.leadingIcon &&
        (prevPara.shadingHex ?? '') === (row.shadingHex ?? '') &&
        (prevPara.leftBorder?.colorHex ?? '') === (row.leftBorder?.colorHex ?? '') &&
        Math.abs(row.fontSizePt - prevPara.fontSizePt) <= 1.5 &&
        dy >= -4 &&
        dy <= Math.max(prevPara.fontSizePt * 0.78, defaultGapPt * 1.45)
      ) {
        const prevPlain = prevPara.runs.map((r) => r.text).join('').trimEnd();
        const prevReachedMargin = prevPara.lastRow.x1 >= contentRight - Math.max(prevPara.fontSizePt * 4.0, 42);
        const endsHardStop = /[。！？.!?：:]$/.test(prevPlain);
        const isShortHeadingLike =
          !prevPara.shadingHex &&
          !prevPara.leftBorder &&
          prevPara.boldCount >= prevPara.charCount * 0.8 &&
          (prevPara.firstSegFontPt > bodyFontPt + 1.2 || prevPara.charCount <= 28);
        const alignedFollow = prevPara.isListStart
          ? row.x0 >= prevPara.firstRow.x0 - 2 && row.x0 <= prevPara.firstRow.x0 + Math.max(32, prevPara.fontSizePt * 2.8)
          : Math.abs(row.x0 - prevPara.lastRow.x0) <= 10 || Math.abs(row.x0 - prevPara.firstRow.x0) <= 28;
        if (!isShortHeadingLike && (prevReachedMargin || (!endsHardStop && alignedFollow))) {
          canMerge = true;
        }
      }

      if (canMerge && prevPara) {
        const prevText = prevPara.runs.map((r) => r.text).join('');
        const lastChar = prevText.slice(-1);
        const firstChar = plain.slice(0, 1);
        if (lastChar && firstChar && !/\s/.test(lastChar) && (!isCjkOrFullWidth(lastChar) || !isCjkOrFullWidth(firstChar))) {
          const carryBg = prevPara.runs[prevPara.runs.length - 1]?.badgeId !== undefined ? undefined : undefined;
          prevPara.runs.push({
            text: ' ',
            fontSizePt: row.fontSizePt,
            fontFamily: 'Calibri',
            bold: false,
            italic: false,
            colorHex: '334155',
            ...(carryBg ? { bgHex: carryBg } : {}),
          });
        }
        prevPara.runs.push(...runs);
        prevPara.charCount += charCount;
        prevPara.boldCount += boldCount;
        if (prevPara.isListStart && row.x0 > prevPara.firstRow.x0 + 3) {
          prevPara.hangingTargetX = Math.max(prevPara.hangingTargetX ?? 0, row.x0);
        }
        prevPara.rowBaselines.push(row.baselineY);
        prevPara.lastRow = row;
        if (row.bottomBorder) prevPara.bottomBorder = row.bottomBorder;
      } else {
        const firstSegFontPt = row.segments[0]?.fontSizePt ?? row.fontSizePt;
        const estPitch =
          Math.abs(row.fontSizePt - bodyFontPt) <= 1.2
            ? groupDefaultPitchPt
            : Math.max(row.fontSizePt * 1.18, Math.min(row.fontSizePt * 1.48, groupDefaultPitchPt * (row.fontSizePt / Math.max(6, bodyFontPt))));

        const rawLeftIndent = align === 'left' ? Math.max(0, row.x0 - contentLeft) : 0;
        const isCalloutBox = Boolean(row.shadingHex || row.leftBorder);
        const firstLineTwips =
          !isCalloutBox && !isListStart && rawLeftIndent >= bodyFontPt * 1.1 && rawLeftIndent <= bodyFontPt * 3.2
            ? Math.round(rawLeftIndent * PT_TO_TWIPS)
            : 0;
        const leftIndentTwips = firstLineTwips > 0 || rawLeftIndent < 4 ? 0 : Math.round(rawLeftIndent * PT_TO_TWIPS);

        const spaceAfterPt = row.bottomBorder ? 2.5 : isCalloutBox ? 2.0 : 0;

        flowParas.push({
          runs,
          align,
          spaceBeforeTwips: 0,
          spaceAfterTwips: Math.round(spaceAfterPt * PT_TO_TWIPS),
          spaceAfterPt,
          linePitchPt: estPitch,
          firstLineTwips,
          leftIndentTwips,
          hangingTwips: 0,
          tabStops,
          fontSizePt: row.fontSizePt,
          firstSegFontPt,
          boldCount,
          charCount,
          isListStart,
          isBulletSymbol,
          leadingIcon: row.leadingIcon,
          bottomBorder: row.bottomBorder,
          topBorder: row.topBorder,
          leftBorder: row.leftBorder,
          shadingHex: row.shadingHex,
          calloutX0: row.calloutX0,
          firstRow: row,
          lastRow: row,
          rowBaselines: [row.baselineY],
        });
      }
    }

    // Finalize exact line pitches, uniform bullet hanging indents, and baseline-to-baseline spacing
    const measuredHangPts = flowParas
      .filter((fp) => fp.isBulletSymbol && fp.hangingTargetX !== undefined)
      .map((fp) => Math.max(7, (fp.hangingTargetX! - fp.firstRow.x0)));
    const defaultBulletHangPt =
      measuredHangPts.length > 0
        ? measuredHangPts[Math.floor(measuredHangPts.length / 2)]
        : 0;

    for (let idxP = 0; idxP < flowParas.length; idxP++) {
      const fp = flowParas[idxP];
      if (fp.rowBaselines.length >= 2) {
        const steps: number[] = [];
        for (let b = 1; b < fp.rowBaselines.length; b++) {
          const s = fp.rowBaselines[b] - fp.rowBaselines[b - 1];
          if (s >= fp.fontSizePt * 1.02 && s <= fp.fontSizePt * 1.75) {
            steps.push(s);
          }
        }
        if (steps.length > 0) {
          steps.sort((a, b) => a - b);
          const medStep = steps[Math.floor(steps.length / 2)];
          fp.linePitchPt = Math.max(fp.fontSizePt * 1.12, Math.min(fp.fontSizePt * 1.62, medStep));
        }
      }
      if (fp.leadingIcon) {
        fp.linePitchPt = Math.max(fp.linePitchPt, fp.leadingIcon.heightPt + 2);
      }

      if (fp.isBulletSymbol && !suppressTabStops && (fp.hangingTargetX !== undefined || defaultBulletHangPt > 0)) {
        const hangPt = fp.hangingTargetX
          ? Math.max(6, Math.min(34, fp.hangingTargetX - fp.firstRow.x0))
          : defaultBulletHangPt;
        const bulletLeftPt = Math.max(0, fp.firstRow.x0 - contentLeft) + hangPt;
        fp.leftIndentTwips = Math.round(bulletLeftPt * PT_TO_TWIPS);
        fp.hangingTwips = Math.round(hangPt * PT_TO_TWIPS);
        fp.firstLineTwips = 0;
        if (fp.runs.length > 0 && /^([•●◦▪])\s*$/.test(fp.runs[0].text)) {
          fp.runs[0] = { ...fp.runs[0], text: fp.runs[0].text.trimEnd() };
          if (fp.runs[1] && /^\s+/.test(fp.runs[1].text)) {
            fp.runs[1] = { ...fp.runs[1], text: fp.runs[1].text.replace(/^\s+/, '') };
          }
          fp.runs.splice(1, 0, {
            text: '\t',
            fontSizePt: fp.runs[0].fontSizePt,
            fontFamily: 'Calibri',
            bold: false,
            italic: false,
            colorHex: '334155',
          });
        } else if (fp.runs.length > 0 && /^([•●◦▪])\s+/.test(fp.runs[0].text)) {
          const m = fp.runs[0].text.match(/^([•●◦▪])\s+([\s\S]*)$/);
          if (m) {
            const firstRun = fp.runs[0];
            const replacementRuns: TextRun[] = [
              { ...firstRun, text: m[1] },
              {
                text: '\t',
                fontSizePt: firstRun.fontSizePt,
                fontFamily: 'Calibri',
                bold: false,
                italic: false,
                colorHex: '334155',
              },
            ];
            if (m[2]) replacementRuns.push({ ...firstRun, text: m[2] });
            fp.runs.splice(0, 1, ...replacementRuns);
          }
        }
      } else if (fp.hangingTargetX && !suppressTabStops) {
        const hangPt = Math.max(8, Math.min(36, fp.hangingTargetX - fp.firstRow.x0));
        fp.leftIndentTwips = Math.round((Math.max(0, fp.firstRow.x0 - contentLeft) + hangPt) * PT_TO_TWIPS);
        fp.hangingTwips = Math.round(hangPt * PT_TO_TWIPS);
        fp.firstLineTwips = 0;
      }

      if (idxP > 0 && !suppressTabStops) {
        const prev = flowParas[idxP - 1];
        const actualStep = fp.firstRow.baselineY - prev.lastRow.baselineY;
        const expectedStep = 0.22 * prev.linePitchPt + 0.78 * fp.linePitchPt + prev.spaceAfterPt;
        const beforePt = Math.max(0, Math.min(36, actualStep - expectedStep));
        fp.spaceBeforeTwips = Math.round(beforePt * PT_TO_TWIPS);
      } else if (idxP > 0) {
        const prev = flowParas[idxP - 1];
        const dyCell = Math.max(0, fp.firstRow.y0 - prev.lastRow.y1 - defaultGapPt * 0.4);
        fp.spaceBeforeTwips = Math.round(Math.min(12, dyCell) * PT_TO_TWIPS);
      }
    }

    for (const fp of flowParas) {
      const pBdrParts: string[] = [];
      if (fp.topBorder) {
        pBdrParts.push(
          `<w:top w:val="single" w:sz="${fp.topBorder.sizeEighths}" w:space="4" w:color="${fp.topBorder.colorHex}"/>`
        );
      }
      if (fp.leftBorder) {
        const boxPadPt =
          fp.calloutX0 !== undefined
            ? Math.max(4, Math.min(10, Math.round(fp.firstRow.x0 - fp.calloutX0)))
            : 6;
        if (fp.leftIndentTwips === 0) {
          fp.leftIndentTwips = Math.max(80, Math.round((fp.firstRow.x0 - contentLeft) * PT_TO_TWIPS) || 120);
        }
        pBdrParts.push(
          `<w:left w:val="single" w:sz="${fp.leftBorder.sizeEighths}" w:space="${boxPadPt}" w:color="${fp.leftBorder.colorHex}"/>`
        );
      }
      if (fp.bottomBorder) {
        pBdrParts.push(
          `<w:bottom w:val="single" w:sz="${fp.bottomBorder.sizeEighths}" w:space="4" w:color="${fp.bottomBorder.colorHex}"/>`
        );
      }
      const pBdrXml = pBdrParts.length > 0 ? `<w:pBdr>${pBdrParts.join('')}</w:pBdr>` : '';
      const shdXml = fp.shadingHex ? `<w:shd w:val="clear" w:color="auto" w:fill="${fp.shadingHex}"/>` : '';

      const indAttr =
        fp.leftIndentTwips > 0 || fp.firstLineTwips > 0 || fp.hangingTwips > 0
          ? `<w:ind${fp.leftIndentTwips > 0 ? ` w:left="${fp.leftIndentTwips}"` : ''}${
              fp.hangingTwips > 0
                ? ` w:hanging="${fp.hangingTwips}"`
                : fp.firstLineTwips > 0
                ? ` w:firstLine="${fp.firstLineTwips}"`
                : ''
            }/>`
          : '';
      const tabsXml =
        fp.tabStops.length > 0
          ? `<w:tabs>${fp.tabStops
              .map((t) => `<w:tab w:val="${t.val}" w:pos="${t.pos}"/>`)
              .join('')}</w:tabs>`
          : '';
      const isH1 = !suppressTabStops && !fp.shadingHex && !fp.leftBorder && fp.firstSegFontPt >= bodyFontPt * 1.5 && fp.charCount <= 60;
      const isH2 =
        !suppressTabStops &&
        !isH1 &&
        !fp.shadingHex &&
        !fp.leftBorder &&
        fp.charCount <= 70 &&
        fp.boldCount >= 2 &&
        (fp.firstSegFontPt >= bodyFontPt * 1.18 || Boolean(fp.bottomBorder));
      const pStyleXml = isH1 ? '<w:pStyle w:val="Heading1"/>' : isH2 ? '<w:pStyle w:val="Heading2"/>' : '';

      const lineTwips = Math.max(200, Math.round(fp.linePitchPt * PT_TO_TWIPS));
      const spacingXml = suppressTabStops
        ? `<w:spacing w:before="${fp.spaceBeforeTwips}" w:after="${fp.spaceAfterTwips}" w:line="240" w:lineRule="auto"/>`
        : `<w:spacing w:before="${fp.spaceBeforeTwips}" w:after="${fp.spaceAfterTwips}" w:line="${lineTwips}" w:lineRule="exact"/>`;

      const iconXml = fp.leadingIcon
        ? `${imageDrawingXml(fp.leadingIcon, Math.min(26, fp.leadingIcon.widthPt), Math.min(26, fp.leadingIcon.heightPt))}<w:r><w:t xml:space="preserve"> </w:t></w:r>`
        : '';

      // Strictly obey ECMA-376 CT_PPr child order: pStyle -> pBdr -> shd -> tabs -> spacing -> ind -> jc
      outElements.push(
        `<w:p><w:pPr>${pStyleXml}${pBdrXml}${shdXml}${tabsXml}${spacingXml}${indAttr}<w:jc w:val="${fp.align}"/></w:pPr>${iconXml}${runsToXml(
          fp.runs,
          fp.shadingHex
        )}</w:p>`
      );
    }
  };

  if (suppressTabStops) {
    emitParagraphGroup(rows);
    return outElements;
  }

  // Detect borderless multi-column tabular runs (>=3 consecutive multi-segment aligned non-badge rows)
  let idx = 0;
  let normalBuffer: VisualRow[] = [];
  while (idx < rows.length) {
    const hasBadgeRow = (r: VisualRow) => r.segments.some((s) => s.runs.some((run) => run.badgeId !== undefined));
    if (rows[idx].segments.length >= 2 && !hasBadgeRow(rows[idx])) {
      let end = idx + 1;
      while (
        end < rows.length &&
        rows[end].segments.length >= 2 &&
        !hasBadgeRow(rows[end]) &&
        rows[end].y0 - rows[end - 1].y1 <= rows[end - 1].fontSizePt * 2.2
      ) {
        end++;
      }
      if (end - idx >= 3) {
        const subRows = rows.slice(idx, end);
        const lanes = findColumnLanes(subRows.flatMap((r) => r.segments), 14);
        if (lanes && lanes.length >= 3 && lanes.length <= 8) {
          if (normalBuffer.length > 0) {
            emitParagraphGroup(normalBuffer);
            normalBuffer = [];
          }
          outElements.push(buildBorderlessAlignedTableXml(subRows, lanes, bodyFontPt));
          idx = end;
          continue;
        }
      }
    }
    normalBuffer.push(rows[idx]);
    idx++;
  }
  if (normalBuffer.length > 0) {
    emitParagraphGroup(normalBuffer);
  }

  return outElements;
}

function buildTableXml(
  table: DetectedTable,
  cellRows: Map<string, VisualRow[]>,
  cellImages: Map<string, PageImageBlock[]>,
  bodyFontPt: number
): string {
  const numRows = table.rowBounds.length - 1;
  const numCols = table.colBounds.length - 1;
  const totalWidthTwips = Math.max(400, Math.round((table.x1 - table.x0) * PT_TO_TWIPS));
  const colWidthsTwips = Array.from({ length: numCols }, (_, c) =>
    Math.max(120, Math.round((table.colBounds[c + 1] - table.colBounds[c]) * PT_TO_TWIPS))
  );

  const covered = Array.from({ length: numRows }, () => Array<boolean>(numCols).fill(false));
  const vMergeStatus = Array.from({ length: numRows }, () =>
    Array<'none' | 'restart' | 'continue'>(numCols).fill('none')
  );

  if (table.kind === 'bordered') {
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        if (covered[r][c]) continue;
        const y0 = table.rowBounds[r];
        const y1 = table.rowBounds[r + 1];
        let spanC = 1;
        while (
          c + spanC < numCols &&
          !hasVerticalBorderAt(table.verticals, table.colBounds[c + spanC], y0, y1)
        ) {
          covered[r][c + spanC] = true;
          spanC++;
        }
      }
    }

    for (let r = 0; r < numRows - 1; r++) {
      for (let c = 0; c < numCols; c++) {
        if (covered[r][c] || covered[r + 1][c]) continue;
        let spanC = 1;
        while (c + spanC < numCols && covered[r][c + spanC]) spanC++;
        let nextSpanC = 1;
        while (c + nextSpanC < numCols && covered[r + 1][c + nextSpanC]) nextSpanC++;
        if (nextSpanC !== spanC) continue;
        const xStart = table.colBounds[c];
        const xEnd = table.colBounds[c + spanC];
        const hasBottomDivider = hasHorizontalBorderAt(
          table.horizontals,
          table.rowBounds[r + 1],
          xStart,
          xEnd
        );
        if (!hasBottomDivider) {
          if (vMergeStatus[r][c] === 'none') vMergeStatus[r][c] = 'restart';
          vMergeStatus[r + 1][c] = 'continue';
        }
      }
    }
  }

  const trXmlList: string[] = [];
  for (let r = 0; r < numRows; r++) {
    const rowH = Math.max(12, table.rowBounds[r + 1] - table.rowBounds[r]);
    const rowHTwips = Math.round(rowH * PT_TO_TWIPS);
    const tcXmlList: string[] = [];

    for (let c = 0; c < numCols; c++) {
      if (covered[r][c]) continue;
      let spanC = 1;
      while (c + spanC < numCols && covered[r][c + spanC]) spanC++;

      const cellW = colWidthsTwips.slice(c, c + spanC).reduce((s, w) => s + w, 0);
      const cellX0 = table.colBounds[c];
      const cellX1 = table.colBounds[c + spanC];
      const cellY0 = table.rowBounds[r];
      let rEnd = r;
      if (vMergeStatus[r][c] === 'restart') {
        while (rEnd + 1 < numRows && vMergeStatus[rEnd + 1][c] === 'continue') {
          rEnd++;
        }
      }
      const cellY1 = table.rowBounds[rEnd + 1];

      const rowsInCell: VisualRow[] = [];
      const imgsInCell: PageImageBlock[] = [];
      if (vMergeStatus[r][c] !== 'continue') {
        for (let rr = r; rr <= rEnd; rr++) {
          for (let cc = c; cc < c + spanC; cc++) {
            const key = `${rr}:${cc}`;
            const cr = cellRows.get(key);
            if (cr) rowsInCell.push(...cr);
            const ci = cellImages.get(key);
            if (ci) imgsInCell.push(...ci);
          }
        }
      }
      rowsInCell.sort((a, b) => a.y0 - b.y0);

      const cellParagraphs = renderVisualRowsToParagraphXml(
        rowsInCell,
        cellX0 + 3,
        cellX1 - 3,
        cellX0 + cellX1,
        bodyFontPt,
        bodyFontPt * 0.3,
        true
      );
      for (const img of imgsInCell) {
        const maxCellImgW = Math.max(24, cellX1 - cellX0 - 8);
        const maxCellImgH = Math.max(24, cellY1 - cellY0 - 6);
        cellParagraphs.push(`<w:p>${imageDrawingXml(img, maxCellImgW, maxCellImgH)}</w:p>`);
      }

      if (cellParagraphs.length === 0) {
        cellParagraphs.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>');
      }

      const cxMid = (cellX0 + cellX1) / 2;
      const cyMid = (cellY0 + cellY1) / 2;
      const cellFill = table.fills.find(
        (f) => cxMid >= f.x0 && cxMid <= f.x1 && cyMid >= f.y0 && cyMid <= f.y1
      );

      const gridSpanXml = spanC > 1 ? `<w:gridSpan w:val="${spanC}"/>` : '';
      const vMergeXml =
        vMergeStatus[r][c] === 'restart'
          ? '<w:vMerge w:val="restart"/>'
          : vMergeStatus[r][c] === 'continue'
          ? '<w:vMerge/>'
          : '';
      const shdXml = cellFill ? `<w:shd w:val="clear" w:color="auto" w:fill="${cellFill.fillHex}"/>` : '';

      let cellBorderXml = '';
      if (table.kind === 'three-line') {
        const hasTopRule = hasHorizontalBorderAt(table.horizontals, cellY0, cellX0, cellX1);
        const hasBotRule = hasHorizontalBorderAt(table.horizontals, cellY1, cellX0, cellX1);
        cellBorderXml = `<w:tcBorders>
          <w:top ${hasTopRule ? 'w:val="single" w:sz="8" w:color="334155"' : 'w:val="none"'}/>
          <w:left w:val="none"/>
          <w:bottom ${hasBotRule ? 'w:val="single" w:sz="8" w:color="334155"' : 'w:val="none"'}/>
          <w:right w:val="none"/>
        </w:tcBorders>`;
      }

      tcXmlList.push(
        `<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/>${gridSpanXml}${vMergeXml}${cellBorderXml}${shdXml}<w:vAlign w:val="center"/></w:tcPr>${cellParagraphs.join(
          ''
        )}</w:tc>`
      );
    }

    trXmlList.push(
      `<w:tr><w:trPr><w:trHeight w:val="${rowHTwips}" w:hRule="atLeast"/></w:trPr>${tcXmlList.join('')}</w:tr>`
    );
  }

  const bordersXml =
    table.kind === 'three-line'
      ? `<w:tblBorders>
        <w:top w:val="single" w:sz="10" w:space="0" w:color="1E293B"/>
        <w:left w:val="none"/>
        <w:bottom w:val="single" w:sz="10" w:space="0" w:color="1E293B"/>
        <w:right w:val="none"/>
        <w:insideH w:val="none"/>
        <w:insideV w:val="none"/>
      </w:tblBorders>`
      : `<w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="64748B"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="64748B"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="64748B"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="64748B"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="94A3B8"/>
      </w:tblBorders>`;

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="${totalWidthTwips}" w:type="dxa"/>
      <w:tblLayout w:type="fixed"/>
      ${bordersXml}
      <w:tblCellMar>
        <w:top w:w="50" w:type="dxa"/>
        <w:left w:w="80" w:type="dxa"/>
        <w:bottom w:w="50" w:type="dxa"/>
        <w:right w:w="80" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tblGrid>${colWidthsTwips.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
    ${trXmlList.join('')}
  </w:tbl>`;
}

function buildSectionPrXml(
  pageW: number,
  pageH: number,
  marginLeft: number,
  marginRight: number,
  marginTop: number,
  marginBottom: number
): string {
  const wTwips = Math.round(pageW * PT_TO_TWIPS);
  const hTwips = Math.round(pageH * PT_TO_TWIPS);
  const mL = Math.round(marginLeft * PT_TO_TWIPS);
  const mR = Math.round(marginRight * PT_TO_TWIPS);
  const mT = Math.round(marginTop * PT_TO_TWIPS);
  const mB = Math.round(marginBottom * PT_TO_TWIPS);
  const orient = pageW > pageH ? ' w:orient="landscape"' : '';
  return `<w:sectPr><w:pgSz w:w="${wTwips}" w:h="${hTwips}"${orient}/><w:pgMar w:top="${mT}" w:right="${mR}" w:bottom="${mB}" w:left="${mL}" w:header="240" w:footer="240" w:gutter="0"/></w:sectPr>`;
}

function injectPageBreakBefore(elementXml: string): string {
  if (elementXml.startsWith('<w:p><w:pPr>')) {
    const pStyleMatch = elementXml.match(/^<w:p><w:pPr>(<w:pStyle\b[^>]*\/>)/);
    if (pStyleMatch) {
      return elementXml.replace(
        `<w:p><w:pPr>${pStyleMatch[1]}`,
        `<w:p><w:pPr>${pStyleMatch[1]}<w:pageBreakBefore/>`
      );
    }
    return elementXml.replace('<w:p><w:pPr>', '<w:p><w:pPr><w:pageBreakBefore/>');
  }
  if (elementXml.startsWith('<w:p/>')) {
    return '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>';
  }
  if (elementXml.startsWith('<w:p>')) {
    return elementXml.replace('<w:p>', '<w:p><w:pPr><w:pageBreakBefore/></w:pPr>');
  }
  if (elementXml.startsWith('<w:tbl>')) {
    if (elementXml.includes('<w:tc>') && elementXml.includes('<w:p><w:pPr>')) {
      return elementXml.replace('<w:p><w:pPr>', '<w:p><w:pPr><w:pageBreakBefore/>');
    }
    if (elementXml.includes('<w:p>')) {
      return elementXml.replace('<w:p>', '<w:p><w:pPr><w:pageBreakBefore/></w:pPr>');
    }
  }
  return `<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>${elementXml}`;
}

export async function convertPdfToDocx(
  inputPdfPath: string,
  outDocxPath: string,
  options: PdfToDocxOptions = {}
): Promise<void> {
  const preservePageBreaks = options.preservePageBreaks ?? true;
  const preserveImages = options.preserveImages ?? true;
  const onProgress = options.onProgress;

  const pdfBytes = await fs.readFile(inputPdfPath);
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');

  try {
    if (doc.needsPassword() && !doc.authenticatePassword('')) {
      throw new Error('该 PDF 已加密受密码保护，暂无法直接转换，请先解密后再试');
    }

    const totalPages = doc.countPages();
    if (totalPages === 0) {
      throw new Error('PDF 文档不包含任何页面');
    }

    const mediaAssets: MediaAsset[] = [];
    const mediaBySha1 = new Map<string, MediaAsset>();
    let docPrCounter = 1;

    const registerMediaImage = async (rawBytes: Uint8Array): Promise<MediaAsset> => {
      const sha1 = crypto.createHash('sha1').update(rawBytes).digest('hex');
      const existing = mediaBySha1.get(sha1);
      if (existing) return existing;

      let finalBytes = rawBytes;
      let ext: 'png' | 'jpg' = 'png';
      let mime = 'image/png';
      try {
        const meta = await sharp(rawBytes).metadata();
        if (meta.format === 'jpeg') {
          ext = 'jpg';
          mime = 'image/jpeg';
        } else if (meta.format !== 'png') {
          finalBytes = Uint8Array.from(await sharp(rawBytes).png({ compressionLevel: 6 }).toBuffer());
        }
      } catch {
        ext = 'png';
        mime = 'image/png';
      }

      const idx = mediaAssets.length + 1;
      const asset: MediaAsset = {
        rId: `rIdImg${idx}`,
        target: `media/image${idx}.${ext}`,
        bytes: finalBytes,
        ext,
        mime,
      };
      mediaAssets.push(asset);
      mediaBySha1.set(sha1, asset);
      return asset;
    };

    interface PageOutput {
      elements: string[];
      pageW: number;
      pageH: number;
      marginLeft: number;
      marginRight: number;
      marginTop: number;
      marginBottom: number;
      forceBreakAfter: boolean;
      startsWithHeading: boolean;
    }

    const pageOutputs: PageOutput[] = [];
    const maxPages = Math.min(totalPages, 150);

    for (let pIdx = 0; pIdx < maxPages; pIdx++) {
      onProgress?.(
        22 + Math.round(((pIdx + 1) / maxPages) * 68),
        `正在智能解析第 ${pIdx + 1}/${maxPages} 页...`
      );

      const page = doc.loadPage(pIdx);
      const bounds = page.getBounds();
      const offX = bounds[0];
      const offY = bounds[1];
      const pageW = Math.max(200, Math.min(1600, bounds[2] - bounds[0]));
      const pageH = Math.max(200, Math.min(1800, bounds[3] - bounds[1]));

      let st: mupdf.StructuredText | undefined;
      try {
        const gfx = await collectPageGraphics(page, offX, offY, pageW, pageH, preserveImages);

        st = page.toStructuredText('preserve-spans');

        const rawLines: RawCharSpan[][] = [];
        let curLine: RawCharSpan[] | null = null;

        st.walk({
          beginLine() {
            curLine = [];
          },
          endLine() {
            if (curLine && curLine.length > 0) {
              rawLines.push(curLine);
            }
            curLine = null;
          },
          onChar(c, origin, font, size, quad, color) {
            if (!curLine || !c || c === '\u0000') return;
            const qx0 = Math.min(quad[0], quad[2], quad[4], quad[6]) - offX;
            const qx1 = Math.max(quad[0], quad[2], quad[4], quad[6]) - offX;
            const qy0 = Math.min(quad[1], quad[3], quad[5], quad[7]) - offY;
            const qy1 = Math.max(quad[1], quad[3], quad[5], quad[7]) - offY;
            const baselineDx = quad[2] - quad[0];
            const baselineDy = quad[3] - quad[1];
            const baselineLen = Math.hypot(baselineDx, baselineDy);
            const angled = baselineLen > 1 && Math.abs(baselineDy) / baselineLen > 0.28;

            const fontName = font?.getName?.() ?? '';
            const bold =
              Boolean(font?.isBold?.()) ||
              /bold|black|heavy|demi|semibold|medium/i.test(fontName);
            const italic =
              Boolean(font?.isItalic?.()) || /italic|oblique/i.test(fontName);

            curLine.push({
              x0: qx0,
              y0: qy0,
              x1: qx1,
              y1: qy1,
              baselineY: (origin?.[1] ?? qy1) - offY,
              ch: c,
              fontSizePt: Math.max(4.5, Math.min(96, size || 11)),
              fontFamily: normalizeFontFamily(fontName),
              bold,
              italic,
              colorHex: colorToHex(color),
              angled,
            });
          },
        });

        // Recover opacity/alpha-blended text colors from Device.fillText (since stext strips alpha)
        if (gfx.translucentTextHints.length > 0) {
          for (const line of rawLines) {
            for (const ch of line) {
              const cx = (ch.x0 + ch.x1) / 2;
              const cy = (ch.y0 + ch.y1) / 2;
              let matchedHex: string | null = null;
              let bestArea = Infinity;
              for (let hIdx = gfx.translucentTextHints.length - 1; hIdx >= 0; hIdx--) {
                const hint = gfx.translucentTextHints[hIdx];
                if (cx >= hint.x0 - 2.5 && cx <= hint.x1 + 2.5 && cy >= hint.y0 - 2.5 && cy <= hint.y1 + 2.5) {
                  const area = (hint.x1 - hint.x0) * (hint.y1 - hint.y0);
                  if (area <= bestArea) {
                    bestArea = area;
                    matchedHex = hint.effectiveHex;
                  }
                }
              }
              if (matchedHex) {
                ch.colorHex = matchedHex;
              }
            }
          }
        }

        // Strip diagonal / very light watermark chars on bare paper, while ALWAYS keeping white/light text on dark badges & banners!
        const flatChars = rawLines.flat();
        const darkHorizChars = flatChars.filter((c) => !c.angled && colorLuma(c.colorHex) < 205);
        const hasDarkOrImageBackdrop = (c: RawCharSpan): boolean => {
          const cx = (c.x0 + c.x1) / 2;
          const cy = (c.y0 + c.y1) / 2;
          return (
            gfx.fills.some(
              (f) => colorLuma(f.fillHex) < 210 && cx >= f.x0 - 2 && cx <= f.x1 + 2 && cy >= f.y0 - 2 && cy <= f.y1 + 2
            ) ||
            gfx.shapeBoxes.some(
              (sb) => sb.isColoredFill && cx >= sb.x0 - 2 && cx <= sb.x1 + 2 && cy >= sb.y0 - 2 && cy <= sb.y1 + 2
            ) ||
            gfx.pendingImages.some((im) => cx >= im.x0 && cx <= im.x1 && cy >= im.y0 && cy <= im.y1)
          );
        };
        const filteredLines =
          darkHorizChars.length >= 10
            ? rawLines
                .map((line) =>
                  line.filter(
                    (c) =>
                      !c.angled &&
                      !(colorLuma(c.colorHex) >= 224 && darkHorizChars.length >= 20 && !hasDarkOrImageBackdrop(c))
                  )
                )
                .filter((line) => line.length > 0)
            : rawLines.filter((line) => line.some((c) => !c.angled) || flatChars.length < 10);

        const filteredCharsFlat = filteredLines.flat().filter((c) => !c.angled);

        // Preliminary rows purely for table detection & available content width estimation
        const prelimRows = buildVisualRowsFromLines(filteredLines);
        const prelimSegments = prelimRows.flatMap((r) => r.segments);
        const approxLeft = prelimRows.length > 0 ? Math.min(...prelimRows.map((r) => r.x0)) : pageW * 0.08;
        const approxRight = prelimRows.length > 0 ? Math.max(...prelimRows.map((r) => r.x1)) : pageW * 0.92;
        const approxAvailW = Math.max(120, approxRight - approxLeft);

        // Detect bordered + three-line tables cleanly
        const detectedTables = detectAllTables(
          gfx.horizontals,
          gfx.verticals,
          gfx.fills,
          gfx.shapeBoxes,
          prelimSegments,
          pageW,
          pageH
        );

        const isInsideAnyTable = (box: ClipBox): boolean => {
          const cx = (box.x0 + box.x1) / 2;
          const cy = (box.y0 + box.y1) / 2;
          return detectedTables.some(
            (t) => cx >= t.x0 - 3 && cx <= t.x1 + 3 && cy >= t.y0 - 3 && cy <= t.y1 + 3
          );
        };

        const countCharsInside = (box: ClipBox): number => {
          let cnt = 0;
          for (const ch of filteredCharsFlat) {
            const cx = (ch.x0 + ch.x1) / 2;
            const cy = (ch.y0 + ch.y1) / 2;
            if (cx >= box.x0 - 2 && cx <= box.x1 + 2 && cy >= box.y0 - 2 && cy <= box.y1 + 2) {
              cnt++;
            }
          }
          return cnt;
        };

        // Classify non-table fills & stroke boxes into inline Badges vs Paragraph Shading Callouts
        const badgeBoxes: BadgeBox[] = [];
        const boxFills: FillRect[] = [];
        const consumedDecorationBoxes: ClipBox[] = [];
        let nextBadgeId = 1;

        for (const f of gfx.fills) {
          if (isInsideAnyTable(f)) continue;
          const charsIn = countCharsInside(f);
          if (charsIn <= 0) continue; // Keep non-text vector icons/logos intact for shape/icon extraction!
          const w = f.x1 - f.x0;
          const h = f.y1 - f.y0;
          if (h <= 30 && w < approxAvailW * 0.55 && charsIn <= 44) {
            badgeBoxes.push({
              badgeId: nextBadgeId++,
              x0: f.x0,
              y0: f.y0,
              x1: f.x1,
              y1: f.y1,
              fillHex: f.fillHex,
            });
            consumedDecorationBoxes.push(f);
          } else if (w >= Math.max(70, approxAvailW * 0.22) && charsIn >= 5) {
            boxFills.push(f);
            consumedDecorationBoxes.push(f);
          }
        }

        for (const sb of gfx.strokeBoxes) {
          if (isInsideAnyTable(sb)) continue;
          const charsIn = countCharsInside(sb);
          if (charsIn <= 0) continue;
          const w = sb.x1 - sb.x0;
          const h = sb.y1 - sb.y0;
          if (h <= 30 && w < approxAvailW * 0.55 && charsIn <= 44) {
            const matchBadge = badgeBoxes.find((b) => {
              const ix0 = Math.max(b.x0, sb.x0);
              const iy0 = Math.max(b.y0, sb.y0);
              const ix1 = Math.min(b.x1, sb.x1);
              const iy1 = Math.min(b.y1, sb.y1);
              if (ix1 <= ix0 || iy1 <= iy0) return false;
              const inter = (ix1 - ix0) * (iy1 - iy0);
              const minArea = Math.min((b.x1 - b.x0) * (b.y1 - b.y0), w * h);
              return inter >= minArea * 0.55;
            });
            if (matchBadge) {
              matchBadge.borderHex = sb.borderHex;
              matchBadge.x0 = Math.min(matchBadge.x0, sb.x0);
              matchBadge.y0 = Math.min(matchBadge.y0, sb.y0);
              matchBadge.x1 = Math.max(matchBadge.x1, sb.x1);
              matchBadge.y1 = Math.max(matchBadge.y1, sb.y1);
            } else {
              badgeBoxes.push({
                badgeId: nextBadgeId++,
                x0: sb.x0,
                y0: sb.y0,
                x1: sb.x1,
                y1: sb.y1,
                borderHex: sb.borderHex,
              });
            }
          }
          consumedDecorationBoxes.push(sb);
        }

        // Tag individual chars inside inline pill badges so every run carries its exact pill styling & boundary
        if (badgeBoxes.length > 0) {
          for (const line of filteredLines) {
            for (const ch of line) {
              const cx = (ch.x0 + ch.x1) / 2;
              const cy = (ch.y0 + ch.y1) / 2;
              let bestBadge: BadgeBox | null = null;
              let bestArea = Infinity;
              for (const b of badgeBoxes) {
                if (cx >= b.x0 - 1.5 && cx <= b.x1 + 1.5 && cy >= b.y0 - 1.5 && cy <= b.y1 + 1.5) {
                  const area = (b.x1 - b.x0) * (b.y1 - b.y0);
                  if (area < bestArea) {
                    bestArea = area;
                    bestBadge = b;
                  }
                }
              }
              if (bestBadge) {
                if (bestBadge.fillHex) ch.bgHex = bestBadge.fillHex;
                if (bestBadge.borderHex) ch.borderHex = bestBadge.borderHex;
                ch.badgeId = bestBadge.badgeId;
              }
            }
          }
        }

        const rawVisualRows = badgeBoxes.length > 0 ? buildVisualRowsFromLines(filteredLines) : prelimRows;
        // Strip standalone footer page numbers in multi-page documents so they don't pollute body paragraphs
        const initialVisualRows =
          maxPages >= 2
            ? rawVisualRows.filter((row) => {
                if (row.y0 < pageH - 52) return true;
                const rowText = row.segments.map((s) => s.plainText).join(' ').trim();
                if (rowText.length > 28) return true;
                return !/^(?:[-—–·\s]*\d{1,4}[-—–·\s]*|第\s*\d+\s*页(?:\s*[/／共]\s*(?:共?\s*\d+\s*页?|\d+))?|page\s+\d+(?:\s+of\s+\d+)?|\d+\s*[/／]\s*\d+)$/i.test(
                  rowText
                );
              })
            : rawVisualRows;
        const allSegments = initialVisualRows.flatMap((r) => r.segments);
        const totalTextChars = allSegments.reduce((s, seg) => s + seg.plainText.length, 0);

        // Register extracted raster images (preserving photos/scans; skipping uniform light page backdrops when overlaid with digital text)
        const pageImages: PageImageBlock[] = [];
        for (const item of gfx.pendingImages) {
          if (item.isLargeBackdropCandidate && totalTextChars >= 18) {
            if (await isUniformPaleImage(item.bytes)) continue;
            // Digital PDF with real foreground prose drawn over a full-bleed template backdrop
            if (gfx.fillTextCount >= 3 && totalTextChars >= 80) continue;
          }
          const asset = await registerMediaImage(item.bytes);
          pageImages.push({
            x0: item.x0,
            y0: item.y0,
            x1: item.x1,
            y1: item.y1,
            widthPt: item.x1 - item.x0,
            heightPt: item.y1 - item.y0,
            rId: asset.rId,
            target: asset.target,
            docPrId: docPrCounter++,
          });
        }

        // Capture non-table vector graphic / chart / seal / heading-icon clusters cleanly as PNG figures
        const figureSuppressedBoxes: ClipBox[] = [];
        if (preserveImages && gfx.shapeBoxes.length > 0) {
          const isCoveredByDecoration = (sb: ShapeBox): boolean => {
            const sbArea = Math.max(1, (sb.x1 - sb.x0) * (sb.y1 - sb.y0));
            return consumedDecorationBoxes.some((db) => {
              const ix0 = Math.max(sb.x0, db.x0 - 2);
              const iy0 = Math.max(sb.y0, db.y0 - 2);
              const ix1 = Math.min(sb.x1, db.x1 + 2);
              const iy1 = Math.min(sb.y1, db.y1 + 2);
              if (ix1 <= ix0 || iy1 <= iy0) return false;
              return (ix1 - ix0) * (iy1 - iy0) >= sbArea * 0.45;
            });
          };

          const nonTableShapes = gfx.shapeBoxes.filter(
            (sb) =>
              !detectedTables.some(
                (t) => sb.x0 >= t.x0 - 4 && sb.x1 <= t.x1 + 4 && sb.y0 >= t.y0 - 4 && sb.y1 <= t.y1 + 4
              ) && !isCoveredByDecoration(sb)
          );
          // Merge close vector shapes into graphic figure clusters
          const clusters: Array<ClipBox & { curves: number; colorFills: number; count: number }> = [];
          for (const sb of nonTableShapes) {
            const pad = 10;
            const hit = clusters.find(
              (c) => sb.x0 <= c.x1 + pad && sb.x1 >= c.x0 - pad && sb.y0 <= c.y1 + pad && sb.y1 >= c.y0 - pad
            );
            if (hit) {
              hit.x0 = Math.min(hit.x0, sb.x0);
              hit.y0 = Math.min(hit.y0, sb.y0);
              hit.x1 = Math.max(hit.x1, sb.x1);
              hit.y1 = Math.max(hit.y1, sb.y1);
              if (sb.hasCurve) hit.curves++;
              if (sb.isColoredFill) hit.colorFills++;
              hit.count++;
            } else {
              clusters.push({
                x0: sb.x0,
                y0: sb.y0,
                x1: sb.x1,
                y1: sb.y1,
                curves: sb.hasCurve ? 1 : 0,
                colorFills: sb.isColoredFill ? 1 : 0,
                count: 1,
              });
            }
          }

          for (const cl of clusters) {
            const cw = cl.x1 - cl.x0;
            const ch = cl.y1 - cl.y0;
            if (cw >= pageW * 0.85 && ch >= pageH * 0.85) continue;

            const segsInside = allSegments.filter((s) => {
              const mx = (s.x0 + s.x1) / 2;
              const my = (s.y0 + s.y1) / 2;
              return mx >= cl.x0 && mx <= cl.x1 && my >= cl.y0 && my <= cl.y1;
            });
            const charsInside = segsInside.reduce((s, x) => s + x.plainText.length, 0);
            const isSmallIcon =
              charsInside === 0 &&
              cw >= 10 &&
              cw <= 34 &&
              ch >= 10 &&
              ch <= 34 &&
              (cl.curves >= 1 || cl.colorFills >= 1 || cl.count >= 2);
            if (!isSmallIcon && (cw < 26 || ch < 22)) continue;

            // Skip plain border/background or rounded-corner container cards wrapping editable text paragraphs
            const isTextCalloutBox = charsInside >= 24 && cl.curves === 0 && cl.colorFills <= 2;
            const isRoundedTextCard =
              charsInside >= 20 &&
              (cl.count <= 4 || (segsInside.length >= 4 && charsInside / Math.max(1, cl.curves + cl.colorFills) >= 7));
            if (isTextCalloutBox || isRoundedTextCard) continue;

            // Only render clusters that actually look like a figure/chart/logo/seal/icon
            if (!isSmallIcon && cl.curves === 0 && cl.colorFills <= 1 && charsInside > 10) continue;

            const cropBox: ClipBox = {
              x0: Math.max(0, cl.x0 - (isSmallIcon ? 1.5 : 3)),
              y0: Math.max(0, cl.y0 - (isSmallIcon ? 1.5 : 3)),
              x1: Math.min(pageW, cl.x1 + (isSmallIcon ? 1.5 : 3)),
              y1: Math.min(pageH, cl.y1 + (isSmallIcon ? 1.5 : 3)),
            };
            const alreadyCoveredByBitmap = pageImages.some(
              (im) => im.x0 <= cl.x0 + 8 && im.x1 >= cl.x1 - 8 && im.y0 <= cl.y0 + 8 && im.y1 >= cl.y1 - 8
            );
            if (alreadyCoveredByBitmap) continue;

            const figPng = await renderPageRegionPng(page, offX, offY, cropBox, isSmallIcon ? 300 : 200);
            const asset = await registerMediaImage(figPng);
            pageImages.push({
              x0: cropBox.x0,
              y0: cropBox.y0,
              x1: cropBox.x1,
              y1: cropBox.y1,
              widthPt: cropBox.x1 - cropBox.x0,
              heightPt: cropBox.y1 - cropBox.y0,
              rId: asset.rId,
              target: asset.target,
              docPrId: docPrCounter++,
            });
            if (charsInside > 0) {
              figureSuppressedBoxes.push(cropBox);
            }
          }
        }

        // Remove chart internal tick/axis micro-labels already captured inside rasterized vector figures
        const visualRows: VisualRow[] = [];
        for (const r of initialVisualRows) {
          const kept = r.segments.filter(
            (seg) =>
              !figureSuppressedBoxes.some((fb) => {
                const mx = (seg.x0 + seg.x1) / 2;
                const my = (seg.y0 + seg.y1) / 2;
                return mx >= fb.x0 && mx <= fb.x1 && my >= fb.y0 && my <= fb.y1;
              })
          );
          if (kept.length > 0) {
            visualRows.push({
              ...r,
              x0: Math.min(...kept.map((s) => s.x0)),
              x1: Math.max(...kept.map((s) => s.x1)),
              segments: kept,
            });
          }
        }

        // Fallback rasterization if page has zero extracted text and zero images (outlined vector artwork / pure scan)
        if (visualRows.length === 0 && pageImages.length === 0 && (gfx.totalVectorOps > 0 || !preserveImages)) {
          let pix: mupdf.Pixmap | undefined;
          try {
            const scale = Math.min(180 / 72, 1800 / Math.max(pageW, pageH));
            pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
            const asset = await registerMediaImage(Uint8Array.from(pix.asPNG()));
            pageImages.push({
              x0: 0,
              y0: 0,
              x1: pageW,
              y1: pageH,
              widthPt: pageW,
              heightPt: pageH,
              rId: asset.rId,
              target: asset.target,
              docPrId: docPrCounter++,
            });
          } finally {
            pix?.destroy();
          }
        }

        // Compute content bounds & dominant body font size
        let minContentX = pageW * 0.1;
        let maxContentX = pageW * 0.9;
        let minContentY = pageH * 0.08;
        let maxContentY = pageH * 0.92;
        if (visualRows.length > 0 || detectedTables.length > 0 || pageImages.length > 0) {
          const lefts = [
            ...visualRows.map((r) => r.x0),
            ...detectedTables.map((t) => t.x0),
            ...pageImages.map((im) => im.x0),
            ...boxFills.map((b) => b.x0),
          ];
          const rights = [
            ...visualRows.map((r) => r.x1),
            ...detectedTables.map((t) => t.x1),
            ...pageImages.map((im) => im.x1),
            ...boxFills.map((b) => b.x1),
          ];
          const tops = [
            ...visualRows.map((r) => r.y0),
            ...detectedTables.map((t) => t.y0),
            ...pageImages.map((im) => im.y0),
          ];
          const bottoms = [
            ...visualRows.map((r) => r.y1),
            ...detectedTables.map((t) => t.y1),
            ...pageImages.map((im) => im.y1),
          ];
          minContentX = Math.max(16, Math.min(...lefts));
          maxContentX = Math.min(pageW - 16, Math.max(...rights));
          minContentY = Math.max(16, Math.min(...tops));
          maxContentY = Math.min(pageH - 16, Math.max(...bottoms));
        }

        const marginLeft = Math.max(16, Math.min(68, Math.floor(minContentX) - 2));
        const marginRight = Math.max(16, Math.min(68, Math.floor(pageW - maxContentX) - 2));
        const marginTop = Math.max(16, Math.min(68, Math.floor(minContentY) - 1));
        const marginBottom = Math.max(16, Math.min(68, Math.floor(pageH - maxContentY) - 1));
        const maxDrawW = Math.max(120, pageW - marginLeft - marginRight - 4);
        const maxDrawH = Math.max(160, pageH - marginTop - marginBottom - 16);

        // Dominant body font size
        const fontBuckets = new Map<number, number>();
        for (const r of visualRows) {
          for (const seg of r.segments) {
            const bucket = Math.round(seg.fontSizePt * 2) / 2;
            fontBuckets.set(bucket, (fontBuckets.get(bucket) ?? 0) + seg.plainText.length);
          }
        }
        let bodyFontPt = 10.5;
        let bestWeight = -1;
        for (const [sz, wt] of fontBuckets.entries()) {
          if (wt > bestWeight) {
            bestWeight = wt;
            bodyFontPt = sz;
          }
        }

        const gaps: number[] = [];
        for (let i = 1; i < visualRows.length; i++) {
          const g = visualRows[i].y0 - visualRows[i - 1].y1;
          if (g >= 0 && g <= bodyFontPt * 1.2) gaps.push(g);
        }
        gaps.sort((a, b) => a - b);
        const defaultGapPt = gaps.length > 0 ? gaps[Math.floor(gaps.length * 0.5)] : bodyFontPt * 0.3;

        // Partition segments and images into detected tables vs free flow
        const tableCellRows = detectedTables.map(() => new Map<string, VisualRow[]>());
        const tableCellImages = detectedTables.map(() => new Map<string, PageImageBlock[]>());
        const freeRows: VisualRow[] = [];
        const freeImages: PageImageBlock[] = [];

        const findTableCell = (x: number, y: number): { tIdx: number; r: number; c: number } | null => {
          for (let tIdx = 0; tIdx < detectedTables.length; tIdx++) {
            const t = detectedTables[tIdx];
            if (x < t.x0 - 3 || x > t.x1 + 3 || y < t.y0 - 3 || y > t.y1 + 3) continue;
            let r = t.rowBounds.findIndex((_, idx) => idx < t.rowBounds.length - 1 && y <= t.rowBounds[idx + 1] + 2);
            if (r < 0) r = t.rowBounds.length - 2;
            let c = t.colBounds.findIndex((_, idx) => idx < t.colBounds.length - 1 && x <= t.colBounds[idx + 1] + 2);
            if (c < 0) c = t.colBounds.length - 2;
            if (r >= 0 && c >= 0) return { tIdx, r, c };
          }
          return null;
        };

        for (const row of visualRows) {
          const segsOutside: VisualSegment[] = [];
          for (const seg of row.segments) {
            const cx = (seg.x0 + seg.x1) / 2;
            const cy = (seg.y0 + seg.y1) / 2;
            const hit = findTableCell(cx, cy);
            if (hit) {
              const key = `${hit.r}:${hit.c}`;
              const bucket = tableCellRows[hit.tIdx].get(key) ?? [];
              const existingRow = bucket.find(
                (er) => Math.abs(er.baselineY - seg.baselineY) <= Math.max(4, seg.fontSizePt * 0.45)
              );
              if (existingRow) {
                existingRow.segments.push(seg);
                existingRow.x0 = Math.min(existingRow.x0, seg.x0);
                existingRow.y0 = Math.min(existingRow.y0, seg.y0);
                existingRow.x1 = Math.max(existingRow.x1, seg.x1);
                existingRow.y1 = Math.max(existingRow.y1, seg.y1);
                existingRow.segments.sort((a, b) => a.x0 - b.x0);
              } else {
                bucket.push({
                  x0: seg.x0,
                  y0: seg.y0,
                  x1: seg.x1,
                  y1: seg.y1,
                  baselineY: seg.baselineY,
                  fontSizePt: seg.fontSizePt,
                  segments: [seg],
                });
                tableCellRows[hit.tIdx].set(key, bucket);
              }
            } else {
              segsOutside.push(seg);
            }
          }
          if (segsOutside.length > 0) {
            freeRows.push({
              ...row,
              x0: Math.min(...segsOutside.map((s) => s.x0)),
              x1: Math.max(...segsOutside.map((s) => s.x1)),
              segments: segsOutside,
            });
          }
        }

        for (const img of pageImages) {
          const cx = (img.x0 + img.x1) / 2;
          const cy = (img.y0 + img.y1) / 2;
          const hit = findTableCell(cx, cy);
          if (hit) {
            const key = `${hit.r}:${hit.c}`;
            const list = tableCellImages[hit.tIdx].get(key) ?? [];
            list.push(img);
            tableCellImages[hit.tIdx].set(key, list);
          } else {
            freeImages.push(img);
          }
        }

        // Attach background shading boxes, left vertical accent bars, horizontal rules, and small inline heading icons to freeRows
        const isInTableBounds = (x: number, y: number) =>
          detectedTables.some((t) => x >= t.x0 - 4 && x <= t.x1 + 4 && y >= t.y0 - 4 && y <= t.y1 + 4);

        for (const r of freeRows) {
          const rx = (r.x0 + r.x1) / 2;
          const ry = (r.y0 + r.y1) / 2;
          let matchedFill: FillRect | null = null;
          let bestArea = Infinity;
          for (const bf of boxFills) {
            if (r.x0 >= bf.x0 - 4 && r.x1 <= bf.x1 + 4 && ry >= bf.y0 - 3 && ry <= bf.y1 + 3) {
              const area = (bf.x1 - bf.x0) * (bf.y1 - bf.y0);
              if (area < bestArea) {
                bestArea = area;
                matchedFill = bf;
              }
            } else if (rx >= bf.x0 && rx <= bf.x1 && ry >= bf.y0 && ry <= bf.y1) {
              const area = (bf.x1 - bf.x0) * (bf.y1 - bf.y0);
              if (area < bestArea) {
                bestArea = area;
                matchedFill = bf;
              }
            }
          }
          if (matchedFill) {
            r.shadingHex = matchedFill.fillHex;
            r.calloutX0 = matchedFill.x0;
          }
        }

        for (const v of gfx.verticals) {
          const h = v.end - v.start;
          if (h < 14 || h > pageH * 0.55 || colorLuma(v.colorHex) >= 242) continue;
          if (isInTableBounds(v.coord, (v.start + v.end) / 2)) continue;
          const hasTextOnLeft = freeRows.some(
            (other) => other.y1 >= v.start && other.y0 <= v.end && other.x1 <= v.coord - 2
          );
          if (hasTextOnLeft) continue;
          const matchedRows = freeRows.filter(
            (r) =>
              Math.min(r.y1, v.end + 3) - Math.max(r.y0, v.start - 3) >= 4 &&
              r.x0 >= v.coord - 3 &&
              r.x0 - v.coord <= 24
          );
          if (matchedRows.length > 0) {
            const sizeEighths = Math.max(8, Math.min(48, Math.round(v.widthPt * 8)));
            for (const r of matchedRows) {
              r.leftBorder = { colorHex: v.colorHex, sizeEighths };
              r.calloutX0 = r.calloutX0 !== undefined ? Math.min(r.calloutX0, v.coord) : v.coord;
            }
          }
        }

        const freeAvailW = Math.max(100, maxContentX - minContentX);
        for (const h of gfx.horizontals) {
          const w = h.end - h.start;
          if (w < freeAvailW * 0.25 || colorLuma(h.colorHex) >= 242) continue;
          if (w >= pageW * 0.88 && (h.coord <= 36 || h.coord >= pageH - 36)) continue;
          if (isInTableBounds((h.start + h.end) / 2, h.coord)) continue;

          const overlapHoriz = (r: VisualRow) => Math.min(r.x1, h.end) - Math.max(r.x0, h.start) >= 12 || r.x0 >= h.start - 20;
          const aboveCands = freeRows
            .filter((r) => overlapHoriz(r) && h.coord - r.y1 >= -2 && h.coord - r.y1 <= 14)
            .sort((a, b) => b.y1 - a.y1);
          const belowCands = freeRows
            .filter((r) => overlapHoriz(r) && r.y0 - h.coord >= -2 && r.y0 - h.coord <= 16)
            .sort((a, b) => a.y0 - b.y0);

          const rowAbove = aboveCands[0];
          const rowBelow = belowCands[0];
          const sizeEighths = Math.max(4, Math.min(24, Math.round(h.widthPt * 8)));

          if (rowAbove && (!rowBelow || h.coord - rowAbove.y1 <= Math.min(12, rowBelow.y0 - h.coord + 3))) {
            rowAbove.bottomBorder = { colorHex: h.colorHex, sizeEighths };
          } else if (rowBelow) {
            rowBelow.topBorder = { colorHex: h.colorHex, sizeEighths };
          }
        }

        // Pair side-by-side image + text rows cleanly into borderless 2-column layout tables
        const consumedRowSet = new Set<VisualRow>();
        const consumedImgSet = new Set<PageImageBlock>();

        // Inline small heading / badge icons (<=28pt) directly into the start of their matching row
        for (const img of freeImages) {
          if (img.widthPt > 28 || img.heightPt > 28) continue;
          const alignedRows = freeRows.filter(
            (r) =>
              !r.leadingIcon &&
              r.y0 <= img.y1 + 6 &&
              r.y1 >= img.y0 - 6 &&
              r.x0 >= img.x1 - 3 &&
              r.x0 - img.x1 <= 24
          );
          if (alignedRows.length === 1) {
            const targetRow = alignedRows[0];
            if (targetRow.y1 - targetRow.y0 <= 32) {
              targetRow.leadingIcon = img;
              targetRow.x0 = Math.min(targetRow.x0, img.x0);
              consumedImgSet.add(img);
            }
          }
        }

        type FlowItem =
          | { kind: 'rows'; y0: number; rows: VisualRow[] }
          | { kind: 'table'; y0: number; tIdx: number }
          | { kind: 'image'; y0: number; img: PageImageBlock }
          | { kind: 'side-by-side'; y0: number; xml: string };

        const flowItems: FlowItem[] = [];

        for (const img of freeImages) {
          if (consumedImgSet.has(img)) continue;
          if (img.widthPt >= maxDrawW * 0.72) continue;
          const imgMidY0 = img.y0 - 6;
          const imgMidY1 = img.y1 + 6;
          const onLeftOfRows = freeRows.filter(
            (r) => !consumedRowSet.has(r) && r.y1 >= imgMidY0 && r.y0 <= imgMidY1 && r.x0 >= img.x1 + 8
          );
          const onRightOfRows = freeRows.filter(
            (r) => !consumedRowSet.has(r) && r.y1 >= imgMidY0 && r.y0 <= imgMidY1 && r.x1 <= img.x0 - 8
          );
          const mixedSide = freeRows.some(
            (r) => !consumedRowSet.has(r) && r.y1 >= imgMidY0 && r.y0 <= imgMidY1 && r.x0 < img.x1 && r.x1 > img.x0
          );
          if (mixedSide) continue;

          // Only pair short caption/card blocks next to image; don't slice continuous prose columns in half!
          const hasAdjacentColumnContinuation = (matched: VisualRow[]) => {
            if (matched.length === 0 || matched.length > 10) return true;
            const colX0 = Math.min(...matched.map((r) => r.x0));
            const colX1 = Math.max(...matched.map((r) => r.x1));
            const colY0 = Math.min(...matched.map((r) => r.y0));
            const colY1 = Math.max(...matched.map((r) => r.y1));
            return freeRows.some((r) => {
              if (consumedRowSet.has(r) || matched.includes(r)) return false;
              const xAligned = Math.abs(r.x0 - colX0) <= 14 && r.x1 > colX0 + 20 && r.x0 < colX1;
              const closeVert = (r.y1 <= colY0 && colY0 - r.y1 <= 24) || (r.y0 >= colY1 && r.y0 - colY1 <= 24);
              return xAligned && closeVert && r.segments.map((s) => s.plainText).join('').length >= 16;
            });
          };

          if (onLeftOfRows.length > 0 && onRightOfRows.length === 0 && !hasAdjacentColumnContinuation(onLeftOfRows)) {
            onLeftOfRows.forEach((r) => consumedRowSet.add(r));
            consumedImgSet.add(img);
            const rightXml = renderVisualRowsToParagraphXml(
              onLeftOfRows,
              img.x1 + 10,
              maxContentX,
              img.x1 + 10 + maxContentX,
              bodyFontPt,
              defaultGapPt,
              true
            );
            const leftXml = [
              `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>${imageDrawingXml(
                img,
                Math.min(img.widthPt, maxDrawW * 0.45),
                maxDrawH
              )}</w:p>`,
            ];
            flowItems.push({
              kind: 'side-by-side',
              y0: Math.min(img.y0, onLeftOfRows[0].y0),
              xml: buildSideBySideLayoutTableXml(
                leftXml,
                rightXml,
                Math.max(40, Math.min(img.widthPt + 12, maxDrawW * 0.45)),
                Math.max(100, maxDrawW - Math.min(img.widthPt + 12, maxDrawW * 0.45))
              ),
            });
          } else if (onRightOfRows.length > 0 && onLeftOfRows.length === 0 && !hasAdjacentColumnContinuation(onRightOfRows)) {
            onRightOfRows.forEach((r) => consumedRowSet.add(r));
            consumedImgSet.add(img);
            const leftXml = renderVisualRowsToParagraphXml(
              onRightOfRows,
              minContentX,
              img.x0 - 10,
              minContentX + img.x0 - 10,
              bodyFontPt,
              defaultGapPt,
              true
            );
            const rightXml = [
              `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>${imageDrawingXml(
                img,
                Math.min(img.widthPt, maxDrawW * 0.45),
                maxDrawH
              )}</w:p>`,
            ];
            flowItems.push({
              kind: 'side-by-side',
              y0: Math.min(img.y0, onRightOfRows[0].y0),
              xml: buildSideBySideLayoutTableXml(
                leftXml,
                rightXml,
                Math.max(100, maxDrawW - Math.min(img.widthPt + 12, maxDrawW * 0.45)),
                Math.max(40, Math.min(img.widthPt + 12, maxDrawW * 0.45))
              ),
            });
          }
        }

        // Also group 2..3 horizontally aligned side-by-side images into a single borderless row
        const remainingImgs = freeImages
          .filter((im) => !consumedImgSet.has(im))
          .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
        for (const baseImg of remainingImgs) {
          if (consumedImgSet.has(baseImg)) continue;
          const peerImgs = remainingImgs
            .filter(
              (cand) =>
                !consumedImgSet.has(cand) &&
                Math.abs(cand.y0 - baseImg.y0) <= 18 &&
                Math.min(cand.y1, baseImg.y1) - Math.max(cand.y0, baseImg.y0) >= Math.min(cand.heightPt, baseImg.heightPt) * 0.4
            )
            .sort((a, b) => a.x0 - b.x0);
          if (peerImgs.length >= 2 && peerImgs.length <= 3) {
            const nonOverlapping = peerImgs.every((im, k) => k === 0 || im.x0 >= peerImgs[k - 1].x1 - 4);
            const rowTextBlocking = freeRows.some(
              (r) => !consumedRowSet.has(r) && r.y1 >= peerImgs[0].y0 - 4 && r.y0 <= peerImgs[0].y1 + 4
            );
            if (nonOverlapping && !rowTextBlocking) {
              peerImgs.forEach((im) => consumedImgSet.add(im));
              const colW = Math.max(80, Math.floor((maxDrawW - 8) / peerImgs.length));
              const totalTwips = Math.round(maxDrawW * PT_TO_TWIPS);
              const cellWTwips = Math.round(colW * PT_TO_TWIPS);
              const gridCols = peerImgs.map(() => `<w:gridCol w:w="${cellWTwips}"/>`).join('');
              const tcs = peerImgs
                .map(
                  (im) =>
                    `<w:tc><w:tcPr><w:tcW w:w="${cellWTwips}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>${imageDrawingXml(
                      im,
                      colW - 10,
                      maxDrawH
                    )}</w:p></w:tc>`
                )
                .join('');
              const rowTbl = `<w:tbl><w:tblPr><w:tblW w:w="${totalTwips}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid><w:tr>${tcs}</w:tr></w:tbl>`;
              flowItems.push({ kind: 'side-by-side', y0: Math.min(...peerImgs.map((p) => p.y0)), xml: rowTbl });
            }
          }
        }

        for (const r of freeRows) {
          if (!consumedRowSet.has(r)) flowItems.push({ kind: 'rows', y0: r.y0, rows: [r] });
        }
        for (let tIdx = 0; tIdx < detectedTables.length; tIdx++) {
          flowItems.push({ kind: 'table', y0: detectedTables[tIdx].y0, tIdx });
        }
        for (const img of freeImages) {
          if (!consumedImgSet.has(img)) flowItems.push({ kind: 'image', y0: img.y0, img });
        }
        flowItems.sort((a, b) => a.y0 - b.y0);

        const groupedItems: FlowItem[] = [];
        for (const item of flowItems) {
          const prev = groupedItems[groupedItems.length - 1];
          if (item.kind === 'rows' && prev?.kind === 'rows') {
            prev.rows.push(...item.rows);
          } else {
            groupedItems.push(item);
          }
        }

        const elements: string[] = [];
        for (let gi = 0; gi < groupedItems.length; gi++) {
          const item = groupedItems[gi];
          if (item.kind === 'rows') {
            elements.push(
              ...renderVisualRowsToParagraphXml(
                item.rows,
                minContentX,
                maxContentX,
                pageW,
                bodyFontPt,
                defaultGapPt
              )
            );
          } else if (item.kind === 'table') {
            elements.push(
              buildTableXml(
                detectedTables[item.tIdx],
                tableCellRows[item.tIdx],
                tableCellImages[item.tIdx],
                bodyFontPt
              )
            );
            if (gi < groupedItems.length - 1) {
              elements.push('<w:p><w:pPr><w:spacing w:before="0" w:after="20" w:line="120" w:lineRule="exact"/></w:pPr></w:p>');
            }
          } else if (item.kind === 'side-by-side') {
            elements.push(item.xml);
          } else {
            elements.push(
              `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr>${imageDrawingXml(
                item.img,
                maxDrawW,
                maxDrawH
              )}</w:p>`
            );
          }
        }

        if (elements.length === 0) {
          elements.push('<w:p/>');
        }

        const bottomWhitespace = pageH - maxContentY;
        const startsWithHeading =
          elements[0].includes('w:val="Heading1"') || elements[0].includes('w:val="Heading2"');
        const forceBreakAfter =
          visualRows.length === 0 ||
          bottomWhitespace >= 95 ||
          (detectedTables.length > 0 && bottomWhitespace >= 55);

        pageOutputs.push({
          elements,
          pageW,
          pageH,
          marginLeft,
          marginRight,
          marginTop,
          marginBottom,
          forceBreakAfter,
          startsWithHeading,
        });
      } finally {
        st?.destroy();
        page.destroy();
      }
    }

    onProgress?.(92, '正在封装规范 DOCX 文档...');

    const bodyParts: string[] = [];
    for (let i = 0; i < pageOutputs.length; i++) {
      const po = pageOutputs[i];
      const elems = [...po.elements];

      if (i > 0) {
        const prev = pageOutputs[i - 1];
        const sameOrientation =
          Math.abs(prev.pageW - po.pageW) < 20 && Math.abs(prev.pageH - po.pageH) < 20;
        const shouldBreak = preservePageBreaks
          ? true
          : prev.forceBreakAfter || po.startsWithHeading;
        if (sameOrientation && shouldBreak && elems.length > 0) {
          elems[0] = injectPageBreakBefore(elems[0]);
        }
      }

      bodyParts.push(...elems);

      if (i < pageOutputs.length - 1) {
        const next = pageOutputs[i + 1];
        const sameOrientation =
          Math.abs(po.pageW - next.pageW) < 20 && Math.abs(po.pageH - next.pageH) < 20;
        if (!sameOrientation) {
          bodyParts.push(
            `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${buildSectionPrXml(
              po.pageW,
              po.pageH,
              po.marginLeft,
              po.marginRight,
              po.marginTop,
              po.marginBottom
            )}</w:pPr><w:r><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:r></w:p>`
          );
        }
      }
    }

    const lastPage = pageOutputs[pageOutputs.length - 1];
    const finalSectPr = buildSectionPrXml(
      lastPage.pageW,
      lastPage.pageH,
      lastPage.marginLeft,
      lastPage.marginRight,
      lastPage.marginTop,
      lastPage.marginBottom
    );

    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`
    );

    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    );

    const docRelsEntries = [
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
      `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`,
      ...mediaAssets.map(
        (m) =>
          `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`
      ),
    ];

    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${docRelsEntries.join('\n  ')}
</Relationships>`
    );

    zip.file(
      'word/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:eastAsia="微软雅黑" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="21"/>
        <w:szCs w:val="21"/>
        <w:color w:val="1E293B"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
</w:styles>`
    );

    zip.file(
      'word/settings.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="420"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word/2013/wordml" w:val="15"/>
  </w:compat>
</w:settings>`
    );

    for (const m of mediaAssets) {
      zip.file(`word/${m.target}`, m.bytes);
    }

    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${bodyParts.join('\n    ')}
    ${finalSectPr}
  </w:body>
</w:document>`
    );

    const outBuf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await fs.writeFile(outDocxPath, outBuf);
  } finally {
    doc.destroy();
  }
}
