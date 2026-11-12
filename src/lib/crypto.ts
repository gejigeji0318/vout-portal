const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const b = atob(norm + '==='.slice((norm.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** 推測できないランダムな値（セッション、state、PKCE など） */
export const randomToken = (bytes = 32): string => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE の code_challenge（S256） */
export async function pkceChallenge(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return toBase64Url(new Uint8Array(buf));
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyB64);
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-GCM で暗号化。保存形式は「iv.暗号文」（どちらも base64url） */
export async function encrypt(plain: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plain));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function decrypt(stored: string, keyB64: string): Promise<string> {
  const [ivS, ctS] = stored.split('.');
  if (!ivS || !ctS) throw new Error('malformed ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivS) }, await aesKey(keyB64), fromBase64(ctS));
  return dec.decode(pt);
}

/** HMAC-SHA256（CSRF トークンの署名に使う） */
export async function hmacHex(message: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 比較にかかる時間を一定にする */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
