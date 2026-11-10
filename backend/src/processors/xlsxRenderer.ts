import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, type PDFImage } from 'pdf-lib';
import sharp from 'sharp';
import * as XLSXNamespace from 'xlsx';
import { parseXmlTree } from './docxRenderer.js';

const XLSX: typeof XLSXNamespace =
  (XLSXNamespace as unknown as { default?: typeof XLSXNamespace }).default ?? XLSXNamespace;

const FONT_FAMILY = 'Noto Sans CJK SC, Microsoft YaHei, PingFang SC, SimHei, sans-serif';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

interface XlsxRenderOptions {
  landscape?: boolean | 'auto';
  fitToPage?: boolean;
  continuous?: boolean;
}

interface BorderEdge {
  width: number;
  color: string;
  double?: boolean;
}

interface CellBorders {
  top?: BorderEdge;
  bottom?: BorderEdge;
  left?: BorderEdge;
  right?: BorderEdge;
}

interface ResolvedCellStyle {
  fontSizePx: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  fill?: string;
  hAlign?: 'left' | 'center' | 'right';
  vAlign: 'top' | 'center' | 'bottom';
  wrapText: boolean;
  borders: CellBorders;
}

interface ExcelTextRun {
  text: string;
  fontSizePx: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
}

interface MergeRange {
  sr: number;
  sc: number;
  er: number;
  ec: number;
}

interface SheetDrawingAnchor {
  rId: string;
  fromRow: number;
  fromCol: number;
  fromRowOffPx: number;
  fromColOffPx: number;
  toRow?: number;
  toCol?: number;
  toRowOffPx?: number;
  toColOffPx?: number;
  extWPx?: number;
  extHPx?: number;
}

interface PreparedImage {
  pdfImage: PDFImage;
  naturalW: number;
  naturalH: number;
}

function escapeXml(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function localTag(tag: string): string {
  const idx = tag.indexOf(':');
  return idx === -1 ? tag : tag.slice(idx + 1);
}

function findChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  return node.children.find((c) => c.tag === name || localTag(c.tag) === name);
}

function findChildren(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.tag === name || localTag(c.tag) === name);
}

function findDescendant(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) {
    if (c.tag === name || localTag(c.tag) === name) return c;
    const hit = findDescendant(c, name);
    if (hit) return hit;
  }
  return undefined;
}

// Standard Office indexed color palette (common entries)
const INDEXED_COLORS: Record<number, string> = {
  0: '#000000',
  1: '#FFFFFF',
  2: '#FF0000',
  3: '#00FF00',
  4: '#0000FF',
  5: '#FFFF00',
  6: '#FF00FF',
  7: '#00FFFF',
  8: '#000000',
  9: '#FFFFFF',
  10: '#FF0000',
  11: '#00FF00',
  12: '#0000FF',
  13: '#FFFF00',
  14: '#FF00FF',
  15: '#00FFFF',
  22: '#C0C0C0',
  23: '#808080',
  64: '#1E293B',
};

const DEFAULT_THEME_COLORS: string[] = [
  '#FFFFFF', // 0: lt1
  '#000000', // 1: dk1
  '#E7E6E6', // 2: lt2
  '#44546A', // 3: dk2
  '#4472C4', // 4: accent1
  '#ED7D31', // 5: accent2
  '#A5A5A5', // 6: accent3
  '#FFC000', // 7: accent4
  '#5B9BD5', // 8: accent5
  '#70AD47', // 9: accent6
];

function applyTint(hex: string, tintStr: string | undefined): string {
  const tint = Number(tintStr);
  if (!tintStr || !Number.isFinite(tint) || tint === 0) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const adjust = (v: number) =>
    Math.max(0, Math.min(255, Math.round(tint > 0 ? v + (255 - v) * tint : v * (1 + tint))));
  const toHex = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(adjust(r))}${toHex(adjust(g))}${toHex(adjust(b))}`;
}

function parseThemePalette(themeXml: string | undefined): string[] {
  const palette = [...DEFAULT_THEME_COLORS];
  if (!themeXml) return palette;
  const root = parseXmlTree(themeXml);
  const clrScheme = findDescendant(root, 'clrScheme');
  if (!clrScheme) return palette;

  // Excel maps theme 0->lt1, 1->dk1, 2->lt2, 3->dk2, 4..9->accent1..6
  const slotNames = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
  slotNames.forEach((slot, idx) => {
    const el = findChild(clrScheme, slot);
    if (!el) return;
    const srgb = findChild(el, 'srgbClr')?.attrs.val;
    const sys = findChild(el, 'sysClr')?.attrs.lastClr;
    const raw = srgb || sys;
    if (raw && /^[0-9a-fA-F]{6}$/.test(raw)) {
      palette[idx] = `#${raw.toUpperCase()}`;
    }
  });
  return palette;
}

function resolveColorNode(
  colorNode: XmlNode | undefined,
  themePalette: string[],
  fallback: string
): string {
  if (!colorNode) return fallback;
  if (colorNode.attrs.auto === '1') return fallback;
  if (colorNode.attrs.rgb) {
    const clean = colorNode.attrs.rgb.replace('#', '').trim();
    const hex = clean.length === 8 ? clean.slice(2) : clean;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return applyTint(`#${hex.toUpperCase()}`, colorNode.attrs.tint);
    }
  }
  if (colorNode.attrs.theme !== undefined) {
    const idx = Number(colorNode.attrs.theme);
    if (Number.isInteger(idx) && themePalette[idx]) {
      return applyTint(themePalette[idx], colorNode.attrs.tint);
    }
  }
  if (colorNode.attrs.indexed !== undefined) {
    const idx = Number(colorNode.attrs.indexed);
    if (INDEXED_COLORS[idx]) {
      return applyTint(INDEXED_COLORS[idx], colorNode.attrs.tint);
    }
  }
  return fallback;
}

