import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AdminLevel, AppEnv } from '../env';
import { resolveSession, SESSION_COOKIE, verifyCsrf } from '../auth/session';
import { HttpError } from '../lib/errors';

/** すべてのリクエストで、ログイン中の利用者を読み込む（いなければ null） */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', await resolveSession(c.env.DB, getCookie(c, SESSION_COOKIE)));
  await next();
};

export const requireLogin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new HttpError(401, 'login_required', 'ログインが必要です');
  await next();
};

const rank: Record<AdminLevel, number> = { none: 0, sub: 1, super: 2 };

/** 管理者のみ。level='super' なら全体管理者のみ */
export const requireAdmin = (level: Exclude<AdminLevel, 'none'> = 'sub'): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'login_required', 'ログインが必要です');
  if (rank[user.adminLevel] < rank[level]) throw new HttpError(403, 'forbidden', 'この操作を行う権限がありません');
  await next();
};

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF 対策（S-4-4）：状態を変える操作は、Origin が自サイトであることと、
 * セッションに結びついた CSRF トークン（X-CSRF-Token）を確認する
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (UNSAFE.has(c.req.method)) {
    const origin = c.req.header('Origin');
    if (!origin || origin !== c.env.APP_ORIGIN) throw new HttpError(403, 'bad_origin', '不正なリクエストです');
    const user = c.get('user');
    if (user && !(await verifyCsrf(c.env, user.sessionId, c.req.header('X-CSRF-Token')))) {
      throw new HttpError(403, 'bad_csrf_token', '不正なリクエストです');
    }
  }
  await next();
};
