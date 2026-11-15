import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { HOUR, now, nowIso } from '../lib/time';
import { validateText } from '../lib/validate';
import { getViewer, type Viewer } from '../services/audience';
import { writeAudit } from '../services/audit';
import { laneText, obHoursBefore, postDueOb } from '../services/fill';
import { sendMessage } from '../services/discord';
import { getTarget, notify } from '../services/notify';
import { jstRange, teamNames } from '../services/teams';

/**
 * スクリムの人員補充（F-07）
 *  - 募集を出せるのは、そのスクリムに出るチームのコーチと、管理者
 *  - 応募できるのは、他チームの選手・補助スタッフ・管理者と、確認済みの OB（そのスクリムに出る 2 チームの人とコーチは不可）
 *  - 声かけだけでは決まらない。本人が応募し、コーチか管理者が承認して決まる
 *  - OB には、OB 向けに募集を出したものだけを、日時・時間・レーン・人数だけで見せる（チーム名・補足は出さない）
 */
export const fillRoutes = new Hono<AppEnv>();

const LANES = ['TOP', 'JG', 'MID', 'BOT', 'SUP', 'ANY'];
interface RequestRow { id: string; scrim_id: string; team_id: string; note: string | null; status: string; ob_posted_at: string | null; starts_at: string; ends_at: string; format: string; requester_team_id: string; opponent_team_id: string; tournament_id: string }
type Who = { v: Viewer & { user: NonNullable<Viewer['user']>; tournament: NonNullable<Viewer['tournament']> }; kind: 'player' | 'staff' | 'admin' | 'coach' | 'ob' };

async function who(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }): Promise<Who> {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!v.user) throw new HttpError(401, 'login_required', 'ログインが必要です');
  if (!v.tournament) throw new HttpError(404, 'no_tournament');
  const vv = { ...v, user: v.user, tournament: v.tournament };
  if (v.isAdmin) return { v: vv, kind: 'admin' };
  if (v.memberType) return { v: vv, kind: v.memberType };
  const u = await c.env.DB.prepare('SELECT ob_verified_at FROM users WHERE id = ?').bind(v.user.id).first<{ ob_verified_at: string | null }>();
  if (u?.ob_verified_at) return { v: vv, kind: 'ob' };
  throw new HttpError(403, 'forbidden', '人員補充は大会の参加者と、確認済みの OB だけが見られます');
}

const loadRequest = (db: D1Database, id: string, tid: string) => db.prepare(
  `SELECT r.*, s.starts_at, s.ends_at, s.format, s.requester_team_id, s.opponent_team_id FROM fill_requests r JOIN scrims s ON s.id = r.scrim_id WHERE r.id = ? AND r.tournament_id = ?`,
).bind(id, tid).first<RequestRow>();

/** 募集を管理できるか：募集したチームのコーチか、管理者 */
const canManage = (w: Who, r: Pick<RequestRow, 'team_id'>) => w.kind === 'admin' || (w.kind === 'coach' && w.v.teamId === r.team_id);

