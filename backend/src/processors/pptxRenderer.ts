import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, degrees, type PDFImage } from 'pdf-lib';
import sharp from 'sharp';
import { parseXmlTree } from './docxRenderer.js';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

interface ColorSpec {
  hex: string;
  alpha: number; // 0..1
}

interface GradientStop {
  pos: number; // 0..100
  color: ColorSpec;
}

type FillSpec =
  | { kind: 'none' }
  | { kind: 'solid'; color: ColorSpec }
  | { kind: 'gradient'; angleDeg: number; stops: GradientStop[] };

interface LineStyle {
  widthPx: number;
  color: ColorSpec;
  dash?: 'dash' | 'dot' | 'dashDot';
}

interface PptTextRun {
  text: string;
  fontSizePx: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: ColorSpec;
}

interface PptParagraph {
  align: 'left' | 'center' | 'right';
  lineMult: number;
  lineFixedPx?: number;
  spaceBeforePx: number;
  spaceAfterPx: number;
  marginLeftPx: number;
  indentPx: number;
  runs: PptTextRun[];
  emptyHeightPx: number;
}

interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rotDeg: number;
  flipH: boolean;
  flipV: boolean;
}

interface PptTableCell {
  rowSpan: number;
  colSpan: number;
  hMerge: boolean;
  vMerge: boolean;
  fill: FillSpec;
  borderTop?: LineStyle;
  borderBottom?: LineStyle;
  borderLeft?: LineStyle;
  borderRight?: LineStyle;
  paragraphs: PptParagraph[];
  anchor: 't' | 'ctr' | 'b';
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

type SlidePaintElement =
  | {
      kind: 'pic';
      box: BoxRect;
      relPath: string;
      alpha: number;
      srcRect?: { l: number; t: number; r: number; b: number };
      line?: LineStyle;
    }
  | {
      kind: 'shape';
      box: BoxRect;
      prst: string;
      adjRatio?: number;
      fill: FillSpec;
      line?: LineStyle;
      paragraphs: PptParagraph[];
      anchor: 't' | 'ctr' | 'b';
      lIns: number;
      rIns: number;
      tIns: number;
      bIns: number;
      wrap: boolean;
    }
  | {
      kind: 'table';
      box: BoxRect;
      colWidths: number[];
      rowHeights: number[];
      rows: PptTableCell[][];
    };

interface PreparedPdfPicture {
  pdfImage: PDFImage;
  width: number;
  height: number;
}

const DEFAULT_FONT_STACK = 'Microsoft YaHei, Noto Sans CJK SC, PingFang SC, SimHei, sans-serif';

const DEFAULT_THEME_SCHEME: Record<string, string> = {
  dk1: '#000000',
  lt1: '#FFFFFF',
  dk2: '#1F497D',
  lt2: '#EEECE1',
  accent1: '#4F81BD',
  accent2: '#C0504D',
  accent3: '#9BBB59',
  accent4: '#8064A2',
  accent5: '#4BACC6',
  accent6: '#F79646',
  hlink: '#0000FF',
  folHlink: '#800080',
};

const STANDARD_CLR_MAP: Record<string, string> = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  green: '#008000',
  blue: '#0000FF',
  yellow: '#FFFF00',
  gray: '#808080',
  darkGray: '#A9A9A9',
  lightGray: '#D3D3D3',
  orange: '#FFA500',
};

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

