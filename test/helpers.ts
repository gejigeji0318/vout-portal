import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import { createSession, csrfTokenFor, SESSION_COOKIE } from '../src/auth/session';
import { sha256Hex } from '../src/lib/crypto';
import { ulid } from '../src/lib/id';
import { nowIso } from '../src/lib/time';
import type { AdminLevel, Env, MemberType } from '../src/env';

export const ORIGIN = 'http://localhost:8787';
let seq = 0;

export async function makeUser(opts: { adminLevel?: AdminLevel; name?: string; suspended?: boolean } = {}): Promise<string> {
  const id = ulid();
  const t = nowIso();
  seq += 1;
  await env.DB.prepare(
    'INSERT INTO users (id, discord_user_id, discord_name, admin_level, last_login_at, suspended_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).bind(id, String(100000000 + seq + Math.floor(Math.random() * 1e6)), opts.name ?? `user${seq}`, opts.adminLevel ?? 'none', t, opts.suspended ? t : null, t, t).run();
  return id;
}

export interface Auth { cookie: string; csrf: string; sessionId: string }

export async function loginAs(userId: string): Promise<Auth> {
  const u = await env.DB.prepare('SELECT admin_level FROM users WHERE id = ?').bind(userId).first<{ admin_level: AdminLevel }>();
  const { token } = await createSession(env.DB, userId, u!.admin_level);
  const sessionId = await sha256Hex(token);
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: await csrfTokenFor(env, sessionId), sessionId };
}

export interface ReqOpts { auth?: Auth | null; body?: unknown; origin?: string | null; csrf?: string | null; headers?: Record<string, string>; env?: Partial<Env> }

export async function req(method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.auth) headers.set('Cookie', opts.auth.cookie);
  const unsafe = method !== 'GET' && method !== 'HEAD';
  if (unsafe) {
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    if (origin) headers.set('Origin', origin);
    const csrf = opts.csrf === undefined ? opts.auth?.csrf : opts.csrf;
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(opts.body);
  }
  const e = { ...env, ...(opts.env ?? {}) } as Env;
  return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: 'manual' }), e, {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext);
}

/** 大会（チーム数 teamCount）を作り、チームの ID を返す */
export async function makeTournament(teamCount = 3, phase = 'preparing'): Promise<{ id: string; teams: string[] }> {
  const id = ulid();
  const t = nowIso();
  await env.DB.prepare('UPDATE tournaments SET phase = ? WHERE phase <> ?').bind('ended', 'ended').run();
  await env.DB.prepare('INSERT INTO tournaments (id, name, phase, period_start, period_end, team_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, 'テスト大会', phase, '2027-01-01T00:00:00.000Z', '2027-02-28T00:00:00.000Z', teamCount, t, t).run();
  const teams: string[] = [];
  for (let i = 0; i < teamCount; i++) {
    const tid = ulid();
    teams.push(tid);
    await env.DB.prepare('INSERT INTO teams (id, tournament_id, created_at, updated_at) VALUES (?,?,?,?)').bind(tid, id, t, t).run();
  }
  return { id, teams };
}

export async function addMember(tournamentId: string, userId: string, type: MemberType, teamId: string | null = null, lane: string | null = null): Promise<void> {
  const t = nowIso();
  await env.DB.prepare('INSERT INTO tournament_members (id, tournament_id, user_id, member_type, team_id, lane, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(ulid(), tournamentId, userId, type, teamId, lane, t, t).run();
}

export const json = async (r: Response): Promise<any> => r.json();
