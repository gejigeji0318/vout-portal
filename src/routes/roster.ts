import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { getViewer } from '../services/audience';
import { signedImageUrl } from '../services/imageStore';
import { getCurrentTournament } from '../services/tournament';
import { teamNames } from '../services/teams';

/**
 * 大会参加者一覧（F-14）とチーム紹介（F-12）。どちらも公開ページ。
 * 宣材写真・X・配信 URL は、本人がマイページで「公開する」を選んだものだけを出す
 */
export const rosterRoutes = new Hono<AppEnv>();
const LANE_ORDER = ['TOP', 'JG', 'MID', 'BOT', 'SUP'];

interface Row {
  user_id: string; name: string; member_type: string; team_id: string | null; lane: string | null; draft_role: string | null;
  publish_photo: number; publish_x: number; publish_stream: number; photo_image_id: string | null; x_account: string | null; stream_urls: string | null; rank: string | null;
}

async function members(db: D1Database, tid: string): Promise<Row[]> {
  const { results } = await db.prepare(
    `SELECT m.user_id, COALESCE(u.display_name, u.discord_name) AS name, m.member_type, m.team_id, m.lane, m.draft_role,
       m.publish_photo, m.publish_x, m.publish_stream, a.photo_image_id, COALESCE(a.x_account, u.x_account) AS x_account, COALESCE(a.stream_urls, u.stream_urls) AS stream_urls, a.rank
     FROM tournament_members m JOIN users u ON u.id = m.user_id
     LEFT JOIN recruitments r ON r.tournament_id = m.tournament_id
     LEFT JOIN applications a ON a.recruitment_id = r.id AND a.user_id = m.user_id
     WHERE m.tournament_id = ? AND m.deleted_at IS NULL AND m.member_type IN ('player','coach') AND u.suspended_at IS NULL`,
  ).bind(tid).all<Row>();
  return results;
}

/** 公開してよい項目だけの形にする */
async function publicPerson(env: AppEnv['Bindings'], r: Row) {
  return {
    name: r.name, memberType: r.member_type, lane: r.lane ?? r.draft_role, rank: r.rank,
    photoUrl: r.publish_photo ? await signedImageUrl(env, r.photo_image_id) : null,
    xAccount: r.publish_x ? r.x_account : null,
    streamUrls: r.publish_stream && r.stream_urls ? (JSON.parse(r.stream_urls) as string[]) : [],
  };
}

/** 大会参加者一覧：選考結果の発表後に公開。チームが決まった後はチーム順（チーム内はレーン順）、決まる前はレーン順 */
rosterRoutes.get('/participants', async (c) => {
  const t = await getCurrentTournament(c.env.DB);
  if (!t || !t.announced_at) return c.json({ published: false, groups: [] });
  const rows = await members(c.env.DB, t.id);
  const names = await teamNames(c.env.DB, t.id);
  const laneIdx = (r: Row) => { const i = LANE_ORDER.indexOf(r.lane ?? r.draft_role ?? ''); return i < 0 ? 9 : i; };
  const byLane = (a: Row, b: Row) => (a.member_type === 'coach' ? -1 : 0) - (b.member_type === 'coach' ? -1 : 0) || laneIdx(a) - laneIdx(b) || a.name.localeCompare(b.name, 'ja');
  const teamsDecided = rows.some((r) => r.member_type === 'player' && r.team_id);
  const groups = teamsDecided
    ? [...names.entries()].map(([id, name]) => ({ title: name, rows: rows.filter((r) => r.team_id === id).sort(byLane) }))
      .concat([{ title: '所属チームの決定前', rows: rows.filter((r) => !r.team_id).sort(byLane) }]).filter((g) => g.rows.length)
    : [{ title: '参加者', rows: [...rows].sort(byLane) }];
  return c.json({
    published: true, teamsDecided,
    groups: await Promise.all(groups.map(async (g) => ({ title: g.title, people: await Promise.all(g.rows.map((r) => publicPerson(c.env, r))) }))),
  });
});

/** チーム紹介：管理者が公開したチームだけ */
rosterRoutes.get('/teams', async (c) => {
  const t = await getCurrentTournament(c.env.DB);
  if (!t) return c.json({ teams: [] });
  const { results: teams } = await c.env.DB.prepare('SELECT id FROM teams WHERE tournament_id = ? AND deleted_at IS NULL AND intro_published_at IS NOT NULL ORDER BY created_at').bind(t.id).all<{ id: string }>();
  const rows = await members(c.env.DB, t.id);
  const names = await teamNames(c.env.DB, t.id);
  const laneIdx = (r: Row) => LANE_ORDER.indexOf(r.lane ?? '');
  return c.json({
    teams: await Promise.all(teams.map(async (tm) => ({
      id: tm.id, name: names.get(tm.id),
      coaches: await Promise.all(rows.filter((r) => r.team_id === tm.id && r.member_type === 'coach').map((r) => publicPerson(c.env, r))),
      players: await Promise.all(rows.filter((r) => r.team_id === tm.id && r.member_type === 'player').sort((a, b) => laneIdx(a) - laneIdx(b)).map((r) => publicPerson(c.env, r))),
    }))),
  });
});

/** 本人の公開設定（マイページ）。大会の選手・コーチだけ */
rosterRoutes.put('/my-publish', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!v.user) throw new HttpError(401, 'login_required');
  if (!v.tournament || (v.memberType !== 'player' && v.memberType !== 'coach')) throw new HttpError(403, 'forbidden', '公開設定は、大会の選手とコーチだけが使えます');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const flag = (k: string) => (b[k] === true ? 1 : 0);
  await c.env.DB.prepare('UPDATE tournament_members SET publish_photo = ?, publish_x = ?, publish_stream = ?, updated_at = ? WHERE tournament_id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(flag('photo'), flag('x'), flag('stream'), nowIso(), v.tournament.id, v.user.id).run();
  return c.json({ ok: true });
});

rosterRoutes.get('/my-publish', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!v.user || !v.tournament) throw new HttpError(401, 'login_required');
  const m = await c.env.DB.prepare('SELECT publish_photo, publish_x, publish_stream FROM tournament_members WHERE tournament_id = ? AND user_id = ? AND deleted_at IS NULL').bind(v.tournament.id, v.user.id)
    .first<{ publish_photo: number; publish_x: number; publish_stream: number }>();
  return c.json(m ? { available: true, photo: Boolean(m.publish_photo), x: Boolean(m.publish_x), stream: Boolean(m.publish_stream) } : { available: false });
});
