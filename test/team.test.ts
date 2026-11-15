import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import { setClockForTest } from '../src/lib/time';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, ORIGIN, req } from './helpers';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x50, 0x49, 0x58, 0xff, 0xd9]);

async function world(scrimStart: string | null = null) {
  const t = await makeTournament(2, 'scrim');
  await env.DB.prepare('UPDATE tournaments SET scrim_start = ? WHERE id = ?').bind(scrimStart, t.id).run();
  const [A, B] = t.teams as [string, string];
  const mk = async (type: 'player' | 'coach' | 'staff', team: string | null, name: string) => { const id = await makeUser({ name }); await addMember(t.id, id, type, team); return { id, auth: await loginAs(id) }; };
  return { t, A, B, coachA: await mk('coach', A, 'Aコーチ'), p1: await mk('player', A, 'A選手1'), p2: await mk('player', A, 'A選手2'), pB: await mk('player', B, 'B選手'), staff: await mk('staff', null, 'スタッフ'), admin: await loginAs(await makeUser({ adminLevel: 'sub' })) };
}
const page = async (auth: Auth) => (await json(await req('GET', '/api/team', { auth }))).pages[0].id as string;
const post = (auth: Auth, pageId: string, body: string, imageIds: string[] = []) => req('POST', `/api/team/pages/${pageId}/posts`, { auth, body: { body, imageIds } });
const posts = async (auth: Auth, pageId: string) => (await json(await req('GET', `/api/team/pages/${pageId}/posts`, { auth }))).posts;

async function upload(auth: Auth) {
  const fd = new FormData(); fd.append('file', new File([JPEG], 's.jpg'));
  const r = await app.fetch(new Request(`${ORIGIN}/api/team/images`, { method: 'POST', body: fd, headers: { Cookie: auth.cookie, Origin: ORIGIN, 'X-CSRF-Token': auth.csrf } }), env,
    { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
  return (await json(r)).imageId as string;
}

describe('チームページ', () => {
  it('見られるのは、そのチームの選手とコーチだけ。他のチームのページは存在しない扱い。補助スタッフは見られない', async () => {
    const w = await world();
    const pageA = await page(w.p1.auth);
    expect((await req('GET', '/api/team', { auth: w.staff.auth })).status).toBe(403);
    expect((await req('GET', `/api/team/pages/${pageA}/posts`, { auth: w.pB.auth })).status).toBe(404);
    expect((await post(w.pB.auth, pageA, 'のぞき見')).status).toBe(404);
    expect((await req('GET', `/api/team?teamId=${w.A}`, { auth: w.admin })).status).toBe(200);
  });

  it('投稿は新しい順。リアクションは決められた絵文字だけで、誰が付けたか見られる。もう一度押すと外れる', async () => {
    const w = await world();
    const pg = await page(w.p1.auth);
    await post(w.p1.auth, pg, '1 つ目');
    setClockForTest(() => new Date(Date.now() + 60_000));
    const { id } = await json(await post(w.p2.auth, pg, '2 つ目'));
    setClockForTest(null);
    expect((await posts(w.p1.auth, pg)).map((p: any) => p.body)).toEqual(['2 つ目', '1 つ目']);
    expect((await req('POST', `/api/team/posts/${id}/reactions`, { auth: w.p1.auth, body: { emoji: '💩' } })).status).toBe(422);
    await req('POST', `/api/team/posts/${id}/reactions`, { auth: w.p1.auth, body: { emoji: '👍' } });
    await req('POST', `/api/team/posts/${id}/reactions`, { auth: w.coachA.auth, body: { emoji: '👍' } });
    expect((await posts(w.p2.auth, pg))[0].reactions).toEqual([{ emoji: '👍', count: 2, names: ['A選手1', 'Aコーチ'], mine: false }]);
    await req('POST', `/api/team/posts/${id}/reactions`, { auth: w.p1.auth, body: { emoji: '👍' } });
    expect((await posts(w.p2.auth, pg))[0].reactions[0].count).toBe(1);
  });

  it('投稿の削除は書いた本人かコーチ。画像は 4 枚まで、自分が送ったものだけ', async () => {
    const w = await world();
    const pg = await page(w.p1.auth);
    const { id } = await json(await post(w.p1.auth, pg, '消す'));
    expect((await req('DELETE', `/api/team/posts/${id}`, { auth: w.p2.auth })).status).toBe(403);
    expect((await req('DELETE', `/api/team/posts/${id}`, { auth: w.coachA.auth })).status).toBe(200);
    const mine = await upload(w.p1.auth);
    const others = await upload(w.p2.auth);
    expect((await post(w.p1.auth, pg, '', [others])).status).toBe(422);
    expect((await post(w.p1.auth, pg, '', [mine, mine, mine, mine, mine])).status).toBe(422);
    expect((await post(w.p1.auth, pg, '', [mine])).status).toBe(201);
    expect((await posts(w.p2.auth, pg))[0].images[0]).toMatch(/^\/img\//);
  });

  it('ページの追加・削除はコーチだけ。削除したページは 30 日以内なら戻せる', async () => {
    const w = await world();
    await page(w.coachA.auth);
    expect((await req('POST', '/api/team/pages', { auth: w.p1.auth, body: { title: '作戦' } })).status).toBe(403);
    const { id } = await json(await req('POST', '/api/team/pages', { auth: w.coachA.auth, body: { title: '作戦' } }));
    await req('DELETE', `/api/team/pages/${id}`, { auth: w.coachA.auth });
    expect((await json(await req('GET', '/api/team', { auth: w.p1.auth }))).pages.map((p: any) => p.title)).toEqual(['全体']);
    expect((await req('POST', `/api/team/pages/${id}/restore`, { auth: w.coachA.auth })).status).toBe(200);
    await req('DELETE', `/api/team/pages/${id}`, { auth: w.coachA.auth });
    setClockForTest(() => new Date(Date.now() + 31 * 86400e3));
    expect((await req('POST', `/api/team/pages/${id}/restore`, { auth: await loginAs(w.coachA.id) })).status).toBe(409);
    setClockForTest(null);
  });

  it('チーム名はコーチが決める。スクリム期間に入ったら変えられない。選手は決められない', async () => {
    const before = await world(new Date(Date.now() + 86400e3).toISOString());
    expect((await req('PUT', '/api/team/name', { auth: before.p1.auth, body: { name: 'X' } })).status).toBe(403);
    expect((await req('PUT', '/api/team/name', { auth: before.coachA.auth, body: { name: 'Team Aurora' } })).status).toBe(200);
    expect((await json(await req('GET', '/api/team', { auth: before.p1.auth }))).team.name).toBe('Team Aurora');
    const after = await world(new Date(Date.now() - 86400e3).toISOString());
    expect((await req('PUT', '/api/team/name', { auth: after.coachA.auth, body: { name: '変更' } })).status).toBe(409);
  });
});
