import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppEnv, MemberType } from '../env';
import { makePreview, PREVIEW_COOKIE, PREVIEW_TTL_MS } from '../auth/preview';
import { HttpError } from '../lib/errors';
import { requireCloudflareAccess } from '../middleware/access';
import { requireAdmin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { getCurrentTournament } from '../services/tournament';

export const previewRoutes = new Hono<AppEnv>();

/** プレビューを始める（管理者のみ）。立場：登録済み閲覧者／選手／コーチ／補助スタッフ（選手・コーチはチームも選ぶ） */
previewRoutes.post('/start', requireCloudflareAccess, requireAdmin('sub'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const types = ['viewer', 'player', 'coach', 'staff'];
  if (typeof b.as !== 'string' || !types.includes(b.as)) throw new HttpError(422, 'invalid_role');
  const memberType = b.as === 'viewer' ? null : (b.as as MemberType);
  let teamId: string | null = null;
  if (memberType === 'player' || memberType === 'coach') {
    const t = await getCurrentTournament(c.env.DB);
    const ok = t && typeof b.teamId === 'string' && (await c.env.DB.prepare('SELECT 1 FROM teams WHERE id = ? AND tournament_id = ? AND deleted_at IS NULL').bind(b.teamId, t.id).first());
    if (!ok) throw new HttpError(422, 'invalid_team', 'チームを選んでください');
    teamId = b.teamId as string;
  }
  const user = c.get('user')!;
  setCookie(c, PREVIEW_COOKIE, await makePreview(c.env, user.sessionId, memberType, teamId), { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: PREVIEW_TTL_MS / 1000 });
  await writeAudit(c.env.DB, user.id, 'preview_start', undefined, { as: b.as, teamId });
  return c.json({ ok: true });
});

/** プレビューを終わる（プレビュー中でも、この操作だけはできる） */
previewRoutes.post('/stop', async (c) => {
  deleteCookie(c, PREVIEW_COOKIE, { path: '/', secure: true });
  return c.json({ ok: true });
});
