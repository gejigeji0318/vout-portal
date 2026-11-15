import { Hono } from 'hono';
import type { AppEnv } from './env';
import { errorResponse } from './lib/errors';
import { csrfProtection, loadUser } from './middleware/auth';
import { securityHeaders } from './middleware/security';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { imgRoutes } from './routes/img';
import { pageRoutes } from './routes/pages';
import { announcementRoutes } from './routes/announcements';
import { laneRoutes } from './routes/lanes';
import { inquiryRoutes } from './routes/inquiries';
import { homeRoutes } from './routes/home';
import { applicationRoutes } from './routes/applications';
import { devRoutes } from './routes/dev';
import { draftRoutes } from './routes/draft';
import { scheduleRoutes } from './routes/schedule';
import { scrimRoutes } from './routes/scrims';
import { fillRoutes } from './routes/fill';
import { obVerifyRoutes } from './routes/obVerify';
import { teamRoutes } from './routes/team';
import { rosterRoutes } from './routes/roster';
import { previewRoutes } from './routes/preview';
import { dailyCleanup } from './services/cleanup';
import { postDueOb } from './services/fill';
export { DraftRoom } from './draft/room';
import { syncLanes } from './services/lanes';
import { announceDue } from './services/publishing';
import type { Env } from './env';

export const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.use('*', loadUser);
app.use('/api/*', csrfProtection);
app.use('/auth/logout', csrfProtection);
app.use('/auth/logout-all', csrfProtection);

app.route('/auth', authRoutes);
app.route('/auth', obVerifyRoutes);
app.route('/api/me', meRoutes);
app.route('/img', imgRoutes);
app.route('/api/pages', pageRoutes);
app.route('/api/announcements', announcementRoutes);
app.route('/api/lanes', laneRoutes);
app.route('/api/inquiries', inquiryRoutes);
app.route('/api/home', homeRoutes);
app.route('/api', applicationRoutes);
app.route('/api/dev', devRoutes);
app.route('/api/draft', draftRoutes);
app.route('/api/schedule', scheduleRoutes);
app.route('/api/scrims', scrimRoutes);
app.route('/api/fill', fillRoutes);
app.route('/api/team', teamRoutes);
app.route('/api/roster', rosterRoutes);
app.route('/api/preview', previewRoutes);
app.route('/api/admin', adminRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => errorResponse(c, err));

/** 定期処理（Cron Triggers）。5 分ごと：予約公開・OB への補充募集／毎日 7:00 JST：適性レーンの取り込みと、期限を過ぎたデータの削除 */
export async function scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  if (event.cron === '0 22 * * *') ctx.waitUntil(Promise.all([syncLanes(env, null), dailyCleanup(env)]));
  else ctx.waitUntil(Promise.all([announceDue(env), postDueOb(env)]));
}

export default { fetch: app.fetch, scheduled };
