import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { setClockForTest } from '../src/lib/time';
import { dailyCleanup } from '../src/services/cleanup';
import { addMember, json, loginAs, makeTournament, makeUser, req } from './helpers';

async function world() {
  const t = await makeTournament(2, 'scrim');
  const [A, B] = t.teams as [string, string];
  const mk = async (type: 'player' | 'coach', team: string | null, name: string, lane: string | null) => { const id = await makeUser({ name }); await addMember(t.id, id, type, team, lane); return { id, auth: await loginAs(id) }; };
  return {
    t, A, B, sup: await mk('player', A, 'Aサポ', 'SUP'), top: await mk('player', A, 'Aトップ', 'TOP'), coach: await mk('coach', A, 'Aコーチ', null), bmid: await mk('player', B, 'Bミッド', 'MID'),
    admin: await loginAs(await makeUser({ adminLevel: 'sub' })),
  };
}

describe('大会参加者一覧', () => {
  it('選考結果の発表前は公開しない。発表後は、チーム順（コーチ → レーン順）で並ぶ', async () => {
    const w = await world();
    expect((await json(await req('GET', '/api/roster/participants'))).published).toBe(false);
    await env.DB.prepare('UPDATE tournaments SET announced_at = ? WHERE id = ?').bind(new Date().toISOString(), w.t.id).run();
    const r = await json(await req('GET', '/api/roster/participants'));
    expect(r.groups.map((g: any) => g.title)).toEqual(['チーム 1', 'チーム 2']);
    expect(r.groups[0].people.map((p: any) => p.name)).toEqual(['Aコーチ', 'Aトップ', 'Aサポ']);
  });

  it('宣材写真・X・配信 URL は、本人が公開を選んだものだけ', async () => {
    const w = await world();
    await env.DB.prepare('UPDATE tournaments SET announced_at = ? WHERE id = ?').bind(new Date().toISOString(), w.t.id).run();
    await env.DB.prepare("UPDATE users SET x_account = 'atop_x', stream_urls = ? WHERE id = ?").bind(JSON.stringify(['https://www.twitch.tv/atop']), w.top.id).run();
    const person = async () => (await json(await req('GET', '/api/roster/participants'))).groups[0].people.find((p: any) => p.name === 'Aトップ');
    expect(await person()).toMatchObject({ xAccount: null, streamUrls: [] });
    expect((await req('PUT', '/api/roster/my-publish', { auth: w.top.auth, body: { x: true, stream: true } })).status).toBe(200);
    expect(await person()).toMatchObject({ xAccount: 'atop_x', streamUrls: ['https://www.twitch.tv/atop'] });
    expect((await req('PUT', '/api/roster/my-publish', { auth: await loginAs(await makeUser()), body: { x: true } })).status).toBe(403);
  });
});

describe('チーム紹介', () => {
  it('管理者が公開したチームだけ表示する。公開・非公開は管理者だけ', async () => {
    const w = await world();
    expect((await json(await req('GET', '/api/roster/teams'))).teams).toEqual([]);
    expect((await req('PUT', `/api/admin/teams/${w.A}/intro`, { auth: w.top.auth, body: { published: true } })).status).toBe(403);
    expect((await req('PUT', `/api/admin/teams/${w.A}/intro`, { auth: w.admin, body: { published: true } })).status).toBe(200);
    const teams = (await json(await req('GET', '/api/roster/teams'))).teams;
    expect(teams.map((t: any) => t.name)).toEqual(['チーム 1']);
    expect(teams[0].players.map((p: any) => p.name)).toEqual(['Aトップ', 'Aサポ']);
    expect(teams[0].coaches.map((p: any) => p.name)).toEqual(['Aコーチ']);
  });
});

describe('毎日の削除処理', () => {
  it('削除した投稿は 10 日後、削除したページは 30 日後、操作ログは 1 年後に消える', async () => {
    const w = await world();
    const day = 86400e3;
    const at = (n: number) => new Date(Date.now() - n * day).toISOString();
    await env.DB.prepare("INSERT INTO team_pages (id, team_id, title, created_by, deleted_at, created_at, updated_at) VALUES ('pg-live', ?, '残す', 'x', NULL, '', ''), ('pg-old', ?, '古い', 'x', ?, '', ''), ('pg-recent', ?, '最近', 'x', ?, '', '')")
      .bind(w.A, w.A, at(31), w.A, at(29)).run();
    await env.DB.prepare("INSERT INTO team_posts (id, page_id, author_user_id, body, deleted_at, created_at, updated_at) VALUES ('po-old', 'pg-live', ?, 'x', ?, '', ''), ('po-new', 'pg-live', ?, 'x', ?, '', ''), ('po-in-old-page', 'pg-old', ?, 'x', NULL, '', '')")
      .bind(w.top.id, at(11), w.top.id, at(9), w.top.id).run();
    await env.DB.prepare("INSERT INTO audit_logs (id, at, action, created_at, updated_at) VALUES ('log-old', ?, 'x', '', ''), ('log-new', ?, 'x', '', '')").bind(at(366), at(364)).run();
    await dailyCleanup(env);
    const ids = async (table: string) => (await env.DB.prepare(`SELECT id FROM ${table}`).all<{ id: string }>()).results.map((r) => r.id);
    expect(await ids('team_posts')).toEqual(expect.arrayContaining(['po-new']));
    expect(await ids('team_posts')).not.toEqual(expect.arrayContaining(['po-old']));
    expect(await ids('team_posts')).not.toEqual(expect.arrayContaining(['po-in-old-page']));
    expect(await ids('team_pages')).toEqual(expect.arrayContaining(['pg-live', 'pg-recent']));
    expect(await ids('team_pages')).not.toEqual(expect.arrayContaining(['pg-old']));
    const logs = await ids('audit_logs');
    expect(logs).toContain('log-new');
    expect(logs).not.toContain('log-old');
    setClockForTest(null);
  });
});
