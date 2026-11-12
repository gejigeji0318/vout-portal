/**
 * ドラフトの進行ロジック（既存のドラフトシステムの logic/draft.ts を移植したもの）
 *
 * 「現在の状態を受け取り、次の状態を返す」だけの純粋な関数。保存は Durable Object（room.ts）が行う。
 * 既存システムとの違い：指名するのは「チーム」（コーチが 1〜2 人いても、チームとして 1 つの指名）。ADC は BOT と表記する
 */
export const ROLES = ['TOP', 'JG', 'MID', 'BOT', 'SUP'] as const;
export type Role = (typeof ROLES)[number];

export interface DraftTeam { id: string; name: string; coachNames: string[]; coachUserIds: string[] }
export interface DraftPlayer { id: string; name: string; role: Role; rank: string | null; iconImageId: string | null }
export interface DraftConfig { teams: readonly DraftTeam[]; players: readonly DraftPlayer[]; roles: readonly Role[]; totalRounds: number }

/**
 * idle: 未開始 / lobby: 参加受付中 / picking: 指名受付中（通常・選び直し）/ collision: 被りあり / roulette: ルーレット
 * freepick: 自由選択中 / roundResult: ラウンド結果 / finished: 最終結果
 */
export type Phase = 'idle' | 'lobby' | 'picking' | 'collision' | 'roulette' | 'freepick' | 'roundResult' | 'finished';
export interface Collision { playerId: string; teamIds: string[] }
export interface RouletteState { id: string; playerId: string; candidates: string[]; winner: string }
export interface FreePick { teamId: string; playerId: string | null }
export interface RoundRecord { round: number; picks: Record<string, string> }

export interface GameState {
  sessionId: string;
  phase: Phase;
  round: number;
  pickSeq: number;
  pickers: string[];
  revealed: Record<string, string>;
  collisions: Collision[];
  losers: string[];
  roulette: RouletteState | null;
  freePick: FreePick | null;
  roundPicks: Record<string, string>;
  teams: Record<string, Partial<Record<Role, string>>>;
  history: RoundRecord[];
}

/** 公開前の指名（本人のチームのコーチだけが見られる） */
export interface PrivatePick { sessionId: string; pickSeq: number; playerId: string | null; confirmed: boolean }

export class DraftError extends Error {}

export function createInitialState(sessionId: string): GameState {
  return { sessionId, phase: 'idle', round: 0, pickSeq: 0, pickers: [], revealed: {}, collisions: [], losers: [], roulette: null, freePick: null, roundPicks: {}, teams: {}, history: [] };
}

export const playerById = (cfg: DraftConfig, id: string | null | undefined) => (id ? cfg.players.find((p) => p.id === id) : undefined);
export const teamById = (cfg: DraftConfig, id: string) => cfg.teams.find((t) => t.id === id);

export function ownerOf(state: GameState, playerId: string): string | null {
  for (const [teamId, team] of Object.entries(state.teams)) if (Object.values(team).includes(playerId)) return teamId;
  return null;
}

export type CardStatus = { kind: 'available' } | { kind: 'taken'; ownerId: string } | { kind: 'roleOwned'; role: Role };

export function cardStatus(state: GameState, teamId: string, player: DraftPlayer): CardStatus {
  const owner = ownerOf(state, player.id);
  if (owner) return { kind: 'taken', ownerId: owner };
  if (state.teams[teamId]?.[player.role]) return { kind: 'roleOwned', role: player.role };
  return { kind: 'available' };
}

export function isLegalPick(cfg: DraftConfig, state: GameState, teamId: string, playerId: string): boolean {
  const player = playerById(cfg, playerId);
  return Boolean(player) && cardStatus(state, teamId, player!).kind === 'available';
}

export function isConfirmedPick(state: GameState, pick: PrivatePick | null | undefined): pick is PrivatePick & { playerId: string } {
  return !!pick && pick.sessionId === state.sessionId && pick.pickSeq === state.pickSeq && pick.confirmed && !!pick.playerId;
}

function expectPhase(state: GameState, ...phases: Phase[]) {
  if (!phases.includes(state.phase)) throw new DraftError('画面の状態が古くなっています。もう一度お試しください。');
}

function assign(cfg: DraftConfig, state: GameState, teamId: string, playerId: string): GameState {
  const player = playerById(cfg, playerId);
  if (!player) throw new DraftError('選手が見つかりません。');
  return { ...state, teams: { ...state.teams, [teamId]: { ...state.teams[teamId], [player.role]: playerId } }, roundPicks: { ...state.roundPicks, [teamId]: playerId } };
}

function beginPicking(state: GameState, pickers: string[], phase: 'picking' | 'freepick'): GameState {
  return { ...state, phase, pickSeq: state.pickSeq + 1, pickers, roulette: null, freePick: phase === 'freepick' ? { teamId: pickers[0]!, playerId: null } : null };
}

function finishRound(state: GameState): GameState {
  return { ...state, phase: 'roundResult', pickers: [], collisions: [], losers: [], roulette: null, freePick: null, history: [...state.history, { round: state.round, picks: state.roundPicks }] };
}

export function openLobby(state: GameState): GameState {
  expectPhase(state, 'idle');
  return { ...state, phase: 'lobby' };
}

export function startDraft(cfg: DraftConfig, state: GameState, joinedIds: string[]): GameState {
  expectPhase(state, 'lobby');
  const missing = cfg.teams.filter((t) => !joinedIds.includes(t.id));
  if (missing.length) throw new DraftError(`まだ参加していないチームがあります：${missing.map((t) => t.name).join('、')}`);
  return beginPicking({ ...state, round: 1, roundPicks: {}, revealed: {}, collisions: [], losers: [] }, cfg.teams.map((t) => t.id), 'picking');
}

