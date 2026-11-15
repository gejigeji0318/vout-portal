import type { Env, MemberType } from '../env';
import { fromBase64, hmacHex, safeEqual, toBase64Url } from '../lib/crypto';
import { now } from '../lib/time';

/**
 * 管理者の「見るだけのプレビュー」：選んだ立場として画面を見る。
 * Cookie は署名つきで、その管理者のセッションにだけ結びつき、1 時間で切れる（他人のセッションでは使えない）
 */
export const PREVIEW_COOKIE = '__Host-preview';
export const PREVIEW_TTL_MS = 60 * 60 * 1000;
interface Payload { sid: string; memberType: MemberType | null; teamId: string | null; exp: number }

export async function makePreview(env: Env, sessionId: string, memberType: MemberType | null, teamId: string | null): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify({ sid: sessionId, memberType, teamId, exp: now().getTime() + PREVIEW_TTL_MS } satisfies Payload)));
  return `${body}.${await hmacHex(`preview:${body}`, env.SIGNING_KEY)}`;
}

export async function readPreview(env: Env, sessionId: string, cookie: string | undefined): Promise<{ memberType: MemberType | null; teamId: string | null } | null> {
  if (!cookie) return null;
  const [body, sig] = cookie.split('.');
  if (!body || !sig || !safeEqual(await hmacHex(`preview:${body}`, env.SIGNING_KEY), sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64(body))) as Payload;
    if (p.sid !== sessionId || p.exp < now().getTime()) return null;
    return { memberType: p.memberType, teamId: p.teamId };
  } catch { return null; }
}
