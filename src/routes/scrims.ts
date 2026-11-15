import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { nowIso } from '../lib/time';
import { validateText } from '../lib/validate';
import { getViewer, type Viewer } from '../services/audience';
import { writeAudit } from '../services/audit';
import { notify } from '../services/notify';
import { commonWindow, overlap } from '../services/overlap';
import { fromJst, jstDate, jstRange, teamNames } from '../services/teams';

/**
 * スクリム日程調整（F-06）
 *  - 見られる人：コーチと運営は全チームのものを状態に関係なく、選手・補助スタッフは確定・実施済みのものだけ
 *  - 申請・回答・確定・中止ができるのは、自チームが関わるもののコーチと、管理者
 */
export const scrimRoutes = new Hono<AppEnv>();

interface ScrimRow { id: string; tournament_id: string; requester_team_id: string; opponent_team_id: string; format: string; status: string; starts_at: string | null; ends_at: string | null; cancel_reason: string | null; created_at: string }
const FORMATS = ['BO1', 'BO3', 'BO5'];

async function ctx(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }) {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!v.user) throw new HttpError(401, 'login_required', 'ログインが必要です');
  if (!v.tournament) throw new HttpError(404, 'no_tournament');
  if (!v.isAdmin && !v.memberType) throw new HttpError(403, 'forbidden', 'スクリムは大会の参加者だけが見られます');
  return { ...v, user: v.user, tournament: v.tournament };
}
const canSeeAll = (v: Viewer) => v.isAdmin || v.memberType === 'coach';
/** そのスクリムを操作できるか：関わるチームのコーチか、管理者 */
function actingTeam(v: Viewer, s: Pick<ScrimRow, 'requester_team_id' | 'opponent_team_id'>): string | 'admin' {
  if (v.isAdmin) return 'admin';
  if (v.memberType === 'coach' && v.teamId && (v.teamId === s.requester_team_id || v.teamId === s.opponent_team_id)) return v.teamId;
  throw new HttpError(403, 'forbidden', '自チームが関わるスクリムだけ操作できます');
}

async function load(db: D1Database, id: string, tid: string) {
  const s = await db.prepare('SELECT * FROM scrims WHERE id = ? AND tournament_id = ?').bind(id, tid).first<ScrimRow>();
  if (!s) throw new HttpError(404, 'not_found', 'スクリムが見つかりません');
  return s;
}

/** 候補日時の検査：スクリム期間内、30 分刻み、開始 < 終了 */
function readCandidates(raw: unknown, t: { scrim_start: string | null; scrim_end: string | null }) {
  if (!t.scrim_start || !t.scrim_end) throw new HttpError(409, 'no_scrim_period', 'スクリム期間が設定されていません');
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5) throw new HttpError(422, 'invalid_candidates', '候補日時を 1〜5 件入れてください');
  const first = jstDate(t.scrim_start);
  const last = jstDate(t.scrim_end);
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const s = typeof o.startsAt === 'string' ? new Date(o.startsAt) : null;
    const e = typeof o.endsAt === 'string' ? new Date(o.endsAt) : null;
    if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s >= e) throw new HttpError(422, 'invalid_candidates', '候補日時の形が正しくありません');
    if (s.getUTCMinutes() % 30 || e.getUTCMinutes() % 30) throw new HttpError(422, 'invalid_candidates', '時間は 30 分刻みで入れてください');
    const d = jstDate(s.toISOString());
    if (d < first || d > last) throw new HttpError(422, 'out_of_period', 'スクリム期間外の日付は申請できません');
    return { startsAt: s.toISOString(), endsAt: e.toISOString() };
  });
}

