import { describe, expect, it } from 'vitest';
import {
  cardStatus, confirmFreePick, createInitialState, DraftError, finishRoulette, isLegalPick, nextRound, openLobby, relayFreePick, reveal,
  secureRandomIndex, startDraft, startRoulette, validateConfig, ROLES, type DraftConfig, type DraftPlayer, type DraftTeam, type GameState, type PrivatePick, type Role,
} from '../src/draft/logic';

/**
 * 既存のドラフトシステムの logic/draft.test.ts を移植したもの（コーチ → チーム、ADC → BOT）。
 * 同じ進行ルールで動くことを確かめる
 */
const T = (id: string, name: string): DraftTeam => ({ id, name, coachNames: [name], coachUserIds: [`u-${id}`] });
const P = (id: string, role: Role): DraftPlayer => ({ id, name: `選手${id}`, role, rank: null, iconImageId: null });
const roleOf = (n: number): Role => (['TOP', 'JG', 'MID', 'BOT', 'SUP'] as const)[Math.floor((n - 1) / 3)]!;
const CONFIG: DraftConfig = {
  teams: [T('fiddler', 'ふぃどらー'), T('setsuna', '月影刹那'), T('kinoko', '食毒茸')],
  players: Array.from({ length: 15 }, (_, i) => P(`p${String(i + 1).padStart(2, '0')}`, roleOf(i + 1))),
  roles: ROLES, totalRounds: 5,
};

const pick = (s: GameState, playerId: string | null, confirmed = true): PrivatePick => ({
  sessionId: s.sessionId,
  pickSeq: s.pickSeq,
  playerId,
  confirmed,
});

const picksOf = (s: GameState, map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([c, p]) => [c, pick(s, p)]));

const started = (cfg: DraftConfig = CONFIG) =>
  startDraft(cfg, openLobby(createInitialState('s1')), cfg.teams.map((c) => c.id));

/** 常に0番目が当選する乱数 */
const first = () => 0;

describe('通常の進行', () => {
  it('被りがなければ、5ラウンドで全員の編成がそろう', () => {
    let s = started();
    const plan: Record<string, string>[] = [
      { fiddler: 'p01', setsuna: 'p05', kinoko: 'p07' },
      { fiddler: 'p11', setsuna: 'p02', kinoko: 'p13' },
      { fiddler: 'p04', setsuna: 'p08', kinoko: 'p03' },
      { fiddler: 'p09', setsuna: 'p10', kinoko: 'p06' },
      { fiddler: 'p14', setsuna: 'p15', kinoko: 'p12' },
    ];
    plan.forEach((round, i) => {
      expect(s.phase).toBe('picking');
      expect(s.round).toBe(i + 1);
      s = reveal(CONFIG, s, picksOf(s, round));
      expect(s.phase).toBe('roundResult');
      expect(s.roundPicks).toEqual(round);
      s = nextRound(CONFIG, s);
    });
    expect(s.phase).toBe('finished');
    expect(s.history).toHaveLength(5);
    for (const coach of CONFIG.teams) {
      expect(Object.keys(s.teams[coach.id]!).sort()).toEqual([...CONFIG.roles].sort());
    }
  });

  it('参加していないコーチがいると開始できない', () => {
    const s = openLobby(createInitialState('s1'));
    expect(() => startDraft(CONFIG, s, ['fiddler', 'setsuna'])).toThrow(/食毒茸/);
  });

  it('未確定のコーチがいると公開できない', () => {
    const s = started();
    const picks = picksOf(s, { fiddler: 'p01', setsuna: 'p05' });
    picks.kinoko = pick(s, 'p07', false);
    expect(() => reveal(CONFIG, s, picks)).toThrow(/食毒茸/);
  });

  it('前回の受付の指名は使わない', () => {
    const s = started();
    const picks = picksOf(s, { fiddler: 'p01', setsuna: 'p05', kinoko: 'p07' });
    picks.kinoko = { ...picks.kinoko!, pickSeq: s.pickSeq - 1 };
    expect(() => reveal(CONFIG, s, picks)).toThrow(DraftError);
  });

  it('自分が持っているロールや、獲得済みの選手は選べない', () => {
    let s = started();
    s = reveal(CONFIG, s, picksOf(s, { fiddler: 'p01', setsuna: 'p05', kinoko: 'p07' }));
    s = nextRound(CONFIG, s);
    const p02 = CONFIG.players.find((p) => p.id === 'p02')!;
    const p05 = CONFIG.players.find((p) => p.id === 'p05')!;
    expect(cardStatus(s, 'fiddler', p02)).toEqual({ kind: 'roleOwned', role: 'TOP' });
    expect(cardStatus(s, 'fiddler', p05)).toEqual({ kind: 'taken', ownerId: 'setsuna' });
    expect(() => reveal(CONFIG, s, picksOf(s, { fiddler: 'p02', setsuna: 'p01', kinoko: 'p08' }))).toThrow(
      /ふぃどらー/,
    );
  });

  it('同じ操作を二重に行うとエラーになる（ボタンの連打対策）', () => {
    const s0 = started();
    const s = reveal(CONFIG, s0, picksOf(s0, { fiddler: 'p01', setsuna: 'p05', kinoko: 'p07' }));
    const s2 = nextRound(CONFIG, s);
    expect(() => nextRound(CONFIG, s2)).toThrow(DraftError);
  });
});

