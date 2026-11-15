import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { writeAudit } from '../../services/audit';
import { isHHMM } from '../../services/overlap';
import { jstDate } from '../../services/teams';
import { getCurrentTournament } from '../../services/tournament';

/** 予定表の日程の用意（F-05：管理者） */
export const scheduleAdmin = new Hono<AppEnv>();

function times(b: Record<string, unknown>) {
  if (!isHHMM(b.stdStart) || !isHHMM(b.stdEnd) || b.stdStart === '24:00' || b.stdStart >= b.stdEnd) throw new HttpError(422, 'invalid_time', '標準の時間帯を 30 分刻みで入力してください');
  return { s: b.stdStart, e: b.stdEnd };
}

/** 日程をまとめて登録する（スクリム期間内の日付だけ。すでにある日付は標準の時間帯を上書き） */
scheduleAdmin.post('/schedule/slots', async (c) => {
  const t = await getCurrentTournament(c.env.DB);
  if (!t) throw new HttpError(409, 'no_tournament');
  if (!t.scrim_start || !t.scrim_end) throw new HttpError(409, 'no_scrim_period', '先に大会設定でスクリム期間を設定してください');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { s, e } = times(b);
  if (!Array.isArray(b.dates) || !b.dates.length || b.dates.length > 60) throw new HttpError(422, 'invalid_dates', '日付を選んでください');
  const first = jstDate(t.scrim_start);
  const last = jstDate(t.scrim_end);
  const ts = nowIso();
  const stmts = b.dates.map((d) => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(422, 'invalid_dates');
    if (d < first || d > last) throw new HttpError(422, 'out_of_period', `${d} はスクリム期間（${first}〜${last}）の外です`);
    return c.env.DB.prepare('INSERT INTO schedule_slots (id, tournament_id, date, std_start, std_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tournament_id, date) DO UPDATE SET std_start = excluded.std_start, std_end = excluded.std_end, updated_at = excluded.updated_at')
      .bind(ulid(), t.id, d, s, e, ts, ts);
  });
  await c.env.DB.batch(stmts);
  await writeAudit(c.env.DB, c.get('user')!.id, 'schedule_slots_set', { type: 'tournament', id: t.id }, { count: stmts.length });
  return c.json({ ok: true, count: stmts.length });
});

scheduleAdmin.delete('/schedule/slots/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM schedule_slots WHERE id = ?').bind(c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'schedule_slot_delete', { type: 'slot', id: c.req.param('id') });
  return c.json({ ok: true });
});
