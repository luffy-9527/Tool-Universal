/**
 * Zero-dependency pure TypeScript JPEG -> PDF binary composer + Base64 helpers.
 * Works identically in WeChat Mini Program JSCore, H5 browser, and Node.js.
 */
export interface LocalPdfImageInput {
  jpegBytes: Uint8Array;
  width: number;
  height: number;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(triplet >> 18) & 0x3f];
    out += B64_CHARS[(triplet >> 12) & 0x3f];
    out += i + 1 < len ? B64_CHARS[(triplet >> 6) & 0x3f] : '=';
    out += i + 2 < len ? B64_CHARS[triplet & 0x3f] : '=';
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const outLen = Math.floor((clean.length * 3) / 4) - pad;
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i]);
    const c1 = B64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === '=' ? 0 : B64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === '=' ? 0 : B64_CHARS.indexOf(clean[i + 3]);
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIdx < outLen) out[outIdx++] = (triplet >> 16) & 0xff;
    if (outIdx < outLen) out[outIdx++] = (triplet >> 8) & 0xff;
    if (outIdx < outLen) out[outIdx++] = triplet & 0xff;
  }
  return out;
}

function encodeAscii(str: string): Uint8Array {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i) & 0xff;
  }
  return arr;
}

function concatUint8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function buildPdfFromJpegs(
  images: LocalPdfImageInput[],
  options: { pageSize?: 'A4' | 'fit'; margin?: number } = {}
): Uint8Array {
  if (images.length === 0) {
    throw new Error('请至少提供一张图片');
  }

  const pageSizeMode = options.pageSize || 'A4';
  const margin = Math.max(0, Math.min(60, options.margin ?? 20));
  const A4_W = 595.28;
  const A4_H = 841.89;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLength = 0;

  const pushChunk = (data: Uint8Array) => {
    chunks.push(data);
    byteLength += data.length;
  };

  const pushStr = (text: string) => {
    pushChunk(encodeAscii(text));
  };

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const pageObjIds: number[] = [];
  for (let i = 0; i < images.length; i++) {
    pageObjIds.push(3 + i * 3);
  }

  offsets[1] = byteLength;
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = byteLength;
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>\nendobj\n`);

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const pageObjId = 3 + i * 3;
    const contentObjId = 4 + i * 3;
    const imgObjId = 5 + i * 3;

    let pageW: number;
    let pageH: number;
    let drawW: number;
    let drawH: number;
    let drawX: number;
    let drawY: number;

    if (pageSizeMode === 'fit') {
      pageW = img.width;
      pageH = img.height;
      drawW = img.width;
      drawH = img.height;
      drawX = 0;
      drawY = 0;
    } else {
      pageW = A4_W;
      pageH = A4_H;
      const availW = A4_W - margin * 2;
      const availH = A4_H - margin * 2;
      const scale = Math.min(availW / img.width, availH / img.height);
      drawW = img.width * scale;
      drawH = img.height * scale;
      drawX = (A4_W - drawW) / 2;
      drawY = (A4_H - drawH) / 2;
    }

    offsets[pageObjId] = byteLength;
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(
        2
      )}] /Resources << /XObject << /Im0 ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );

    const streamCmd = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(
      2
    )} cm\n/Im0 Do\nQ\n`;
    offsets[contentObjId] = byteLength;
    pushStr(`${contentObjId} 0 obj\n<< /Length ${streamCmd.length} >>\nstream\n${streamCmd}endstream\nendobj\n`);

    offsets[imgObjId] = byteLength;
    pushStr(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpegBytes.length} >>\nstream\n`
    );
    pushChunk(img.jpegBytes);
    pushStr('\nendstream\nendobj\n');
  }

  const xrefOffset = byteLength;
  const totalObjects = 3 + images.length * 3;
  pushStr(`xref\n0 ${totalObjects}\n`);
  pushStr('0000000000 65535 f \n');
  for (let i = 1; i < totalObjects; i++) {
    const padded = String(offsets[i]).padStart(10, '0');
    pushStr(`${padded} 00000 n \n`);
  }

  pushStr(`trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return concatUint8(chunks);
}