describe('被りの処理', () => {
  it('2人被り：外れた1人は自由選択。決定は即表示され、管理者の確定で終わる', () => {
    let s = started();
    s = reveal(CONFIG, s, picksOf(s, { fiddler: 'p01', setsuna: 'p01', kinoko: 'p07' }));
    expect(s.phase).toBe('collision');
    expect(s.roundPicks).toEqual({ kinoko: 'p07' });
    expect(s.collisions).toEqual([{ playerId: 'p01', teamIds: ['fiddler', 'setsuna'] }]);

    s = startRoulette(s, () => 1, 'r1');
    expect(s.roulette?.winner).toBe('setsuna');
    s = finishRoulette(CONFIG, s);
    expect(s.phase).toBe('freepick');
    expect(s.pickers).toEqual(['fiddler']);
    expect(s.freePick).toEqual({ teamId: 'fiddler', playerId: null });

    // 決定 → 即表示
    const relayed = relayFreePick(CONFIG, s, pick(s, 'p02'));
    expect(relayed?.freePick?.playerId).toBe('p02');
    s = relayed!;
    // 変化がなければ書き込まない
    expect(relayFreePick(CONFIG, s, pick(s, 'p02'))).toBeNull();
    // 決定を取り消すと表示も戻る
    const undone = relayFreePick(CONFIG, s, pick(s, null, false));
    expect(undone?.freePick?.playerId).toBeNull();

    s = confirmFreePick(CONFIG, s);
    expect(s.phase).toBe('roundResult');
    expect(s.roundPicks).toEqual({ kinoko: 'p07', setsuna: 'p01', fiddler: 'p02' });
  });

  it('自由選択で選べない選手を決定しても表示しない', () => {
    let s = started();
    s = reveal(CONFIG, s, picksOf(s, { fiddler: 'p01', setsuna: 'p01', kinoko: 'p07' }));
    s = finishRoulette(CONFIG, startRoulette(s, () => 1, 'r1'));
    expect(relayFreePick(CONFIG, s, pick(s, 'p07'))).toBeNull(); // きのこが獲得済み
    expect(() => confirmFreePick(CONFIG, s)).toThrow(DraftError);
  });

  it('3人被り：外れた2人は非公開で選び直し、また被ったらルーレット、最後の1人は自由選択', () => {
    let s = started();
    s = reveal(CONFIG, s, picksOf(s, { fiddler: 'p01', setsuna: 'p01', kinoko: 'p01' }));
    s = finishRoulette(CONFIG, startRoulette(s, () => 2, 'r1'));
    expect(s.teams.kinoko).toEqual({ TOP: 'p01' });
    expect(s.phase).toBe('picking');
    expect(s.pickers).toEqual(['fiddler', 'setsuna']);

    // 選び直しでまた被る
    s = reveal(CONFIG, s, picksOf(s, { fiddler: 'p05', setsuna: 'p05' }));
    expect(s.phase).toBe('collision');
    s = finishRoulette(CONFIG, startRoulette(s, first, 'r2'));
    expect(s.phase).toBe('freepick');
    expect(s.freePick?.teamId).toBe('setsuna');

    s = relayFreePick(CONFIG, s, pick(s, 'p08'))!;
    s = confirmFreePick(CONFIG, s);
    expect(s.roundPicks).toEqual({ kinoko: 'p01', fiddler: 'p05', setsuna: 'p08' });
  });

  it('3人被りの選び直しで被らなければ、そのままラウンド結果', () => {
    let s = started();
    s = reveal(CONFIG, s, picksOf(s, { fiddler: 'p01', setsuna: 'p01', kinoko: 'p01' }));
    s = finishRoulette(CONFIG, startRoulette(s, first, 'r1'));
    // 獲得済みの p01 は選べない
    expect(isLegalPick(CONFIG, s, 'setsuna', 'p01')).toBe(false);
    s = reveal(CONFIG, s, picksOf(s, { setsuna: 'p02', kinoko: 'p13' }));
    expect(s.phase).toBe('roundResult');
    expect(s.roundPicks).toEqual({ fiddler: 'p01', setsuna: 'p02', kinoko: 'p13' });
  });
});

