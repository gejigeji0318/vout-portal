import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { isUlid, ulid } from '../src/lib/id';
import { decrypt, encrypt } from '../src/lib/crypto';
import { HttpError } from '../src/lib/errors';
import { csrfTokenFor, verifyCsrf } from '../src/auth/session';
import {
  displayNameKey, STREAM_HOSTS, validateDisplayName, validateHttpsUrl, validateTimePresets, validateXAccount,
} from '../src/lib/validate';

const code = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof HttpError ? e.code : 'other'; }
};

describe('ID（ULID）', () => {
  it('26 文字で重複しない', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isUlid(id)).toBe(true);
  });
});

describe('表示名', () => {
  it('前後の空白を除いて受け付ける', () => expect(validateDisplayName('  たろう ')).toBe('たろう'));
  it('空・21 文字以上は拒否', () => {
    expect(code(() => validateDisplayName(''))).toBe('invalid_display_name');
    expect(code(() => validateDisplayName('あ'.repeat(21)))).toBe('invalid_display_name');
  });
  it('運営と紛らわしい名前は拒否（全角・大文字・空白の違いも同じとみなす）', () => {
    for (const n of ['運営', 'ポータル運営', 'ADMIN', 'Ａｄｍｉｎ', 's t a f f', '公式アカウント']) {
      expect(code(() => validateDisplayName(n))).toBe('reserved_display_name');
    }
  });
  it('見えない制御文字は拒否', () => expect(code(() => validateDisplayName('たろ\u200Bう'))).toBe('invalid_display_name'));
  it('重複チェック用の形は全角・半角・大文字小文字の違いをそろえる', () => {
    expect(displayNameKey('Ｔａｒｏ')).toBe(displayNameKey('taro'));
  });
});

describe('URL・X アカウント', () => {
  it('配信 URL は https かつ許可したサイトのみ', () => {
    expect(validateHttpsUrl('https://www.twitch.tv/abc', 'u', STREAM_HOSTS)).toBe('https://www.twitch.tv/abc');
    expect(code(() => validateHttpsUrl('http://www.twitch.tv/abc', 'u', STREAM_HOSTS))).toBe('invalid_u');
    expect(code(() => validateHttpsUrl('https://twitch.tv.evil.example/abc', 'u', STREAM_HOSTS))).toBe('invalid_u');
    expect(code(() => validateHttpsUrl('javascript:alert(1)', 'u', STREAM_HOSTS))).toBe('invalid_u');
    expect(code(() => validateHttpsUrl('https://user:pass@twitch.tv/', 'u', STREAM_HOSTS))).toBe('invalid_u');
  });
  it('X のユーザー名', () => {
    expect(validateXAccount('@abc_123')).toBe('abc_123');
    expect(code(() => validateXAccount('abc-123'))).toBe('invalid_x_account');
    expect(code(() => validateXAccount('a'.repeat(16)))).toBe('invalid_x_account');
  });
});

describe('よく使う時間', () => {
  it('30 分刻み・5 件まで', () => {
    expect(validateTimePresets([{ label: '平日夜', start: '20:00', end: '24:00' }])).toHaveLength(1);
    expect(code(() => validateTimePresets([{ label: 'x', start: '20:15', end: '22:00' }]))).toBe('invalid_time_presets');
    expect(code(() => validateTimePresets([{ label: 'x', start: '22:00', end: '20:00' }]))).toBe('invalid_time_presets');
    expect(code(() => validateTimePresets(Array(6).fill({ label: 'x', start: '20:00', end: '21:00' })))).toBe('invalid_time_presets');
  });
});

describe('暗号化・CSRF トークン', () => {
  it('暗号化して元に戻せる。暗号文に元の文字列は含まれない', async () => {
    const secret = 'https://discord.com/api/webhooks/1/abc';
    const c = await encrypt(secret, env.ENCRYPTION_KEY);
    expect(c).not.toContain('discord');
    expect(await decrypt(c, env.ENCRYPTION_KEY)).toBe(secret);
  });
  it('CSRF トークンはセッションごとに違い、他のセッションのものは通らない', async () => {
    const a = await csrfTokenFor(env, 'session-a');
    expect(await verifyCsrf(env, 'session-a', a)).toBe(true);
    expect(await verifyCsrf(env, 'session-b', a)).toBe(false);
    expect(await verifyCsrf(env, 'session-a', undefined)).toBe(false);
  });
});
