import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { MIN_CHAMPIONS, syncLanes, validateLaneData } from '../src/services/lanes';
import { addMember, json, loginAs, makeTournament, makeUser, req } from './helpers';

const champ = (i: number, main = 'mid') => ({ name: `Champ${i}`, main, rate: 5.5, rates: { [main]: 5.5, top: 1.2 } });
const goodData = (n = MIN_CHAMPIONS) => ({ updated_at: '2026-11-06T21:05:00+00:00', source: 'OP.GG', champions: Array.from({ length: n }, (_, i) => champ(i)) });

let laneJson: unknown;
let laneStatus: number;
let ddragonOk: boolean;
let sent: string[];
beforeEach(async () => {
  laneJson = goodData(); laneStatus = 200; ddragonOk = true; sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === env.LANES_DATA_URL) return laneStatus === 200 ? Response.json(laneJson) : new Response(null, { status: laneStatus });
    if (url.includes('ddragon')) {
      if (!ddragonOk) return new Response(null, { status: 500 });
      if (url.endsWith('versions.json')) return Response.json(['15.21.1']);
      const ja = url.includes('ja_JP');
      return Response.json({ data: { Champ0: { name: ja ? 'チャンプゼロ' : 'Champ0' }, NewOne: { name: ja ? '新チャンプ' : 'New One' } } });
    }
    if (url.endsWith('/messages')) { sent.push(JSON.parse(String(init?.body)).content); return Response.json({ id: '1' }); }
    return new Response(null, { status: 404 });
  });
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, created_at, updated_at) VALUES ('notification.default', ?, '', '')")
    .bind(JSON.stringify({ channelId: '900000000000000002', channelName: '全体', categoryName: null, kind: 'text' })).run();
});
afterEach(() => vi.restoreAllMocks());

describe('適性レーン：取り込むデータの検査', () => {
  it('正しいデータは通り、100 体未満は失敗にする', () => {
    expect(validateLaneData(goodData()).champions).toHaveLength(MIN_CHAMPIONS);
    expect(() => validateLaneData(goodData(MIN_CHAMPIONS - 1))).toThrow('少なすぎます');
  });
  it('画面に差し込まれる値は形を厳しく確かめ、スクリプトなどを含むデータは通さない', () => {
    const bad = (patch: Record<string, unknown>) => { const d = goodData(); Object.assign(d.champions[3]!, patch); return () => validateLaneData(d); };
    expect(bad({ main: '<img src=x onerror=alert(1)>' })).toThrow();
    expect(bad({ name: 'Ahri<script>' })).toThrow();
    expect(bad({ rate: '5%' })).toThrow();
    expect(bad({ rates: { 'top" onmouseover="x': 1 } })).toThrow();
    expect(() => validateLaneData({ champions: 'x' })).toThrow();
  });
});

describe('適性レーン：取り込み', () => {
  it('取り込むと、日本語名とデータ不足のチャンピオンも含めて既存の画面と同じ形で返す', async () => {
    const r = await syncLanes(env, null);
    expect(r.ok).toBe(true);
    const d = await json(await req('GET', '/api/lanes'));
    expect(d.updated_at).toBe('2026-11-06T21:05:00.000Z');
    expect(d.champions.find((c: any) => c.name === 'Champ0').ja).toBe('チャンプゼロ');
    expect(d.champions.find((c: any) => c.ja === '新チャンプ').nodata).toBe(true);
  });

  it('失敗したときは前回のデータを残し、Discord で知らせる', async () => {
    await syncLanes(env, null);
    laneJson = goodData(10);
    const r = await syncLanes(env, null);
    expect(r.ok).toBe(false);
    expect((await json(await req('GET', '/api/lanes'))).champions.length).toBeGreaterThanOrEqual(MIN_CHAMPIONS);
    expect(sent.at(-1)).toContain('取り込みに失敗');
    laneStatus = 500;
    expect((await syncLanes(env, null)).ok).toBe(false);
  });

  it('日本語名が取れなくても、英語名で取り込める', async () => {
    ddragonOk = false;
    expect((await syncLanes(env, null)).ok).toBe(true);
    expect((await json(await req('GET', '/api/lanes'))).champions[0].ja).toBe('Champ0');
  });

  it('公開範囲を「ログインした人」にすると未ログインでは見られない。変更は全体管理者のみ', async () => {
    const sub = await loginAs(await makeUser({ adminLevel: 'sub' }));
    const sup = await loginAs(await makeUser({ adminLevel: 'super' }));
    expect((await req('PUT', '/api/admin/lanes/visibility', { auth: sub, body: { visibility: 'logged_in' } })).status).toBe(403);
    expect((await req('PUT', '/api/admin/lanes/visibility', { auth: sup, body: { visibility: 'logged_in' } })).status).toBe(200);
    expect((await req('GET', '/api/lanes')).status).toBe(401);
    expect((await req('GET', '/api/lanes', { auth: await loginAs(await makeUser()) })).status).toBe(200);
  });

  it('「今すぐ更新」は管理者だけ', async () => {
    expect((await req('POST', '/api/admin/lanes/sync', { auth: await loginAs(await makeUser()) })).status).toBe(403);
    expect((await json(await req('POST', '/api/admin/lanes/sync', { auth: await loginAs(await makeUser({ adminLevel: 'sub' })) }))).ok).toBe(true);
  });
});

