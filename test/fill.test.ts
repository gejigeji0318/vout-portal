import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { setClockForTest } from '../src/lib/time';
import { postDueOb } from '../src/services/fill';
import { DISCORD_GUILDS } from '../src/routes/obVerify';
import { DISCORD_ME, DISCORD_TOKEN } from '../src/routes/auth';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, req } from './helpers';

let sent: { content: string; users: string[] }[] = [];
let guilds: { id: string }[] = [];
let discordMeId = '';
beforeEach(async () => {
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/messages')) { const b = JSON.parse(String(init?.body)); sent.push({ content: b.content, users: b.allowed_mentions?.users ?? [] }); return Response.json({ id: '1' }); }
    if (url === DISCORD_TOKEN) return Response.json({ access_token: 'tok' });
    if (url === DISCORD_ME) return Response.json({ id: discordMeId, username: 'x' });
    if (url === DISCORD_GUILDS) return Response.json(guilds);
    return new Response(null, { status: 404 });
  });
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, created_at, updated_at) VALUES ('notification.default', ?, '', '')")
    .bind(JSON.stringify({ channelId: '900000000000000002', channelName: '全体', categoryName: null, kind: 'text' })).run();
});
afterEach(() => { vi.restoreAllMocks(); setClockForTest(null); });

const START = new Date(Date.now() + 3 * 86400e3);           // 3 日後のスクリム
const iso = (d: Date) => d.toISOString();

