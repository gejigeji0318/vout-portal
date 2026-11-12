import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { HttpError } from '../lib/errors';
import { ulid } from '../lib/id';
import { nowIso } from '../lib/time';
import { requireLogin } from '../middleware/auth';
import { hardDeleteImage, saveImage, signedImageUrl } from '../services/imageStore';
import { getMembership } from '../services/tournament';
import { activeChecks, type ApplicationRow, applicantStatus, currentRecruitment, isOpen, validateApplication } from '../services/selection';

/** 大会応募（F-11）：登録済み閲覧者（ログインした、まだ大会に参加していない人） */
export const applicationRoutes = new Hono<AppEnv>();

/** 募集要項（誰でも見られる）。ログインしていれば自分の選考状況も */
applicationRoutes.get('/recruitment', async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) return c.json({ recruitment: null });
  const { t, r } = cur;
  const user = c.get('user');
  return c.json({
    recruitment: {
      tournamentName: t.name, body: r.body, kinds: JSON.parse(r.kinds), opensAt: r.opens_at, closesAt: r.closes_at, open: isOpen(r),
      checks: (await activeChecks(c.env.DB, r.id)).map((x) => ({ id: x.id, label: x.label })),
    },
    myStatus: user ? await applicantStatus(c.env, t, r, user.id) : null,
  });
});

/** 応募できる人か（管理者・参加者・不採用の記録がある人は応募できない） */
async function assertCanApply(c: { env: AppEnv['Bindings']; get: (k: 'user') => AppEnv['Variables']['user'] }) {
  const user = c.get('user')!;
  if (user.adminLevel !== 'none') throw new HttpError(403, 'admin_cannot_apply', '運営は応募できません');
  const cur = await currentRecruitment(c.env.DB);
  if (!cur) throw new HttpError(409, 'no_recruitment', '現在、募集はありません');
  if (await getMembership(c.env.DB, cur.t.id, user.id)) throw new HttpError(409, 'already_member', 'すでに大会の参加者です');
  if (await c.env.DB.prepare('SELECT 1 FROM rejection_records WHERE tournament_id = ? AND user_id = ?').bind(cur.t.id, user.id).first()) {
    throw new HttpError(409, 'already_decided', 'この大会の選考はすでに終わっています');
  }
  return cur;
}

/** 宣材写真のアップロード（応募の前に送る。ここでは保存だけで、応募に使うまでは誰にも見せない） */
applicationRoutes.post('/applications/photo', requireLogin, async (c) => {
  const { t, r } = await assertCanApply(c);
  if (!isOpen(r)) throw new HttpError(409, 'closed', '受付期間ではありません');
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const file = (body as Record<string, unknown>).file;
  if (!(file instanceof File)) throw new HttpError(400, 'no_file', '画像を選んでください');
  const id = await saveImage(c.env, { ownerId: c.get('user')!.id, purpose: 'promo', file, tournamentId: t.id });
  return c.json({ photoId: id, photoUrl: await signedImageUrl(c.env, id) }, 201);
});

async function ownPhoto(db: D1Database, photoId: unknown, userId: string): Promise<string> {
  if (typeof photoId !== 'string') throw new HttpError(422, 'invalid_photo', '宣材写真を選んでください');
  const ok = await db.prepare("SELECT 1 FROM images WHERE id = ? AND owner_user_id = ? AND purpose = 'promo' AND deleted_at IS NULL").bind(photoId, userId).first();
  if (!ok) throw new HttpError(422, 'invalid_photo', '宣材写真を選び直してください');
  return photoId;
}

async function saveChecks(db: D1Database, recruitmentId: string, applicationId: string, agreed: unknown) {
  const checks = await activeChecks(db, recruitmentId);
  const ids = new Set(Array.isArray(agreed) ? agreed.filter((x): x is string => typeof x === 'string') : []);
  if (checks.some((x) => !ids.has(x.id))) throw new HttpError(422, 'checks_required', '確認事項にすべて同意してください');
  const t = nowIso();
  await db.batch([
    db.prepare('DELETE FROM application_checks WHERE application_id = ?').bind(applicationId),
    ...checks.map((x) => db.prepare('INSERT INTO application_checks (application_id, check_id, agreed_at) VALUES (?,?,?)').bind(applicationId, x.id, t)),
  ]);
}

