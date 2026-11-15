import { describe, expect, it } from 'vitest';
import { commonWindow, overlap } from '../src/services/overlap';

const o = (start: string, end: string) => ({ status: 'o' as const, start, end });
const t = (start: string, end: string) => ({ status: 't' as const, start, end });
const x = { status: 'x' as const, start: null, end: null };

describe('同じ時間にそろう人数（予定表の色分け）', () => {
  it('5 人が 21:00〜23:00 にそろうなら「21:00〜23:00 に 5 人」', () => {
    const r = overlap([o('20:00', '24:00'), o('21:00', '23:00'), o('21:00', '24:00'), o('19:00', '23:00'), o('21:00', '23:30')]);
    expect([r.count, r.window]).toEqual([5, ['21:00', '23:00']]);
  });

  it('全員が○でも時間がずれていれば、同時にそろう人数で数える', () => {
    const r = overlap([o('19:00', '21:00'), o('21:00', '23:00'), o('19:00', '23:00')]);
    expect(r.count).toBe(2);
  });

  it('△ を含めると増える場合は、その人数と時間帯も出す。× は数えない', () => {
    const r = overlap([o('21:00', '24:00'), o('21:00', '24:00'), o('21:00', '24:00'), o('21:00', '24:00'), t('22:00', '23:00'), x]);
    expect([r.count, r.countWithT, r.windowWithT]).toEqual([4, 5, ['22:00', '23:00']]);
  });

  it('同じ人数の時間帯が 2 つあれば、長く続くほうを出す', () => {
    const r = overlap([o('19:00', '20:00'), o('19:00', '20:00'), o('21:00', '23:00'), o('21:00', '23:00')]);
    expect(r.window).toEqual(['21:00', '23:00']);
  });

  it('誰も入力していなければ 0 人', () => {
    expect(overlap([]).count).toBe(0);
    expect(overlap([x]).window).toBeNull();
  });

  it('2 チームの両方がそろう時間帯は、それぞれの時間帯の重なり', () => {
    const a = overlap([o('20:00', '23:00')]);
    const b = overlap([o('21:00', '24:00')]);
    expect(commonWindow(a, b)).toEqual(['21:00', '23:00']);
    expect(commonWindow(overlap([o('19:00', '20:00')]), b)).toBeNull();
  });
});