fillRoutes.get('/', async (c) => {
  const w = await who(c);
  const db = c.env.DB;
  const ob = w.kind === 'ob';
  const { results } = await db.prepare(
    `SELECT r.*, s.starts_at, s.ends_at, s.format, s.requester_team_id, s.opponent_team_id FROM fill_requests r JOIN scrims s ON s.id = r.scrim_id
     WHERE r.tournament_id = ? AND r.status <> 'cancelled' ${ob ? "AND r.ob_posted_at IS NOT NULL AND r.status = 'open'" : ''} ORDER BY s.starts_at`,
  ).bind(w.v.tournament.id).all<RequestRow>();
  const ids = results.map((r) => r.id);
  const slots = ids.length ? (await db.prepare(`SELECT * FROM fill_slots WHERE request_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`).bind(...ids).all<{ id: string; request_id: string; lane: string; filled_at: string | null }>()).results : [];
  const slotIds = slots.map((s) => s.id);
  const apps = slotIds.length ? (await db.prepare(
    `SELECT a.id, a.slot_id, a.user_id, a.applicant_kind, a.status, COALESCE(u.display_name, u.discord_name) AS name, m.lane AS member_lane
     FROM fill_applications a JOIN users u ON u.id = a.user_id LEFT JOIN tournament_members m ON m.user_id = a.user_id AND m.tournament_id = ? AND m.deleted_at IS NULL
     WHERE a.slot_id IN (${slotIds.map(() => '?').join(',')}) ORDER BY a.created_at`,
  ).bind(w.v.tournament.id, ...slotIds).all<{ id: string; slot_id: string; user_id: string; applicant_kind: string; status: string; name: string; member_lane: string | null }>()).results : [];
  const names = await teamNames(db, w.v.tournament.id);
  return c.json({
    kind: w.kind,
    requests: results.map((r) => {
      const manage = canManage(w, r);
      return {
        id: r.id, status: r.status, startsAt: r.starts_at, endsAt: r.ends_at, format: r.format, obPosted: Boolean(r.ob_posted_at),
        // OB にはチーム名と補足を出さない
        ...(ob ? {} : { teamName: names.get(r.team_id), opponentName: names.get(r.team_id === r.requester_team_id ? r.opponent_team_id : r.requester_team_id), note: r.note }),
        canManage: manage,
        slots: slots.filter((s) => s.request_id === r.id).map((s) => {
          const mine = apps.find((a) => a.slot_id === s.id && a.user_id === w.v.user.id);
          const filledBy = apps.find((a) => a.slot_id === s.id && a.status === 'approved');
          return {
            id: s.id, lane: s.lane, filled: Boolean(s.filled_at),
            myApplication: mine ? { id: mine.id, status: mine.status } : null,
            // 応募者の一覧は、募集を管理できる人だけ
            ...(manage ? { applicants: apps.filter((a) => a.slot_id === s.id).map((a) => ({ id: a.id, userId: a.user_id, name: a.name, kind: a.applicant_kind, status: a.status, lane: a.member_lane })) } : {}),
            ...(!ob && filledBy ? { filledByName: filledBy.name } : {}),
          };
        }),
      };
    }),
  });
});

/** 募集を出す：確定済みで、まだ始まっていないスクリム */
fillRoutes.post('/', async (c) => {
  const w = await who(c);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = await c.env.DB.prepare("SELECT * FROM scrims WHERE id = ? AND tournament_id = ?").bind(String(b.scrimId ?? ''), w.v.tournament.id)
    .first<{ id: string; status: string; starts_at: string; ends_at: string; requester_team_id: string; opponent_team_id: string }>();
  if (!s) throw new HttpError(404, 'not_found', 'スクリムが見つかりません');
  const team = w.kind === 'admin' ? String(b.teamId ?? '') : w.kind === 'coach' ? w.v.teamId : null;
  if (!team || (team !== s.requester_team_id && team !== s.opponent_team_id)) throw new HttpError(403, 'forbidden', '自チームが出るスクリムだけ、補充を募集できます');
  if (s.status !== 'confirmed') throw new HttpError(409, 'not_confirmed', '確定したスクリムだけ、補充を募集できます');
  if (s.starts_at <= nowIso()) throw new HttpError(409, 'started', '始まったスクリムには募集できません');
  if (!Array.isArray(b.lanes) || !b.lanes.length || b.lanes.length > 5 || b.lanes.some((l) => !LANES.includes(String(l)))) throw new HttpError(422, 'invalid_lanes', '募集するレーンを選んでください（5 人まで）');
  const note = validateText(b.note, 'note', 200);
  const hours = await obHoursBefore(c.env.DB);
  const obAt = new Date(Math.max(now().getTime(), new Date(s.starts_at).getTime() - hours * HOUR)).toISOString();
  const id = ulid();
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO fill_requests (id, tournament_id, scrim_id, team_id, note, ob_post_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, w.v.tournament.id, s.id, team, note, obAt, w.v.user.id, t, t),
    ...(b.lanes as string[]).map((l) => c.env.DB.prepare('INSERT INTO fill_slots (id, request_id, lane, created_at, updated_at) VALUES (?,?,?,?,?)').bind(ulid(), id, l, t, t)),
  ]);
  const names = await teamNames(c.env.DB, w.v.tournament.id);
  await notify(c.env, 'fill', `人員補充の募集：${names.get(team)}　${jstRange(s.starts_at, s.ends_at)}　${laneText(b.lanes as string[])}（${(b.lanes as string[]).length} 人）\n${c.env.APP_ORIGIN}/fill`).catch(() => {});
  await postDueOb(c.env); // 開始まで時間がないときは、すぐ OB にも出す
  return c.json({ id, obPostAt: obAt }, 201);
});

