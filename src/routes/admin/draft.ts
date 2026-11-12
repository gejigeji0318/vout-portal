import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { revokeAllSessions } from '../../auth/session';
import { buildConfig, issueStreamKey, roomOp, roomView } from '../../draft/service';
import type { GameState, Role } from '../../draft/logic';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { writeAudit } from '../../services/audit';
import { notify } from '../../services/notify';
import { getCurrentTournament } from '../../services/tournament';

/** ドラフトの進行（運営） */
export const draftAdmin = new Hono<AppEnv>();

async function ctx(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }) {
  const t = await getCurrentTournament(c.env.DB);
  if (!t) throw new HttpError(409, 'no_tournament', '開催中の大会がありません');
  return { t, actor: { kind: 'admin' as const, userId: c.get('user')!.id } };
}

draftAdmin.get('/draft/state', async (c) => {
  const { t } = await ctx(c);
  const session = await c.env.DB.prepare('SELECT id, stream_key_expires_at, confirmed_at FROM draft_sessions WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 1').bind(t.id).first();
  return c.json({ view: await roomView(c.env, t.id, { kind: 'admin' }), session });
});

/** 参加受付を始める：大会の参加者からチームと選手を読み込み、新しいドラフトを作る */
draftAdmin.post('/draft/open-lobby', async (c) => {
  const { t, actor } = await ctx(c);
  const config = await buildConfig(c.env.DB, t.id);
  const sessionId = ulid();
  const ts = nowIso();
  await c.env.DB.prepare('INSERT INTO draft_sessions (id, tournament_id, phase, created_at, updated_at) VALUES (?,?,?,?,?)').bind(sessionId, t.id, 'lobby', ts, ts).run();
  try {
    await roomOp(c.env, t.id, actor, 'setup', { config, sessionId, tournamentId: t.id });
  } catch (e) {
    await c.env.DB.prepare('DELETE FROM draft_sessions WHERE id = ?').bind(sessionId).run();
    throw e;
  }
  await writeAudit(c.env.DB, actor.userId, 'draft_open_lobby', { type: 'draft', id: sessionId });
  return c.json({ ok: true, sessionId });
});

const simpleOps: Record<string, string> = {
  start: 'start', reveal: 'reveal', 'roulette-start': 'rouletteStart', 'roulette-finish': 'rouletteFinish', 'freepick-confirm': 'freepickConfirm', 'next-round': 'nextRound',
};
for (const [path, op] of Object.entries(simpleOps)) {
  draftAdmin.post(`/draft/${path}`, async (c) => {
    const { t, actor } = await ctx(c);
    await roomOp(c.env, t.id, actor, op);
    if (op === 'start') await c.env.DB.prepare("UPDATE tournaments SET phase = 'drafting', updated_at = ? WHERE id = ?").bind(nowIso(), t.id).run();
    if (op === 'start') await writeAudit(c.env.DB, actor.userId, 'draft_start', { type: 'tournament', id: t.id });
    return c.json({ ok: true });
  });
}

/** 初期化（すべての進行データを消して「未開始」に戻す）。確定済みのドラフトは初期化できない */
draftAdmin.post('/draft/reset', async (c) => {
  const { t, actor } = await ctx(c);
  const s = await c.env.DB.prepare('SELECT id, confirmed_at FROM draft_sessions WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 1').bind(t.id).first<{ id: string; confirmed_at: string | null }>();
  if (s?.confirmed_at) throw new HttpError(409, 'confirmed', '結果を確定したドラフトは初期化できません');
  await roomOp(c.env, t.id, actor, 'reset');
  if (s) await c.env.DB.prepare('UPDATE draft_sessions SET stream_key_hash = NULL, stream_key_expires_at = NULL, phase = ?, updated_at = ? WHERE id = ?').bind('reset', nowIso(), s.id).run();
  await writeAudit(c.env.DB, actor.userId, 'draft_reset', { type: 'tournament', id: t.id });
  return c.json({ ok: true });
});

/** 配信用 URL の発行（作り直すと、前の URL は使えなくなる）。鍵は URL のハッシュ（#）に入れ、サーバーの記録に残りにくくする */
draftAdmin.post('/draft/stream-key', async (c) => {
  const { t, actor } = await ctx(c);
  const s = await c.env.DB.prepare('SELECT id FROM draft_sessions WHERE tournament_id = ? ORDER BY created_at DESC LIMIT 1').bind(t.id).first<{ id: string }>();
  if (!s) throw new HttpError(409, 'no_session', '先に参加受付を始めてください');
  const key = await issueStreamKey(c.env.DB, s.id);
  await writeAudit(c.env.DB, actor.userId, 'draft_stream_key', { type: 'draft', id: s.id });
  return c.json({ url: `${c.env.APP_ORIGIN}/draft/stream#key=${key}` });
});

/** 配信が終わったら、ドラフトの結果でチームへの振り分けを確定する */
draftAdmin.post('/draft/confirm-result', async (c) => {
  const { t, actor } = await ctx(c);
  const view = (await roomView(c.env, t.id, { kind: 'admin' })) as { phase: GameState['phase']; sessionId: string; teams: GameState['teams']; resultConfirmed: boolean };
  if (view.phase !== 'finished') throw new HttpError(409, 'not_finished', '最終結果が出てから確定してください');
  if (view.resultConfirmed) throw new HttpError(409, 'confirmed', 'すでに確定しています');
  const ts = nowIso();
  const stmts: D1PreparedStatement[] = [];
  const players: string[] = [];
  for (const [teamId, roles] of Object.entries(view.teams)) {
    for (const [role, memberId] of Object.entries(roles) as [Role, string][]) {
      players.push(memberId);
      stmts.push(c.env.DB.prepare("UPDATE tournament_members SET team_id = ?, lane = ?, updated_at = ? WHERE id = ? AND tournament_id = ? AND member_type = 'player'").bind(teamId, role, ts, memberId, t.id));
    }
  }
  stmts.push(c.env.DB.prepare('UPDATE draft_sessions SET confirmed_at = ?, confirmed_by = ?, stream_key_hash = NULL, stream_key_expires_at = NULL, updated_at = ? WHERE id = ?').bind(ts, actor.userId, ts, view.sessionId));
  await c.env.DB.batch(stmts);
  await roomOp(c.env, t.id, actor, 'markConfirmed');
  // チームが決まって見られるページが変わるので、選手にはログインし直してもらう
  const { results } = await c.env.DB.prepare(`SELECT user_id FROM tournament_members WHERE id IN (${players.map(() => '?').join(',')})`).bind(...players).all<{ user_id: string }>();
  for (const r of results) await revokeAllSessions(c.env.DB, r.user_id);
  await writeAudit(c.env.DB, actor.userId, 'draft_confirm_result', { type: 'draft', id: view.sessionId }, { players: players.length });
  await notify(c.env, 'default', 'ドラフトの結果を確定しました。各チームのページを確認してください。').catch(() => {});
  return c.json({ ok: true, assigned: players.length });
});
