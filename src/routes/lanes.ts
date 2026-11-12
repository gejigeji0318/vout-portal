import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { getSetting, type LaneSnapshot } from '../services/lanes';

/** 適性レーン：公開範囲は管理者が設定する（public＝閲覧者にも公開／logged_in＝ログインした人だけ） */
export const laneRoutes = new Hono<AppEnv>();

laneRoutes.get('/', async (c) => {
  const conf = (await getSetting<{ visibility: 'public' | 'logged_in' }>(c.env.DB, 'tools.lanes')) ?? { visibility: 'public' };
  if (conf.visibility === 'logged_in' && !c.get('user')) throw new HttpError(401, 'login_required', '適性レーンはログインすると見られます');
  const snap = await getSetting<LaneSnapshot>(c.env.DB, 'lanes.snapshot');
  if (!snap) return c.json({ updated_at: null, source: 'OP.GG (https://op.gg)', champions: [] });
  // 既存の画面と同じ形（updated_at・source・champions）で返す
  return c.json({ updated_at: snap.updatedAt, source: snap.source, champions: snap.champions });
});
