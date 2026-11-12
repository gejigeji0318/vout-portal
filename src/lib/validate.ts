import { HttpError } from './errors';

const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/;

/** 表示名に使えない言葉（運営メンバーと紛らわしい名前） */
const RESERVED = ['運営', 'うんえい', '管理者', 'かんりしゃ', 'admin', 'staff', 'moderator', 'official', '公式', 'system'];

const normalize = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

export function validateDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(422, 'invalid_display_name', '表示名を入力してください');
  const name = raw.normalize('NFKC').trim();
  if (name.length < 1 || name.length > 20) throw new HttpError(422, 'invalid_display_name', '表示名は 1〜20 文字です');
  if (CONTROL.test(name)) throw new HttpError(422, 'invalid_display_name', '使えない文字が含まれています');
  const n = normalize(name);
  if (RESERVED.some((w) => n.includes(normalize(w)))) {
    throw new HttpError(422, 'reserved_display_name', '運営メンバーと紛らわしい名前は使えません');
  }
  return name;
}

/** 表示名の重複チェック用に、比較用の形にそろえる */
export const displayNameKey = (s: string): string => normalize(s);

export function validateText(raw: unknown, field: string, max: number, required = false): string | null {
  if (raw === null || raw === undefined || raw === '') {
    if (required) throw new HttpError(422, `invalid_${field}`, `${field} を入力してください`);
    return null;
  }
  if (typeof raw !== 'string') throw new HttpError(422, `invalid_${field}`);
  const v = raw.trim();
  if (v.length > max) throw new HttpError(422, `invalid_${field}`, `${max} 文字以内で入力してください`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) throw new HttpError(422, `invalid_${field}`);
  if (required && v.length === 0) throw new HttpError(422, `invalid_${field}`);
  return v;
}

/** https の URL で、許可したドメイン（またはそのサブドメイン）のものだけを受け付ける */
export function validateHttpsUrl(raw: unknown, field: string, allowedHosts?: string[]): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 300) throw new HttpError(422, `invalid_${field}`);
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(422, `invalid_${field}`, 'URL の形式が正しくありません');
  }
  if (u.protocol !== 'https:') throw new HttpError(422, `invalid_${field}`, 'https の URL のみ使えます');
  if (u.username || u.password) throw new HttpError(422, `invalid_${field}`);
  if (allowedHosts) {
    const host = u.hostname.toLowerCase();
    const ok = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new HttpError(422, `invalid_${field}`, '対応していないサイトの URL です');
  }
  return u.toString();
}

/** 配信 URL（最大 3 件、重複は 1 つにまとめる） */
export function validateStreamUrls(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(422, 'invalid_stream_urls');
  const urls = raw.map((u, i) => {
    try { return validateHttpsUrl(u, 'stream_url', STREAM_HOSTS); } catch (e) {
      throw new HttpError(422, 'invalid_stream_url', `配信 URL（${i + 1} つ目）：${e instanceof HttpError && e.message !== 'invalid_stream_url' ? e.message : '形式が正しくありません'}`);
    }
  }).filter((u): u is string => Boolean(u));
  const unique = [...new Set(urls)];
  if (unique.length > 3) throw new HttpError(422, 'invalid_stream_urls', '配信 URL は 3 件までです');
  return unique;
}

export const STREAM_HOSTS = ['twitch.tv', 'youtube.com', 'youtu.be', 'twitcasting.tv', 'openrec.tv', 'kick.com', 'nicovideo.jp'];

export function validateXAccount(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(422, 'invalid_x_account');
  const v = raw.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(v)) throw new HttpError(422, 'invalid_x_account', 'X のユーザー名の形式が正しくありません');
  return v;
}

const HHMM = /^(?:[01]\d|2[0-4]):(?:00|30)$/;

export interface TimePreset { label: string; start: string; end: string }

/** よく使う時間（30 分刻み、5 件まで） */
export function validateTimePresets(raw: unknown): TimePreset[] {
  if (!Array.isArray(raw)) throw new HttpError(422, 'invalid_time_presets');
  if (raw.length > 5) throw new HttpError(422, 'invalid_time_presets', 'よく使う時間は 5 件までです');
  return raw.map((p) => {
    if (typeof p !== 'object' || p === null) throw new HttpError(422, 'invalid_time_presets');
    const { label, start, end } = p as Record<string, unknown>;
    const l = validateText(label, 'label', 10, true)!;
    if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end) || start === '24:00') {
      throw new HttpError(422, 'invalid_time_presets', '時間は 30 分刻みで入力してください');
    }
    if (start >= end) throw new HttpError(422, 'invalid_time_presets', '終了は開始より後にしてください');
    return { label: l, start, end };
  });
}

export function validateIsoDate(raw: unknown, field: string, required = false): string | null {
  if (raw === null || raw === undefined || raw === '') {
    if (required) throw new HttpError(422, `invalid_${field}`);
    return null;
  }
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) throw new HttpError(422, `invalid_${field}`);
  return new Date(raw).toISOString();
}

export const LANES = ['TOP', 'JG', 'MID', 'BOT', 'SUP'] as const;
export type Lane = (typeof LANES)[number];
export const isLane = (v: unknown): v is Lane => typeof v === 'string' && (LANES as readonly string[]).includes(v);
