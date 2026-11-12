import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { validateHttpsUrl, validateIsoDate, validateText } from '../../lib/validate';
import { requireAdmin } from '../../middleware/auth';
import type { AnnouncementRow } from '../../services/audience';
import { writeAudit } from '../../services/audit';
import { sendMessage } from '../../services/discord';
import { getTarget } from '../../services/notify';
import { announceDue } from '../../services/publishing';
import { getCurrentTournament } from '../../services/tournament';
import { CATEGORIES, targetsFor } from '../announcements';
import { latestVersion, PAGE_KINDS, type PageKind, TOURNAMENT_PAGES } from '../pages';

export const contentAdmin = new Hono<AppEnv>();

// ---- 案内ページ ----
/** はじめに・大会概要・プライバシーポリシーは全体管理者のみ、ルールブックは管理者が編集できる */
contentAdmin.put('/pages/:kind', async (c, next) => {
  const kind = c.req.param('kind') as PageKind;
  if (!PAGE_KINDS.includes(kind)) throw new HttpError(404, 'not_found');
  return kind === 'rules' ? next() : requireAdmin('super')(c, next);
}, async (c) => {
  const kind = c.req.param('kind') as PageKind;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = validateText(b.body, 'body', 20000, true)!;
  let tid: string | null = null;
  if (TOURNAMENT_PAGES.has(kind)) {
    const t = await getCurrentTournament(c.env.DB);
    if (!t) throw new HttpError(409, 'no_tournament', '開催中の大会がありません');
    tid = t.id;
  }
  const version = ((await latestVersion(c.env.DB, kind, tid))?.version ?? 0) + 1;
  const t = nowIso();
  await c.env.DB.prepare('INSERT INTO page_versions (id, kind, tournament_id, version, body, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(ulid(), kind, tid, version, body, c.get('user')!.id, t, t).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'page_update', { type: 'page', id: kind }, { version });
  return c.json({ ok: true, version });
});

/** 公式リンク（全体管理者のみ）。https のみ、5 件まで */
contentAdmin.put('/official-links', requireAdmin('super'), async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!Array.isArray(b.links) || b.links.length > 5) throw new HttpError(422, 'invalid_links', '公式リンクは 5 件までです');
  const links = b.links.map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    if (o.kind !== 'x' && o.kind !== 'stream' && o.kind !== 'other') throw new HttpError(422, 'invalid_links');
    return { kind: o.kind, label: validateText(o.label, 'label', 30, true), url: validateHttpsUrl(o.url, 'url') ?? (() => { throw new HttpError(422, 'invalid_links'); })() };
  });
  const t = nowIso();
  await c.env.DB.prepare('INSERT INTO settings (key, value, updated_by, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
    .bind('official_links', JSON.stringify(links), c.get('user')!.id, t, t).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'official_links_update');
  return c.json({ ok: true });
});

// ---- お知らせ ----
interface Target { memberType: 'player' | 'coach' | 'staff' | null; teamId: string | null }

async function readAnnouncement(db: D1Database, b: Record<string, unknown>) {
  const title = validateText(b.title, 'title', 80, true)!;
  const body = validateText(b.body, 'body', 10000, true)!;
  if (typeof b.category !== 'string' || !(CATEGORIES as readonly string[]).includes(b.category)) throw new HttpError(422, 'invalid_category');
  if (b.visibility !== 'public' && b.visibility !== 'logged_in' && b.visibility !== 'targeted') throw new HttpError(422, 'invalid_visibility');
  const important = b.important === true;
  if (important && b.visibility === 'public') {
    throw new HttpError(422, 'important_needs_login', '重要なお知らせ（既読確認あり）は、ログインした人か対象者向けにしてください');
  }
  let targets: Target[] = [];
  if (b.visibility === 'targeted') {
    if (!Array.isArray(b.targets) || b.targets.length === 0 || b.targets.length > 30) throw new HttpError(422, 'invalid_targets', '対象者を選んでください');
    const t = await getCurrentTournament(db);
    targets = await Promise.all(b.targets.map(async (x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const memberType = o.memberType ?? null;
      if (memberType !== null && memberType !== 'player' && memberType !== 'coach' && memberType !== 'staff') throw new HttpError(422, 'invalid_targets');
      const teamId = (o.teamId ?? null) as string | null;
      if (teamId !== null && !(await db.prepare('SELECT 1 FROM teams WHERE id = ? AND tournament_id = ? AND deleted_at IS NULL').bind(teamId, t?.id ?? '').first())) {
        throw new HttpError(422, 'invalid_targets', 'チームが見つかりません');
      }
      return { memberType: memberType as Target['memberType'], teamId };
    }));
  }
  // publishAt：null（下書き）／'now'（今すぐ）／日時（予約）
  const publishedAt = b.publishAt === 'now' ? nowIso() : validateIsoDate(b.publishAt, 'publish_at');
  return { title, body, category: b.category, visibility: b.visibility, important, targets, publishedAt };
}

