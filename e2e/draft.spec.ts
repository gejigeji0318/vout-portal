import { expect, type Page, test } from '@playwright/test';
import { asPersona } from './helpers';

/** その選手を選んで「決定」する */
async function pick(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^.?${name}（テスト）`) }).click();
  await page.getByRole('button', { name: '決定', exact: true }).click();
  await expect(page.getByRole('button', { name: '決定済み' })).toBeVisible();
}

test('ドラフト 1 回分：同時に指名 → 被り → ルーレット → 自由選択 → 5 ラウンド → 配信用画面 → 結果の確定', async ({ browser }) => {
  const admin = await asPersona(browser, 'super');
  expect((await admin.api('POST', '/api/dev/seed-draft')).status).toBe(200);
  const a = await asPersona(browser, 'coach-a');
  const b = await asPersona(browser, 'coach-b');

  // 参加受付 → 両チームが参加 → 開始
  await admin.page.goto('/admin/draft');
  await admin.page.getByRole('button', { name: '参加受付を開始' }).click();
  for (const c of [a, b]) {
    await c.page.goto('/draft');
    await c.page.getByRole('button', { name: '参加する' }).click();
    await expect(c.page.getByText('参加しました')).toBeVisible();
  }
  await expect(admin.page.getByText('2チーム中2チームが参加済み')).toBeVisible();
  await admin.page.getByRole('button', { name: 'ドラフト開始' }).click();

  // ラウンド 1：両チームが同じ選手を指名（被り）。運営の画面には「確定済み」しか出ず、選手名は出ない
  await pick(a.page, 'TOP1');
  await pick(b.page, 'TOP1');
  await expect(admin.page.getByText('2チーム中2チームが確定済み')).toBeVisible();
  await expect(admin.page.locator('.cells')).not.toContainText('TOP1');
  await admin.page.getByRole('button', { name: '公開' }).click();
  await expect(admin.page.getByText('被りが1件あります')).toBeVisible();
  await admin.page.getByRole('button', { name: 'ルーレット開始' }).click();
  await admin.page.getByRole('button', { name: '次へ' }).click({ timeout: 20_000 }); // 演出が終わると押せる

  // 外れたチームは自由選択。決定はすぐ相手の画面にも出る
  await expect.poll(async () => (await a.page.getByText('残りの選手から自由に選んでください').count()) + (await b.page.getByText('残りの選手から自由に選んでください').count())).toBe(1);
  const aLost = (await a.page.getByText('残りの選手から自由に選んでください').count()) === 1;
  const [winner, loser] = aLost ? [b, a] : [a, b];
  await pick(loser.page, 'JG1');
  await expect(winner.page.getByText('確定待ち')).toBeVisible();
  await admin.page.getByRole('button', { name: '確定', exact: true }).click();
  await admin.page.getByRole('button', { name: '次のラウンドへ' }).click();

  // ラウンド 2〜5：被りなし
  const plan: [string, string][] = [['JG2', 'TOP2'], ['MID1', 'MID2'], ['BOT1', 'BOT2'], ['SUP1', 'SUP2']];
  for (const [i, [w, l]] of plan.entries()) {
    await pick(winner.page, w);
    await pick(loser.page, l);
    await admin.page.getByRole('button', { name: '公開' }).click();
    await admin.page.getByRole('button', { name: i === plan.length - 1 ? '最終結果を表示' : '次のラウンドへ' }).click();
  }
  for (const c of [a, b]) await expect(c.page.getByRole('heading', { name: '最終結果' })).toBeVisible();

  // 配信用画面（ログインなし）にも最終結果が出る
  await admin.page.getByRole('button', { name: '配信用 URL' }).click();
  const url = (await admin.page.locator('.stream-url').textContent())!;
  const viewer = await browser.newContext();
  const stream = await viewer.newPage();
  await stream.goto(url);
  await expect(stream.getByRole('heading', { name: '最終結果' })).toBeVisible();
  await admin.page.getByRole('button', { name: '閉じる' }).click();

  // 結果を確定 → チームに振り分け
  await admin.page.getByRole('button', { name: '結果を確定' }).click();
  await admin.page.getByRole('button', { name: '確定する' }).click();
  await expect(admin.page.getByText('チームへの振り分けを確定しました')).toBeVisible();
});

test('ドラフトの画面は、選手には見られない。配信用 URL の鍵が違うと見られない', async ({ browser }) => {
  const player = await asPersona(browser, 'player-a-mid');
  await player.page.goto('/draft');
  await expect(player.page.getByText('ドラフトの画面は、コーチと運営だけが見られます')).toBeVisible();
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto('/draft/stream#key=wrong-key');
  await expect(viewer.getByText('配信用 URL が正しくないか、期限が切れています')).toBeVisible();
});
