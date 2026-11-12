import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { announceDue } from '../src/services/publishing';
import { setClockForTest } from '../src/lib/time';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, req } from './helpers';

let sent: { channel: string; body: any }[] = [];
beforeEach(async () => {
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/guilds/')) return Response.json([{ id: '900000000000000002', type: 0, name: '全体', parent_id: null }]);
    if (url.endsWith('/messages')) { sent.push({ channel: url, body: JSON.parse(String(init?.body)) }); return Response.json({ id: '1' }); }
    return new Response(null, { status: 404 });
  });
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, created_at, updated_at) VALUES ('notification.default', ?, '', '')")
    .bind(JSON.stringify({ channelId: '900000000000000002', channelName: '全体', categoryName: null, kind: 'text' })).run();
});
afterEach(() => vi.restoreAllMocks());

async function world(phase = 'preparing') {
  const t = await makeTournament(2, phase);
  const ids = { viewer: await makeUser(), playerA: await makeUser(), playerB: await makeUser(), coachA: await makeUser(), staff: await makeUser({ name: 'スタッフK' }),
    sub: await makeUser({ adminLevel: 'sub', name: '補助さん' }), sup: await makeUser({ adminLevel: 'super', name: '全体さん' }) };
  await addMember(t.id, ids.playerA, 'player', t.teams[0]!);
  await addMember(t.id, ids.playerB, 'player', t.teams[1]!);
  await addMember(t.id, ids.coachA, 'coach', t.teams[0]!);
  await addMember(t.id, ids.staff, 'staff');
  const a: Record<keyof typeof ids, Auth> = {} as never;
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) a[k] = await loginAs(ids[k]);
  return { t, ids, a };
}

const create = (auth: Auth, body: Record<string, unknown>) =>
  req('POST', '/api/admin/announcements', { auth, body: { title: 'タイトル', body: '本文', category: 'general', visibility: 'public', publishAt: 'now', ...body } });
const titles = async (auth: Auth | null) => (await json(await req('GET', '/api/announcements', { auth }))).announcements.map((x: any) => x.title);