applicationRoutes.post('/applications', requireLogin, async (c) => {
  const { r } = await assertCanApply(c);
  if (!isOpen(r)) throw new HttpError(409, 'closed', '受付期間ではありません');
  const user = c.get('user')!;
  if (await c.env.DB.prepare('SELECT 1 FROM applications WHERE recruitment_id = ? AND user_id = ?').bind(r.id, user.id).first()) {
    throw new HttpError(409, 'already_applied', 'すでに応募しています。内容は応募状況から修正できます');
  }
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const v = validateApplication(b, JSON.parse(r.kinds));
  const photo = await ownPhoto(c.env.DB, b.photoId, user.id);
  const id = ulid();
  const t = nowIso();
  // 同意の確認を先に行い、そろっていなければ応募を作らない
  const checks = await activeChecks(c.env.DB, r.id);
  const agreed = new Set(Array.isArray(b.agreedCheckIds) ? b.agreedCheckIds : []);
  if (checks.some((x) => !agreed.has(x.id))) throw new HttpError(422, 'checks_required', '確認事項にすべて同意してください');
  await c.env.DB.prepare(
    'INSERT INTO applications (id, recruitment_id, user_id, kind, opgg_url, rank, main_lane, second_lane, x_account, stream_urls, photo_image_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).bind(id, r.id, user.id, v.kind, v.opgg, v.rank, v.main, v.second, v.x, v.streams, photo, t, t).run();
  await saveChecks(c.env.DB, r.id, id, b.agreedCheckIds);
  return c.json({ id }, 201);
});

/** 自分の応募（内容と選考状況） */
applicationRoutes.get('/applications/mine', requireLogin, async (c) => {
  const cur = await currentRecruitment(c.env.DB);
  const user = c.get('user')!;
  if (!cur) return c.json({ application: null, status: 'none' });
  const status = await applicantStatus(c.env, cur.t, cur.r, user.id);
  const a = await c.env.DB.prepare('SELECT * FROM applications WHERE recruitment_id = ? AND user_id = ?').bind(cur.r.id, user.id).first<ApplicationRow>();
  return c.json({
    status,
    application: a ? {
      kind: a.kind, opggUrl: a.opgg_url, rank: a.rank, mainLane: a.main_lane, secondLane: a.second_lane, xAccount: a.x_account,
      streamUrls: a.stream_urls ? JSON.parse(a.stream_urls) : [], photoUrl: await signedImageUrl(c.env, a.photo_image_id), submittedAt: a.created_at, updatedAt: a.updated_at, staffEditedAt: a.staff_edited_at,
    } : null,
  });
});

/** 締切までは修正できる */
applicationRoutes.put('/applications/mine', requireLogin, async (c) => {
  const { r } = await assertCanApply(c);
  if (!isOpen(r)) throw new HttpError(409, 'closed', '締切を過ぎたため修正できません');
  const user = c.get('user')!;
  const a = await c.env.DB.prepare('SELECT * FROM applications WHERE recruitment_id = ? AND user_id = ?').bind(r.id, user.id).first<ApplicationRow>();
  if (!a) throw new HttpError(404, 'not_found');
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const v = validateApplication(b, JSON.parse(r.kinds));
  const photo = b.photoId ? await ownPhoto(c.env.DB, b.photoId, user.id) : a.photo_image_id;
  await saveChecks(c.env.DB, r.id, a.id, b.agreedCheckIds);
  await c.env.DB.prepare('UPDATE applications SET kind=?, opgg_url=?, rank=?, main_lane=?, second_lane=?, x_account=?, stream_urls=?, photo_image_id=?, updated_at=? WHERE id = ?')
    .bind(v.kind, v.opgg, v.rank, v.main, v.second, v.x, v.streams, photo, nowIso(), a.id).run();
  if (photo !== a.photo_image_id) await hardDeleteImage(c.env, a.photo_image_id);
  return c.json({ ok: true });
});

/** 取り下げ（締切まで）。応募と宣材写真をすぐに物理削除する */
applicationRoutes.delete('/applications/mine', requireLogin, async (c) => {
  const { r } = await assertCanApply(c);
  if (!isOpen(r)) throw new HttpError(409, 'closed', '締切を過ぎたため取り下げできません。運営に問い合わせてください');
  const a = await c.env.DB.prepare('SELECT id, photo_image_id FROM applications WHERE recruitment_id = ? AND user_id = ?').bind(r.id, c.get('user')!.id)
    .first<{ id: string; photo_image_id: string }>();
  if (!a) throw new HttpError(404, 'not_found');
  await c.env.DB.prepare('DELETE FROM applications WHERE id = ?').bind(a.id).run();
  await hardDeleteImage(c.env, a.photo_image_id);
  return c.json({ ok: true });
});