fillRoutes.post('/:id/cancel', async (c) => {
  const w = await who(c);
  const r = await loadRequest(c.env.DB, c.req.param('id'), w.v.tournament.id);
  if (!r) throw new HttpError(404, 'not_found');
  if (!canManage(w, r)) throw new HttpError(403, 'forbidden');
  await cancelRequest(c.env.DB, r.id);
  return c.json({ ok: true });
});

export async function cancelRequest(db: D1Database, id: string) {
  const t = nowIso();
  await db.batch([
    db.prepare("UPDATE fill_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(t, id),
    db.prepare("UPDATE fill_applications SET status = 'not_selected', updated_at = ? WHERE status IN ('invited','applied') AND slot_id IN (SELECT id FROM fill_slots WHERE request_id = ?)").bind(t, id),
  ]);
}

/** 補充に入れる人か：そのスクリムに出る 2 チームの人・コーチ・時間の重なるスクリムに出る人は不可 */
async function assertEligible(db: D1Database, tid: string, r: RequestRow, userId: string, kind: string) {
  if (kind === 'coach') throw new HttpError(403, 'forbidden', 'コーチは補充に入れません');
  const m = await db.prepare('SELECT team_id FROM tournament_members WHERE tournament_id = ? AND user_id = ? AND deleted_at IS NULL').bind(tid, userId).first<{ team_id: string | null }>();
  if (m?.team_id && (m.team_id === r.requester_team_id || m.team_id === r.opponent_team_id)) throw new HttpError(409, 'own_scrim', 'このスクリムに出るチームの人は、補充に入れません');
  const clash = await db.prepare(
    "SELECT 1 FROM scrim_participants p JOIN scrims s ON s.id = p.scrim_id WHERE p.user_id = ? AND s.status = 'confirmed' AND s.starts_at < ? AND s.ends_at > ? AND s.id <> ?",
  ).bind(userId, r.ends_at, r.starts_at, r.scrim_id).first();
  if (clash) throw new HttpError(409, 'time_clash', '同じ時間に出るスクリムがあります');
}

async function slotWithRequest(db: D1Database, slotId: string, tid: string) {
  const s = await db.prepare('SELECT id, request_id, lane, filled_at FROM fill_slots WHERE id = ?').bind(slotId).first<{ id: string; request_id: string; lane: string; filled_at: string | null }>();
  const r = s ? await loadRequest(db, s.request_id, tid) : null;
  if (!s || !r) throw new HttpError(404, 'not_found', '募集が見つかりません');
  if (r.status !== 'open' || s.filled_at) throw new HttpError(409, 'closed', 'この枠はもう埋まっているか、締め切られています');
  return { s, r };
}

/**
 * 声をかけられる人の一覧（募集したチームのコーチと管理者だけ）：
 * 他チームの選手・補助スタッフ・管理者・確認済みの OB。その日の予定表の入力（○△×）も添える
 */
fillRoutes.get('/:id/candidates', async (c) => {
  const w = await who(c);
  const r = await loadRequest(c.env.DB, c.req.param('id'), w.v.tournament.id);
  if (!r) throw new HttpError(404, 'not_found');
  if (!canManage(w, r)) throw new HttpError(403, 'forbidden');
  const date = new Date(new Date(r.starts_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, COALESCE(u.display_name, u.discord_name) AS name, m.member_type, m.lane, m.team_id, u.admin_level, u.ob_verified_at,
       a.status AS avail, a.start_time, a.end_time
     FROM users u
     LEFT JOIN tournament_members m ON m.user_id = u.id AND m.tournament_id = ? AND m.deleted_at IS NULL
     LEFT JOIN schedule_slots sl ON sl.tournament_id = ? AND sl.date = ?
     LEFT JOIN availabilities a ON a.slot_id = sl.id AND a.user_id = u.id
     WHERE u.suspended_at IS NULL AND (m.id IS NOT NULL OR u.admin_level <> 'none' OR u.ob_verified_at IS NOT NULL)`,
  ).bind(w.v.tournament.id, w.v.tournament.id, date).all<{ id: string; name: string; member_type: string | null; lane: string | null; team_id: string | null; admin_level: string; ob_verified_at: string | null; avail: string | null; start_time: string | null; end_time: string | null }>();
  const names = await teamNames(c.env.DB, w.v.tournament.id);
  const people = results
    .filter((p) => p.member_type !== 'coach' && !(p.team_id && (p.team_id === r.requester_team_id || p.team_id === r.opponent_team_id)))
    .map((p) => ({
      userId: p.id, name: p.name, lane: p.lane,
      kind: p.admin_level !== 'none' ? '運営' : p.member_type === 'staff' ? '運営' : p.member_type === 'player' ? names.get(p.team_id ?? '') ?? '所属前の選手' : 'OB',
      availability: p.avail ? { status: p.avail, start: p.start_time, end: p.end_time } : null,
    }))
    .sort((a, b) => (a.availability?.status === 'o' ? 0 : a.availability?.status === 't' ? 1 : 2) - (b.availability?.status === 'o' ? 0 : b.availability?.status === 't' ? 1 : 2));
  return c.json({ people });
});

/** 応募（声かけされていれば、それに応じる） */
fillRoutes.post('/slots/:slotId/apply', async (c) => {
  const w = await who(c);
  const { s, r } = await slotWithRequest(c.env.DB, c.req.param('slotId'), w.v.tournament.id);
  if (w.kind === 'ob' && !r.ob_posted_at) throw new HttpError(404, 'not_found', '募集が見つかりません');
  await assertEligible(c.env.DB, w.v.tournament.id, r, w.v.user.id, w.kind);
  const t = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO fill_applications (id, slot_id, user_id, applicant_kind, status, created_at, updated_at) VALUES (?,?,?,?,'applied',?,?)
     ON CONFLICT(slot_id, user_id) DO UPDATE SET status = 'applied', updated_at = excluded.updated_at WHERE fill_applications.status IN ('invited','declined','withdrawn')`,
  ).bind(ulid(), s.id, w.v.user.id, w.kind, t, t).run();
  return c.json({ ok: true });
});

/** 応募の取り下げ・声かけを断る */
fillRoutes.post('/slots/:slotId/withdraw', async (c) => {
  const w = await who(c);
  const t = nowIso();
  const r = await c.env.DB.prepare(
    "UPDATE fill_applications SET status = CASE status WHEN 'invited' THEN 'declined' ELSE 'withdrawn' END, updated_at = ? WHERE slot_id = ? AND user_id = ? AND status IN ('invited','applied')",
  ).bind(t, c.req.param('slotId'), w.v.user.id).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  return c.json({ ok: true });
});

/** 声かけ：本人に知らせる（本人が応募するまでは決まらない） */
fillRoutes.post('/slots/:slotId/invite', async (c) => {
  const w = await who(c);
  const { s, r } = await slotWithRequest(c.env.DB, c.req.param('slotId'), w.v.tournament.id);
  if (!canManage(w, r)) throw new HttpError(403, 'forbidden');
  const userId = String(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).userId ?? '');
  const target = await c.env.DB.prepare(
    `SELECT u.id, u.discord_user_id, u.admin_level, u.ob_verified_at, m.member_type FROM users u
     LEFT JOIN tournament_members m ON m.user_id = u.id AND m.tournament_id = ? AND m.deleted_at IS NULL WHERE u.id = ? AND u.suspended_at IS NULL`,
  ).bind(w.v.tournament.id, userId).first<{ id: string; discord_user_id: string; admin_level: string; ob_verified_at: string | null; member_type: string | null }>();
  const kind = !target ? null : target.admin_level !== 'none' ? 'admin' : target.member_type ?? (target.ob_verified_at ? 'ob' : null);
  if (!target || !kind) throw new HttpError(422, 'invalid_user', '声をかけられるのは、大会の参加者・運営・確認済みの OB です');
  await assertEligible(c.env.DB, w.v.tournament.id, r, target.id, kind);
  const t = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO fill_applications (id, slot_id, user_id, applicant_kind, status, invited_by, created_at, updated_at) VALUES (?,?,?,?,'invited',?,?,?) ON CONFLICT(slot_id, user_id) DO NOTHING",
  ).bind(ulid(), s.id, target.id, kind, w.v.user.id, t, t).run();
  const ch = await getTarget(c.env.DB, 'fill');
  if (ch) await sendMessage(c.env, ch.channelId, `<@${target.discord_user_id}> 人員補充の声かけがあります：${jstRange(r.starts_at, r.ends_at)}　${laneText([s.lane])}\n参加できる場合は、ポータルから応募してください：${c.env.APP_ORIGIN}/fill`, [target.discord_user_id]).catch(() => {});
  return c.json({ ok: true });
});