/** 時間が重なるもの：同じチームの確定済みスクリム（重複は不可）と、配信日程（注意だけ） */
async function conflicts(db: D1Database, tid: string, teamIds: string[], startsAt: string, endsAt: string, exceptId?: string) {
  const { results: clash } = await db.prepare(
    `SELECT id FROM scrims WHERE tournament_id = ? AND status = 'confirmed' AND id <> ? AND starts_at < ? AND ends_at > ?
     AND (requester_team_id IN (?, ?) OR opponent_team_id IN (?, ?))`,
  ).bind(tid, exceptId ?? '', endsAt, startsAt, teamIds[0], teamIds[1], teamIds[0], teamIds[1]).all();
  const { results: streams } = await db.prepare("SELECT title FROM events WHERE tournament_id = ? AND kind = 'stream' AND starts_at < ? AND ends_at > ?").bind(tid, endsAt, startsAt).all<{ title: string }>();
  return { scrimClash: clash.length > 0, streams: streams.map((s) => s.title) };
}

const log = (db: D1Database, scrimId: string, action: string, actor: string, note: string | null = null) =>
  db.prepare('INSERT INTO scrim_logs (id, scrim_id, action, actor_user_id, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(ulid(), scrimId, action, actor, note, nowIso(), nowIso());

scrimRoutes.get('/', async (c) => {
  const v = await ctx(c);
  const names = await teamNames(c.env.DB, v.tournament.id);
  const where = canSeeAll(v) ? '' : "AND status IN ('confirmed','done')";
  const { results } = await c.env.DB.prepare(`SELECT * FROM scrims WHERE tournament_id = ? ${where} ORDER BY COALESCE(starts_at, created_at) DESC`).bind(v.tournament.id).all<ScrimRow>();
  const ids = results.map((s) => s.id);
  const cands = canSeeAll(v) && ids.length
    ? (await c.env.DB.prepare(`SELECT * FROM scrim_candidates WHERE scrim_id IN (${ids.map(() => '?').join(',')}) ORDER BY starts_at`).bind(...ids).all<{ id: string; scrim_id: string; starts_at: string; ends_at: string; proposed_by_team_id: string }>()).results
    : [];
  return c.json({
    myTeamId: v.teamId, canManage: v.isAdmin || v.memberType === 'coach',
    scrims: results.map((s) => ({
      id: s.id, format: s.format, status: s.status, startsAt: s.starts_at, endsAt: s.ends_at, cancelReason: s.cancel_reason,
      requester: { id: s.requester_team_id, name: names.get(s.requester_team_id) }, opponent: { id: s.opponent_team_id, name: names.get(s.opponent_team_id) },
      candidates: cands.filter((x) => x.scrim_id === s.id).map((x) => ({ id: x.id, startsAt: x.starts_at, endsAt: x.ends_at, proposedBy: x.proposed_by_team_id })),
      mine: Boolean(v.teamId && (v.teamId === s.requester_team_id || v.teamId === s.opponent_team_id)),
    })),
  });
});

scrimRoutes.get('/:id', async (c) => {
  const v = await ctx(c);
  const s = await load(c.env.DB, c.req.param('id'), v.tournament.id);
  if (!canSeeAll(v) && !['confirmed', 'done'].includes(s.status)) throw new HttpError(404, 'not_found', 'スクリムが見つかりません');
  const names = await teamNames(c.env.DB, v.tournament.id);
  const { results: participants } = await c.env.DB.prepare(
    'SELECT p.user_id, p.team_id, p.via, COALESCE(u.display_name, u.discord_name) AS name, m.lane FROM scrim_participants p JOIN users u ON u.id = p.user_id LEFT JOIN tournament_members m ON m.user_id = p.user_id AND m.tournament_id = ? WHERE p.scrim_id = ?',
  ).bind(v.tournament.id, s.id).all();
  const logs = canSeeAll(v) ? (await c.env.DB.prepare('SELECT l.action, l.note, l.created_at, COALESCE(u.display_name, u.discord_name) AS actor FROM scrim_logs l LEFT JOIN users u ON u.id = l.actor_user_id WHERE l.scrim_id = ? ORDER BY l.created_at').bind(s.id).all()).results : [];
  return c.json({ scrim: { ...s, requesterName: names.get(s.requester_team_id), opponentName: names.get(s.opponent_team_id) }, participants, logs });
});

/**
 * 候補日時の自動提示：予定表から、自チームと相手チームの両方がそろう日程を、そろう人数の多い順に返す
 */
scrimRoutes.get('/suggest/:opponentTeamId', async (c) => {
  const v = await ctx(c);
  const mine = v.isAdmin ? c.req.query('teamId') : v.memberType === 'coach' ? v.teamId : null;
  if (!mine) throw new HttpError(403, 'forbidden');
  const opp = c.req.param('opponentTeamId');
  const { results: slots } = await c.env.DB.prepare('SELECT id, date FROM schedule_slots WHERE tournament_id = ? ORDER BY date').bind(v.tournament.id).all<{ id: string; date: string }>();
  const { results: rows } = await c.env.DB.prepare(
    `SELECT a.slot_id, a.status, a.start_time, a.end_time, m.team_id FROM availabilities a
     JOIN tournament_members m ON m.user_id = a.user_id AND m.tournament_id = ? AND m.member_type = 'player' AND m.deleted_at IS NULL
     WHERE m.team_id IN (?, ?)`,
  ).bind(v.tournament.id, mine, opp).all<{ slot_id: string; status: 'o' | 't' | 'x'; start_time: string | null; end_time: string | null; team_id: string }>();
  const out = slots.map((s) => {
    const pick = (team: string) => overlap(rows.filter((r) => r.slot_id === s.id && r.team_id === team).map((r) => ({ status: r.status, start: r.start_time, end: r.end_time })));
    const a = pick(mine);
    const b = pick(opp);
    const w = commonWindow(a, b);
    return { date: s.date, mine: a.count, opponent: b.count, window: w, startsAt: w ? fromJst(s.date, w[0]) : null, endsAt: w ? fromJst(s.date, w[1]) : null };
  }).filter((x) => x.window).sort((x, y) => Math.min(y.mine, y.opponent) - Math.min(x.mine, x.opponent) || x.date.localeCompare(y.date));
  return c.json({ suggestions: out.slice(0, 10) });
});

/** 申請 */
scrimRoutes.post('/', async (c) => {
  const v = await ctx(c);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const requester = v.isAdmin ? String(b.requesterTeamId ?? '') : v.memberType === 'coach' ? v.teamId : null;
  if (!requester) throw new HttpError(403, 'forbidden', 'スクリムを申請できるのは、コーチと管理者です');
  const names = await teamNames(c.env.DB, v.tournament.id);
  const opponent = String(b.opponentTeamId ?? '');
  if (!names.has(requester) || !names.has(opponent)) throw new HttpError(422, 'invalid_team', 'チームが見つかりません');
  if (requester === opponent) throw new HttpError(422, 'same_team', '相手は大会内の別のチームを選んでください');
  if (typeof b.format !== 'string' || !FORMATS.includes(b.format)) throw new HttpError(422, 'invalid_format');
  const cands = readCandidates(b.candidates, v.tournament);
  const id = ulid();
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO scrims (id, tournament_id, requester_team_id, opponent_team_id, format, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,'requested',?,?,?)")
      .bind(id, v.tournament.id, requester, opponent, b.format, v.user.id, t, t),
    ...cands.map((x) => c.env.DB.prepare('INSERT INTO scrim_candidates (id, scrim_id, starts_at, ends_at, proposed_by_team_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(ulid(), id, x.startsAt, x.endsAt, requester, t, t)),
    log(c.env.DB, id, 'requested', v.user.id),
  ]);
  await notify(c.env, 'scrim', `スクリムの申請：${names.get(requester)} → ${names.get(opponent)}（${b.format}・候補 ${cands.length} 件）`).catch(() => {});
  return c.json({ id }, 201);
});

/** 別案を返す（候補を出し直す）。古い候補は消し、やり取りは履歴に残す */
scrimRoutes.post('/:id/propose', async (c) => {
  const v = await ctx(c);
  const s = await load(c.env.DB, c.req.param('id'), v.tournament.id);
  const team = actingTeam(v, s);
  if (!['requested', 'negotiating'].includes(s.status)) throw new HttpError(409, 'closed', 'このスクリムは調整中ではありません');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const cands = readCandidates(b.candidates, v.tournament);
  const by = team === 'admin' ? String(b.asTeamId ?? s.opponent_team_id) : team;
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM scrim_candidates WHERE scrim_id = ?').bind(s.id),
    ...cands.map((x) => c.env.DB.prepare('INSERT INTO scrim_candidates (id, scrim_id, starts_at, ends_at, proposed_by_team_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(ulid(), s.id, x.startsAt, x.endsAt, by, t, t)),
    c.env.DB.prepare("UPDATE scrims SET status = 'negotiating', updated_at = ? WHERE id = ?").bind(t, s.id),
    log(c.env.DB, s.id, 'proposed', v.user.id),
  ]);
  const names = await teamNames(c.env.DB, v.tournament.id);
  await notify(c.env, 'scrim', `スクリムの別案：${names.get(s.requester_team_id)} × ${names.get(s.opponent_team_id)}（候補 ${cands.length} 件）`).catch(() => {});
  return c.json({ ok: true });
});

/**
 * 確定：相手側が出した候補から選ぶ（自分たちが出した候補は、自分では確定できない）。
 * 同じチームの確定済みスクリムと時間が重なるときは確定できない。配信日程と重なるときは注意を返す
 */
scrimRoutes.post('/:id/confirm', async (c) => {
  const v = await ctx(c);
  const s = await load(c.env.DB, c.req.param('id'), v.tournament.id);
  const team = actingTeam(v, s);
  if (!['requested', 'negotiating'].includes(s.status)) throw new HttpError(409, 'closed', 'このスクリムは調整中ではありません');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const cand = await c.env.DB.prepare('SELECT * FROM scrim_candidates WHERE id = ? AND scrim_id = ?').bind(String(b.candidateId ?? ''), s.id)
    .first<{ starts_at: string; ends_at: string; proposed_by_team_id: string }>();
  if (!cand) throw new HttpError(422, 'invalid_candidate', '候補を選んでください');
  if (team !== 'admin' && cand.proposed_by_team_id === team) throw new HttpError(409, 'own_proposal', '自チームが出した候補は、相手チームが確定します');
  const conf = await conflicts(c.env.DB, v.tournament.id, [s.requester_team_id, s.opponent_team_id], cand.starts_at, cand.ends_at, s.id);
  if (conf.scrimClash) throw new HttpError(409, 'double_booked', 'どちらかのチームに、同じ時間の確定済みスクリムがあります');
  const t = nowIso();
  const { results: players } = await c.env.DB.prepare("SELECT user_id, team_id FROM tournament_members WHERE tournament_id = ? AND member_type = 'player' AND deleted_at IS NULL AND team_id IN (?, ?)")
    .bind(v.tournament.id, s.requester_team_id, s.opponent_team_id).all<{ user_id: string; team_id: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE scrims SET status = 'confirmed', starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?").bind(cand.starts_at, cand.ends_at, t, s.id),
    c.env.DB.prepare('DELETE FROM scrim_candidates WHERE scrim_id = ?').bind(s.id),
    // 参加メンバーは、まず両チームの選手全員。コーチが入れ替えられる
    ...players.map((p) => c.env.DB.prepare("INSERT OR IGNORE INTO scrim_participants (scrim_id, user_id, team_id, via, created_at, updated_at) VALUES (?,?,?,'team',?,?)").bind(s.id, p.user_id, p.team_id, t, t)),
    log(c.env.DB, s.id, 'confirmed', v.user.id),
  ]);
  const names = await teamNames(c.env.DB, v.tournament.id);
  await notify(c.env, 'scrim', `スクリム確定：${names.get(s.requester_team_id)} vs ${names.get(s.opponent_team_id)}　${jstRange(cand.starts_at, cand.ends_at)}（${s.format}）`).catch(() => {});
  return c.json({ ok: true, warnings: conf.streams.map((title) => `配信「${title}」と時間が重なっています`) });
});

