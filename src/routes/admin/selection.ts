import { Hono } from 'hono';
import type { AppEnv, MemberType } from '../../env';
import { revokeAllSessions } from '../../auth/session';
import { HttpError } from '../../lib/errors';
import { ulid } from '../../lib/id';
import { nowIso } from '../../lib/time';
import { isLane, validateIsoDate, validateText } from '../../lib/validate';
import { writeAudit } from '../../services/audit';
import { hardDeleteImage, signedImageUrl } from '../../services/imageStore';
import { notify } from '../../services/notify';
import { type ApplicationRow, currentRecruitment, isOpen, validateApplication } from '../../services/selection';
import { DRAFT_STARTED_PHASES, getCurrentTournament } from '../../services/tournament';

/** 応募・選考（SC-18）。審査と仮決定の内容は、このファイルの API からしか返さない（管理者のみ） */
export const selectionAdmin = new Hono<AppEnv>();

const FIXED_CHECKS = ['ルールブックを読み、内容に同意します', '参加者一覧への掲載に同意します'];
const KINDS: MemberType[] = ['player', 'coach', 'staff'];

// ---------------- 募集の設定 ----------------
selectionAdmin.get('/recruitment', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) return c.json({ recruitment: null });
  const { results } = await c.env.DB.prepare('SELECT id, label, fixed FROM recruitment_checks WHERE recruitment_id = ? AND deleted_at IS NULL ORDER BY sort_order').bind(cur.r.id).all();
  return c.json({ recruitment: { body: cur.r.body, kinds: JSON.parse(cur.r.kinds), opensAt: cur.r.opens_at, closesAt: cur.r.closes_at, checks: results } });
});