export function reveal(cfg: DraftConfig, state: GameState, picks: Record<string, PrivatePick | null | undefined>): GameState {
  expectPhase(state, 'picking');
  const chosen: Record<string, string> = {};
  for (const teamId of state.pickers) {
    const pick = picks[teamId];
    const name = teamById(cfg, teamId)?.name ?? teamId;
    if (!isConfirmedPick(state, pick)) throw new DraftError(`${name}がまだ確定していません。`);
    if (!isLegalPick(cfg, state, teamId, pick.playerId)) throw new DraftError(`${name}の指名が無効です。選び直してもらってください。`);
    chosen[teamId] = pick.playerId;
  }
  const byPlayer = new Map<string, string[]>();
  for (const team of cfg.teams) {
    const playerId = chosen[team.id];
    if (playerId) byPlayer.set(playerId, [...(byPlayer.get(playerId) ?? []), team.id]);
  }
  let next: GameState = { ...state, revealed: chosen, losers: [], pickers: [] };
  const collisions: Collision[] = [];
  for (const [playerId, teamIds] of byPlayer) {
    if (teamIds.length === 1) next = assign(cfg, next, teamIds[0]!, playerId);
    else collisions.push({ playerId, teamIds });
  }
  if (!collisions.length) return finishRound(next);
  const order = (id: string) => cfg.players.findIndex((p) => p.id === id);
  collisions.sort((a, b) => order(a.playerId) - order(b.playerId));
  return { ...next, phase: 'collision', collisions };
}

/** 被りあり → ルーレット（当選はここで、演出の前にサーバーで決める） */
export function startRoulette(state: GameState, randomIndex: (n: number) => number, rouletteId: string): GameState {
  expectPhase(state, 'collision');
  const target = state.collisions[0];
  if (!target) throw new DraftError('処理する被りがありません。');
  return { ...state, phase: 'roulette', roulette: { id: rouletteId, playerId: target.playerId, candidates: target.teamIds, winner: target.teamIds[randomIndex(target.teamIds.length)]! } };
}

export function finishRoulette(cfg: DraftConfig, state: GameState): GameState {
  expectPhase(state, 'roulette');
  const r = state.roulette;
  if (!r) throw new DraftError('ルーレットの結果がありません。');
  let next = assign(cfg, state, r.winner, r.playerId);
  next = { ...next, roulette: null, collisions: state.collisions.filter((c) => c.playerId !== r.playerId), losers: [...state.losers, ...r.candidates.filter((id) => id !== r.winner)] };
  if (next.collisions.length) return { ...next, phase: 'collision' };
  const losers = cfg.teams.map((t) => t.id).filter((id) => next.losers.includes(id));
  next = { ...next, losers: [] };
  if (losers.length >= 2) return beginPicking(next, losers, 'picking');
  if (losers.length === 1) return beginPicking(next, losers, 'freepick');
  return finishRound(next);
}

/** 自由選択中：コーチの決定内容を、全員に見える freePick に反映する（変化がなければ null） */
export function relayFreePick(cfg: DraftConfig, state: GameState, pick: PrivatePick | null | undefined): GameState | null {
  if (state.phase !== 'freepick' || !state.freePick) return null;
  const teamId = state.freePick.teamId;
  const desired = isConfirmedPick(state, pick) && isLegalPick(cfg, state, teamId, pick.playerId) ? pick.playerId : null;
  if (desired === state.freePick.playerId) return null;
  return { ...state, freePick: { teamId, playerId: desired } };
}

export function confirmFreePick(cfg: DraftConfig, state: GameState): GameState {
  expectPhase(state, 'freepick');
  const fp = state.freePick;
  if (!fp?.playerId) throw new DraftError('まだ選手が決定されていません。');
  if (!isLegalPick(cfg, state, fp.teamId, fp.playerId)) throw new DraftError('決定された選手は指名できません。');
  return finishRound(assign(cfg, { ...state, freePick: null }, fp.teamId, fp.playerId));
}

export function nextRound(cfg: DraftConfig, state: GameState): GameState {
  expectPhase(state, 'roundResult');
  if (state.round >= cfg.totalRounds) return { ...state, phase: 'finished' };
  return beginPicking({ ...state, round: state.round + 1, roundPicks: {}, revealed: {}, collisions: [], losers: [] }, cfg.teams.map((t) => t.id), 'picking');
}

/** 設定の検証：各ロールの選手数 ＝ チーム数、ID の重複なし */
export function validateConfig(cfg: DraftConfig): string[] {
  const errors: string[] = [];
  if (cfg.teams.length < 2) errors.push('チームが 2 つ以上必要です');
  for (const t of cfg.teams) if (!t.coachUserIds.length) errors.push(`${t.name}にコーチが割り当てられていません`);
  for (const role of cfg.roles) {
    const n = cfg.players.filter((p) => p.role === role).length;
    if (n !== cfg.teams.length) errors.push(`${role} の選手が ${n} 人です（チーム数 ${cfg.teams.length} と同じ人数が必要）`);
  }
  const ids = [...cfg.teams.map((t) => t.id), ...cfg.players.map((p) => p.id)];
  if (new Set(ids).size !== ids.length) errors.push('ID が重複しています');
  return errors;
}

/** 0 〜 n-1 の整数を均等な確率で返す（暗号論的乱数） */
export function secureRandomIndex(n: number): number {
  if (n <= 0) throw new Error('n must be positive');
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0]! >= limit);
  return buf[0]! % n;
}
