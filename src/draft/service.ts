import type { Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { signedImageUrl } from '../services/imageStore';
import { getCurrentTournament, getMembership } from '../services/tournament';
import { type DraftConfig, type DraftPlayer, type DraftTeam, ROLES, type Role } from './logic';
import type { Actor } from './room';
import type { Viewer } from './view';

export const roomFor = (env: Env, tournamentId: string) => env.DRAFT.get(env.DRAFT.idFromName(tournamentId));

/** ドラフトを見られる人：運営と、チームに割り当てられたコーチだけ（選手・補助スタッフ・閲覧者は見られない） */
export async function draftActor(c: Context<AppEnv>): Promise<{ tournamentId: string; actor: Actor; viewer: Viewer }> {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'login_required', 'ログインが必要です');
  const t = await getCurrentTournament(c.env.DB);
  if (!t) throw new HttpError(404, 'no_tournament', '開催中の大会がありません');
  if (user.adminLevel !== 'none') return { tournamentId: t.id, actor: { kind: 'admin', userId: user.id }, viewer: { kind: 'admin' } };
  const m = await getMembership(c.env.DB, t.id, user.id);
  if (m?.member_type === 'coach' && m.team_id) return { tournamentId: t.id, actor: { kind: 'coach', teamId: m.team_id, userId: user.id }, viewer: { kind: 'coach', teamId: m.team_id } };
  throw new HttpError(403, 'forbidden', 'ドラフトの画面は、コーチと運営だけが見られます');
}

/** Durable Object への操作。運営・コーチの立場はサーバーが決めて渡す（利用者からは渡させない） */
export async function roomOp(env: Env, tournamentId: string, actor: Actor, op: string, args: Record<string, unknown> = {}) {
  const res = await roomFor(env, tournamentId).fetch('https://draft/op', { method: 'POST', body: JSON.stringify({ op, actor, args }) });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new HttpError(409, 'draft', String(data.message ?? '操作できませんでした'));
  return data;
}

export async function roomView(env: Env, tournamentId: string, viewer: Viewer) {
  return (await roomFor(env, tournamentId).fetch('https://draft/view', { headers: { 'X-Draft-Viewer': JSON.stringify(viewer) } })).json();
}

/** 大会の参加者からドラフトの設定（チームと選手）を作る */
export async function buildConfig(db: D1Database, tournamentId: string): Promise<DraftConfig> {
  const { results: teamRows } = await db.prepare('SELECT id, name FROM teams WHERE tournament_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(tournamentId).all<{ id: string; name: string | null }>();
  const { results: members } = await db.prepare(
    `SELECT m.id, m.user_id, m.member_type, m.team_id, m.draft_role, COALESCE(u.display_name, u.discord_name) AS name, a.rank, a.photo_image_id
     FROM tournament_members m JOIN users u ON u.id = m.user_id
     LEFT JOIN recruitments r ON r.tournament_id = m.tournament_id
     LEFT JOIN applications a ON a.recruitment_id = r.id AND a.user_id = m.user_id
     WHERE m.tournament_id = ? AND m.deleted_at IS NULL`,
  ).bind(tournamentId).all<{ id: string; user_id: string; member_type: string; team_id: string | null; draft_role: Role | null; name: string; rank: string | null; photo_image_id: string | null }>();
  const teams: DraftTeam[] = teamRows.map((t, i) => {
    const coaches = members.filter((m) => m.member_type === 'coach' && m.team_id === t.id);
    return { id: t.id, name: t.name ?? `チーム ${i + 1}`, coachNames: coaches.map((c) => c.name), coachUserIds: coaches.map((c) => c.user_id) };
  });
  const players: DraftPlayer[] = members.filter((m) => m.member_type === 'player' && m.draft_role)
    .sort((a, b) => ROLES.indexOf(a.draft_role!) - ROLES.indexOf(b.draft_role!))
    .map((m) => ({ id: m.id, name: m.name, role: m.draft_role!, rank: m.rank, iconImageId: m.photo_image_id }));
  return { teams, players, roles: ROLES, totalRounds: ROLES.length };
}

/** 画面用の設定（宣材写真は短時間の URL にして渡す） */
export async function publicConfig(env: Env, tournamentId: string) {
  const { config } = (await (await roomFor(env, tournamentId).fetch('https://draft/config')).json()) as { config: DraftConfig | null };
  if (!config) return null;
  return {
    roles: config.roles, totalRounds: config.totalRounds,
    teams: config.teams.map((t) => ({ id: t.id, name: t.name, coachNames: t.coachNames })),
    players: await Promise.all(config.players.map(async (p) => ({ id: p.id, name: p.name, role: p.role, rank: p.rank, iconUrl: await signedImageUrl(env, p.iconImageId) }))),
  };
}

// ---- 配信用 URL の鍵 ----
export async function issueStreamKey(db: D1Database, sessionId: string): Promise<string> {
  const key = randomToken(32);
  const expires = new Date(Date.now() + 24 * 3600e3).toISOString();
  await db.prepare('UPDATE draft_sessions SET stream_key_hash = ?, stream_key_expires_at = ?, updated_at = ? WHERE id = ?').bind(await sha256Hex(key), expires, nowIso(), sessionId).run();
  return key;
}

/** 配信用の鍵を確かめて、その大会を返す。鍵が無い・違う・期限切れなら見せない */
export async function verifyStreamKey(db: D1Database, key: string | undefined): Promise<string> {
  if (!key || key.length > 100) throw new HttpError(403, 'forbidden', '配信用 URL が正しくないか、期限が切れています');
  const t = await getCurrentTournament(db);
  const s = t ? await db.prepare('SELECT stream_key_hash, stream_key_expires_at FROM draft_sessions WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(t.id).first<{ stream_key_hash: string | null; stream_key_expires_at: string | null }>() : null;
  if (!t || !s?.stream_key_hash || !s.stream_key_expires_at || s.stream_key_expires_at < nowIso() || !safeEqual(s.stream_key_hash, await sha256Hex(key))) {
    throw new HttpError(403, 'forbidden', '配信用 URL が正しくないか、期限が切れています');
  }
  return t.id;
}
