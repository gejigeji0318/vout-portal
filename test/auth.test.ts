import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { DISCORD_ME, DISCORD_TOKEN } from '../src/routes/auth';
import { setClockForTest, HOUR, DAY } from '../src/lib/time';
import { json, loginAs, makeUser, req } from './helpers';

afterEach(() => vi.restoreAllMocks());

const cookieValue = (res: Response, name: string): string | null => {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('Set-Cookie') ?? ''];
  for (const c of all) { const m = c.match(new RegExp(`${name}=([^;]*)`)); if (m) return m[1]!; }
  return null;
};

async function startLogin(): Promise<{ state: string; cookie: string; location: URL }> {
  const res = await req('GET', '/auth/login');
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('Location')!);
  const state = location.searchParams.get('state')!;
  return { state, cookie: `__Host-oauth=${cookieValue(res, '__Host-oauth')}`, location };
}

function mockDiscord(user: { id: string; username: string; global_name?: string }) {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === DISCORD_TOKEN) return Response.json({ access_token: 'discord-access-token', token_type: 'Bearer' });
    if (url === DISCORD_ME) return Response.json(user);
    return original(input, init);
  });
}

describe('Discord ログイン', () => {
  it('開始時：identify のみ・PKCE（S256）・state を付けて Discord へ移り、state を Cookie に保存する', async () => {
    const { location, cookie } = await startLogin();
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('scope')).toBe('identify');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(cookie).toMatch(/__Host-oauth=.+/);
  });

  it('state が Cookie と違えば拒否する（ログイン CSRF 対策）', async () => {
    const { state } = await startLogin();
    const res = await req('GET', `/auth/callback?code=x&state=${state}`, { headers: { Cookie: '__Host-oauth=other' } });
    expect(res.status).toBe(400);
  });

  it('初回ログインで利用者を作り、セッション Cookie（HttpOnly・Secure・SameSite）を返す。アクセストークンは保存しない', async () => {
    mockDiscord({ id: '111222333444', username: 'taro', global_name: 'たろう' });
    const { state, cookie } = await startLogin();
    const res = await req('GET', `/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(302);
    const setCookie = (res.headers.getSetCookie?.() ?? []).join('\n');
    expect(setCookie).toMatch(/__Host-sid=.+HttpOnly; Secure; SameSite=Lax/);
    const u = await env.DB.prepare('SELECT * FROM users WHERE discord_user_id = ?').bind('111222333444').first<Record<string, unknown>>();
    expect(u?.discord_name).toBe('たろう');
    expect(JSON.stringify(u)).not.toContain('discord-access-token');
  });

  it('同じ state は 2 回使えない', async () => {
    mockDiscord({ id: '555666777888', username: 'jiro' });
    const { state, cookie } = await startLogin();
    expect((await req('GET', `/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(302);
    expect((await req('GET', `/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(400);
  });

  it('利用停止中の人はログインできない', async () => {
    const id = await makeUser({ suspended: true });
    const { discord_user_id } = (await env.DB.prepare('SELECT discord_user_id FROM users WHERE id = ?').bind(id).first<{ discord_user_id: string }>())!;
    mockDiscord({ id: discord_user_id, username: 'x' });
    const { state, cookie } = await startLogin();
    expect((await req('GET', `/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(403);
  });
});

describe('セッション', () => {
  it('Cookie が無い・でたらめなら未ログイン扱い', async () => {
    expect(await json(await req('GET', '/api/me'))).toEqual({ loggedIn: false });
    expect(await json(await req('GET', '/api/me', { headers: { Cookie: '__Host-sid=bogus' } }))).toEqual({ loggedIn: false });
  });

  it('利用者は 7 日、管理者は 8 時間で切れる', async () => {
    const user = await loginAs(await makeUser());
    const admin = await loginAs(await makeUser({ adminLevel: 'sub' }));
    const base = Date.now();
    setClockForTest(() => new Date(base + 9 * HOUR));
    expect((await json(await req('GET', '/api/me', { auth: user }))).loggedIn).toBe(true);
    expect((await json(await req('GET', '/api/me', { auth: admin }))).loggedIn).toBe(false);
    setClockForTest(() => new Date(base + 7 * DAY + HOUR));
    expect((await json(await req('GET', '/api/me', { auth: user }))).loggedIn).toBe(false);
  });

  it('ログアウトでセッションが消える', async () => {
    const a = await loginAs(await makeUser());
    expect((await req('POST', '/auth/logout', { auth: a })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: a }))).loggedIn).toBe(false);
  });

  it('全端末ログアウトで、他の端末のセッションも消える', async () => {
    const id = await makeUser();
    const pc = await loginAs(id);
    const phone = await loginAs(id);
    expect((await req('POST', '/auth/logout-all', { auth: pc })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: phone }))).loggedIn).toBe(false);
  });
});

describe('CSRF 対策', () => {
  it('Origin が無い・違う・トークンが無い・違うと拒否し、正しければ通す', async () => {
    const a = await loginAs(await makeUser());
    const body = { xAccount: 'abc' };
    expect((await req('PATCH', '/api/me', { auth: a, body, origin: null })).status).toBe(403);
    expect((await req('PATCH', '/api/me', { auth: a, body, origin: 'https://evil.example' })).status).toBe(403);
    expect((await req('PATCH', '/api/me', { auth: a, body, csrf: null })).status).toBe(403);
    expect((await req('PATCH', '/api/me', { auth: a, body, csrf: 'f'.repeat(64) })).status).toBe(403);
    expect((await req('PATCH', '/api/me', { auth: a, body })).status).toBe(200);
  });

  it('他人のセッションの CSRF トークンは使えない', async () => {
    const a = await loginAs(await makeUser());
    const b = await loginAs(await makeUser());
    expect((await req('PATCH', '/api/me', { auth: a, body: { xAccount: 'abc' }, csrf: b.csrf })).status).toBe(403);
  });
});

describe('セキュリティヘッダー', () => {
  it('主なヘッダーが付き、API はキャッシュさせない', async () => {
    const res = await req('GET', '/api/me');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
