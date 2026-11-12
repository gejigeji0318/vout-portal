import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../env';
import { fromBase64 } from '../lib/crypto';
import { HttpError } from '../lib/errors';

/**
 * 管理者 API の二重保護（S-1-3）：Cloudflare Access が付ける JWT を検証する。
 * 本番で設定が無い場合は「通さない」（設定漏れで素通りにしない）。
 */
export const requireCloudflareAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { ACCESS_AUD, ACCESS_TEAM_DOMAIN, ENVIRONMENT } = c.env;
  if (!ACCESS_AUD || !ACCESS_TEAM_DOMAIN) {
    if (ENVIRONMENT === 'production') throw new HttpError(403, 'access_not_configured', '管理者画面の保護が設定されていません');
    return next(); // 開発・テスト環境のみ省略
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token || !(await verifyAccessJwt(token, c.env))) throw new HttpError(403, 'access_denied', 'この画面を見る権限がありません');
  await next();
};

let certCache: { keys: JsonWebKey[]; at: number } | null = null;

async function getCerts(teamDomain: string): Promise<JsonWebKey[]> {
  if (certCache && Date.now() - certCache.at < 10 * 60 * 1000) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(403, 'access_denied');
  const { keys } = (await res.json()) as { keys: JsonWebKey[] };
  certCache = { keys, at: Date.now() };
  return keys;
}

const decodeJson = (part: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(fromBase64(part)));

export async function verifyAccessJwt(token: string, env: Pick<Env, 'ACCESS_AUD' | 'ACCESS_TEAM_DOMAIN'>): Promise<boolean> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    return false;
  }
  if (header.alg !== 'RS256') return false;
  const jwk = (await getCerts(env.ACCESS_TEAM_DOMAIN)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return false;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return aud.includes(env.ACCESS_AUD);
}
