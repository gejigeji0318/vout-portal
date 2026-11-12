import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { validateText } from '../../lib/validate';
import { writeAudit } from '../../services/audit';

/** 問い合わせ対応（SC-18 の問い合わせ対応タブ） */
export const inquiriesAdmin = new Hono<AppEnv>();
const STATUSES = ['open', 'in_progress', 'done'];

inquiriesAdmin.get('/inquiries', async (c) => {
  const status = c.req.query('status');
  const where = status === 'active' ? "AND i.status <> 'done'" : STATUSES.includes(status ?? '') ? 'AND i.status = ?' : '';
  const stmt = c.env.DB.prepare(
    `SELECT i.id, i.number, i.subject, i.status, i.created_at, i.updated_at, i.assignee_user_id,
       COALESCE(u.display_name, u.discord_name) AS user_name
     FROM inquiries i JOIN users u ON u.id = i.user_id WHERE i.deleted_at IS NULL ${where} ORDER BY i.updated_at DESC LIMIT 200`,
  );
  const { results } = await (where.includes('?') ? stmt.bind(status) : stmt).all();
  return c.json({ inquiries: results });
});

inquiriesAdmin.get('/inquiries/:id', async (c) => {
  const i = await c.env.DB.prepare(
    `SELECT i.id, i.number, i.subject, i.status, i.assignee_user_id, i.created_at, COALESCE(u.display_name, u.discord_name) AS user_name
     FROM inquiries i JOIN users u ON u.id = i.user_id WHERE i.id = ? AND i.deleted_at IS NULL`,
  ).bind(c.req.param('id')).first();
  if (!i) throw new HttpError(404, 'not_found');
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.from_staff, m.body, m.created_at, COALESCE(u.display_name, u.discord_name, '削除済みの利用者') AS sender_name
     FROM inquiry_messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.inquiry_id = ? ORDER BY m.created_at`,
  ).bind(c.req.param('id')).all();
  return c.json({ inquiry: i, messages: results });
});

/** 返信。done: true なら返信と同時に完了にする */
inquiriesAdmin.post('/inquiries/:id/messages', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = validateText(b.body, 'body', 2000, true)!;
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare('SELECT 1 FROM inquiries WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!exists) throw new HttpError(404, 'not_found');
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO inquiry_messages (id, inquiry_id, sender_user_id, from_staff, body, created_at, updated_at) VALUES (?,?,?,1,?,?,?)').bind(ulid(), id, c.get('user')!.id, body, t, t),
    c.env.DB.prepare('UPDATE inquiries SET status = ?, assignee_user_id = COALESCE(assignee_user_id, ?), updated_at = ? WHERE id = ?')
      .bind(b.done === true ? 'done' : 'in_progress', c.get('user')!.id, t, id),
  ]);
  await writeAudit(c.env.DB, c.get('user')!.id, 'inquiry_reply', { type: 'inquiry', id });
  return c.json({ ok: true }, 201);
});

inquiriesAdmin.patch('/inquiries/:id', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('status' in b) {
    if (typeof b.status !== 'string' || !STATUSES.includes(b.status)) throw new HttpError(422, 'invalid_status');
    sets.push('status = ?'); vals.push(b.status);
  }
  if ('assigneeUserId' in b) {
    if (b.assigneeUserId !== null) {
      const ok = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND admin_level <> 'none'").bind(String(b.assigneeUserId)).first();
      if (!ok) throw new HttpError(422, 'invalid_assignee', '担当にできるのは管理者だけです');
    }
    sets.push('assignee_user_id = ?'); vals.push(b.assigneeUserId);
  }
  if (!sets.length) throw new HttpError(400, 'nothing_to_update');
  const r = await c.env.DB.prepare(`UPDATE inquiries SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).bind(...vals, nowIso(), c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'inquiry_update', { type: 'inquiry', id: c.req.param('id') });
  return c.json({ ok: true });
});

/** 管理者の一覧（担当を選ぶため）。種別は返さない */
inquiriesAdmin.get('/admins', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, COALESCE(display_name, discord_name) AS name FROM users WHERE admin_level <> 'none' AND suspended_at IS NULL ORDER BY created_at").all();
  return c.json({ admins: results });
});
