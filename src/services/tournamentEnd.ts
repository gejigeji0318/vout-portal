import type { Env } from '../env';
import { addMs, DAY, now, nowIso } from '../lib/time';
import { writeAudit } from './audit';
import { hardDeleteImage } from './imageStore';

export const RESTORE_DAYS = 10;

/** 大会終了：データを画面から消す（論理削除）。10 日以内なら元に戻せる */
export async function endTournament(env: Env, tournamentId: string, actor: string) {
  const t = nowIso();
  const r = await env.DB.prepare("UPDATE tournaments SET phase_before_end = phase, phase = 'ended', ended_at = ?, updated_at = ? WHERE id = ? AND phase <> 'ended' AND deleted_at IS NULL")
    .bind(t, t, tournamentId).run();
  if (r.meta.changes) await writeAudit(env.DB, actor, 'tournament_end', { type: 'tournament', id: tournamentId });
  return Boolean(r.meta.changes);
}

/**
 * 10 日を過ぎた終了済みの大会を、関係するデータごと物理削除する（毎日の削除処理から呼ぶ）。
 * 子のデータから順に消す。画像は R2 からも消す。ドラフトの Durable Object の中身も消す
 */
export async function purgeEndedTournaments(env: Env): Promise<number> {
  const limit = addMs(now(), -RESTORE_DAYS * DAY).toISOString();
  const { results } = await env.DB.prepare("SELECT id, ended_at FROM tournaments WHERE phase = 'ended' AND ended_at IS NOT NULL AND ended_at < ? AND deleted_at IS NULL").bind(limit).all<{ id: string; ended_at: string }>();
  for (const t of results) {
    const db = env.DB;
    const { results: imgs } = await db.prepare('SELECT id FROM images WHERE tournament_id = ?').bind(t.id).all<{ id: string }>();
    for (const i of imgs) await hardDeleteImage(env, i.id);
    const teamSub = 'SELECT id FROM teams WHERE tournament_id = ?';
    const q = (sql: string) => db.prepare(sql).bind(t.id);
    await db.batch([
      q(`DELETE FROM post_reactions WHERE post_id IN (SELECT p.id FROM team_posts p JOIN team_pages g ON g.id = p.page_id WHERE g.team_id IN (${teamSub}))`),
      q(`DELETE FROM team_posts WHERE page_id IN (SELECT id FROM team_pages WHERE team_id IN (${teamSub}))`),
      q(`DELETE FROM team_pages WHERE team_id IN (${teamSub})`),
      q('DELETE FROM fill_applications WHERE slot_id IN (SELECT s.id FROM fill_slots s JOIN fill_requests r ON r.id = s.request_id WHERE r.tournament_id = ?)'),
      q('DELETE FROM fill_slots WHERE request_id IN (SELECT id FROM fill_requests WHERE tournament_id = ?)'),
      q('DELETE FROM fill_requests WHERE tournament_id = ?'),
      q('DELETE FROM scrim_participants WHERE scrim_id IN (SELECT id FROM scrims WHERE tournament_id = ?)'),
      q('DELETE FROM scrim_logs WHERE scrim_id IN (SELECT id FROM scrims WHERE tournament_id = ?)'),
      q('DELETE FROM scrim_candidates WHERE scrim_id IN (SELECT id FROM scrims WHERE tournament_id = ?)'),
      q('DELETE FROM scrims WHERE tournament_id = ?'),
      q('DELETE FROM availabilities WHERE slot_id IN (SELECT id FROM schedule_slots WHERE tournament_id = ?)'),
      q('DELETE FROM schedule_slots WHERE tournament_id = ?'),
      q('DELETE FROM draft_results WHERE session_id IN (SELECT id FROM draft_sessions WHERE tournament_id = ?)'),
      q('DELETE FROM draft_sessions WHERE tournament_id = ?'),
      q('DELETE FROM reviews WHERE application_id IN (SELECT a.id FROM applications a JOIN recruitments r ON r.id = a.recruitment_id WHERE r.tournament_id = ?)'),
      q('DELETE FROM provisional_decisions WHERE application_id IN (SELECT a.id FROM applications a JOIN recruitments r ON r.id = a.recruitment_id WHERE r.tournament_id = ?)'),
      q('DELETE FROM application_checks WHERE application_id IN (SELECT a.id FROM applications a JOIN recruitments r ON r.id = a.recruitment_id WHERE r.tournament_id = ?)'),
      q('DELETE FROM applications WHERE recruitment_id IN (SELECT id FROM recruitments WHERE tournament_id = ?)'),
      q('DELETE FROM recruitment_checks WHERE recruitment_id IN (SELECT id FROM recruitments WHERE tournament_id = ?)'),
      q('DELETE FROM recruitments WHERE tournament_id = ?'),
      q('DELETE FROM rejection_records WHERE tournament_id = ?'),
      q('DELETE FROM announcement_reads WHERE announcement_id IN (SELECT id FROM announcements WHERE tournament_id = ?)'),
      q('DELETE FROM announcement_targets WHERE announcement_id IN (SELECT id FROM announcements WHERE tournament_id = ?)'),
      q('DELETE FROM announcements WHERE tournament_id = ?'),
      q('DELETE FROM page_versions WHERE tournament_id = ?'),
      q('DELETE FROM events WHERE tournament_id = ?'),
      q('DELETE FROM tournament_members WHERE tournament_id = ?'),
      q('DELETE FROM images WHERE tournament_id = ?'),
      q('DELETE FROM teams WHERE tournament_id = ?'),
      // 問い合わせは大会中だけ保持する（大会終了までに作られたもの）
      db.prepare('DELETE FROM inquiry_messages WHERE inquiry_id IN (SELECT id FROM inquiries WHERE created_at <= ?)').bind(t.ended_at),
      db.prepare('DELETE FROM inquiries WHERE created_at <= ?').bind(t.ended_at),
      q('DELETE FROM tournaments WHERE id = ?'),
    ]);
    // ドラフトの Durable Object に残っている状態も消す
    try {
      await env.DRAFT.get(env.DRAFT.idFromName(t.id)).fetch('https://draft/op', { method: 'POST', body: JSON.stringify({ op: 'reset', actor: { kind: 'admin', userId: 'system' } }) });
    } catch { /* 無ければよい */ }
    await writeAudit(db, null, 'tournament_purge', { type: 'tournament', id: t.id });
  }
  return results.length;
}

/** 最後のログインから 2 年たった利用者を削除する（管理者は除く）。画像は R2 からも消す */
export async function purgeInactiveUsers(env: Env): Promise<number> {
  const limit = addMs(now(), -730 * DAY).toISOString();
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE admin_level = 'none' AND last_login_at < ?").bind(limit).all<{ id: string }>();
  for (const u of results) {
    const { results: imgs } = await env.DB.prepare('SELECT id FROM images WHERE owner_user_id = ?').bind(u.id).all<{ id: string }>();
    for (const i of imgs) await hardDeleteImage(env, i.id);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run(); // 関係するデータは ON DELETE CASCADE で消える
  }
  if (results.length) await writeAudit(env.DB, null, 'inactive_users_purge', undefined, { count: results.length });
  return results.length;
}
