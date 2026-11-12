import type { AdminLevel, CurrentUser, Env } from '../env';
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { addMs, DAY, HOUR, now, nowIso } from '../lib/time';

export const SESSION_COOKIE = '__Host-sid';
/** 有効期限（要件定義書 S-2-3）：利用者 7 日、管理者 8 時間 */
export const USER_SESSION_TTL = 7 * DAY;
export const ADMIN_SESSION_TTL = 8 * HOUR;

export async function createSession(db: D1Database, userId: string, adminLevel: AdminLevel): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const ttl = adminLevel === 'none' ? USER_SESSION_TTL : ADMIN_SESSION_TTL;
  const expiresAt = addMs(now(), ttl).toISOString();
  const t = nowIso();
  await db
    .prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, expiresAt, t, t)
    .run();
  return { token, expiresAt };
}

interface SessionRow {
  session_id: string;
  expires_at: string;
  user_id: string;
  discord_name: string;
  display_name: string | null;
  admin_level: AdminLevel;
  suspended_at: string | null;
}

/** Cookie の値からログイン中の利用者を求める。期限切れ・利用停止なら null */
export async function resolveSession(db: D1Database, token: string | undefined): Promise<CurrentUser | null> {
  if (!token || token.length > 100) return null;
  const id = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.discord_name, u.display_name, u.admin_level, u.suspended_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .bind(id)
    .first<SessionRow>();
  if (!row) return null;
  if (row.expires_at <= nowIso() || row.suspended_at) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return {
    id: row.user_id,
    discordName: row.discord_name,
    displayName: row.display_name,
    adminLevel: row.admin_level,
    sessionId: row.session_id,
  };
}

export const revokeSession = (db: D1Database, sessionId: string) => db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
/** 全端末からのログアウト。権限の変更・利用停止のときにも使う（S-2-4） */
export const revokeAllSessions = (db: D1Database, userId: string) => db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();

export function sessionCookie(token: string, expiresAt: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}
export const clearSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** CSRF トークン：セッションに結びついた署名。DB に列を増やさずに済む */
export const csrfTokenFor = (env: Env, sessionId: string): Promise<string> => hmacHex(`csrf:${sessionId}`, env.SIGNING_KEY);
export async function verifyCsrf(env: Env, sessionId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return safeEqual(await csrfTokenFor(env, sessionId), token);
}
