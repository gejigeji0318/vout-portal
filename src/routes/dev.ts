import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { createSession, sessionCookie } from '../auth/session';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { nowIso } from '../lib/time';
import { writeAudit } from '../services/audit';
import { getCurrentTournament } from '../services/tournament';

/**
 * 開発・テスト用：立場を切り替えてログインする（本番では存在しない扱い）。
 *  - 開発（ENVIRONMENT=development）：PC の中（localhost）からの接続だけ
 *  - テスト環境（ENVIRONMENT=test）：管理者だけ
 *  - 本番：常に 404。ルート自体が無いのと同じ応答にする
 * テスト用アカウントの Discord ID は "test-" で始まり、本物の Discord ID（数字のみ）とは重ならない
 */
export const devRoutes = new Hono<AppEnv>();

interface Persona { key: string; label: string; memberType: 'player' | 'coach' | 'staff' | null; team: number | null; lane: string | null; adminLevel: 'none' | 'sub' | 'super' }
export const PERSONAS: Persona[] = [
  { key: 'viewer', label: '登録済み閲覧者', memberType: null, team: null, lane: null, adminLevel: 'none' },
  { key: 'player-a-top', label: '選手（チーム1・TOP）', memberType: 'player', team: 0, lane: 'TOP', adminLevel: 'none' },
  { key: 'player-a-mid', label: '選手（チーム1・MID）', memberType: 'player', team: 0, lane: 'MID', adminLevel: 'none' },
  { key: 'player-b-mid', label: '選手（チーム2・MID）', memberType: 'player', team: 1, lane: 'MID', adminLevel: 'none' },
  { key: 'coach-a', label: 'コーチ（チーム1）', memberType: 'coach', team: 0, lane: null, adminLevel: 'none' },
  { key: 'coach-b', label: 'コーチ（チーム2）', memberType: 'coach', team: 1, lane: null, adminLevel: 'none' },
  { key: 'staff', label: '補助スタッフ', memberType: 'staff', team: null, lane: null, adminLevel: 'none' },
  { key: 'sub', label: '補助管理者', memberType: null, team: null, lane: null, adminLevel: 'sub' },
  { key: 'super', label: '全体管理者', memberType: null, team: null, lane: null, adminLevel: 'super' },
];

const isLocal = (c: Context<AppEnv>) => { const h = new URL(c.req.url).hostname; return h === 'localhost' || h === '127.0.0.1'; };

/** 使えるかどうか。使えないときは、本番と同じく「存在しない」応答にする */
function assertAvailable(c: Context<AppEnv>) {
  const env = c.env.ENVIRONMENT;
  if (env === 'development' && isLocal(c)) return;
  if (env === 'test' && c.get('user') && c.get('user')!.adminLevel !== 'none') return;
  throw new HttpError(404, 'not_found');
}

/** テスト環境では、管理者権限を持つテスト用アカウントにはならせない（本物の管理者に限る） */
const personasFor = (c: Context<AppEnv>) => (c.env.ENVIRONMENT === 'development' ? PERSONAS : PERSONAS.filter((p) => p.adminLevel === 'none'));

devRoutes.get('/personas', (c) => {
  assertAvailable(c);
  return c.json({ personas: personasFor(c).map((p) => ({ key: p.key, label: p.label })) });
});

