import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            APP_ORIGIN: 'http://localhost:8787',
            DISCORD_CLIENT_ID: 'test-client-id',
            DISCORD_CLIENT_SECRET: 'test-client-secret',
            DISCORD_BOT_TOKEN: 'test-bot-token-SECRET',
            DISCORD_GUILD_ID: '800000000000000000',
            // テスト専用の鍵（本番の鍵は wrangler secret で別に登録する）
            ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            SIGNING_KEY: 'test-signing-key-not-for-production',
            LANES_DATA_URL: 'https://example.github.io/championLane/data.json',
            ACCESS_TEAM_DOMAIN: '',
            ACCESS_AUD: '',
          },
        },
      }),
    ],
    // テストのファイルは 1 つずつ順に実行する（同じテスト用 DB を使うため、並行すると「開催中の大会」が入れ替わってしまう）
    test: {
      setupFiles: ['./test/setup.ts'],
      fileParallelism: false,
      // サーバー側のテストだけ（e2e/ は画面の通しテスト。Playwright で動かす）
      include: ['test/**/*.test.ts'],
    },
  };
});
