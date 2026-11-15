import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { nowIso } from '../lib/time';
import { getViewer } from '../services/audience';
import { type Entry, isHHMM, overlap } from '../services/overlap';
import { jstDate, jstTime, teamNames } from '../services/teams';

/**
 * 予定表（F-05）。見られるのは大会の参加者と運営だけ。
 *  - 自チームはメンバー 1 人ずつの入力が見える
 *  - 他チームは「同時にそろう人数」と △ の時間帯だけ（個人の入力は見えない）
 *  - 運営（管理者・補助スタッフ）の入力は「運営」として 1 人ずつ、参加者全員が見られる
 *  - 所属チームが決まる前の選手の入力は、管理者だけが見られる
 */
export const scheduleRoutes = new Hono<AppEnv>();

interface Row { slot_id: string; user_id: string; status: 'o' | 't' | 'x'; start_time: string | null; end_time: string | null; changed_after_deadline: number }
interface Person { user_id: string; name: string; member_type: string | null; team_id: string | null; lane: string | null; admin_level: string }

async function context(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }) {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!v.user) throw new HttpError(401, 'login_required', 'ログインが必要です');
  if (!v.tournament) throw new HttpError(404, 'no_tournament', '開催中の大会がありません');
  if (!v.isAdmin && !v.memberType) throw new HttpError(403, 'forbidden', '予定表は大会の参加者だけが見られます');
  return { ...v, user: v.user, tournament: v.tournament };
}

scheduleRoutes.get('/', async (c) => {
  const v = await context(c);
  const db = c.env.DB;
  const tid = v.tournament.id;
  const { results: slots } = await db.prepare('SELECT id, date, std_start, std_end FROM schedule_slots WHERE tournament_id = ? ORDER BY date').bind(tid)
    .all<{ id: string; date: string; std_start: string; std_end: string }>();
  const { results: rows } = await db.prepare('SELECT a.slot_id, a.user_id, a.status, a.start_time, a.end_time, a.changed_after_deadline FROM availabilities a JOIN schedule_slots s ON s.id = a.slot_id WHERE s.tournament_id = ?')
    .bind(tid).all<Row>();
  const { results: people } = await db.prepare(
    `SELECT u.id AS user_id, COALESCE(u.display_name, u.discord_name) AS name, m.member_type, m.team_id, m.lane, u.admin_level
     FROM users u LEFT JOIN tournament_members m ON m.user_id = u.id AND m.tournament_id = ? AND m.deleted_at IS NULL
     WHERE (m.id IS NOT NULL OR u.admin_level <> 'none') AND u.suspended_at IS NULL`,
  ).bind(tid).all<Person>();
  const names = await teamNames(db, tid);
  const entriesOf = (userId: string) => Object.fromEntries(rows.filter((r) => r.user_id === userId).map((r) => [r.slot_id, { status: r.status, start: r.start_time, end: r.end_time, changedAfterDeadline: Boolean(r.changed_after_deadline) }]));
  const person = (p: Person) => ({ userId: p.user_id, name: p.name, memberType: p.member_type, lane: p.lane, entries: entriesOf(p.user_id) });
  const asEntry = (r: Row): Entry => ({ status: r.status, start: r.start_time, end: r.end_time });

  const teams = [...names.entries()].map(([teamId, name]) => {
    const players = people.filter((p) => p.team_id === teamId && p.member_type === 'player');
    const coaches = people.filter((p) => p.team_id === teamId && p.member_type === 'coach');
    const perSlot = Object.fromEntries(slots.map((s) => {
      const es = rows.filter((r) => r.slot_id === s.id && players.some((p) => p.user_id === r.user_id));
      // 他チームにも見せる △ の時間帯（誰の入力かは出さない）
      const triangles = es.filter((r) => r.status === 't' && r.start_time && r.end_time).map((r) => [r.start_time, r.end_time]);
      return [s.id, { ...overlap(es.map(asEntry)), players: players.length, triangles }];
    }));
    const isMine = v.teamId === teamId;
    return {
      id: teamId, name, isMine, perSlot,
      // 個人ごとの入力は、自チームと運営だけ
      members: isMine || v.isAdmin ? [...players, ...coaches].map(person) : undefined,
    };
  });
  const staff = people.filter((p) => p.admin_level !== 'none' || p.member_type === 'staff').map((p) => ({ userId: p.user_id, name: p.name, entries: entriesOf(p.user_id) }));
  const unassigned = v.isAdmin ? people.filter((p) => p.member_type === 'player' && !p.team_id).map(person) : undefined;
  const { results: scrims } = await db.prepare("SELECT id, requester_team_id, opponent_team_id, starts_at, ends_at FROM scrims WHERE tournament_id = ? AND status = 'confirmed'").bind(tid)
    .all<{ id: string; requester_team_id: string; opponent_team_id: string; starts_at: string; ends_at: string }>();
  return c.json({
    deadline: v.tournament.schedule_deadline, scrimStart: v.tournament.scrim_start, scrimEnd: v.tournament.scrim_end,
    slots: slots.map((s) => ({ id: s.id, date: s.date, stdStart: s.std_start, stdEnd: s.std_end })),
    mine: entriesOf(v.user.id), myTeamId: v.teamId, isAdmin: v.isAdmin,
    teams, staff, unassigned,
    scrims: scrims.map((s) => ({ id: s.id, date: jstDate(s.starts_at), start: jstTime(s.starts_at), end: jstTime(s.ends_at), teams: [names.get(s.requester_team_id), names.get(s.opponent_team_id)], teamIds: [s.requester_team_id, s.opponent_team_id] })),
  });
});

