import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, type PDFImage } from 'pdf-lib';
import sharp from 'sharp';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const FONT_FAMILY = 'Noto Sans CJK SC, Microsoft YaHei, PingFang SC, SimHei, sans-serif';

function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          const code = parseInt(entity.slice(2), 16);
          return Number.isFinite(code) ? String.fromCodePoint(code) : '';
        }
        if (entity.startsWith('#')) {
          const code = parseInt(entity.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : '';
        }
        return '';
      }
    }
  });
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

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(raw)) !== null) {
    const val = decodeXmlEntities(m[2] ?? m[3] ?? '');
    attrs[m[1]] = val;
    const colon = m[1].indexOf(':');
    if (colon !== -1) {
      const local = m[1].slice(colon + 1);
      if (!(local in attrs)) attrs[local] = val;
    }
  }
  return attrs;
}

export function parseXmlTree(xml: string): XmlNode {
  const root: XmlNode = { tag: '__root__', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tokenRegex = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/)?([^\s>/]+)([^>]*?)(\/)?>|([^<]+)/g;
  let m: RegExpExecArray | null;

  while ((m = tokenRegex.exec(xml)) !== null) {
    const parent = stack[stack.length - 1];
    if (m[1] !== undefined) {
      parent.text += m[1];
      continue;
    }
    if (m[6] !== undefined) {
      parent.text += decodeXmlEntities(m[6]);
      continue;
    }
    if (m[3] === undefined) continue;

    const isClose = m[2] === '/';
    const tag = m[3];
    const attrRaw = m[4] || '';
    const isSelfClosing = m[5] === '/';

    if (isClose) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node: XmlNode = {
      tag,
      attrs: attrRaw.trim() ? parseAttributes(attrRaw) : {},
      children: [],
      text: '',
    };
    parent.children.push(node);
    if (!isSelfClosing) {
      stack.push(node);
    }
  }

  return root.children[0] || root;
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
  for (const child of node.children) {
    if (child.tag === name || localTag(child.tag) === name) return child;
    const deeper = findDescendant(child, name);
    if (deeper) return deeper;
  }
  return undefined;
}

function normalizeHex(raw: string | undefined, fallback = '#1E293B'): string {
  if (!raw || raw === 'auto' || raw === 'none') return fallback;
  const cleaned = raw.replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return `#${cleaned.toUpperCase()}`;
  return fallback;
}

function isEnabledFlag(node: XmlNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const val = node.attrs['w:val'] ?? node.attrs['val'];
  if (val === '0' || val === 'false' || val === 'off') return false;
  return true;
}

function twipsToPx(twips: number | string | undefined, fallback: number): number {
  const n = Number(twips);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n / 15; // 1440 twips = 96 px => 1 twip = 1/15 px
}

function signedTwipsToPx(twips: number | string | undefined, fallback = 0): number {
  const n = Number(twips);
  return Number.isFinite(n) ? n / 15 : fallback;
}

interface InlineImageRef {
  rId: string;
  width: number;
  height: number;
}

interface TextStyle {
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  highlight?: string;
  border?: string;
}

interface StyledSpan {
  text: string;
  style: TextStyle;
  inlineImage?: InlineImageRef;
}

interface ParagraphBorder {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
}

type DocBlock =
  | { type: 'pageBreak' }
  | {
      type: 'paragraph';
      align: 'left' | 'center' | 'right' | 'justify';
      spaceBefore: number;
      spaceAfter: number;
      lineMult: number;
      exactLinePx?: number;
      indentLeft: number;
      indentFirst: number;
      indentHanging: number;
      rightTabPosPx?: number;
      shading?: string;
      borders?: ParagraphBorder;
      spans: StyledSpan[];
    }
  | {
      type: 'image';
      rId: string;
      align: 'left' | 'center' | 'right';
      targetW?: number;
      targetH?: number;
      spaceBefore: number;
      spaceAfter: number;
    }
  | {
      type: 'table';
      block: ParsedTable;
    };

interface CellBorderSpec {
  width: number;
  color: string;
  none?: boolean;
}

interface CellBorders {
  top?: CellBorderSpec;
  bottom?: CellBorderSpec;
  left?: CellBorderSpec;
  right?: CellBorderSpec;
  insideH?: CellBorderSpec;
  insideV?: CellBorderSpec;
}

interface ParsedCell {
  gridSpan: number;
  vMerge?: 'restart' | 'continue';
  widthPx?: number;
  padTop: number;
  padBottom: number;
  padLeft: number;
  padRight: number;
  shading?: string;
  vAlign: 'top' | 'center' | 'bottom';
  borders: CellBorders;
  blocks: DocBlock[];
}

interface ParsedRow {
  isHeader: boolean;
  cells: ParsedCell[];
}

interface ParsedTable {
  align: 'left' | 'center' | 'right';
  colWidthsPx: number[];
  borders: CellBorders;
  defaultPad: { top: number; bottom: number; left: number; right: number };
  rows: ParsedRow[];
}