describe('案内ページ', () => {
  it('はじめに：誰でも見られ、運営メンバー（管理者・補助スタッフ）が並ぶ。選手は出ない。管理者の種別は返さない', async () => {
    const { a } = await world();
    expect((await req('PUT', '/api/pages/about', { auth: a.sup, body: {} })).status).toBe(404);
    expect((await req('PUT', '/api/admin/pages/about', { auth: a.sup, body: { body: '大会の趣旨' } })).status).toBe(200);
    const res = await json(await req('GET', '/api/pages/about'));
    expect(res.page.body).toBe('大会の趣旨');
    const names = res.staff.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(['スタッフK', '補助さん', '全体さん']));
    const text = JSON.stringify(res);
    for (const f of ['admin_level', 'adminLevel', '"sub"', '"super"', 'discord_user_id']) expect(text).not.toContain(f);
  });

  it('はじめに・大会概要・プライバシーポリシーの編集は全体管理者のみ、ルールブックは管理者なら編集できる', async () => {
    const { a } = await world();
    for (const k of ['about', 'overview', 'privacy']) expect((await req('PUT', `/api/admin/pages/${k}`, { auth: a.sub, body: { body: 'x' } })).status).toBe(403);
    expect((await req('PUT', '/api/admin/pages/rules', { auth: a.sub, body: { body: '第 1 版' } })).status).toBe(200);
    expect((await req('PUT', '/api/admin/pages/rules', { auth: a.playerA, body: { body: 'x' } })).status).toBe(403);
  });

  it('ルールブック：参加者と運営は見られる。登録済み閲覧者は募集期間中だけ。未ログインは見られない', async () => {
    const { a, t } = await world('preparing');
    await req('PUT', '/api/admin/pages/rules', { auth: a.sub, body: { body: '第 1 版' } });
    await req('PUT', '/api/admin/pages/rules', { auth: a.sub, body: { body: '第 2 版' } });
    expect((await req('GET', '/api/pages/rules')).status).toBe(401);
    expect((await req('GET', '/api/pages/rules', { auth: a.viewer })).status).toBe(403);
    expect((await json(await req('GET', '/api/pages/rules', { auth: a.playerA }))).page.body).toBe('第 2 版');
    await env.DB.prepare("UPDATE tournaments SET phase = 'recruiting' WHERE id = ?").bind(t.id).run();
    expect((await req('GET', '/api/pages/rules', { auth: a.viewer })).status).toBe(200);
    const { versions } = await json(await req('GET', '/api/pages/rules/versions', { auth: a.playerA }));
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect((await json(await req('GET', '/api/pages/rules/versions/1', { auth: a.playerA }))).body).toBe('第 1 版');
  });

  it('大会概要：日程とチーム数は大会設定から自動で出る', async () => {
    await world();
    const res = await json(await req('GET', '/api/pages/overview'));
    expect(res.tournament.teamCount).toBe(2);
    expect(res.tournament.name).toBe('テスト大会');
  });

  it('公式リンク：全体管理者のみ。https 以外は拒否', async () => {
    const { a } = await world();
    const links = [{ kind: 'x', label: '公式 X', url: 'https://x.com/vout' }];
    expect((await req('PUT', '/api/admin/official-links', { auth: a.sub, body: { links } })).status).toBe(403);
    expect((await req('PUT', '/api/admin/official-links', { auth: a.sup, body: { links: [{ kind: 'x', label: 'x', url: 'javascript:alert(1)' }] } })).status).toBe(422);
    expect((await req('PUT', '/api/admin/official-links', { auth: a.sup, body: { links } })).status).toBe(200);
    expect((await json(await req('GET', '/api/pages/about'))).officialLinks).toEqual(links);
  });
});

describe('お知らせの公開範囲', () => {
  it('誰でも／ログインした人／対象者（利用者タイプ × チーム）の範囲どおりに見える', async () => {
    const { a, t } = await world();
    await create(a.sub, { title: '全員向け' });
    await create(a.sub, { title: 'ログイン者向け', visibility: 'logged_in' });
    await create(a.sub, { title: 'A チーム選手向け', visibility: 'targeted', targets: [{ memberType: 'player', teamId: t.teams[0] }] });
    expect(await titles(null)).toEqual(['全員向け']);
    expect(await titles(a.viewer)).toEqual(expect.not.arrayContaining(['A チーム選手向け']));
    expect(await titles(a.viewer)).toEqual(expect.arrayContaining(['全員向け', 'ログイン者向け']));
    expect(await titles(a.playerA)).toContain('A チーム選手向け');
    expect(await titles(a.playerB)).not.toContain('A チーム選手向け');
    expect(await titles(a.coachA)).not.toContain('A チーム選手向け');
    expect(await titles(a.sub)).toContain('A チーム選手向け');
  });

  it('見られないお知らせは、URL を直接開いても「存在しない」と同じ応答', async () => {
    const { a } = await world();
    const { id } = await json(await create(a.sub, { title: 'ログイン者向け', visibility: 'logged_in' }));
    expect((await req('GET', `/api/announcements/${id}`)).status).toBe(404);
    expect((await req('GET', `/api/announcements/${id}`, { auth: a.viewer })).status).toBe(200);
  });

  it('下書きは誰にも見えず、管理画面では「下書き」になる', async () => {
    const { a } = await world();
    await create(a.sub, { title: '下書き中', publishAt: null });
    expect(await titles(a.sup)).not.toContain('下書き中');
    const list = (await json(await req('GET', '/api/admin/announcements', { auth: a.sub }))).announcements;
    expect(list.find((x: any) => x.title === '下書き中').status).toBe('draft');
  });

  it('お知らせを作れるのは管理者だけ。誰でも向けの重要なお知らせは作れない', async () => {
    const { a } = await world();
    expect((await create(a.playerA, {})).status).toBe(403);
    expect((await create(a.sub, { important: true, visibility: 'public' })).status).toBe(422);
  });
});

