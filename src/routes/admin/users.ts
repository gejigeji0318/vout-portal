import { Hono } from 'hono';
import type { AppEnv, MemberType } from '../../env';
import { revokeAllSessions } from '../../auth/session';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { isLane } from '../../lib/validate';
import { requireAdmin } from '../../middleware/auth';
import { writeAudit } from '../../services/audit';
import { notify } from '../../services/notify';
import { getCurrentTournament, getMembership } from '../../services/tournament';

export const usersAdmin = new Hono<AppEnv>();

const MEMBER_TYPES: MemberType[] = ['player', 'coach', 'staff'];

usersAdmin.get('/users', async (c) => {
  const cur = await getCurrentTournament(c.env.DB);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, COALESCE(u.display_name, u.discord_name) AS display_name, u.admin_level, u.last_login_at, u.suspended_at,
            m.member_type, m.team_id, m.lane, m.draft_role
     FROM users u
     LEFT JOIN tournament_members m ON m.user_id = u.id AND m.tournament_id = ? AND m.deleted_at IS NULL
     ORDER BY u.created_at`,
  ).bind(cur?.id ?? '').all();
  return c.json({ users: results });
});

async function assertTeam(db: D1Database, tournamentId: string, teamId: unknown): Promise<string | null> {
  if (teamId === null || teamId === undefined || teamId === '') return null;
  if (typeof teamId !== 'string') throw new HttpError(422, 'invalid_team');
  const t = await db.prepare('SELECT id FROM teams WHERE id = ? AND tournament_id = ? AND deleted_at IS NULL').bind(teamId, tournamentId).first();
  if (!t) throw new HttpError(422, 'invalid_team', 'チームが見つかりません');
  return teamId;
}

/**
 * 利用者タイプ・チーム割当の変更（管理者ロールは対象外。管理者の追加・解除は二人承認で行う）。
 * memberType を null にすると、大会の参加者から外す（登録済み閲覧者に戻る）。
 * 権限が変わるので、その人のセッションをすべて無効にする（S-2-4）。
 */
usersAdmin.put('/users/:id/membership', async (c) => {
  const actor = c.get('user')!;
  const userId = c.req.param('id');
  const cur = await getCurrentTournament(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_tournament');
  const target = await c.env.DB.prepare('SELECT id, admin_level FROM users WHERE id = ?').bind(userId).first<{ id: string; admin_level: string }>();
  if (!target) throw new HttpError(404, 'not_found');
  if (target.admin_level !== 'none') throw new HttpError(422, 'admin_cannot_be_member', '管理者は大会の参加者にできません');

  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const existing = await getMembership(c.env.DB, cur.id, userId);
  const t = nowIso();
  if (b.memberType === null) {
    if (existing) await c.env.DB.prepare('UPDATE tournament_members SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(t, t, existing.id).run();
  } else {
    if (typeof b.memberType !== 'string' || !MEMBER_TYPES.includes(b.memberType as MemberType)) throw new HttpError(422, 'invalid_member_type');
    const teamId = await assertTeam(c.env.DB, cur.id, b.teamId);
    if (b.memberType === 'staff' && teamId) throw new HttpError(422, 'staff_has_no_team', '補助スタッフはチームに所属しません');
    const lane = b.lane === undefined || b.lane === null ? null : isLane(b.lane) ? b.lane : (() => { throw new HttpError(422, 'invalid_lane'); })();
    const draftRole = b.draftRole === undefined || b.draftRole === null ? null : isLane(b.draftRole) ? b.draftRole : (() => { throw new HttpError(422, 'invalid_draft_role'); })();
    if (existing) {
      await c.env.DB.prepare('UPDATE tournament_members SET member_type=?, team_id=?, lane=?, draft_role=?, updated_at=? WHERE id = ?')
        .bind(b.memberType, teamId, lane, draftRole, t, existing.id).run();
    } else {
      await c.env.DB.prepare(
        'INSERT INTO tournament_members (id, tournament_id, user_id, member_type, team_id, lane, draft_role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(ulid(), cur.id, userId, b.memberType, teamId, lane, draftRole, t, t).run();
    }
  }
  await revokeAllSessions(c.env.DB, userId);
  await writeAudit(c.env.DB, actor.id, 'membership_change', { type: 'user', id: userId }, { memberType: b.memberType ?? null });
  return c.json({ ok: true });
});

/**
 * チーム移動（移籍）。移動先に同じレーンの選手がいる場合は、confirm: true が無いと止める（警告）。
 */
usersAdmin.post('/users/:id/transfer', async (c) => {
  const actor = c.get('user')!;
  const userId = c.req.param('id');
  const cur = await getCurrentTournament(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_tournament');
  const m = await getMembership(c.env.DB, cur.id, userId);
  if (!m || m.member_type !== 'player') throw new HttpError(422, 'not_a_player', '移籍できるのは選手だけです');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const teamId = await assertTeam(c.env.DB, cur.id, b.teamId);
  if (!teamId) throw new HttpError(422, 'invalid_team');
  if (teamId === m.team_id) throw new HttpError(422, 'same_team', '同じチームです');
  const lane = b.lane === undefined ? m.lane : isLane(b.lane) ? b.lane : (() => { throw new HttpError(422, 'invalid_lane'); })();

  if (lane && b.confirm !== true) {
    const clash = await c.env.DB.prepare(
      "SELECT 1 FROM tournament_members WHERE team_id = ? AND member_type = 'player' AND lane = ? AND deleted_at IS NULL AND user_id <> ?",
    ).bind(teamId, lane, userId).first();
    if (clash) return c.json({ error: 'same_lane_exists', message: `移動先のチームにはすでに ${lane} の選手がいます。続ける場合は確認してください` }, 409);
  }
  await c.env.DB.prepare('UPDATE tournament_members SET team_id = ?, lane = ?, updated_at = ? WHERE id = ?').bind(teamId, lane, nowIso(), m.id).run();
  await revokeAllSessions(c.env.DB, userId); // 見られるチームページが変わるため
  await writeAudit(c.env.DB, actor.id, 'transfer', { type: 'user', id: userId }, { fromTeamId: m.team_id, toTeamId: teamId, lane });
  await notify(c.env, 'transfer', 'チーム移動（移籍）がありました。詳しくはポータルで確認してください。').catch(() => false);
  // 確定済みスクリムの一覧（自動では外さない）は段階 5 で追加する
  return c.json({ ok: true });
});

/** 利用停止（全体管理者のみ）。すぐにすべてのセッションを無効にする */
usersAdmin.post('/users/:id/suspend', requireAdmin('super'), async (c) => {
  const userId = c.req.param('id');
  const actor = c.get('user')!;
  if (userId === actor.id) throw new HttpError(422, 'cannot_suspend_self', '自分自身は利用停止できません');
  const t = nowIso();
  const r = await c.env.DB.prepare("UPDATE users SET suspended_at = ?, updated_at = ? WHERE id = ? AND admin_level <> 'super'").bind(t, t, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await revokeAllSessions(c.env.DB, userId);
  await writeAudit(c.env.DB, actor.id, 'user_suspend', { type: 'user', id: userId });
  return c.json({ ok: true });
});

usersAdmin.post('/users/:id/unsuspend', requireAdmin('super'), async (c) => {
  const userId = c.req.param('id');
  const r = await c.env.DB.prepare('UPDATE users SET suspended_at = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'user_unsuspend', { type: 'user', id: userId });
  return c.json({ ok: true });
});
