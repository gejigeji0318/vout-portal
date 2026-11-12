import type { Context } from 'hono';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

export class HttpError extends Error {
  constructor(public status: ErrorStatus, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** エラーの応答。内部情報（スタックトレース、SQL）は返さない（S-5-4） */
export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  console.error('unexpected error', err instanceof Error ? err.message : err);
  return c.json({ error: 'internal_error', message: 'エラーが発生しました' }, 500);
}
