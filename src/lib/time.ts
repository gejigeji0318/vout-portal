/** 現在時刻（UTC の ISO 文字列）。テストで差し替えられるように関数にしておく */
let clock: () => Date = () => new Date();
export const now = (): Date => clock();
export const nowIso = (): string => clock().toISOString();
export const setClockForTest = (fn: (() => Date) | null): void => {
  clock = fn ?? (() => new Date());
};
export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
