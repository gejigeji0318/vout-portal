/**
 * 画像の安全処理（要件定義書 S-6）
 *  - 種類は拡張子ではなくファイルの中身（先頭のバイト）で判定し、PNG・JPEG・WebP 以外は受け付けない
 *  - 撮影場所などのメタデータ（EXIF・XMP・テキスト情報）は、保存する前に取り除く
 */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function detectImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

export function stripMetadata(b: Uint8Array, type: ImageType): Uint8Array {
  if (type === 'image/jpeg') return stripJpeg(b);
  if (type === 'image/png') return stripPng(b);
  return stripWebp(b);
}

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const bad = (): never => { throw new Error('malformed_image'); };

/** JPEG：APP1（EXIF・XMP）、APP13（IPTC）、コメントを除く。画像本体（SOS 以降）はそのまま */
function stripJpeg(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) bad();
    let m = b[i + 1]!;
    while (m === 0xff) { i++; m = b[i + 1]!; } // 埋め草の 0xFF
    if (m === 0xd9) { parts.push(b.subarray(i, i + 2)); return concat(parts); } // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > b.length) bad();
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2 || i + 2 + len > b.length) bad();
    const seg = b.subarray(i, i + 2 + len);
    if (m === 0xda) { parts.push(b.subarray(i)); return concat(parts); } // SOS 以降は画像本体
    const drop = m === 0xe1 || m === 0xed || m === 0xfe;
    if (!drop) parts.push(seg);
    i += 2 + len;
  }
  return bad();
}

/** PNG：画像に必要なチャンクだけを残す（テキスト情報や EXIF のチャンクは捨てる） */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);
function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
    const name = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) bad();
    if (PNG_KEEP.has(name)) parts.push(b.subarray(i, end));
    i = end;
    if (name === 'IEND') return concat(parts);
  }
  return bad();
}

/** WebP：EXIF と XMP のチャンクを除き、VP8X の該当フラグも下ろす */
function stripWebp(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const name = ascii(b, i, 4);
    const len = (b[i + 4]! | (b[i + 5]! << 8) | (b[i + 6]! << 16) | (b[i + 7]! << 24)) >>> 0;
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) bad();
    const chunk = b.slice(i, Math.min(end, b.length));
    if (name === 'VP8X' && chunk.length > 8) chunk[8] = chunk[8]! & ~0x0c; // EXIF(0x08)・XMP(0x04)
    if (name !== 'EXIF' && name !== 'XMP ') parts.push(chunk);
    i = end;
  }
  const body = concat(parts);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 4), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(b.subarray(8, 12), 8);
  return concat([header, body]);
}
