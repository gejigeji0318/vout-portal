import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { draftActor, publicConfig, roomFor, roomOp, roomView, verifyStreamKey } from '../draft/service';
import type { Viewer } from '../draft/view';

/** ドラフト（コーチ・運営・配信用画面） */
export const draftRoutes = new Hono<AppEnv>();

/** WebSocket で、状態が変わるたびに画面の中身を受け取る。立場はサーバーが決めて Durable Object に渡す */
async function connect(env: AppEnv['Bindings'], req: Request, tournamentId: string, viewer: Viewer) {
  if (req.headers.get('Upgrade') !== 'websocket') throw new HttpError(400, 'expected_websocket');
  const headers = new Headers({ Upgrade: 'websocket', 'X-Draft-Viewer': JSON.stringify(viewer) });
  return roomFor(env, tournamentId).fetch('https://draft/ws', { headers });
}

draftRoutes.get('/ws', async (c) => {
  // ログインの Cookie を使う接続なので、自サイト以外のページからの接続は断る（WebSocket の乗っ取り対策）
  if (c.req.header('Origin') !== c.env.APP_ORIGIN) throw new HttpError(403, 'bad_origin');
  const { tournamentId, viewer } = await draftActor(c);
  return connect(c.env, c.req.raw, tournamentId, viewer);
});

/** 接続が切れたときの予備：今の状態をそのまま返す */
draftRoutes.get('/state', async (c) => {
  const { tournamentId, viewer } = await draftActor(c);
  return c.json({ view: await roomView(c.env, tournamentId, viewer) });
});

draftRoutes.get('/config', async (c) => {
  const { tournamentId, actor } = await draftActor(c);
  return c.json({ config: await publicConfig(c.env, tournamentId), myTeamId: actor.teamId ?? null, isAdmin: actor.kind === 'admin' });
});

for (const op of ['join', 'pick', 'confirm', 'unconfirm'] as const) {
  draftRoutes.post(`/${op}`, async (c) => {
    const { tournamentId, actor } = await draftActor(c);
    if (actor.kind !== 'coach') throw new HttpError(403, 'forbidden', 'この操作はコーチだけができます');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    await roomOp(c.env, tournamentId, actor, op, op === 'pick' ? { playerId: b.playerId } : {});
    return c.json({ ok: true });
  });
}

// ---- 配信用画面（ログイン不要。推測できない鍵が必要） ----
const streamKey = (c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) => c.req.header('X-Stream-Key') ?? c.req.query('key');

draftRoutes.get('/stream/state', async (c) => {
  const tid = await verifyStreamKey(c.env.DB, streamKey(c));
  return c.json({ view: await roomView(c.env, tid, { kind: 'stream' }) });
});
draftRoutes.get('/stream/config', async (c) => {
  const tid = await verifyStreamKey(c.env.DB, streamKey(c));
  return c.json({ config: await publicConfig(c.env, tid) });
});
draftRoutes.get('/stream/ws', async (c) => {
  const tid = await verifyStreamKey(c.env.DB, streamKey(c));
  return connect(c.env, c.req.raw, tid, { kind: 'stream' });
});
