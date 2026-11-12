// ULID（時刻 48bit ＋ 乱数 80bit を Crockford Base32 で 26 文字）。推測できない ID として使う
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(time: number = Date.now()): string {
  let t = time;
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let randPart = '';
  for (let i = 0; i < 16; i++) randPart += ALPHABET[bytes[i]! % 32];
  return timePart + randPart;
}

export const isUlid = (s: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
