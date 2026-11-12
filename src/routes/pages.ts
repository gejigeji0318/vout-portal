import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { canSeeRules, getViewer } from '../services/audience';
import { signedImageUrl } from '../services/imageStore';
import { getCurrentTournament } from '../services/tournament';

export const PAGE_KINDS = ['about', 'overview', 'rules', 'privacy'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
/** 大会ごとに持つページ（それ以外は大会をまたいで使う） */
export const TOURNAMENT_PAGES = new Set<PageKind>(['overview', 'rules']);

export async function latestVersion(db: D1Database, kind: PageKind, tournamentId: string | null) {
  return db
    .prepare('SELECT version, body, created_at FROM page_versions WHERE kind = ? AND COALESCE(tournament_id, \'\') = ? ORDER BY version DESC LIMIT 1')
    .bind(kind, tournamentId ?? '')
    .first<{ version: number; body: string; created_at: string }>();
}

export const pageRoutes = new Hono<AppEnv>();

pageRoutes.get('/:kind', async (c) => {
  const kind = c.req.param('kind') as PageKind;
  if (!PAGE_KINDS.includes(kind)) throw new HttpError(404, 'not_found');
  const v = await getViewer(c.env.DB, c.get('user'));
  if (kind === 'rules' && !canSeeRules(v)) throw new HttpError(c.get('user') ? 403 : 401, 'forbidden', 'ルールブックは大会の参加者だけが見られます');
  const tid = TOURNAMENT_PAGES.has(kind) ? v.tournament?.id ?? null : null;
  if (TOURNAMENT_PAGES.has(kind) && !tid) return c.json({ kind, page: null });
  const page = await latestVersion(c.env.DB, kind, tid);
  const res: Record<string, unknown> = { kind, page: page ? { version: page.version, body: page.body, updatedAt: page.created_at } : null };
  if (kind === 'about') {
    res.staff = await staffMembers(c.env, v.tournament?.id ?? null);
    const links = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'official_links'").first<{ value: string }>();
    res.officialLinks = links ? JSON.parse(links.value) : [];
  }
  if (kind === 'overview') res.tournament = await overview(c.env.DB);
  return c.json(res);
});

/** ルールブックの版の履歴（F-16） */
pageRoutes.get('/rules/versions', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!canSeeRules(v)) throw new HttpError(c.get('user') ? 403 : 401, 'forbidden');
  if (!v.tournament) return c.json({ versions: [] });
  const { results } = await c.env.DB.prepare("SELECT version, created_at FROM page_versions WHERE kind = 'rules' AND tournament_id = ? ORDER BY version DESC")
    .bind(v.tournament.id).all<{ version: number; created_at: string }>();
  return c.json({ versions: results.map((r) => ({ version: r.version, updatedAt: r.created_at })) });
});

pageRoutes.get('/rules/versions/:version', async (c) => {
  const v = await getViewer(c.env.DB, c.get('user'));
  if (!canSeeRules(v)) throw new HttpError(c.get('user') ? 403 : 401, 'forbidden');
  const row = await c.env.DB.prepare("SELECT version, body, created_at FROM page_versions WHERE kind = 'rules' AND tournament_id = ? AND version = ?")
    .bind(v.tournament?.id ?? '', Number(c.req.param('version'))).first<{ version: number; body: string; created_at: string }>();
  if (!row) throw new HttpError(404, 'not_found');
  return c.json({ version: row.version, body: row.body, updatedAt: row.created_at });
});

/**
 * 運営メンバー（管理者・補助スタッフ）。管理者の種別は返さない（S-3-4）。
 * 返すのは、本人がマイページで登録した項目だけ
 */
async function staffMembers(env: AppEnv['Bindings'], tournamentId: string | null) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, COALESCE(u.display_name, u.discord_name) AS name, u.bio, u.icon_image_id, u.stream_urls, u.x_account
     FROM users u
     WHERE u.suspended_at IS NULL AND (u.admin_level <> 'none' OR EXISTS (
       SELECT 1 FROM tournament_members m WHERE m.user_id = u.id AND m.tournament_id = ? AND m.member_type = 'staff' AND m.deleted_at IS NULL))
     ORDER BY u.created_at`,
  ).bind(tournamentId ?? '').all<{ id: string; name: string; bio: string | null; icon_image_id: string | null; stream_urls: string | null; x_account: string | null }>();
  return Promise.all(results.map(async (r) => ({
    name: r.name, bio: r.bio, iconUrl: await signedImageUrl(env, r.icon_image_id),
    streamUrls: r.stream_urls ? JSON.parse(r.stream_urls) : [], xAccount: r.x_account,
  })));
}

/** 大会概要：日程やチーム数は大会設定から自動で出す（F-19） */
async function overview(db: D1Database) {
  const t = await getCurrentTournament(db);
  if (!t) return null;
  const { results } = await db.prepare('SELECT kind, title, starts_at, ends_at FROM events WHERE tournament_id = ? ORDER BY starts_at').bind(t.id).all();
  return {
    name: t.name, phase: t.phase, periodStart: t.period_start, periodEnd: t.period_end, teamCount: t.team_count,
    scrimStart: t.scrim_start, scrimEnd: t.scrim_end, events: results,
  };
}
