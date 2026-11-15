import { afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { makePreview, PREVIEW_COOKIE } from '../src/auth/preview';
import { setClockForTest } from '../src/lib/time';
import { purgeEndedTournaments, purgeInactiveUsers } from '../src/services/tournamentEnd';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, req } from './helpers';

afterEach(() => setClockForTest(null));

async function world() {
  const t = await makeTournament(2, 'scrim');
  const superA = await makeUser({ adminLevel: 'super', name: '全体A' });
  const superB = await makeUser({ adminLevel: 'super', name: '全体B' });
  const player = await makeUser({ name: '選手' });
  await addMember(t.id, player, 'player', t.teams[0]!, 'MID');
  return { t, superA, superB, a: await loginAs(superA), b: await loginAs(superB), sub: await loginAs(await makeUser({ adminLevel: 'sub' })), player, playerAuth: await loginAs(player) };
}
const request = (auth: Auth, body: Record<string, unknown>) => req('POST', '/api/admin/approvals', { auth, body });

describe('二人承認', () => {
  it('申請・承認は全体管理者だけ。自分の申請は承認できず、別の全体管理者が承認した時点で実行される', async () => {
    const w = await world();
    const target = await makeUser({ name: '新しい運営' });
    const targetAuth = await loginAs(target);
    expect((await request(w.sub, { kind: 'admin_grant', userId: target, level: 'sub' })).status).toBe(403);
    const { id } = await json(await request(w.a, { kind: 'admin_grant', userId: target, level: 'sub' }));
    expect((await request(w.a, { kind: 'admin_grant', userId: target, level: 'sub' })).status).toBe(409); // 同じ申請が承認待ち
    expect((await req('POST', `/api/admin/approvals/${id}/approve`, { auth: w.a })).status).toBe(403);
    expect((await env.DB.prepare('SELECT admin_level FROM users WHERE id = ?').bind(target).first<{ admin_level: string }>())!.admin_level).toBe('none');
    expect((await req('POST', `/api/admin/approvals/${id}/approve`, { auth: w.b })).status).toBe(200);
    expect((await env.DB.prepare('SELECT admin_level FROM users WHERE id = ?').bind(target).first<{ admin_level: string }>())!.admin_level).toBe('sub');
    expect((await json(await req('GET', '/api/me', { auth: targetAuth }))).loggedIn).toBe(false); // ログインし直し
  });

  it('24 時間たった申請は承認できない。大会の参加者は管理者にできない', async () => {
    const w = await world();
    const target = await makeUser();
    const { id } = await json(await request(w.a, { kind: 'admin_grant', userId: target, level: 'sub' }));
    setClockForTest(() => new Date(Date.now() + 25 * 3600e3));
    expect((await req('POST', `/api/admin/approvals/${id}/approve`, { auth: await loginAs(w.superB) })).status).toBe(409);
    setClockForTest(null);
    expect((await request(w.a, { kind: 'admin_grant', userId: w.player, level: 'sub' })).status).toBe(409);
  });

  it('大会終了：承認で画面から消え、10 日以内なら元の段階に戻せる。10 日を過ぎると戻せない', async () => {
    const w = await world();
    const { id } = await json(await request(w.a, { kind: 'tournament_end' }));
    await req('POST', `/api/admin/approvals/${id}/approve`, { auth: w.b });
    expect((await json(await req('GET', '/api/home'))).tournament).toBeNull();
    expect((await req('GET', '/api/schedule', { auth: w.playerAuth })).status).toBe(404);
    expect((await req('POST', `/api/admin/tournaments/${w.t.id}/restore`, { auth: w.sub })).status).toBe(403);
    expect((await req('POST', `/api/admin/tournaments/${w.t.id}/restore`, { auth: w.a })).status).toBe(200);
    expect((await json(await req('GET', '/api/home'))).tournament.phase).toBe('scrim');
    const again = await json(await request(w.a, { kind: 'tournament_end' }));
    await req('POST', `/api/admin/approvals/${again.id}/approve`, { auth: w.b });
    setClockForTest(() => new Date(Date.now() + 11 * 86400e3));
    expect((await req('POST', `/api/admin/tournaments/${w.t.id}/restore`, { auth: await loginAs(w.superA) })).status).toBe(409);
  });

  it('終了から 10 日を過ぎた大会は、関係するデータと画像ごと消える', async () => {
    const w = await world();
    await env.IMAGES.put('images/purge-test', new Uint8Array([1, 2, 3]));
    await env.DB.prepare("INSERT INTO images (id, owner_user_id, tournament_id, purpose, r2_key, content_type, size_bytes, created_at, updated_at) VALUES ('img-purge', ?, ?, 'post', 'images/purge-test', 'image/png', 3, '', '')").bind(w.player, w.t.id).run();
    await env.DB.prepare("INSERT INTO team_pages (id, team_id, title, created_by, created_at, updated_at) VALUES ('pg-purge', ?, '全体', 'x', '', '')").bind(w.t.teams[0]).run();
    await env.DB.prepare("INSERT INTO team_posts (id, page_id, author_user_id, body, created_at, updated_at) VALUES ('po-purge', 'pg-purge', ?, 'x', '', '')").bind(w.player).run();
    await env.DB.prepare("UPDATE tournaments SET phase = 'ended', ended_at = ? WHERE id = ?").bind(new Date(Date.now() - 11 * 86400e3).toISOString(), w.t.id).run();
    expect(await purgeEndedTournaments(env)).toBeGreaterThanOrEqual(1);
    for (const [table, where] of [['tournaments', `id = '${w.t.id}'`], ['teams', `tournament_id = '${w.t.id}'`], ['tournament_members', `tournament_id = '${w.t.id}'`], ['team_posts', "id = 'po-purge'"], ['images', "id = 'img-purge'"]]) {
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${where}`).first(), table).toBeNull();
    }
    expect(await env.IMAGES.get('images/purge-test')).toBeNull();
  });
});

describe('2 年ログインなしの削除', () => {
  it('最後のログインから 2 年たった利用者は消える。管理者は消さない', async () => {
    const old = await makeUser();
    const oldAdmin = await makeUser({ adminLevel: 'sub' });
    const recent = await makeUser();
    const threeYears = new Date(Date.now() - 3 * 365 * 86400e3).toISOString();
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id IN (?, ?)').bind(threeYears, old, oldAdmin).run();
    await purgeInactiveUsers(env);
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(old).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(oldAdmin).first()).toBeTruthy();
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(recent).first()).toBeTruthy();
  });
});

describe('見るだけのプレビュー', () => {
  async function previewAs(auth: Auth, body: Record<string, unknown>) {
    const res = await req('POST', '/api/preview/start', { auth, body });
    const cookie = (res.headers.getSetCookie?.() ?? []).join(';').match(/__Host-preview=[^;]+/)?.[0];
    return { status: res.status, auth: cookie ? { ...auth, cookie: `${auth.cookie}; ${cookie}` } : auth };
  }

  it('選んだ立場として見える。管理者の画面は使えず、書き込みはすべて断る。終了すると管理者に戻る', async () => {
    const w = await world();
    const p = await previewAs(w.sub, { as: 'player', teamId: w.t.teams[0] });
    expect(p.status).toBe(200);
    const me = await json(await req('GET', '/api/me', { auth: p.auth }));
    expect([me.user.isAdmin, me.user.membership.memberType, me.preview.teamId]).toEqual([false, 'player', w.t.teams[0]]);
    expect((await json(await req('GET', '/api/schedule', { auth: p.auth }))).teams.find((t: any) => t.isMine)).toBeTruthy();
    expect((await req('GET', '/api/admin/me', { auth: p.auth })).status).toBe(403);
    const write = await req('PATCH', '/api/me', { auth: p.auth, body: { xAccount: 'x' } });
    expect([write.status, (await json(write)).error]).toEqual([403, 'preview_readonly']);
    expect((await req('POST', '/api/preview/stop', { auth: p.auth })).status).toBe(200);
    expect((await req('GET', '/api/admin/me', { auth: w.sub })).status).toBe(200);
  });

  it('管理者以外は始められない。他人のセッション用に作られたプレビューは効かない', async () => {
    const w = await world();
    expect((await previewAs(w.playerAuth, { as: 'viewer' })).status).toBe(403);
    const forged = await makePreview(env, 'someone-elses-session', 'player', w.t.teams[0]!);
    const auth = { ...w.a, cookie: `${w.a.cookie}; ${PREVIEW_COOKIE}=${forged}` };
    expect((await req('GET', '/api/admin/me', { auth })).status).toBe(200); // 管理者のまま
  });

  it('1 時間で自動的に終わる', async () => {
    const w = await world();
    const p = await previewAs(w.sub, { as: 'viewer' });
    expect((await req('GET', '/api/admin/me', { auth: p.auth })).status).toBe(403);
    setClockForTest(() => new Date(Date.now() + 61 * 60 * 1000));
    expect((await req('GET', '/api/admin/me', { auth: p.auth })).status).toBe(200);
  });
});
