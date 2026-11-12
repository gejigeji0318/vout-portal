import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import { json, loginAs, makeTournament, makeUser, ORIGIN, req } from './helpers';

const dev = { ENVIRONMENT: 'development' as const };

describe('開発用の立場の切り替え', () => {
  it('本番では、ログインの有無や管理者かどうかに関係なく「存在しない」（404）', async () => {
    const sup = await loginAs(await makeUser({ adminLevel: 'super' }));
    for (const auth of [null, sup]) {
      expect((await req('GET', '/api/dev/personas', { auth, env: { ENVIRONMENT: 'production' } })).status).toBe(404);
      expect((await req('POST', '/api/dev/login-as', { auth, body: { persona: 'super' }, env: { ENVIRONMENT: 'production' } })).status).toBe(404);
    }
  });

  it('開発でも、PC の中（localhost）以外からの接続は拒否する', async () => {
    const r = await app.fetch(new Request('https://portal.example.com/api/dev/personas'), { ...env, ...dev },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
    expect(r.status).toBe(404);
  });

  it('テスト環境では管理者だけが使え、管理者権限を持つ立場は選べない', async () => {
    const test = { ENVIRONMENT: 'test' as const };
    expect((await req('GET', '/api/dev/personas', { env: test })).status).toBe(404);
    expect((await req('GET', '/api/dev/personas', { auth: await loginAs(await makeUser()), env: test })).status).toBe(404);
    const sub = await loginAs(await makeUser({ adminLevel: 'sub' }));
    const keys = (await json(await req('GET', '/api/dev/personas', { auth: sub, env: test }))).personas.map((p: any) => p.key);
    expect(keys).not.toContain('super');
    expect(keys).not.toContain('sub');
    expect((await req('POST', '/api/dev/login-as', { auth: sub, body: { persona: 'super' }, env: test })).status).toBe(422);
  });

  it('開発の PC では、選んだ立場のテスト用アカウントでログインでき、名前に（テスト）が付く', async () => {
    const t = await makeTournament(2);
    const res = await req('POST', '/api/dev/login-as', { body: { persona: 'coach-a' }, env: dev });
    expect(res.status).toBe(200);
    const cookie = (res.headers.getSetCookie?.() ?? []).join(';').match(/__Host-sid=[^;]+/)![0];
    const me = await json(await req('GET', '/api/me', { headers: { Cookie: cookie } }));
    expect(me.user.displayName).toBe('コーチ（チーム1）（テスト）');
    expect(me.user.membership).toEqual({ memberType: 'coach', teamId: t.teams[0], lane: null });
    const u = await env.DB.prepare("SELECT discord_user_id FROM users WHERE discord_user_id LIKE 'test-%'").first<{ discord_user_id: string }>();
    expect(u!.discord_user_id).toMatch(/^test-/);
  });
});
