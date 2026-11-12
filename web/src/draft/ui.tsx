/** 既存のドラフトシステムの共通部品を移植したもの（チーム単位・ポータルのデータに合わせて変更） */
import { useEffect, useState, type ReactNode } from 'react';
import { markRoulettePlayed, shouldPlayRoulette, useDraft } from './live';
import type { Player, Team, View } from './types';

const ROULETTE_DURATION_MS = 4500;

/** ランクの色（選手アイコンの外枠）。「Silver Ⅱ」のような値の、最初の語で決める */
export const RANK_COLORS: Record<string, string> = {
  Iron: '#888780', Bronze: '#854F0B', Silver: '#85B7EB', Gold: '#EF9F27', Platinum: '#4FB3A8',
  Emerald: '#2E9E5B', Diamond: '#6D8FE0', Master: '#A066C8', Grandmaster: '#D0564A', Challenger: '#F1C40F',
};
const tierOf = (rank: string | null) => rank?.split(' ')[0] ?? '';
const rankColor = (rank: string | null) => RANK_COLORS[tierOf(rank)] ?? 'var(--line)';

function Frame({ src, letter, width, color, title, className = '' }: { src: string | null; letter: string; width: number; color: string; title?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`photo ${className}`} style={{ ['--photo-size' as string]: `${width}px`, borderColor: color }} title={title}>
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <span aria-hidden="true">{letter}</span>}
    </span>
  );
}

export const PlayerPhoto = ({ player, width }: { player: Player; width: number }) => (
  <Frame src={player.iconUrl} letter={[...player.name][0] ?? '?'} width={width} color={rankColor(player.rank)} title={`${player.name}${player.rank ? `（${player.rank}）` : ''}`} />
);

export const TeamPhoto = ({ team, width }: { team: Team; width: number }) => (
  <Frame src={null} letter={[...team.name][0] ?? '?'} width={width} color="var(--gold)" className="photo--coach" title={team.name} />
);

/** チーム名（長い名前でも枠の高さが変わらないよう、文字数に応じて小さくする） */
export function TeamName({ team, base = 26 }: { team: Team; base?: number }) {
  const len = [...team.name].length;
  const ratio = len <= 12 ? 1 : len <= 22 ? 0.92 : len <= 32 ? 0.85 : 0.78;
  return <span className="team-name" style={{ fontSize: Math.round(base * ratio) }}>{team.name}</span>;
}

export function RankLegend() {
  const { config } = useDraft();
  const tiers = Object.keys(RANK_COLORS).filter((t) => config.players.some((p) => tierOf(p.rank) === t));
  if (!tiers.length) return null;
  return (
    <div className="rank-legend" aria-label="ランクの色">
      <span className="rank-legend__title">ランク</span>
      {tiers.map((t) => <span key={t} className="rank-legend__item"><span className="rank-legend__dot" style={{ background: RANK_COLORS[t] }} />{t}</span>)}
    </div>
  );
}

export function roundLabel(view: View | null, totalRounds: number) {
  if (!view || view.round === 0) return 'ドラフト開始前';
  if (view.phase === 'finished') return '最終結果';
  return `ラウンド ${view.round} / ${totalRounds}`;
}

export function TopBar({ title, who, extra }: { title: string; who: string; extra?: ReactNode }) {
  return (
    <header className="topbar">
      <h1 className="topbar__round">{title}</h1>
      <div className="topbar__right"><span className="topbar__who">{who}</span>{extra}</div>
    </header>
  );
}

export const ActionBar = ({ message, sub, children }: { message: ReactNode; sub?: ReactNode; children?: ReactNode }) => (
  <div className="action-bar">
    <div className="action-bar__text"><div className="action-bar__message">{message}</div>{sub && <div className="action-bar__sub">{sub}</div>}</div>
    <div className="action-bar__buttons">{children}</div>
  </div>
);

export const Notice = ({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) => (
  <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
);

export const CenterMessage = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="center-message"><h2>{title}</h2>{children}</div>
);

