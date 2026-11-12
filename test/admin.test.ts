import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, req } from './helpers';

let sup: Auth;
let sub: Auth;
beforeEach(async () => {
  sup = await loginAs(await makeUser({ adminLevel: 'super' }));
  sub = await loginAs(await makeUser({ adminLevel: 'sub' }));
});
afterEach(() => vi.restoreAllMocks());

const activeTeams = async (tid: string) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ? AND deleted_at IS NULL').bind(tid).first<{ n: number }>())!.n;

describe('大会設定', () => {
  it('大会を作るとチーム枠が参加チーム数だけできる。開催中の大会があれば作れない', async () => {
    await env.DB.prepare("UPDATE tournaments SET phase = 'ended'").run();
    const body = { name: '冬の大会', periodStart: '2027-01-10', periodEnd: '2027-02-28', teamCount: 4 };
    const res = await req('POST', '/api/admin/tournament', { auth: sub, body });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    expect(await activeTeams(id)).toBe(4);
    expect((await req('POST', '/api/admin/tournament', { auth: sub, body })).status).toBe(409);
  });

  it('チーム数を減らすとき、コーチが割り当てられたチーム枠は消せない', async () => {
    const t = await makeTournament(3);
    for (const team of t.teams) await addMember(t.id, await makeUser(), 'coach', team);
    expect((await req('PATCH', `/api/admin/tournament/${t.id}`, { auth: sub, body: { teamCount: 2 } })).status).toBe(409);
    // 1 チームのコーチを外せば減らせる
    await env.DB.prepare('UPDATE tournament_members SET team_id = NULL WHERE team_id = ?').bind(t.teams[2]).run();
    expect((await req('PATCH', `/api/admin/tournament/${t.id}`, { auth: sub, body: { teamCount: 2 } })).status).toBe(200);
    expect(await activeTeams(t.id)).toBe(2);
  });

  it('ドラフト開始後はチーム数を変えられない', async () => {
    const t = await makeTournament(3, 'drafting');
    expect((await req('PATCH', `/api/admin/tournament/${t.id}`, { auth: sub, body: { teamCount: 4 } })).status).toBe(409);
  });

  it('大会終了（ended）は、ここからは設定できない（二人承認の手続きで行う）', async () => {
    const t = await makeTournament(3);
    expect((await req('PATCH', `/api/admin/tournament/${t.id}`, { auth: sup, body: { phase: 'ended' } })).status).toBe(422);
  });

  it('配信日程を登録できる。終了が開始より前なら拒否', async () => {
    await makeTournament(3);
    const ok = { kind: 'stream', title: 'ドラフト配信', startsAt: '2027-02-07T11:00:00Z', endsAt: '2027-02-07T13:00:00Z', url: 'https://www.youtube.com/live/x' };
    expect((await req('POST', '/api/admin/events', { auth: sub, body: ok })).status).toBe(201);
    expect((await req('POST', '/api/admin/events', { auth: sub, body: { ...ok, endsAt: '2027-02-07T10:00:00Z' } })).status).toBe(422);
  });
});