describe('チームが増えた場合', () => {
  const roles: Role[] = ['TOP', 'JG', 'MID', 'BOT', 'SUP'];
  const teams = ['a', 'b', 'c', 'd'].map((id) => T(id, id.toUpperCase()));
  const players = roles.flatMap((role) => [1, 2, 3, 4].map((n) => P(`${role}${n}`, role)));
  const cfg4: DraftConfig = { teams, players, roles, totalRounds: 5 };

  it('設定の検証を通る', () => {
    expect(validateConfig(cfg4)).toEqual([]);
  });

  it('別々の被りが2つ：順番にルーレットを行い、外れた2人がまとめて選び直す', () => {
    let s = started(cfg4);
    s = reveal(cfg4, s, picksOf(s, { a: 'TOP1', b: 'TOP1', c: 'MID1', d: 'MID1' }));
    expect(s.collisions.map((c) => c.playerId)).toEqual(['TOP1', 'MID1']);

    s = finishRoulette(cfg4, startRoulette(s, first, 'r1'));
    expect(s.phase).toBe('collision');
    expect(s.losers).toEqual(['b']);
    s = finishRoulette(cfg4, startRoulette(s, () => 1, 'r2'));
    expect(s.phase).toBe('picking');
    expect(s.pickers).toEqual(['b', 'c']);
    expect(s.teams).toEqual({ a: { TOP: 'TOP1' }, d: { MID: 'MID1' } });
  });
});

describe('ランダムなドラフトを繰り返しても、途中で選べなくなることはない', () => {
  it('500回のシミュレーション', () => {
    const rand = (n: number) => Math.floor(Math.random() * n);
    for (let t = 0; t < 500; t++) {
      let s = started();
      let guard = 0;
      while (s.phase !== 'finished') {
        if (++guard > 200) throw new Error('終わらない');
        if (s.phase === 'picking' || s.phase === 'freepick') {
          const map: Record<string, string> = {};
          for (const c of s.pickers) {
            const legal = CONFIG.players.filter((p) => isLegalPick(CONFIG, s, c, p.id));
            expect(legal.length).toBeGreaterThan(0);
            map[c] = legal[rand(legal.length)]!.id;
          }
          if (s.phase === 'picking') s = reveal(CONFIG, s, picksOf(s, map));
          else s = confirmFreePick(CONFIG, relayFreePick(CONFIG, s, pick(s, map[s.pickers[0]!]!))!);
        } else if (s.phase === 'collision') s = startRoulette(s, rand, `r${guard}`);
        else if (s.phase === 'roulette') s = finishRoulette(CONFIG, s);
        else if (s.phase === 'roundResult') s = nextRound(CONFIG, s);
      }
      const all = Object.values(s.teams).flatMap((t) => Object.values(t));
      expect(new Set(all).size).toBe(CONFIG.players.length);
    }
  });
});

describe('設定の検証', () => {
  it('現在の設定は問題なし', () => {
    expect(validateConfig(CONFIG)).toEqual([]);
  });

  it('ロールの人数が合わないとエラー', () => {
    const cfg = { ...CONFIG, players: CONFIG.players.filter((p) => p.id !== 'p15') };
    expect(validateConfig(cfg)).toEqual(['SUP の選手が 2 人です（チーム数 3 と同じ人数が必要）']);
  });

  it('id の重複を検出', () => {
    const cfg = { ...CONFIG, players: [...CONFIG.players.slice(0, 14), { ...CONFIG.players[14]!, id: 'p01' }] };
    expect(validateConfig(cfg).some((e) => e.includes('重複'))).toBe(true);
  });
});

describe('乱数', () => {
  it('0〜n-1の範囲で、偏りなく出る', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[secureRandomIndex(3)]!++;
    counts.forEach((c) => expect(c).toBeGreaterThan(9000));
  });
});
