import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { revokeAllSessions } from '../../auth/session';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { addMs, DAY, HOUR, now, nowIso } from '../../lib/time';
import { requireAdmin } from '../../middleware/auth';
import { writeAudit } from '../../services/audit';
import { notify } from '../../services/notify';
import { getCurrentTournament } from '../../services/tournament';
import { endTournament, RESTORE_DAYS } from '../../services/tournamentEnd';

/**
 * 二人承認（全体管理者のみ）：管理者の追加・解除、大会終了。
 * 申請した本人は承認できない。24 時間以内に別の全体管理者が承認しなければ無効になる。実行は承認した時点
 */
export const approvalsAdmin = new Hono<AppEnv>();
approvalsAdmin.use('/approvals', requireAdmin('super'));
approvalsAdmin.use('/approvals/*', requireAdmin('super'));
approvalsAdmin.use('/tournaments/*', requireAdmin('super'));

interface Approval { id: string; kind: 'admin_grant' | 'admin_revoke' | 'tournament_end'; payload: string; status: string; requested_by: string; decided_by: string | null; expires_at: string; created_at: string }
const LABEL: Record<Approval['kind'], string> = { admin_grant: '管理者の追加', admin_revoke: '管理者の解除', tournament_end: '大会終了' };

/** 期限切れの申請を「無効」にしておく */
const expireOld = (db: D1Database) => db.prepare("UPDATE approvals SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?").bind(nowIso(), nowIso()).run();

approvalsAdmin.get('/approvals', async (c) => {
  await expireOld(c.env.DB);
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, COALESCE(r.display_name, r.discord_name) AS requester, COALESCE(d.display_name, d.discord_name) AS decider
     FROM approvals a LEFT JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by ORDER BY a.created_at DESC LIMIT 50`,
  ).all<Approval & { requester: string; decider: string | null }>();
  const ids = [...new Set(results.map((a) => (JSON.parse(a.payload) as { userId?: string }).userId).filter(Boolean))] as string[];
  const names = ids.length ? new Map((await c.env.DB.prepare(`SELECT id, COALESCE(display_name, discord_name) AS n FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: string; n: string }>()).results.map((u) => [u.id, u.n])) : new Map();
  return c.json({
    me: c.get('user')!.id,
    approvals: results.map((a) => {
      const p = JSON.parse(a.payload) as { userId?: string; level?: string; tournamentName?: string };
      return { id: a.id, kind: a.kind, label: LABEL[a.kind], status: a.status, requester: a.requester, requestedBy: a.requested_by, decider: a.decider, expiresAt: a.expires_at, createdAt: a.created_at,
        target: a.kind === 'tournament_end' ? p.tournamentName : `${names.get(p.userId ?? '') ?? '不明'}${p.level ? `（${p.level === 'super' ? '全体管理者' : '補助管理者'}）` : ''}` };
    }),
  });
});

