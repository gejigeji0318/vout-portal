import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, req } from './helpers';

/**
 * 権限表（要件定義書 2 章）を API ごとのテストにしたもの。
 * 立場：未ログイン、登録済み閲覧者、選手、コーチ、補助スタッフ、補助管理者、全体管理者
 */
type Role = 'anon' | 'viewer' | 'player' | 'coach' | 'staff' | 'sub' | 'super';
const ROLES: Role[] = ['anon', 'viewer', 'player', 'coach', 'staff', 'sub', 'super'];
const auth: Partial<Record<Role, Auth>> = {};

beforeAll(async () => {
  const t = await makeTournament(3);
  const ids: Record<Exclude<Role, 'anon'>, string> = {
    viewer: await makeUser(),
    player: await makeUser(),
    coach: await makeUser(),
    staff: await makeUser(),
    sub: await makeUser({ adminLevel: 'sub' }),
    super: await makeUser({ adminLevel: 'super' }),
  };
  await addMember(t.id, ids.player, 'player', t.teams[0]!, 'MID');
  await addMember(t.id, ids.coach, 'coach', t.teams[0]!);
  await addMember(t.id, ids.staff, 'staff');
  for (const r of Object.keys(ids) as Exclude<Role, 'anon'>[]) auth[r] = await loginAs(ids[r]);
});

// Discord の API は偽物に置き換える（チャンネルが 0 件のサーバー）
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return url.includes('/guilds/') ? Response.json([]) : new Response(null, { status: 404 });
  });
});
afterEach(() => vi.restoreAllMocks());

const ADMIN_ONLY = { anon: 401, viewer: 403, player: 403, coach: 403, staff: 403, sub: 200, super: 200 } as const;
const SUPER_ONLY = { anon: 401, viewer: 403, player: 403, coach: 403, staff: 403, sub: 403, super: 200 } as const;
const EVERYONE = { anon: 200, viewer: 200, player: 200, coach: 200, staff: 200, sub: 200, super: 200 } as const;

const matrix: Array<{ name: string; method: string; path: string; expected: Record<Role, number> }> = [
  { name: '自分の情報', method: 'GET', path: '/api/me', expected: EVERYONE },
  { name: '管理者の種別', method: 'GET', path: '/api/admin/me', expected: ADMIN_ONLY },
  { name: '大会設定の取得', method: 'GET', path: '/api/admin/tournament', expected: ADMIN_ONLY },
  { name: 'チーム一覧（管理）', method: 'GET', path: '/api/admin/teams', expected: ADMIN_ONLY },
  { name: '日程一覧（管理）', method: 'GET', path: '/api/admin/events', expected: ADMIN_ONLY },
  { name: 'ユーザー一覧（管理）', method: 'GET', path: '/api/admin/users', expected: ADMIN_ONLY },
  { name: 'Discord 通知の設定', method: 'GET', path: '/api/admin/settings/notifications', expected: SUPER_ONLY },
  { name: '操作ログ', method: 'GET', path: '/api/admin/audit-logs', expected: SUPER_ONLY },
  { name: 'お知らせの管理一覧', method: 'GET', path: '/api/admin/announcements', expected: ADMIN_ONLY },
  { name: 'はじめに', method: 'GET', path: '/api/pages/about', expected: EVERYONE },
  { name: 'お知らせ一覧', method: 'GET', path: '/api/announcements', expected: EVERYONE },
  { name: '問い合わせ対応', method: 'GET', path: '/api/admin/inquiries', expected: ADMIN_ONLY },
  { name: '適性レーンの状態', method: 'GET', path: '/api/admin/lanes/status', expected: ADMIN_ONLY },
  { name: 'TOP', method: 'GET', path: '/api/home', expected: EVERYONE },
  { name: '応募一覧（審査）', method: 'GET', path: '/api/admin/applications', expected: ADMIN_ONLY },
  { name: '仮決定表', method: 'GET', path: '/api/admin/provisional', expected: ADMIN_ONLY },
  { name: '募集要項', method: 'GET', path: '/api/recruitment', expected: EVERYONE },
  { name: 'Discord のチャンネル一覧', method: 'GET', path: '/api/admin/discord/channels', expected: SUPER_ONLY },
];

describe('権限表どおりにアクセスが制限される', () => {
  for (const row of matrix) {
    for (const role of ROLES) {
      it(`${row.name}：${role} → ${row.expected[role]}`, async () => {
        const res = await req(row.method, row.path, { auth: auth[role] ?? null });
        expect(res.status).toBe(row.expected[role]);
      });
    }
  }

  it('利用停止は全体管理者のみ（補助管理者は 403）', async () => {
    const target = await makeUser();
    expect((await req('POST', `/api/admin/users/${target}/suspend`, { auth: auth.sub })).status).toBe(403);
    expect((await req('POST', `/api/admin/users/${target}/suspend`, { auth: auth.player })).status).toBe(403);
    expect((await req('POST', `/api/admin/users/${target}/suspend`, { auth: auth.super })).status).toBe(200);
  });

  it('紹介文を設定できるのは運営メンバー（管理者・補助スタッフ）だけ', async () => {
    expect((await req('PATCH', '/api/me', { auth: auth.player, body: { bio: 'よろしく' } })).status).toBe(403);
    expect((await req('PATCH', '/api/me', { auth: auth.staff, body: { bio: 'よろしく' } })).status).toBe(200);
    expect((await req('PATCH', '/api/me', { auth: auth.sub, body: { bio: 'よろしく' } })).status).toBe(200);
  });
});

describe('返してはいけない項目が含まれない', () => {
  const FORBIDDEN_IN_PUBLIC = ['admin_level', 'adminLevel', '"sub"', '"super"', 'discord_user_id', 'code_verifier', 'webhook', 'session'];

  it('一般の API（/api/me）は、管理者にも管理者の種別を返さない', async () => {
    for (const role of ROLES) {
      const text = JSON.stringify(await json(await req('GET', '/api/me', { auth: auth[role] ?? null })));
      for (const f of FORBIDDEN_IN_PUBLIC) expect(text, `${role} の応答に ${f}`).not.toContain(f);
    }
  });

  it('管理者かどうかの真偽値だけは本人に返る', async () => {
    expect((await json(await req('GET', '/api/me', { auth: auth.sub }))).user.isAdmin).toBe(true);
    expect((await json(await req('GET', '/api/me', { auth: auth.player }))).user.isAdmin).toBe(false);
  });
});

describe('Cloudflare Access（管理者画面の二重保護）', () => {
  it('本番で Access の設定が無いときは、管理者でも通さない（設定漏れで素通りにしない）', async () => {
    const res = await req('GET', '/api/admin/me', { auth: auth.super, env: { ENVIRONMENT: 'production' } });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('access_not_configured');
  });

  it('Access が設定されていて JWT が無ければ通さない', async () => {
    const res = await req('GET', '/api/admin/me', { auth: auth.super, env: { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' } });
    expect(res.status).toBe(403);
  });
});
