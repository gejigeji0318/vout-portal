// サーバーとのやり取り。状態を変える操作には CSRF トークンを付ける
let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? '処理できませんでした。時間をおいてもう一度お試しください'));
  }
  return data as T;
}

/** 画像などのファイルを送る（CSRF トークン付き） */
export async function apiUpload<T = unknown>(path: string, file: Blob, filename: string): Promise<T> {
  const fd = new FormData();
  fd.append('file', file, filename);
  const res = await fetch(path, { method: 'POST', body: fd, headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {}, credentials: 'same-origin' });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? 'アップロードできませんでした'));
  return data as T;
}

export interface Me {
  loggedIn: boolean;
  csrfToken?: string;
  user?: {
    id: string; displayName: string; discordName: string; bio: string | null; streamUrls: string[]; xAccount: string | null; iconUrl: string | null;
    timePresets: { label: string; start: string; end: string }[];
    isAdmin: boolean;
    membership: { memberType: 'player' | 'coach' | 'staff'; teamId: string | null; lane: string | null } | null;
  };
}
