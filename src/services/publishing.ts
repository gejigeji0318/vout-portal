import type { Env } from '../env';
import { nowIso } from '../lib/time';
import { writeAudit } from './audit';
import { notify } from './notify';

/**
 * 公開時刻を過ぎて、まだ通知していないお知らせを Discord に知らせる。
 * 「今すぐ公開」のときも、予約公開の時刻になったとき（定期処理）も、ここを通る。
 * 通知済みの印（notified_at）を先に付けてから送るので、二重に送らない
 */
export async function announceDue(env: Env): Promise<number> {
  const t = nowIso();
  const { results } = await env.DB.prepare(
    'SELECT id, title FROM announcements WHERE deleted_at IS NULL AND notified_at IS NULL AND published_at IS NOT NULL AND published_at <= ?',
  ).bind(t).all<{ id: string; title: string }>();
  let sent = 0;
  for (const a of results) {
    const claimed = await env.DB.prepare('UPDATE announcements SET notified_at = ? WHERE id = ? AND notified_at IS NULL').bind(t, a.id).run();
    if (!claimed.meta.changes) continue;
    await notify(env, 'announcement', `お知らせ：${a.title}\n${env.APP_ORIGIN}/news/${a.id}`);
    await writeAudit(env.DB, null, 'announcement_publish', { type: 'announcement', id: a.id });
    sent++;
  }
  return sent;
}
