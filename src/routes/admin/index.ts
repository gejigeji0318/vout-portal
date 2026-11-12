import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { requireCloudflareAccess } from '../../middleware/access';
import { requireAdmin } from '../../middleware/auth';
import { tournamentAdmin } from './tournament';
import { usersAdmin } from './users';
import { systemAdmin } from './system';
import { contentAdmin } from './content';
import { inquiriesAdmin } from './inquiries';
import { lanesAdmin } from './lanes';
import { selectionAdmin } from './selection';

/** 管理者 API。Cloudflare Access ＋ 管理者のセッションの二重で守る（S-1-3） */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireCloudflareAccess, requireAdmin('sub'));

/** 管理者画面だけで使う：自分の管理者の種別 */
adminRoutes.get('/me', (c) => c.json({ adminLevel: c.get('user')!.adminLevel }));
adminRoutes.route('/', tournamentAdmin);
adminRoutes.route('/', usersAdmin);
adminRoutes.route('/', systemAdmin);
adminRoutes.route('/', contentAdmin);
adminRoutes.route('/', inquiriesAdmin);
adminRoutes.route('/', lanesAdmin);
adminRoutes.route('/', selectionAdmin);
