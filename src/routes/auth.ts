import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { createSession, revokeAllSessions, revokeSession, sessionCookie, clearSessionCookie } from '../auth/session';
import { decrypt, encrypt, pkceChallenge, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { addMs, now, nowIso } from '../lib/time';
import { writeAudit } from '../services/audit';

const STATE_COOKIE = '__Host-oauth';
const STATE_TTL_MS = 10 * 60 * 1000;
export const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
export const DISCORD_ME = 'https://discord.com/api/users/@me';

export const authRoutes = new Hono<AppEnv>();

/** Discord ログインの開始（S-1-2：認可コードフロー＋state＋PKCE、権限は identify のみ） */
authRoutes.get('/login', async (c) => {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const t = nowIso();
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(t).run();
  await c.env.DB.prepare('INSERT INTO oauth_states (id, code_verifier_enc, purpose, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex(state), await encrypt(verifier, c.env.ENCRYPTION_KEY), 'login', addMs(now(), STATE_TTL_MS).toISOString(), t, t)
    .run();
  setCookie(c, STATE_COOKIE, state, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: STATE_TTL_MS / 1000 });
  const url = new URL(DISCORD_AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.env.DISCORD_CLIENT_ID);
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `${c.env.APP_ORIGIN}/auth/callback`);
  url.searchParams.set('code_challenge', await pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return c.redirect(url.toString(), 302);
});

interface DiscordUser { id: string; username: string; global_name?: string | null }

authRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true });
  if (!code || !state || !cookieState || !safeEqual(state, cookieState)) throw new HttpError(400, 'invalid_state', 'ログインをやり直してください');

  // state は 1 回限り。使ったらすぐ消す
  const stateId = await sha256Hex(state);
  const row = await c.env.DB.prepare('SELECT code_verifier_enc, expires_at FROM oauth_states WHERE id = ? AND purpose = ?')
    .bind(stateId, 'login')
    .first<{ code_verifier_enc: string; expires_at: string }>();
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE id = ?').bind(stateId).run();
  if (!row || row.expires_at <= nowIso()) throw new HttpError(400, 'invalid_state', 'ログインをやり直してください');
  const verifier = await decrypt(row.code_verifier_enc, c.env.ENCRYPTION_KEY);

  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.DISCORD_CLIENT_ID,
      client_secret: c.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new HttpError(400, 'discord_error', 'Discord でのログインに失敗しました');
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new HttpError(400, 'discord_error', 'Discord でのログインに失敗しました');

  const meRes = await fetch(DISCORD_ME, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!meRes.ok) throw new HttpError(400, 'discord_error', 'Discord でのログインに失敗しました');
  const me = (await meRes.json()) as DiscordUser;
  // アクセストークンはここで使い終わり。保存しない（S-1-2）
  if (!/^\d{5,25}$/.test(me.id)) throw new HttpError(400, 'discord_error');

  const discordName = (me.global_name || me.username || 'user').slice(0, 40);
  const t = nowIso();
  const existing = await c.env.DB.prepare('SELECT id, admin_level, suspended_at FROM users WHERE discord_user_id = ?')
    .bind(me.id)
    .first<{ id: string; admin_level: 'none' | 'sub' | 'super'; suspended_at: string | null }>();
  let userId: string;
  let adminLevel: 'none' | 'sub' | 'super' = 'none';
  if (existing) {
    if (existing.suspended_at) throw new HttpError(403, 'suspended', 'このアカウントは利用停止中です');
    userId = existing.id;
    adminLevel = existing.admin_level;
    await c.env.DB.prepare('UPDATE users SET discord_name = ?, last_login_at = ?, updated_at = ? WHERE id = ?').bind(discordName, t, t, userId).run();
  } else {
    userId = ulid();
    await c.env.DB.prepare('INSERT INTO users (id, discord_user_id, discord_name, last_login_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind(userId, me.id, discordName, t, t, t)
      .run();
  }
  const { token, expiresAt } = await createSession(c.env.DB, userId, adminLevel);
  await writeAudit(c.env.DB, userId, 'login');
  c.header('Set-Cookie', sessionCookie(token, expiresAt), { append: true });
  return c.redirect('/', 302);
});

authRoutes.post('/logout', async (c) => {
  const user = c.get('user');
  if (user) await revokeSession(c.env.DB, user.sessionId);
  c.header('Set-Cookie', clearSessionCookie(), { append: true });
  return c.json({ ok: true });
});

authRoutes.post('/logout-all', async (c) => {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'login_required');
  await revokeAllSessions(c.env.DB, user.id);
  await writeAudit(c.env.DB, user.id, 'logout_all');
  c.header('Set-Cookie', clearSessionCookie(), { append: true });
  return c.json({ ok: true });
});