devRoutes.post('/login-as', async (c) => {
  assertAvailable(c);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = personasFor(c).find((x) => x.key === b.persona);
  if (!p) throw new HttpError(422, 'invalid_persona');
  const db = c.env.DB;
  const t = nowIso();
  const discordId = `test-${p.key}`;
  let user = await db.prepare('SELECT id FROM users WHERE discord_user_id = ?').bind(discordId).first<{ id: string }>();
  if (!user) {
    user = { id: ulid() };
    await db.prepare('INSERT INTO users (id, discord_user_id, discord_name, admin_level, last_login_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(user.id, discordId, `${p.label}（テスト）`, p.adminLevel, t, t, t).run();
  }
  await db.prepare('UPDATE users SET admin_level = ?, suspended_at = NULL, last_login_at = ? WHERE id = ?').bind(p.adminLevel, t, user.id).run();
  // 大会での立場を、選んだものに合わせる
  const tour = await getCurrentTournament(db);
  if (tour) {
    await db.prepare('DELETE FROM tournament_members WHERE tournament_id = ? AND user_id = ?').bind(tour.id, user.id).run();
    if (p.memberType) {
      const { results: teams } = await db.prepare('SELECT id FROM teams WHERE tournament_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(tour.id).all<{ id: string }>();
      const teamId = p.team === null ? null : teams[p.team]?.id ?? null;
      await db.prepare('INSERT INTO tournament_members (id, tournament_id, user_id, member_type, team_id, lane, draft_role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(ulid(), tour.id, user.id, p.memberType, teamId, p.lane, p.lane, t, t).run();
    }
  }
  const actor = c.get('user');
  await writeAudit(db, actor?.id ?? null, 'dev_login_as', { type: 'user', id: user.id }, { persona: p.key });
  const { token, expiresAt } = await createSession(db, user.id, p.adminLevel);
  c.header('Set-Cookie', sessionCookie(token, expiresAt), { append: true });
  return c.json({ ok: true });
});

/**
 * ドラフトを試すための見本データ（開発・テスト環境だけ）：
 * 大会が無ければ 2 チームで作り、チーム 1・2 にテスト用コーチ、各ロール 2 人ずつのテスト用選手を用意する
 */
devRoutes.post('/seed-draft', async (c) => {
  assertAvailable(c);
  const db = c.env.DB;
  const t = nowIso();
  let tour = await getCurrentTournament(db);
  if (!tour) {
    const id = ulid();
    await db.prepare("INSERT INTO tournaments (id, name, phase, period_start, period_end, team_count, created_at, updated_at) VALUES (?,?,'selecting',?,?,2,?,?)")
      .bind(id, 'テスト大会', t, new Date(Date.now() + 60 * 86400e3).toISOString(), t, t).run();
    for (let i = 0; i < 2; i++) await db.prepare('INSERT INTO teams (id, tournament_id, created_at, updated_at) VALUES (?,?,?,?)').bind(ulid(), id, new Date(Date.now() + i).toISOString(), t).run();
    tour = (await getCurrentTournament(db))!;
  }
  const { results: teams } = await db.prepare('SELECT id FROM teams WHERE tournament_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(tour.id).all<{ id: string }>();
  const ensureUser = async (key: string, name: string) => {
    let u = await db.prepare('SELECT id FROM users WHERE discord_user_id = ?').bind(`test-${key}`).first<{ id: string }>();
    if (!u) {
      u = { id: ulid() };
      await db.prepare('INSERT INTO users (id, discord_user_id, discord_name, last_login_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(u.id, `test-${key}`, `${name}（テスト）`, t, t, t).run();
    }
    await db.prepare('DELETE FROM tournament_members WHERE tournament_id = ? AND user_id = ?').bind(tour!.id, u.id).run();
    return u.id;
  };
  for (const [i, key] of (['coach-a', 'coach-b'] as const).entries()) {
    const uid = await ensureUser(key, PERSONAS.find((p) => p.key === key)!.label);
    await db.prepare("INSERT INTO tournament_members (id, tournament_id, user_id, member_type, team_id, created_at, updated_at) VALUES (?,?,?,'coach',?,?,?)").bind(ulid(), tour.id, uid, teams[i]?.id ?? null, t, t).run();
  }
  let n = 0;
  for (const role of ['TOP', 'JG', 'MID', 'BOT', 'SUP']) for (let k = 1; k <= teams.length; k++) {
    const uid = await ensureUser(`draft-${role}${k}`, `${role}${k}`);
    await db.prepare("INSERT INTO tournament_members (id, tournament_id, user_id, member_type, draft_role, created_at, updated_at) VALUES (?,?,?,'player',?,?,?)").bind(ulid(), tour.id, uid, role, t, t).run();
    n++;
  }
  await writeAudit(db, c.get('user')?.id ?? null, 'dev_seed_draft', { type: 'tournament', id: tour.id });
  return c.json({ ok: true, tournamentId: tour.id, teams: teams.length, players: n });
});

/**
 * スクリムを試すための見本データ（開発・テスト環境だけ）：
 * 今日からの 2 週間をスクリム期間にし、チーム 1・2 に選手 5 人ずつ（テスト用）を所属させ、
 * 1 週間分の日程と、いろいろな ○△× の入力を用意する
 */
devRoutes.post('/seed-scrim', async (c) => {
  assertAvailable(c);
  const db = c.env.DB;
  const t = nowIso();
  let tour = await getCurrentTournament(db);
  if (!tour) {
    const id = ulid();
    await db.prepare("INSERT INTO tournaments (id, name, phase, period_start, period_end, team_count, created_at, updated_at) VALUES (?,?,'scrim',?,?,2,?,?)")
      .bind(id, 'テスト大会', t, new Date(Date.now() + 60 * 86400e3).toISOString(), t, t).run();
    for (let i = 0; i < 2; i++) await db.prepare('INSERT INTO teams (id, tournament_id, created_at, updated_at) VALUES (?,?,?,?)').bind(ulid(), id, new Date(Date.now() + i).toISOString(), t).run();
    tour = (await getCurrentTournament(db))!;
  }
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const day = (n: number) => new Date(new Date(`${today}T12:00:00+09:00`).getTime() + n * 86400e3 + 9 * 3600e3).toISOString().slice(0, 10);
  await db.prepare("UPDATE tournaments SET phase = 'scrim', scrim_start = ?, scrim_end = ?, updated_at = ? WHERE id = ?")
    .bind(new Date(`${today}T00:00:00+09:00`).toISOString(), new Date(`${day(13)}T00:00:00+09:00`).toISOString(), t, tour.id).run();
  const { results: teams } = await db.prepare('SELECT id FROM teams WHERE tournament_id = ? AND deleted_at IS NULL ORDER BY created_at').bind(tour.id).all<{ id: string }>();
  const ensure = async (key: string, name: string, type: 'player' | 'coach', teamId: string, lane: string | null) => {
    let u = await db.prepare('SELECT id FROM users WHERE discord_user_id = ?').bind(`test-${key}`).first<{ id: string }>();
    if (!u) { u = { id: ulid() }; await db.prepare('INSERT INTO users (id, discord_user_id, discord_name, last_login_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(u.id, `test-${key}`, `${name}（テスト）`, t, t, t).run(); }
    await db.prepare('DELETE FROM tournament_members WHERE tournament_id = ? AND user_id = ?').bind(tour!.id, u.id).run();
    await db.prepare('INSERT INTO tournament_members (id, tournament_id, user_id, member_type, team_id, lane, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(ulid(), tour!.id, u.id, type, teamId, lane, t, t).run();
    return u.id;
  };
  const lanes = ['TOP', 'JG', 'MID', 'BOT', 'SUP'];
  const players: { id: string; team: number; i: number }[] = [];
  for (const [ti, team] of teams.slice(0, 2).entries()) {
    await ensure(['coach-a', 'coach-b'][ti]!, PERSONAS.find((p) => p.key === ['coach-a', 'coach-b'][ti])!.label, 'coach', team.id, null);
    for (const [i, lane] of lanes.entries()) players.push({ id: await ensure(`scrim-${ti + 1}-${lane}`, `チーム${ti + 1}の${lane}`, 'player', team.id, lane), team: ti, i });
  }
  // 日程（今日から 7 日）と入力：日によって、そろう人数が変わるようにする
  for (let n = 0; n < 7; n++) {
    const date = day(n);
    await db.prepare('INSERT INTO schedule_slots (id, tournament_id, date, std_start, std_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tournament_id, date) DO NOTHING')
      .bind(ulid(), tour.id, date, '21:00', '24:00', t, t).run();
    const slot = (await db.prepare('SELECT id FROM schedule_slots WHERE tournament_id = ? AND date = ?').bind(tour.id, date).first<{ id: string }>())!;
    for (const p of players) {
      const absent = (p.i + n + p.team) % 7 === 0 || (n === 2 && p.i < 2);
      const status = absent ? 'x' : (p.i + n) % 5 === 0 ? 't' : 'o';
      const start = status === 'x' ? null : status === 't' ? '22:00' : n % 2 ? '20:00' : '21:00';
      const end = status === 'x' ? null : status === 't' ? '23:00' : '24:00';
      await db.prepare('INSERT INTO availabilities (id, slot_id, user_id, status, start_time, end_time, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(slot_id, user_id) DO UPDATE SET status = excluded.status, start_time = excluded.start_time, end_time = excluded.end_time')
        .bind(ulid(), slot.id, p.id, status, start, end, t, t).run();
    }
  }
  await writeAudit(db, c.get('user')?.id ?? null, 'dev_seed_scrim', { type: 'tournament', id: tour.id });
  return c.json({ ok: true, players: players.length, days: 7 });
});
