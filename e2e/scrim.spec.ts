import './no-page-errors';
import { expect, test } from '@playwright/test';
import { asPersona, expectSuccess } from './helpers';

test('予定表とスクリム：予定表を確認 → 候補から申請 → 相手のコーチが確定 → 選手は確定してから見える', async ({ browser }) => {
  const admin = await asPersona(browser, 'super');
  expect((await admin.api('POST', '/api/dev/seed-scrim')).status).toBe(200);
  const a = await asPersona(browser, 'coach-a');
  const b = await asPersona(browser, 'coach-b');
  const player = await asPersona(browser, 'player-a-mid');

  // 予定表：チームごとの「同時にそろう人数」が出る
  await a.page.goto('/schedule');
  await expect(a.page.getByRole('heading', { name: '予定表' })).toBeVisible();
  await expect(a.page.getByText('チームごとの空き状況')).toBeVisible();
  await expect(a.page.getByText(/\d 人/).first()).toBeVisible();

  // まとめて入力：日付のチェックボックスで選び、○ を一括で入れて保存できる
  const boxes = a.page.getByRole('checkbox', { name: /を選ぶ$/ });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await boxes.nth(1).uncheck();
  await boxes.nth(2).check();
  await a.page.getByRole('button', { name: '選んだ 2 日に入れる' }).click();
  await a.page.getByRole('button', { name: /日分を保存/ }).click();
  await expectSuccess(a.page, a.page.getByText(/^保存しました/), '予定表の保存');

  // 申請：相手を選ぶと、両チームがそろう日程が提示される
  await a.page.goto('/scrims');
  await a.page.getByRole('button', { name: 'スクリムを申請' }).click();
  await a.page.getByRole('combobox', { name: '相手チーム' }).click();
  await a.page.getByRole('option', { name: 'チーム 2' }).click();
  const firstSuggestion = a.page.getByRole('checkbox', { name: /自チーム \d 人・相手 \d 人/ }).first();
  await firstSuggestion.check();
  await a.page.getByRole('button', { name: '申請する' }).click();
  await expectSuccess(a.page, a.page.locator('.mantine-Badge-label', { hasText: /^申請中$/ }), 'スクリムの申請');

  // 選手には、確定するまで見えない（他のテストで確定したスクリムがあってもよいように、件数で比べる）
  await player.page.goto('/scrims');
  await expect(player.page.getByRole('heading', { name: '確定' })).toBeVisible();
  const before = await player.page.getByText('チーム 1 vs チーム 2').count();

  // 相手のコーチが確定
  await b.page.goto('/scrims');
  const confirmedBefore = await b.page.locator('.mantine-Badge-label', { hasText: /^確定$/ }).count();
  await b.page.getByRole('button', { name: 'この日時で確定' }).first().click();
  await expectSuccess(b.page, b.page.locator('.mantine-Badge-label', { hasText: /^確定$/ }).nth(confirmedBefore), 'スクリムの確定');

  await player.page.reload();
  await expect(player.page.getByText('チーム 1 vs チーム 2')).toHaveCount(before + 1);
  await expect(player.page.locator('.mantine-Badge-label', { hasText: /^確定$/ }).first()).toBeVisible();
});
