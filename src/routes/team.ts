import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { addMs, DAY, now, nowIso } from '../lib/time';
import { validateText } from '../lib/validate';
import { getViewer } from '../services/audience';
import { writeAudit } from '../services/audit';
import { saveImage, signedImageUrl } from '../services/imageStore';
import { teamNames } from '../services/teams';

/**
 * チームページ（F-08）：見られるのは、そのチームの選手とコーチ（と管理者）だけ。他のチームのページは見られない
 *  - ページの追加・名前の変更・削除はコーチ。削除したページは 30 日以内なら元に戻せる
 *  - 投稿は新しい順。画像は 4 枚まで。削除した投稿は 10 日後に消える
 *  - リアクションは決められた絵文字だけ。誰が付けたか見られる
 *  - チーム名はコーチが決める。スクリム期間に入ったら変えられない（誤りの修正は管理者が管理者画面で行う）
 */
export const teamRoutes = new Hono<AppEnv>();
export const EMOJIS = ['👍', '👀', '🔥', '😂', '🙏', '✅'];
const PAGE_RESTORE_DAYS = 30;

async function ctx(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user']; req: { query: (k: string) => string | undefined } }) {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!v.user) throw new HttpError(401, 'login_required', 'ログインが必要です');
  if (!v.tournament) throw new HttpError(404, 'no_tournament');
  const teamId = v.isAdmin ? c.req.query('teamId') ?? null : (v.memberType === 'player' || v.memberType === 'coach') ? v.teamId : null;
  if (!teamId) throw new HttpError(403, 'forbidden', v.isAdmin ? 'チームを選んでください' : 'チームページは、そのチームの選手とコーチだけが見られます');
  const team = await c.env.DB.prepare('SELECT id, name FROM teams WHERE id = ? AND tournament_id = ? AND deleted_at IS NULL').bind(teamId, v.tournament.id).first<{ id: string; name: string | null }>();
  if (!team) throw new HttpError(404, 'not_found');
  return { v, user: v.user, tournament: v.tournament, team, isCoach: v.memberType === 'coach' || v.isAdmin };
}

