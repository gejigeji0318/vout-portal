import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { nowIso } from '../../lib/time';
import { validateIsoDate } from '../../lib/validate';
import { groupByCategory, listNotifyChannels } from '../../services/discord';
import { requireAdmin } from '../../middleware/auth';
import { writeAudit } from '../../services/audit';
import { NOTIFICATION_KINDS, notify, type NotificationKind, type NotifyTarget } from '../../services/notify';

/** システム設定：全体管理者のみ（SC-19） */
export const systemAdmin = new Hono<AppEnv>();
systemAdmin.use('/settings/*', requireAdmin('super'));
systemAdmin.use('/audit-logs', requireAdmin('super'));
systemAdmin.use('/discord/*', requireAdmin('super'));

const kindParam = (k: string): NotificationKind => {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(k)) throw new HttpError(404, 'not_found');
  return k as NotificationKind;
};

/** 固定のサーバーの、通知に使えるチャンネル（カテゴリーごと） */
systemAdmin.get('/discord/channels', async (c) => {
  return c.json({ groups: groupByCategory(await listNotifyChannels(c.env)) });
});

/** 送り先の一覧 */
systemAdmin.get('/settings/notifications', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'notification.%'").all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key.slice('notification.'.length), JSON.parse(r.value) as NotifyTarget]));
  return c.json({
    notifications: NOTIFICATION_KINDS.map((k) => {
      const t = map.get(k);
      return { kind: k, configured: Boolean(t), channelId: t?.channelId ?? null, channelName: t?.channelName ?? null, categoryName: t?.categoryName ?? null };
    }),
  });
});

/** 送り先の設定。チャンネルは、固定のサーバーにある「テキスト」か「アナウンス」だけ選べる */
systemAdmin.put('/settings/notifications/:kind', async (c) => {
  const kind = kindParam(c.req.param('kind'));
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.channelId !== 'string' || !/^\d{5,25}$/.test(b.channelId)) throw new HttpError(422, 'invalid_channel', 'チャンネルを選んでください');
  const ch = (await listNotifyChannels(c.env)).find((x) => x.id === b.channelId);
  if (!ch) throw new HttpError(422, 'invalid_channel', 'このサーバーのテキストチャンネルかアナウンスチャンネルを選んでください');
  const value: NotifyTarget = { channelId: ch.id, channelName: ch.name, categoryName: ch.categoryName, kind: ch.kind };
  const t = nowIso();
  await c.env.DB.prepare(
    'INSERT INTO settings (key, value, updated_by, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
  ).bind(`notification.${kind}`, JSON.stringify(value), c.get('user')!.id, t, t).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'notification_setting_update', { type: 'setting', id: `notification.${kind}` });
  return c.json({ ok: true });
});

systemAdmin.delete('/settings/notifications/:kind', async (c) => {
  const kind = kindParam(c.req.param('kind'));
  await c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`notification.${kind}`).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'notification_setting_delete', { type: 'setting', id: `notification.${kind}` });
  return c.json({ ok: true });
});

systemAdmin.post('/settings/notifications/:kind/test', async (c) => {
  const kind = kindParam(c.req.param('kind'));
  const r = await notify(c.env, kind, 'これはポータルからのテスト送信です。');
  return c.json(r);
});

/** 操作ログの閲覧：期間・操作の種類・操作した人で絞り込み（新しい順に 100 件ずつ） */
systemAdmin.get('/audit-logs', async (c) => {
  const where: string[] = [];
  const vals: unknown[] = [];
  const from = validateIsoDate(c.req.query('from'), 'from');
  const to = validateIsoDate(c.req.query('to'), 'to');
  const action = c.req.query('action');
  const actor = c.req.query('actor');
  const before = c.req.query('before');
  if (from) { where.push('at >= ?'); vals.push(from); }
  if (to) { where.push('at <= ?'); vals.push(to); }
  if (action) { where.push('action = ?'); vals.push(action.slice(0, 50)); }
  if (actor) { where.push('actor_user_id = ?'); vals.push(actor.slice(0, 40)); }
  if (before) { where.push('id < ?'); vals.push(before.slice(0, 40)); }
  const sql = `SELECT id, at, actor_user_id, action, target_type, target_id, detail FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`;
  const { results } = await c.env.DB.prepare(sql).bind(...vals).all();
  return c.json({ logs: results });
});
