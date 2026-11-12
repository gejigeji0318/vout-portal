import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { ulid } from '../lib/id';
import { nowIso } from '../lib/time';
import * as L from './logic';
import { type Viewer, viewFor } from './view';

export interface Actor { kind: 'admin' | 'coach'; teamId?: string; userId: string }

/**
 * 1 つの大会のドラフト（Durable Object）。すべての操作を 1 つずつ順番に処理するので、
 * ボタンの連打や管理画面を 2 か所で開いても、状態が二重に進むことはない（既存システムのトランザクションと同じ保証）。
 * 状態と公開前の指名は、この Durable Object の保存領域に持つ（再起動しても消えない）
 */
export class DraftRoom extends DurableObject<Env> {
  private async load() {
    const [state, config, picks, joined, meta] = await Promise.all([
      this.ctx.storage.get<L.GameState>('state'), this.ctx.storage.get<L.DraftConfig>('config'),
      this.ctx.storage.get<Record<string, L.PrivatePick>>('picks'), this.ctx.storage.get<string[]>('joined'),
      this.ctx.storage.get<{ tournamentId: string; resultConfirmed: boolean }>('meta'),
    ]);
    return { state: state ?? L.createInitialState('none'), config: config ?? null, picks: picks ?? {}, joined: joined ?? [], meta: meta ?? null };
  }

  private viewerOf(req: Request): Viewer {
    return JSON.parse(req.headers.get('X-Draft-Viewer') ?? '{"kind":"stream"}') as Viewer;
  }

  private viewJson(d: Awaited<ReturnType<DraftRoom['load']>>, viewer: Viewer) {
    return viewFor(d.state, d.picks, d.joined, d.config?.totalRounds ?? 5, d.meta?.resultConfirmed ?? false, viewer);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const viewer = this.viewerOf(req);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [JSON.stringify(viewer)]);
      pair[1].send(JSON.stringify({ type: 'view', view: this.viewJson(await this.load(), viewer) }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/view') return Response.json(this.viewJson(await this.load(), this.viewerOf(req)));
    if (url.pathname === '/config') return Response.json({ config: (await this.load()).config });
    if (url.pathname === '/op') {
      const { op, actor, args } = (await req.json()) as { op: string; actor: Actor; args?: Record<string, unknown> };
      try {
        const result = await this.apply(op, actor, args ?? {});
        await this.broadcast();
        return Response.json({ ok: true, ...result });
      } catch (e) {
        if (e instanceof L.DraftError) return Response.json({ error: 'draft', message: e.message }, { status: 409 });
        throw e;
      }
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong'); // 接続が生きているかの確認
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code); } catch { /* すでに閉じている */ }
  }

  /** 全員に、それぞれの立場の画面の中身を送る */
  private async broadcast() {
    const d = await this.load();
    for (const ws of this.ctx.getWebSockets()) {
      const viewer = JSON.parse(this.ctx.getTags(ws)[0] ?? '{"kind":"stream"}') as Viewer;
      try { ws.send(JSON.stringify({ type: 'view', view: this.viewJson(d, viewer) })); } catch { /* 切れている接続は無視 */ }
    }
  }

