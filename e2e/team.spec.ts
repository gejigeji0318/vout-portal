import './no-page-errors';
import { expect, test } from '@playwright/test';
import { asPersona } from './helpers';

test('チームページ：選手が投稿 → コーチがリアクション（誰が付けたか見える）→ 他のチームの選手には見えない', async ({ browser }) => {
  const admin = await asPersona(browser, 'super');
  expect((await admin.api('POST', '/api/dev/seed-scrim')).status).toBe(200);
  const player = await asPersona(browser, 'player-a-mid');
  const coach = await asPersona(browser, 'coach-a');
  const other = await asPersona(browser, 'player-b-mid');
  const text = `今日の振り返り ${Date.now()}`;

  await player.page.goto('/team');
  await player.page.getByRole('textbox', { name: '投稿する内容' }).fill(text);
  await player.page.getByRole('button', { name: '投稿' }).click();
  await expect(player.page.getByText(text)).toBeVisible();

  // まず、コーチの画面に同じチームの投稿が出ていることを確かめる（出ていなければ、ここで分かりやすく止まる）
  await coach.page.goto('/team');
  await expect(coach.page.getByText(text), 'コーチの画面に、同じチームの選手の投稿が表示されていない').toBeVisible();
  // その投稿の枠の中の「リアクションを付ける」を押す
  const card = coach.page.locator('.mantine-Card-root').filter({ hasText: text });
  await card.getByRole('button', { name: 'リアクションを付ける' }).click();
  await coach.page.getByRole('button', { name: '🔥 を付ける' }).click();
  await expect(coach.page.getByRole('button', { name: /🔥 1（コーチ（チーム1）（テスト））/ })).toBeVisible();

  await other.page.goto('/team');
  await expect(other.page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(other.page.getByText(text)).toHaveCount(0);
});
