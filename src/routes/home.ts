import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { nowIso } from '../lib/time';
import { canSeeAnnouncement, getViewer, type AnnouncementRow } from '../services/audience';
import { targetsFor } from './announcements';

/** TOP ページ（F-01）に必要なものをまとめて返す */
export const homeRoutes = new Hono<AppEnv>();

homeRoutes.get('/', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  const t = v.tournament;
  const now = nowIso();
  const events = t
    ? (await c.env.DB.prepare('SELECT kind, title, starts_at, ends_at FROM events WHERE tournament_id = ? AND ends_at >= ? ORDER BY starts_at LIMIT 5').bind(t.id, now).all()).results
    : [];
  const { results } = await c.env.DB.prepare('SELECT * FROM announcements WHERE deleted_at IS NULL AND published_at IS NOT NULL AND published_at <= ? ORDER BY published_at DESC LIMIT 50')
    .bind(now).all<AnnouncementRow>();
  const targets = await targetsFor(c.env.DB, results.map((a) => a.id));
  const visible = results.filter((a) => canSeeAnnouncement(a, targets.get(a.id) ?? [], v));
  const news = visible.slice(0, 5).map((a) => ({ id: a.id, title: a.title, category: a.category, important: Boolean(a.important), publishedAt: a.published_at }));

  // やること：未確認の重要なお知らせ（予定表の未入力などは、その機能ができる段階で足す）
  let todos: { kind: string; title: string; link: string }[] = [];
  if (v.user && !v.isAdmin) {
    const { results: reads } = await c.env.DB.prepare('SELECT announcement_id FROM announcement_reads WHERE user_id = ?').bind(v.user.id).all<{ announcement_id: string }>();
    const read = new Set(reads.map((r) => r.announcement_id));
    todos = visible.filter((a) => a.important && !read.has(a.id)).map((a) => ({ kind: 'confirm', title: `重要なお知らせ「${a.title}」を確認する`, link: `/news/${a.id}` }));
  }
  let admin: { openInquiries: number } | undefined;
  if (v.isAdmin) {
    const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'open' AND deleted_at IS NULL").first<{ n: number }>();
    admin = { openInquiries: r?.n ?? 0 };
  }
  return c.json({ tournament: t ? { name: t.name, phase: t.phase } : null, events, news, todos, admin });
});
