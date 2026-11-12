import { type APIRequestContext, type Browser, expect } from '@playwright/test';
import { BASE } from './playwright.config';

/** 開発用の立場の切り替えで、その立場のテスト用アカウントとしてログインしたブラウザを作る */
export async function asPersona(browser: Browser, persona: string) {
  const context = await browser.newContext();
  const r = await context.request.post('/api/dev/login-as', { data: { persona }, headers: { Origin: BASE } });
  expect(r.ok(), `${persona} でログインできない`).toBeTruthy();
  return { context, page: await context.newPage(), api: (method: string, path: string, data?: unknown) => call(context.request, method, path, data) };
}

/** CSRF トークンを付けて API を呼ぶ */
export async function call(request: APIRequestContext, method: string, path: string, data?: unknown) {
  const me = await (await request.get('/api/me')).json();
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE, 'X-CSRF-Token': me.csrfToken ?? '' } });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}