function escapeXml(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mapPptFontFamily(rawName: string | undefined): string {
  const name = rawName?.trim();
  if (!name || /^\+[a-z]{2}-/i.test(name)) return DEFAULT_FONT_STACK;
  const safe = name.replace(/["'<>]/g, '');
  if (/苹方|PingFang/i.test(safe)) {
    return `'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'SimHei', sans-serif`;
  }
  if (/微软雅黑|Microsoft YaHei/i.test(safe)) {
    return `'Microsoft YaHei', 'Noto Sans CJK SC', 'PingFang SC', 'SimHei', sans-serif`;
  }
  if (/黑体|SimHei/i.test(safe)) {
    return `'SimHei', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
  }
  if (/仿宋|FangSong/i.test(safe)) {
    return `'FangSong', 'SimSun', 'Noto Serif CJK SC', ${DEFAULT_FONT_STACK}`;
  }
  if (/宋体|SimSun/i.test(safe)) {
    return `'SimSun', 'Noto Serif CJK SC', ${DEFAULT_FONT_STACK}`;
  }
  if (/楷体|KaiTi/i.test(safe)) {
    return `'KaiTi', 'STKaiti', 'Noto Serif CJK SC', ${DEFAULT_FONT_STACK}`;
  }
  return `'${safe}', ${DEFAULT_FONT_STACK}`;
}

function parseThemeScheme(themeXml: string | undefined): Record<string, string> {
  const scheme = { ...DEFAULT_THEME_SCHEME };
  if (!themeXml) return scheme;
  const root = parseXmlTree(themeXml);
  const clrScheme = findDescendant(root, 'clrScheme');
  if (!clrScheme) return scheme;

  for (const key of Object.keys(DEFAULT_THEME_SCHEME)) {
    const node = findChild(clrScheme, key);
    if (!node) continue;
    const srgb = findChild(node, 'srgbClr')?.attrs.val;
    const sys = findChild(node, 'sysClr')?.attrs.lastClr;
    const raw = srgb || sys;
    if (raw && /^[0-9a-fA-F]{6}$/.test(raw)) {
      scheme[key] = `#${raw.toUpperCase()}`;
    }
  }
  return scheme;
}

function applyLumModifiers(hex: string, colorNode: XmlNode): ColorSpec {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  let alpha = 1;

  for (const child of colorNode.children) {
    const lt = localTag(child.tag);
    const val = Number(child.attrs.val);
    if (!Number.isFinite(val)) continue;
    if (lt === 'alpha') {
      alpha = Math.max(0, Math.min(1, val / 100000));
    } else if (lt === 'tint') {
      const f = val / 100000;
      r = Math.round(r + (255 - r) * (1 - f));
      g = Math.round(g + (255 - g) * (1 - f));
      b = Math.round(b + (255 - b) * (1 - f));
    } else if (lt === 'shade') {
      const f = val / 100000;
      r = Math.round(r * f);
      g = Math.round(g * f);
      b = Math.round(b * f);
    } else if (lt === 'lumMod') {
      const f = val / 100000;
      r = Math.round(r * f);
      g = Math.round(g * f);
      b = Math.round(b * f);
    } else if (lt === 'lumOff') {
      const off = (val / 100000) * 255;
      r = Math.round(r + off);
      g = Math.round(g + off);
      b = Math.round(b + off);
    }
  }

  const clampHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
  return { hex: `#${clampHex(r)}${clampHex(g)}${clampHex(b)}`, alpha };
}

function resolveDrawingColor(
  container: XmlNode | undefined,
  themeScheme: Record<string, string>,
  clrMap: Record<string, string>,
  phClrHex?: string
): ColorSpec | undefined {
  if (!container) return undefined;

  const srgb = findChild(container, 'srgbClr');
  if (srgb?.attrs.val && /^[0-9a-fA-F]{6}$/.test(srgb.attrs.val)) {
    return applyLumModifiers(`#${srgb.attrs.val.toUpperCase()}`, srgb);
  }

  const schemeClr = findChild(container, 'schemeClr');
  if (schemeClr?.attrs.val) {
    const rawKey = schemeClr.attrs.val;
    let baseHex: string | undefined;
    if (rawKey === 'phClr' && phClrHex) {
      baseHex = phClrHex;
    } else {
      const mappedKey = clrMap[rawKey] ?? rawKey;
      baseHex = themeScheme[mappedKey];
    }
    if (baseHex) {
      return applyLumModifiers(baseHex, schemeClr);
    }
  }

  const sysClr = findChild(container, 'sysClr');
  if (sysClr) {
    const raw = sysClr.attrs.lastClr || (sysClr.attrs.val === 'window' ? 'FFFFFF' : '000000');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) {
      return applyLumModifiers(`#${raw.toUpperCase()}`, sysClr);
    }
  }

  const prstClr = findChild(container, 'prstClr');
  if (prstClr?.attrs.val && NAMED_COLORS[prstClr.attrs.val]) {
    return applyLumModifiers(NAMED_COLORS[prstClr.attrs.val], prstClr);
  }

  return undefined;
}

function parseFillSpec(
  node: XmlNode | undefined,
  themeScheme: Record<string, string>,
  clrMap: Record<string, string>
): FillSpec | undefined {
  if (!node) return undefined;
  if (findChild(node, 'noFill')) return { kind: 'none' };

  const solid = findChild(node, 'solidFill');
  if (solid) {
    const col = resolveDrawingColor(solid, themeScheme, clrMap);
    if (col) return { kind: 'solid', color: col };
  }

  const grad = findChild(node, 'gradFill');
  if (grad) {
    const gsLst = findChild(grad, 'gsLst');
    const stops: GradientStop[] = [];
    for (const gs of findChildren(gsLst, 'gs')) {
      const posRaw = Number(gs.attrs.pos ?? 0);
      const col = resolveDrawingColor(gs, themeScheme, clrMap);
      if (col) stops.push({ pos: Math.max(0, Math.min(100, posRaw / 1000)), color: col });
    }
    if (stops.length > 0) {
      stops.sort((a, b) => a.pos - b.pos);
      const lin = findChild(grad, 'lin');
      const angDeg = lin?.attrs.ang ? Number(lin.attrs.ang) / 60000 : 90;
      return { kind: 'gradient', angleDeg: angDeg, stops };
    }
  }

  return undefined;
}

function parseLineStyle(
  lnNode: XmlNode | undefined,
  scaleX: number,
  themeScheme: Record<string, string>,
  clrMap: Record<string, string>
): LineStyle | undefined {
  if (!lnNode) return undefined;
  if (findChild(lnNode, 'noFill')) return undefined;
  const fill = parseFillSpec(lnNode, themeScheme, clrMap);
  if (!fill || fill.kind === 'none') return undefined;
  const color = fill.kind === 'solid' ? fill.color : fill.stops[0]?.color;
  if (!color || color.alpha <= 0.01) return undefined;

  const wEmu = lnNode.attrs.w !== undefined ? Number(lnNode.attrs.w) : 12700;
  const widthPx = Math.max(0.75, (wEmu / 9525) * scaleX);
  const prstDash = findChild(lnNode, 'prstDash')?.attrs.val;
  const dash: LineStyle['dash'] =
    prstDash === 'dot' || prstDash === 'sysDot'
      ? 'dot'
      : prstDash === 'dashDot' || prstDash === 'lgDashDot'
      ? 'dashDot'
      : prstDash && prstDash !== 'solid'
      ? 'dash'
      : undefined;

  return { widthPx, color, dash };
}

function parseRelsMap(relsXml: string | undefined, baseDir: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  if (!relsXml) return map;
  const root = parseXmlTree(relsXml);
  for (const rel of findChildren(root, 'Relationship')) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    const type = rel.attrs.Type || '';
    if (!id || !target || /^https?:\/\//i.test(target)) continue;
    const normalized = target.startsWith('/')
      ? target.slice(1)
      : path.posix.normalize(path.posix.join(baseDir, target));
    map.set(id, { target: normalized, type });
  }
  return map;
}

function extractBox(
  xfrmNode: XmlNode | undefined,
  scaleX: number,
  scaleY: number,
  fallbackBox?: BoxRect
): BoxRect | null {
  const off = findChild(xfrmNode, 'off');
  const ext = findChild(xfrmNode, 'ext');
  const x = off?.attrs.x !== undefined ? Number(off.attrs.x) * scaleX : fallbackBox?.x;
  const y = off?.attrs.y !== undefined ? Number(off.attrs.y) * scaleY : fallbackBox?.y;
  const w = ext?.attrs.cx !== undefined ? Number(ext.attrs.cx) * scaleX : fallbackBox?.w;
  const h = ext?.attrs.cy !== undefined ? Number(ext.attrs.cy) * scaleY : fallbackBox?.h;

  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;

  const rotRaw = xfrmNode?.attrs.rot;
  const rotDeg = rotRaw !== undefined && Number.isFinite(Number(rotRaw)) ? Number(rotRaw) / 60000 : fallbackBox?.rotDeg ?? 0;
  const flipH = xfrmNode?.attrs.flipH === '1' || xfrmNode?.attrs.flipH === 'true' || Boolean(fallbackBox?.flipH);
  const flipV = xfrmNode?.attrs.flipV === '1' || xfrmNode?.attrs.flipV === 'true' || Boolean(fallbackBox?.flipV);
  return { x, y, w, h, rotDeg, flipH, flipV };
}

function parseBoolAttr(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined;
  if (val === '0' || val === 'false') return false;
  if (val === '1' || val === 'true') return true;
  return undefined;
}

function parseTextBody(
  txBody: XmlNode | undefined,
  textScale: number,
  themeScheme: Record<string, string>,
  clrMap: Record<string, string>,
  defaultFontSizePt = 18,
  defaultColorHex = '#1E293B',
  isBulletDefault = false
): {
  paragraphs: PptParagraph[];
  anchor: 't' | 'ctr' | 'b';
  lIns: number;
  rIns: number;
  tIns: number;
  bIns: number;
  wrap: boolean;
} {
  const bodyPr = findChild(txBody, 'bodyPr');
  const anchorRaw = bodyPr?.attrs.anchor;
  const anchor: 't' | 'ctr' | 'b' =
    anchorRaw === 'ctr' ? 'ctr' : anchorRaw === 'b' ? 'b' : 't';
  const wrap = bodyPr?.attrs.wrap !== 'none';
  const lIns = (bodyPr?.attrs.lIns !== undefined ? Number(bodyPr.attrs.lIns) : 91440) * (1 / 9525) * textScale;
  const rIns = (bodyPr?.attrs.rIns !== undefined ? Number(bodyPr.attrs.rIns) : 91440) * (1 / 9525) * textScale;
  const tIns = (bodyPr?.attrs.tIns !== undefined ? Number(bodyPr.attrs.tIns) : 45720) * (1 / 9525) * textScale;
  const bIns = (bodyPr?.attrs.bIns !== undefined ? Number(bodyPr.attrs.bIns) : 45720) * (1 / 9525) * textScale;

  // Read lvl1pPr..lvl9pPr from txBody/lstStyle
  const lstStyle = findChild(txBody, 'lstStyle');
  const lvlDefaults = new Map<number, { defRPr?: XmlNode; algn?: string }>();
  if (lstStyle) {
    for (let lvl = 1; lvl <= 9; lvl++) {
      const lp = findChild(lstStyle, `lvl${lvl}pPr`);
      if (lp) {
        lvlDefaults.set(lvl - 1, { defRPr: findChild(lp, 'defRPr'), algn: lp.attrs.algn });
      }
    }
  }

  const paragraphs: PptParagraph[] = [];
  for (const pNode of findChildren(txBody, 'p')) {
    const pPr = findChild(pNode, 'pPr');
    const lvl = Math.max(0, Math.min(8, Number(pPr?.attrs.lvl ?? 0)));
    const lvlDef = lvlDefaults.get(lvl);
    const algnRaw = pPr?.attrs.algn ?? lvlDef?.algn;
    const align: 'left' | 'center' | 'right' =
      algnRaw === 'ctr' ? 'center' : algnRaw === 'r' ? 'right' : 'left';

    const defRPr = findChild(pPr, 'defRPr') ?? lvlDef?.defRPr;
    const endParaRPr = findChild(pNode, 'endParaRPr');

    let lineMult = 1.0;
    let lineFixedPx: number | undefined;
    const lnSpc = findChild(pPr, 'lnSpc');
    const spcPct = findChild(lnSpc, 'spcPct')?.attrs.val;
    const spcPts = findChild(lnSpc, 'spcPts')?.attrs.val;
    if (spcPct && Number.isFinite(Number(spcPct))) {
      lineMult = Math.max(0.85, Number(spcPct) / 100000);
    } else if (spcPts && Number.isFinite(Number(spcPts))) {
      lineFixedPx = (Number(spcPts) / 100) * (4 / 3) * textScale;
    }

    const parseSpacing = (spcNode: XmlNode | undefined, refPt: number): number => {
      if (!spcNode) return 0;
      const pts = findChild(spcNode, 'spcPts')?.attrs.val;
      if (pts && Number.isFinite(Number(pts))) {
        return (Number(pts) / 100) * (4 / 3) * textScale;
      }
      const pct = findChild(spcNode, 'spcPct')?.attrs.val;
      if (pct && Number.isFinite(Number(pct))) {
        return (Number(pct) / 100000) * refPt * (4 / 3) * textScale;
      }
      return 0;
    };

    const marLEmu = Number(pPr?.attrs.marL ?? 0);
    const indentEmu = Number(pPr?.attrs.indent ?? 0);
    const marginLeftPx = Math.max(0, (marLEmu / 9525) * textScale);
    const indentPx = (indentEmu / 9525) * textScale;

    const runs: PptTextRun[] = [];
    const resolveRunProps = (rPr: XmlNode | undefined): Omit<PptTextRun, 'text'> => {
      const szRaw = rPr?.attrs.sz ?? defRPr?.attrs.sz ?? endParaRPr?.attrs.sz;
      const pt = szRaw && Number.isFinite(Number(szRaw)) ? Number(szRaw) / 100 : defaultFontSizePt;
      const fontSizePx = Math.max(9, pt * (4 / 3) * textScale);

      const eaType = findChild(rPr, 'ea')?.attrs.typeface || findChild(defRPr, 'ea')?.attrs.typeface;
      const latinType = findChild(rPr, 'latin')?.attrs.typeface || findChild(defRPr, 'latin')?.attrs.typeface;
      const fontFamily = mapPptFontFamily(eaType || latinType);

      const bold = parseBoolAttr(rPr?.attrs.b) ?? parseBoolAttr(defRPr?.attrs.b) ?? false;
      const italic = parseBoolAttr(rPr?.attrs.i) ?? parseBoolAttr(defRPr?.attrs.i) ?? false;
      const uVal = rPr?.attrs.u ?? defRPr?.attrs.u;
      const underline = Boolean(uVal && uVal !== 'none');
      const strikeVal = rPr?.attrs.strike ?? defRPr?.attrs.strike;
      const strike = Boolean(strikeVal && strikeVal !== 'noStrike');

      const fillCol =
        resolveDrawingColor(findChild(rPr, 'solidFill'), themeScheme, clrMap) ??
        resolveDrawingColor(findChild(defRPr, 'solidFill'), themeScheme, clrMap) ??
        { hex: defaultColorHex, alpha: 1 };

      return { fontSizePx, fontFamily, bold, italic, underline, strike, color: fillCol };
    };

    for (const child of pNode.children) {
      const lt = localTag(child.tag);
      if (lt === 'r' || lt === 'fld') {
        const rPr = findChild(child, 'rPr');
        const tNode = findChild(child, 't');
        const txt = tNode?.text ?? '';
        if (!txt) continue;
        runs.push({ text: txt, ...resolveRunProps(rPr) });
      } else if (lt === 'br') {
        const rPr = findChild(child, 'rPr');
        runs.push({ text: '\n', ...resolveRunProps(rPr) });
      }
    }

    // Add bullet prefix if explicit buChar/buAutoNum (and not buNone) and paragraph has visible text
    const hasBuNone = Boolean(findChild(pPr, 'buNone'));
    const buChar = findChild(pPr, 'buChar')?.attrs.char;
    const buAuto = findChild(pPr, 'buAutoNum');
    const bulletText = !hasBuNone
      ? buChar
        ? `${buChar} `
        : buAuto
        ? '• '
        : isBulletDefault && lvl > 0
        ? '• '
        : ''
      : '';
    if (bulletText && runs.some((r) => r.text.trim().length > 0)) {
      runs.unshift({ ...runs[0], text: bulletText });
    }

    const firstRPr = findChild(findChild(pNode, 'r'), 'rPr');
    const refSzRaw = firstRPr?.attrs.sz ?? defRPr?.attrs.sz ?? endParaRPr?.attrs.sz;
    const refPt = refSzRaw && Number.isFinite(Number(refSzRaw)) ? Number(refSzRaw) / 100 : defaultFontSizePt;
    const spaceBeforePx = parseSpacing(findChild(pPr, 'spcBef'), refPt);
    const spaceAfterPx = parseSpacing(findChild(pPr, 'spcAft'), refPt);
    const emptyHeightPx = (lineFixedPx ?? refPt * (4 / 3) * textScale * lineMult * 1.15);

    paragraphs.push({
      align,
      lineMult,
      lineFixedPx,
      spaceBeforePx,
      spaceAfterPx,
      marginLeftPx,
      indentPx,
      runs,
      emptyHeightPx,
    });
  }

  return { paragraphs, anchor, lIns, rIns, tIns, bIns, wrap };
}

function charWidthUnits(ch: string, bold: boolean): number {
  const code = ch.codePointAt(0) ?? 32;
  const boldFactor = bold ? 1.03 : 1.0;
  if (code === 0x3000) return 1.0; // full-width ideographic space
  if (code === 9) return 2.0;
  if (code > 127) return 1.0 * boldFactor;
  if ('mwMW@#%&QGO+'.includes(ch)) return 0.78 * boldFactor;
  if ('ijlI.,;:\'"!|` '.includes(ch)) return 0.34 * boldFactor;
  if (ch >= '0' && ch <= '9') return 0.56 * boldFactor;
  if (ch >= 'A' && ch <= 'Z') return 0.67 * boldFactor;
  return 0.53 * boldFactor;
}

function sameRunStyle(a: PptTextRun, b: PptTextRun): boolean {
  return (
    a.fontSizePx === b.fontSizePx &&
    a.fontFamily === b.fontFamily &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.color.hex === b.color.hex &&
    a.color.alpha === b.color.alpha
  );
}

function wrapRunsToLines(runs: PptTextRun[], maxWidthPx: number, allowWrap: boolean): PptTextRun[][] {
  if (runs.length === 0) return [];
  const safeMax = allowWrap ? Math.max(18, maxWidthPx) : 100000;
  const lines: PptTextRun[][] = [];
  let curLine: PptTextRun[] = [];
  let curW = 0;

  const pushLine = () => {
    lines.push(curLine);
    curLine = [];
    curW = 0;
  };

  const appendSeg = (text: string, tpl: PptTextRun) => {
    if (!text) return;
    const last = curLine[curLine.length - 1];
    if (last && sameRunStyle(last, tpl)) {
      last.text += text;
    } else {
      curLine.push({ ...tpl, text });
    }
  };

  for (const run of runs) {
    const clean = run.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const tokens = clean.match(/\n|[A-Za-z0-9.,_%+-]{2,20}|[\s\S]/g) || [];
    for (const token of tokens) {
      if (token === '\n') {
        pushLine();
        continue;
      }
      let tokenW = 0;
      for (const ch of token) {
        tokenW += charWidthUnits(ch, run.bold) * run.fontSizePx;
      }
      if (curLine.length > 0 && curW + tokenW > safeMax) {
        if (token.length > 1 && tokenW > safeMax) {
          for (const ch of token) {
            const chW = charWidthUnits(ch, run.bold) * run.fontSizePx;
            if (curLine.length > 0 && curW + chW > safeMax) pushLine();
            appendSeg(ch, run);
            curW += chW;
          }
          continue;
        }
        pushLine();
        // Skip leading normal space when wrapping to a new line
        if (token === ' ') continue;
        appendSeg(token, run);
        curW = tokenW;
      } else {
        appendSeg(token, run);
        curW += tokenW;
      }
    }
  }

  if (curLine.length > 0) lines.push(curLine);
  return lines;
}

function measureTextBlock(
  paragraphs: PptParagraph[],
  availW: number,
  wrap: boolean,
  scaleFactor = 1
): {
  totalH: number;
  laidOut: Array<{
    align: 'left' | 'center' | 'right';
    marginLeftPx: number;
    spaceBeforePx: number;
    spaceAfterPx: number;
    emptyHeightPx: number;
    lines: Array<{ segs: PptTextRun[]; lineH: number; maxFontPx: number }>;
  }>;
} {
  let totalH = 0;
  const laidOut: Array<{
    align: 'left' | 'center' | 'right';
    marginLeftPx: number;
    spaceBeforePx: number;
    spaceAfterPx: number;
    emptyHeightPx: number;
    lines: Array<{ segs: PptTextRun[]; lineH: number; maxFontPx: number }>;
  }> = [];

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const p = paragraphs[pIdx];
    const scaledRuns =
      scaleFactor === 1
        ? p.runs
        : p.runs.map((r) => ({ ...r, fontSizePx: Math.max(8, r.fontSizePx * scaleFactor) }));
    const spaceBefore = pIdx === 0 ? 0 : p.spaceBeforePx * scaleFactor;
    const spaceAfter = pIdx === paragraphs.length - 1 ? 0 : p.spaceAfterPx * scaleFactor;
    const boxWForPara = Math.max(18, availW - p.marginLeftPx);
    const wrapped = wrapRunsToLines(scaledRuns, boxWForPara, wrap);

    totalH += spaceBefore;
    const lineInfos: Array<{ segs: PptTextRun[]; lineH: number; maxFontPx: number }> = [];
    if (wrapped.length === 0) {
      totalH += p.emptyHeightPx * scaleFactor;
    } else {
      for (const segs of wrapped) {
        const maxFontPx = segs.reduce((mx, s) => Math.max(mx, s.fontSizePx), 12);
        const lineH = p.lineFixedPx ? p.lineFixedPx * scaleFactor : maxFontPx * (p.lineMult * 1.15);
        lineInfos.push({ segs, lineH, maxFontPx });
        totalH += lineH;
      }
    }
    totalH += spaceAfter;

    laidOut.push({
      align: p.align,
      marginLeftPx: p.marginLeftPx,
      spaceBeforePx: spaceBefore,
      spaceAfterPx: spaceAfter,
      emptyHeightPx: p.emptyHeightPx * scaleFactor,
      lines: lineInfos,
    });
  }

  return { totalH, laidOut };
}

