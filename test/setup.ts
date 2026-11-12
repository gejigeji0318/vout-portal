import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach } from 'vitest';
import { setClockForTest } from '../src/lib/time';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
afterEach(() => setClockForTest(null));
