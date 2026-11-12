export type Role = 'TOP' | 'JG' | 'MID' | 'BOT' | 'SUP';
export type Phase = 'idle' | 'lobby' | 'picking' | 'collision' | 'roulette' | 'freepick' | 'roundResult' | 'finished';
export interface Team { id: string; name: string; coachNames: string[] }
export interface Player { id: string; name: string; role: Role; rank: string | null; iconUrl: string | null }
export interface DraftConfig { roles: Role[]; totalRounds: number; teams: Team[]; players: Player[] }
export interface View {
  sessionId: string; phase: Phase; round: number; totalRounds: number; pickSeq: number;
  pickers: string[]; revealed: Record<string, string>; collisions: { playerId: string; teamIds: string[] }[];
  roulette: { id: string; playerId: string; candidates: string[]; winner: string } | null;
  freePick: { teamId: string; playerId: string | null } | null; roundPicks: Record<string, string>;
  teams: Record<string, Partial<Record<Role, string>>>; history: { round: number; picks: Record<string, string> }[];
  joined: string[]; confirmedTeams: string[]; resultConfirmed: boolean;
  myTeamId?: string; myPick?: { playerId: string | null; confirmed: boolean } | null;
}
