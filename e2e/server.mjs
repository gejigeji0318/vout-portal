// 画面の通しテスト用のサーバー。毎回まっさらなデータベースで起動する（npm run dev のデータには触れない）
import { execSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const persist = '.wrangler/e2e';
rmSync(persist, { recursive: true, force: true });
const env = { ...process.env, CI: 'true' };
execSync(`npx wrangler d1 migrations apply portal-db --local --persist-to ${persist}`, { stdio: 'pipe', env });
// テスト専用の鍵（あなたの .dev.vars の値は使わない）
const vars = {
  APP_ORIGIN: 'http://localhost:8788', ENVIRONMENT: 'development', DISCORD_CLIENT_SECRET: 'e2e',
  ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', SIGNING_KEY: 'e2e-signing-key-not-for-production',
};
const args = ['wrangler', 'dev', '--port', '8788', '--persist-to', persist, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
const child = spawn('npx', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