interface StyleDef {
  name?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  spaceBefore?: number;
  spaceAfter?: number;
  lineMult?: number;
  fontSizePx?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

interface PreparedImage {
  pdfImage: PDFImage;
  naturalW: number;
  naturalH: number;
}

interface ImagePlacement {
  image: PreparedImage;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageCanvas {
  svgElements: string[];
  images: ImagePlacement[];
}

function charWidthUnits(ch: string, bold: boolean): number {
  const code = ch.codePointAt(0) ?? 32;
  const boldFactor = bold ? 1.04 : 1.0;
  if (code === 9) return 2.0;
  if (code > 127) {
    // Full-width CJK / punctuation (~1.0em in Noto Sans CJK / Microsoft YaHei)
    return 1.0;
  }
  if ('mwMW@#%&QGO+'.includes(ch)) return 0.8 * boldFactor;
  if ('ijlI.,;:\'"!|` '.includes(ch)) return 0.33 * boldFactor;
  if ('ftjr-()[]{}/\\'.includes(ch)) return 0.39 * boldFactor;
  if (ch >= '0' && ch <= '9') return 0.55 * boldFactor;
  if (ch >= 'A' && ch <= 'Z') return 0.66 * boldFactor;
  return 0.54 * boldFactor;
}

function spanWidthPx(span: StyledSpan): number {
  if (span.inlineImage) return span.inlineImage.width + 2;
  let w = 0;
  for (const ch of span.text) {
    w += charWidthUnits(ch, span.style.bold) * span.style.fontSizePx;
  }
  return w;
}

function wrapStyledSpans(
  spans: StyledSpan[],
  maxWidth: number,
  firstLineIndent: number,
  indentHanging = 0
): Array<{ segments: StyledSpan[]; maxFontPx: number }> {
  const lines: Array<{ segments: StyledSpan[]; maxFontPx: number }> = [];
  let currentLine: StyledSpan[] = [];
  let currentWidth = indentHanging > 0 ? -indentHanging : Math.max(0, firstLineIndent);
  let maxFontInLine = 14;

  const pushCurrentLine = () => {
    lines.push({
      segments: currentLine,
      maxFontPx: currentLine.length > 0 ? maxFontInLine : 13,
    });
    currentLine = [];
    currentWidth = 0;
    maxFontInLine = 12;
  };

  const appendText = (txt: string, style: TextStyle) => {
    const last = currentLine[currentLine.length - 1];
    if (last && !last.inlineImage && last.style === style) {
      last.text += txt;
    } else {
      currentLine.push({ text: txt, style });
    }
    if (style.fontSizePx > maxFontInLine) maxFontInLine = style.fontSizePx;
  };

  // Tokenize into contiguous ASCII words/numbers vs individual CJK chars/breaks
  // so decimal numbers like "8140.00" don't split across lines unnecessarily.
  for (const span of spans) {
    if (span.inlineImage) {
      const iconW = span.inlineImage.width + 2;
      if (currentLine.length > 0 && currentWidth + iconW > maxWidth) {
        pushCurrentLine();
      }
      currentLine.push(span);
      currentWidth += iconW;
      maxFontInLine = Math.max(maxFontInLine, span.style.fontSizePx, span.inlineImage.height);
      continue;
    }
    if (span.text === '\t') {
      if (lines.length === 0 && currentWidth < 0) {
        currentLine.push({ text: '\t', style: span.style });
        currentWidth = 0;
      } else {
        appendText('\t', span.style);
        currentWidth += charWidthUnits('\t', span.style.bold) * span.style.fontSizePx;
      }
      continue;
    }
    const cleanText = span.text.replace(/\r/g, '');
    const tokens = cleanText.match(/\n|[A-Za-z0-9.,_%+-]{2,18}|[\s\S]/g) || [];
    for (const token of tokens) {
      if (token === '\n') {
        pushCurrentLine();
        continue;
      }
      let tokenW = 0;
      for (const ch of token) {
        tokenW += charWidthUnits(ch, span.style.bold) * span.style.fontSizePx;
      }
      if (currentLine.length > 0 && currentWidth + tokenW > maxWidth) {
        if (token.length > 1 && tokenW > maxWidth) {
          // Very long ASCII token: fall back to character wrapping
          for (const ch of token) {
            const chW = charWidthUnits(ch, span.style.bold) * span.style.fontSizePx;
            if (currentLine.length > 0 && currentWidth + chW > maxWidth) {
              pushCurrentLine();
            }
            appendText(ch, span.style);
            currentWidth += chW;
          }
          continue;
        }
        pushCurrentLine();
        if (token === ' ') continue;
      }
      appendText(token, span.style);
      currentWidth += tokenW;
    }
  }

  if (currentLine.length > 0 || lines.length === 0) {
    lines.push({
      segments: currentLine,
      maxFontPx: currentLine.length > 0 ? maxFontInLine : spans[0]?.style.fontSizePx || 14,
    });
  }

  return lines;
}

function estimateLineWidth(segments: StyledSpan[]): number {
  let w = 0;
  for (const seg of segments) {
    w += spanWidthPx(seg);
  }
  return w;
}

function renderWrappedLineSvg(
  line: { segments: StyledSpan[]; maxFontPx: number },
  boxX: number,
  baselineY: number,
  boxWidth: number,
  align: 'left' | 'center' | 'right' | 'justify',
  firstLineIndent: number,
  indentHanging = 0,
  rightTabPosPx?: number,
  onInlineImage?: (rId: string, x: number, y: number, w: number, h: number) => void
): string {
  const visibleSegments = line.segments.filter((s) => s.text.length > 0 || s.inlineImage);
  if (visibleSegments.length === 0) return '';

  const startOffset = indentHanging > 0 ? -indentHanging : firstLineIndent;
  let anchor = 'start';
  let startX = boxX + startOffset;
  if (align === 'center') {
    anchor = 'middle';
    startX = boxX + boxWidth / 2;
  } else if (align === 'right') {
    anchor = 'end';
    startX = boxX + boxWidth;
  }

  // Handle hanging bullet marker (e.g. "•\t...") or flush-right tab stop at rightTabPosPx
  const tabIdx = visibleSegments.findIndex((s) => s.text === '\t');
  if (align === 'left' && tabIdx >= 0) {
    const beforeTab = visibleSegments.slice(0, tabIdx);
    const afterTab = visibleSegments.slice(tabIdx + 1);
    if (indentHanging > 0 && beforeTab.length <= 2) {
      const leftSvg = renderWrappedLineSvg(
        { segments: beforeTab, maxFontPx: line.maxFontPx },
        boxX,
        baselineY,
        boxWidth,
        'left',
        -indentHanging,
        0,
        undefined,
        onInlineImage
      );
      const rightSvg = renderWrappedLineSvg(
        { segments: afterTab, maxFontPx: line.maxFontPx },
        boxX,
        baselineY,
        boxWidth,
        'left',
        0,
        0,
        undefined,
        onInlineImage
      );
      return `${leftSvg}${rightSvg}`;
    }
    if (rightTabPosPx !== undefined && afterTab.length > 0) {
      const leftSvg = renderWrappedLineSvg(
        { segments: beforeTab, maxFontPx: line.maxFontPx },
        boxX,
        baselineY,
        boxWidth,
        'left',
        startOffset,
        0,
        undefined,
        onInlineImage
      );
      const rightX = boxX + Math.min(boxWidth, rightTabPosPx);
      const rightTsp = afterTab
        .map((seg) => {
          const attrs = [
            `font-family="${FONT_FAMILY}"`,
            `font-size="${seg.style.fontSizePx.toFixed(1)}"`,
            `fill="${seg.style.color}"`,
          ];
          if (seg.style.bold) attrs.push('font-weight="700"');
          if (seg.style.italic) attrs.push('font-style="italic"');
          return `<tspan ${attrs.join(' ')}>${escapeXml(seg.text)}</tspan>`;
        })
        .join('');
      return `${leftSvg}<text x="${rightX.toFixed(1)}" y="${baselineY.toFixed(
        1
      )}" text-anchor="end" xml:space="preserve">${rightTsp}</text>`;
    }
  }

  const makeTspan = (seg: StyledSpan, txt: string) => {
    const attrs = [
      `font-family="${FONT_FAMILY}"`,
      `font-size="${seg.style.fontSizePx.toFixed(1)}"`,
      `fill="${seg.style.color}"`,
    ];
    if (seg.style.bold) attrs.push('font-weight="700"');
    if (seg.style.italic) attrs.push('font-style="italic"');
    if (seg.style.underline) attrs.push('text-decoration="underline"');
    return `<tspan ${attrs.join(' ')}>${escapeXml(txt)}</tspan>`;
  };

  if (align === 'left' && visibleSegments.some((s) => s.style.highlight || s.style.border || s.inlineImage)) {
    const outSvg: string[] = [];
    let cursorX = startX;
    let chunkStartX = cursorX;
    let chunkTspans = '';

    const flushChunk = () => {
      if (!chunkTspans) return;
      outSvg.push(
        `<text x="${chunkStartX.toFixed(1)}" y="${baselineY.toFixed(
          1
        )}" text-anchor="start" xml:space="preserve">${chunkTspans}</text>`
      );
      chunkTspans = '';
    };

    for (const seg of visibleSegments) {
      if (seg.inlineImage) {
        flushChunk();
        onInlineImage?.(
          seg.inlineImage.rId,
          cursorX,
          baselineY - seg.inlineImage.height * 0.85,
          seg.inlineImage.width,
          seg.inlineImage.height
        );
        cursorX += seg.inlineImage.width + 3;
        chunkStartX = cursorX;
        continue;
      }

      const displaySeg = seg.text === '\t' ? { ...seg, text: '  ' } : seg;
      const segW = spanWidthPx(displaySeg);
      if (displaySeg.style.highlight || displaySeg.style.border) {
        flushChunk();
        const padX = 2.5;
        const h = displaySeg.style.fontSizePx * 1.24;
        const fill = displaySeg.style.highlight || 'none';
        const strokeAttr = displaySeg.style.border ? ` stroke="${displaySeg.style.border}" stroke-width="0.75"` : '';
        outSvg.push(
          `<rect x="${cursorX.toFixed(1)}" y="${(baselineY - displaySeg.style.fontSizePx * 0.94).toFixed(
            1
          )}" width="${Math.max(6, segW + padX * 2).toFixed(1)}" height="${h.toFixed(
            1
          )}" fill="${fill}"${strokeAttr} rx="2"/>`
        );
        outSvg.push(
          `<text x="${(cursorX + padX).toFixed(1)}" y="${baselineY.toFixed(
            1
          )}" text-anchor="start" xml:space="preserve">${makeTspan(displaySeg, displaySeg.text)}</text>`
        );
        cursorX += segW + padX * 2 + 1.5;
        chunkStartX = cursorX;
      } else {
        if (!chunkTspans) chunkStartX = cursorX;
        chunkTspans += makeTspan(displaySeg, displaySeg.text);
        cursorX += segW;
      }
    }
    flushChunk();
    return outSvg.join('');
  }

  const textSegments = visibleSegments.filter((s) => !s.inlineImage);
  if (textSegments.length === 0) return '';

  const tspans = textSegments
    .map((seg) => makeTspan(seg, seg.text === '\t' ? '  ' : seg.text))
    .join('');

  return `<text x="${startX.toFixed(1)}" y="${baselineY.toFixed(
    1
  )}" text-anchor="${anchor}" xml:space="preserve">${tspans}</text>`;
}

function parseBorderSpec(node: XmlNode | undefined): CellBorderSpec | undefined {
  if (!node) return undefined;
  const val = node.attrs['w:val'] ?? node.attrs['val'] ?? 'single';
  if (val === 'none' || val === 'nil') {
    return { width: 0, color: 'transparent', none: true };
  }
  const szRaw = Number(node.attrs['w:sz'] ?? node.attrs['sz'] ?? 4);
  const width = Math.max(0.6, Math.min(4, (Number.isFinite(szRaw) ? szRaw : 4) / 6));
  const color = normalizeHex(node.attrs['w:color'] ?? node.attrs['color'], '#CBD5E1');
  return { width, color };
}

function parseBordersNode(node: XmlNode | undefined): CellBorders {
  if (!node) return {};
  return {
    top: parseBorderSpec(findChild(node, 'top')),
    bottom: parseBorderSpec(findChild(node, 'bottom')),
    left: parseBorderSpec(findChild(node, 'left')),
    right: parseBorderSpec(findChild(node, 'right')),
    insideH: parseBorderSpec(findChild(node, 'insideH')),
    insideV: parseBorderSpec(findChild(node, 'insideV')),
  };
}

function parseStylesXml(xml: string | undefined): { defaults: StyleDef; styles: Map<string, StyleDef> } {
  const defaults: StyleDef = {
    fontSizePx: 14,
    bold: false,
    italic: false,
    color: '#1E293B',
    spaceBefore: 0,
    spaceAfter: 6,
    lineMult: 1.42,
    align: 'left',
  };
  const styles = new Map<string, StyleDef>();
  if (!xml) return { defaults, styles };

  const root = parseXmlTree(xml);
  const docDefaults = findChild(root, 'docDefaults');
  const defRPr = findDescendant(findChild(docDefaults, 'rPrDefault'), 'rPr');
  const defPPr = findDescendant(findChild(docDefaults, 'pPrDefault'), 'pPr');

  const szNode = findChild(defRPr, 'sz');
  if (szNode?.attrs.val) defaults.fontSizePx = Math.max(10, (Number(szNode.attrs.val) / 2) * (4 / 3));
  const colorNode = findChild(defRPr, 'color');
  if (colorNode?.attrs.val) defaults.color = normalizeHex(colorNode.attrs.val, '#1E293B');
  const defSpacing = findChild(defPPr, 'spacing');
  if (defSpacing?.attrs.after) defaults.spaceAfter = twipsToPx(defSpacing.attrs.after, 6);

  for (const st of findChildren(root, 'style')) {
    const id = st.attrs.styleId;
    if (!id) continue;
    const nameNode = findChild(st, 'name');
    const name = nameNode?.attrs.val || id;
    const pPr = findChild(st, 'pPr');
    const rPr = findChild(st, 'rPr');
    const def: StyleDef = { name };

    if (/heading\s*1|^1$|title/i.test(name) || /heading1/i.test(id)) {
      def.fontSizePx = 22;
      def.bold = true;
      def.spaceBefore = 12;
      def.spaceAfter = 6;
    } else if (/heading\s*2|^2$/i.test(name) || /heading2/i.test(id)) {
      def.fontSizePx = 18;
      def.bold = true;
      def.spaceBefore = 10;
      def.spaceAfter = 5;
    } else if (/heading\s*3|^3$/i.test(name) || /heading3/i.test(id)) {
      def.fontSizePx = 16;
      def.bold = true;
      def.spaceBefore = 8;
      def.spaceAfter = 4;
    }

    const jc = findChild(pPr, 'jc')?.attrs.val;
    if (jc === 'center' || jc === 'right' || jc === 'left' || jc === 'both') {
      def.align = jc === 'both' ? 'justify' : jc;
    }
    const sp = findChild(pPr, 'spacing');
    if (sp?.attrs.before) def.spaceBefore = twipsToPx(sp.attrs.before, 0);
    if (sp?.attrs.after) def.spaceAfter = twipsToPx(sp.attrs.after, 6);

    const rSz = findChild(rPr, 'sz')?.attrs.val;
    if (rSz) def.fontSizePx = Math.max(9, (Number(rSz) / 2) * (4 / 3));
    const rB = isEnabledFlag(findChild(rPr, 'b'));
    if (rB !== undefined) def.bold = rB;
    const rI = isEnabledFlag(findChild(rPr, 'i'));
    if (rI !== undefined) def.italic = rI;
    const rC = findChild(rPr, 'color')?.attrs.val;
    if (rC) def.color = normalizeHex(rC, '#1E293B');

    styles.set(id, def);
  }

  return { defaults, styles };
}

function parseRelsMap(relsXml: string | undefined, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const root = parseXmlTree(relsXml);
  for (const rel of findChildren(root, 'Relationship')) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target) continue;
    if (/^https?:\/\//i.test(target)) continue;
    const normalized = target.startsWith('/')
      ? target.slice(1)
      : path.posix.normalize(path.posix.join(baseDir, target));
    map.set(id, normalized);
  }
  return map;
}

function mergeTextStyle(base: TextStyle, rPr: XmlNode | undefined): TextStyle {
  if (!rPr) return base;
  const szVal = findChild(rPr, 'sz')?.attrs.val;
  const bVal = isEnabledFlag(findChild(rPr, 'b'));
  const iVal = isEnabledFlag(findChild(rPr, 'i'));
  const uNode = findChild(rPr, 'u');
  const uVal = uNode ? uNode.attrs.val !== 'none' : undefined;
  const colorVal = findChild(rPr, 'color')?.attrs.val;
  const shdVal = findChild(rPr, 'shd')?.attrs.fill;
  const hlVal = findChild(rPr, 'highlight')?.attrs.val;
  const rBdr = parseBorderSpec(findChild(rPr, 'bdr'));

  let highlight = base.highlight;
  if (hlVal && hlVal !== 'none') {
    const hlMap: Record<string, string> = {
      yellow: '#FEF08A',
      green: '#BBF7D0',
      cyan: '#A5F3FC',
      magenta: '#FBCFE8',
      blue: '#BFDBFE',
      lightGray: '#E2E8F0',
    };
    highlight = hlMap[hlVal] || '#FEF08A';
  } else if (shdVal && shdVal !== 'auto' && shdVal !== 'clear') {
    highlight = normalizeHex(shdVal);
  }
  const border = rBdr && !rBdr.none ? rBdr.color : base.border;

  return {
    fontSizePx: szVal ? Math.max(8, (Number(szVal) / 2) * (4 / 3)) : base.fontSizePx,
    bold: bVal !== undefined ? bVal : base.bold,
    italic: iVal !== undefined ? iVal : base.italic,
    underline: uVal !== undefined ? uVal : base.underline,
    color: colorVal ? normalizeHex(colorVal, base.color) : base.color,
    highlight,
    border,
  };
}

function parseParagraphNode(
  pNode: XmlNode,
  defaults: StyleDef,
  styles: Map<string, StyleDef>
): DocBlock[] {
  const pPr = findChild(pNode, 'pPr');
  const styleId = findChild(pPr, 'pStyle')?.attrs.val;
  const namedStyle = styleId ? styles.get(styleId) : undefined;

  const jc = findChild(pPr, 'jc')?.attrs.val;
  const align: 'left' | 'center' | 'right' | 'justify' =
    jc === 'center' || jc === 'right' || jc === 'left'
      ? jc
      : jc === 'both'
      ? 'justify'
      : namedStyle?.align ?? defaults.align ?? 'left';

  const sp = findChild(pPr, 'spacing');
  const spaceBefore = sp?.attrs.before !== undefined ? twipsToPx(sp.attrs.before, 0) : namedStyle?.spaceBefore ?? 0;
  const spaceAfter = sp?.attrs.after !== undefined ? twipsToPx(sp.attrs.after, 6) : namedStyle?.spaceAfter ?? 6;
  let lineMult = defaults.lineMult ?? 1.42;
  let exactLinePx: number | undefined;
  if (sp?.attrs.line) {
    if (sp.attrs.lineRule === 'exact') {
      const lp = Number(sp.attrs.line) / 15;
      if (Number.isFinite(lp) && lp >= 10 && lp <= 72) {
        exactLinePx = lp;
      }
    } else if (!sp.attrs.lineRule || sp.attrs.lineRule === 'auto') {
      const mult = Number(sp.attrs.line) / 240;
      if (Number.isFinite(mult) && mult >= 1.0 && mult <= 2.6) {
        lineMult = Math.max(1.25, mult * 1.12);
      }
    }
  }

  const ind = findChild(pPr, 'ind');
  const indentLeft = Math.max(0, signedTwipsToPx(ind?.attrs.left, 0));
  const indentFirst = Math.max(0, signedTwipsToPx(ind?.attrs.firstLine, 0));
  const indentHanging = Math.max(0, signedTwipsToPx(ind?.attrs.hanging, 0));

  const tabsNode = findChild(pPr, 'tabs');
  let rightTabPosPx: number | undefined;
  for (const tab of findChildren(tabsNode, 'tab')) {
    if (tab.attrs.val === 'right' && tab.attrs.pos) {
      rightTabPosPx = twipsToPx(tab.attrs.pos, 0);
    }
  }

  const shdFill = findChild(pPr, 'shd')?.attrs.fill;
  const shading = shdFill && shdFill !== 'auto' && shdFill !== 'clear' ? normalizeHex(shdFill) : undefined;

  const pBdr = findChild(pPr, 'pBdr');
  const borders: ParagraphBorder | undefined = pBdr
    ? {
        top: parseBorderSpec(findChild(pBdr, 'top'))?.none ? undefined : parseBorderSpec(findChild(pBdr, 'top'))?.color,
        bottom: parseBorderSpec(findChild(pBdr, 'bottom'))?.none ? undefined : parseBorderSpec(findChild(pBdr, 'bottom'))?.color,
        left: parseBorderSpec(findChild(pBdr, 'left'))?.none ? undefined : parseBorderSpec(findChild(pBdr, 'left'))?.color,
        right: parseBorderSpec(findChild(pBdr, 'right'))?.none ? undefined : parseBorderSpec(findChild(pBdr, 'right'))?.color,
      }
    : undefined;

  const pRPr = findChild(pPr, 'rPr');
  const baseTextStyle: TextStyle = mergeTextStyle(
    {
      fontSizePx: namedStyle?.fontSizePx ?? defaults.fontSizePx ?? 14,
      bold: namedStyle?.bold ?? defaults.bold ?? false,
      italic: namedStyle?.italic ?? defaults.italic ?? false,
      underline: false,
      color: namedStyle?.color ?? defaults.color ?? '#1E293B',
    },
    pRPr
  );

  const out: DocBlock[] = [];
  if (findChild(pPr, 'pageBreakBefore')) {
    out.push({ type: 'pageBreak' });
  }

  let spans: StyledSpan[] = [];
  if (findChild(pPr, 'numPr')) {
    spans.push({ text: '• ', style: { ...baseTextStyle, bold: true } });
  }

  const flushParagraph = (isTail: boolean) => {
    if (spans.length === 0 && !shading && !borders?.bottom && !borders?.left && !borders?.top && !isTail) return;
    out.push({
      type: 'paragraph',
      align,
      spaceBefore: out.length === 0 || out[out.length - 1]?.type === 'pageBreak' ? spaceBefore : 2,
      spaceAfter: isTail ? spaceAfter : 2,
      lineMult,
      exactLinePx,
      indentLeft,
      indentFirst,
      indentHanging,
      rightTabPosPx,
      shading,
      borders,
      spans,
    });
    spans = [];
  };

  const visitRunChild = (node: XmlNode, runStyle: TextStyle) => {
    const tag = localTag(node.tag);
    if (tag === 't' || tag === 'delText') {
      if (node.text) spans.push({ text: node.text, style: runStyle });
      return;
    }
    if (tag === 'tab') {
      spans.push({ text: '\t', style: runStyle });
      return;
    }
    if (tag === 'br') {
      if (node.attrs.type === 'page') {
        if (spans.length > 0) flushParagraph(false);
        out.push({ type: 'pageBreak' });
      } else {
        spans.push({ text: '\n', style: runStyle });
      }
      return;
    }
    if (tag === 'AlternateContent') {
      const choice = findChild(node, 'Choice');
      const branch = choice ?? findChild(node, 'Fallback');
      if (branch) {
        for (const c of branch.children) visitRunChild(c, runStyle);
      }
      return;
    }
    if (tag === 'drawing') {
      const blip = findDescendant(node, 'blip');
      const rId = blip?.attrs['r:embed'] || blip?.attrs['r:link'] || blip?.attrs.embed || blip?.attrs.link;
      if (rId) {
        const extent = findDescendant(node, 'extent');
        const cx = Number(extent?.attrs.cx);
        const cy = Number(extent?.attrs.cy);
        const tw = Number.isFinite(cx) && cx > 0 ? cx / 9525 : undefined;
        const th = Number.isFinite(cy) && cy > 0 ? cy / 9525 : undefined;
        if (tw && th && tw <= 32 && th <= 32) {
          spans.push({
            text: '',
            style: runStyle,
            inlineImage: { rId, width: tw, height: th },
          });
        } else {
          if (spans.length > 0) flushParagraph(false);
          out.push({
            type: 'image',
            rId,
            align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
            targetW: tw,
            targetH: th,
            spaceBefore: Math.max(4, spaceBefore),
            spaceAfter: Math.max(4, spaceAfter),
          });
        }
      }
      const txbx = findDescendant(node, 'txbxContent');
      if (txbx && !rId) {
        for (const innerP of findChildren(txbx, 'p')) {
          out.push(...parseParagraphNode(innerP, defaults, styles));
        }
      }
      return;
    }
    if (tag === 'pict') {
      const imgData = findDescendant(node, 'imagedata');
      const rId = imgData?.attrs['r:id'] || imgData?.attrs.id;
      if (rId) {
        if (spans.length > 0) flushParagraph(false);
        out.push({
          type: 'image',
          rId,
          align: align === 'right' ? 'right' : align === 'center' ? 'center' : 'left',
          spaceBefore: Math.max(4, spaceBefore),
          spaceAfter: Math.max(4, spaceAfter),
        });
      }
      return;
    }
    if (tag === 'r') {
      const nestedStyle = mergeTextStyle(runStyle, findChild(node, 'rPr'));
      for (const c of node.children) visitRunChild(c, nestedStyle);
      return;
    }
    // Check nested content like smartTag / sdtContent / fldSimple
    for (const c of node.children) {
      if (localTag(c.tag) !== 'instrText') {
        visitRunChild(c, runStyle);
      }
    }
  };

  for (const child of pNode.children) {
    const tag = localTag(child.tag);
    if (tag === 'pPr' || tag === 'bookmarkStart' || tag === 'bookmarkEnd') continue;
    if (tag === 'r') {
      const rStyle = mergeTextStyle(baseTextStyle, findChild(child, 'rPr'));
      for (const rc of child.children) {
        if (localTag(rc.tag) !== 'rPr' && localTag(rc.tag) !== 'instrText') {
          visitRunChild(rc, rStyle);
        }
      }
    } else if (tag === 'hyperlink' || tag === 'fldSimple' || tag === 'sdt') {
      visitRunChild(child, baseTextStyle);
    } else if (tag === 'AlternateContent' || tag === 'drawing' || tag === 'pict') {
      visitRunChild(child, baseTextStyle);
    }
  }

  const pSectPr = findChild(pPr, 'sectPr');
  const sectType = findChild(pSectPr, 'type')?.attrs.val;
  const endsSection = Boolean(pSectPr && sectType !== 'continuous');

  const hasImageTail = out.length > 0 && out[out.length - 1].type === 'image' && spans.length === 0;
  if (!hasImageTail) {
    if (spans.length > 0 || (out.length === 0 && !endsSection)) {
      flushParagraph(true);
    }
  }
  if (endsSection) {
    out.push({ type: 'pageBreak' });
  }

  return out;
}

function parseTableNode(
  tblNode: XmlNode,
  defaults: StyleDef,
  styles: Map<string, StyleDef>
): ParsedTable {
  const tblPr = findChild(tblNode, 'tblPr');
  const jc = findChild(tblPr, 'jc')?.attrs.val;
  const align: 'left' | 'center' | 'right' = jc === 'center' || jc === 'right' ? jc : 'left';
  const tblBorders = parseBordersNode(findChild(tblPr, 'tblBorders'));

  const tblMar = findChild(tblPr, 'tblCellMar');
  const defaultPad = {
    top: twipsToPx(findChild(tblMar, 'top')?.attrs.w, 5),
    bottom: twipsToPx(findChild(tblMar, 'bottom')?.attrs.w, 5),
    left: twipsToPx(findChild(tblMar, 'left')?.attrs.w, 8),
    right: twipsToPx(findChild(tblMar, 'right')?.attrs.w, 8),
  };

  const tblGrid = findChild(tblNode, 'tblGrid');
  const colWidthsPx = findChildren(tblGrid, 'gridCol').map((gc) => twipsToPx(gc.attrs.w, 120));

  const rows: ParsedRow[] = [];
  for (const tr of findChildren(tblNode, 'tr')) {
    const trPr = findChild(tr, 'trPr');
    const isHeader = Boolean(findChild(trPr, 'tblHeader'));
    const cells: ParsedCell[] = [];

    for (const tc of findChildren(tr, 'tc')) {
      const tcPr = findChild(tc, 'tcPr');
      const gridSpan = Math.max(1, Number(findChild(tcPr, 'gridSpan')?.attrs.val || 1));
      const vMergeNode = findChild(tcPr, 'vMerge');
      const vMerge = vMergeNode ? (vMergeNode.attrs.val === 'restart' ? 'restart' : 'continue') : undefined;
      const tcWAttr = findChild(tcPr, 'tcW');
      const widthPx =
        tcWAttr?.attrs.type === 'dxa' && tcWAttr?.attrs.w ? twipsToPx(tcWAttr.attrs.w, 0) : undefined;

      const tcMar = findChild(tcPr, 'tcMar');
      const padTop = findChild(tcMar, 'top')?.attrs.w ? twipsToPx(findChild(tcMar, 'top')?.attrs.w, defaultPad.top) : defaultPad.top;
      const padBottom = findChild(tcMar, 'bottom')?.attrs.w
        ? twipsToPx(findChild(tcMar, 'bottom')?.attrs.w, defaultPad.bottom)
        : defaultPad.bottom;
      const padLeft = findChild(tcMar, 'left')?.attrs.w
        ? twipsToPx(findChild(tcMar, 'left')?.attrs.w, defaultPad.left)
        : defaultPad.left;
      const padRight = findChild(tcMar, 'right')?.attrs.w
        ? twipsToPx(findChild(tcMar, 'right')?.attrs.w, defaultPad.right)
        : defaultPad.right;

      const shdFill = findChild(tcPr, 'shd')?.attrs.fill;
      const shading = shdFill && shdFill !== 'auto' && shdFill !== 'clear' ? normalizeHex(shdFill) : undefined;
      const vAlignRaw = findChild(tcPr, 'vAlign')?.attrs.val;
      const vAlign: 'top' | 'center' | 'bottom' =
        vAlignRaw === 'center' || vAlignRaw === 'bottom' ? vAlignRaw : 'top';
      const borders = parseBordersNode(findChild(tcPr, 'tcBorders'));

      const blocks: DocBlock[] = [];
      for (const child of tc.children) {
        const tag = localTag(child.tag);
        if (tag === 'p') {
          blocks.push(...parseParagraphNode(child, defaults, styles));
        } else if (tag === 'tbl') {
          // Flatten nested tables sequentially inside cell
          const nested = parseTableNode(child, defaults, styles);
          for (const nr of nested.rows) {
            for (const nc of nr.cells) {
              blocks.push(...nc.blocks);
            }
          }
        }
      }

      cells.push({
        gridSpan,
        vMerge,
        widthPx,
        padTop,
        padBottom,
        padLeft,
        padRight,
        shading,
        vAlign,
        borders,
        blocks,
      });
    }

    if (cells.length > 0) {
      rows.push({ isHeader, cells });
    }
  }

  return {
    align,
    colWidthsPx,
    borders: tblBorders,
    defaultPad,
    rows,
  };
}

function parseBodyChildren(
  bodyNode: XmlNode,
  defaults: StyleDef,
  styles: Map<string, StyleDef>
): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const child of bodyNode.children) {
    const tag = localTag(child.tag);
    if (tag === 'p') {
      blocks.push(...parseParagraphNode(child, defaults, styles));
    } else if (tag === 'tbl') {
      blocks.push({ type: 'table', block: parseTableNode(child, defaults, styles) });
    } else if (tag === 'sdt') {
      const sdtContent = findChild(child, 'sdtContent');
      if (sdtContent) {
        blocks.push(...parseBodyChildren(sdtContent, defaults, styles));
      }
    }
  }
  return blocks;
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
        // Always detach pooled Buffer slice so byteOffset === 0 for pdf-lib JpegEmbedder
        const pdfImage = await pdfDoc.embedJpg(Uint8Array.from(rawBuf));
        return { pdfImage, naturalW: meta.width, naturalH: meta.height };
      } catch {
        // Fall through to sharp normalization (e.g., CMYK or non-standard JPEG)
      }
    }

    if (meta.format === 'png' && !needsRotate && !isOversized) {
      try {
        const pdfImage = await pdfDoc.embedPng(Uint8Array.from(rawBuf));
        return { pdfImage, naturalW: meta.width, naturalH: meta.height };
      } catch {
        // Fall through to sharp normalization
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

function fitImageDimensions(
  naturalW: number,
  naturalH: number,
  targetW: number | undefined,
  targetH: number | undefined,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  let w = targetW && targetW > 4 ? targetW : naturalW;
  let h = targetH && targetH > 4 ? targetH : naturalH;

  if (w > maxWidth) {
    const s = maxWidth / w;
    w = maxWidth;
    h *= s;
  }
  if (h > maxHeight) {
    const s = maxHeight / h;
    h = maxHeight;
    w *= s;
  }
  return { width: Math.max(8, w), height: Math.max(8, h) };
}

interface MeasuredParagraph {
  lines: Array<{ segments: StyledSpan[]; maxFontPx: number }>;
  totalHeight: number;
  lineSpacingPx: number[];
}

function measureParagraph(
  p: Extract<DocBlock, { type: 'paragraph' }>,
  boxWidth: number
): MeasuredParagraph {
  const usableW = Math.max(36, boxWidth - p.indentLeft);
  const lines = wrapStyledSpans(p.spans, usableW, p.indentFirst, p.indentHanging);
  const lineSpacingPx: number[] = [];
  let totalHeight = 0;

  for (const line of lines) {
    const lh =
      line.segments.length === 0
        ? Math.max(10, line.maxFontPx * 0.7)
        : p.exactLinePx
        ? Math.max(12, p.exactLinePx)
        : Math.max(16, line.maxFontPx * p.lineMult);
    lineSpacingPx.push(lh);
    totalHeight += lh;
  }

  return { lines, totalHeight, lineSpacingPx };
}

function extractPlainHeaderText(xml: string | undefined): string {
  if (!xml) return '';
  const root = parseXmlTree(xml);
  const parts: string[] = [];
  const walk = (n: XmlNode) => {
    const t = localTag(n.tag);
    if (t === 't' && n.text) parts.push(n.text);
    if (t !== 'instrText') {
      for (const c of n.children) walk(c);
    }
  };
  walk(root);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export async function renderDocxToPdf(inputPath: string, outPdfPath: string): Promise<void> {
  const zipBytes = await fs.readFile(inputPath);
  const zip = await JSZip.loadAsync(zipBytes);
  const docFile = zip.files['word/document.xml'];
  if (!docFile) {
    throw new Error('DOCX 缺少 word/document.xml 主文档内容');
  }

  const docXml = await docFile.async('string');
  const relsXml = await zip.files['word/_rels/document.xml.rels']?.async('string');
  const stylesXml = await zip.files['word/styles.xml']?.async('string');

  const docRoot = parseXmlTree(docXml);
  const bodyNode = findChild(docRoot, 'body');
  if (!bodyNode) {
    throw new Error('DOCX 主文档结构异常（未找到 w:body）');
  }

  const relMap = parseRelsMap(relsXml, 'word');
  const { defaults, styles } = parseStylesXml(stylesXml);

  // Page dimensions & margins from last (body-level) sectPr
  const sectPr = findChild(bodyNode, 'sectPr') ?? findDescendant(bodyNode, 'sectPr');
  const pgSz = findChild(sectPr, 'pgSz');
  const pgMar = findChild(sectPr, 'pgMar');
  let pageW = twipsToPx(pgSz?.attrs.w, 794);
  let pageH = twipsToPx(pgSz?.attrs.h, 1123);
  if (pgSz?.attrs.orient === 'landscape' && pageW < pageH) {
    [pageW, pageH] = [pageH, pageW];
  }
  pageW = Math.max(520, Math.min(1600, pageW));
  pageH = Math.max(600, Math.min(2000, pageH));

  const marginLeft = Math.max(18, Math.min(110, twipsToPx(pgMar?.attrs.left, 64)));
  const marginRight = Math.max(18, Math.min(110, twipsToPx(pgMar?.attrs.right, 64)));
  const marginTop = Math.max(18, Math.min(120, twipsToPx(pgMar?.attrs.top, 70)));
  const marginBottom = Math.max(18, Math.min(120, twipsToPx(pgMar?.attrs.bottom, 70)));
  const contentW = pageW - marginLeft - marginRight;
  const usableBottom = pageH - marginBottom;

  // Optional header/footer text
  let headerText = '';
  const hdrRef = findChild(sectPr, 'headerReference');
  if (hdrRef?.attrs.id && relMap.has(hdrRef.attrs.id)) {
    const hdrPath = relMap.get(hdrRef.attrs.id)!;
    headerText = extractPlainHeaderText(await zip.files[hdrPath]?.async('string'));
  }

  // Parse body blocks
  const blocks = parseBodyChildren(bodyNode, defaults, styles);

  // Preload all referenced images into pdf-lib once
  const pdfDoc = await PDFDocument.create();
  const imageCache = new Map<string, PreparedImage | null>();
  const neededRelIds = new Set<string>();

  const collectImageIds = (list: DocBlock[]) => {
    for (const b of list) {
      if (b.type === 'image') neededRelIds.add(b.rId);
      else if (b.type === 'paragraph') {
        for (const s of b.spans) {
          if (s.inlineImage) neededRelIds.add(s.inlineImage.rId);
        }
      } else if (b.type === 'table') {
        for (const r of b.block.rows) {
          for (const c of r.cells) collectImageIds(c.blocks);
        }
      }
    }
  };
  collectImageIds(blocks);

  for (const rId of neededRelIds) {
    const targetPath = relMap.get(rId);
    if (!targetPath || !zip.files[targetPath]) {
      imageCache.set(rId, null);
      continue;
    }
    const buf = await zip.files[targetPath].async('nodebuffer');
    imageCache.set(rId, await preparePdfImage(pdfDoc, buf));
  }

  // Layout pages
  const pages: PageCanvas[] = [];
  let currentPage: PageCanvas = { svgElements: [], images: [] };
  let cursorY = marginTop;

  const startNewPage = () => {
    if (currentPage.svgElements.length > 0 || currentPage.images.length > 0) {
      pages.push(currentPage);
    }
    currentPage = { svgElements: [], images: [] };
    cursorY = marginTop;
  };

  const ensureSpace = (neededH: number) => {
    if (cursorY > marginTop + 2 && cursorY + neededH > usableBottom) {
      startNewPage();
    }
  };

  const drawParagraph = (
    p: Extract<DocBlock, { type: 'paragraph' }>,
    x: number,
    width: number,
    inCell: boolean
  ) => {
    const measured = measureParagraph(p, width);
    const spaceBefore = !inCell && cursorY <= marginTop + 1 ? 0 : Math.min(20, p.spaceBefore);
    const spaceAfter = Math.min(18, p.spaceAfter);

    if (!inCell) {
      ensureSpace(spaceBefore + measured.totalHeight);
    }

    const startY = cursorY + (cursorY <= marginTop + 1 && !inCell ? 0 : spaceBefore);

    if (p.shading) {
      currentPage.svgElements.push(
        `<rect x="${x.toFixed(1)}" y="${startY.toFixed(1)}" width="${width.toFixed(1)}" height="${(
          measured.totalHeight + 4
        ).toFixed(1)}" fill="${p.shading}" rx="2"/>`
      );
    }
    if (p.borders?.left) {
      currentPage.svgElements.push(
        `<rect x="${x.toFixed(1)}" y="${startY.toFixed(1)}" width="3" height="${(
          measured.totalHeight + 2
        ).toFixed(1)}" fill="${p.borders.left}"/>`
      );
    }

    if (p.borders?.top) {
      currentPage.svgElements.push(
        `<line x1="${x.toFixed(1)}" y1="${(startY - 3).toFixed(1)}" x2="${(x + width).toFixed(1)}" y2="${(
          startY - 3
        ).toFixed(1)}" stroke="${p.borders.top}" stroke-width="0.9"/>`
      );
    }

    let lineY = startY;
    for (let i = 0; i < measured.lines.length; i++) {
      const line = measured.lines[i];
      const lh = measured.lineSpacingPx[i];
      if (!inCell && lineY + lh > usableBottom) {
        startNewPage();
        lineY = cursorY;
      }
      const baseline = lineY + Math.min(lh * 0.78, (line.maxFontPx || 14) * 0.96);
      const lineSvg = renderWrappedLineSvg(
        line,
        x + p.indentLeft,
        baseline,
        Math.max(36, width - p.indentLeft),
        p.align,
        i === 0 ? p.indentFirst : 0,
        i === 0 ? p.indentHanging : 0,
        i === 0 ? p.rightTabPosPx : undefined,
        (rId, ix, iy, iw, ih) => {
          const prep = imageCache.get(rId);
          if (prep) {
            currentPage.images.push({ image: prep, x: ix, y: iy, width: iw, height: ih });
          }
        }
      );
      if (lineSvg) currentPage.svgElements.push(lineSvg);
      lineY += lh;
    }

    if (p.borders?.bottom) {
      currentPage.svgElements.push(
        `<line x1="${x.toFixed(1)}" y1="${(lineY + 2).toFixed(1)}" x2="${(x + width).toFixed(1)}" y2="${(
          lineY + 2
        ).toFixed(1)}" stroke="${p.borders.bottom}" stroke-width="1"/>`
      );
    }

    cursorY = lineY + (inCell ? Math.min(4, spaceAfter) : spaceAfter);
  };

  for (const block of blocks) {
    if (block.type === 'pageBreak') {
      if (cursorY > marginTop + 2 || currentPage.images.length > 0 || currentPage.svgElements.length > 0) {
        startNewPage();
      }
      continue;
    }

    if (block.type === 'paragraph') {
      drawParagraph(block, marginLeft, contentW, false);
      continue;
    }

    if (block.type === 'image') {
      const prep = imageCache.get(block.rId);
      if (!prep) continue;
      const maxImgH = usableBottom - marginTop - 16;
      const dims = fitImageDimensions(
        prep.naturalW,
        prep.naturalH,
        block.targetW,
        block.targetH,
        contentW,
        maxImgH
      );
      const spaceBefore = cursorY <= marginTop + 1 ? 0 : Math.min(12, block.spaceBefore);
      ensureSpace(spaceBefore + dims.height);

      const drawY = cursorY + (cursorY <= marginTop + 1 ? 0 : spaceBefore);
      let drawX = marginLeft;
      if (block.align === 'center') drawX = marginLeft + (contentW - dims.width) / 2;
      else if (block.align === 'right') drawX = marginLeft + contentW - dims.width;

      currentPage.images.push({
        image: prep,
        x: drawX,
        y: drawY,
        width: dims.width,
        height: dims.height,
      });
      cursorY = drawY + dims.height + Math.min(12, block.spaceAfter);
      continue;
    }

    if (block.type === 'table') {
      const tbl = block.block;
      if (tbl.rows.length === 0) continue;
      if (tbl.rows[0]?.cells[0]?.blocks[0]?.type === 'pageBreak') {
        tbl.rows[0].cells[0].blocks.shift();
        if (cursorY > marginTop + 2 || currentPage.images.length > 0 || currentPage.svgElements.length > 0) {
          startNewPage();
        }
      }

      const maxCols = Math.max(
        tbl.colWidthsPx.length,
        ...tbl.rows.map((r) => r.cells.reduce((sum, c) => sum + c.gridSpan, 0))
      );
      let rawColWidths =
        tbl.colWidthsPx.length >= maxCols
          ? tbl.colWidthsPx.slice(0, maxCols)
          : Array.from({ length: maxCols }, (_, i) => tbl.colWidthsPx[i] || contentW / maxCols);

      const rawTotalW = rawColWidths.reduce((s, w) => s + w, 0) || contentW;
      if (rawTotalW > contentW || rawTotalW < contentW * 0.45) {
        const scale = contentW / rawTotalW;
        rawColWidths = rawColWidths.map((w) => w * scale);
      }
      const totalTableW = rawColWidths.reduce((s, w) => s + w, 0);
      const tableX =
        tbl.align === 'center'
          ? marginLeft + Math.max(0, (contentW - totalTableW) / 2)
          : tbl.align === 'right'
          ? marginLeft + Math.max(0, contentW - totalTableW)
          : marginLeft;

      const usableH = usableBottom - marginTop;

      const measureRowLayout = (row: ParsedRow) => {
        let colIdx = 0;
        const cellLayouts: Array<{
          cell: ParsedCell;
          x: number;
          w: number;
          innerH: number;
          items: Array<
            | { kind: 'p'; p: Extract<DocBlock, { type: 'paragraph' }>; measured: MeasuredParagraph }
            | { kind: 'img'; prep: PreparedImage; w: number; h: number; align: 'left' | 'center' | 'right' }
          >;
        }> = [];

        for (const cell of row.cells) {
          const span = Math.min(cell.gridSpan, Math.max(1, maxCols - colIdx));
          let cellW = 0;
          for (let k = 0; k < span; k++) cellW += rawColWidths[colIdx + k] || contentW / maxCols;
          const cellX =
            tableX +
            rawColWidths.slice(0, colIdx).reduce((s, w) => s + w, 0);
          colIdx += span;

          const innerW = Math.max(24, cellW - cell.padLeft - cell.padRight);
          const items: (typeof cellLayouts)[number]['items'] = [];
          let innerH = 0;

          for (const b of cell.blocks) {
            if (b.type === 'paragraph') {
              const m = measureParagraph(b, innerW);
              const sb = innerH === 0 ? 0 : Math.min(8, b.spaceBefore);
              const sa = Math.min(6, b.spaceAfter);
              items.push({ kind: 'p', p: b, measured: m });
              innerH += sb + m.totalHeight + sa;
            } else if (b.type === 'image') {
              const prep = imageCache.get(b.rId);
              if (!prep) continue;
              const dims = fitImageDimensions(
                prep.naturalW,
                prep.naturalH,
                b.targetW,
                b.targetH,
                innerW,
                Math.max(120, usableH - cell.padTop - cell.padBottom - 40)
              );
              items.push({ kind: 'img', prep, w: dims.width, h: dims.height, align: b.align });
              innerH += dims.height + 6;
            }
          }

          // Shrink images proportionally if a single cell exceeds usableH
          const maxInnerH = Math.max(40, usableH - cell.padTop - cell.padBottom - 8);
          if (innerH > maxInnerH) {
            const imgSum = items.reduce((s, it) => s + (it.kind === 'img' ? it.h : 0), 0);
            const textSum = Math.max(0, innerH - imgSum);
            if (imgSum > 0) {
              const availImgH = Math.max(60, maxInnerH - textSum);
              const scale = Math.min(1, availImgH / imgSum);
              innerH = textSum;
              for (const it of items) {
                if (it.kind === 'img') {
                  it.w *= scale;
                  it.h *= scale;
                  innerH += it.h;
                }
              }
            }
          }

          cellLayouts.push({ cell, x: cellX, w: cellW, innerH, items });
        }

        const rowH = Math.max(
          22,
          ...cellLayouts.map((cl) => cl.innerH + cl.cell.padTop + cl.cell.padBottom)
        );
        return { rowH, cellLayouts };
      };

      const drawRowLayout = (
        layout: ReturnType<typeof measureRowLayout>,
        rowIdx: number,
        totalRows: number
      ) => {
        const y0 = cursorY;
        const { rowH, cellLayouts } = layout;

        for (let cIdx = 0; cIdx < cellLayouts.length; cIdx++) {
          const cl = cellLayouts[cIdx];
          const c = cl.cell;
          if (c.shading) {
            currentPage.svgElements.push(
              `<rect x="${cl.x.toFixed(1)}" y="${y0.toFixed(1)}" width="${cl.w.toFixed(
                1
              )}" height="${rowH.toFixed(1)}" fill="${c.shading}"/>`
            );
          }

          const topBorder =
            c.borders.top ?? (rowIdx === 0 ? tbl.borders.top : tbl.borders.insideH) ?? {
              width: 0.75,
              color: '#CBD5E1',
            };
          const bottomBorder =
            c.borders.bottom ??
            (rowIdx === totalRows - 1 ? tbl.borders.bottom : tbl.borders.insideH) ?? {
              width: 0.75,
              color: '#CBD5E1',
            };
          const leftBorder =
            c.borders.left ?? (cIdx === 0 ? tbl.borders.left : tbl.borders.insideV);
          const rightBorder =
            c.borders.right ?? (cIdx === cellLayouts.length - 1 ? tbl.borders.right : tbl.borders.insideV);

          if (topBorder && !topBorder.none) {
            currentPage.svgElements.push(
              `<line x1="${cl.x.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${(cl.x + cl.w).toFixed(
                1
              )}" y2="${y0.toFixed(1)}" stroke="${topBorder.color}" stroke-width="${topBorder.width}"/>`
            );
          }
          if (bottomBorder && !bottomBorder.none) {
            currentPage.svgElements.push(
              `<line x1="${cl.x.toFixed(1)}" y1="${(y0 + rowH).toFixed(1)}" x2="${(cl.x + cl.w).toFixed(
                1
              )}" y2="${(y0 + rowH).toFixed(1)}" stroke="${bottomBorder.color}" stroke-width="${bottomBorder.width}"/>`
            );
          }
          if (leftBorder && !leftBorder.none) {
            currentPage.svgElements.push(
              `<line x1="${cl.x.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${cl.x.toFixed(1)}" y2="${(
                y0 + rowH
              ).toFixed(1)}" stroke="${leftBorder.color}" stroke-width="${leftBorder.width}"/>`
            );
          }
          if (rightBorder && !rightBorder.none) {
            currentPage.svgElements.push(
              `<line x1="${(cl.x + cl.w).toFixed(1)}" y1="${y0.toFixed(1)}" x2="${(
                cl.x + cl.w
              ).toFixed(1)}" y2="${(y0 + rowH).toFixed(1)}" stroke="${rightBorder.color}" stroke-width="${rightBorder.width}"/>`
            );
          }

          let cellY = y0 + c.padTop;
          if (c.vAlign === 'center') {
            cellY = y0 + Math.max(c.padTop, (rowH - cl.innerH) / 2);
          } else if (c.vAlign === 'bottom') {
            cellY = y0 + Math.max(c.padTop, rowH - c.padBottom - cl.innerH);
          }

          const innerX = cl.x + c.padLeft;
          const innerW = Math.max(24, cl.w - c.padLeft - c.padRight);

          for (let itemIdx = 0; itemIdx < cl.items.length; itemIdx++) {
            const it = cl.items[itemIdx];
            if (it.kind === 'p') {
              if (itemIdx > 0) cellY += Math.min(6, it.p.spaceBefore);
              for (let lIdx = 0; lIdx < it.measured.lines.length; lIdx++) {
                const line = it.measured.lines[lIdx];
                const lh = it.measured.lineSpacingPx[lIdx];
                const baseline = cellY + Math.min(lh * 0.78, (line.maxFontPx || 14) * 0.96);
                const svg = renderWrappedLineSvg(
                  line,
                  innerX + it.p.indentLeft,
                  baseline,
                  Math.max(24, innerW - it.p.indentLeft),
                  it.p.align,
                  lIdx === 0 ? it.p.indentFirst : 0,
                  lIdx === 0 ? it.p.indentHanging : 0,
                  lIdx === 0 ? it.p.rightTabPosPx : undefined,
                  (rId, ix, iy, iw, ih) => {
                    const prep = imageCache.get(rId);
                    if (prep) {
                      currentPage.images.push({ image: prep, x: ix, y: iy, width: iw, height: ih });
                    }
                  }
                );
                if (svg) currentPage.svgElements.push(svg);
                cellY += lh;
              }
              cellY += Math.min(4, it.p.spaceAfter);
            } else if (it.kind === 'img') {
              let imgX = innerX;
              if (it.align === 'center') imgX = innerX + Math.max(0, (innerW - it.w) / 2);
              else if (it.align === 'right') imgX = innerX + Math.max(0, innerW - it.w);
              currentPage.images.push({
                image: it.prep,
                x: imgX,
                y: cellY,
                width: it.w,
                height: it.h,
              });
              cellY += it.h + 4;
            }
          }
        }

        cursorY = y0 + rowH;
      };

      const headerRows = tbl.rows.filter((r) => r.isHeader);
      const measuredRows = tbl.rows.map((r) => measureRowLayout(r));

      for (let rIdx = 0; rIdx < measuredRows.length; rIdx++) {
        const layout = measuredRows[rIdx];
        if (cursorY > marginTop + 2 && cursorY + layout.rowH > usableBottom) {
          startNewPage();
          if (headerRows.length > 0 && !tbl.rows[rIdx].isHeader) {
            for (let hIdx = 0; hIdx < headerRows.length; hIdx++) {
              drawRowLayout(measuredRows[hIdx], 0, tbl.rows.length);
            }
          }
        }
        drawRowLayout(layout, rIdx, tbl.rows.length);
      }

      cursorY += 8;
    }
  }

  if (currentPage.svgElements.length > 0 || currentPage.images.length > 0 || pages.length === 0) {
    pages.push(currentPage);
  }

  // Suppress synthetic page numbers when margins are tight or document already embeds page-number footers
  const hasExplicitPageFooter = blocks.some(
    (b) =>
      b.type === 'paragraph' &&
      /(?:第\s*\d+\s*页|Page\s*\d+\s*(?:\/|of)\s*\d+)/i.test(b.spans.map((s) => s.text).join(''))
  );

  // Render pages cleanly into pdf-lib
  const totalPages = pages.length;
  const pagePtW = pageW * 0.75;
  const pagePtH = pageH * 0.75;
  const rasterScale = 1.5;

  for (let pIdx = 0; pIdx < totalPages; pIdx++) {
    const pData = pages[pIdx];
    const headerSvg = headerText
      ? `<text x="${(pageW - marginRight).toFixed(1)}" y="${Math.max(24, marginTop * 0.5).toFixed(
          1
        )}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="11" fill="#64748B">${escapeXml(
          headerText
        )}</text><line x1="${marginLeft}" y1="${Math.max(30, marginTop * 0.58).toFixed(1)}" x2="${(
          pageW - marginRight
        ).toFixed(1)}" y2="${Math.max(30, marginTop * 0.58).toFixed(
          1
        )}" stroke="#E2E8F0" stroke-width="0.75"/>`
      : '';

    const footerSvg =
      marginBottom >= 54 && !hasExplicitPageFooter
        ? `<text x="${(pageW / 2).toFixed(1)}" y="${(pageH - Math.max(16, marginBottom * 0.38)).toFixed(
            1
          )}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="11" fill="#94A3B8">第 ${
            pIdx + 1
          } 页 / 共 ${totalPages} 页</text>`
        : '';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pageW} ${pageH}" width="${Math.round(
      pageW * rasterScale
    )}" height="${Math.round(pageH * rasterScale)}">
      <rect width="${pageW}" height="${pageH}" fill="#FFFFFF"/>
      ${headerSvg}
      ${pData.svgElements.join('\n')}
      ${footerSvg}
    </svg>`;

    const bgPng = await sharp(Buffer.from(svg)).png({ compressionLevel: 5 }).toBuffer();
    const bgEmbedded = await pdfDoc.embedPng(bgPng);
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
