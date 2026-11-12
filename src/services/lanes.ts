import type { Env } from '../env';
import { nowIso } from '../lib/time';
import { writeAudit } from './audit';
import { notify } from './notify';

/**
 * 適性レーン（F-09）：既存の championLane の data.json と、Riot 公式（Data Dragon）の日本語名を
 * サーバーで取り込み、検査したうえで 1 件のデータとして保存する。
 * 画面はこのデータを HTML に差し込むので、ここで形を厳しく確かめる（不正なデータで画面が乗っ取られないように）
 */
export const POSITIONS = ['top', 'jungle', 'mid', 'adc', 'support'] as const;
export const MIN_CHAMPIONS = 100;
const DDRAGON = 'https://ddragon.leagueoflegends.com';

export interface LaneChampion { name: string; ja: string; main: string | null; rate: number; rates: Record<string, number>; nodata?: true }
export interface LaneSnapshot { updatedAt: string; source: string; syncedAt: string; champions: LaneChampion[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const NAME_RE = /^[A-Za-z0-9'. &-]{1,40}$/;
const isRate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

/** data.json の中身を検査する。形が違えば理由を投げる */
export function validateLaneData(json: unknown): { updatedAt: string; champions: Omit<LaneChampion, 'ja'>[] } {
  const o = json as { updated_at?: unknown; champions?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.champions)) throw new Error('data.json の形が違います');
  if (typeof o.updated_at !== 'string' || Number.isNaN(Date.parse(o.updated_at))) throw new Error('更新日時が読み取れません');
  const champions = o.champions.map((c, i) => {
    const x = c as Record<string, unknown>;
    if (typeof x.name !== 'string' || !NAME_RE.test(x.name)) throw new Error(`${i + 1} 件目の名前が不正です`);
    if (typeof x.main !== 'string' || !(POSITIONS as readonly string[]).includes(x.main)) throw new Error(`${x.name} のレーンが不正です`);
    if (!isRate(x.rate)) throw new Error(`${x.name} のピック率が不正です`);
    if (!x.rates || typeof x.rates !== 'object') throw new Error(`${x.name} のレーン別ピック率が不正です`);
    const rates: Record<string, number> = {};
    for (const [k, v] of Object.entries(x.rates as Record<string, unknown>)) {
      if (!(POSITIONS as readonly string[]).includes(k) || !isRate(v)) throw new Error(`${x.name} のレーン別ピック率が不正です`);
      rates[k] = v;
    }
    return { name: x.name, main: x.main, rate: x.rate, rates };
  });
  if (champions.length < MIN_CHAMPIONS) throw new Error(`取得数が少なすぎます（${champions.length} 体）`);
  return { updatedAt: new Date(o.updated_at).toISOString(), champions };
}

/** Data Dragon から、英語の ID・名前 → 日本語名 の対応と、全チャンピオンの一覧を作る（日本語名は表示用の文字だけに絞る） */
async function loadJapaneseNames(): Promise<{ map: Map<string, string>; all: { keys: string[]; name: string; ja: string }[] }> {
  const get = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(u); return r.json() as Promise<any>; };
  const [ver] = (await get(`${DDRAGON}/api/versions.json`)) as string[];
  if (!ver || !/^[\d.]+$/.test(ver)) throw new Error('Data Dragon の版が読み取れません');
  const base = `${DDRAGON}/cdn/${ver}/data`;
  const [ja, en] = await Promise.all([get(`${base}/ja_JP/champion.json`), get(`${base}/en_US/champion.json`)]);
  const map = new Map<string, string>();
  const all: { keys: string[]; name: string; ja: string }[] = [];
  for (const [id, c] of Object.entries(ja.data as Record<string, { name: string }>)) {
    const jaName = String(c.name).replace(/[<>&"'`]/g, '').slice(0, 40);
    const enName = String((en.data as Record<string, { name: string }>)[id]?.name ?? id).replace(/[<>&"'`]/g, '').slice(0, 40);
    const keys = [norm(id), norm(enName)];
    for (const k of keys) map.set(k, jaName);
    all.push({ keys, name: enName, ja: jaName });
  }
  return { map, all };
}

/** 取り込み。失敗したときは前回のデータを残し、管理者に Discord で知らせる */
export async function syncLanes(env: Env, actorUserId: string | null): Promise<{ ok: boolean; message: string; count?: number }> {
  const syncedAt = nowIso();
  try {
    const res = await fetch(env.LANES_DATA_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`data.json を取得できませんでした（HTTP ${res.status}）`);
    const data = validateLaneData(await res.json());
    const names = await loadJapaneseNames().catch(() => ({ map: new Map<string, string>(), all: [] as { keys: string[]; name: string; ja: string }[] }));
    const champions: LaneChampion[] = data.champions.map((c) => ({ ...c, ja: names.map.get(norm(c.name)) ?? c.name }));
    const have = new Set(champions.map((c) => norm(c.name)));
    for (const c of names.all) if (!c.keys.some((k) => have.has(k))) champions.push({ name: c.name, ja: c.ja, main: null, rate: 0, rates: {}, nodata: true });
    const snapshot: LaneSnapshot = { updatedAt: data.updatedAt, source: 'OP.GG (https://op.gg)', syncedAt, champions };
    await putSetting(env.DB, 'lanes.snapshot', snapshot, actorUserId);
    const msg = `${data.champions.length} 体を取り込みました`;
    await putSetting(env.DB, 'lanes.last_sync', { at: syncedAt, ok: true, message: msg }, actorUserId);
    await writeAudit(env.DB, actorUserId, 'lanes_sync', undefined, { ok: true, count: data.champions.length });
    return { ok: true, message: msg, count: data.champions.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '取り込みに失敗しました';
    await putSetting(env.DB, 'lanes.last_sync', { at: syncedAt, ok: false, message: msg }, actorUserId);
    await writeAudit(env.DB, actorUserId, 'lanes_sync', undefined, { ok: false });
    await notify(env, 'lanes_sync', `適性レーンの取り込みに失敗しました（前日のデータを表示しています）：${msg}`).catch(() => {});
    return { ok: false, message: msg };
  }
}

export async function putSetting(db: D1Database, key: string, value: unknown, by: string | null): Promise<void> {
  const t = nowIso();
  await db.prepare('INSERT INTO settings (key, value, updated_by, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), by, t, t).run();
}

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as T) : null;
}