async function saveTargets(db: D1Database, id: string, targets: Target[]) {
  const t = nowIso();
  await db.batch([
    db.prepare('DELETE FROM announcement_targets WHERE announcement_id = ?').bind(id),
    ...targets.map((x) => db.prepare('INSERT INTO announcement_targets (id, announcement_id, member_type, team_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind(ulid(), id, x.memberType, x.teamId, t, t)),
  ]);
}

const statusOf = (a: AnnouncementRow) => (!a.published_at ? 'draft' : a.published_at > nowIso() ? 'scheduled' : 'published');

contentAdmin.get('/announcements', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM announcements WHERE deleted_at IS NULL ORDER BY COALESCE(published_at, created_at) DESC').all<AnnouncementRow>();
  const targets = await targetsFor(c.env.DB, results.map((a) => a.id));
  return c.json({
    announcements: results.map((a) => ({
      id: a.id, title: a.title, body: a.body, category: a.category, visibility: a.visibility, important: Boolean(a.important),
      publishedAt: a.published_at, status: statusOf(a),
      targets: (targets.get(a.id) ?? []).map((t) => ({ memberType: t.member_type, teamId: t.team_id })),
    })),
  });
});

contentAdmin.post('/announcements', async (c) => {
  const a = await readAnnouncement(c.env.DB, (await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  const id = ulid();
  const t = nowIso();
  const tour = await getCurrentTournament(c.env.DB);
  await c.env.DB.prepare('INSERT INTO announcements (id, tournament_id, title, body, category, visibility, important, published_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, tour?.id ?? null, a.title, a.body, a.category, a.visibility, a.important ? 1 : 0, a.publishedAt, c.get('user')!.id, t, t).run();
  await saveTargets(c.env.DB, id, a.targets);
  await writeAudit(c.env.DB, c.get('user')!.id, 'announcement_create', { type: 'announcement', id });
  await announceDue(c.env);
  return c.json({ id }, 201);
});

contentAdmin.put('/announcements/:id', async (c) => {
  const id = c.req.param('id');
  const a = await readAnnouncement(c.env.DB, (await c.req.json().catch(() => ({}))) as Record<string, unknown>);
  const r = await c.env.DB.prepare('UPDATE announcements SET title=?, body=?, category=?, visibility=?, important=?, published_at=?, updated_at=? WHERE id = ? AND deleted_at IS NULL')
    .bind(a.title, a.body, a.category, a.visibility, a.important ? 1 : 0, a.publishedAt, nowIso(), id).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await saveTargets(c.env.DB, id, a.targets);
  await writeAudit(c.env.DB, c.get('user')!.id, 'announcement_update', { type: 'announcement', id });
  await announceDue(c.env);
  return c.json({ ok: true });
});

contentAdmin.delete('/announcements/:id', async (c) => {
  const r = await c.env.DB.prepare('UPDATE announcements SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(nowIso(), nowIso(), c.req.param('id')).run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found');
  await writeAudit(c.env.DB, c.get('user')!.id, 'announcement_delete', { type: 'announcement', id: c.req.param('id') });
  return c.json({ ok: true });
});

/** 重要なお知らせの対象者（確認済み・未確認）。閲覧者は対象にしない（F-15） */
async function audienceOf(db: D1Database, a: AnnouncementRow) {
  const t = await getCurrentTournament(db);
  const { results: members } = await db.prepare(
    `SELECT u.id, u.discord_user_id, COALESCE(u.display_name, u.discord_name) AS name, m.member_type, m.team_id
     FROM tournament_members m JOIN users u ON u.id = m.user_id
     WHERE m.tournament_id = ? AND m.deleted_at IS NULL AND u.suspended_at IS NULL`,
  ).bind(t?.id ?? '').all<{ id: string; discord_user_id: string; name: string; member_type: string; team_id: string | null }>();
  const targets = (await targetsFor(db, [a.id])).get(a.id) ?? [];
  const inScope = members.filter((m) => a.visibility !== 'targeted' ||
    targets.some((x) => (x.member_type === null || x.member_type === m.member_type) && (x.team_id === null || x.team_id === m.team_id)));
  const { results: reads } = await db.prepare('SELECT user_id, read_at FROM announcement_reads WHERE announcement_id = ?').bind(a.id).all<{ user_id: string; read_at: string }>();
  const readAt = new Map(reads.map((r) => [r.user_id, r.read_at]));
  return inScope.map((m) => ({ ...m, readAt: readAt.get(m.id) ?? null }));
}

contentAdmin.get('/announcements/:id/confirmations', async (c) => {
  const a = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').bind(c.req.param('id')).first<AnnouncementRow>();
  if (!a || !a.important) throw new HttpError(404, 'not_found');
  const list = await audienceOf(c.env.DB, a);
  return c.json({ people: list.map((p) => ({ id: p.id, name: p.name, memberType: p.member_type, confirmedAt: p.readAt })) });
});

/** 未確認の人にだけ、Discord で本人をメンションして再通知する */
contentAdmin.post('/announcements/:id/remind', async (c) => {
  const a = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').bind(c.req.param('id')).first<AnnouncementRow>();
  if (!a || !a.important || !a.published_at || a.published_at > nowIso()) throw new HttpError(404, 'not_found');
  const unconfirmed = (await audienceOf(c.env.DB, a)).filter((p) => !p.readAt);
  if (!unconfirmed.length) return c.json({ ok: true, reminded: 0 });
  const target = await getTarget(c.env.DB, 'announcement');
  if (!target) throw new HttpError(409, 'no_channel', 'お知らせの通知先が設定されていません');
  for (let i = 0; i < unconfirmed.length; i += 20) {
    const chunk = unconfirmed.slice(i, i + 20);
    const mentions = chunk.map((p) => `<@${p.discord_user_id}>`).join(' ');
    const r = await sendMessage(c.env, target.channelId, `${mentions}\n重要なお知らせ「${a.title}」をまだ確認していません。ポータルで確認してください。\n${c.env.APP_ORIGIN}/news/${a.id}`, chunk.map((p) => p.discord_user_id));
    if (!r.ok) throw new HttpError(409, 'send_failed', r.reason ?? '送信に失敗しました');
  }
  await writeAudit(c.env.DB, c.get('user')!.id, 'announcement_remind', { type: 'announcement', id: a.id }, { count: unconfirmed.length });
  return c.json({ ok: true, reminded: unconfirmed.length });
});
