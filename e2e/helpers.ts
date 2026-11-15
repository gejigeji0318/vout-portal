import { type APIRequestContext, type Browser, expect, type Locator, type Page } from '@playwright/test';
import { BASE } from './playwright.config';

/** 画面で起きた JavaScript のエラー */
export const pageErrors: string[] = [];

/** 開発用の立場の切り替えで、その立場のテスト用アカウントとしてログインしたブラウザを作る */
export async function asPersona(browser: Browser, persona: string) {
  const context = await browser.newContext();
  const r = await context.request.post('/api/dev/login-as', { data: { persona }, headers: { Origin: BASE } });
  expect(r.ok(), `${persona} でログインできない`).toBeTruthy();
  const page = await context.newPage();
  // 画面で JavaScript のエラーが起きたら記録する（テストの最後に、1 件もないことを確かめる）
  page.on('pageerror', (e) => pageErrors.push(`${persona}: ${e.message}`));
  return { context, page, api: (method: string, path: string, data?: unknown) => call(context.request, method, path, data) };
}

/** CSRF トークンを付けて API を呼ぶ */
export async function call(request: APIRequestContext, method: string, path: string, data?: unknown) {
  const me = await (await request.get('/api/me')).json();
  const res = await request.fetch(path, { method, data, headers: { Origin: BASE, 'X-CSRF-Token': me.csrfToken ?? '' } });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/**
 * 操作のあと、「成功したときに出るもの」か「赤いエラーの通知」のどちらかが出るまで待つ。
 * エラーだったときは、通知に書かれた理由をそのままテストの失敗メッセージにする（原因がすぐ分かるように）
 */
export async function expectSuccess(page: Page, success: Locator, what: string) {
  const error = page.locator('.mantine-Notification-root').filter({ hasText: /できませんでした|送れませんでした|保存できませんでした/ });
  await expect(success.or(error).first(), `${what}の結果が画面に出ない`).toBeVisible();
  if (await error.count()) throw new Error(`${what}でエラーになりました：${(await error.first().innerText()).replace(/\s+/g, ' ')}`);
}
