/**
 * 画像をブラウザの中で描き直す。
 *  - スマホ写真の向き（回転）を正しく直す
 *  - 選んだ範囲を正方形に切り抜き、決まった大きさにそろえる
 *  - 描き直すことで、撮影場所などの情報も消える（サーバーでも改めて取り除く）
 */
export const loadBitmap = (file: File): Promise<ImageBitmap> => createImageBitmap(file, { imageOrientation: 'from-image' });

/** 元画像の (sx, sy) から一辺 side の正方形を切り抜き、size × size の WebP にする */
export function cropToSquare(bitmap: ImageBitmap, sx: number, sy: number, side: number, size = 512): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas_unavailable'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode_failed'))), 'image/webp', 0.9));
}

/** 元の画像として受け付ける種類と大きさ（描き直した後は数百 KB 程度になる） */
export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp';
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
