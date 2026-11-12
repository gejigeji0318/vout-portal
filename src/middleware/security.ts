import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';

/** セキュリティヘッダー（S-4-1〜S-4-3） */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  // WebSocket の接続（101）の応答は変更できないので、そのまま通す（ページの中身は含まれない）
  if (c.res.status === 101) return;
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 個別に厳しい設定をした応答（画像など）はそのまま残す
  if (!h.has('Content-Security-Policy')) h.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (c.env.ENVIRONMENT === 'production') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/')) h.set('Cache-Control', 'no-store');
};
