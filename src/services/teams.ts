/** チームの表示名（名前が無ければ「チーム n」） */
export async function teamNames(db: D1Database, tournamentId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT id, name FROM teams WHERE tournament_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(tournamentId).all<{ id: string; name: string | null }>();
  return new Map(results.map((t, i) => [t.id, t.name ?? `チーム ${i + 1}`]));
}

/** 日本時間の表示（通知文に使う） */
const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
export const jstRange = (s: string, e: string) => `${fmt.format(new Date(s))}〜${fmtTime.format(new Date(e))}`;
/** 日本時間の日付（YYYY-MM-DD）と時刻（HH:MM） */
export const jstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const jstTime = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(11, 16);
/** 日本時間の「日付＋時刻」から UTC の ISO を作る（24:00 は翌日の 0:00） */
export const fromJst = (date: string, time: string) => new Date(new Date(`${date}T00:00:00+09:00`).getTime() + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60000).toISOString();