/**
 * 自分の入力（1 件でも、まとめて入力でも同じ）。○・△ は時間が必須（30 分刻み）。
 * 締切後も変更できるが、変更した入力には印を付ける
 */
scheduleRoutes.put('/mine', async (c) => {
  const v = await context(c);
  const b = (await c.req.json().catch(() => ({}))) as { entries?: unknown };
  if (!Array.isArray(b.entries) || b.entries.length === 0 || b.entries.length > 100) throw new HttpError(422, 'invalid_entries');
  const { results: slots } = await c.env.DB.prepare('SELECT id FROM schedule_slots WHERE tournament_id = ?').bind(v.tournament.id).all<{ id: string }>();
  const valid = new Set(slots.map((s) => s.id));
  const t = nowIso();
  const late = Boolean(v.tournament.schedule_deadline && t > v.tournament.schedule_deadline);
  const stmts = b.entries.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.slotId !== 'string' || !valid.has(e.slotId)) throw new HttpError(422, 'invalid_slot', '日程が見つかりません');
    if (e.status !== 'o' && e.status !== 't' && e.status !== 'x') throw new HttpError(422, 'invalid_status');
    let start: string | null = null;
    let end: string | null = null;
    if (e.status !== 'x') {
      if (!isHHMM(e.start) || !isHHMM(e.end) || e.start === '24:00') throw new HttpError(422, 'invalid_time', '○・△ のときは、参加できる時間を 30 分刻みで入力してください');
      if (e.start >= e.end) throw new HttpError(422, 'invalid_time', '終わりの時間は、始まりより後にしてください');
      start = e.start; end = e.end;
    }
    return c.env.DB.prepare(
      `INSERT INTO availabilities (id, slot_id, user_id, status, start_time, end_time, changed_after_deadline, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slot_id, user_id) DO UPDATE SET status = excluded.status, start_time = excluded.start_time, end_time = excluded.end_time,
         changed_after_deadline = MAX(availabilities.changed_after_deadline, excluded.changed_after_deadline), updated_at = excluded.updated_at`,
    ).bind(ulid(), e.slotId, v.user.id, e.status, start, end, late ? 1 : 0, t, t);
  });
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, late });
});
