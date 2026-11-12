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
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