  private async apply(op: string, actor: Actor, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const d = await this.load();
    const { config } = d;
    let state = d.state;
    let picks = d.picks;
    let joined = d.joined;
    const admin = () => { if (actor.kind !== 'admin') throw new L.DraftError('この操作は運営だけができます。'); };
    const needConfig = () => { if (!config) throw new L.DraftError('ドラフトの準備ができていません。'); return config; };
    const myTeam = () => {
      if (actor.kind !== 'coach' || !actor.teamId) throw new L.DraftError('この操作はコーチだけができます。');
      return actor.teamId;
    };

    switch (op) {
      // ---- 運営 ----
      case 'setup': { // 参加受付を始める（新しいドラフト）
        admin();
        if (state.phase !== 'idle' && state.sessionId !== 'none') throw new L.DraftError('進行中のドラフトがあります。初期化してから始めてください。');
        const cfg = args.config as L.DraftConfig;
        const errors = L.validateConfig(cfg);
        if (errors.length) throw new L.DraftError(errors.join('／'));
        await this.ctx.storage.put({ config: cfg, meta: { tournamentId: String(args.tournamentId), resultConfirmed: false } });
        state = L.openLobby(L.createInitialState(String(args.sessionId)));
        picks = {}; joined = [];
        break;
      }
      case 'start': admin(); state = L.startDraft(needConfig(), state, joined); break;
      case 'reveal': admin(); state = L.reveal(needConfig(), state, picks); break;
      case 'rouletteStart': admin(); state = L.startRoulette(state, L.secureRandomIndex, ulid()); break;
      case 'rouletteFinish': admin(); state = L.finishRoulette(needConfig(), state); break;
      case 'freepickConfirm': admin(); state = L.confirmFreePick(needConfig(), state); break;
      case 'nextRound': admin(); state = L.nextRound(needConfig(), state); break;
      case 'reset': admin(); state = L.createInitialState('none'); picks = {}; joined = []; await this.ctx.storage.delete(['config', 'meta']); break;
      case 'markConfirmed': admin(); if (state.phase !== 'finished') throw new L.DraftError('最終結果が出てから確定してください。');
        await this.ctx.storage.put('meta', { ...d.meta!, resultConfirmed: true }); break;
      // ---- コーチ ----
      case 'join': {
        const team = myTeam();
        if (state.phase !== 'lobby') throw new L.DraftError('参加の受付中ではありません。');
        if (!needConfig().teams.some((t) => t.id === team)) throw new L.DraftError('このチームはドラフトの対象ではありません。');
        if (!joined.includes(team)) joined = [...joined, team];
        break;
      }
      case 'pick': case 'confirm': case 'unconfirm': {
        const team = myTeam();
        if ((state.phase !== 'picking' && state.phase !== 'freepick') || !state.pickers.includes(team)) throw new L.DraftError('今は指名できません。');
        const cur = picks[team];
        const mine = cur && cur.sessionId === state.sessionId && cur.pickSeq === state.pickSeq ? cur : null;
        let next: L.PrivatePick;
        if (op === 'pick') {
          const playerId = String(args.playerId ?? '');
          if (mine?.confirmed) throw new L.DraftError('決定済みです。選び直す場合は「選び直す」を押してください。');
          if (!L.isLegalPick(needConfig(), state, team, playerId)) throw new L.DraftError('この選手は選べません。');
          next = { sessionId: state.sessionId, pickSeq: state.pickSeq, playerId, confirmed: false };
        } else if (op === 'confirm') {
          if (!mine?.playerId) throw new L.DraftError('先に選手を選んでください。');
          next = { ...mine, confirmed: true };
        } else {
          next = { sessionId: state.sessionId, pickSeq: state.pickSeq, playerId: null, confirmed: false };
        }
        picks = { ...picks, [team]: next };
        // 自由選択中は、決定（取り消し）をすぐ全員の画面に出す
        const relayed = L.relayFreePick(needConfig(), state, next);
        if (relayed) state = relayed;
        break;
      }
      default: throw new L.DraftError('不明な操作です。');
    }

    const before = d.state;
    await this.ctx.storage.put({ state, picks, joined });
    await this.record(before, state);
    return {};
  }

  /** D1 に記録を残す（進行の段階と、ラウンドごとの結果） */
  private async record(before: L.GameState, after: L.GameState) {
    if (after.sessionId === 'none') return;
    const t = nowIso();
    await this.env.DB.prepare('UPDATE draft_sessions SET phase = ?, round = ?, pick_seq = ?, updated_at = ? WHERE id = ?')
      .bind(after.phase, after.round, after.pickSeq, t, after.sessionId).run();
    if (after.history.length > before.history.length) {
      const last = after.history[after.history.length - 1]!;
      await this.env.DB.batch(Object.entries(last.picks).map(([teamId, playerId]) => this.env.DB.prepare(
        'INSERT OR REPLACE INTO draft_results (session_id, team_id, round, player_member_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).bind(after.sessionId, teamId, last.round, playerId, t, t)));
    }
  }
}