function renderParagraphsToSvg(
  paragraphs: PptParagraph[],
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  anchor: 't' | 'ctr' | 'b',
  lIns: number,
  rIns: number,
  tIns: number,
  bIns: number,
  wrap: boolean,
  clipId: string
): { defs: string[]; elements: string[] } {
  if (paragraphs.length === 0 || !paragraphs.some((p) => p.runs.length > 0)) {
    return { defs: [], elements: [] };
  }

  const availW = Math.max(20, boxW - lIns - rIns);
  const availH = Math.max(16, boxH - tIns - bIns);

  let measured = measureTextBlock(paragraphs, availW, wrap, 1);
  // Subtle autofit shrink only when wrapped text strictly overflows box height
  if (measured.totalH > availH * 1.01 && availH > 24) {
    const ratio = Math.max(0.7, (availH * 0.97) / measured.totalH);
    measured = measureTextBlock(paragraphs, availW, wrap, ratio);
  }

  let curY = boxY + tIns;
  if (anchor === 'ctr') {
    curY = boxY + tIns + Math.max(0, (availH - measured.totalH) / 2);
  } else if (anchor === 'b') {
    curY = boxY + boxH - bIns - measured.totalH;
  }

  const textParts: string[] = [];
  for (const para of measured.laidOut) {
    curY += para.spaceBeforePx;
    if (para.lines.length === 0) {
      curY += para.emptyHeightPx;
      curY += para.spaceAfterPx;
      continue;
    }

    let textX = boxX + lIns + para.marginLeftPx;
    let textAnchor = 'start';
    if (para.align === 'center') {
      textX = boxX + lIns + para.marginLeftPx + Math.max(0, availW - para.marginLeftPx) / 2;
      textAnchor = 'middle';
    } else if (para.align === 'right') {
      textX = boxX + boxW - rIns;
      textAnchor = 'end';
    }

    for (const line of para.lines) {
      const baseline = curY + (line.lineH - line.maxFontPx) * 0.25 + line.maxFontPx * 0.8;
      curY += line.lineH;
      if (baseline > boxY + boxH + 8) continue;

      const tspans = line.segs
        .map((seg) => {
          const attrs = [
            `font-family="${escapeXml(seg.fontFamily)}"`,
            `font-size="${seg.fontSizePx.toFixed(1)}"`,
            `fill="${seg.color.hex}"`,
          ];
          if (seg.color.alpha < 0.995) attrs.push(`fill-opacity="${seg.color.alpha.toFixed(3)}"`);
          if (seg.bold) attrs.push('font-weight="700"');
          if (seg.italic) attrs.push('font-style="italic"');
          const decos: string[] = [];
          if (seg.underline) decos.push('underline');
          if (seg.strike) decos.push('line-through');
          if (decos.length > 0) attrs.push(`text-decoration="${decos.join(' ')}"`);
          return `<tspan ${attrs.join(' ')}>${escapeXml(seg.text)}</tspan>`;
        })
        .join('');

      textParts.push(
        `<text x="${textX.toFixed(1)}" y="${baseline.toFixed(1)}" text-anchor="${textAnchor}" xml:space="preserve">${tspans}</text>`
      );
    }
    curY += para.spaceAfterPx;
  }

  if (textParts.length === 0) return { defs: [], elements: [] };

  const clipDef = `<clipPath id="${clipId}"><rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(
    1
  )}" height="${(boxH + 4).toFixed(1)}"/></clipPath>`;
  return {
    defs: [clipDef],
    elements: [`<g clip-path="url(#${clipId})">${textParts.join('\n')}</g>`],
  };
}

