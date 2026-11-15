import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { decrypt, encrypt, pkceChallenge, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { addMs, now, nowIso } from '../lib/time';
import { requireLogin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { DISCORD_AUTHORIZE, DISCORD_ME, DISCORD_TOKEN } from './auth';

/**
 * OB の確認（F-07）：Discord でもう一度認証してもらい、Vout の Discord サーバーに参加しているかを確かめる。
 * サーバーの一覧はこの確認にだけ使い、保存しない。ログイン中のアカウントと同じ Discord アカウントでなければ確認しない
 */
export const obVerifyRoutes = new Hono<AppEnv>();
export const DISCORD_GUILDS = 'https://discord.com/api/users/@me/guilds';
const COOKIE = '__Host-obv';

obVerifyRoutes.get('/ob-verify', requireLogin, async (c) => {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const t = nowIso();
  await c.env.DB.prepare('INSERT INTO oauth_states (id, code_verifier_enc, purpose, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex(state), await encrypt(verifier, c.env.ENCRYPTION_KEY), 'ob_verify', addMs(now(), 10 * 60 * 1000).toISOString(), t, t).run();
  setCookie(c, COOKIE, state, { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 });
  const url = new URL(DISCORD_AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.env.DISCORD_CLIENT_ID);
  url.searchParams.set('scope', 'identify guilds');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `${c.env.APP_ORIGIN}/auth/ob-callback`);
  url.searchParams.set('code_challenge', await pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return c.redirect(url.toString(), 302);
});

obVerifyRoutes.get('/ob-callback', requireLogin, async (c) => {
  const user = c.get('user')!;
  const done = (result: string) => c.redirect(`/fill?ob=${result}`, 302);
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieState = getCookie(c, COOKIE);
  deleteCookie(c, COOKIE, { path: '/', secure: true });
  if (!code || !state || !cookieState || !safeEqual(state, cookieState)) throw new HttpError(400, 'invalid_state', '確認をやり直してください');
  const sid = await sha256Hex(state);
  const row = await c.env.DB.prepare("SELECT code_verifier_enc, expires_at FROM oauth_states WHERE id = ? AND purpose = 'ob_verify'").bind(sid).first<{ code_verifier_enc: string; expires_at: string }>();
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE id = ?').bind(sid).run();
  if (!row || row.expires_at <= nowIso()) throw new HttpError(400, 'invalid_state', '確認をやり直してください');
  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.env.DISCORD_CLIENT_ID, client_secret: c.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code,
      redirect_uri: `${c.env.APP_ORIGIN}/auth/ob-callback`, code_verifier: await decrypt(row.code_verifier_enc, c.env.ENCRYPTION_KEY) }),
  });
  const token = tokenRes.ok ? ((await tokenRes.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return done('error');
  const headers = { Authorization: `Bearer ${token}` };
  const [meRes, guildsRes] = await Promise.all([fetch(DISCORD_ME, { headers }), fetch(DISCORD_GUILDS, { headers })]);
  if (!meRes.ok || !guildsRes.ok) return done('error');
  const me = (await meRes.json()) as { id: string };
  const own = await c.env.DB.prepare('SELECT discord_user_id FROM users WHERE id = ?').bind(user.id).first<{ discord_user_id: string }>();
  // 別の Discord アカウントで認証した場合は確認しない（他人のサーバー参加を使えないように）
  if (!own || own.discord_user_id !== me.id) return done('mismatch');
  const guilds = (await guildsRes.json()) as { id: string }[];
  if (!guilds.some((g) => g.id === c.env.DISCORD_GUILD_ID)) return done('not_member');
  await c.env.DB.prepare('UPDATE users SET ob_verified_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), user.id).run();
  await writeAudit(c.env.DB, user.id, 'ob_verified');
  return done('ok');
});

/** 確認の状態（ログイン中の本人だけ） */
obVerifyRoutes.get('/ob-status', requireLogin, async (c) => {
  const u = await c.env.DB.prepare('SELECT ob_verified_at FROM users WHERE id = ?').bind(c.get('user')!.id).first<{ ob_verified_at: string | null }>();
  return c.json({ verified: Boolean(u?.ob_verified_at) });
});
