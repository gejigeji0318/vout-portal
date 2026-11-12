import type { GameState, PrivatePick } from './logic';

/**
 * 見る人ごとの画面の中身。公開前の指名を誰に見せるかは、ここだけで決める。
 *  - コーチ：自分のチームの指名だけ
 *  - 運営・配信：誰の指名も見せない（「決定済みかどうか」だけ）
 */
export type Viewer = { kind: 'admin' } | { kind: 'coach'; teamId: string } | { kind: 'stream' };

export interface DraftView {
  sessionId: string; phase: GameState['phase']; round: number; totalRounds: number; pickSeq: number;
  pickers: string[]; revealed: Record<string, string>; collisions: GameState['collisions']; roulette: GameState['roulette'];
  freePick: GameState['freePick']; roundPicks: Record<string, string>; teams: GameState['teams']; history: GameState['history'];
  joined: string[]; confirmedTeams: string[]; resultConfirmed: boolean;
  myTeamId?: string; myPick?: { playerId: string | null; confirmed: boolean } | null;
}

export function viewFor(state: GameState, picks: Record<string, PrivatePick>, joined: string[], totalRounds: number, resultConfirmed: boolean, viewer: Viewer): DraftView {
  const current = (p: PrivatePick | undefined) => p && p.sessionId === state.sessionId && p.pickSeq === state.pickSeq ? p : undefined;
  const confirmedTeams = state.pickers.filter((t) => current(picks[t])?.confirmed);
  const view: DraftView = {
    sessionId: state.sessionId, phase: state.phase, round: state.round, totalRounds, pickSeq: state.pickSeq,
    pickers: state.pickers, revealed: state.revealed, collisions: state.collisions, roulette: state.roulette, freePick: state.freePick,
    roundPicks: state.roundPicks, teams: state.teams, history: state.history, joined, confirmedTeams, resultConfirmed,
  };
  if (viewer.kind === 'coach') {
    const mine = current(picks[viewer.teamId]);
    view.myTeamId = viewer.teamId;
    view.myPick = mine ? { playerId: mine.playerId, confirmed: mine.confirmed } : null;
  }
  return view;
}
