/**
 * 予定表の「同じ時間に何人そろうか」の計算（F-05 の色分けとスクリムの候補提示に使う）。
 * 時刻は 30 分刻みの "HH:MM"（24:00 まで）。○ の人だけで数えた人数と、△ も含めた人数を出す
 */
export interface Entry { status: 'o' | 't' | 'x'; start: string | null; end: string | null }
export interface Overlap {
  /** ○ の人が同時にそろう最大の人数と、その時間帯（いちばん長く続くもの） */
  count: number; window: [string, string] | null;
  /** △ も含めたときの最大の人数と時間帯（○ だけより増えるときに補足として出す） */
  countWithT: number; windowWithT: [string, string] | null;
}

export const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h! * 60 + m!; };
export const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function best(entries: Entry[], include: (e: Entry) => boolean): { count: number; window: [string, string] | null } {
  const use = entries.filter((e) => include(e) && e.start && e.end);
  let count = 0;
  let window: [string, string] | null = null;
  let bestLen = 0;
  // 30 分ごとの区間で、そこにいる人数を数える
  const counts: number[] = [];
  for (let s = 0; s < 48; s++) counts.push(use.filter((e) => toMin(e.start!) <= s * 30 && s * 30 + 30 <= toMin(e.end!)).length);
  const max = Math.max(0, ...counts);
  if (max === 0) return { count: 0, window: null };
  for (let s = 0; s < 48; s++) {
    if (counts[s] !== max) continue;
    let e = s;
    while (e + 1 < 48 && counts[e + 1] === max) e++;
    if (e - s + 1 > bestLen) { bestLen = e - s + 1; window = [toHHMM(s * 30), toHHMM(e * 30 + 30)]; count = max; }
    s = e;
  }
  return { count, window };
}

export function overlap(entries: Entry[]): Overlap {
  const o = best(entries, (e) => e.status === 'o');
  const ot = best(entries, (e) => e.status === 'o' || e.status === 't');
  return { count: o.count, window: o.window, countWithT: ot.count, windowWithT: ot.window };
}

/** 2 チームの両方がそろう時間帯（スクリムの候補）。それぞれの ○ の時間帯の重なり */
export function commonWindow(a: Overlap, b: Overlap): [string, string] | null {
  if (!a.window || !b.window) return null;
  const s = Math.max(toMin(a.window[0]), toMin(b.window[0]));
  const e = Math.min(toMin(a.window[1]), toMin(b.window[1]));
  return e > s ? [toHHMM(s), toHHMM(e)] : null;
}

const HHMM = /^(?:[01]\d|2[0-3]):(?:00|30)$|^24:00$/;
export const isHHMM = (t: unknown): t is string => typeof t === 'string' && HHMM.test(t);