describe('ユーザー管理', () => {
  it('利用者タイプを変えると、その人のセッションはすべて無効になり、操作ログが残る', async () => {
    const t = await makeTournament(3);
    const uid = await makeUser();
    const target = await loginAs(uid);
    const res = await req('PUT', `/api/admin/users/${uid}/membership`, { auth: sub, body: { memberType: 'player', teamId: t.teams[0], lane: 'TOP' } });
    expect(res.status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: target }))).loggedIn).toBe(false);
    const log = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'membership_change' AND target_id = ?").bind(uid).first();
    expect(log).toBeTruthy();
  });

  it('管理者は大会の参加者にできない。補助スタッフはチームに所属させられない', async () => {
    const t = await makeTournament(3);
    const admin = await makeUser({ adminLevel: 'sub' });
    expect((await req('PUT', `/api/admin/users/${admin}/membership`, { auth: sup, body: { memberType: 'player' } })).status).toBe(422);
    const u = await makeUser();
    expect((await req('PUT', `/api/admin/users/${u}/membership`, { auth: sup, body: { memberType: 'staff', teamId: t.teams[0] } })).status).toBe(422);
  });

  it('移籍：移動先に同じレーンの選手がいると止まり、確認すれば移動できる', async () => {
    const t = await makeTournament(3);
    const p1 = await makeUser();
    const p2 = await makeUser();
    await addMember(t.id, p1, 'player', t.teams[0]!, 'MID');
    await addMember(t.id, p2, 'player', t.teams[1]!, 'MID');
    const blocked = await req('POST', `/api/admin/users/${p1}/transfer`, { auth: sub, body: { teamId: t.teams[1] } });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toBe('same_lane_exists');
    const ok = await req('POST', `/api/admin/users/${p1}/transfer`, { auth: sub, body: { teamId: t.teams[1], confirm: true } });
    expect(ok.status).toBe(200);
    const m = await env.DB.prepare('SELECT team_id FROM tournament_members WHERE user_id = ?').bind(p1).first<{ team_id: string }>();
    expect(m!.team_id).toBe(t.teams[1]);
  });

  it('利用停止：その人はすぐにログアウトされる。全体管理者は停止できない', async () => {
    const uid = await makeUser();
    const target = await loginAs(uid);
    expect((await req('POST', `/api/admin/users/${uid}/suspend`, { auth: sup })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: target }))).loggedIn).toBe(false);
    const other = await makeUser({ adminLevel: 'super' });
    expect((await req('POST', `/api/admin/users/${other}/suspend`, { auth: sup })).status).toBe(404);
  });
});