/** 募集の作成・変更。確認事項は自由に編集できる（固定の 2 つは常に入る） */
selectionAdmin.put('/recruitment', async (c) => {
  const t = await getCurrentTournament(c.env.DB);
  if (!t) throw new HttpError(409, 'no_tournament', '開催中の大会がありません');
  if (t.announced_at) throw new HttpError(409, 'announced', '選考結果の発表後は変更できません');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = validateText(b.body, 'body', 10000, true)!;
  if (!Array.isArray(b.kinds) || !b.kinds.length || b.kinds.some((k) => !KINDS.includes(k as MemberType))) throw new HttpError(422, 'invalid_kinds', '募集する区分を選んでください');
  const opens = validateIsoDate(b.opensAt, 'opens_at', true)!;
  const closes = validateIsoDate(b.closesAt, 'closes_at', true)!;
  if (opens >= closes) throw new HttpError(422, 'invalid_period', '締切は受付開始より後にしてください');
  const labels = (Array.isArray(b.checks) ? b.checks : []).map((x) => validateText(x, 'check', 120, true)!);
  if (labels.length > 10) throw new HttpError(422, 'too_many_checks', '確認事項は 10 個までです');
  const ts = nowIso();
  let r = await c.env.DB.prepare('SELECT id FROM recruitments WHERE tournament_id = ?').bind(t.id).first<{ id: string }>();
  if (r) {
    await c.env.DB.prepare('UPDATE recruitments SET body=?, kinds=?, opens_at=?, closes_at=?, updated_at=? WHERE id = ?').bind(body, JSON.stringify(b.kinds), opens, closes, ts, r.id).run();
  } else {
    r = { id: ulid() };
    await c.env.DB.prepare('INSERT INTO recruitments (id, tournament_id, body, kinds, opens_at, closes_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(r.id, t.id, body, JSON.stringify(b.kinds), opens, closes, ts, ts).run();
    await c.env.DB.batch(FIXED_CHECKS.map((l, i) => c.env.DB.prepare('INSERT INTO recruitment_checks (id, recruitment_id, label, sort_order, fixed, created_at, updated_at) VALUES (?,?,?,?,1,?,?)')
      .bind(ulid(), r!.id, l, i, ts, ts)));
  }
  // 自由な確認事項：今ある分は隠し（同意の記録のため消さない）、新しく作り直す
  await c.env.DB.prepare('UPDATE recruitment_checks SET deleted_at = ? WHERE recruitment_id = ? AND fixed = 0 AND deleted_at IS NULL').bind(ts, r.id).run();
  if (labels.length) {
    await c.env.DB.batch(labels.map((l, i) => c.env.DB.prepare('INSERT INTO recruitment_checks (id, recruitment_id, label, sort_order, fixed, created_at, updated_at) VALUES (?,?,?,?,0,?,?)')
      .bind(ulid(), r!.id, l, 10 + i, ts, ts)));
  }
  await writeAudit(c.env.DB, c.get('user')!.id, 'recruitment_update', { type: 'recruitment', id: r.id });
  return c.json({ ok: true });
});

// ---------------- 応募一覧・詳細 ----------------
interface ReviewRow { application_id: string; reviewer_user_id: string; reviewer_name: string; grade: string | null; comment: string | null; submitted_at: string | null }

async function reviewsFor(db: D1Database, ids: string[]): Promise<ReviewRow[]> {
  if (!ids.length) return [];
  const { results } = await db.prepare(
    `SELECT r.application_id, r.reviewer_user_id, COALESCE(u.display_name, u.discord_name) AS reviewer_name, r.grade, r.comment, r.submitted_at
     FROM reviews r JOIN users u ON u.id = r.reviewer_user_id WHERE r.application_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at`,
  ).bind(...ids).all<ReviewRow>();
  return results;
}

/** もう 1 人の審査は、自分が担当で、まだ送信していない間は見せない */
function visibleReviews(all: ReviewRow[], viewerId: string) {
  const mine = all.find((r) => r.reviewer_user_id === viewerId);
  const hideOthers = Boolean(mine && !mine.submitted_at);
  return all.map((r) => {
    const hidden = hideOthers && r.reviewer_user_id !== viewerId;
    return { reviewerId: r.reviewer_user_id, reviewerName: r.reviewer_name, submitted: Boolean(r.submitted_at),
      grade: hidden ? null : r.grade, comment: hidden ? null : r.comment, hidden, mine: r.reviewer_user_id === viewerId };
  });
}

selectionAdmin.get('/applications', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) return c.json({ applications: [] });
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, COALESCE(u.display_name, u.discord_name) AS name, p.member_type AS p_type, p.draft_role AS p_role, p.team_id AS p_team
     FROM applications a JOIN users u ON u.id = a.user_id LEFT JOIN provisional_decisions p ON p.application_id = a.id
     WHERE a.recruitment_id = ? ORDER BY a.created_at`,
  ).bind(cur.r.id).all<ApplicationRow & { name: string; p_type: string | null; p_role: string | null; p_team: string | null }>();
  const reviews = await reviewsFor(c.env.DB, results.map((a) => a.id));
  const me = c.get('user')!.id;
  return c.json({
    applications: results.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, rank: a.rank, mainLane: a.main_lane, secondLane: a.second_lane, submittedAt: a.created_at,
      reviews: visibleReviews(reviews.filter((r) => r.application_id === a.id), me),
      provisional: a.p_type ? { memberType: a.p_type, draftRole: a.p_role, teamId: a.p_team } : null,
    })),
  });
});

selectionAdmin.get('/applications/:id', async (c) => {
  const a = await c.env.DB.prepare('SELECT a.*, COALESCE(u.display_name, u.discord_name) AS name FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?')
    .bind(c.req.param('id')).first<ApplicationRow & { name: string }>();
  if (!a) throw new HttpError(404, 'not_found');
  const checks = await c.env.DB.prepare('SELECT c.label FROM application_checks ac JOIN recruitment_checks c ON c.id = ac.check_id WHERE ac.application_id = ? ORDER BY c.sort_order')
    .bind(a.id).all<{ label: string }>();
  return c.json({
    application: {
      id: a.id, name: a.name, kind: a.kind, opggUrl: a.opgg_url, rank: a.rank, mainLane: a.main_lane, secondLane: a.second_lane, xAccount: a.x_account,
      streamUrls: a.stream_urls ? JSON.parse(a.stream_urls) : [], photoUrl: await signedImageUrl(c.env, a.photo_image_id),
      agreedChecks: checks.results.map((x) => x.label), submittedAt: a.created_at, staffEditedAt: a.staff_edited_at,
    },
    reviews: visibleReviews(await reviewsFor(c.env.DB, [a.id]), c.get('user')!.id),
  });
});

/**
 * 運営による応募内容の修正（X の書き間違いなど）。区分と宣材写真は本人だけが変えられる。
 * 本人が入力するときと同じ確認をかけ、修正した項目を操作ログに残し、本人の応募状況に修正日時を出す
 */
selectionAdmin.put('/applications/:id', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_recruitment');
  if (cur.t.announced_at) throw new HttpError(409, 'announced', '発表後は修正できません');
  const a = await c.env.DB.prepare('SELECT * FROM applications WHERE id = ? AND recruitment_id = ?').bind(c.req.param('id'), cur.r.id).first<ApplicationRow>();
  if (!a) throw new HttpError(404, 'not_found');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const v = validateApplication({ ...b, kind: a.kind }, [a.kind]);
  const before = { opgg_url: a.opgg_url, rank: a.rank, main_lane: a.main_lane, second_lane: a.second_lane, x_account: a.x_account, stream_urls: a.stream_urls };
  const after = { opgg_url: v.opgg, rank: v.rank, main_lane: v.main, second_lane: v.second, x_account: v.x, stream_urls: v.streams };
  const changed = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]);
  if (!changed.length) return c.json({ ok: true, changed: [] });
  const t = nowIso();
  await c.env.DB.prepare('UPDATE applications SET opgg_url=?, rank=?, main_lane=?, second_lane=?, x_account=?, stream_urls=?, staff_edited_at=?, updated_at=? WHERE id = ?')
    .bind(v.opgg, v.rank, v.main, v.second, v.x, v.streams, t, t, a.id).run();
  // 操作ログには、変えた項目の名前だけを残す（値そのものは残さない）
  await writeAudit(c.env.DB, c.get('user')!.id, 'application_staff_edit', { type: 'application', id: a.id }, { fields: changed });
  return c.json({ ok: true, changed });
});

// ---------------- 審査 ----------------
const isAdminUser = (db: D1Database, id: string) => db.prepare("SELECT 1 FROM users WHERE id = ? AND admin_level <> 'none' AND suspended_at IS NULL").bind(id).first();

/** 審査担当の割り当て（2 人まで）。送信済みの審査をした人は外せない */
selectionAdmin.put('/applications/:id/reviewers', async (c) => {
  const id = c.req.param('id');
  if (!(await c.env.DB.prepare('SELECT 1 FROM applications WHERE id = ?').bind(id).first())) throw new HttpError(404, 'not_found');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(b.reviewerIds) ? [...new Set(b.reviewerIds.filter((x): x is string => typeof x === 'string'))] : [];
  if (ids.length > 2) throw new HttpError(422, 'too_many_reviewers', '審査担当は 2 人までです');
  for (const r of ids) if (!(await isAdminUser(c.env.DB, r))) throw new HttpError(422, 'invalid_reviewer', '審査担当にできるのは管理者だけです');
  const current = (await reviewsFor(c.env.DB, [id]));
  if (current.some((r) => r.submitted_at && !ids.includes(r.reviewer_user_id))) throw new HttpError(409, 'reviewed', '審査を送信済みの担当は外せません');
  const t = nowIso();
  await c.env.DB.batch([
    ...current.filter((r) => !ids.includes(r.reviewer_user_id)).map((r) => c.env.DB.prepare('DELETE FROM reviews WHERE application_id = ? AND reviewer_user_id = ?').bind(id, r.reviewer_user_id)),
    ...ids.filter((r) => !current.some((x) => x.reviewer_user_id === r)).map((r) => c.env.DB.prepare('INSERT INTO reviews (id, application_id, reviewer_user_id, assigned_by, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind(ulid(), id, r, c.get('user')!.id, t, t)),
  ]);
  await writeAudit(c.env.DB, c.get('user')!.id, 'review_assign', { type: 'application', id });
  return c.json({ ok: true });
});

/** 担当がまだ足りない応募に、担当の少ない管理者から順に割り当てる */
selectionAdmin.post('/applications/auto-assign', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_recruitment');
  const { results: admins } = await c.env.DB.prepare("SELECT id FROM users WHERE admin_level <> 'none' AND suspended_at IS NULL").all<{ id: string }>();
  if (admins.length < 2) throw new HttpError(409, 'not_enough_admins', '審査には管理者が 2 人以上必要です');
  const { results: apps } = await c.env.DB.prepare('SELECT id FROM applications WHERE recruitment_id = ? ORDER BY created_at').bind(cur.r.id).all<{ id: string }>();
  const reviews = await reviewsFor(c.env.DB, apps.map((a) => a.id));
  const load = new Map(admins.map((a) => [a.id, reviews.filter((r) => r.reviewer_user_id === a.id).length]));
  const t = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const a of apps) {
    const have = reviews.filter((r) => r.application_id === a.id).map((r) => r.reviewer_user_id);
    for (let n = have.length; n < 2; n++) {
      const pick = [...load.entries()].filter(([id]) => !have.includes(id)).sort((x, y) => x[1] - y[1])[0]!;
      have.push(pick[0]);
      load.set(pick[0], pick[1] + 1);
      stmts.push(c.env.DB.prepare('INSERT INTO reviews (id, application_id, reviewer_user_id, assigned_by, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(ulid(), a.id, pick[0], c.get('user')!.id, t, t));
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  await writeAudit(c.env.DB, c.get('user')!.id, 'review_auto_assign', undefined, { count: stmts.length });
  return c.json({ ok: true, assigned: stmts.length });
});

/** 審査の送信（担当者だけ）。A〜E とコメント */
selectionAdmin.put('/applications/:id/review', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.grade !== 'string' || !['A', 'B', 'C', 'D', 'E'].includes(b.grade)) throw new HttpError(422, 'invalid_grade', '評価（A〜E）を選んでください');
  const comment = validateText(b.comment, 'comment', 1000);
  const t = nowIso();
  const r = await c.env.DB.prepare('UPDATE reviews SET grade = ?, comment = ?, submitted_at = ?, updated_at = ? WHERE application_id = ? AND reviewer_user_id = ?')
    .bind(b.grade, comment, t, t, c.req.param('id'), c.get('user')!.id).run();
  if (!r.meta.changes) throw new HttpError(403, 'not_reviewer', 'この応募の審査担当ではありません');
  await writeAudit(c.env.DB, c.get('user')!.id, 'review_submit', { type: 'application', id: c.req.param('id') });
  return c.json({ ok: true });
});

// ---------------- 仮決定表 ----------------
/** 仮決定表に入れる（2 人の審査が済んでから）。不採用は仮決定に入れない */
selectionAdmin.put('/applications/:id/provisional', async (c) => {
  const id = c.req.param('id');
  const t = await getCurrentTournament(c.env.DB);
  if (!t || t.announced_at) throw new HttpError(409, 'announced', '発表後は変更できません');
  const done = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM reviews WHERE application_id = ? AND submitted_at IS NOT NULL').bind(id).first<{ n: number }>();
  if ((done?.n ?? 0) < 2) throw new HttpError(409, 'reviews_incomplete', '2 人の審査が済んでから仮決定表に入れてください');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!KINDS.includes(b.memberType as MemberType)) throw new HttpError(422, 'invalid_member_type');
  const draftRole = b.memberType === 'player' ? (isLane(b.draftRole) ? b.draftRole : null) : null;
  let teamId: string | null = null;
  if (b.memberType === 'coach' && b.teamId) {
    if (!(await c.env.DB.prepare('SELECT 1 FROM teams WHERE id = ? AND tournament_id = ? AND deleted_at IS NULL').bind(b.teamId, t.id).first())) throw new HttpError(422, 'invalid_team');
    teamId = String(b.teamId);
  }
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO provisional_decisions (application_id, member_type, draft_role, team_id, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(application_id) DO UPDATE SET member_type = excluded.member_type, draft_role = excluded.draft_role, team_id = excluded.team_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(id, b.memberType, draftRole, teamId, c.get('user')!.id, ts, ts).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'provisional_set', { type: 'application', id });
  return c.json({ ok: true });
});

selectionAdmin.delete('/applications/:id/provisional', async (c) => {
  const t = await getCurrentTournament(c.env.DB);
  if (!t || t.announced_at) throw new HttpError(409, 'announced', '発表後は変更できません');
  await c.env.DB.prepare('DELETE FROM provisional_decisions WHERE application_id = ?').bind(c.req.param('id')).run();
  await writeAudit(c.env.DB, c.get('user')!.id, 'provisional_remove', { type: 'application', id: c.req.param('id') });
  return c.json({ ok: true });
});

/** 仮決定表：ロール別の人数（必要数＝参加チーム数）と、最終更新者 */
selectionAdmin.get('/provisional', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) return c.json({ teamCount: 0, roleCounts: {}, entries: [], candidates: 0, lastUpdate: null });
  const { results } = await c.env.DB.prepare(
    `SELECT p.application_id, p.member_type, p.draft_role, p.team_id, p.updated_at, COALESCE(u.display_name, u.discord_name) AS name,
       a.rank, a.main_lane, a.second_lane, COALESCE(b.display_name, b.discord_name) AS updated_by_name
     FROM provisional_decisions p JOIN applications a ON a.id = p.application_id JOIN users u ON u.id = a.user_id JOIN users b ON b.id = p.updated_by
     WHERE a.recruitment_id = ? ORDER BY p.member_type, p.draft_role`,
  ).bind(cur.r.id).all<Record<string, string | null>>();
  const roleCounts: Record<string, number> = { TOP: 0, JG: 0, MID: 0, BOT: 0, SUP: 0 };
  for (const e of results) if (e.member_type === 'player' && e.draft_role) roleCounts[e.draft_role] = (roleCounts[e.draft_role] ?? 0) + 1;
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM applications WHERE recruitment_id = ?').bind(cur.r.id).first<{ n: number }>();
  const last = [...results].sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)))[0];
  return c.json({
    teamCount: cur.t.team_count, roleCounts, entries: results, candidates: (total?.n ?? 0) - results.length,
    lastUpdate: last ? { at: last.updated_at, by: last.updated_by_name } : null, announcedAt: cur.t.announced_at,
  });
});

// ---------------- 最終決定と発表 ----------------
/**
 * 仮決定表に入っている人を採用、入っていない人を不採用として、全員同時に確定する（F-11）。
 * 不採用の人は、応募・同意・審査・宣材写真を削除し、「不採用だった」という記録だけを残す
 */
selectionAdmin.post('/selection/announce', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_recruitment');
  const { t, r } = cur;
  if (t.announced_at) throw new HttpError(409, 'announced', 'すでに発表しています');
  if (isOpen(r)) throw new HttpError(409, 'still_open', '受付期間が終わってから発表してください');
  const { results: apps } = await c.env.DB.prepare(
    'SELECT a.id, a.user_id, a.photo_image_id, p.member_type, p.draft_role, p.team_id FROM applications a LEFT JOIN provisional_decisions p ON p.application_id = a.id WHERE a.recruitment_id = ?',
  ).bind(r.id).all<{ id: string; user_id: string; photo_image_id: string; member_type: string | null; draft_role: string | null; team_id: string | null }>();
  const ts = nowIso();
  const accepted = apps.filter((a) => a.member_type);
  const rejected = apps.filter((a) => !a.member_type);
  await c.env.DB.batch([
    ...accepted.map((a) => c.env.DB.prepare(
      `INSERT INTO tournament_members (id, tournament_id, user_id, member_type, team_id, draft_role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(tournament_id, user_id) DO UPDATE SET member_type = excluded.member_type, team_id = excluded.team_id, draft_role = excluded.draft_role, deleted_at = NULL, updated_at = excluded.updated_at`,
    ).bind(ulid(), t.id, a.user_id, a.member_type, a.team_id, a.draft_role, ts, ts)),
    ...rejected.flatMap((a) => [
      c.env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(a.id),
      c.env.DB.prepare('INSERT OR IGNORE INTO rejection_records (id, tournament_id, user_id, decided_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(ulid(), t.id, a.user_id, ts, ts, ts),
    ]),
    c.env.DB.prepare('UPDATE tournaments SET announced_at = ?, updated_at = ? WHERE id = ?').bind(ts, ts, t.id),
  ]);
  for (const a of rejected) await hardDeleteImage(c.env, a.photo_image_id);
  for (const a of accepted) await revokeAllSessions(c.env.DB, a.user_id); // 立場が変わるので、ログインし直してもらう
  await writeAudit(c.env.DB, c.get('user')!.id, 'announce_selection', { type: 'tournament', id: t.id }, { accepted: accepted.length, rejected: rejected.length });
  await notify(c.env, 'selection_result', `選考結果を発表しました。応募した方は、ポータルの「応募状況」で結果を確認してください。\n${c.env.APP_ORIGIN}/entry`).catch(() => {});
  return c.json({ ok: true, accepted: accepted.length, rejected: rejected.length });
});

/** 採用の取り消し（ドラフト開始前まで）。不採用と同じ扱いにする */
selectionAdmin.post('/applications/:id/cancel-acceptance', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur || !cur.t.announced_at) throw new HttpError(409, 'not_announced', '発表前は仮決定表から外してください');
  if (DRAFT_STARTED_PHASES.has(cur.t.phase)) throw new HttpError(409, 'draft_started', 'ドラフト開始後は取り消せません。ユーザー管理で対応してください');
  const a = await c.env.DB.prepare('SELECT id, user_id, photo_image_id FROM applications WHERE id = ? AND recruitment_id = ?').bind(c.req.param('id'), cur.r.id)
    .first<{ id: string; user_id: string; photo_image_id: string }>();
  if (!a) throw new HttpError(404, 'not_found');
  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM tournament_members WHERE tournament_id = ? AND user_id = ?').bind(cur.t.id, a.user_id),
    c.env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(a.id),
    c.env.DB.prepare('INSERT OR IGNORE INTO rejection_records (id, tournament_id, user_id, decided_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').bind(ulid(), cur.t.id, a.user_id, ts, ts, ts),
  ]);
  await hardDeleteImage(c.env, a.photo_image_id);
  await revokeAllSessions(c.env.DB, a.user_id);
  await writeAudit(c.env.DB, c.get('user')!.id, 'cancel_acceptance', { type: 'user', id: a.user_id });
  return c.json({ ok: true });
});
