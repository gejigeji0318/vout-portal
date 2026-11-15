import type { Env } from '../env';
import { nowIso } from '../lib/time';
import { getSetting } from './lanes';
import { notify } from './notify';
import { jstRange } from './teams';

/** OB への自動募集：スクリム開始の何時間前に、まだ埋まっていなければ出すか（設定 fill.ob_hours_before、初期値 24） */
export async function obHoursBefore(db: D1Database): Promise<number> {
  const v = await getSetting<{ hours: number }>(db, 'fill.ob_hours_before');
  return v?.hours ?? 24;
}

export const laneText = (lanes: string[]) => lanes.map((l) => (l === 'ANY' ? 'どのレーンでも' : l)).join('・');

/**
 * 時刻を過ぎた補充の募集を、OB 向けのチャンネルに出す（5 分ごとの定期処理、管理者の「今すぐ OB に募集」）。
 * OB 向けには、日時・時間・レーン・人数だけを載せる（チーム名は出さない）。出した印を先に付けるので二重に出さない
 */
export async function postDueOb(env: Env): Promise<number> {
  const t = nowIso();
  const { results } = await env.DB.prepare(
    `SELECT r.id, s.starts_at, s.ends_at FROM fill_requests r JOIN scrims s ON s.id = r.scrim_id JOIN tournaments t ON t.id = r.tournament_id
     WHERE r.status = 'open' AND r.ob_posted_at IS NULL AND r.ob_post_at IS NOT NULL AND r.ob_post_at <= ? AND s.starts_at > ?
       AND t.phase <> 'ended' AND t.deleted_at IS NULL`, // 終わった大会の募集は出さない
  ).bind(t, t).all<{ id: string; starts_at: string; ends_at: string }>();
  let posted = 0;
  for (const r of results) {
    const claimed = await env.DB.prepare('UPDATE fill_requests SET ob_posted_at = ?, updated_at = ? WHERE id = ? AND ob_posted_at IS NULL').bind(t, t, r.id).run();
    if (!claimed.meta.changes) continue;
    const { results: open } = await env.DB.prepare('SELECT lane FROM fill_slots WHERE request_id = ? AND filled_at IS NULL').bind(r.id).all<{ lane: string }>();
    if (!open.length) continue;
    await notify(env, 'fill_ob', `OB の方へ：スクリムの人員を募集しています\n${jstRange(r.starts_at, r.ends_at)}　${laneText(open.map((o) => o.lane))}（${open.length} 人）\n応募はポータルから：${env.APP_ORIGIN}/fill`).catch(() => {});
    posted++;
  }
  return posted;
}