function fillToSvgAttr(
  fill: FillSpec,
  gradId: string,
  defs: string[]
): { fillAttr: string; extraAttrs: string } {
  if (fill.kind === 'none') {
    return { fillAttr: 'none', extraAttrs: '' };
  }
  if (fill.kind === 'solid') {
    return {
      fillAttr: fill.color.hex,
      extraAttrs: fill.color.alpha < 0.995 ? ` fill-opacity="${fill.color.alpha.toFixed(3)}"` : '',
    };
  }
  const rad = ((fill.angleDeg - 90) * Math.PI) / 180;
  const x1 = (50 - Math.cos(rad) * 50).toFixed(1);
  const y1 = (50 - Math.sin(rad) * 50).toFixed(1);
  const x2 = (50 + Math.cos(rad) * 50).toFixed(1);
  const y2 = (50 + Math.sin(rad) * 50).toFixed(1);
  const stopsSvg = fill.stops
    .map(
      (s) =>
        `<stop offset="${s.pos.toFixed(1)}%" stop-color="${s.color.hex}" stop-opacity="${s.color.alpha.toFixed(3)}"/>`
    )
    .join('');
  defs.push(
    `<linearGradient id="${gradId}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">${stopsSvg}</linearGradient>`
  );
  return { fillAttr: `url(#${gradId})`, extraAttrs: '' };
}

function lineToSvgAttrs(line: LineStyle | undefined): string {
  if (!line) return '';
  const attrs = [
    `stroke="${line.color.hex}"`,
    `stroke-width="${line.widthPx.toFixed(2)}"`,
  ];
  if (line.color.alpha < 0.995) attrs.push(`stroke-opacity="${line.color.alpha.toFixed(3)}"`);
  if (line.dash === 'dot') attrs.push(`stroke-dasharray="${Math.max(1.5, line.widthPx).toFixed(1)} ${(line.widthPx * 2.2).toFixed(1)}"`);
  else if (line.dash === 'dash') attrs.push(`stroke-dasharray="${(line.widthPx * 4).toFixed(1)} ${(line.widthPx * 2.5).toFixed(1)}"`);
  else if (line.dash === 'dashDot') attrs.push(`stroke-dasharray="${(line.widthPx * 4).toFixed(1)} ${(line.widthPx * 2).toFixed(1)} ${line.widthPx.toFixed(1)} ${(line.widthPx * 2).toFixed(1)}"`);
  return ' ' + attrs.join(' ');
}

