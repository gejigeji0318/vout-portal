import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { requireAdmin } from '../../middleware/auth';
import { writeAudit } from '../../services/audit';
import { getSetting, putSetting, syncLanes } from '../../services/lanes';

export const lanesAdmin = new Hono<AppEnv>();

lanesAdmin.get('/lanes/status', async (c) => {
  const last = await getSetting<{ at: string; ok: boolean; message: string }>(c.env.DB, 'lanes.last_sync');
  const snap = await getSetting<{ updatedAt: string; champions: unknown[] }>(c.env.DB, 'lanes.snapshot');
  const conf = (await getSetting<{ visibility: string }>(c.env.DB, 'tools.lanes')) ?? { visibility: 'public' };
  return c.json({ lastSync: last, dataUpdatedAt: snap?.updatedAt ?? null, count: snap?.champions.length ?? 0, visibility: conf.visibility });
});

/** 今すぐ更新（F-09） */
lanesAdmin.post('/lanes/sync', async (c) => c.json(await syncLanes(c.env, c.get('user')!.id)));

/** 公開範囲（全体管理者のみ） */
lanesAdmin.put('/lanes/visibility', requireAdmin('super'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (b.visibility !== 'public' && b.visibility !== 'logged_in') throw new HttpError(422, 'invalid_visibility');
  await putSetting(c.env.DB, 'tools.lanes', { visibility: b.visibility }, c.get('user')!.id);
  await writeAudit(c.env.DB, c.get('user')!.id, 'lanes_visibility_update', undefined, { visibility: b.visibility });
  return c.json({ ok: true });
});
