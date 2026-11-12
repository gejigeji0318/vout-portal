import { defineConfig } from '@playwright/test';

export const BASE = 'http://localhost:8788';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  workers: 1, // 同じデータベースを使うので、1 つずつ順に実行する
  reporter: [['list']],
  use: { baseURL: BASE, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1366, height: 900 }, screenshot: 'only-on-failure' },
  webServer: { command: 'node e2e/server.mjs', url: BASE, reuseExistingServer: false, timeout: 180_000, cwd: '..' },
});
