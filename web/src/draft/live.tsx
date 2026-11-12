import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { DraftConfig, Player, View } from './types';

/**
 * ドラフトの状態をリアルタイムで受け取る。
 *  - WebSocket で、状態が変わるたびにサーバーから届く
 *  - 切れたら自動でつなぎ直す（1 → 2 → 5 → 10 秒おき）。つながるまでは 3 秒おきに状態を取りに行く
 *  - 宣材写真の URL は 30 分で期限が切れるので、20 分おきに設定を読み直す
 */
export type Source = { kind: 'member' } | { kind: 'stream'; key: string };
export type Conn = 'connecting' | 'live' | 'polling';

/** ルーレット：画面を開いた最初のデータにすでにあったものは「再読み込みによる復帰」として演出を省く（既存システムと同じ） */
const rouletteLive = new Map<string, boolean>();
const roulettePlayed = new Set<string>();
export const shouldPlayRoulette = (id: string) => rouletteLive.get(id) === true && !roulettePlayed.has(id);
export const markRoulettePlayed = (id: string) => roulettePlayed.add(id);

export function useDraftLive(source: Source) {
  const [config, setConfig] = useState<DraftConfig | null | undefined>(undefined);
  const [view, setView] = useState<View | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const first = useRef(true);
  const lastSession = useRef<string | null>(null);
  const key = source.kind === 'stream' ? source.key : null;
  const headers: Record<string, string> = key ? { 'X-Stream-Key': key } : {};
  const base = key ? '/api/draft/stream' : '/api/draft';

  const accept = useCallback((v: View) => {
    if (v.roulette && !rouletteLive.has(v.roulette.id)) rouletteLive.set(v.roulette.id, !first.current);
    first.current = false;
    setView(v);
  }, []);

  const loadConfig = useCallback(async () => {
    const res = await fetch(`${base}/config`, { headers, credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) { setFatal((await res.json().catch(() => ({}))).message ?? 'この画面を見る権限がありません'); return; }
    if (res.ok) setConfig((await res.json()).config ?? null);
  }, [base, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = useCallback(async () => {
    const res = await fetch(`${base}/state`, { headers, credentials: 'same-origin' }).catch(() => null);
    if (res?.ok) accept((await res.json()).view);
  }, [base, key, accept]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadConfig(); const t = setInterval(loadConfig, 20 * 60 * 1000); return () => clearInterval(t); }, [loadConfig]);
  // ドラフトが作り直されたら（参加受付の開始・初期化）、チームと選手を読み直す
  useEffect(() => {
    if (view && view.sessionId !== lastSession.current) { lastSession.current = view.sessionId; void loadConfig(); }
  }, [view, loadConfig]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => { if (!pollTimer) { void poll(); pollTimer = setInterval(poll, 3000); } };
    const stopPolling = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined; };
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}${base}/ws${key ? `?key=${encodeURIComponent(key)}` : ''}`);
      ws.onopen = () => { retry = 0; setConn('live'); stopPolling(); pingTimer = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25000); };
      ws.onmessage = (e) => { if (e.data === 'pong') return; const m = JSON.parse(String(e.data)); if (m.type === 'view') accept(m.view); };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (closed) return;
        setConn('polling');
        startPolling();
        const wait = [1000, 2000, 5000, 10000][Math.min(retry++, 3)];
        setTimeout(() => !closed && open(), wait);
      };
    };
    open();
    startPolling(); // 最初の接続ができるまでの間も表示できるように
    return () => { closed = true; clearInterval(pingTimer); stopPolling(); ws?.close(); };
  }, [base, key, poll, accept]);

  return { config, view, conn, fatal, refresh: poll };
}

// ---- 画面のあちこちで使う、名前の引き当て ----
export interface DraftData { config: DraftConfig; view: View }
const Ctx = createContext<DraftData | null>(null);
export const DraftProvider = Ctx.Provider;
export function useDraft() {
  const d = useDraftMaybe();
  if (!d) throw new Error('useDraft は DraftProvider の中で使う');
  return d;
}

/** ドラフトの準備（参加受付）がまだなら null */
export function useDraftMaybe() {
  const d = useContext(Ctx);
  if (!d) return null;
  const playerOf = (id: string | null | undefined): Player | undefined => (id ? d.config.players.find((p) => p.id === id) : undefined);
  const teamOf = (id: string) => d.config.teams.find((t) => t.id === id);
  const teamName = (id: string) => teamOf(id)?.name ?? id;
  const joinNames = (ids: string[]) => ids.map(teamName).join('・');
  return { ...d, playerOf, teamOf, teamName, joinNames };
}
export type Draft = NonNullable<ReturnType<typeof useDraftMaybe>>;

/** 選手カードの状態（既存システムの cardStatus と同じ判定。最終的な判定はサーバーが行う） */
export function cardStatus(view: View, teamId: string, player: Player):
  { kind: 'available' } | { kind: 'taken'; ownerId: string } | { kind: 'roleOwned'; role: string } {
  for (const [tid, team] of Object.entries(view.teams)) if (Object.values(team).includes(player.id)) return { kind: 'taken', ownerId: tid };
  if (view.teams[teamId]?.[player.role]) return { kind: 'roleOwned', role: player.role };
  return { kind: 'available' };
}