/** そのページがこのチームのものか（他のチームのページは「存在しない」扱い） */
async function ownPage(db: D1Database, pageId: string, teamId: string, includeDeleted = false) {
  const p = await db.prepare(`SELECT * FROM team_pages WHERE id = ? AND team_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).bind(pageId, teamId).first<{ id: string; deleted_at: string | null }>();
  if (!p) throw new HttpError(404, 'not_found', 'ページが見つかりません');
  return p;
}

teamRoutes.get('/', async (c) => {
  const x = await ctx(c);
  let { results: pages } = await c.env.DB.prepare('SELECT id, title, deleted_at FROM team_pages WHERE team_id = ? ORDER BY sort_order, created_at').bind(x.team.id).all<{ id: string; title: string; deleted_at: string | null }>();
  if (!pages.some((p) => !p.deleted_at)) {
    // 最初に開いたときに「全体」のページを作る
    const t = nowIso();
    await c.env.DB.prepare('INSERT INTO team_pages (id, team_id, title, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(ulid(), x.team.id, '全体', x.user.id, t, t).run();
    pages = (await c.env.DB.prepare('SELECT id, title, deleted_at FROM team_pages WHERE team_id = ? ORDER BY sort_order, created_at').bind(x.team.id).all<{ id: string; title: string; deleted_at: string | null }>()).results;
  }
  const names = await teamNames(c.env.DB, x.tournament.id);
  const locked = Boolean(x.tournament.scrim_start && nowIso() >= x.tournament.scrim_start);
  const restoreLimit = addMs(now(), -PAGE_RESTORE_DAYS * DAY).toISOString();
  return c.json({
    team: { id: x.team.id, name: names.get(x.team.id), named: Boolean(x.team.name), nameLocked: locked },
    isCoach: x.isCoach, emojis: EMOJIS,
    pages: pages.filter((p) => !p.deleted_at).map((p) => ({ id: p.id, title: p.title })),
    // 削除したページ（30 日以内なら元に戻せる）はコーチだけに見せる
    deletedPages: x.isCoach ? pages.filter((p) => p.deleted_at && p.deleted_at > restoreLimit).map((p) => ({ id: p.id, title: p.title, deletedAt: p.deleted_at })) : [],
  });
});

/** チーム名（コーチ）。スクリム期間に入ったら変えられない */
teamRoutes.put('/name', async (c) => {
  const x = await ctx(c);
  if (x.v.memberType !== 'coach') throw new HttpError(403, 'forbidden', 'チーム名を決められるのはコーチです（運営は管理者画面で修正できます）');
  if (x.tournament.scrim_start && nowIso() >= x.tournament.scrim_start) throw new HttpError(409, 'locked', 'スクリム期間に入ったため、チーム名は変更できません。誤りの修正は運営に問い合わせてください');
  const name = validateText(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).name, 'name', 30, true)!;
  await c.env.DB.prepare('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?').bind(name, nowIso(), x.team.id).run();
  await writeAudit(c.env.DB, x.user.id, 'team_name_set', { type: 'team', id: x.team.id });
  return c.json({ ok: true });
});

const needCoach = (x: Awaited<ReturnType<typeof ctx>>) => { if (!x.isCoach) throw new HttpError(403, 'forbidden', 'ページの追加・変更・削除はコーチだけができます'); };

teamRoutes.post('/pages', async (c) => {
  const x = await ctx(c); needCoach(x);
  const title = validateText(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).title, 'title', 30, true)!;
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM team_pages WHERE team_id = ? AND deleted_at IS NULL').bind(x.team.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 20) throw new HttpError(409, 'too_many', 'ページは 20 個までです');
  const id = ulid(); const t = nowIso();
  await c.env.DB.prepare('INSERT INTO team_pages (id, team_id, title, sort_order, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, x.team.id, title, (n?.n ?? 0) + 1, x.user.id, t, t).run();
  return c.json({ id }, 201);
});

teamRoutes.patch('/pages/:id', async (c) => {
  const x = await ctx(c); needCoach(x);
  await ownPage(c.env.DB, c.req.param('id'), x.team.id);
  const title = validateText(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).title, 'title', 30, true)!;
  await c.env.DB.prepare('UPDATE team_pages SET title = ?, updated_at = ? WHERE id = ?').bind(title, nowIso(), c.req.param('id')).run();
  return c.json({ ok: true });
});

teamRoutes.delete('/pages/:id', async (c) => {
  const x = await ctx(c); needCoach(x);
  await ownPage(c.env.DB, c.req.param('id'), x.team.id);
  await c.env.DB.prepare('UPDATE team_pages SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), c.req.param('id')).run();
  await writeAudit(c.env.DB, x.user.id, 'team_page_delete', { type: 'team_page', id: c.req.param('id') });
  return c.json({ ok: true });
});

teamRoutes.post('/pages/:id/restore', async (c) => {
  const x = await ctx(c); needCoach(x);
  const p = await ownPage(c.env.DB, c.req.param('id'), x.team.id, true);
  if (!p.deleted_at || p.deleted_at <= addMs(now(), -PAGE_RESTORE_DAYS * DAY).toISOString()) throw new HttpError(409, 'expired', '削除から 30 日を過ぎたページは戻せません');
  await c.env.DB.prepare('UPDATE team_pages SET deleted_at = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), p.id).run();
  return c.json({ ok: true });
});

/** 投稿（新しい順）。画像は短時間の URL で、リアクションは絵文字ごとに付けた人の名前つき */
teamRoutes.get('/pages/:id/posts', async (c) => {
  const x = await ctx(c);
  await ownPage(c.env.DB, c.req.param('id'), x.team.id);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.body, p.image_ids, p.created_at, p.author_user_id, COALESCE(u.display_name, u.discord_name) AS author
     FROM team_posts p JOIN users u ON u.id = p.author_user_id WHERE p.page_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 100`,
  ).bind(c.req.param('id')).all<{ id: string; body: string; image_ids: string | null; created_at: string; author_user_id: string; author: string }>();
  const ids = results.map((r) => r.id);
  const reactions = ids.length ? (await c.env.DB.prepare(
    `SELECT r.post_id, r.emoji, r.user_id, COALESCE(u.display_name, u.discord_name) AS name FROM post_reactions r JOIN users u ON u.id = r.user_id WHERE r.post_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at`,
  ).bind(...ids).all<{ post_id: string; emoji: string; user_id: string; name: string }>()).results : [];
  return c.json({
    posts: await Promise.all(results.map(async (r) => ({
      id: r.id, body: r.body, createdAt: r.created_at, author: r.author,
      canDelete: r.author_user_id === x.user.id || x.isCoach,
      images: await Promise.all((r.image_ids ? (JSON.parse(r.image_ids) as string[]) : []).map((i) => signedImageUrl(c.env, i))),
      reactions: EMOJIS.map((e) => {
        const rs = reactions.filter((q) => q.post_id === r.id && q.emoji === e);
        return { emoji: e, count: rs.length, names: rs.map((q) => q.name), mine: rs.some((q) => q.user_id === x.user.id) };
      }).filter((q) => q.count > 0),
    }))),
  });
});

