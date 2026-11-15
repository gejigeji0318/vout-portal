import './no-page-errors';
import { expect, test } from '@playwright/test';
import { asPersona, expectSuccess } from './helpers';

/** 日本時間で今日から n 日後の 21:00〜23:00 */
const slot = (n: number) => {
  const day = new Date(Date.now() + 9 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
  return { startsAt: new Date(`${day}T21:00:00+09:00`).toISOString(), endsAt: new Date(`${day}T23:00:00+09:00`).toISOString() };
};

test('人員補充：確定したスクリムから募集 → 運営スタッフが応募 → コーチが決定 → 本人に「決定」と出る', async ({ browser }) => {
  const admin = await asPersona(browser, 'super');
  expect((await admin.api('POST', '/api/dev/seed-scrim')).status).toBe(200);
  const a = await asPersona(browser, 'coach-a');
  const b = await asPersona(browser, 'coach-b');
  const staff = await asPersona(browser, 'staff');

  // 前提：チーム 1 とチーム 2 のスクリムが確定している（API で用意）
  const teams = (await a.api('GET', '/api/schedule')).body.teams as { id: string; isMine: boolean }[];
  const other = teams.find((t) => !t.isMine)!.id;
  const { body } = await a.api('POST', '/api/scrims', { opponentTeamId: other, format: 'BO1', candidates: [slot(4)] });
  const cand = (await b.api('GET', '/api/scrims')).body.scrims.find((s: { id: string }) => s.id === body.id).candidates[0];
  expect((await b.api('POST', `/api/scrims/${body.id}/confirm`, { candidateId: cand.id })).status).toBe(200);

  // コーチが画面から募集を出す
  await a.page.goto('/scrims');
  await a.page.getByRole('button', { name: '人員補充を募集' }).first().click();
  await a.page.getByRole('button', { name: 'MID', exact: true }).click();
  await a.page.getByRole('button', { name: '募集する' }).click();
  await expectSuccess(a.page, a.page.getByText('補充の募集を出しました'), '補充の募集');
  await a.page.goto('/fill');
  await expect(a.page.getByText('募集中').first()).toBeVisible();

  // 運営スタッフが応募する
  await staff.page.goto('/fill');
  await staff.page.getByRole('button', { name: '応募する' }).first().click();
  await expectSuccess(staff.page, staff.page.locator('.mantine-Badge-label', { hasText: /^応募中$/ }).first(), '補充への応募');

  // コーチが決定する
  await a.page.reload();
  await a.page.getByRole('button', { name: 'この人で決定' }).click();
  await expectSuccess(a.page, a.page.getByText(/^決定：/).first(), '補充の決定');

  await staff.page.reload();
  await expect(staff.page.getByText(/決定/).first()).toBeVisible();
});

test('大会に参加していない人には、OB の確認の案内が出る', async ({ browser }) => {
  const viewer = await asPersona(browser, 'viewer');
  await viewer.page.goto('/fill');
  await expect(viewer.page.getByRole('link', { name: 'Discord で OB の確認をする' })).toBeVisible();
});
