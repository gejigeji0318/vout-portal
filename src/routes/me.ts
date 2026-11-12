import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { csrfTokenFor } from '../auth/session';
import { HttpError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { requireLogin } from '../middleware/auth';
import { getCurrentTournament, getMembership } from '../services/tournament';
import { saveImage, signedImageUrl, softDeleteImage } from '../services/imageStore';
import {
  displayNameKey, validateDisplayName, validateStreamUrls, validateText, validateTimePresets, validateXAccount,
} from '../lib/validate';

export const meRoutes = new Hono<AppEnv>();

interface UserRow {
  id: string; discord_name: string; display_name: string | null; bio: string | null; stream_urls: string | null;
  x_account: string | null; time_presets: string | null; admin_level: string; icon_image_id: string | null;
}

/**
 * 自分の情報。管理者の種別（全体／補助）は返さない（S-3-4）。管理者かどうかの真偽値だけ返す
 */
meRoutes.get('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ loggedIn: false });
  const u = await c.env.DB.prepare('SELECT id, discord_name, display_name, bio, stream_urls, x_account, time_presets, admin_level, icon_image_id FROM users WHERE id = ?')
    .bind(user.id)
    .first<UserRow>();
  if (!u) throw new HttpError(401, 'login_required');
  const tournament = await getCurrentTournament(c.env.DB);
  const m = tournament ? await getMembership(c.env.DB, tournament.id, user.id) : null;
  return c.json({
    loggedIn: true,
    csrfToken: await csrfTokenFor(c.env, user.sessionId),
    user: {
      id: u.id,
      displayName: u.display_name ?? u.discord_name,
      discordName: u.discord_name,
      bio: u.bio,
      streamUrls: u.stream_urls ? JSON.parse(u.stream_urls) : [],
      xAccount: u.x_account,
      iconUrl: await signedImageUrl(c.env, u.icon_image_id),
      timePresets: u.time_presets ? JSON.parse(u.time_presets) : [],
      isAdmin: u.admin_level !== 'none',
      membership: m ? { memberType: m.member_type, teamId: m.team_id, lane: m.lane } : null,
    },
  });
});

meRoutes.patch('/', requireLogin, async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body');
  const sets: string[] = [];
  const vals: unknown[] = [];

  if ('displayName' in body) {
    if (body.displayName === null || body.displayName === '') {
      sets.push('display_name = ?');
      vals.push(null); // Discord の名前に戻す
    } else {
      const name = validateDisplayName(body.displayName);
      await assertDisplayNameAvailable(c.env.DB, user.id, name);
      sets.push('display_name = ?');
      vals.push(name);
    }
  }
  if ('streamUrls' in body) {
    const urls = validateStreamUrls(body.streamUrls);
    sets.push('stream_urls = ?');
    vals.push(urls.length ? JSON.stringify(urls) : null);
  }
  if ('xAccount' in body) { sets.push('x_account = ?'); vals.push(validateXAccount(body.xAccount)); }
  if ('timePresets' in body) { sets.push('time_presets = ?'); vals.push(JSON.stringify(validateTimePresets(body.timePresets))); }
  if ('bio' in body) {
    // 紹介文は運営メンバー（管理者・補助スタッフ）だけ（F-04・F-13）
    if (!(await isStaffMember(c.env.DB, user.id, user.adminLevel))) throw new HttpError(403, 'forbidden', '紹介文を設定できるのは運営メンバーだけです');
    sets.push('bio = ?');
    vals.push(validateText(body.bio, 'bio', 300));
  }
  if (sets.length === 0) throw new HttpError(400, 'nothing_to_update');
  sets.push('updated_at = ?');
  vals.push(nowIso(), user.id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return c.json({ ok: true });
});

/** 運営メンバー（管理者・補助スタッフ）のアイコン（F-04・F-13） */
meRoutes.post('/icon', requireLogin, async (c) => {
  const user = c.get('user')!;
  if (!(await isStaffMember(c.env.DB, user.id, user.adminLevel))) throw new HttpError(403, 'forbidden', 'アイコンを設定できるのは運営メンバーだけです');
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > 6 * 1024 * 1024) throw new HttpError(422, 'image_too_large', '画像は 5MB までです');
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const file = (body as Record<string, unknown>).file;
  if (!(file instanceof File)) throw new HttpError(400, 'no_file', '画像を選んでください');
  const id = await saveImage(c.env, { ownerId: user.id, purpose: 'staff_icon', file });
  const prev = await c.env.DB.prepare('SELECT icon_image_id FROM users WHERE id = ?').bind(user.id).first<{ icon_image_id: string | null }>();
  await c.env.DB.prepare('UPDATE users SET icon_image_id = ?, updated_at = ? WHERE id = ?').bind(id, nowIso(), user.id).run();
  if (prev?.icon_image_id) await softDeleteImage(c.env.DB, prev.icon_image_id);
  return c.json({ ok: true, iconUrl: await signedImageUrl(c.env, id) });
});

meRoutes.delete('/icon', requireLogin, async (c) => {
  const user = c.get('user')!;
  const prev = await c.env.DB.prepare('SELECT icon_image_id FROM users WHERE id = ?').bind(user.id).first<{ icon_image_id: string | null }>();
  if (prev?.icon_image_id) {
    await c.env.DB.prepare('UPDATE users SET icon_image_id = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
    await softDeleteImage(c.env.DB, prev.icon_image_id);
  }
  return c.json({ ok: true });
});

async function isStaffMember(db: D1Database, userId: string, adminLevel: string): Promise<boolean> {
  if (adminLevel !== 'none') return true;
  const t = await getCurrentTournament(db);
  if (!t) return false;
  const m = await getMembership(db, t.id, userId);
  return m?.member_type === 'staff';
}

/** 表示名は、他の人の「実際に表示される名前」と重複させない */
async function assertDisplayNameAvailable(db: D1Database, userId: string, name: string): Promise<void> {
  const key = displayNameKey(name);
  const { results } = await db.prepare('SELECT id, display_name, discord_name FROM users WHERE id <> ?').bind(userId).all<{
    id: string; display_name: string | null; discord_name: string;
  }>();
  if (results.some((r) => displayNameKey(r.display_name ?? r.discord_name) === key)) {
    throw new HttpError(409, 'display_name_taken', 'その表示名はすでに使われています');
  }
}