describe('予約公開と Discord への通知', () => {
  it('今すぐ公開は、作った時点で 1 回だけ通知する', async () => {
    const { a } = await world();
    await create(a.sub, { title: 'すぐ' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.content).toContain('すぐ');
    expect(await announceDue(env)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('予約公開は、時刻までは見えず通知もしない。時刻を過ぎた定期処理で公開・通知され、二重には送らない', async () => {
    const { a } = await world();
    const at = new Date(Date.now() + 2 * 3600e3).toISOString();
    await create(a.sub, { title: '予約', publishAt: at });
    expect(sent).toHaveLength(0);
    expect(await titles(null)).not.toContain('予約');
    setClockForTest(() => new Date(Date.now() + 3 * 3600e3));
    expect(await announceDue(env)).toBe(1);
    expect(await titles(null)).toContain('予約');
    expect(await announceDue(env)).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe('重要なお知らせの既読確認', () => {
  it('確認するまで「未確認」に出続け、確認すると消える', async () => {
    const { a } = await world();
    const { id } = await json(await create(a.sub, { title: '重要', visibility: 'logged_in', important: true }));
    expect((await json(await req('GET', '/api/announcements/unconfirmed', { auth: a.playerA }))).announcements.map((x: any) => x.id)).toEqual([id]);
    expect((await req('POST', `/api/announcements/${id}/confirm`, { auth: a.playerA })).status).toBe(200);
    expect((await json(await req('GET', '/api/announcements/unconfirmed', { auth: a.playerA }))).announcements).toEqual([]);
  });

  it('運営には、確認を求める帯を出さない（確認の対象は参加者だけ）', async () => {
    const { a } = await world();
    await create(a.sub, { title: '重要', visibility: 'logged_in', important: true });
    expect((await json(await req('GET', '/api/announcements/unconfirmed', { auth: a.sup }))).announcements).toEqual([]);
  });

  it('対象外の人は確認できない。重要でないお知らせは確認の対象外', async () => {
    const { a, t } = await world();
    const { id } = await json(await create(a.sub, { title: 'A 向け重要', visibility: 'targeted', important: true, targets: [{ memberType: null, teamId: t.teams[0] }] }));
    expect((await req('POST', `/api/announcements/${id}/confirm`, { auth: a.playerB })).status).toBe(404);
    const normal = (await json(await create(a.sub, { title: '普通' }))).id;
    expect((await req('POST', `/api/announcements/${normal}/confirm`, { auth: a.playerA })).status).toBe(422);
  });

  it('管理者は確認状況を見られ、未確認の人にだけ Discord で本人宛てに再通知する', async () => {
    const { a, t, ids } = await world();
    const { id } = await json(await create(a.sub, { title: 'A 向け重要', visibility: 'targeted', important: true, targets: [{ memberType: null, teamId: t.teams[0] }] }));
    await req('POST', `/api/announcements/${id}/confirm`, { auth: a.playerA });
    const { people } = await json(await req('GET', `/api/admin/announcements/${id}/confirmations`, { auth: a.sub }));
    expect(people).toHaveLength(2); // A チームの選手とコーチ
    sent = [];
    const r = await json(await req('POST', `/api/admin/announcements/${id}/remind`, { auth: a.sub }));
    expect(r.reminded).toBe(1);
    const coach = await env.DB.prepare('SELECT discord_user_id FROM users WHERE id = ?').bind(ids.coachA).first<{ discord_user_id: string }>();
    expect(sent[0]!.body.allowed_mentions.users).toEqual([coach!.discord_user_id]);
    expect(sent[0]!.body.allowed_mentions.parse).toEqual([]);
  });
});