function renderShapeToSvg(
  el: Extract<SlidePaintElement, { kind: 'shape' }>,
  uidPrefix: string
): { defs: string[]; elements: string[] } {
  const defs: string[] = [];
  const elements: string[] = [];
  const { box, prst, adjRatio, fill, line, paragraphs } = el;
  const gradId = `${uidPrefix}_grad`;
  const clipId = `${uidPrefix}_clip`;

  const { fillAttr, extraAttrs } = fillToSvgAttr(fill, gradId, defs);
  const strokeAttrs = lineToSvgAttrs(line);

  const hasFill = fill.kind !== 'none';
  const hasStroke = Boolean(line);

  const geomParts: string[] = [];
  if (hasFill || hasStroke) {
    if (prst === 'line' || prst === 'straightConnector1') {
      const x1 = box.flipH ? box.x + box.w : box.x;
      const x2 = box.flipH ? box.x : box.x + box.w;
      const y1 = box.flipV ? box.y + box.h : box.y;
      const y2 = box.flipV ? box.y : box.y + box.h;
      geomParts.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
          1
        )}" fill="none"${strokeAttrs}/>`
      );
    } else if (prst === 'ellipse') {
      geomParts.push(
        `<ellipse cx="${(box.x + box.w / 2).toFixed(1)}" cy="${(box.y + box.h / 2).toFixed(1)}" rx="${(
          box.w / 2
        ).toFixed(1)}" ry="${(box.h / 2).toFixed(1)}" fill="${fillAttr}"${extraAttrs}${strokeAttrs}/>`
      );
    } else if (prst === 'roundRect') {
      const ratio = adjRatio !== undefined ? Math.max(0, Math.min(0.5, adjRatio)) : 0.1667;
      const r = Math.min(box.w, box.h) * ratio;
      geomParts.push(
        `<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(
          1
        )}" rx="${r.toFixed(1)}" ry="${r.toFixed(1)}" fill="${fillAttr}"${extraAttrs}${strokeAttrs}/>`
      );
    } else if (prst === 'triangle' || prst === 'isoscelesTriangle') {
      const pts = `${(box.x + box.w / 2).toFixed(1)},${box.y.toFixed(1)} ${(box.x + box.w).toFixed(1)},${(
        box.y + box.h
      ).toFixed(1)} ${box.x.toFixed(1)},${(box.y + box.h).toFixed(1)}`;
      geomParts.push(`<polygon points="${pts}" fill="${fillAttr}"${extraAttrs}${strokeAttrs}/>`);
    } else if (prst === 'rtTriangle') {
      const pts = `${box.x.toFixed(1)},${box.y.toFixed(1)} ${(box.x + box.w).toFixed(1)},${(box.y + box.h).toFixed(
        1
      )} ${box.x.toFixed(1)},${(box.y + box.h).toFixed(1)}`;
      geomParts.push(`<polygon points="${pts}" fill="${fillAttr}"${extraAttrs}${strokeAttrs}/>`);
    } else {
      geomParts.push(
        `<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(
          1
        )}" fill="${fillAttr}"${extraAttrs}${strokeAttrs}/>`
      );
    }
  }

  const textRes = renderParagraphsToSvg(
    paragraphs,
    box.x,
    box.y,
    box.w,
    box.h,
    el.anchor,
    el.lIns,
    el.rIns,
    el.tIns,
    el.bIns,
    el.wrap,
    clipId
  );
  defs.push(...textRes.defs);

  const inner = [...geomParts, ...textRes.elements].join('\n');
  if (!inner) return { defs, elements: [] };

  if (Math.abs(box.rotDeg) > 0.1) {
    const cx = (box.x + box.w / 2).toFixed(1);
    const cy = (box.y + box.h / 2).toFixed(1);
    elements.push(`<g transform="rotate(${box.rotDeg.toFixed(2)} ${cx} ${cy})">${inner}</g>`);
  } else {
    elements.push(inner);
  }
  return { defs, elements };
}

function renderTableToSvg(
  el: Extract<SlidePaintElement, { kind: 'table' }>,
  uidPrefix: string
): { defs: string[]; elements: string[] } {
  const defs: string[] = [];
  const elements: string[] = [];
  const { box, colWidths, rowHeights, rows } = el;

  const colLeft: number[] = [box.x];
  for (let c = 0; c < colWidths.length; c++) colLeft.push(colLeft[c] + colWidths[c]);
  const rowTop: number[] = [box.y];
  for (let r = 0; r < rowHeights.length; r++) rowTop.push(rowTop[r] + rowHeights[r]);

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const cell = rows[r][c];
      if (cell.hMerge || cell.vMerge) continue;
      const cEnd = Math.min(colWidths.length, c + Math.max(1, cell.colSpan));
      const rEnd = Math.min(rowHeights.length, r + Math.max(1, cell.rowSpan));
      const cx = colLeft[c];
      const cy = rowTop[r];
      const cw = Math.max(10, colLeft[cEnd] - cx);
      const ch = Math.max(10, rowTop[rEnd] - cy);

      if (cell.fill.kind !== 'none') {
        const { fillAttr, extraAttrs } = fillToSvgAttr(cell.fill, `${uidPrefix}_tc${r}_${c}`, defs);
        elements.push(
          `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(
            1
          )}" fill="${fillAttr}"${extraAttrs}/>`
        );
      }

      const drawBorder = (b: LineStyle | undefined, x1: number, y1: number, x2: number, y2: number) => {
        if (!b) return;
        elements.push(
          `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
            1
          )}"${lineToSvgAttrs(b)}/>`
        );
      };
      drawBorder(cell.borderTop, cx, cy, cx + cw, cy);
      drawBorder(cell.borderBottom, cx, cy + ch, cx + cw, cy + ch);
      drawBorder(cell.borderLeft, cx, cy, cx, cy + ch);
      drawBorder(cell.borderRight, cx + cw, cy, cx + cw, cy + ch);

      const textRes = renderParagraphsToSvg(
        cell.paragraphs,
        cx,
        cy,
        cw,
        ch,
        cell.anchor,
        cell.padL,
        cell.padR,
        cell.padT,
        cell.padB,
        true,
        `${uidPrefix}_tclip${r}_${c}`
      );
      defs.push(...textRes.defs);
      elements.push(...textRes.elements);
    }
  }
  return { defs, elements };
}

async function preparePictureForPdf(
  pdfDoc: PDFDocument,
  rawBuf: Buffer,
  el: Extract<SlidePaintElement, { kind: 'pic' }>
): Promise<PreparedPdfPicture | null> {
  try {
    const meta = await sharp(rawBuf).metadata();
    if (!meta.width || !meta.height) return null;

    let pipeline = sharp(rawBuf).rotate();
    let curW = meta.width;
    let curH = meta.height;

    if (el.srcRect) {
      const left = Math.max(0, Math.round(curW * el.srcRect.l));
      const top = Math.max(0, Math.round(curH * el.srcRect.t));
      const rightCut = Math.max(0, Math.round(curW * el.srcRect.r));
      const bottomCut = Math.max(0, Math.round(curH * el.srcRect.b));
      const extractW = Math.max(4, curW - left - rightCut);
      const extractH = Math.max(4, curH - top - bottomCut);
      if (extractW < curW || extractH < curH) {
        pipeline = pipeline.extract({ left, top, width: extractW, height: extractH });
        curW = extractW;
        curH = extractH;
      }
    }

    if (el.box.flipH) pipeline = pipeline.flop();
    if (el.box.flipV) pipeline = pipeline.flip();

    const maxDim = 1800;
    const isOversized = curW > maxDim || curH > maxDim;
    const needsCustomAlpha = el.alpha < 0.995;
    const isUntouched =
      !el.srcRect && !el.box.flipH && !el.box.flipV && !el.alpha && !(meta.orientation && meta.orientation > 1) && !isOversized;

    if (isUntouched && !needsCustomAlpha) {
      if (meta.format === 'jpeg') {
        try {
          const pdfImage = await pdfDoc.embedJpg(Uint8Array.from(rawBuf));
          return { pdfImage, width: curW, height: curH };
        } catch {
          // Fall through
        }
      }
      if (meta.format === 'png') {
        try {
          const pdfImage = await pdfDoc.embedPng(Uint8Array.from(rawBuf));
          return { pdfImage, width: curW, height: curH };
        } catch {
          // Fall through
        }
      }
    }

    if (isOversized) {
      pipeline = pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }

    if (needsCustomAlpha) {
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let idx = 3; idx < data.length; idx += 4) {
        data[idx] = Math.round(data[idx] * el.alpha);
      }
      const pngBuf = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      })
        .png({ compressionLevel: 6 })
        .toBuffer();
      const pdfImage = await pdfDoc.embedPng(Uint8Array.from(pngBuf));
      return { pdfImage, width: info.width, height: info.height };
    }

    if (meta.format === 'png' && meta.hasAlpha) {
      const { data, info } = await pipeline.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
      const pdfImage = await pdfDoc.embedPng(Uint8Array.from(data));
      return { pdfImage, width: info.width, height: info.height };
    }

    try {
      const { data, info } = await pipeline
        .toColorspace('srgb')
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const pdfImage = await pdfDoc.embedJpg(Uint8Array.from(data));
      return { pdfImage, width: info.width, height: info.height };
    } catch {
      const { data, info } = await sharp(rawBuf).rotate().png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
      const pdfImage = await pdfDoc.embedPng(Uint8Array.from(data));
      return { pdfImage, width: info.width, height: info.height };
    }
  } catch {
    return null;
  }
}

