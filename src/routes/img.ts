import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { isUlid } from '../lib/id';
import { verifyImageSignature } from '../services/imageStore';

/** 署名付き URL でだけ画像を返す。期限切れ・改ざん・削除済みは見せない */
export const imgRoutes = new Hono<AppEnv>();

imgRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUlid(id) || !(await verifyImageSignature(c.env, id, c.req.query('exp'), c.req.query('sig')))) {
    throw new HttpError(403, 'forbidden', 'この画像を見る権限がないか、URL の期限が切れています');
  }
  const row = await c.env.DB.prepare('SELECT r2_key, content_type FROM images WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ r2_key: string; content_type: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  const obj = await c.env.IMAGES.get(row.r2_key);
  if (!obj) throw new HttpError(404, 'not_found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.content_type,
      'X-Content-Type-Options': 'nosniff',
      // 画像として以外は動かないようにする（万一、中身が画像でなくても実行させない）
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=600',
    },
  });
});