/** 投稿に付ける画像（先に送る。位置情報などは取り除いて保存） */
teamRoutes.post('/images', async (c) => {
  const x = await ctx(c);
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const file = (body as Record<string, unknown>).file;
  if (!(file instanceof File)) throw new HttpError(400, 'no_file', '画像を選んでください');
  const id = await saveImage(c.env, { ownerId: x.user.id, purpose: 'post', file, tournamentId: x.tournament.id });
  return c.json({ imageId: id }, 201);
});

teamRoutes.post('/pages/:id/posts', async (c) => {
  const x = await ctx(c);
  await ownPage(c.env.DB, c.req.param('id'), x.team.id);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const imageIds = Array.isArray(b.imageIds) ? b.imageIds.filter((i): i is string => typeof i === 'string') : [];
  if (imageIds.length > 4) throw new HttpError(422, 'too_many_images', '画像は 4 枚までです');
  const body = validateText(b.body, 'body', 2000, imageIds.length === 0) ?? '';
  for (const i of imageIds) {
    // 自分が送った、投稿用の画像だけ使える
    const ok = await c.env.DB.prepare("SELECT 1 FROM images WHERE id = ? AND owner_user_id = ? AND purpose = 'post' AND deleted_at IS NULL").bind(i, x.user.id).first();
    if (!ok) throw new HttpError(422, 'invalid_image', '画像を選び直してください');
  }
  const id = ulid(); const t = nowIso();
  await c.env.DB.prepare('INSERT INTO team_posts (id, page_id, author_user_id, body, image_ids, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, c.req.param('id'), x.user.id, body, imageIds.length ? JSON.stringify(imageIds) : null, t, t).run();
  return c.json({ id }, 201);
});

async function ownPost(db: D1Database, postId: string, teamId: string) {
  const p = await db.prepare('SELECT p.id, p.author_user_id FROM team_posts p JOIN team_pages g ON g.id = p.page_id WHERE p.id = ? AND g.team_id = ? AND p.deleted_at IS NULL AND g.deleted_at IS NULL')
    .bind(postId, teamId).first<{ id: string; author_user_id: string }>();
  if (!p) throw new HttpError(404, 'not_found', '投稿が見つかりません');
  return p;
}

/** 投稿の削除（書いた本人かコーチ）。10 日後に消える */
teamRoutes.delete('/posts/:id', async (c) => {
  const x = await ctx(c);
  const p = await ownPost(c.env.DB, c.req.param('id'), x.team.id);
  if (p.author_user_id !== x.user.id && !x.isCoach) throw new HttpError(403, 'forbidden', '自分の投稿だけ削除できます');
  await c.env.DB.prepare('UPDATE team_posts SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(nowIso(), nowIso(), p.id).run();
  return c.json({ ok: true });
});

/** リアクション（付ける・外す） */
teamRoutes.post('/posts/:id/reactions', async (c) => {
  const x = await ctx(c);
  const p = await ownPost(c.env.DB, c.req.param('id'), x.team.id);
  const emoji = String(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).emoji ?? '');
  if (!EMOJIS.includes(emoji)) throw new HttpError(422, 'invalid_emoji', '使えない絵文字です');
  const del = await c.env.DB.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').bind(p.id, x.user.id, emoji).run();
  if (!del.meta.changes) await c.env.DB.prepare('INSERT INTO post_reactions (post_id, user_id, emoji, created_at, updated_at) VALUES (?,?,?,?,?)').bind(p.id, x.user.id, emoji, nowIso(), nowIso()).run();
  return c.json({ ok: true, on: !del.meta.changes });
});
