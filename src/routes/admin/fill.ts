import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { nowIso } from '../../lib/time';
import { requireAdmin } from '../../middleware/auth';
import { writeAudit } from '../../services/audit';
import { obHoursBefore, postDueOb } from '../../services/fill';
import { putSetting } from '../../services/lanes';

/** 人員補充の管理者操作 */
export const fillAdmin = new Hono<AppEnv>();

/** 今すぐ OB に募集（管理者のみ。コーチはできない） */
fillAdmin.post('/fill/:id/ob-now', async (c) => {
  const r = await c.env.DB.prepare("UPDATE fill_requests SET ob_post_at = ?, updated_at = ? WHERE id = ? AND status = 'open' AND ob_posted_at IS NULL").bind(nowIso(), nowIso(), c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(409, 'not_open', 'この募集は締め切られているか、すでに OB に出ています');
  const posted = await postDueOb(c.env);
  await writeAudit(c.env.DB, c.get('user')!.id, 'fill_ob_now', { type: 'fill_request', id: c.req.param('id') });
  return c.json({ ok: true, posted });
});

fillAdmin.get('/fill/settings', async (c) => c.json({ obHoursBefore: await obHoursBefore(c.env.DB) }));

/** OB への自動募集を、スクリム開始の何時間前に出すか（全体管理者のみ） */
fillAdmin.put('/fill/settings', requireAdmin('super'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const h = Number(b.obHoursBefore);
  if (!Number.isInteger(h) || h < 0 || h > 168) throw new HttpError(422, 'invalid_hours', '0〜168 時間で入力してください');
  await putSetting(c.env.DB, 'fill.ob_hours_before', { hours: h }, c.get('user')!.id);
  await writeAudit(c.env.DB, c.get('user')!.id, 'fill_settings_update', undefined, { hours: h });
  return c.json({ ok: true });
});
