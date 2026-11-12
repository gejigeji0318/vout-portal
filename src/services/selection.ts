import type { Env } from '../env';
import { HttpError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { validateHttpsUrl, validateStreamUrls, validateXAccount } from '../lib/validate';
import { getCurrentTournament, type TournamentRow } from './tournament';

/** ランク：Iron〜Diamond は区分（Ⅰ〜Ⅳ）つき、Master 以上は区分なし。保存は "Silver Ⅱ" の形 */
export const DIVISION_TIERS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond'] as const;
export const APEX_TIERS = ['Master', 'Grandmaster', 'Challenger'] as const;
export const DIVISIONS = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'] as const;
export const RANKS = [...DIVISION_TIERS.flatMap((t) => DIVISIONS.map((d) => `${t} ${d}`)), ...APEX_TIERS] as const;
export const APPLY_LANES = ['TOP', 'JG', 'MID', 'BOT', 'SUP', 'ALL'] as const;
export const OPGG_HOSTS = ['op.gg'];

export interface RecruitmentRow { id: string; tournament_id: string; body: string; kinds: string; opens_at: string; closes_at: string }
export interface ApplicationRow {
  id: string; recruitment_id: string; user_id: string; kind: 'player' | 'coach' | 'staff'; opgg_url: string; rank: string | null;
  main_lane: string | null; second_lane: string | null; x_account: string | null; stream_urls: string | null; photo_image_id: string; created_at: string; updated_at: string; staff_edited_at: string | null;
}

export async function currentRecruitment(db: D1Database): Promise<{ t: TournamentRow; r: RecruitmentRow } | null> {
  const t = await getCurrentTournament(db);
  if (!t) return null;
  const r = await db.prepare('SELECT * FROM recruitments WHERE tournament_id = ?').bind(t.id).first<RecruitmentRow>();
  return r ? { t, r } : null;
}

export const isOpen = (r: RecruitmentRow) => { const n = nowIso(); return r.opens_at <= n && n < r.closes_at; };

export const activeChecks = (db: D1Database, recruitmentId: string) =>
  db.prepare('SELECT id, label, fixed FROM recruitment_checks WHERE recruitment_id = ? AND deleted_at IS NULL ORDER BY sort_order')
    .bind(recruitmentId).all<{ id: string; label: string; fixed: number }>().then((r) => r.results);

/** 応募内容の検査（F-11）。選手はランク・得意レーン・セカンドが必須。コーチ・補助スタッフは任意 */
export function validateApplication(b: Record<string, unknown>, kinds: string[]) {
  const kind = b.kind;
  if (typeof kind !== 'string' || !kinds.includes(kind)) throw new HttpError(422, 'invalid_kind', '募集していない区分です');
  let opgg: string | null;
  try { opgg = validateHttpsUrl(b.opggUrl, 'opgg_url', OPGG_HOSTS); } catch { throw new HttpError(422, 'invalid_opgg_url', 'OP.GG：OP.GG のページの URL（https://op.gg/...）を入力してください'); }
  if (!opgg) throw new HttpError(422, 'invalid_opgg_url', 'OP.GG の URL を入力してください');
  const pick = <T extends readonly string[]>(v: unknown, list: T, field: string): T[number] | null => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || !list.includes(v)) throw new HttpError(422, `invalid_${field}`);
    return v as T[number];
  };
  const rank = pick(b.rank, RANKS as readonly string[], 'rank');
  const main = pick(b.mainLane, APPLY_LANES, 'main_lane');
  const second = pick(b.secondLane, APPLY_LANES, 'second_lane');
  if (kind === 'player') {
    if (!rank) throw new HttpError(422, 'invalid_rank', 'ランクを選んでください（Iron〜Diamond は区分のⅠ〜Ⅳも）');
    if (!main) throw new HttpError(422, 'invalid_main_lane', '得意レーンを選んでください');
    if (main !== 'ALL' && !second) throw new HttpError(422, 'invalid_second_lane', 'セカンドレーンを選んでください');
  }
  if (main && second && main === second) throw new HttpError(422, 'same_lanes', '得意レーンとセカンドレーンは別のものを選んでください');
  const streams = validateStreamUrls(b.streamUrls);
  return {
    kind: kind as 'player' | 'coach' | 'staff', opgg, rank, main, second: main === 'ALL' && !second ? null : second,
    x: validateXAccount(b.xAccount), streams: streams.length ? JSON.stringify(streams) : null,
  };
}

/**
 * 本人に見せる選考状況。発表前は審査・仮決定の内容に関係なく「応募済み（受付中）」か「選考中」だけ
 */
export async function applicantStatus(env: Env, t: TournamentRow, r: RecruitmentRow, userId: string): Promise<'none' | 'submitted' | 'selecting' | 'accepted' | 'rejected'> {
  if (await env.DB.prepare('SELECT 1 FROM rejection_records WHERE tournament_id = ? AND user_id = ?').bind(t.id, userId).first()) return 'rejected';
  const app = await env.DB.prepare('SELECT 1 FROM applications WHERE recruitment_id = ? AND user_id = ?').bind(r.id, userId).first();
  if (!app) return 'none';
  if (t.announced_at) return 'accepted';
  return isOpen(r) ? 'submitted' : 'selecting';
}