function mapExcelFontFamily(rawName: string | undefined): string {
  const name = rawName?.trim();
  if (!name) return FONT_FAMILY;
  const safe = name.replace(/["'<>]/g, '');
  if (/方正仿宋|仿宋|FangSong/i.test(safe)) {
    return `'${safe}', 'FangSong', '仿宋', 'STFangsong', 'SimSun', 'Noto Serif CJK SC', ${FONT_FAMILY}`;
  }
  if (/方正小标宋|小标宋|宋体|SimSun|NSimSun/i.test(safe)) {
    return `'${safe}', 'SimSun', '宋体', 'NSimSun', 'Noto Serif CJK SC', ${FONT_FAMILY}`;
  }
  if (/楷体|KaiTi/i.test(safe)) {
    return `'${safe}', 'KaiTi', '楷体', 'STKaiti', 'Noto Serif CJK SC', ${FONT_FAMILY}`;
  }
  if (/黑体|SimHei/i.test(safe)) {
    return `'${safe}', 'SimHei', '黑体', ${FONT_FAMILY}`;
  }
  if (/微软雅黑|Microsoft YaHei/i.test(safe)) {
    return `'Microsoft YaHei', ${FONT_FAMILY}`;
  }
  return `'${safe}', ${FONT_FAMILY}`;
}

interface SharedStringEntry {
  text: string;
  richRuns?: Array<{
    text: string;
    fontSizePx?: number;
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: string;
  }>;
}

function parseRichTextContainer(
  containerNode: XmlNode,
  themePalette: string[]
): SharedStringEntry {
  const rNodes = findChildren(containerNode, 'r');
  if (rNodes.length === 0) {
    // Only read direct <t> children so phonetic <rPh> guides are never concatenated
    const text = findChildren(containerNode, 't')
      .map((t) => t.text)
      .join('');
    return { text };
  }

  const richRuns: NonNullable<SharedStringEntry['richRuns']> = [];
  const parts: string[] = [];
  for (const rNode of rNodes) {
    const rPr = findChild(rNode, 'rPr');
    const tText = findChildren(rNode, 't')
      .map((t) => t.text)
      .join('');
    if (!tText) continue;
    parts.push(tText);

    const szRaw = findChild(rPr, 'sz')?.attrs.val;
    const szNum = szRaw ? Number(szRaw) : NaN;
    const rFont = findChild(rPr, 'rFont')?.attrs.val || findChild(rPr, 'name')?.attrs.val;
    const bNode = findChild(rPr, 'b');
    const iNode = findChild(rPr, 'i');
    const uNode = findChild(rPr, 'u');
    const colorNode = findChild(rPr, 'color');

    richRuns.push({
      text: tText,
      fontSizePx: Number.isFinite(szNum) && szNum > 0 ? Math.max(9.5, szNum * (4 / 3)) : undefined,
      fontFamily: rFont ? mapExcelFontFamily(rFont) : undefined,
      bold: bNode ? bNode.attrs.val !== '0' && bNode.attrs.val !== 'false' : undefined,
      italic: iNode ? iNode.attrs.val !== '0' && iNode.attrs.val !== 'false' : undefined,
      underline: uNode ? uNode.attrs.val !== 'none' && uNode.attrs.val !== '0' : undefined,
      color: colorNode ? resolveColorNode(colorNode, themePalette, '#1E293B') : undefined,
    });
  }

  return {
    text: parts.join(''),
    richRuns: richRuns.length > 0 ? richRuns : undefined,
  };
}

function parseSharedStrings(ssXml: string | undefined, themePalette: string[]): SharedStringEntry[] {
  if (!ssXml) return [];
  const root = parseXmlTree(ssXml);
  return findChildren(root, 'si').map((si) => parseRichTextContainer(si, themePalette));
}

function parseExcelStyles(stylesXml: string | undefined, themePalette: string[]): ResolvedCellStyle[] {
  const defaultStyle: ResolvedCellStyle = {
    fontSizePx: 14,
    fontFamily: FONT_FAMILY,
    bold: false,
    italic: false,
    underline: false,
    color: '#1E293B',
    vAlign: 'center',
    wrapText: false,
    borders: {},
  };
  if (!stylesXml) return [defaultStyle];

  const root = parseXmlTree(stylesXml);
  const fontsNode = findChild(root, 'fonts');
  const fillsNode = findChild(root, 'fills');
  const bordersNode = findChild(root, 'borders');
  const cellXfsNode = findChild(root, 'cellXfs');

  const fonts = findChildren(fontsNode, 'font').map((fn) => {
    const szVal = Number(findChild(fn, 'sz')?.attrs.val || 11);
    const bNode = findChild(fn, 'b');
    const iNode = findChild(fn, 'i');
    const uNode = findChild(fn, 'u');
    const fontName = findChild(fn, 'name')?.attrs.val;
    return {
      fontSizePx: Math.max(9.5, (Number.isFinite(szVal) ? szVal : 11) * (4 / 3)),
      fontFamily: mapExcelFontFamily(fontName),
      bold: Boolean(bNode && bNode.attrs.val !== '0' && bNode.attrs.val !== 'false'),
      italic: Boolean(iNode && iNode.attrs.val !== '0' && iNode.attrs.val !== 'false'),
      underline: Boolean(uNode && uNode.attrs.val !== 'none' && uNode.attrs.val !== '0'),
      color: resolveColorNode(findChild(fn, 'color'), themePalette, '#1E293B'),
    };
  });

  const fills = findChildren(fillsNode, 'fill').map((fl) => {
    const pf = findChild(fl, 'patternFill');
    const patternType = pf?.attrs.patternType;
    if (!pf || patternType !== 'solid') return undefined;
    const fg = findChild(pf, 'fgColor');
    const color = resolveColorNode(fg, themePalette, '');
    return color && color !== '#FFFFFF' ? color : undefined;
  });

  const parseEdge = (edgeNode: XmlNode | undefined): BorderEdge | undefined => {
    if (!edgeNode) return undefined;
    const style = edgeNode.attrs.style;
    if (!style || style === 'none') return undefined;
    const width =
      style === 'thick' ? 2.2 : style === 'medium' || style === 'mediumDashed' ? 1.5 : style === 'hair' ? 0.55 : 0.85;
    const color = resolveColorNode(findChild(edgeNode, 'color'), themePalette, '#1E293B');
    return { width, color, double: style === 'double' };
  };

  const borders = findChildren(bordersNode, 'border').map((bd) => ({
    top: parseEdge(findChild(bd, 'top')),
    bottom: parseEdge(findChild(bd, 'bottom')),
    left: parseEdge(findChild(bd, 'left')),
    right: parseEdge(findChild(bd, 'right')),
  }));

  const xfs = findChildren(cellXfsNode, 'xf').map((xf) => {
    const fId = Number(xf.attrs.fontId || 0);
    const fillId = Number(xf.attrs.fillId || 0);
    const bdId = Number(xf.attrs.borderId || 0);
    const align = findChild(xf, 'alignment');
    const font = fonts[fId] || fonts[0] || defaultStyle;
    const hRaw = align?.attrs.horizontal;
    const vRaw = align?.attrs.vertical;
    const hAlign: 'left' | 'center' | 'right' | undefined =
      hRaw === 'center' || hRaw === 'centerContinuous'
        ? 'center'
        : hRaw === 'right'
        ? 'right'
        : hRaw === 'left'
        ? 'left'
        : undefined;
    const vAlign: 'top' | 'center' | 'bottom' =
      vRaw === 'top' ? 'top' : vRaw === 'bottom' ? 'bottom' : 'center';
    const wrapText = align?.attrs.wrapText === '1' || align?.attrs.wrapText === 'true';

    return {
      fontSizePx: font.fontSizePx,
      fontFamily: font.fontFamily,
      bold: font.bold,
      italic: font.italic,
      underline: font.underline,
      color: font.color,
      fill: fills[fillId],
      hAlign,
      vAlign,
      wrapText,
      borders: borders[bdId] || {},
    };
  });

  return xfs.length > 0 ? xfs : [defaultStyle];
}

function parseRelsMap(relsXml: string | undefined, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const root = parseXmlTree(relsXml);
  for (const rel of findChildren(root, 'Relationship')) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target || /^https?:\/\//i.test(target)) continue;
    const normalized = target.startsWith('/')
      ? target.slice(1)
      : path.posix.normalize(path.posix.join(baseDir, target));
    map.set(id, normalized);
  }
  return map;
}

function colRefToIndex(colLetters: string): number {
  let idx = 0;
  for (const ch of colLetters.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
}

function parseCellAddress(ref: string): { r: number; c: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  return { c: colRefToIndex(m[1]), r: Number(m[2]) - 1 };
}

function charWidthUnits(ch: string, bold: boolean): number {
  const code = ch.codePointAt(0) ?? 32;
  const boldFactor = bold ? 1.04 : 1.0;
  if (code === 9) return 2.0;
  if (code > 127) return 1.0 * boldFactor;
  if ('mwMW@#%&QGO+'.includes(ch)) return 0.78 * boldFactor;
  if ('ijlI.,;:\'"!|` '.includes(ch)) return 0.33 * boldFactor;
  if (ch >= '0' && ch <= '9') return 0.55 * boldFactor;
  if (ch >= 'A' && ch <= 'Z') return 0.67 * boldFactor;
  return 0.53 * boldFactor;
}

function sameRunStyle(a: ExcelTextRun, b: ExcelTextRun): boolean {
  return (
    a.fontSizePx === b.fontSizePx &&
    a.fontFamily === b.fontFamily &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.color === b.color
  );
}

function wrapCellRuns(runs: ExcelTextRun[], maxWidthPx: number): ExcelTextRun[][] {
  const fallbackFontPx = runs[0]?.fontSizePx || 12;
  const safeMax = Math.max(fallbackFontPx * 1.4, maxWidthPx);
  const lines: ExcelTextRun[][] = [];
  let currentLine: ExcelTextRun[] = [];
  let curW = 0;

  const pushLine = () => {
    lines.push(currentLine);
    currentLine = [];
    curW = 0;
  };

  const appendSeg = (text: string, template: ExcelTextRun) => {
    if (!text) return;
    const last = currentLine[currentLine.length - 1];
    if (last && sameRunStyle(last, template)) {
      last.text += text;
    } else {
      currentLine.push({ ...template, text });
    }
  };

  for (const run of runs) {
    const cleanText = run.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const tokens = cleanText.match(/\n|[A-Za-z0-9.,_%+-]{2,18}|[\s\S]/g) || [];
    for (const token of tokens) {
      if (token === '\n') {
        pushLine();
        continue;
      }
      let tokenW = 0;
      for (const ch of token) {
        tokenW += charWidthUnits(ch, run.bold) * run.fontSizePx;
      }
      if (currentLine.length > 0 && curW + tokenW > safeMax) {
        if (token.length > 1 && tokenW > safeMax) {
          for (const ch of token) {
            const chW = charWidthUnits(ch, run.bold) * run.fontSizePx;
            if (currentLine.length > 0 && curW + chW > safeMax) {
              pushLine();
            }
            appendSeg(ch, run);
            curW += chW;
          }
          continue;
        }
        pushLine();
        appendSeg(token, run);
        curW = tokenW;
      } else {
        appendSeg(token, run);
        curW += tokenW;
      }
    }
  }

  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }
  return lines;
}

async function preparePdfImage(
  pdfDoc: PDFDocument,
  rawBuf: Buffer
): Promise<PreparedImage | null> {
  try {
    const meta = await sharp(rawBuf).metadata();
    if (!meta.width || !meta.height) return null;
    const needsRotate = Boolean(meta.orientation && meta.orientation > 1);
    const maxDim = 1800;
    const isOversized = meta.width > maxDim || meta.height > maxDim;

    if (meta.format === 'jpeg' && !needsRotate && !isOversized) {
      try {
        const pdfImage = await pdfDoc.embedJpg(Uint8Array.from(rawBuf));
        return { pdfImage, naturalW: meta.width, naturalH: meta.height };
      } catch {
        // Fall through
      }
    }
    if (meta.format === 'png' && !needsRotate && !isOversized) {
      try {
        const pdfImage = await pdfDoc.embedPng(Uint8Array.from(rawBuf));
        return { pdfImage, naturalW: meta.width, naturalH: meta.height };
      } catch {
        // Fall through
      }
    }

    let pipeline = sharp(rawBuf).rotate();
    if (isOversized) {
      pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }
    if (meta.format === 'png' && meta.hasAlpha) {
      const { data, info } = await pipeline.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
      const pdfImage = await pdfDoc.embedPng(Uint8Array.from(data));
      return { pdfImage, naturalW: info.width, naturalH: info.height };
    }
    try {
      const { data, info } = await pipeline
        .toColorspace('srgb')
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const pdfImage = await pdfDoc.embedJpg(Uint8Array.from(data));
      return { pdfImage, naturalW: info.width, naturalH: info.height };
    } catch {
      const { data, info } = await sharp(rawBuf)
        .rotate()
        .png({ compressionLevel: 6 })
        .toBuffer({ resolveWithObject: true });
      const pdfImage = await pdfDoc.embedPng(Uint8Array.from(data));
      return { pdfImage, naturalW: info.width, naturalH: info.height };
    }
  } catch {
    return null;
  }
}

function parseDrawingAnchors(drawingXml: string): SheetDrawingAnchor[] {
  const root = parseXmlTree(drawingXml);
  const anchors: SheetDrawingAnchor[] = [];

  const handleAnchor = (node: XmlNode, isTwoCell: boolean) => {
    // Support AlternateContent wrapper around drawings
    const picSearchRoot = (() => {
      const alt = findChild(node, 'AlternateContent');
      if (alt) return findChild(alt, 'Choice') ?? findChild(alt, 'Fallback') ?? node;
      return node;
    })();

    const fromNode = findChild(node, 'from');
    const blip = findDescendant(picSearchRoot, 'blip');
    const rId = blip?.attrs['r:embed'] || blip?.attrs['r:link'] || blip?.attrs.embed || blip?.attrs.link;
    if (!fromNode || !rId) return;

    const fromCol = Number(findChild(fromNode, 'col')?.text || 0);
    const fromRow = Number(findChild(fromNode, 'row')?.text || 0);
    const fromColOffPx = Number(findChild(fromNode, 'colOff')?.text || 0) / 9525;
    const fromRowOffPx = Number(findChild(fromNode, 'rowOff')?.text || 0) / 9525;

    if (isTwoCell) {
      const toNode = findChild(node, 'to');
      if (toNode) {
        anchors.push({
          rId,
          fromCol,
          fromRow,
          fromColOffPx,
          fromRowOffPx,
          toCol: Number(findChild(toNode, 'col')?.text || fromCol),
          toRow: Number(findChild(toNode, 'row')?.text || fromRow),
          toColOffPx: Number(findChild(toNode, 'colOff')?.text || 0) / 9525,
          toRowOffPx: Number(findChild(toNode, 'rowOff')?.text || 0) / 9525,
        });
        return;
      }
    }

    const extNode = findChild(node, 'ext') || findDescendant(picSearchRoot, 'ext');
    const extWPx = Number(extNode?.attrs.cx || 0) / 9525;
    const extHPx = Number(extNode?.attrs.cy || 0) / 9525;
    anchors.push({
      rId,
      fromCol,
      fromRow,
      fromColOffPx,
      fromRowOffPx,
      extWPx: extWPx > 4 ? extWPx : undefined,
      extHPx: extHPx > 4 ? extHPx : undefined,
    });
  };

  for (const child of root.children) {
    const tag = localTag(child.tag);
    if (tag === 'twoCellAnchor') handleAnchor(child, true);
    else if (tag === 'oneCellAnchor') handleAnchor(child, false);
  }
  return anchors;
}

export async function renderXlsxToPdf(
  inputPath: string,
  outPdfPath: string,
  options: XlsxRenderOptions = {}
): Promise<void> {
  const landscapeMode = options.landscape ?? 'auto';
  const fitToPage = options.fitToPage ?? true;
  const continuous = Boolean(options.continuous);

  const fileBytes = await fs.readFile(inputPath);
  const workbook = XLSX.read(fileBytes, { type: 'buffer', cellStyles: true });
  if (workbook.SheetNames.length === 0) {
    throw new Error('Excel 文件中没有读取到有效工作表');
  }

  let zip: JSZip | null = null;
  if (fileBytes.length >= 2 && fileBytes[0] === 0x50 && fileBytes[1] === 0x4b) {
    try {
      zip = await JSZip.loadAsync(fileBytes);
    } catch {
      zip = null;
    }
  }

  const themeXml = await zip?.files['xl/theme/theme1.xml']?.async('string');
  const stylesXml = await zip?.files['xl/styles.xml']?.async('string');
  const workbookXml = await zip?.files['xl/workbook.xml']?.async('string');
  const wbRelsXml = await zip?.files['xl/_rels/workbook.xml.rels']?.async('string');
  const sharedStringsXml = await zip?.files['xl/sharedStrings.xml']?.async('string');

  const themePalette = parseThemePalette(themeXml);
  const cellStyles = parseExcelStyles(stylesXml, themePalette);
  const wbRels = parseRelsMap(wbRelsXml, 'xl');
  const sharedStrings = parseSharedStrings(sharedStringsXml, themePalette);

  // Map sheet name -> worksheet XML path in zip
  const sheetPathByName = new Map<string, string>();
  if (workbookXml) {
    const wbRoot = parseXmlTree(workbookXml);
    const sheetsNode = findChild(wbRoot, 'sheets');
    for (const sh of findChildren(sheetsNode, 'sheet')) {
      const name = sh.attrs.name;
      const rId = sh.attrs['r:id'] || sh.attrs.id;
      if (name && rId && wbRels.has(rId)) {
        sheetPathByName.set(name, wbRels.get(rId)!);
      }
    }
  }

  const padX = 34;
  const padY = 34;
  const bottomMargin = 38;

  const pdfDoc = await PDFDocument.create();
  const sheetsToRender = workbook.SheetNames.slice(0, 20);
  const showSheetBanner = sheetsToRender.length > 1;

  interface ExcelPageData {
    pageW: number;
    pageH: number;
    svgElements: string[];
    images: Array<{ image: PreparedImage; x: number; y: number; width: number; height: number }>;
  }
  const allPages: ExcelPageData[] = [];
  const imageCache = new Map<string, PreparedImage | null>();

  const loadZipImage = async (zipPath: string): Promise<PreparedImage | null> => {
    if (!zip) return null;
    if (imageCache.has(zipPath)) return imageCache.get(zipPath) ?? null;
    const entry = zip.files[zipPath];
    if (!entry) {
      imageCache.set(zipPath, null);
      return null;
    }
    const prep = await preparePdfImage(pdfDoc, await entry.async('nodebuffer'));
    imageCache.set(zipPath, prep);
    return prep;
  };

  for (let sIdx = 0; sIdx < sheetsToRender.length; sIdx++) {
    const sheetName = sheetsToRender[sIdx];
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;

    const merges: MergeRange[] = (ws['!merges'] || []).map((m) => ({
      sr: m.s.r,
      sc: m.s.c,
      er: m.e.r,
      ec: m.e.c,
    }));

    // Parse raw worksheet XML for exact cell style indices, rich text runs, row heights, and drawings
    const sheetXmlPath = sheetPathByName.get(sheetName) || `xl/worksheets/sheet${sIdx + 1}.xml`;
    const sheetXml = await zip?.files[sheetXmlPath]?.async('string');

    const cellStyleIndex = new Map<string, number>();
    const cellRichStrings = new Map<string, NonNullable<SharedStringEntry['richRuns']>>();
    const xmlRowHeightPt = new Map<number, number>();
    let defaultRowHeightPt = 15;
    let defaultColWidthCh = 9;
    let maxStyledRow = 0;
    let maxStyledCol = 0;
    let lastDataRow = 0;
    let lastDataCol = 0;
    let pageOrientationAttr: string | undefined;
    const drawingRelIds: string[] = [];

    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const c = ws[key];
      if (!c) continue;
      const hasVal =
        (c.v !== undefined && c.v !== '') ||
        (c.w !== undefined && c.w !== '') ||
        c.f !== undefined;
      if (hasVal) {
        const addr = parseCellAddress(key);
        if (addr) {
          if (addr.r > lastDataRow) lastDataRow = addr.r;
          if (addr.c > lastDataCol) lastDataCol = addr.c;
        }
      }
    }

    if (sheetXml) {
      const wsRoot = parseXmlTree(sheetXml);
      const pageSetup = findChild(wsRoot, 'pageSetup');
      if (pageSetup?.attrs.orientation) {
        pageOrientationAttr = pageSetup.attrs.orientation;
      }
      const fmtPr = findChild(wsRoot, 'sheetFormatPr');
      if (fmtPr?.attrs.defaultRowHeight) {
        const drh = Number(fmtPr.attrs.defaultRowHeight);
        if (Number.isFinite(drh) && drh > 6) defaultRowHeightPt = drh;
      }
      if (fmtPr?.attrs.defaultColWidth) {
        const dcw = Number(fmtPr.attrs.defaultColWidth);
        if (Number.isFinite(dcw) && dcw > 2) defaultColWidthCh = dcw;
      }

      const sheetData = findChild(wsRoot, 'sheetData');
      for (const rowNode of findChildren(sheetData, 'row')) {
        const rNum = Number(rowNode.attrs.r) - 1;
        if (!Number.isInteger(rNum) || rNum < 0) continue;
        if (rowNode.attrs.ht) {
          const ht = Number(rowNode.attrs.ht);
          if (Number.isFinite(ht) && ht > 4) xmlRowHeightPt.set(rNum, ht);
        }
        for (const cNode of findChildren(rowNode, 'c')) {
          const ref = cNode.attrs.r;
          if (!ref) continue;
          const addr = parseCellAddress(ref);
          const sAttr = cNode.attrs.s;
          if (sAttr !== undefined) {
            const sIdxVal = Number(sAttr);
            if (Number.isInteger(sIdxVal)) {
              cellStyleIndex.set(ref, sIdxVal);
              const st = cellStyles[sIdxVal];
              const hasVisibleBox =
                st &&
                (st.fill ||
                  st.borders.top ||
                  st.borders.bottom ||
                  st.borders.left ||
                  st.borders.right);
              if (hasVisibleBox && addr) {
                if (addr.r > maxStyledRow) maxStyledRow = addr.r;
                if (addr.c > maxStyledCol) maxStyledCol = addr.c;
              }
            }
          }

          const vNode = findChild(cNode, 'v');
          const fNode = findChild(cNode, 'f');
          let hasCellData =
            (vNode?.text !== undefined && vNode.text !== '') ||
            Boolean(fNode);

          if (cNode.attrs.t === 's') {
            const vIdx = Number(vNode?.text);
            const ssEntry = Number.isInteger(vIdx) ? sharedStrings[vIdx] : undefined;
            if (ssEntry?.richRuns && ssEntry.richRuns.length > 0) {
              cellRichStrings.set(ref, ssEntry.richRuns);
            }
          } else if (cNode.attrs.t === 'inlineStr') {
            const isNode = findChild(cNode, 'is');
            if (isNode) {
              const rich = parseRichTextContainer(isNode, themePalette);
              if (rich.text) hasCellData = true;
              if (rich.richRuns && rich.richRuns.length > 0) {
                cellRichStrings.set(ref, rich.richRuns);
              }
            }
          }

          if (hasCellData && addr) {
            if (addr.r > lastDataRow) lastDataRow = addr.r;
            if (addr.c > lastDataCol) lastDataCol = addr.c;
          }
        }
      }

      for (const dr of findChildren(wsRoot, 'drawing')) {
        const rId = dr.attrs['r:id'] || dr.attrs.id;
        if (rId) drawingRelIds.push(rId);
      }
    }

    // Parse anchored drawings if any
    const sheetBaseDir = path.posix.dirname(sheetXmlPath);
    const sheetBaseName = path.posix.basename(sheetXmlPath);
    const sheetRelsPath = path.posix.join(sheetBaseDir, '_rels', `${sheetBaseName}.rels`);
    const sheetRels = parseRelsMap(await zip?.files[sheetRelsPath]?.async('string'), sheetBaseDir);

    const drawings: Array<{ anchor: SheetDrawingAnchor; image: PreparedImage }> = [];
    for (const drRelId of drawingRelIds) {
      const drawingPath = sheetRels.get(drRelId);
      if (!drawingPath) continue;
      const drawingXml = await zip?.files[drawingPath]?.async('string');
      if (!drawingXml) continue;

      const drawingBaseDir = path.posix.dirname(drawingPath);
      const drawingBaseName = path.posix.basename(drawingPath);
      const drawingRelsPath = path.posix.join(drawingBaseDir, '_rels', `${drawingBaseName}.rels`);
      const drawingRels = parseRelsMap(await zip?.files[drawingRelsPath]?.async('string'), drawingBaseDir);

      for (const anchor of parseDrawingAnchors(drawingXml)) {
        const imgPath = drawingRels.get(anchor.rId);
        if (!imgPath) continue;
        const prepared = await loadZipImage(imgPath);
        if (!prepared) continue;
        drawings.push({ anchor, image: prepared });
      }
    }

    // Determine effective row/col grid bounds while filtering phantom styled-only trailing rows
    const refRange = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const effectiveStyledRow =
      lastDataRow > 0 ? Math.min(maxStyledRow, lastDataRow + 20) : Math.min(maxStyledRow, 40);
    const effectiveStyledCol =
      lastDataCol > 0 ? Math.min(maxStyledCol, lastDataCol + 6) : Math.min(maxStyledCol, 12);
    const effectiveRefRow =
      lastDataRow > 0 ? Math.min(refRange.e.r, lastDataRow + 20) : Math.min(refRange.e.r, 40);
    const effectiveRefCol =
      lastDataCol > 0 ? Math.min(refRange.e.c, lastDataCol + 6) : Math.min(refRange.e.c, 12);

    let maxRow = Math.max(lastDataRow, effectiveStyledRow, effectiveRefRow);
    let maxCol = Math.max(lastDataCol, effectiveStyledCol, effectiveRefCol);
    for (const m of merges) {
      if (lastDataRow === 0 || m.sr <= lastDataRow + 20) {
        if (m.er > maxRow) maxRow = m.er;
        if (m.ec > maxCol) maxCol = m.ec;
      }
    }
    for (const d of drawings) {
      if (d.anchor.fromRow > maxRow) maxRow = d.anchor.fromRow;
      if (d.anchor.fromCol > maxCol) maxCol = d.anchor.fromCol;
      if (d.anchor.toRow !== undefined && d.anchor.toRow > maxRow) maxRow = d.anchor.toRow;
      if (d.anchor.toCol !== undefined && d.anchor.toCol > maxCol) maxCol = d.anchor.toCol;
    }

    maxCol = Math.min(24, maxCol);
    maxRow = Math.min(continuous ? 1499 : 2999, maxRow);
    const numCols = maxCol + 1;
    const numRows = maxRow + 1;

    // Build merge lookup maps
    const mergeMaster = new Map<string, MergeRange>();
    const coveredByMerge = new Set<string>();
    for (const m of merges) {
      if (m.sr > maxRow || m.sc > maxCol) continue;
      const clamped: MergeRange = {
        sr: m.sr,
        sc: m.sc,
        er: Math.min(maxRow, m.er),
        ec: Math.min(maxCol, m.ec),
      };
      mergeMaster.set(`${clamped.sr}:${clamped.sc}`, clamped);
      for (let r = clamped.sr; r <= clamped.er; r++) {
        for (let c = clamped.sc; c <= clamped.ec; c++) {
          if (r !== clamped.sr || c !== clamped.sc) {
            coveredByMerge.add(`${r}:${c}`);
          }
        }
      }
    }

    // Check if the sheet uses explicit borders at all; if none, draw light spreadsheet gridlines
    let sheetHasAnyExplicitBorders = false;
    for (const sVal of cellStyleIndex.values()) {
      const bd = cellStyles[sVal]?.borders;
      if (bd && (bd.top || bd.bottom || bd.left || bd.right)) {
        sheetHasAnyExplicitBorders = true;
        break;
      }
    }

    // Column widths & baseline row heights in 96DPI pixels
    const colsMeta = ws['!cols'] || [];
    const rawColWidths: number[] = Array.from({ length: numCols }, (_, c) => {
      const colInfo = colsMeta[c];
      if (colInfo?.wch && colInfo.wch > 1) return Math.round(colInfo.wch * 8.6 + 5);
      if (colInfo?.wpx && colInfo.wpx > 10) return colInfo.wpx;
      return Math.round(defaultColWidthCh * 8.6 + 5);
    });
    const rawTotalSheetW = rawColWidths.reduce((s, w) => s + w, 0) || 700;

    const rowsMeta = ws['!rows'] || [];
    const rawRowPts: number[] = Array.from({ length: numRows }, (_, r) => {
      const xmlPt = xmlRowHeightPt.get(r);
      const sheetJsPt = rowsMeta[r]?.hpt;
      return xmlPt ?? sheetJsPt ?? defaultRowHeightPt;
    });
    const rawTotalSheetH = rawRowPts.reduce((s, pt) => s + Math.max(20, pt * (4 / 3)), 0);

    // Choose portrait vs landscape cleanly per sheet when mode is 'auto'
    const sheetLandscape =
      landscapeMode === true
        ? true
        : landscapeMode === false
        ? false
        : pageOrientationAttr === 'landscape'
        ? true
        : pageOrientationAttr === 'portrait'
        ? false
        : rawTotalSheetW > 900 || (rawTotalSheetW > rawTotalSheetH * 1.15 && rawTotalSheetW > 740);

    const pageW = sheetLandscape ? 1123 : 794;
    const pageH = sheetLandscape ? 794 : 1123;
    const availW = pageW - padX * 2;
    const availH = pageH - padY - bottomMargin;

    // Horizontal scaling factor to fit width cleanly
    const widthScale = fitToPage
      ? Math.min(1.12, availW / rawTotalSheetW)
      : Math.min(1.0, availW / rawTotalSheetW);

    const colWidths = rawColWidths.map((w) => w * widthScale);
    const totalTableW = colWidths.reduce((s, w) => s + w, 0);
    const colLeft: number[] = [0];
    for (let c = 0; c < numCols; c++) {
      colLeft.push(colLeft[c] + colWidths[c]);
    }

    const rowHeightScale = Math.max(0.58, Math.min(1.05, widthScale));
    const fontScale = Math.min(1.04, Math.max(0.58, widthScale * 1.15));

    // Baseline row heights in 96DPI pixels scaled proportionally with widthScale
    const rowHeights: number[] = rawRowPts.map((pt) =>
      Math.max(15, pt * (4 / 3) * rowHeightScale)
    );

    const getCellText = (r: number, c: number): string => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) return '';
      if (cell.w !== undefined) return String(cell.w);
      if (cell.v !== undefined) return String(XLSX.utils.format_cell(cell));
      return '';
    };

    const getCellType = (r: number, c: number): string | undefined => {
      const addr = XLSX.utils.encode_cell({ r, c });
      return ws[addr]?.t;
    };

    const getCellStyle = (r: number, c: number): ResolvedCellStyle => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const idx = cellStyleIndex.get(addr);
      return (idx !== undefined ? cellStyles[idx] : cellStyles[0]) || cellStyles[0];
    };

    // Resolve boxes for every non-covered cell & pre-wrap text so rows never clip vertically
    interface CellRenderItem {
      sr: number;
      sc: number;
      er: number;
      ec: number;
      lines: ExcelTextRun[][];
      maxFontSizePx: number;
      fill?: string;
      hAlign: 'left' | 'center' | 'right';
      vAlign: 'top' | 'center' | 'bottom';
      borders: CellBorders;
    }

    const renderItems: CellRenderItem[] = [];
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const key = `${r}:${c}`;
        if (coveredByMerge.has(key)) continue;

        const m = mergeMaster.get(key) || { sr: r, sc: c, er: r, ec: c };
        const st = getCellStyle(r, c);
        const addr = XLSX.utils.encode_cell({ r, c });
        const richEntry = cellRichStrings.get(addr);
        const text = getCellText(r, c);
        const boxW = colLeft[m.ec + 1] - colLeft[m.sc];

        let cellRuns: ExcelTextRun[] = [];
        if (richEntry && richEntry.length > 0) {
          cellRuns = richEntry.map((rr) => ({
            text: rr.text,
            fontSizePx: Math.max(7.2, (rr.fontSizePx ?? st.fontSizePx) * fontScale),
            fontFamily: rr.fontFamily ?? st.fontFamily,
            bold: rr.bold ?? st.bold,
            italic: rr.italic ?? st.italic,
            underline: rr.underline ?? st.underline,
            color: rr.color ?? st.color,
          }));
        } else if (text) {
          cellRuns = [
            {
              text,
              fontSizePx: Math.max(7.2, st.fontSizePx * fontScale),
              fontFamily: st.fontFamily,
              bold: st.bold,
              italic: st.italic,
              underline: st.underline,
              color: st.color,
            },
          ];
        }

        const cType = getCellType(r, c);
        const hAlign: 'left' | 'center' | 'right' =
          st.hAlign ?? (cType === 'n' ? 'right' : 'left');
        const hPad = hAlign === 'center' ? 7 : 8;
        const lines = cellRuns.length > 0 ? wrapCellRuns(cellRuns, Math.max(16, boxW - hPad)) : [];
        const maxFontSizePx = cellRuns.reduce(
          (mx, run) => Math.max(mx, run.fontSizePx),
          Math.max(7.2, st.fontSizePx * fontScale)
        );

        // Resolve outer borders across the merged boundary
        let borders: CellBorders = st.borders;
        if (m.er > m.sr || m.ec > m.sc) {
          let top = st.borders.top;
          for (let cc = m.sc; !top && cc <= m.ec; cc++) top = getCellStyle(m.sr, cc).borders.top;
          let bottom = getCellStyle(m.er, m.sc).borders.bottom;
          for (let cc = m.sc; !bottom && cc <= m.ec; cc++) bottom = getCellStyle(m.er, cc).borders.bottom;
          let left = st.borders.left;
          for (let rr = m.sr; !left && rr <= m.er; rr++) left = getCellStyle(rr, m.sc).borders.left;
          let right = getCellStyle(m.sr, m.ec).borders.right;
          for (let rr = m.sr; !right && rr <= m.er; rr++) right = getCellStyle(rr, m.ec).borders.right;
          borders = { top, bottom, left, right };
        }

        if (!sheetHasAnyExplicitBorders) {
          borders = {
            top: borders.top ?? { width: 0.75, color: '#CBD5E1' },
            bottom: borders.bottom ?? { width: 0.75, color: '#CBD5E1' },
            left: borders.left ?? { width: 0.75, color: '#CBD5E1' },
            right: borders.right ?? { width: 0.75, color: '#CBD5E1' },
          };
        }

        // Expand row height if wrapped text needs more vertical space
        if (lines.length > 0) {
          const lineH = maxFontSizePx * 1.35;
          const neededH = lines.length * lineH + 8;
          let currentH = 0;
          for (let rr = m.sr; rr <= m.er; rr++) currentH += rowHeights[rr];
          if (neededH > currentH) {
            const extra = neededH - currentH;
            if (m.sr === m.er) {
              rowHeights[m.sr] += extra;
            } else {
              rowHeights[m.er] += extra;
            }
          }
        }

        renderItems.push({
          sr: m.sr,
          sc: m.sc,
          er: m.er,
          ec: m.ec,
          lines,
          maxFontSizePx,
          fill: st.fill,
          hAlign,
          vAlign: st.vAlign,
          borders,
        });
      }
    }

    // Build atomic row groups so pagination never cuts across a vertical merge or an anchored photo
    const spanEndByStartRow = new Map<number, number>();
    const registerSpan = (sr: number, er: number) => {
      const clampedStart = Math.max(0, Math.min(numRows - 1, sr));
      const clampedEnd = Math.max(clampedStart, Math.min(numRows - 1, er));
      for (let r = clampedStart; r <= clampedEnd; r++) {
        spanEndByStartRow.set(r, Math.max(spanEndByStartRow.get(r) ?? r, clampedEnd));
      }
    };
    for (const m of merges) registerSpan(m.sr, m.er);
    for (const d of drawings) {
      if (d.anchor.toRow !== undefined) registerSpan(d.anchor.fromRow, d.anchor.toRow);
    }

    const rowGroups: Array<{ sr: number; er: number; height: number }> = [];
    let cursorR = 0;
    while (cursorR < numRows) {
      let groupEnd = spanEndByStartRow.get(cursorR) ?? cursorR;
      // Merge overlapping spans transitively
      let rScan = cursorR;
      while (rScan <= groupEnd) {
        const candidateEnd = spanEndByStartRow.get(rScan) ?? rScan;
        if (candidateEnd > groupEnd) groupEnd = candidateEnd;
        rScan++;
      }
      let h = 0;
      for (let r = cursorR; r <= groupEnd; r++) h += rowHeights[r];
      rowGroups.push({ sr: cursorR, er: groupEnd, height: h });
      cursorR = groupEnd + 1;
    }

    // Paginate atomic row groups cleanly (continuous long-image mode allows tall seamless sheets)
    const sheetTopOffset = showSheetBanner ? 28 : 0;
    const maxRowsAvailH = (continuous ? 10500 : availH) - sheetTopOffset;

    const pageRowSlices: Array<{ startRow: number; endRow: number }> = [];
    let sliceStart = 0;
    let sliceH = 0;
    for (const grp of rowGroups) {
      if (sliceH > 0 && sliceH + grp.height > maxRowsAvailH) {
        pageRowSlices.push({ startRow: sliceStart, endRow: grp.sr - 1 });
        sliceStart = grp.sr;
        sliceH = grp.height;
      } else {
        sliceH += grp.height;
      }
    }
    pageRowSlices.push({ startRow: sliceStart, endRow: numRows - 1 });

    // Cumulative rowY inside the sheet
    const rowTop: number[] = [0];
    for (let r = 0; r < numRows; r++) {
      rowTop.push(rowTop[r] + rowHeights[r]);
    }

    // Render each page slice
    const offsetX = padX + Math.max(0, (availW - totalTableW) / 2);
    for (const slice of pageRowSlices) {
      const pageSvg: string[] = [];
      const pageImages: ExcelPageData['images'] = [];

      if (showSheetBanner) {
        pageSvg.push(
          `<text x="${offsetX.toFixed(1)}" y="${(padY + 15).toFixed(
            1
          )}" font-family="${FONT_FAMILY}" font-size="14" font-weight="700" fill="#132B54">${escapeXml(
            sheetName
          )}</text>`
        );
      }

      const sliceTopRowY = rowTop[slice.startRow];
      const baseOriginY = padY + sheetTopOffset;
      const sliceTotalH = rowTop[slice.endRow + 1] - sliceTopRowY;
      // Scale vertically slightly ONLY if a single unbreakable atomic group slightly exceeds maxRowsAvailH
      const yScale = sliceTotalH > maxRowsAvailH ? maxRowsAvailH / sliceTotalH : 1;

      for (const item of renderItems) {
        if (item.er < slice.startRow || item.sr > slice.endRow) continue;
        const clampedSr = Math.max(slice.startRow, item.sr);
        const clampedEr = Math.min(slice.endRow, item.er);
        const x = offsetX + colLeft[item.sc];
        const w = colLeft[item.ec + 1] - colLeft[item.sc];
        const y = baseOriginY + (rowTop[clampedSr] - sliceTopRowY) * yScale;
        const h = (rowTop[clampedEr + 1] - rowTop[clampedSr]) * yScale;

        if (item.fill) {
          pageSvg.push(
            `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(
              1
            )}" fill="${item.fill}"/>`
          );
        }

        const drawEdge = (edge: BorderEdge | undefined, x1: number, y1: number, x2: number, y2: number) => {
          if (!edge) return;
          if (edge.double) {
            const isHoriz = Math.abs(y1 - y2) < 0.01;
            const dx = isHoriz ? 0 : 0.9;
            const dy = isHoriz ? 0.9 : 0;
            pageSvg.push(
              `<line x1="${(x1 - dx).toFixed(1)}" y1="${(y1 - dy).toFixed(1)}" x2="${(x2 - dx).toFixed(
                1
              )}" y2="${(y2 - dy).toFixed(1)}" stroke="${edge.color}" stroke-width="0.65" stroke-linecap="square"/>`,
              `<line x1="${(x1 + dx).toFixed(1)}" y1="${(y1 + dy).toFixed(1)}" x2="${(x2 + dx).toFixed(
                1
              )}" y2="${(y2 + dy).toFixed(1)}" stroke="${edge.color}" stroke-width="0.65" stroke-linecap="square"/>`
            );
            return;
          }
          pageSvg.push(
            `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
              1
            )}" stroke="${edge.color}" stroke-width="${edge.width}" stroke-linecap="square"/>`
          );
        };
        drawEdge(item.borders.top, x, y, x + w, y);
        drawEdge(item.borders.bottom, x, y + h, x + w, y + h);
        drawEdge(item.borders.left, x, y, x, y + h);
        drawEdge(item.borders.right, x + w, y, x + w, y + h);

        if (item.lines.length > 0 && item.sr >= slice.startRow && item.sr <= slice.endRow) {
          const lineFontSize = item.maxFontSizePx * Math.min(1, yScale);
          const lineH = lineFontSize * 1.35;
          const blockH = item.lines.length * lineH;
          let startTextY = y + Math.max(3, (h - blockH) / 2);
          if (item.vAlign === 'top') startTextY = y + 4;
          else if (item.vAlign === 'bottom') startTextY = y + Math.max(3, h - blockH - 4);

          let textX = x + 4.5;
          let anchor = 'start';
          if (item.hAlign === 'center') {
            textX = x + w / 2;
            anchor = 'middle';
          } else if (item.hAlign === 'right') {
            textX = x + w - 4.5;
            anchor = 'end';
          }

          item.lines.forEach((lineSegs, lIdx) => {
            if (lineSegs.length === 0) return;
            const baseline = startTextY + lIdx * lineH + lineFontSize * 0.9;
            if (baseline > y + h + 2) return;
            const tspans = lineSegs
              .map((seg) => {
                const segSize = seg.fontSizePx * Math.min(1, yScale);
                const attrs = [
                  `font-family="${escapeXml(seg.fontFamily)}"`,
                  `font-size="${segSize.toFixed(1)}"`,
                  `fill="${seg.color}"`,
                ];
                if (seg.bold) attrs.push('font-weight="700"');
                if (seg.italic) attrs.push('font-style="italic"');
                if (seg.underline) attrs.push('text-decoration="underline"');
                return `<tspan ${attrs.join(' ')}>${escapeXml(seg.text)}</tspan>`;
              })
              .join('');
            pageSvg.push(
              `<text x="${textX.toFixed(1)}" y="${baseline.toFixed(
                1
              )}" text-anchor="${anchor}" xml:space="preserve">${tspans}</text>`
            );
          });
        }
      }

      // Place anchored drawings falling inside this slice
      for (const d of drawings) {
        const a = d.anchor;
        const anchorRow = a.fromRow;
        if (anchorRow < slice.startRow || anchorRow > slice.endRow) continue;

        const cFrom = Math.max(0, Math.min(numCols, a.fromCol));
        const rFrom = Math.max(slice.startRow, Math.min(slice.endRow, a.fromRow));
        const x1 = offsetX + colLeft[cFrom] + a.fromColOffPx * widthScale;
        const y1 = baseOriginY + (rowTop[rFrom] + a.fromRowOffPx * rowHeightScale - sliceTopRowY) * yScale;

        let boxW = (a.extWPx ?? Math.min(260, d.image.naturalW)) * widthScale;
        let boxH = (a.extHPx ?? Math.min(260, d.image.naturalH)) * rowHeightScale * yScale;

        if (a.toCol !== undefined && a.toRow !== undefined) {
          const cTo = Math.max(0, Math.min(numCols, a.toCol));
          const rTo = Math.max(slice.startRow, Math.min(slice.endRow + 1, a.toRow));
          const x2 = offsetX + colLeft[cTo] + (a.toColOffPx ?? 0) * widthScale;
          const y2 = baseOriginY + (rowTop[rTo] + (a.toRowOffPx ?? 0) * rowHeightScale - sliceTopRowY) * yScale;
          if (x2 > x1 + 4) boxW = x2 - x1;
          if (y2 > y1 + 4) boxH = y2 - y1;
        }

        // Preserve image aspect ratio cleanly inside its Excel anchor bounding box
        const natRatio = d.image.naturalW / d.image.naturalH;
        const boxRatio = boxW / boxH;
        let drawW = boxW;
        let drawH = boxH;
        let drawX = x1;
        let drawY = y1;
        if (Math.abs(natRatio - boxRatio) > 0.06) {
          const s = Math.min(boxW / d.image.naturalW, boxH / d.image.naturalH);
          drawW = d.image.naturalW * s;
          drawH = d.image.naturalH * s;
          drawX = x1 + (boxW - drawW) / 2;
          drawY = y1 + (boxH - drawH) / 2;
        }

        pageImages.push({
          image: d.image,
          x: drawX,
          y: drawY,
          width: drawW,
          height: drawH,
        });
      }

      allPages.push({
        pageW,
        pageH: continuous ? Math.max(260, Math.round(baseOriginY + sliceTotalH * yScale + padY)) : pageH,
        svgElements: pageSvg,
        images: pageImages,
      });
    }
  }

  if (allPages.length === 0) {
    allPages.push({
      pageW: landscapeMode === true ? 1123 : 794,
      pageH: landscapeMode === true ? 794 : 1123,
      svgElements: [
        `<text x="${padX}" y="${padY + 24}" font-family="${FONT_FAMILY}" font-size="14" fill="#64748B">（空白工作表）</text>`,
      ],
      images: [],
    });
  }

  const totalPages = allPages.length;
  const rasterScale = 1.5;

  for (let p = 0; p < totalPages; p++) {
    const pData = allPages[p];
    const pW = pData.pageW;
    const pH = pData.pageH;
    const pagePtW = pW * 0.75;
    const pagePtH = pH * 0.75;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pW} ${pH}" width="${Math.round(
      pW * rasterScale
    )}" height="${Math.round(pH * rasterScale)}">
      <rect width="${pW}" height="${pH}" fill="#FFFFFF"/>
      ${pData.svgElements.join('\n')}
      ${
        continuous
          ? ''
          : `<text x="${pW / 2}" y="${pH - 16}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#94A3B8">第 ${
              p + 1
            } 页 / 共 ${totalPages} 页</text>`
      }
    </svg>`;

    const bgPng = await sharp(Buffer.from(svg)).png({ compressionLevel: 5 }).toBuffer();
    const bgEmbedded = await pdfDoc.embedPng(Uint8Array.from(bgPng));
    const pdfPage = pdfDoc.addPage([pagePtW, pagePtH]);
    pdfPage.drawImage(bgEmbedded, {
      x: 0,
      y: 0,
      width: pagePtW,
      height: pagePtH,
    });

    for (const img of pData.images) {
      const drawW = img.width * 0.75;
      const drawH = img.height * 0.75;
      const drawX = img.x * 0.75;
      const drawY = pagePtH - (img.y + img.height) * 0.75;
      pdfPage.drawImage(img.image.pdfImage, {
        x: drawX,
        y: drawY,
        width: drawW,
        height: drawH,
      });
    }
  }

  await fs.writeFile(outPdfPath, await pdfDoc.save());
}