const Logo = () => <div className="logo-cell logo-cell--empty"><span>Vout</span></div>;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head"><h2>{title}</h2><button className="btn btn--quiet" onClick={onClose} aria-label="閉じる">閉じる</button></div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog(p: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title={p.title} onClose={p.onCancel}>
      <p className="modal__text">{p.message}</p>
      <div className="modal__actions">
        <button className="btn" onClick={p.onCancel} autoFocus>キャンセル</button>
        <button className="btn btn--danger" onClick={p.onConfirm}>{p.confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function CumulativeModal({ me, onClose }: { me?: string; onClose: () => void }) {
  const { config, view, playerOf } = useDraft();
  return (
    <Modal title="ここまでの累計" onClose={onClose}>
      <table className="cumulative">
        <thead><tr><th scope="col">ロール</th>{config.teams.map((t) => <th key={t.id} scope="col" className={t.id === me ? 'is-me' : undefined}>{t.name}</th>)}</tr></thead>
        <tbody>{config.roles.map((role) => (
          <tr key={role}><th scope="row">{role}</th>{config.teams.map((t) => <td key={t.id}>{playerOf(view.teams[t.id]?.[role])?.name ?? '—'}</td>)}</tr>
        ))}</tbody>
      </table>
    </Modal>
  );
}

// ---- チームの枠を並べた表示（運営の進行画面・コーチの結果・配信で共通） ----
const Status = ({ kind, children }: { kind: 'ok' | 'wait' | 'muted'; children: ReactNode }) => <span className={`state state--${kind}`}>{children}</span>;

function PlayerReveal({ playerId, tag }: { playerId: string; tag?: string }) {
  const { playerOf } = useDraft();
  const p = playerOf(playerId);
  if (!p) return <Status kind="muted">不明な選手</Status>;
  return (
    <div className="reveal" key={playerId}>
      <PlayerPhoto player={p} width={96} />
      <div><div className="reveal__role">{p.role}</div><div className="reveal__name">{p.name}</div>{tag && <span className="reveal__tag">{tag}</span>}</div>
    </div>
  );
}

/** showStatus：参加状況・決定状況を出すか（運営と配信）。公開前の指名そのものは、誰の画面にも出さない */
function boxFor(view: View, teamId: string, showStatus: boolean): { content: ReactNode; clash?: boolean } {
  const confirmedPick = view.roundPicks[teamId];
  switch (view.phase) {
    case 'idle': return { content: <Status kind="muted">受付前</Status> };
    case 'lobby': return { content: view.joined.includes(teamId) ? <Status kind="ok">参加済み</Status> : <Status kind="wait">未参加</Status> };
    case 'picking': {
      if (confirmedPick) return { content: <PlayerReveal playerId={confirmedPick} /> };
      if (!view.pickers.includes(teamId)) return { content: <Status kind="muted">—</Status> };
      if (!showStatus) return { content: <Status kind="wait">選び直し中</Status> };
      return { content: view.confirmedTeams.includes(teamId) ? <Status kind="ok">確定済み</Status> : <Status kind="wait">選択中</Status> };
    }
    case 'collision': {
      if (confirmedPick) return { content: <PlayerReveal playerId={confirmedPick} /> };
      const revealed = view.revealed[teamId];
      if (revealed && view.collisions.some((c) => c.teamIds.includes(teamId))) return { content: <PlayerReveal playerId={revealed} tag="被り" />, clash: true };
      return { content: <Status kind="muted">—</Status> };
    }
    case 'freepick': {
      if (confirmedPick) return { content: <PlayerReveal playerId={confirmedPick} /> };
      if (view.freePick?.teamId === teamId) {
        return view.freePick.playerId ? { content: <PlayerReveal playerId={view.freePick.playerId} tag="確定待ち" /> } : { content: <Status kind="wait">選択中</Status> };
      }
      return { content: <Status kind="muted">—</Status> };
    }
    default: return { content: confirmedPick ? <PlayerReveal playerId={confirmedPick} /> : <Status kind="muted">—</Status> };
  }
}

export function TeamGrid({ showStatus = false }: { showStatus?: boolean }) {
  const { config, view } = useDraft();
  return (
    <div className="cells">
      {config.teams.map((t) => {
        const b = boxFor(view, t.id, showStatus);
        return (
          <section key={t.id} className={`cell${b.clash ? ' cell--clash' : ''}`} aria-label={t.name}>
            <div className="cell__side">
              <div className="cell__team"><TeamName team={t} base={18} /></div>
              <TeamPhoto team={t} width={44} />
              <div className="cell__coach">{t.coachNames.join('・') || 'コーチ未定'}</div>
            </div>
            <div className="cell__body">{b.content}</div>
          </section>
        );
      })}
      <div className="cell cell--logo"><Logo /></div>
    </div>
  );
}

// ---- ルーレット（当選は演出の前にサーバーで決まっている。全員の画面が同じ位置で止まる） ----
const BASE_DELAY = 60;
export function RouletteView({ renderActions }: { renderActions?: (finished: boolean) => ReactNode }) {
  const { view, playerOf, teamOf, teamName, joinNames } = useDraft();
  const r = view.roulette!;
  const n = r.candidates.length;
  const winnerIndex = Math.max(0, r.candidates.indexOf(r.winner));
  const [live] = useState(() => shouldPlayRoulette(r.id));
  const [lit, setLit] = useState<number>(live ? 0 : winnerIndex);
  const [finished, setFinished] = useState(!live);
  useEffect(() => {
    if (!live) return;
    const total = n * 6 + winnerIndex;
    const curve = (4 * Math.max(0, ROULETTE_DURATION_MS - total * BASE_DELAY)) / total;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      setLit(i % n);
      if (i >= total) { markRoulettePlayed(r.id); setFinished(true); return; }
      i += 1;
      timer = setTimeout(step, BASE_DELAY + curve * Math.pow(i / total, 3));
    };
    step();
    return () => clearTimeout(timer);
  }, [live, n, winnerIndex, r.id]);
  const player = playerOf(r.playerId);
  const losers = r.candidates.filter((id) => id !== r.winner);
  const remaining = view.collisions.length - 1;
  const nextStep = remaining > 0 ? `${joinNames(losers)}は、残りの被りを処理したあとに選び直します。`
    : losers.length >= 2 ? `${joinNames(losers)}は残りの選手から同時に選び直します。` : `${joinNames(losers)}は残りの選手から自由に選べます。`;
  return (
    <div className="roulette">
      <div className="roulette__target">
        {player && <PlayerPhoto player={player} width={64} />}
        <p><strong>{player?.name ?? '選手'}（{player?.role}）</strong>で被りが発生しました</p>
      </div>
      <div className="roulette__row">
        {r.candidates.map((id, i) => {
          const cls = finished ? (id === r.winner ? 'is-win' : 'is-lose') : i === lit ? 'is-lit' : '';
          const team = teamOf(id);
          return <div key={id} className={`roulette__card ${cls}`}>{team && <TeamPhoto team={team} width={40} />}<span>{teamName(id)}</span></div>;
        })}
      </div>
      <p className="roulette__result" aria-live="polite">{finished ? `${teamName(r.winner)}が${player?.name ?? '選手'}を獲得しました。${nextStep}` : '抽選中…'}</p>
      {renderActions?.(finished)}
    </div>
  );
}

// ---- 最終結果 ----
export function FinalResult() {
  const { config, view, playerOf } = useDraft();
  const n = config.teams.length;
  const rows = Math.ceil(n / 4);
  const perRow = Math.ceil(n / rows);
  const compact = rows > 1;
  const photo = compact ? 52 : 76;
  return (
    <div className={`final${compact ? ' final--compact' : ''}`}>
      <div className="final__grid" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}>
        {config.teams.map((t) => (
          <section key={t.id} className="final__team" aria-label={t.name}>
            <div className="final__teamname"><span className="final__label">チーム</span><TeamName team={t} base={23} /></div>
            <div className="final__row final__row--coach">
              <TeamPhoto team={t} width={photo} />
              <div><div className="final__role">コーチ</div><div className="final__name">{t.coachNames.join('・') || '—'}</div></div>
            </div>
            {config.roles.map((role) => {
              const p = playerOf(view.teams[t.id]?.[role]);
              return (
                <div key={role} className="final__row">
                  {p ? <PlayerPhoto player={p} width={photo} /> : <span className="final__empty" style={{ width: photo }} />}
                  <div><div className="final__role">{role}</div><div className="final__name">{p?.name ?? '—'}</div></div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <RankLegend />
    </div>
  );
}