/** 申請 */
approvalsAdmin.post('/approvals', async (c) => {
  await expireOld(c.env.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const user = c.get('user')!;
  let payload: Record<string, unknown>;
  if (b.kind === 'admin_grant' || b.kind === 'admin_revoke') {
    const target = await c.env.DB.prepare('SELECT id, admin_level FROM users WHERE id = ? AND suspended_at IS NULL').bind(String(b.userId ?? '')).first<{ id: string; admin_level: string }>();
    if (!target) throw new HttpError(422, 'invalid_user', '利用者が見つかりません');
    if (b.kind === 'admin_grant') {
      if (b.level !== 'sub' && b.level !== 'super') throw new HttpError(422, 'invalid_level');
      if (target.admin_level === b.level) throw new HttpError(409, 'already', 'すでにその種別の管理者です');
      const t = await getCurrentTournament(c.env.DB);
      if (t && (await c.env.DB.prepare('SELECT 1 FROM tournament_members WHERE tournament_id = ? AND user_id = ? AND deleted_at IS NULL').bind(t.id, target.id).first())) {
        throw new HttpError(409, 'is_member', '大会の参加者は管理者にできません。先に参加者から外してください');
      }
      payload = { userId: target.id, level: b.level };
    } else {
      if (target.admin_level === 'none') throw new HttpError(409, 'not_admin', '管理者ではありません');
      payload = { userId: target.id };
    }
  } else if (b.kind === 'tournament_end') {
    const t = await getCurrentTournament(c.env.DB);
    if (!t) throw new HttpError(409, 'no_tournament', '開催中の大会がありません');
    payload = { tournamentId: t.id, tournamentName: t.name };
  } else throw new HttpError(422, 'invalid_kind');
  const dup = await c.env.DB.prepare("SELECT 1 FROM approvals WHERE status = 'pending' AND kind = ? AND payload = ?").bind(b.kind, JSON.stringify(payload)).first();
  if (dup) throw new HttpError(409, 'duplicate', '同じ内容の申請が承認待ちです');
  const id = ulid(); const t = nowIso();
  await c.env.DB.prepare('INSERT INTO approvals (id, kind, payload, requested_by, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, b.kind, JSON.stringify(payload), user.id, addMs(now(), 24 * HOUR).toISOString(), t, t).run();
  await writeAudit(c.env.DB, user.id, 'approval_request', { type: 'approval', id }, { kind: b.kind });
  // 管理者の種別は機微情報なので、通知には種類だけを載せる
  await notify(c.env, 'approval', `二人承認の依頼：${LABEL[b.kind as Approval['kind']]}。もう 1 人の全体管理者は、管理者画面のシステム設定から確認してください（24 時間で無効になります）`).catch(() => {});
  return c.json({ id }, 201);
});

async function pending(db: D1Database, id: string) {
  await expireOld(db);
  const a = await db.prepare("SELECT * FROM approvals WHERE id = ? AND status = 'pending'").bind(id).first<Approval>();
  if (!a) throw new HttpError(409, 'not_pending', 'この申請は承認待ちではありません（期限切れ・処理済みの可能性があります）');
  return a;
}

/** 承認：申請者とは別の全体管理者だけ。承認した時点で実行する */
approvalsAdmin.post('/approvals/:id/approve', async (c) => {
  const user = c.get('user')!;
  const a = await pending(c.env.DB, c.req.param('id'));
  if (a.requested_by === user.id) throw new HttpError(403, 'own_request', '自分の申請は承認できません。もう 1 人の全体管理者が承認します');
  const p = JSON.parse(a.payload) as { userId?: string; level?: 'sub' | 'super'; tournamentId?: string };
  const claimed = await c.env.DB.prepare("UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(user.id, nowIso(), nowIso(), a.id).run();
  if (!claimed.meta.changes) throw new HttpError(409, 'not_pending');
  if (a.kind === 'admin_grant') {
    await c.env.DB.prepare('UPDATE users SET admin_level = ?, updated_at = ? WHERE id = ?').bind(p.level, nowIso(), p.userId).run();
    await revokeAllSessions(c.env.DB, p.userId!); // 権限が変わるので、ログインし直してもらう
  } else if (a.kind === 'admin_revoke') {
    const supers = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE admin_level = 'super' AND id <> ?").bind(p.userId).first<{ n: number }>();
    const target = await c.env.DB.prepare('SELECT admin_level FROM users WHERE id = ?').bind(p.userId).first<{ admin_level: string }>();
    if (target?.admin_level === 'super' && (supers?.n ?? 0) < 1) {
      await c.env.DB.prepare("UPDATE approvals SET status = 'rejected', updated_at = ? WHERE id = ?").bind(nowIso(), a.id).run();
      throw new HttpError(409, 'last_super', '全体管理者がいなくなるため、解除できません');
    }
    await c.env.DB.prepare("UPDATE users SET admin_level = 'none', updated_at = ? WHERE id = ?").bind(nowIso(), p.userId).run();
    await revokeAllSessions(c.env.DB, p.userId!);
  } else {
    await endTournament(c.env, p.tournamentId!, user.id);
  }
  await writeAudit(c.env.DB, user.id, 'approval_approve', { type: 'approval', id: a.id }, { kind: a.kind });
  return c.json({ ok: true });
});

approvalsAdmin.post('/approvals/:id/reject', async (c) => {
  const user = c.get('user')!;
  const a = await pending(c.env.DB, c.req.param('id'));
  const status = a.requested_by === user.id ? 'cancelled' : 'rejected'; // 自分の申請は取り消し、他人の申請は却下
  await c.env.DB.prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').bind(status, user.id, nowIso(), nowIso(), a.id).run();
  await writeAudit(c.env.DB, user.id, status === 'cancelled' ? 'approval_cancel' : 'approval_reject', { type: 'approval', id: a.id });
  return c.json({ ok: true, status });
});

/** 終了した大会（10 日以内なら元に戻せる） */
approvalsAdmin.get('/tournaments/ended', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, ended_at FROM tournaments WHERE phase = 'ended' AND deleted_at IS NULL AND ended_at IS NOT NULL ORDER BY ended_at DESC").all<{ id: string; name: string; ended_at: string }>();
  return c.json({ tournaments: results.map((t) => ({ ...t, purgeAt: addMs(new Date(t.ended_at), RESTORE_DAYS * DAY).toISOString() })) });
});

approvalsAdmin.post('/tournaments/:id/restore', async (c) => {
  const t = await c.env.DB.prepare("SELECT id, ended_at, phase_before_end FROM tournaments WHERE id = ? AND phase = 'ended' AND deleted_at IS NULL").bind(c.req.param('id')).first<{ id: string; ended_at: string; phase_before_end: string | null }>();
  if (!t) throw new HttpError(404, 'not_found');
  if (t.ended_at < addMs(now(), -RESTORE_DAYS * DAY).toISOString()) throw new HttpError(409, 'expired', '大会終了から 10 日を過ぎたため戻せません');
  if (await getCurrentTournament(c.env.DB)) throw new HttpError(409, 'active_exists', '開催中の大会があるため戻せません');
  await c.env.DB.prepare('UPDATE tournaments SET phase = ?, ended_at = NULL, updated_at = ? WHERE id = ?').bind(t.phase_before_end ?? 'main', nowIso(), t.id).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'tournament_restore', { type: 'tournament', id: t.id });
  return c.json({ ok: true });
});
