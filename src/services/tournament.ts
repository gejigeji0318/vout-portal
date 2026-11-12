import type { MemberType } from '../env';

export interface TournamentRow {
  id: string; name: string; phase: string; period_start: string; period_end: string; team_count: number;
  scrim_start: string | null; scrim_end: string | null; schedule_deadline: string | null;
  announced_at: string | null; ended_at: string | null;
}

/** 開催中の大会（終了・削除されていない最新のもの）。同時に 1 大会の前提 */
export const getCurrentTournament = (db: D1Database) =>
  db
    .prepare("SELECT * FROM tournaments WHERE deleted_at IS NULL AND phase <> 'ended' ORDER BY created_at DESC LIMIT 1")
    .first<TournamentRow>();

export interface Membership { id: string; member_type: MemberType; team_id: string | null; lane: string | null; draft_role: string | null }

export const getMembership = (db: D1Database, tournamentId: string, userId: string) =>
  db
    .prepare('SELECT id, member_type, team_id, lane, draft_role FROM tournament_members WHERE tournament_id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(tournamentId, userId)
    .first<Membership>();

/** ドラフト開始以降はチーム数を変えられない */
export const DRAFT_STARTED_PHASES = new Set(['drafting', 'scrim', 'main', 'ended']);