export async function renderPptxToPdf(inputPath: string, outPdfPath: string): Promise<void> {
  if (!inputPath.toLowerCase().endsWith('.pptx')) {
    throw new Error('本地无 LibreOffice 引擎时仅支持 .pptx，旧版 .ppt 请部署到 Docker/微信云托管运行');
  }

  const zipBytes = await fs.readFile(inputPath);
  const zip = await JSZip.loadAsync(zipBytes);

  // Determine exact slide order via presentation.xml + presentation.xml.rels
  const presXml = await zip.files['ppt/presentation.xml']?.async('string');
  const presRels = parseRelsMap(
    await zip.files['ppt/_rels/presentation.xml.rels']?.async('string'),
    'ppt'
  );

  let slideEmuW = 12192000;
  let slideEmuH = 6858000;
  let slideKeys: string[] = [];

  if (presXml) {
    const presRoot = parseXmlTree(presXml);
    const sldSz = findChild(presRoot, 'sldSz');
    if (sldSz?.attrs.cx && sldSz?.attrs.cy) {
      slideEmuW = Math.max(100000, Number(sldSz.attrs.cx));
      slideEmuH = Math.max(100000, Number(sldSz.attrs.cy));
    }
    const sldIdLst = findChild(presRoot, 'sldIdLst');
    for (const sldId of findChildren(sldIdLst, 'sldId')) {
      const rId = sldId.attrs['r:id'] || sldId.attrs.id;
      const target = rId ? presRels.get(rId)?.target : undefined;
      if (target && zip.files[target]) {
        slideKeys.push(target);
      }
    }
  }

  if (slideKeys.length === 0) {
    slideKeys = Object.keys(zip.files)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  if (slideKeys.length === 0) {
    throw new Error('PPTX 中未找到幻灯片页面');
  }

  // Natural 96-DPI pixel size capped cleanly for memory & razor-sharp text
  const rawPxW = slideEmuW / 9525;
  const pageW = Math.max(720, Math.min(1600, Math.round(rawPxW)));
  const pageH = Math.max(400, Math.min(1600, Math.round((pageW * slideEmuH) / slideEmuW)));
  const scaleX = pageW / slideEmuW;
  const scaleY = pageH / slideEmuH;
  const textScale = pageW / rawPxW;

  const themeXml = await zip.files['ppt/theme/theme1.xml']?.async('string');
  const defaultThemeScheme = parseThemeScheme(themeXml);

  // Cache parsed layout / master XMLs and rels
  const xmlTreeCache = new Map<string, XmlNode>();
  const relsCache = new Map<string, Map<string, { target: string; type: string }>>();

  const getXmlTree = async (zipPath: string): Promise<XmlNode | undefined> => {
    if (xmlTreeCache.has(zipPath)) return xmlTreeCache.get(zipPath);
    const xml = await zip.files[zipPath]?.async('string');
    if (!xml) return undefined;
    const tree = parseXmlTree(xml);
    xmlTreeCache.set(zipPath, tree);
    return tree;
  };

  const getRelsForPart = async (partPath: string): Promise<Map<string, { target: string; type: string }>> => {
    if (relsCache.has(partPath)) return relsCache.get(partPath)!;
    const dir = path.posix.dirname(partPath);
    const base = path.posix.basename(partPath);
    const relsPath = path.posix.join(dir, '_rels', `${base}.rels`);
    const map = parseRelsMap(await zip.files[relsPath]?.async('string'), dir);
    relsCache.set(partPath, map);
    return map;
  };

  const resolvePlaceholders = (spTree: XmlNode | undefined) => {
    const byTypeIdx = new Map<string, { box?: BoxRect; defColor?: string; defSizePt?: number }>();
    const byType = new Map<string, { box?: BoxRect; defColor?: string; defSizePt?: number }>();
    if (!spTree) return { byTypeIdx, byType };

    for (const ch of findChildren(spTree, 'sp')) {
      const ph = findDescendant(findChild(ch, 'nvSpPr'), 'ph');
      if (!ph) continue;
      const phType = ph.attrs.type || 'body';
      const phIdx = ph.attrs.idx;
      const spPr = findChild(ch, 'spPr');
      const xfrm = findChild(spPr, 'xfrm');
      const box = extractBox(xfrm, scaleX, scaleY) ?? undefined;
      const entry = { box };
      if (phIdx !== undefined) byTypeIdx.set(`${phType}:${phIdx}`, entry);
      if (!byType.has(phType)) byType.set(phType, entry);
    }
    return { byTypeIdx, byType };
  };

  const collectPaintElements = (
    container: XmlNode,
    partRels: Map<string, { target: string; type: string }>,
    themeScheme: Record<string, string>,
    clrMap: Record<string, string>,
    locScaleX: number,
    locScaleY: number,
    offsetPxX: number,
    offsetPxY: number,
    layoutPh?: ReturnType<typeof resolvePlaceholders>,
    masterPh?: ReturnType<typeof resolvePlaceholders>,
    skipPlaceholders = false
  ): SlidePaintElement[] => {
    const out: SlidePaintElement[] = [];
    let flowCursorY = 72;

    for (const rawChild of container.children) {
      // Unwrap mc:AlternateContent cleanly
      const child = (() => {
        if (localTag(rawChild.tag) === 'AlternateContent') {
          return findChild(rawChild, 'Fallback') ?? findChild(rawChild, 'Choice') ?? rawChild;
        }
        return rawChild;
      })();

      const lt = localTag(child.tag);

      if (lt === 'grpSp') {
        const grpSpPr = findChild(child, 'grpSpPr');
        const gx = findChild(grpSpPr, 'xfrm');
        const off = findChild(gx, 'off');
        const ext = findChild(gx, 'ext');
        const chOff = findChild(gx, 'chOff');
        const chExt = findChild(gx, 'chExt');

        const gOffX = Number(off?.attrs.x ?? 0);
        const gOffY = Number(off?.attrs.y ?? 0);
        const gExtX = Number(ext?.attrs.cx ?? 0);
        const gExtY = Number(ext?.attrs.cy ?? 0);
        const cOffX = Number(chOff?.attrs.x ?? 0);
        const cOffY = Number(chOff?.attrs.y ?? 0);
        const cExtX = Number(chExt?.attrs.cx ?? 0);
        const cExtY = Number(chExt?.attrs.cy ?? 0);

        const nextScaleX = gExtX > 0 && cExtX > 0 ? locScaleX * (gExtX / cExtX) : locScaleX;
        const nextScaleY = gExtY > 0 && cExtY > 0 ? locScaleY * (gExtY / cExtY) : locScaleY;
        const nextOffsetX = offsetPxX + gOffX * locScaleX - cOffX * nextScaleX;
        const nextOffsetY = offsetPxY + gOffY * locScaleY - cOffY * nextScaleY;

        out.push(
          ...collectPaintElements(
            child,
            partRels,
            themeScheme,
            clrMap,
            nextScaleX,
            nextScaleY,
            nextOffsetX,
            nextOffsetY,
            layoutPh,
            masterPh,
            skipPlaceholders
          )
        );
        continue;
      }

      if (lt === 'pic') {
        const spPr = findChild(child, 'spPr');
        const xfrm = findChild(spPr, 'xfrm');
        const box = extractBox(xfrm, locScaleX, locScaleY);
        const blipFill = findChild(child, 'blipFill');
        const blip = findChild(blipFill, 'blip');
        const rId = blip?.attrs['r:embed'] || blip?.attrs.embed || blip?.attrs['r:link'] || blip?.attrs.link;
        const rel = rId ? partRels.get(rId) : undefined;
        if (!box || !rel) continue;

        box.x += offsetPxX;
        box.y += offsetPxY;

        const alphaAmt = findChild(blip, 'alphaModFix')?.attrs.amt;
        const alpha = alphaAmt !== undefined && Number.isFinite(Number(alphaAmt))
          ? Math.max(0, Math.min(1, Number(alphaAmt) / 100000))
          : 1;

        const srcRectNode = findChild(blipFill, 'srcRect');
        const srcRect = srcRectNode
          ? {
              l: Number(srcRectNode.attrs.l ?? 0) / 100000,
              t: Number(srcRectNode.attrs.t ?? 0) / 100000,
              r: Number(srcRectNode.attrs.r ?? 0) / 100000,
              b: Number(srcRectNode.attrs.b ?? 0) / 100000,
            }
          : undefined;
        const hasCrop = srcRect && (srcRect.l > 0.002 || srcRect.t > 0.002 || srcRect.r > 0.002 || srcRect.b > 0.002);

        const line = parseLineStyle(findChild(spPr, 'ln'), locScaleX * 9525 * scaleX, themeScheme, clrMap);

        out.push({
          kind: 'pic',
          box,
          relPath: rel.target,
          alpha,
          srcRect: hasCrop ? srcRect : undefined,
          line,
        });
        continue;
      }

      if (lt === 'sp') {
        const nvSpPr = findChild(child, 'nvSpPr');
        const ph = findDescendant(nvSpPr, 'ph');
        if (skipPlaceholders && ph) continue;

        let fallbackBox: BoxRect | undefined;
        let isTitlePh = false;
        if (ph) {
          const phType = ph.attrs.type || 'body';
          const phIdx = ph.attrs.idx;
          isTitlePh = phType === 'title' || phType === 'ctrTitle';
          const fromLayout =
            (phIdx !== undefined ? layoutPh?.byTypeIdx.get(`${phType}:${phIdx}`) : undefined) ??
            layoutPh?.byType.get(phType);
          const fromMaster =
            (phIdx !== undefined ? masterPh?.byTypeIdx.get(`${phType}:${phIdx}`) : undefined) ??
            masterPh?.byType.get(phType);
          fallbackBox = fromLayout?.box ?? fromMaster?.box;
        }

        const spPr = findChild(child, 'spPr');
        const xfrm = findChild(spPr, 'xfrm');
        let box = extractBox(xfrm, locScaleX, locScaleY, fallbackBox);
        const txBodyNode = findChild(child, 'txBody');
        if (!box && txBodyNode) {
          box = { x: 72, y: flowCursorY, w: Math.max(240, pageW - 144), h: 160, rotDeg: 0, flipH: false, flipV: false };
          flowCursorY += 170;
        }
        if (!box) continue;
        if (!fallbackBox || xfrm) {
          box.x += offsetPxX;
          box.y += offsetPxY;
        }

        const prstGeom = findChild(spPr, 'prstGeom');
        const prst = prstGeom?.attrs.prst || 'rect';
        const adjGd = findChild(findChild(prstGeom, 'avLst'), 'gd');
        let adjRatio: number | undefined;
        if (adjGd?.attrs.name === 'adj' && adjGd.attrs.fmla) {
          const m = /^val\s+(\d+)/.exec(adjGd.attrs.fmla.trim());
          if (m) adjRatio = Number(m[1]) / 100000;
        }

        let fill = parseFillSpec(spPr, themeScheme, clrMap);
        if (!fill) {
          // Check <p:style><a:fillRef> for styled shapes
          const styleNode = findChild(child, 'style');
          const fillRef = findChild(styleNode, 'fillRef');
          const refIdx = Number(fillRef?.attrs.idx ?? 0);
          if (fillRef && refIdx > 0) {
            const c = resolveDrawingColor(fillRef, themeScheme, clrMap);
            if (c) fill = { kind: 'solid', color: c };
          }
        }
        fill = fill ?? { kind: 'none' };

        let line = parseLineStyle(findChild(spPr, 'ln'), scaleX * 9525, themeScheme, clrMap);
        if (!line && !findChild(spPr, 'ln')) {
          const lnRef = findChild(findChild(child, 'style'), 'lnRef');
          if (lnRef && Number(lnRef.attrs.idx ?? 0) > 0) {
            const lc = resolveDrawingColor(lnRef, themeScheme, clrMap);
            if (lc) line = { widthPx: 1, color: lc };
          }
        }

        const txBody = findChild(child, 'txBody');
        const parsedText = txBody
          ? parseTextBody(txBody, textScale, themeScheme, clrMap, isTitlePh ? 32 : 18, '#1E293B', Boolean(ph && !isTitlePh))
          : { paragraphs: [], anchor: 't' as const, lIns: 9.6, rIns: 9.6, tIns: 4.8, bIns: 4.8, wrap: true };

        if (fill.kind === 'none' && !line && !parsedText.paragraphs.some((p) => p.runs.length > 0)) {
          continue;
        }

        out.push({
          kind: 'shape',
          box,
          prst,
          adjRatio,
          fill,
          line,
          paragraphs: parsedText.paragraphs,
          anchor: parsedText.anchor,
          lIns: parsedText.lIns,
          rIns: parsedText.rIns,
          tIns: parsedText.tIns,
          bIns: parsedText.bIns,
          wrap: parsedText.wrap,
        });
        continue;
      }

      if (lt === 'graphicFrame') {
        const tbl = findDescendant(child, 'tbl');
        const xfrm = findChild(child, 'xfrm');
        const box = extractBox(xfrm, locScaleX, locScaleY);
        if (!tbl || !box) continue;
        box.x += offsetPxX;
        box.y += offsetPxY;

        const gridCols = findChildren(findChild(tbl, 'tblGrid'), 'gridCol');
        let colWidths = gridCols.map((gc) => Math.max(16, Number(gc.attrs.w ?? 0) * locScaleX));
        if (colWidths.length === 0) colWidths = [box.w];
        const sumCol = colWidths.reduce((s, w) => s + w, 0);
        if (sumCol > 0 && Math.abs(sumCol - box.w) > 4) {
          const cf = box.w / sumCol;
          colWidths = colWidths.map((w) => w * cf);
        }

        const trNodes = findChildren(tbl, 'tr');
        let rowHeights = trNodes.map((tr) => Math.max(20, Number(tr.attrs.h ?? 370840) * locScaleY));
        const sumRow = rowHeights.reduce((s, h) => s + h, 0);
        if (sumRow > box.h && sumRow > 0) {
          const rf = box.h / sumRow;
          rowHeights = rowHeights.map((h) => h * rf);
        }

        const parsedRows: PptTableCell[][] = trNodes.map((tr) =>
          findChildren(tr, 'tc').map((tc) => {
            const tcPr = findChild(tc, 'tcPr');
            const fill = parseFillSpec(tcPr, themeScheme, clrMap) ?? { kind: 'none' };
            const txBody = findChild(tc, 'txBody');
            const pt = txBody
              ? parseTextBody(txBody, textScale, themeScheme, clrMap, 14, '#1E293B', false)
              : { paragraphs: [], anchor: 'ctr' as const, lIns: 6, rIns: 6, tIns: 4, bIns: 4, wrap: true };

            const anchorRaw = tcPr?.attrs.anchor;
            const anchor: 't' | 'ctr' | 'b' =
              anchorRaw === 'ctr' ? 'ctr' : anchorRaw === 'b' ? 'b' : pt.anchor;
            const defaultBorder: LineStyle = { widthPx: 0.75, color: { hex: '#CBD5E1', alpha: 1 } };

            return {
              rowSpan: Number(tc.attrs.rowSpan ?? 1),
              colSpan: Number(tc.attrs.gridSpan ?? 1),
              hMerge: tc.attrs.hMerge === '1' || tc.attrs.hMerge === 'true',
              vMerge: tc.attrs.vMerge === '1' || tc.attrs.vMerge === 'true',
              fill,
              borderTop: parseLineStyle(findChild(tcPr, 'lnT'), scaleX * 9525, themeScheme, clrMap) ?? defaultBorder,
              borderBottom: parseLineStyle(findChild(tcPr, 'lnB'), scaleX * 9525, themeScheme, clrMap) ?? defaultBorder,
              borderLeft: parseLineStyle(findChild(tcPr, 'lnL'), scaleX * 9525, themeScheme, clrMap) ?? defaultBorder,
              borderRight: parseLineStyle(findChild(tcPr, 'lnR'), scaleX * 9525, themeScheme, clrMap) ?? defaultBorder,
              paragraphs: pt.paragraphs,
              anchor,
              padL: (Number(tcPr?.attrs.marL ?? 76200) / 9525) * textScale,
              padR: (Number(tcPr?.attrs.marR ?? 76200) / 9525) * textScale,
              padT: (Number(tcPr?.attrs.marT ?? 38100) / 9525) * textScale,
              padB: (Number(tcPr?.attrs.marB ?? 38100) / 9525) * textScale,
            };
          })
        );

        out.push({
          kind: 'table',
          box,
          colWidths,
          rowHeights,
          rows: parsedRows,
        });
      }
    }

    return out;
  };

  const pdfDoc = await PDFDocument.create();
  const pagePtW = pageW * 0.75;
  const pagePtH = pageH * 0.75;
  const rasterScale = 1.5;

  const picCache = new Map<string, PreparedPdfPicture | null>();

  for (let sIdx = 0; sIdx < slideKeys.length; sIdx++) {
    const slideKey = slideKeys[sIdx];
    const slideRoot = await getXmlTree(slideKey);
    if (!slideRoot) continue;
    const slideRels = await getRelsForPart(slideKey);

    // Find linked slideLayout & slideMaster
    let layoutPath: string | undefined;
    for (const rel of slideRels.values()) {
      if (rel.type.endsWith('/slideLayout') || rel.target.includes('slideLayouts/')) {
        layoutPath = rel.target;
        break;
      }
    }
    const layoutRoot = layoutPath ? await getXmlTree(layoutPath) : undefined;
    const layoutRels = layoutPath ? await getRelsForPart(layoutPath) : new Map<string, { target: string; type: string }>();

    let masterPath: string | undefined;
    for (const rel of layoutRels.values()) {
      if (rel.type.endsWith('/slideMaster') || rel.target.includes('slideMasters/')) {
        masterPath = rel.target;
        break;
      }
    }
    const masterRoot = masterPath ? await getXmlTree(masterPath) : undefined;
    const masterRels = masterPath ? await getRelsForPart(masterPath) : new Map<string, { target: string; type: string }>();

    // Color mapping inheritance
    const clrMap: Record<string, string> = { ...STANDARD_CLR_MAP };
    const masterClrMap = findChild(masterRoot, 'clrMap');
    if (masterClrMap) {
      for (const [k, v] of Object.entries(masterClrMap.attrs)) {
        clrMap[k] = v;
      }
    }
    const slideClrOvr = findChild(findChild(slideRoot, 'clrMapOvr'), 'overrideClrMapping');
    if (slideClrOvr) {
      for (const [k, v] of Object.entries(slideClrOvr.attrs)) {
        clrMap[k] = v;
      }
    }

    // Resolve background from slide -> layout -> master
    const resolveBgFrom = (root: XmlNode | undefined, rels: Map<string, { target: string; type: string }>) => {
      const cSld = findChild(root, 'cSld');
      const bg = findChild(cSld, 'bg');
      if (!bg) return undefined;
      const bgPr = findChild(bg, 'bgPr');
      if (bgPr) {
        const blip = findChild(findChild(bgPr, 'blipFill'), 'blip');
        const rId = blip?.attrs['r:embed'] || blip?.attrs.embed;
        if (rId && rels.get(rId)) {
          return {
            pic: {
              kind: 'pic' as const,
              box: { x: 0, y: 0, w: pageW, h: pageH, rotDeg: 0, flipH: false, flipV: false },
              relPath: rels.get(rId)!.target,
              alpha: 1,
            },
          };
        }
        const fill = parseFillSpec(bgPr, defaultThemeScheme, clrMap);
        if (fill && fill.kind !== 'none') return { fill };
      }
      const bgRef = findChild(bg, 'bgRef');
      if (bgRef) {
        const col = resolveDrawingColor(bgRef, defaultThemeScheme, clrMap);
        if (col) return { fill: { kind: 'solid' as const, color: col } };
      }
      return undefined;
    };

    const resolvedBg =
      resolveBgFrom(slideRoot, slideRels) ??
      resolveBgFrom(layoutRoot, layoutRels) ??
      resolveBgFrom(masterRoot, masterRels);

    const masterSpTree = findChild(findChild(masterRoot, 'cSld'), 'spTree');
    const layoutSpTree = findChild(findChild(layoutRoot, 'cSld'), 'spTree');
    const slideSpTree = findChild(findChild(slideRoot, 'cSld'), 'spTree');

    const masterPh = resolvePlaceholders(masterSpTree);
    const layoutPh = resolvePlaceholders(layoutSpTree);

    const paintStack: SlidePaintElement[] = [];

    // 1. Background image if <p:bg> uses blipFill (solid/gradient bg goes inside base SVG layer)
    if (resolvedBg?.pic) {
      paintStack.push(resolvedBg.pic);
    }

    // 2. Non-placeholder decorative elements from master & layout if showMasterSp !== '0'
    const layoutShowMaster = layoutRoot?.attrs.showMasterSp !== '0';
    const slideShowMaster = slideRoot.attrs.showMasterSp !== '0';
    if (slideShowMaster && layoutShowMaster && masterSpTree) {
      paintStack.push(
        ...collectPaintElements(masterSpTree, masterRels, defaultThemeScheme, clrMap, scaleX, scaleY, 0, 0, undefined, undefined, true)
      );
    }
    if (slideShowMaster && layoutSpTree) {
      paintStack.push(
        ...collectPaintElements(layoutSpTree, layoutRels, defaultThemeScheme, clrMap, scaleX, scaleY, 0, 0, undefined, undefined, true)
      );
    }

    // 3. Slide elements in exact XML z-order!
    if (slideSpTree) {
      paintStack.push(
        ...collectPaintElements(slideSpTree, slideRels, defaultThemeScheme, clrMap, scaleX, scaleY, 0, 0, layoutPh, masterPh, false)
      );
    }

    const pdfPage = pdfDoc.addPage([pagePtW, pagePtH]);

    // Base slide background (white default or resolved gradient/solid fill)
    const baseBgFill: FillSpec = resolvedBg?.fill ?? {
      kind: 'solid',
      color: { hex: '#FFFFFF', alpha: 1 },
    };

    // Flush consecutive SVG layers between native PDF image layers to preserve EXACT z-order!
    let svgDefs: string[] = [];
    let svgBody: string[] = [];
    let layerIdx = 0;

    // Seed background layer
    const bgAttr = fillToSvgAttr(baseBgFill, `s${sIdx}_bgGrad`, svgDefs);
    svgBody.push(`<rect width="${pageW}" height="${pageH}" fill="${bgAttr.fillAttr}"${bgAttr.extraAttrs}/>`);

    const flushSvgLayer = async () => {
      if (svgBody.length === 0) return;
      const defsBlock = svgDefs.length > 0 ? `<defs>${svgDefs.join('\n')}</defs>` : '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pageW} ${pageH}" width="${Math.round(
        pageW * rasterScale
      )}" height="${Math.round(pageH * rasterScale)}">
        ${defsBlock}
        ${svgBody.join('\n')}
      </svg>`;
      const pngBuf = await sharp(Buffer.from(svg)).png({ compressionLevel: 5 }).toBuffer();
      const embedded = await pdfDoc.embedPng(Uint8Array.from(pngBuf));
      pdfPage.drawImage(embedded, { x: 0, y: 0, width: pagePtW, height: pagePtH });
      svgDefs = [];
      svgBody = [];
      layerIdx++;
    };

    for (let elIdx = 0; elIdx < paintStack.length; elIdx++) {
      const el = paintStack[elIdx];
      if (el.kind === 'pic') {
        await flushSvgLayer();

        const cacheKey = `${el.relPath}|${el.alpha.toFixed(2)}|${el.box.flipH}|${el.box.flipV}|${
          el.srcRect ? JSON.stringify(el.srcRect) : ''
        }`;
        let prepared = picCache.get(cacheKey);
        if (prepared === undefined) {
          const entry = zip.files[el.relPath];
          prepared = entry ? await preparePictureForPdf(pdfDoc, await entry.async('nodebuffer'), el) : null;
          picCache.set(cacheKey, prepared);
        }

        if (prepared) {
          const wPt = el.box.w * 0.75;
          const hPt = el.box.h * 0.75;
          const xPt = el.box.x * 0.75;
          const yPt = pagePtH - (el.box.y + el.box.h) * 0.75;

          if (Math.abs(el.box.rotDeg) > 0.1) {
            const theta = (-el.box.rotDeg * Math.PI) / 180;
            const cx = xPt + wPt / 2;
            const cy = yPt + hPt / 2;
            const rx = cx - (wPt / 2) * Math.cos(theta) + (hPt / 2) * Math.sin(theta);
            const ry = cy - (wPt / 2) * Math.sin(theta) - (hPt / 2) * Math.cos(theta);
            pdfPage.drawImage(prepared.pdfImage, {
              x: rx,
              y: ry,
              width: wPt,
              height: hPt,
              rotate: degrees(-el.box.rotDeg),
            });
          } else {
            pdfPage.drawImage(prepared.pdfImage, { x: xPt, y: yPt, width: wPt, height: hPt });
          }
        }

        // Draw picture border stroke in next SVG batch if present
        if (el.line) {
          svgBody.push(
            `<rect x="${el.box.x.toFixed(1)}" y="${el.box.y.toFixed(1)}" width="${el.box.w.toFixed(
              1
            )}" height="${el.box.h.toFixed(1)}" fill="none"${lineToSvgAttrs(el.line)}/>`
          );
        }
      } else if (el.kind === 'shape') {
        const res = renderShapeToSvg(el, `s${sIdx}_l${layerIdx}_e${elIdx}`);
        svgDefs.push(...res.defs);
        svgBody.push(...res.elements);
      } else if (el.kind === 'table') {
        const res = renderTableToSvg(el, `s${sIdx}_l${layerIdx}_e${elIdx}`);
        svgDefs.push(...res.defs);
        svgBody.push(...res.elements);
      }
    }

    await flushSvgLayer();
  }

  await fs.writeFile(outPdfPath, await pdfDoc.save());
}
