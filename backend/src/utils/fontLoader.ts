import fs from 'node:fs/promises';

const CANDIDATE_FONT_PATHS = [
  // Linux (Debian/Ubuntu Noto CJK installed in Dockerfile)
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  // Windows common Chinese fonts (for local Windows dev)
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  // macOS
  '/System/Library/Fonts/PingFang.ttc',
];

let cachedFontPath: string | null | undefined;

export async function findCjkFontPath(): Promise<string | null> {
  if (cachedFontPath !== undefined) return cachedFontPath;

  for (const fontPath of CANDIDATE_FONT_PATHS) {
    try {
      await fs.access(fontPath);
      cachedFontPath = fontPath;
      return fontPath;
    } catch {
      // continue searching
    }
  }
  cachedFontPath = null;
  return null;
}
