import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { addMs, DAY, now, nowIso } from '../lib/time';
import { validateText } from '../lib/validate';
import { requireLogin } from '../middleware/auth';
import { notify } from '../services/notify';

/** 運営への問い合わせ（F-17）。ログインした人だけ。添付なし */
export const inquiryRoutes = new Hono<AppEnv>();
inquiryRoutes.use('*', requireLogin);

const LIMIT_PER_DAY = 5;

inquiryRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.number, i.subject, i.status, i.created_at,
       (SELECT MAX(created_at) FROM inquiry_messages m WHERE m.inquiry_id = i.id AND m.from_staff = 1) AS last_reply_at
     FROM inquiries i WHERE i.user_id = ? AND i.deleted_at IS NULL ORDER BY i.created_at DESC`,
  ).bind(c.get('user')!.id).all();
  return c.json({ inquiries: results });
});

inquiryRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const subject = validateText(b.subject, 'subject', 60, true)!;
  const body = validateText(b.body, 'body', 2000, true)!;
  const since = addMs(now(), -DAY).toISOString();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM inquiries WHERE user_id = ? AND created_at > ?').bind(user.id, since).first<{ n: number }>();
  if ((recent?.n ?? 0) >= LIMIT_PER_DAY) throw new HttpError(429, 'too_many', `問い合わせは 1 日に ${LIMIT_PER_DAY} 件までです。時間をおいてお試しください`);
  const id = ulid();
  const t = nowIso();
  const next = ((await c.env.DB.prepare('SELECT MAX(number) AS n FROM inquiries').first<{ n: number | null }>())?.n ?? 0) + 1;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO inquiries (id, number, user_id, subject, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(id, next, user.id, subject, t, t),
    c.env.DB.prepare('INSERT INTO inquiry_messages (id, inquiry_id, sender_user_id, from_staff, body, created_at, updated_at) VALUES (?,?,?,0,?,?,?)').bind(ulid(), id, user.id, body, t, t),
  ]);
  // 管理者向けの通知は、受付番号と件名だけ（本文は載せない）
  await notify(c.env, 'inquiry', `問い合わせを受け付けました：No.${String(next).padStart(4, '0')}「${subject}」\n${c.env.APP_ORIGIN}/admin?tab=inquiries`).catch(() => {});
  return c.json({ id, number: next }, 201);
});

async function ownInquiry(db: D1Database, id: string, userId: string) {
  const i = await db.prepare('SELECT id, number, subject, status, created_at FROM inquiries WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, userId)
    .first<{ id: string; number: number; subject: string; status: string; created_at: string }>();
  if (!i) throw new HttpError(404, 'not_found', '問い合わせが見つかりません');
  return i;
}

/** 本人の問い合わせとやり取り。運営の返信は、誰が書いたかを出さず「運営」とだけ示す */
inquiryRoutes.get('/:id', async (c) => {
  const i = await ownInquiry(c.env.DB, c.req.param('id'), c.get('user')!.id);
  const { results } = await c.env.DB.prepare('SELECT id, from_staff, body, created_at FROM inquiry_messages WHERE inquiry_id = ? ORDER BY created_at').bind(i.id)
    .all<{ id: string; from_staff: number; body: string; created_at: string }>();
  return c.json({ inquiry: i, messages: results.map((m) => ({ id: m.id, fromStaff: Boolean(m.from_staff), body: m.body, createdAt: m.created_at })) });
});

inquiryRoutes.post('/:id/messages', async (c) => {
  const user = c.get('user')!;
  const i = await ownInquiry(c.env.DB, c.req.param('id'), user.id);
  const body = validateText(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).body, 'body', 2000, true)!;
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO inquiry_messages (id, inquiry_id, sender_user_id, from_staff, body, created_at, updated_at) VALUES (?,?,?,0,?,?,?)').bind(ulid(), i.id, user.id, body, t, t),
    // 完了したものに追記されたら、もう一度「未対応」に戻す
    c.env.DB.prepare("UPDATE inquiries SET status = CASE WHEN status = 'done' THEN 'open' ELSE status END, updated_at = ? WHERE id = ?").bind(t, i.id),
  ]);
  if (i.status === 'done') await notify(c.env, 'inquiry', `問い合わせ No.${String(i.number).padStart(4, '0')} に追記がありました`).catch(() => {});
  return c.json({ ok: true }, 201);
});
