import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { requireLogin } from '../middleware/auth';
import { type AnnouncementRow, canSeeAnnouncement, getViewer, type TargetRow, type Viewer } from '../services/audience';

export const CATEGORIES = ['general', 'schedule', 'rules', 'scrim', 'stream'] as const;

export const announcementRoutes = new Hono<AppEnv>();

async function visibleAnnouncements(db: D1Database, v: Viewer): Promise<AnnouncementRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM announcements WHERE deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= ? ORDER BY published_at DESC LIMIT 200')
    .bind(nowIso()).all<AnnouncementRow>();
  const targets = await targetsFor(db, results.filter((a) => a.visibility === 'targeted').map((a) => a.id));
  return results.filter((a) => canSeeAnnouncement(a, targets.get(a.id) ?? [], v));
}

export async function targetsFor(db: D1Database, ids: string[]): Promise<Map<string, TargetRow[]>> {
  const map = new Map<string, TargetRow[]>();
  if (!ids.length) return map;
  const { results } = await db.prepare(`SELECT announcement_id, member_type, team_id FROM announcement_targets WHERE announcement_id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all<TargetRow & { announcement_id: string }>();
  for (const r of results) map.set(r.announcement_id, [...(map.get(r.announcement_id) ?? []), { member_type: r.member_type, team_id: r.team_id }]);
  return map;
}

async function readSet(db: D1Database, userId: string | undefined): Promise<Set<string>> {
  if (!userId) return new Set();
  const { results } = await db.prepare('SELECT announcement_id FROM announcement_reads WHERE user_id = ?').bind(userId).all<{ announcement_id: string }>();
  return new Set(results.map((r) => r.announcement_id));
}

const summary = (a: AnnouncementRow, read: Set<string>) => ({
  id: a.id, title: a.title, category: a.category, important: Boolean(a.important), publishedAt: a.published_at,
  confirmed: a.important ? read.has(a.id) : null,
});

/** 見られるお知らせの一覧（未ログインなら誰でも見られるものだけ）。category で絞り込み */
announcementRoutes.get('/', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  const cat = c.req.query('category');
  const list = (await visibleAnnouncements(c.env.DB, v)).filter((a) => !cat || a.category === cat);
  const read = await readSet(c.env.DB, v.user?.id);
  return c.json({ announcements: list.map((a) => summary(a, read)) });
});

/** 未確認の重要なお知らせ（ログイン後の画面上部に出し続ける。F-15） */
announcementRoutes.get('/unconfirmed', requireLogin, async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  // 確認の対象は大会の参加者だけ。運営には出さない（確認状況の一覧と合わせる）
  if (v.isAdmin) return c.json({ announcements: [] });
  const read = await readSet(c.env.DB, v.user!.id);
  const list = (await visibleAnnouncements(c.env.DB, v)).filter((a) => a.important && !read.has(a.id));
  return c.json({ announcements: list.map((a) => summary(a, read)) });
});

announcementRoutes.get('/:id', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  const a = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?').bind(c.req.param('id')).first<AnnouncementRow>();
  const targets = a ? (await targetsFor(c.env.DB, [a.id])).get(a.id) ?? [] : [];
  // 見られないものは「存在しない」と同じ応答にする（あるかどうかも分からないように）
  if (!a || !canSeeAnnouncement(a, targets, v)) throw new HttpError(404, 'not_found', 'お知らせが見つかりません');
  const read = await readSet(c.env.DB, v.user?.id);
  return c.json({ announcement: { ...summary(a, read), body: a.body } });
});

/** 重要なお知らせの「確認しました」 */
announcementRoutes.post('/:id/confirm', requireLogin, async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  const a = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?').bind(c.req.param('id')).first<AnnouncementRow>();
  const targets = a ? (await targetsFor(c.env.DB, [a.id])).get(a.id) ?? [] : [];
  if (!a || !canSeeAnnouncement(a, targets, v)) throw new HttpError(404, 'not_found');
  if (!a.important) throw new HttpError(422, 'not_important');
  await c.env.DB.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,?,?)').bind(a.id, v.user!.id, nowIso()).run();
  return c.json({ ok: true });
});
