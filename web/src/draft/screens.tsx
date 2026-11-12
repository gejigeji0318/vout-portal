import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { cardStatus, DraftProvider, useDraft, useDraftLive, useDraftMaybe, type Conn } from './live';
import { ActionBar, CenterMessage, ConfirmDialog, CumulativeModal, FinalResult, Modal, Notice, PlayerPhoto, RankLegend, RouletteView, roundLabel, TeamGrid, TopBar } from './ui';
import type { Player, Role, View } from './types';
import './draft.css';

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : '通信に失敗しました。もう一度お試しください。');
const ConnBadge = ({ conn }: { conn: Conn }) => (
  <span className={`conn${conn === 'live' ? '' : ' conn--bad'}`} role="status">{conn === 'live' ? '● 接続中' : conn === 'polling' ? '● 再接続中（3 秒ごとに更新）' : '● 接続しています'}</span>
);

/** 3 つの画面の共通の枠：読み込み・エラー・まだドラフトが無いとき */
function Shell({ source, render }: { source: Parameters<typeof useDraftLive>[0]; render: (conn: Conn) => ReactNode }) {
  const { config, view, conn, fatal } = useDraftLive(source);
  const body = fatal ? <CenterMessage title="表示できません"><p>{fatal}</p></CenterMessage>
    : config === undefined || !view ? <CenterMessage title="読み込んでいます" /> : null;
  return (
    <div className="draft-root">
      {body ? <div className="screen">{body}</div>
        : config ? <DraftProvider value={{ config, view: view! }}>{render(conn)}</DraftProvider>
        : render(conn)}
    </div>
  );
}

// =============== コーチ ===============
export function CoachDraftPage() {
  return <Shell source={{ kind: 'member' }} render={(conn) => <CoachInner conn={conn} />} />;
}

function CoachInner({ conn }: { conn: Conn }) {
  const ctx = useDraftOrNull();
  if (!ctx) return <div className="screen"><TopBar title="ドラフト" who="" extra={<a className="btn btn--sm" href="/" target="_blank" rel="noopener">ポータルを開く</a>} /><CenterMessage title="ドラフトの準備中です"><p>運営が参加受付を始めるまでお待ちください。</p></CenterMessage></div>;
  return <CoachScreen conn={conn} />;
}

const useDraftOrNull = useDraftMaybe;

function resultMessage(view: View, d: ReturnType<typeof useDraft>): string {
  switch (view.phase) {
    case 'picking': return `${d.joinNames(view.pickers)}が選び直しています`;
    case 'collision': return '被りが発生しました。運営がルーレットを開始するまでお待ちください';
    case 'freepick': {
      const fp = view.freePick;
      if (!fp) return '';
      const p = d.playerOf(fp.playerId);
      return p ? `${d.teamName(fp.teamId)}が${p.name}を選びました。運営の確定を待っています` : `${d.teamName(fp.teamId)}が残りの選手から選んでいます`;
    }
    case 'roundResult': return view.round >= view.totalRounds ? '全ラウンドが終わりました。最終結果の発表をお待ちください' : `ラウンド${view.round}の結果です。次のラウンドの開始をお待ちください`;
    default: return '';
  }
}

