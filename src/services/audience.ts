import type { CurrentUser, MemberType } from '../env';
import { nowIso } from '../lib/time';
import { getCurrentTournament, getMembership, type TournamentRow } from './tournament';

/** 見ている人の立場。公開範囲の判定はすべてここを通す */
export interface Viewer {
  user: CurrentUser | null;
  isAdmin: boolean;
  tournament: TournamentRow | null;
  memberType: MemberType | null;
  teamId: string | null;
}

export async function getViewer(db: D1Database, user: CurrentUser | null): Promise<Viewer> {
  const tournament = await getCurrentTournament(db);
  const m = user && tournament ? await getMembership(db, tournament.id, user.id) : null;
  return { user, isAdmin: Boolean(user && user.adminLevel !== 'none'), tournament, memberType: m?.member_type ?? null, teamId: m?.team_id ?? null };
}

/** ルールブックを見られる人：参加者・運営と、募集期間中の登録済み閲覧者（F-16） */
export const canSeeRules = (v: Viewer): boolean =>
  v.isAdmin || v.memberType !== null || (Boolean(v.user) && v.tournament?.phase === 'recruiting');

export interface AnnouncementRow {
  id: string; tournament_id: string | null; title: string; body: string; category: string; visibility: 'public' | 'logged_in' | 'targeted';
  important: number; published_at: string | null; notified_at: string | null; created_by: string; deleted_at: string | null; created_at: string;
}
export interface TargetRow { member_type: MemberType | null; team_id: string | null }

export const isPublished = (a: AnnouncementRow): boolean => Boolean(a.published_at && a.published_at <= nowIso() && !a.deleted_at);

/** お知らせの公開範囲（F-03・F-15）。運営は、公開済みのものはすべて見られる */
export function canSeeAnnouncement(a: AnnouncementRow, targets: TargetRow[], v: Viewer): boolean {
  if (!isPublished(a)) return false;
  if (a.visibility === 'public') return true;
  if (!v.user) return false;
  if (a.visibility === 'logged_in' || v.isAdmin) return true;
  if (!v.memberType) return false;
  return targets.some((t) => (t.member_type === null || t.member_type === v.memberType) && (t.team_id === null || t.team_id === v.teamId));
}
