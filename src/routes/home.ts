import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { nowIso } from '../lib/time';
import { canSeeAnnouncement, getViewer, type AnnouncementRow } from '../services/audience';
import { targetsFor } from './announcements';
import { jstRange, teamNames } from '../services/teams';

/** TOP ページ（F-01）に必要なものをまとめて返す */
export const homeRoutes = new Hono<AppEnv>();

homeRoutes.get('/', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  const t = v.tournament;
  const now = nowIso();
  let events: { kind: string; title: string; starts_at: string; ends_at: string }[] = t
    ? (await c.env.DB.prepare('SELECT kind, title, starts_at, ends_at FROM events WHERE tournament_id = ? AND ends_at >= ? ORDER BY starts_at LIMIT 5').bind(t.id, now).all<{ kind: string; title: string; starts_at: string; ends_at: string }>()).results
    : [];
  // 自分に関係するスクリム：自分が参加メンバーに入っているもの（コーチは自チームのもの）
  if (t && v.user && v.memberType) {
    const { results: own } = await c.env.DB.prepare(
      `SELECT DISTINCT s.id, s.requester_team_id, s.opponent_team_id, s.starts_at, s.ends_at FROM scrims s LEFT JOIN scrim_participants p ON p.scrim_id = s.id
       WHERE s.tournament_id = ? AND s.status = 'confirmed' AND s.ends_at >= ? AND (p.user_id = ? OR (? = 'coach' AND ? IN (s.requester_team_id, s.opponent_team_id)))
       ORDER BY s.starts_at LIMIT 5`,
    ).bind(t.id, now, v.user.id, v.memberType, v.teamId ?? '').all<{ id: string; requester_team_id: string; opponent_team_id: string; starts_at: string; ends_at: string }>();
    const names = await teamNames(c.env.DB, t.id);
    events = [...events, ...own.map((s) => ({ kind: 'scrim', title: `スクリム ${names.get(s.requester_team_id)} vs ${names.get(s.opponent_team_id)}`, starts_at: s.starts_at, ends_at: s.ends_at }))]
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 6);
  }
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
    if (t && v.memberType) {
      // 予定表：今日以降の日程で、まだ入力していない日
      const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const missing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM schedule_slots s WHERE s.tournament_id = ? AND s.date >= ? AND NOT EXISTS (SELECT 1 FROM availabilities a WHERE a.slot_id = s.id AND a.user_id = ?)')
        .bind(t.id, today, v.user.id).first<{ n: number }>();
      if (missing?.n) todos.push({ kind: 'schedule', title: `予定表に未入力の日が ${missing.n} 日あります`, link: '/schedule' });
    }
    if (t) {
      // 人員補充：声がかかっているもの、決まったもの（これからのスクリム）
      const { results: fills } = await c.env.DB.prepare(
        `SELECT a.status, f.lane, s.starts_at, s.ends_at FROM fill_applications a JOIN fill_slots f ON f.id = a.slot_id JOIN fill_requests r ON r.id = f.request_id JOIN scrims s ON s.id = r.scrim_id
         WHERE a.user_id = ? AND r.tournament_id = ? AND a.status IN ('invited','approved') AND s.starts_at > ? ORDER BY s.starts_at`,
      ).bind(v.user.id, t.id, now).all<{ status: string; lane: string; starts_at: string; ends_at: string }>();
      for (const f of fills) todos.push({ kind: 'fill', title: f.status === 'invited' ? `人員補充の声かけに答える：${jstRange(f.starts_at, f.ends_at)}（${f.lane}）` : `人員補充で参加が決まりました：${jstRange(f.starts_at, f.ends_at)}（${f.lane}）`, link: '/fill' });
    }
  }
  let admin: { openInquiries: number } | undefined;
  if (v.isAdmin) {
    const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'open' AND deleted_at IS NULL").first<{ n: number }>();
    admin = { openInquiries: r?.n ?? 0 };
  }
  return c.json({ tournament: t ? { name: t.name, phase: t.phase } : null, events, news, todos, admin });
});