function CoachScreen({ conn }: { conn: Conn }) {
  const d = useDraft();
  const { view } = d;
  const me = view.myTeamId!;
  const [showCumulative, setShowCumulative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joined = view.joined.includes(me);
  const isPicker = (view.phase === 'picking' || view.phase === 'freepick') && view.pickers.includes(me);
  const join = async () => { setBusy(true); setError(null); try { await api('POST', '/api/draft/join'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };

  let body: ReactNode;
  if (view.phase === 'idle' || view.phase === 'lobby') {
    body = joined ? <CenterMessage title="参加しました"><p>運営がドラフトを開始するまでお待ちください。</p></CenterMessage>
      : <CenterMessage title="ドラフトへの参加">
          <p>{view.phase === 'lobby' ? '参加ボタンを押してください。' : '運営が参加受付を始めるまでお待ちください。'}</p>
          <button className="btn btn--primary btn--large" disabled={view.phase !== 'lobby' || busy} onClick={join}>参加する</button>
        </CenterMessage>;
  } else if (isPicker) {
    body = <PickScreen key={`${view.sessionId}:${view.pickSeq}`} onShowCumulative={() => setShowCumulative(true)} />;
  } else if (view.phase === 'roulette' && view.roulette) {
    body = <RouletteView key={view.roulette.id} />;
  } else if (view.phase === 'finished') {
    body = <FinalResult />;
  } else {
    body = <><TeamGrid /><ActionBar message={resultMessage(view, d)}><button className="btn" onClick={() => setShowCumulative(true)}>累計</button></ActionBar></>;
  }
  return (
    <div className="screen">
      <TopBar title={roundLabel(view, d.config.totalRounds)} who={d.teamName(me)} extra={<><ConnBadge conn={conn} /><a className="btn btn--sm" href="/" target="_blank" rel="noopener">ポータルを開く</a></>} />
      {error && <Notice tone="error">{error}</Notice>}
      <main className="screen__main">{body}</main>
      {showCumulative && <CumulativeModal me={me} onClose={() => setShowCumulative(false)} />}
    </div>
  );
}

/** 画面上の配置：上段 TOP・MID、中段 JG、下段 BOT・SUP（既存システムと同じ） */
const AREA: Record<Role, string> = { TOP: 'top', MID: 'mid', JG: 'jg', BOT: 'bot', SUP: 'sup' };

function PickScreen({ onShowCumulative }: { onShowCumulative: () => void }) {
  const d = useDraft();
  const { view, config } = d;
  const me = view.myTeamId!;
  const current = view.myPick ?? null;
  const [selected, setSelected] = useState<string | null>(current?.playerId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = Boolean(current?.confirmed && current.playerId === selected);
  const mode = view.phase === 'freepick' ? 'free' : view.pickers.length < config.teams.length ? 'repick' : 'normal';
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const choose = (p: Player) => {
    if (busy || p.id === selected || cardStatus(view, me, p).kind !== 'available') return;
    setSelected(p.id);
    // 決定後に選び直したら、決定を取り消す（状態は「選択中」に戻る）
    if (current?.confirmed) void run(() => api('POST', '/api/draft/unconfirm'));
  };
  const decide = () => selected && run(async () => { await api('POST', '/api/draft/pick', { playerId: selected }); await api('POST', '/api/draft/confirm'); });
  const sel = d.playerOf(selected);
  const status = decided ? (mode === 'free' ? '全員の画面に表示されました。運営が確定するまでは変更できます' : '決定しました。運営が公開するまでは変更できます') : '決定を押すまで何度でも選び直せます';
  return (
    <>
      {mode === 'repick' && <Notice>ルーレットに外れたため、残りの選手から選び直してください。公開されるまで他のチームには見えません。</Notice>}
      {mode === 'free' && <Notice>残りの選手から自由に選んでください。決定すると全員の画面に表示されます。</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <RankLegend />
      <div className="role-board">
        {config.roles.map((role) => (
          <section key={role} className={`role-box role-box--${AREA[role]}`} style={{ gridArea: AREA[role] }} aria-label={role}>
            <h2 className="role-box__title">{role}</h2>
            <div className="role-box__cards">
              {config.players.filter((p) => p.role === role).map((p) => {
                const st = cardStatus(view, me, p);
                const available = st.kind === 'available';
                const isSel = p.id === selected;
                return (
                  <button key={p.id} type="button" className={`pick-card${isSel ? ' is-selected' : ''}${available ? '' : ' is-blocked'}`} disabled={!available} aria-pressed={isSel} onClick={() => choose(p)}>
                    <PlayerPhoto player={p} width={48} />
                    <span className="pick-card__text">
                      <span className="pick-card__name">{p.name}</span>
                      <span className="pick-card__note">{st.kind === 'taken' ? d.teamName(st.ownerId) : st.kind === 'roleOwned' ? `${st.role}取得済` : p.rank ?? ''}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <ActionBar message={sel ? `選択中：${sel.name}（${sel.role}）` : '選手を選んでください'} sub={status}>
        <button className="btn" onClick={onShowCumulative}>累計</button>
        <button className="btn btn--primary" disabled={busy || !selected || decided} onClick={decide}>{decided ? '決定済み' : '決定'}</button>
      </ActionBar>
    </>
  );
}

// =============== 運営（進行画面） ===============
export function AdminDraftPage() {
  return <Shell source={{ kind: 'member' }} render={(conn) => <AdminScreen conn={conn} />} />;
}

function AdminScreen({ conn }: { conn: Conn }) {
  const ctx = useDraftOrNull();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmResult, setConfirmResult] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const run = async (path: string, after?: (r: any) => void) => {
    setBusy(true); setError(null);
    try { const r = await api('POST', `/api/admin/draft/${path}`); after?.(r); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const extra = (
    <>
      <ConnBadge conn={conn} />
      {ctx && <button className="btn btn--sm" disabled={busy} onClick={() => run('stream-key', (r) => setStreamUrl(r.url))}>配信用 URL</button>}
      {ctx && <button className="btn btn--quiet" onClick={() => setConfirmReset(true)}>ドラフトを初期化</button>}
      <a className="btn btn--sm" href="/admin" target="_blank" rel="noopener">管理者画面を開く</a>
    </>
  );
  if (!ctx || ctx.view.sessionId === 'none') {
    return (
      <div className="screen">
        <TopBar title="ドラフト開始前" who="運営" extra={extra} />
        {error && <Notice tone="error">{error}</Notice>}
        <main className="screen__main">
          <CenterMessage title="ドラフトの準備">
            <p>参加受付を始めると、大会の参加者（チームとコーチ、ドラフト用ロールを設定した選手）を読み込みます。</p>
            <button className="btn btn--primary btn--large" disabled={busy} onClick={() => run('open-lobby')}>参加受付を開始</button>
          </CenterMessage>
        </main>
      </div>
    );
  }
  const d = ctx;
  const { view, config } = d;
  const joinedCount = view.joined.length;
  const confirmedCount = view.confirmedTeams.length;
  const isRepick = view.phase === 'picking' && view.pickers.length < config.teams.length;
  let bar: ReactNode = null;
  switch (view.phase) {
    case 'lobby':
      bar = <ActionBar message={`${config.teams.length}チーム中${joinedCount}チームが参加済み`} sub={joinedCount < config.teams.length ? '全チームが参加するとドラフトを開始できます' : undefined}>
        <button className="btn btn--primary" disabled={busy || joinedCount < config.teams.length} onClick={() => run('start')}>ドラフト開始</button></ActionBar>;
      break;
    case 'picking':
      bar = <ActionBar message={`${view.pickers.length}チーム中${confirmedCount}チームが確定済み`} sub={isRepick ? `${d.joinNames(view.pickers)}が選び直しています` : confirmedCount < view.pickers.length ? '全チームが確定すると公開できます' : undefined}>
        <button className="btn btn--primary" disabled={busy || confirmedCount < view.pickers.length} onClick={() => run('reveal')}>公開</button></ActionBar>;
      break;
    case 'collision': {
      const next = view.collisions[0];
      bar = <ActionBar message={`被りが${view.collisions.length}件あります`} sub={next ? `次は ${d.playerOf(next.playerId)?.name}（${d.joinNames(next.teamIds)}）` : undefined}>
        <button className="btn btn--primary" disabled={busy} onClick={() => run('roulette-start')}>ルーレット開始</button></ActionBar>;
      break;
    }
    case 'freepick': {
      const fp = view.freePick;
      const chosen = d.playerOf(fp?.playerId);
      bar = <ActionBar message={fp && chosen ? `${d.teamName(fp.teamId)}が${chosen.name}を決定しました` : `${fp ? d.teamName(fp.teamId) : ''}が残りの選手から選んでいます`} sub={chosen ? '確定するまでは、コーチが選び直せます' : undefined}>
        <button className="btn btn--primary" disabled={busy || !chosen} onClick={() => run('freepick-confirm')}>確定</button></ActionBar>;
      break;
    }
    case 'roundResult':
      bar = <ActionBar message={`ラウンド${view.round}の結果が確定しました`}>
        <button className="btn btn--primary" disabled={busy} onClick={() => run('next-round')}>{view.round >= config.totalRounds ? '最終結果を表示' : '次のラウンドへ'}</button></ActionBar>;
      break;
    case 'finished':
      bar = <ActionBar message={view.resultConfirmed ? 'チームへの振り分けを確定しました' : '配信が終わったら、結果を確定してチームに振り分けます'}>
        {!view.resultConfirmed && <button className="btn btn--primary" disabled={busy} onClick={() => setConfirmResult(true)}>結果を確定</button>}</ActionBar>;
      break;
  }
  return (
    <div className="screen">
      <TopBar title={roundLabel(view, config.totalRounds)} who="運営" extra={extra} />
      {error && <Notice tone="error">{error}</Notice>}
      <main className="screen__main">
        {view.phase === 'roulette' && view.roulette ? (
          <RouletteView key={view.roulette.id} renderActions={(finished) => (
            <ActionBar message={finished ? 'ルーレットが終わりました' : '抽選中です'}>
              <button className="btn btn--primary" disabled={busy || !finished} onClick={() => run('roulette-finish')}>次へ</button>
            </ActionBar>)} />
        ) : view.phase === 'finished' ? <><FinalResult />{bar}</> : <><TeamGrid showStatus />{bar}</>}
      </main>
      {confirmReset && <ConfirmDialog title="ドラフトを初期化" message="参加状況、指名、編成、ラウンドの記録をすべて消去し、「未開始」の状態に戻します。配信用 URL も使えなくなります。元に戻すことはできません。"
        confirmLabel="初期化する" onCancel={() => setConfirmReset(false)} onConfirm={() => { setConfirmReset(false); void run('reset'); }} />}
      {confirmResult && <ConfirmDialog title="結果を確定" message="最終結果のとおりに、選手をチームとレーンに振り分けます。確定すると初期化できなくなり、配信用 URL も使えなくなります。"
        confirmLabel="確定する" onCancel={() => setConfirmResult(false)} onConfirm={() => { setConfirmResult(false); void run('confirm-result'); }} />}
      {streamUrl && (
        <Modal title="配信用 URL" onClose={() => setStreamUrl(null)}>
          <p className="modal__text">OBS のブラウザソースに、この URL を貼り付けてください。公開前の指名は表示されません。発行し直すと、前の URL は使えなくなります（24 時間で期限切れ）。</p>
          <p className="stream-url">{streamUrl}</p>
          <div className="modal__actions"><button className="btn btn--primary" onClick={() => navigator.clipboard?.writeText(streamUrl)}>コピー</button></div>
        </Modal>
      )}
    </div>
  );
}

// =============== 配信用画面（OBS のブラウザソース。操作はできない） ===============
export function StreamDraftPage() {
  const key = new URLSearchParams(location.hash.slice(1)).get('key') ?? '';
  if (!key) return <div className="draft-root"><div className="screen"><CenterMessage title="配信用 URL が正しくありません" /></div></div>;
  return <Shell source={{ kind: 'stream', key }} render={() => <StreamScreen />} />;
}

function StreamScreen() {
  const ctx = useDraftOrNull();
  if (!ctx) return <div className="screen"><CenterMessage title="まもなく開始します" /></div>;
  const { view, config } = ctx;
  return (
    <div className="screen">
      <TopBar title={roundLabel(view, config.totalRounds)} who="" />
      <main className="screen__main">
        {view.phase === 'roulette' && view.roulette ? <RouletteView key={view.roulette.id} /> : view.phase === 'finished' ? <FinalResult /> : <TeamGrid showStatus />}
      </main>
    </div>
  );
}