/** 参加メンバーの指定（自チームの分。補充で入る人は段階 5-2 の人員補充で決まる） */
scrimRoutes.put('/:id/participants', async (c) => {
  const v = await ctx(c);
  const s = await load(c.env.DB, c.req.param('id'), v.tournament.id);
  const team = actingTeam(v, s);
  if (s.status !== 'confirmed') throw new HttpError(409, 'not_confirmed', '確定したスクリムだけ指定できます');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const forTeam = team === 'admin' ? String(b.teamId ?? '') : team;
  if (forTeam !== s.requester_team_id && forTeam !== s.opponent_team_id) throw new HttpError(422, 'invalid_team');
  const ids = Array.isArray(b.userIds) ? b.userIds.filter((x): x is string => typeof x === 'string') : [];
  const { results: members } = await c.env.DB.prepare("SELECT user_id FROM tournament_members WHERE tournament_id = ? AND team_id = ? AND member_type = 'player' AND deleted_at IS NULL").bind(v.tournament.id, forTeam).all<{ user_id: string }>();
  const allowed = new Set(members.map((m) => m.user_id));
  if (ids.some((x) => !allowed.has(x))) throw new HttpError(422, 'invalid_member', 'そのチームの選手だけを選べます');
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM scrim_participants WHERE scrim_id = ? AND team_id = ? AND via = 'team'").bind(s.id, forTeam),
    ...ids.map((u) => c.env.DB.prepare("INSERT OR IGNORE INTO scrim_participants (scrim_id, user_id, team_id, via, created_at, updated_at) VALUES (?,?,?,'team',?,?)").bind(s.id, u, forTeam, t, t)),
  ]);
  return c.json({ ok: true });
});

