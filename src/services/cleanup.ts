import type { Env } from '../env';
import { addMs, DAY, now } from '../lib/time';
import { writeAudit } from './audit';
import { hardDeleteImage } from './imageStore';
import { purgeEndedTournaments, purgeInactiveUsers } from './tournamentEnd';

/**
 * 毎日の削除処理（要件定義書の削除・保持のルール）
 *  - 削除した投稿：10 日後に物理削除（画像も）
 *  - 削除したチーム内ページ：30 日後に物理削除（中の投稿・画像も）
 *  - 操作ログ：1 年後に物理削除
 *  - 論理削除した画像：10 日後に物理削除
 *  - 二人承認の記録：1 年後／終了した大会：10 日後／最後のログインから 2 年の利用者
 */
export async function dailyCleanup(env: Env): Promise<Record<string, number>> {
  const ago = (days: number) => addMs(now(), -days * DAY).toISOString();
  const db = env.DB;
  const imageIdsOf = (rows: { image_ids: string | null }[]) => rows.flatMap((r) => (r.image_ids ? (JSON.parse(r.image_ids) as string[]) : []));

  const { results: oldPosts } = await db.prepare('SELECT id, image_ids FROM team_posts WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(ago(10)).all<{ id: string; image_ids: string | null }>();
  const { results: pagePosts } = await db.prepare('SELECT p.id, p.image_ids FROM team_posts p JOIN team_pages g ON g.id = p.page_id WHERE g.deleted_at IS NOT NULL AND g.deleted_at < ?').bind(ago(30)).all<{ id: string; image_ids: string | null }>();
  for (const id of imageIdsOf([...oldPosts, ...pagePosts])) await hardDeleteImage(env, id);
  const posts = await db.prepare('DELETE FROM team_posts WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(ago(10)).run();
  const pages = await db.prepare('DELETE FROM team_pages WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(ago(30)).run();
  const { results: oldImages } = await db.prepare('SELECT id FROM images WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(ago(10)).all<{ id: string }>();
  for (const i of oldImages) await hardDeleteImage(env, i.id);
  const logs = await db.prepare('DELETE FROM audit_logs WHERE at < ?').bind(ago(365)).run();
  const approvals = await db.prepare('DELETE FROM approvals WHERE created_at < ?').bind(ago(365)).run();
  const tournaments = await purgeEndedTournaments(env);
  const users = await purgeInactiveUsers(env);
  const result = { posts: posts.meta.changes ?? 0, pages: pages.meta.changes ?? 0, images: oldImages.length, logs: logs.meta.changes ?? 0, approvals: approvals.meta.changes ?? 0, tournaments, users };
  await writeAudit(db, null, 'daily_cleanup', undefined, result);
  return result;
}
