import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { validateHttpsUrl, validateIsoDate, validateText, STREAM_HOSTS } from '../../lib/validate';
import { writeAudit } from '../../services/audit';
import { DRAFT_STARTED_PHASES, getCurrentTournament } from '../../services/tournament';

export const tournamentAdmin = new Hono<AppEnv>();

const PHASES = ['preparing', 'recruiting', 'selecting', 'drafting', 'scrim', 'main'];

function validateTeamCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 2 || v > 16) throw new HttpError(422, 'invalid_team_count', '参加チーム数は 2〜16 です');
  return v;
}

async function createTeams(db: D1Database, tournamentId: string, count: number): Promise<void> {
  const t = nowIso();
  const stmts = Array.from({ length: count }, () =>
    db.prepare('INSERT INTO teams (id, tournament_id, created_at, updated_at) VALUES (?,?,?,?)').bind(ulid(), tournamentId, t, t),
  );
  if (stmts.length) await db.batch(stmts);
}

tournamentAdmin.get('/tournament', async (c) => {
  const t = await getCurrentTournament(c.env.DB);
  return c.json({ tournament: t ?? null });
});

tournamentAdmin.post('/tournament', async (c) => {
  if (await getCurrentTournament(c.env.DB)) throw new HttpError(409, 'tournament_exists', '開催中の大会があります');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = validateText(b.name, 'name', 60, true)!;
  const periodStart = validateIsoDate(b.periodStart, 'period_start', true)!;
  const periodEnd = validateIsoDate(b.periodEnd, 'period_end', true)!;
  if (periodStart >= periodEnd) throw new HttpError(422, 'invalid_period', '大会期間の終了は開始より後にしてください');
  const teamCount = validateTeamCount(b.teamCount);
  const id = ulid();
  const t = nowIso();
  await c.env.DB.prepare('INSERT INTO tournaments (id, name, period_start, period_end, team_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, name, periodStart, periodEnd, teamCount, t, t)
    .run();
  await createTeams(c.env.DB, id, teamCount);
  await writeAudit(c.env.DB, c.get('user')!.id, 'tournament_create', { type: 'tournament', id });
  return c.json({ id }, 201);
});

tournamentAdmin.patch('/tournament/:id', async (c) => {
  const id = c.req.param('id');
  const cur = await getCurrentTournament(c.env.DB);
  if (!cur || cur.id !== id) throw new HttpError(404, 'not_found');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if ('name' in b) put('name', validateText(b.name, 'name', 60, true));
  if ('periodStart' in b) put('period_start', validateIsoDate(b.periodStart, 'period_start', true));
  if ('periodEnd' in b) put('period_end', validateIsoDate(b.periodEnd, 'period_end', true));
  if ('scrimStart' in b) put('scrim_start', validateIsoDate(b.scrimStart, 'scrim_start'));
  if ('scrimEnd' in b) put('scrim_end', validateIsoDate(b.scrimEnd, 'scrim_end'));
  if ('scheduleDeadline' in b) put('schedule_deadline', validateIsoDate(b.scheduleDeadline, 'schedule_deadline'));
  if ('phase' in b) {
    if (typeof b.phase !== 'string' || !PHASES.includes(b.phase)) throw new HttpError(422, 'invalid_phase');
    put('phase', b.phase); // 大会終了（ended）は二人承認の手続きでのみ行う
  }
  if ('teamCount' in b) {
    const next = validateTeamCount(b.teamCount);
    if (DRAFT_STARTED_PHASES.has(cur.phase)) throw new HttpError(409, 'draft_started', 'ドラフト開始後はチーム数を変更できません');
    await changeTeamCount(c.env.DB, cur.id, cur.team_count, next);
    put('team_count', next);
  }
  if (sets.length === 0) throw new HttpError(400, 'nothing_to_update');
  put('updated_at', nowIso());
  await c.env.DB.prepare(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'tournament_update', { type: 'tournament', id }, { fields: Object.keys(b) });
  return c.json({ ok: true });
});

/** チーム数の変更。減らすときは、コーチが割り当てられていないチーム枠だけを消せる（F-03） */
async function changeTeamCount(db: D1Database, tournamentId: string, current: number, next: number): Promise<void> {
  if (next > current) return createTeams(db, tournamentId, next - current);
  if (next === current) return;
  const { results } = await db
    .prepare(
      `SELECT t.id FROM teams t
       WHERE t.tournament_id = ? AND t.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM tournament_members m WHERE m.team_id = t.id AND m.member_type = 'coach' AND m.deleted_at IS NULL)
       ORDER BY t.created_at DESC`,
    )
    .bind(tournamentId)
    .all<{ id: string }>();
  const removable = results.slice(0, current - next);
  if (removable.length < current - next) {
    throw new HttpError(409, 'coach_assigned', 'コーチが割り当てられたチーム枠は削除できません。先に割り当てを外してください');
  }
  const t = nowIso();
  await db.batch(removable.map((r) => db.prepare('UPDATE teams SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(t, t, r.id)));
}

tournamentAdmin.get('/teams', async (c) => {
  const cur = await getCurrentTournament(c.env.DB);
  if (!cur) return c.json({ teams: [] });
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name,
       (SELECT COUNT(*) FROM tournament_members m WHERE m.team_id = t.id AND m.member_type = 'coach' AND m.deleted_at IS NULL) AS coaches,
       (SELECT COUNT(*) FROM tournament_members m WHERE m.team_id = t.id AND m.member_type = 'player' AND m.deleted_at IS NULL) AS players
     FROM teams t WHERE t.tournament_id = ? AND t.deleted_at IS NULL ORDER BY t.created_at`,
  ).bind(cur.id).all();
  return c.json({ teams: results });
});

/** 管理者によるチーム名の修正（コーチによる命名は段階 5） */
tournamentAdmin.patch('/teams/:id', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = validateText(b.name, 'name', 30);
  const r = await c.env.DB.prepare('UPDATE teams SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(name, nowIso(), c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'team_rename', { type: 'team', id: c.req.param('id') });
  return c.json({ ok: true });
});

// ---- 本番日程・配信日程 ----
tournamentAdmin.get('/events', async (c) => {
  const cur = await getCurrentTournament(c.env.DB);
  if (!cur) return c.json({ events: [] });
  const { results } = await c.env.DB.prepare('SELECT id, kind, title, starts_at, ends_at, url FROM events WHERE tournament_id = ? ORDER BY starts_at').bind(cur.id).all();
  return c.json({ events: results });
});

function readEvent(b: Record<string, unknown>) {
  if (b.kind !== 'main' && b.kind !== 'stream') throw new HttpError(422, 'invalid_kind');
  const startsAt = validateIsoDate(b.startsAt, 'starts_at', true)!;
  const endsAt = validateIsoDate(b.endsAt, 'ends_at', true)!;
  if (startsAt >= endsAt) throw new HttpError(422, 'invalid_period', '終了は開始より後にしてください');
  return { kind: b.kind, title: validateText(b.title, 'title', 40, true)!, startsAt, endsAt, url: validateHttpsUrl(b.url, 'url', STREAM_HOSTS) };
}

tournamentAdmin.post('/events', async (c) => {
  const cur = await getCurrentTournament(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_tournament');
  const e = readEvent((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  const id = ulid();
  const t = nowIso();
  await c.env.DB.prepare('INSERT INTO events (id, tournament_id, kind, title, starts_at, ends_at, url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, cur.id, e.kind, e.title, e.startsAt, e.endsAt, e.url, t, t).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'event_create', { type: 'event', id });
  return c.json({ id }, 201);
});

tournamentAdmin.put('/events/:id', async (c) => {
  const e = readEvent((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  const r = await c.env.DB.prepare('UPDATE events SET kind=?, title=?, starts_at=?, ends_at=?, url=?, updated_at=? WHERE id = ?')
    .bind(e.kind, e.title, e.startsAt, e.endsAt, e.url, nowIso(), c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'event_update', { type: 'event', id: c.req.param('id') });
  return c.json({ ok: true });
});

tournamentAdmin.delete('/events/:id', async (c) => {
  const r = await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'event_delete', { type: 'event', id: c.req.param('id') });
  return c.json({ ok: true });
});