describe('問い合わせ', () => {
  it('ログインした人だけが送れる。管理者への通知は受付番号と件名だけで、本文は載せない', async () => {
    expect((await req('POST', '/api/inquiries', { body: { subject: 'a', body: 'b' } })).status).toBe(401);
    const u = await loginAs(await makeUser());
    const r = await json(await req('POST', '/api/inquiries', { auth: u, body: { subject: 'スクリムについて', body: '秘密の相談内容' } }));
    expect(r.number).toBeGreaterThan(0);
    expect(sent.at(-1)).toContain('スクリムについて');
    expect(sent.at(-1)).not.toContain('秘密の相談内容');
  });

  it('他人の問い合わせは見られず、書き込めない', async () => {
    const u = await loginAs(await makeUser());
    const other = await loginAs(await makeUser());
    const { id } = await json(await req('POST', '/api/inquiries', { auth: u, body: { subject: 's', body: 'b' } }));
    expect((await req('GET', `/api/inquiries/${id}`, { auth: other })).status).toBe(404);
    expect((await req('POST', `/api/inquiries/${id}/messages`, { auth: other, body: { body: 'x' } })).status).toBe(404);
    expect((await json(await req('GET', '/api/inquiries', { auth: other }))).inquiries).toEqual([]);
  });

  it('運営の返信は本人には「運営」として届き、返信した管理者の名前は見えない。完了後に追記すると未対応に戻る', async () => {
    const u = await loginAs(await makeUser());
    const admin = await loginAs(await makeUser({ adminLevel: 'sub', name: '補助管理者ネーム' }));
    const { id } = await json(await req('POST', '/api/inquiries', { auth: u, body: { subject: 's', body: '質問' } }));
    expect((await req('POST', `/api/admin/inquiries/${id}/messages`, { auth: admin, body: { body: '回答です', done: true } })).status).toBe(201);
    const mine = await json(await req('GET', `/api/inquiries/${id}`, { auth: u }));
    expect(mine.messages.map((m: any) => m.fromStaff)).toEqual([false, true]);
    expect(JSON.stringify(mine)).not.toContain('補助管理者ネーム');
    expect(mine.inquiry.status).toBe('done');
    await req('POST', `/api/inquiries/${id}/messages`, { auth: u, body: { body: '追加の質問' } });
    expect((await json(await req('GET', `/api/inquiries/${id}`, { auth: u }))).inquiry.status).toBe('open');
  });

  it('1 日に送れるのは 5 件まで', async () => {
    const u = await loginAs(await makeUser());
    for (let i = 0; i < 5; i++) expect((await req('POST', '/api/inquiries', { auth: u, body: { subject: `s${i}`, body: 'b' } })).status).toBe(201);
    expect((await req('POST', '/api/inquiries', { auth: u, body: { subject: 's6', body: 'b' } })).status).toBe(429);
  });

  it('担当にできるのは管理者だけ。問い合わせ対応は管理者だけ', async () => {
    const u = await loginAs(await makeUser());
    const admin = await loginAs(await makeUser({ adminLevel: 'sub' }));
    const player = await makeUser();
    const { id } = await json(await req('POST', '/api/inquiries', { auth: u, body: { subject: 's', body: 'b' } }));
    expect((await req('PATCH', `/api/admin/inquiries/${id}`, { auth: admin, body: { assigneeUserId: player } })).status).toBe(422);
    expect((await req('GET', '/api/admin/inquiries', { auth: u })).status).toBe(403);
  });
});

describe('TOP ページ', () => {
  it('未ログインには公開のお知らせだけ。やることと管理者向けの件数は出ない', async () => {
    const t = await makeTournament(2);
    const sub = await loginAs(await makeUser({ adminLevel: 'sub' }));
    const base = { body: '本文', category: 'general', publishAt: 'now' };
    await req('POST', '/api/admin/announcements', { auth: sub, body: { ...base, title: '公開', visibility: 'public' } });
    await req('POST', '/api/admin/announcements', { auth: sub, body: { ...base, title: '重要', visibility: 'logged_in', important: true } });
    const anon = await json(await req('GET', '/api/home'));
    expect(anon.news.map((n: any) => n.title)).toEqual(['公開']);
    expect(anon.todos).toEqual([]);
    expect(anon.admin).toBeUndefined();
    const p = await makeUser();
    await addMember(t.id, p, 'player', t.teams[0]!);
    const home = await json(await req('GET', '/api/home', { auth: await loginAs(p) }));
    expect(home.todos.map((x: any) => x.title)).toEqual(['重要なお知らせ「重要」を確認する']);
    expect((await json(await req('GET', '/api/home', { auth: sub }))).admin.openInquiries).toBeGreaterThanOrEqual(0);
  });
});