/** 実施済みにする（開始時刻を過ぎてから） */
scrimRoutes.post('/:id/done', async (c) => {
  const v = await ctx(c);
  const s = await load(c.env.DB, c.req.param('id'), v.tournament.id);
  actingTeam(v, s);
  if (s.status !== 'confirmed') throw new HttpError(409, 'not_confirmed', '確定したスクリムだけ実施済みにできます');
  if (s.starts_at! > nowIso()) throw new HttpError(409, 'not_started', '開始時刻を過ぎてから実施済みにしてください');
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE scrims SET status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), s.id),
    log(c.env.DB, s.id, 'done', v.user.id),
  ]);
  return c.json({ ok: true });
});

/** 中止（理由が必要） */
scrimRoutes.post('/:id/cancel', async (c) => {
  const v = await ctx(c);
  const s = await load(c.env.DB, c.req.param('id'), v.tournament.id);
  actingTeam(v, s);
  if (['done', 'cancelled'].includes(s.status)) throw new HttpError(409, 'closed', 'このスクリムは中止できません');
  const reason = validateText(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).reason, 'reason', 200, true)!;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE scrims SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").bind(reason, nowIso(), s.id),
    c.env.DB.prepare('DELETE FROM scrim_candidates WHERE scrim_id = ?').bind(s.id),
    log(c.env.DB, s.id, 'cancelled', v.user.id, reason),
    // スクリムを中止したら、その人員補充の募集も締める
    c.env.DB.prepare("UPDATE fill_applications SET status = 'not_selected', updated_at = ? WHERE status IN ('invited','applied') AND slot_id IN (SELECT f.id FROM fill_slots f JOIN fill_requests r ON r.id = f.request_id WHERE r.scrim_id = ?)").bind(nowIso(), s.id),
    c.env.DB.prepare("UPDATE fill_requests SET status = 'cancelled', updated_at = ? WHERE scrim_id = ? AND status = 'open'").bind(nowIso(), s.id),
  ]);
  const names = await teamNames(c.env.DB, v.tournament.id);
  await notify(c.env, 'scrim', `スクリム中止：${names.get(s.requester_team_id)} × ${names.get(s.opponent_team_id)}${s.starts_at ? `（${jstRange(s.starts_at, s.ends_at!)}）` : ''}`).catch(() => {});
  await writeAudit(c.env.DB, v.user.id, 'scrim_cancel', { type: 'scrim', id: s.id });
  return c.json({ ok: true });
});