async function world() {
  const t = await makeTournament(3, 'scrim');
  const [A, B, C] = t.teams as [string, string, string];
  const mk = async (type: 'player' | 'coach' | 'staff' | null, team: string | null, name: string, lane: string | null = null) => {
    const id = await makeUser({ name }); if (type) await addMember(t.id, id, type, team, lane);
    const u = await env.DB.prepare('SELECT discord_user_id FROM users WHERE id = ?').bind(id).first<{ discord_user_id: string }>();
    return { id, discord: u!.discord_user_id, auth: await loginAs(id) };
  };
  const w = {
    t, A, B, C,
    coachA: await mk('coach', A, 'Aコーチ'), coachB: await mk('coach', B, 'Bコーチ'), coachC: await mk('coach', C, 'Cコーチ'),
    playerA: await mk('player', A, 'A選手', 'MID'), playerC: await mk('player', C, 'C選手', 'MID'), playerC2: await mk('player', C, 'C選手2', 'SUP'),
    staff: await mk('staff', null, '運営スタッフ'), ob: await mk(null, null, 'OBさん'), outsider: await mk(null, null, '一般の人'),
    admin: await loginAs(await makeUser({ adminLevel: 'sub' })),
  };
  await env.DB.prepare('UPDATE users SET ob_verified_at = ? WHERE id = ?').bind(new Date().toISOString(), w.ob.id).run();
  const scrim = `scrim-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO scrims (id, tournament_id, requester_team_id, opponent_team_id, format, status, starts_at, ends_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'BO3', 'confirmed', ?, ?, 'x', '', '')")
    .bind(scrim, t.id, A, B, iso(START), iso(new Date(START.getTime() + 2 * 3600e3))).run();
  return { ...w, scrim };
}
type W = Awaited<ReturnType<typeof world>>;
const open = async (w: W, lanes = ['MID', 'SUP'], auth: Auth = w.coachA.auth) => req('POST', '/api/fill', { auth, body: { scrimId: w.scrim, lanes, note: 'A チームより' } });
const list = async (auth: Auth) => (await json(await req('GET', '/api/fill', { auth }))).requests;

describe('人員補充：募集', () => {
  it('募集を出せるのは、そのスクリムに出るチームのコーチと管理者だけ', async () => {
    const w = await world();
    expect((await open(w, ['MID'], w.coachC.auth)).status).toBe(403);
    expect((await open(w, ['MID'], w.playerA.auth)).status).toBe(403);
    expect((await open(w)).status).toBe(201);
    expect(sent.at(-1)!.content).toContain('人員補充の募集');
    expect(sent.at(-1)!.content).toContain('MID・SUP（2 人）');
  });

  it('参加者には見え、確認していない一般の人には見えない。OB には OB 向けに出すまで見えない', async () => {
    const w = await world();
    await open(w);
    expect((await list(w.playerC.auth))[0].teamName).toBe('チーム 1');
    expect((await req('GET', '/api/fill', { auth: w.outsider.auth })).status).toBe(403);
    expect(await list(w.ob.auth)).toEqual([]);
  });

  it('OB への自動募集：開始の 24 時間前に、まだ埋まっていなければ出す。OB 向けにはチーム名も補足も出さない。二重には出さない', async () => {
    const w = await world();
    await open(w);
    expect(await postDueOb(env)).toBe(0);
    setClockForTest(() => new Date(START.getTime() - 23 * 3600e3));
    expect(await postDueOb(env)).toBe(1);
    expect(await postDueOb(env)).toBe(0);
    expect(sent.at(-1)!.content).toContain('OB の方へ');
    expect(sent.at(-1)!.content).not.toContain('チーム');
    setClockForTest(null);
    const forOb = JSON.stringify(await list(w.ob.auth));
    expect(forOb).toContain('MID');
    expect(forOb).not.toContain('チーム 1');
    expect(forOb).not.toContain('A チームより');
  });

  it('「今すぐ OB に募集」は管理者だけ', async () => {
    const w = await world();
    const { id } = await json(await open(w));
    expect((await req('POST', `/api/admin/fill/${id}/ob-now`, { auth: w.coachA.auth })).status).toBe(403);
    expect((await json(await req('POST', `/api/admin/fill/${id}/ob-now`, { auth: w.admin }))).posted).toBe(1);
  });
});

describe('人員補充：応募・声かけ・承認', () => {
  it('そのスクリムに出るチームの人とコーチは応募できない。他チームの選手・補助スタッフ・OB は応募できる', async () => {
    const w = await world();
    const { id } = await json(await open(w));
    const slot = (await list(w.coachA.auth)).find((r: any) => r.id === id).slots[0].id;
    expect((await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.playerA.auth })).status).toBe(409);
    expect((await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.coachC.auth })).status).toBe(403);
    expect((await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.playerC.auth })).status).toBe(200);
    expect((await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.staff.auth })).status).toBe(200);
    expect((await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.ob.auth })).status).toBe(404); // OB 向けに出る前
  });

  it('同じ時間に出るスクリムがある人は応募できない', async () => {
    const w = await world();
    await env.DB.prepare("INSERT INTO scrims (id, tournament_id, requester_team_id, opponent_team_id, format, status, starts_at, ends_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'BO1', 'confirmed', ?, ?, 'x', '', '')")
      .bind(`other-${w.scrim}`, w.t.id, w.C, w.B, iso(new Date(START.getTime() + 3600e3)), iso(new Date(START.getTime() + 3 * 3600e3))).run();
    await env.DB.prepare("INSERT INTO scrim_participants (scrim_id, user_id, team_id, via, created_at, updated_at) VALUES (?, ?, ?, 'team', '', '')").bind(`other-${w.scrim}`, w.playerC.id, w.C).run();
    const { id } = await json(await open(w));
    const slot = (await list(w.coachA.auth)).find((r: any) => r.id === id).slots[0].id;
    expect((await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.playerC.auth })).status).toBe(409);
  });

  it('声かけだけでは決まらない。本人が応募してから承認でき、承認するとスクリムの参加メンバーに入り、本人に知らせる', async () => {
    const w = await world();
    const { id } = await json(await open(w, ['MID']));
    const slot = (await list(w.coachA.auth)).find((r: any) => r.id === id).slots[0].id;
    expect((await req('POST', `/api/fill/slots/${slot}/invite`, { auth: w.coachA.auth, body: { userId: w.playerC.id } })).status).toBe(200);
    expect(sent.at(-1)!.users).toEqual([w.playerC.discord]);
    await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.playerC2.auth });
    const apps = (await list(w.coachA.auth)).find((r: any) => r.id === id).slots[0].applicants;
    const invited = apps.find((a: any) => a.userId === w.playerC.id);
    expect(invited.status).toBe('invited');
    expect((await req('POST', `/api/fill/applications/${invited.id}/approve`, { auth: w.coachA.auth })).status).toBe(409);
    await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.playerC.auth });
    expect((await req('POST', `/api/fill/applications/${invited.id}/approve`, { auth: w.coachB.auth })).status).toBe(403);
    expect((await req('POST', `/api/fill/applications/${invited.id}/approve`, { auth: w.coachA.auth })).status).toBe(200);
    expect(sent.at(-1)!.content).toContain('人員補充が決まりました');
    const p = await env.DB.prepare("SELECT team_id, via FROM scrim_participants WHERE scrim_id = ? AND user_id = ?").bind(w.scrim, w.playerC.id).first();
    expect(p).toEqual({ team_id: w.A, via: 'fill' });
    const after = (await list(w.coachA.auth)).find((r: any) => r.id === id);
    expect(after.status).toBe('filled');
    expect(after.slots[0].applicants.find((a: any) => a.userId === w.playerC2.id).status).toBe('not_selected');
  });

  it('応募者の一覧は、募集したチームのコーチと管理者だけが見られる', async () => {
    const w = await world();
    const { id } = await json(await open(w));
    const slot = (await list(w.coachA.auth)).find((r: any) => r.id === id).slots[0].id;
    await req('POST', `/api/fill/slots/${slot}/apply`, { auth: w.playerC.auth });
    for (const a of [w.coachB.auth, w.playerC2.auth]) {
      const text = JSON.stringify(await list(a));
      expect(text).not.toContain('applicants');
      expect(text).not.toContain('C選手"');
    }
    expect((await list(w.admin)).find((r: any) => r.id === id).slots[0].applicants).toHaveLength(1);
  });

  it('声をかけられる人の一覧には、そのスクリムに出るチームの人とコーチは入らない。募集したチームのコーチだけが見られる', async () => {
    const w = await world();
    const { id } = await json(await open(w));
    expect((await req('GET', `/api/fill/${id}/candidates`, { auth: w.coachB.auth })).status).toBe(403);
    const names = (await json(await req('GET', `/api/fill/${id}/candidates`, { auth: w.coachA.auth }))).people.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['C選手', 'C選手2', '運営スタッフ', 'OBさん']));
    expect(names).not.toContain('A選手');
    expect(names).not.toContain('Cコーチ');
    expect(names).not.toContain('一般の人');
  });

  it('スクリムを中止すると、その補充の募集も締め切られる', async () => {
    const w = await world();
    await open(w);
    await req('POST', `/api/scrims/${w.scrim}/cancel`, { auth: w.coachA.auth, body: { reason: '都合により' } });
    expect(await list(w.playerC.auth)).toEqual([]);
  });
});

describe('OB の確認', () => {
  const GUILD = '800000000000000000';
  async function verify(auth: Auth) {
    const start = await req('GET', '/auth/ob-verify', { auth });
    const loc = new URL(start.headers.get('Location')!);
    expect(loc.searchParams.get('scope')).toBe('identify guilds');
    const state = loc.searchParams.get('state')!;
    const cookie = (start.headers.getSetCookie?.() ?? []).join(';').match(/__Host-obv=[^;]+/)![0];
    const res = await req('GET', `/auth/ob-callback?code=c&state=${state}`, { headers: { Cookie: `${auth.cookie}; ${cookie}` } });
    return res.headers.get('Location');
  }

  it('Vout の Discord サーバーに参加していれば確認済みになる。参加していなければならない', async () => {
    const w = await world();
    discordMeId = w.outsider.discord;
    guilds = [{ id: '1' }];
    expect(await verify(w.outsider.auth)).toBe('/fill?ob=not_member');
    guilds = [{ id: GUILD }];
    expect(await verify(w.outsider.auth)).toBe('/fill?ob=ok');
    expect((await json(await req('GET', '/auth/ob-status', { auth: w.outsider.auth }))).verified).toBe(true);
  });

  it('ログイン中と別の Discord アカウントで認証しても、確認済みにならない', async () => {
    const w = await world();
    discordMeId = '999999999999';
    guilds = [{ id: GUILD }];
    expect(await verify(w.outsider.auth)).toBe('/fill?ob=mismatch');
    expect((await json(await req('GET', '/auth/ob-status', { auth: w.outsider.auth }))).verified).toBe(false);
  });
});
