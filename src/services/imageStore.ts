import type { Env } from '../env';
import { hmacHex, safeEqual } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { now, nowIso } from '../lib/time';
import { detectImageType, MAX_IMAGE_BYTES, stripMetadata } from './images';

export type ImagePurpose = 'promo' | 'staff_icon' | 'post' | 'page';

/** 画像の URL の有効期限（要件定義書 S-6-2：短時間だけ有効な URL） */
export const IMAGE_URL_TTL_SEC = 30 * 60;

/**
 * 画像を検査・無害化して R2 に保存し、images の ID を返す。
 * R2 上の名前はサーバーで付け直す（元のファイル名は使わない。S-6-6）
 */
export async function saveImage(env: Env, opts: { ownerId: string; purpose: ImagePurpose; file: File; tournamentId?: string | null }): Promise<string> {
  if (opts.file.size > MAX_IMAGE_BYTES) throw new HttpError(422, 'image_too_large', '画像は 5MB までです');
  const raw = new Uint8Array(await opts.file.arrayBuffer());
  const type = detectImageType(raw);
  if (!type) throw new HttpError(422, 'invalid_image_type', 'PNG・JPEG・WebP の画像を選んでください');
  let clean: Uint8Array;
  try {
    clean = stripMetadata(raw, type);
  } catch {
    throw new HttpError(422, 'invalid_image', '画像を読み取れませんでした。別の画像を選んでください');
  }
  const id = ulid();
  const key = `images/${id}`;
  await env.IMAGES.put(key, clean, { httpMetadata: { contentType: type } });
  const t = nowIso();
  await env.DB.prepare('INSERT INTO images (id, owner_user_id, tournament_id, purpose, r2_key, content_type, size_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, opts.ownerId, opts.tournamentId ?? null, opts.purpose, key, type, clean.length, t, t)
    .run();
  return id;
}

/** 論理削除（R2 からの物理削除は 10 日後の定期処理で行う） */
export const softDeleteImage = (db: D1Database, id: string) =>
  db.prepare('UPDATE images SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(nowIso(), nowIso(), id).run();

const sign = (env: Env, id: string, exp: number) => hmacHex(`img:${id}:${exp}`, env.SIGNING_KEY);

/**
 * 画像を見せてよい相手にだけ渡す URL。権限の確認は、この URL を作る API の側で行う
 */
export async function signedImageUrl(env: Env, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const exp = Math.floor(now().getTime() / 1000) + IMAGE_URL_TTL_SEC;
  return `/img/${id}?exp=${exp}&sig=${await sign(env, id, exp)}`;
}

export async function verifyImageSignature(env: Env, id: string, exp: string | undefined, sig: string | undefined): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) < Math.floor(now().getTime() / 1000)) return false;
  return safeEqual(await sign(env, id, Number(exp)), sig);
}
