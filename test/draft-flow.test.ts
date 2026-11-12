import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import { ulid } from '../src/lib/id';
import { nowIso } from '../src/lib/time';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, ORIGIN, req } from './helpers';

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 })); });
afterEach(() => vi.restoreAllMocks());

const ROLES = ['TOP', 'JG', 'MID', 'BOT', 'SUP'];

/** 2 チーム（A はコーチ 2 人）、各ロール 2 人ずつの選手 */
async function world() {
  const t = await makeTournament(2, 'selecting');
  const [A, B] = t.teams as [string, string];
  const coachA1 = await makeUser({ name: 'コーチA1' }); await addMember(t.id, coachA1, 'coach', A);
  const coachA2 = await makeUser({ name: 'コーチA2' }); await addMember(t.id, coachA2, 'coach', A);
  const coachB = await makeUser({ name: 'コーチB' }); await addMember(t.id, coachB, 'coach', B);
  const players: Record<string, string> = {};
  for (const role of ROLES) for (const n of [1, 2]) {
    const uid = await makeUser({ name: `${role}${n}` });
    const id = ulid();
    await env.DB.prepare('INSERT INTO tournament_members (id, tournament_id, user_id, member_type, draft_role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, t.id, uid, 'player', role, nowIso(), nowIso()).run();
    players[`${role}${n}`] = id;
  }
  const playerUser = await makeUser(); await addMember(t.id, playerUser, 'player', A, 'MID');
  const staff = await makeUser(); await addMember(t.id, staff, 'staff');
  return {
    t, A, B, players,
    a1: await loginAs(coachA1), a2: await loginAs(coachA2), b: await loginAs(coachB),
    admin: await loginAs(await makeUser({ adminLevel: 'sub' })), player: await loginAs(playerUser), staff: await loginAs(staff), viewer: await loginAs(await makeUser()),
  };
}

const op = (auth: Auth, path: string, body: unknown = {}) => req('POST', path, { auth, body });
const view = async (auth: Auth) => (await json(await req('GET', '/api/draft/state', { auth }))).view;

async function lobbyAndStart(w: Awaited<ReturnType<typeof world>>) {
  expect((await op(w.admin, '/api/admin/draft/open-lobby')).status).toBe(200);
  await op(w.a1, '/api/draft/join');
  await op(w.b, '/api/draft/join');
  expect((await op(w.admin, '/api/admin/draft/start')).status).toBe(200);
}

describe('ドラフト：見られる人', () => {
  it('コーチと運営だけが見られる。選手・補助スタッフ・閲覧者・未ログインは見られない', async () => {
    const w = await world();
    await op(w.admin, '/api/admin/draft/open-lobby');
    for (const a of [w.player, w.staff, w.viewer]) expect((await req('GET', '/api/draft/state', { auth: a })).status).toBe(403);
    expect((await req('GET', '/api/draft/state')).status).toBe(401);
    expect((await req('GET', '/api/draft/state', { auth: w.a1 })).status).toBe(200);
    expect((await req('GET', '/api/draft/state', { auth: w.admin })).status).toBe(200);
  });

  it('進行の操作は運営だけ。コーチの操作はコーチだけ', async () => {
    const w = await world();
    expect((await op(w.a1, '/api/admin/draft/open-lobby')).status).toBe(403);
    await op(w.admin, '/api/admin/draft/open-lobby');
    expect((await op(w.admin, '/api/draft/join')).status).toBe(403);
    expect((await op(w.player, '/api/draft/join')).status).toBe(403);
  });

  it('ロールごとの選手数がチーム数と合わなければ始められず、記録も残らない', async () => {
    const w = await world();
    await env.DB.prepare('UPDATE tournament_members SET draft_role = NULL WHERE id = ?').bind(w.players.SUP2).run();
    const r = await op(w.admin, '/api/admin/draft/open-lobby');
    expect(r.status).toBe(409);
    expect((await json(r)).message).toContain('SUP の選手が 1 人');
    expect(await env.DB.prepare('SELECT 1 FROM draft_sessions WHERE tournament_id = ?').bind(w.t.id).first()).toBeNull();
  });
});

describe('ドラフト：公開前の指名は、他のチーム・運営・配信には出ない', () => {
  it('自分のチームのコーチ（2 人とも）だけに見え、他のチーム・運営・配信の応答には選手の ID すら含まれない', async () => {
    const w = await world();
    await lobbyAndStart(w);
    const secret = w.players.MID1!;
    expect((await op(w.a1, '/api/draft/pick', { playerId: secret })).status).toBe(200);
    expect((await view(w.a1)).myPick).toEqual({ playerId: secret, confirmed: false });
    expect((await view(w.a2)).myPick).toEqual({ playerId: secret, confirmed: false });
    await op(w.a2, '/api/draft/confirm');
    for (const a of [w.b, w.admin]) {
      const text = JSON.stringify(await view(a));
      expect(text, '他チーム・運営に漏れていない').not.toContain(secret);
    }
    const adminView = await view(w.admin);
    expect(adminView.confirmedTeams).toEqual([w.A]); // 決定済みかどうかだけは見える
    const { url } = await json(await op(w.admin, '/api/admin/draft/stream-key'));
    const key = url.split('#key=')[1];
    const stream = await json(await req('GET', '/api/draft/stream/state', { headers: { 'X-Stream-Key': key } }));
    expect(JSON.stringify(stream)).not.toContain(secret);
  });
});

describe('ドラフト：進行', () => {
  it('全チームが参加しないと始められない。選べない選手は選べない。決定後は選び直しを押すまで変えられない', async () => {
    const w = await world();
    await op(w.admin, '/api/admin/draft/open-lobby');
    await op(w.a1, '/api/draft/join');
    expect((await op(w.admin, '/api/admin/draft/start')).status).toBe(409);
    await op(w.b, '/api/draft/join');
    await op(w.admin, '/api/admin/draft/start');
    await op(w.a1, '/api/draft/pick', { playerId: w.players.TOP1 });
    await op(w.a1, '/api/draft/confirm');
    expect((await op(w.a1, '/api/draft/pick', { playerId: w.players.JG1 })).status).toBe(409);
    await op(w.a1, '/api/draft/unconfirm');
    expect((await op(w.a1, '/api/draft/pick', { playerId: w.players.JG1 })).status).toBe(200);
    expect((await op(w.a1, '/api/draft/pick', { playerId: 'not-a-player' })).status).toBe(409);
  });

  it('5 ラウンドを最後まで進め、結果を確定すると選手がチームとレーンに振り分けられる。確定後は初期化できない', async () => {
    const w = await world();
    await lobbyAndStart(w);
    for (const role of ROLES) {
      await op(w.a1, '/api/draft/pick', { playerId: w.players[`${role}1`] }); await op(w.a1, '/api/draft/confirm');
      await op(w.b, '/api/draft/pick', { playerId: w.players[`${role}2`] }); await op(w.b, '/api/draft/confirm');
      expect((await op(w.admin, '/api/admin/draft/reveal')).status).toBe(200);
      expect((await view(w.admin)).phase).toBe('roundResult');
      await op(w.admin, '/api/admin/draft/next-round');
    }
    expect((await view(w.b)).phase).toBe('finished');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM draft_results').first<{ n: number }>())!.n).toBeGreaterThanOrEqual(10);
    expect((await op(w.admin, '/api/admin/draft/confirm-result')).status).toBe(200);
    const m = await env.DB.prepare('SELECT team_id, lane FROM tournament_members WHERE id = ?').bind(w.players.MID1).first();
    expect(m).toEqual({ team_id: w.A, lane: 'MID' });
    expect((await op(w.admin, '/api/admin/draft/confirm-result')).status).toBe(409);
    expect((await op(w.admin, '/api/admin/draft/reset')).status).toBe(409);
  });

  it('被り → ルーレット → 外れたチームは自由選択。決定はすぐ他のチームにも見え、運営の確定でラウンドが終わる', async () => {
    const w = await world();
    await lobbyAndStart(w);
    await op(w.a1, '/api/draft/pick', { playerId: w.players.TOP1 }); await op(w.a1, '/api/draft/confirm');
    await op(w.b, '/api/draft/pick', { playerId: w.players.TOP1 }); await op(w.b, '/api/draft/confirm');
    await op(w.admin, '/api/admin/draft/reveal');
    expect((await view(w.admin)).phase).toBe('collision');
    await op(w.admin, '/api/admin/draft/roulette-start');
    const r = (await view(w.b)).roulette;
    expect([w.A, w.B]).toContain(r.winner);
    await op(w.admin, '/api/admin/draft/roulette-finish');
    const loser = r.winner === w.A ? w.b : w.a1;
    const other = r.winner === w.A ? w.a1 : w.b;
    const v = await view(other);
    expect(v.phase).toBe('freepick');
    await op(loser, '/api/draft/pick', { playerId: w.players.JG2 });
    await op(loser, '/api/draft/confirm');
    expect((await view(other)).freePick.playerId).toBe(w.players.JG2);
    await op(w.admin, '/api/admin/draft/freepick-confirm');
    expect((await view(other)).phase).toBe('roundResult');
  });

  it('同じ操作を二重に行うとエラーになり、状態は 1 回分しか進まない（ボタンの連打対策）', async () => {
    const w = await world();
    await lobbyAndStart(w);
    await op(w.a1, '/api/draft/pick', { playerId: w.players.TOP1 }); await op(w.a1, '/api/draft/confirm');
    await op(w.b, '/api/draft/pick', { playerId: w.players.TOP2 }); await op(w.b, '/api/draft/confirm');
    await op(w.admin, '/api/admin/draft/reveal');
    const results = await Promise.all([op(w.admin, '/api/admin/draft/next-round'), op(w.admin, '/api/admin/draft/next-round')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await view(w.admin)).round).toBe(2);
  });
});

describe('ドラフト：配信用画面とリアルタイム接続', () => {
  it('配信用 URL は鍵が無い・違うと見られない。作り直すと前の鍵は使えない。初期化すると使えなくなる', async () => {
    const w = await world();
    await op(w.admin, '/api/admin/draft/open-lobby');
    expect((await req('GET', '/api/draft/stream/state')).status).toBe(403);
    const k1 = (await json(await op(w.admin, '/api/admin/draft/stream-key'))).url.split('#key=')[1];
    expect((await req('GET', '/api/draft/stream/state', { headers: { 'X-Stream-Key': 'x'.repeat(43) } })).status).toBe(403);
    expect((await req('GET', '/api/draft/stream/state', { headers: { 'X-Stream-Key': k1 } })).status).toBe(200);
    const k2 = (await json(await op(w.admin, '/api/admin/draft/stream-key'))).url.split('#key=')[1];
    expect((await req('GET', '/api/draft/stream/state', { headers: { 'X-Stream-Key': k1 } })).status).toBe(403);
    await op(w.admin, '/api/admin/draft/reset');
    expect((await req('GET', '/api/draft/stream/state', { headers: { 'X-Stream-Key': k2 } })).status).toBe(403);
  });

  it('リアルタイム接続：自サイト以外からの接続は断る。つながると最初の画面の中身が届く', async () => {
    const w = await world();
    await op(w.admin, '/api/admin/draft/open-lobby');
    const bad = await req('GET', '/api/draft/ws', { auth: w.a1, headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const res = await app.fetch(new Request(`${ORIGIN}/api/draft/ws`, { headers: { Upgrade: 'websocket', Origin: ORIGIN, Cookie: w.a1.cookie } }), env,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const first = new Promise<any>((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data)))));
    ws.accept();
    const msg = await first;
    expect(msg.type).toBe('view');
    expect(msg.view.phase).toBe('lobby');
    expect(msg.view.myTeamId).toBe(w.A);
    ws.close();
  });
});