/** 承認：この人で決定。スクリムの参加メンバーに入れ、同じ枠の他の応募は「今回は見送り」にする */
fillRoutes.post('/applications/:id/approve', async (c) => {
  const w = await who(c);
  const a = await c.env.DB.prepare('SELECT a.*, u.discord_user_id FROM fill_applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?').bind(c.req.param('id'))
    .first<{ id: string; slot_id: string; user_id: string; status: string; discord_user_id: string }>();
  if (!a) throw new HttpError(404, 'not_found');
  const { s, r } = await slotWithRequest(c.env.DB, a.slot_id, w.v.tournament.id);
  if (!canManage(w, r)) throw new HttpError(403, 'forbidden');
  if (a.status !== 'applied') throw new HttpError(409, 'not_applied', a.status === 'invited' ? '声をかけた人が応募してから承認してください' : 'この応募は承認できません');
  const t = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE fill_applications SET status = 'approved', decided_by = ?, updated_at = ? WHERE id = ?").bind(w.v.user.id, t, a.id),
    c.env.DB.prepare("UPDATE fill_applications SET status = 'not_selected', updated_at = ? WHERE slot_id = ? AND id <> ? AND status IN ('invited','applied')").bind(t, s.id, a.id),
    c.env.DB.prepare('UPDATE fill_slots SET filled_application_id = ?, filled_at = ?, updated_at = ? WHERE id = ?').bind(a.id, t, t, s.id),
    c.env.DB.prepare("INSERT OR REPLACE INTO scrim_participants (scrim_id, user_id, team_id, via, created_at, updated_at) VALUES (?,?,?,'fill',?,?)").bind(r.scrim_id, a.user_id, r.team_id, t, t),
    // 枠がすべて埋まったら、募集を締める
    c.env.DB.prepare("UPDATE fill_requests SET status = 'filled', updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fill_slots WHERE request_id = ? AND filled_at IS NULL)").bind(t, r.id, r.id),
  ]);
  await writeAudit(c.env.DB, w.v.user.id, 'fill_approve', { type: 'fill_application', id: a.id });
  const ch = await getTarget(c.env.DB, 'fill');
  if (ch) await sendMessage(c.env, ch.channelId, `<@${a.discord_user_id}> 人員補充が決まりました：${jstRange(r.starts_at, r.ends_at)}　${laneText([s.lane])}\n${c.env.APP_ORIGIN}/fill`, [a.discord_user_id]).catch(() => {});
  return c.json({ ok: true });
});