describe('Discord 通知（Bot）', () => {
  // 固定のサーバーのチャンネル（Discord の API を偽物に置き換える）
  const CHANNELS = [
    { id: '900000000000000001', type: 4, name: '大会', position: 0 },
    { id: '900000000000000002', type: 0, name: '全体連絡', parent_id: '900000000000000001', position: 0 },
    { id: '900000000000000003', type: 5, name: 'お知らせ', parent_id: '900000000000000001', position: 1 },
    { id: '900000000000000004', type: 2, name: 'ボイス', parent_id: '900000000000000001', position: 2 },
    { id: '900000000000000005', type: 0, name: '雑談', parent_id: null, position: 0 },
    { id: '900000000000000006', type: 4, name: '運営', position: 1 },
    { id: '900000000000000007', type: 0, name: '運営連絡', parent_id: '900000000000000006', position: 0 },
  ];
  let sent: { url: string; auth: string | null; body: any } | null;
  let sendStatus: number;
  let sendCode: number;
  beforeEach(() => {
    sent = null;
    sendStatus = 200;
    sendCode = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/guilds/800000000000000000/channels')) return Response.json(CHANNELS);
      if (url.includes('/channels/') && url.endsWith('/messages')) {
        sent = { url, auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) };
        if (sendStatus === 200) return Response.json({ id: '1' });
        return Response.json({ code: sendCode, message: 'error' }, { status: sendStatus });
      }
      return new Response(null, { status: 404 });
    });
  });

  it('チャンネルはカテゴリーごとに、テキストとアナウンスだけが一覧に出る（ボイスやカテゴリー自体は出ない）', async () => {
    const { groups } = await json(await req('GET', '/api/admin/discord/channels', { auth: sup }));
    expect(groups.map((g: any) => g.categoryName)).toEqual([null, '大会', '運営']);
    const taikai = groups.find((g: any) => g.categoryName === '大会');
    expect(taikai.channels.map((c: any) => [c.name, c.kind])).toEqual([['全体連絡', 'text'], ['お知らせ', 'announcement']]);
  });

  it('チャンネル一覧と送り先の設定は全体管理者のみ', async () => {
    expect((await req('GET', '/api/admin/discord/channels', { auth: sub })).status).toBe(403);
    expect((await req('PUT', '/api/admin/settings/notifications/default', { auth: sub, body: { channelId: '900000000000000002' } })).status).toBe(403);
  });

  it('送り先にはテキストかアナウンスのチャンネルだけ選べる', async () => {
    for (const bad of ['900000000000000004', '900000000000000001', '999999999999999999', 'abc']) {
      expect((await req('PUT', '/api/admin/settings/notifications/default', { auth: sup, body: { channelId: bad } })).status).toBe(422);
    }
    expect((await req('PUT', '/api/admin/settings/notifications/default', { auth: sup, body: { channelId: '900000000000000003' } })).status).toBe(200);
    const { notifications } = await json(await req('GET', '/api/admin/settings/notifications', { auth: sup }));
    const d = notifications.find((n: any) => n.kind === 'default');
    expect([d.categoryName, d.channelName]).toEqual(['大会', 'お知らせ']);
  });

  it('Bot のトークンは DB にも API の応答にも出ない', async () => {
    await req('PUT', '/api/admin/settings/notifications/default', { auth: sup, body: { channelId: '900000000000000002' } });
    const rows = await env.DB.prepare('SELECT value FROM settings').all();
    expect(JSON.stringify(rows.results)).not.toContain('SECRET');
    for (const path of ['/api/admin/settings/notifications', '/api/admin/discord/channels']) {
      expect(JSON.stringify(await json(await req('GET', path, { auth: sup })))).not.toContain('SECRET');
    }
  });

  it('通知は Bot として送り、@everyone などのメンションは無効にする', async () => {
    await req('PUT', '/api/admin/settings/notifications/default', { auth: sup, body: { channelId: '900000000000000002' } });
    expect((await json(await req('POST', '/api/admin/settings/notifications/default/test', { auth: sup }))).ok).toBe(true);
    expect(sent!.url).toContain('/channels/900000000000000002/messages');
    expect(sent!.auth).toBe('Bot test-bot-token-SECRET');
    expect(sent!.body.allowed_mentions.parse).toEqual([]);
  });

  it('種類ごとの送り先が無ければ、大会全体のチャンネルに送る', async () => {
    await req('PUT', '/api/admin/settings/notifications/default', { auth: sup, body: { channelId: '900000000000000002' } });
    await req('POST', '/api/admin/settings/notifications/transfer/test', { auth: sup });
    expect(sent!.url).toContain('/channels/900000000000000002/');
    await req('PUT', '/api/admin/settings/notifications/transfer', { auth: sup, body: { channelId: '900000000000000007' } });
    await req('POST', '/api/admin/settings/notifications/transfer/test', { auth: sup });
    expect(sent!.url).toContain('/channels/900000000000000007/');
  });

  it('Discord に接続できないときは、500 ではなく分かる言葉で返す', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const res = await req('GET', '/api/admin/discord/channels', { auth: sup });
    expect(res.status).toBe(409);
    expect((await json(res)).message).toContain('Discord に接続できませんでした');
  });

  it('Bot に投稿権限が無いときは、理由を返す', async () => {
    await req('PUT', '/api/admin/settings/notifications/default', { auth: sup, body: { channelId: '900000000000000002' } });
    sendStatus = 403;
    sendCode = 50013;
    let r = await json(await req('POST', '/api/admin/settings/notifications/default/test', { auth: sup }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('メッセージを送信');
    expect(r.reason).toContain('50013');
    sendCode = 50001;
    r = await json(await req('POST', '/api/admin/settings/notifications/default/test', { auth: sup }));
    expect(r.reason).toContain('チャンネルを見る');
    expect(r.reason).toContain('50001');
  });
});

describe('操作ログ', () => {
  it('操作の種類で絞り込める', async () => {
    const t = await makeTournament(3);
    await req('PATCH', `/api/admin/tournament/${t.id}`, { auth: sup, body: { name: '改名' } });
    const { logs } = await json(await req('GET', '/api/admin/audit-logs?action=tournament_update', { auth: sup }));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: { action: string }) => l.action === 'tournament_update')).toBe(true);
  });
});
