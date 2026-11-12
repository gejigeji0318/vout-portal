import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import { setClockForTest } from '../src/lib/time';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, ORIGIN, req } from './helpers';

const HOUR = 3600e3;
// 構造だけ正しい小さな JPEG（中身の検査は images.test.ts で行っている）
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x50, 0x49, 0x58, 0xff, 0xd9]);

let sent: string[] = [];
beforeEach(async () => {
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/messages')) { sent.push(JSON.parse(String(init?.body)).content); return Response.json({ id: '1' }); }
    return new Response(null, { status: 404 });
  });
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, created_at, updated_at) VALUES ('notification.default', ?, '', '')")
    .bind(JSON.stringify({ channelId: '900000000000000002', channelName: '全体', categoryName: null, kind: 'text' })).run();
});
afterEach(() => { vi.restoreAllMocks(); setClockForTest(null); });

async function setup() {
  const t = await makeTournament(2, 'recruiting');
  const ids = { sup: await makeUser({ adminLevel: 'super' }), subA: await makeUser({ adminLevel: 'sub', name: '審査A' }), subB: await makeUser({ adminLevel: 'sub', name: '審査B' }) };
  const a = { sup: await loginAs(ids.sup), subA: await loginAs(ids.subA), subB: await loginAs(ids.subB) };
  const now = Date.now();
  const res = await req('PUT', '/api/admin/recruitment', { auth: a.subA, body: {
    body: '募集要項', kinds: ['player', 'coach'], opensAt: new Date(now - HOUR).toISOString(), closesAt: new Date(now + HOUR).toISOString(), checks: ['18 歳以上です'],
  } });
  expect(res.status).toBe(200);
  return { t, ids, a, closeLater: () => setClockForTest(() => new Date(now + 2 * HOUR)) };
}

async function uploadPhoto(auth: Auth): Promise<string> {
  const fd = new FormData();
  fd.append('file', new File([JPEG], 'p.jpg'));
  const r = await app.fetch(new Request(`${ORIGIN}/api/applications/photo`, { method: 'POST', body: fd, headers: { Cookie: auth.cookie, Origin: ORIGIN, 'X-CSRF-Token': auth.csrf } }),
    env, { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
  expect(r.status).toBe(201);
  return (await json(r)).photoId;
}

async function apply(auth: Auth, patch: Record<string, unknown> = {}) {
  const rec = await json(await req('GET', '/api/recruitment', { auth }));
  const photoId = patch.photoId ?? (await uploadPhoto(auth));
  return req('POST', '/api/applications', { auth, body: {
    kind: 'player', opggUrl: 'https://op.gg/summoners/jp/test', rank: 'Diamond Ⅲ', mainLane: 'MID', secondLane: 'TOP', streamUrls: [],
    agreedCheckIds: rec.recruitment.checks.map((c: any) => c.id), photoId, ...patch,
  } });
}

async function applicant() { const id = await makeUser(); return { id, auth: await loginAs(id) }; }

describe('募集と応募', () => {
  it('募集要項は誰でも見られ、固定の確認事項（ルールブック・掲載への同意）が必ず入る', async () => {
    await setup();
    const r = await json(await req('GET', '/api/recruitment'));
    expect(r.recruitment.open).toBe(true);
    expect(r.recruitment.checks.map((c: any) => c.label)).toEqual(['ルールブックを読み、内容に同意します', '参加者一覧への掲載に同意します', '18 歳以上です']);
  });

  it('応募できるのはログインした一般の人だけ（未ログイン・運営・参加者は不可）', async () => {
    const { a, t } = await setup();
    expect((await req('POST', '/api/applications', { body: {} })).status).toBe(401);
    expect((await req('POST', '/api/applications', { auth: a.subA, body: {} })).status).toBe(403);
    const m = await makeUser();
    await addMember(t.id, m, 'player', t.teams[0]!);
    expect((await req('POST', '/api/applications', { auth: await loginAs(m), body: {} })).status).toBe(409);
  });

  it('入力の検査：選手のランク、同じレーン、OP.GG 以外の URL、募集していない区分、確認事項の同意漏れ', async () => {
    await setup();
    const u = await applicant();
    expect((await apply(u.auth, { rank: null })).status).toBe(422);
    expect((await apply(u.auth, { secondLane: 'MID' })).status).toBe(422);
    expect((await apply(u.auth, { opggUrl: 'https://evil.example/op.gg' })).status).toBe(422);
    expect((await apply(u.auth, { kind: 'staff' })).status).toBe(422);
    expect((await apply(u.auth, { agreedCheckIds: [] })).status).toBe(422);
    expect((await json(await req('GET', '/api/applications/mine', { auth: u.auth }))).application).toBeNull();
    expect((await apply(u.auth, { mainLane: 'ALL', secondLane: null })).status).toBe(201);
    expect((await apply(u.auth)).status).toBe(409);
  });

  it('ランクは「段階 区分」の形（Silver Ⅱ など）。Master 以上は区分なし。区分のない Silver や Master Ⅰ は拒否', async () => {
    await setup();
    for (const bad of ['Silver', 'Master Ⅰ', 'Silver 2', 'Silver Ⅴ']) expect((await apply((await applicant()).auth, { rank: bad })).status).toBe(422);
    const u = await applicant();
    expect((await apply(u.auth, { rank: 'Master' })).status).toBe(201);
    const v = await applicant();
    expect((await apply(v.auth, { rank: 'Silver Ⅱ' })).status).toBe(201);
    expect((await json(await req('GET', '/api/applications/mine', { auth: v.auth }))).application.rank).toBe('Silver Ⅱ');
  });

  it('コーチはランク・レーンが任意。他人の宣材写真は使えない', async () => {
    await setup();
    const u = await applicant();
    const other = await applicant();
    const othersPhoto = await uploadPhoto(other.auth);
    expect((await apply(u.auth, { kind: 'coach', rank: null, mainLane: null, secondLane: null, photoId: othersPhoto })).status).toBe(422);
    expect((await apply(u.auth, { kind: 'coach', rank: null, mainLane: null, secondLane: null })).status).toBe(201);
  });

  it('締切までは修正・取り下げでき、取り下げると応募と宣材写真がすぐに消える。締切後はできない', async () => {
    const s = await setup();
    const u = await applicant();
    await apply(u.auth);
    const rec = await json(await req('GET', '/api/recruitment', { auth: u.auth }));
    const body = { kind: 'player', opggUrl: 'https://op.gg/x', rank: 'Gold Ⅰ', mainLane: 'SUP', secondLane: 'BOT', agreedCheckIds: rec.recruitment.checks.map((c: any) => c.id) };
    expect((await req('PUT', '/api/applications/mine', { auth: u.auth, body })).status).toBe(200);
    const app1 = await env.DB.prepare('SELECT photo_image_id FROM applications WHERE user_id = ?').bind(u.id).first<{ photo_image_id: string }>();
    const key = (await env.DB.prepare('SELECT r2_key FROM images WHERE id = ?').bind(app1!.photo_image_id).first<{ r2_key: string }>())!.r2_key;
    expect((await req('DELETE', '/api/applications/mine', { auth: u.auth })).status).toBe(200);
    expect(await env.IMAGES.get(key)).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM images WHERE id = ?').bind(app1!.photo_image_id).first()).toBeNull();
    const u2 = await applicant();
    await apply(u2.auth);
    s.closeLater();
    expect((await req('PUT', '/api/applications/mine', { auth: u2.auth, body })).status).toBe(409);
    expect((await req('DELETE', '/api/applications/mine', { auth: u2.auth })).status).toBe(409);
  });
});

describe('運営による応募内容の修正', () => {
  it('管理者は X などを直せて、本人の応募状況に修正日時が出る。操作ログには項目名だけが残る', async () => {
    const s = await setup();
    const u = await applicant();
    const { id } = await json(await apply(u.auth, { xAccount: 'typo_accont' }));
    const body = { opggUrl: 'https://op.gg/summoners/jp/test', rank: 'Diamond Ⅲ', mainLane: 'MID', secondLane: 'TOP', xAccount: 'typo_account', streamUrls: [] };
    const r = await json(await req('PUT', `/api/admin/applications/${id}`, { auth: s.a.subA, body }));
    expect(r.changed).toEqual(['x_account']);
    const mine = (await json(await req('GET', '/api/applications/mine', { auth: u.auth }))).application;
    expect(mine.xAccount).toBe('typo_account');
    expect(mine.staffEditedAt).toBeTruthy();
    const log = await env.DB.prepare("SELECT detail FROM audit_logs WHERE action = 'application_staff_edit' AND target_id = ?").bind(id).first<{ detail: string }>();
    expect(JSON.parse(log!.detail)).toEqual({ fields: ['x_account'] });
    expect(log!.detail).not.toContain('typo_account');
  });

  it('本人と同じ入力の確認がかかる。区分は変えられない。管理者以外は修正できない', async () => {
    const s = await setup();
    const u = await applicant();
    const { id } = await json(await apply(u.auth));
    const base = { opggUrl: 'https://op.gg/x', rank: 'Diamond Ⅲ', mainLane: 'MID', secondLane: 'TOP' };
    expect((await req('PUT', `/api/admin/applications/${id}`, { auth: s.a.subA, body: { ...base, xAccount: 'bad name!' } })).status).toBe(422);
    expect((await req('PUT', `/api/admin/applications/${id}`, { auth: s.a.subA, body: { ...base, rank: 'Silver' } })).status).toBe(422);
    await req('PUT', `/api/admin/applications/${id}`, { auth: s.a.subA, body: { ...base, kind: 'coach' } });
    expect((await env.DB.prepare('SELECT kind FROM applications WHERE id = ?').bind(id).first<{ kind: string }>())!.kind).toBe('player');
    expect((await req('PUT', `/api/admin/applications/${id}`, { auth: u.auth, body: base })).status).toBe(403);
  });
});

describe('審査', () => {
  async function withApplication() {
    const s = await setup();
    const u = await applicant();
    const { id } = await json(await apply(u.auth));
    return { ...s, u, appId: id as string };
  }

  it('審査担当は管理者から 2 人まで。担当でない人は審査を送れない', async () => {
    const { a, ids, appId, u } = await withApplication();
    expect((await req('PUT', `/api/admin/applications/${appId}/reviewers`, { auth: a.sup, body: { reviewerIds: [u.id] } })).status).toBe(422);
    expect((await req('PUT', `/api/admin/applications/${appId}/reviewers`, { auth: a.sup, body: { reviewerIds: [ids.subA, ids.subB, ids.sup] } })).status).toBe(422);
    expect((await req('PUT', `/api/admin/applications/${appId}/reviewers`, { auth: a.sup, body: { reviewerIds: [ids.subA, ids.subB] } })).status).toBe(200);
    expect((await req('PUT', `/api/admin/applications/${appId}/review`, { auth: a.sup, body: { grade: 'A' } })).status).toBe(403);
    expect((await req('PUT', `/api/admin/applications/${appId}/review`, { auth: a.subA, body: { grade: 'S' } })).status).toBe(422);
  });

  it('もう 1 人の審査は、自分の審査を送信するまで見えない。担当でない管理者は両方見られる', async () => {
    const { a, ids, appId } = await withApplication();
    await req('PUT', `/api/admin/applications/${appId}/reviewers`, { auth: a.sup, body: { reviewerIds: [ids.subA, ids.subB] } });
    await req('PUT', `/api/admin/applications/${appId}/review`, { auth: a.subA, body: { grade: 'A', comment: 'MID が上手い' } });
    const beforeB = (await json(await req('GET', `/api/admin/applications/${appId}`, { auth: a.subB }))).reviews;
    const other = beforeB.find((r: any) => !r.mine);
    expect(other.hidden).toBe(true);
    expect(other.grade).toBeNull();
    expect(JSON.stringify(beforeB)).not.toContain('MID が上手い');
    await req('PUT', `/api/admin/applications/${appId}/review`, { auth: a.subB, body: { grade: 'B' } });
    const afterB = (await json(await req('GET', `/api/admin/applications/${appId}`, { auth: a.subB }))).reviews;
    expect(afterB.find((r: any) => !r.mine).grade).toBe('A');
    const sup = (await json(await req('GET', `/api/admin/applications/${appId}`, { auth: a.sup }))).reviews;
    expect(sup.map((r: any) => r.grade).sort()).toEqual(['A', 'B']);
  });

  it('担当の自動割り当ては、1 件につき 2 人ずつ、担当の少ない管理者から順に入れる', async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) await apply((await applicant()).auth);
    const r = await json(await req('POST', '/api/admin/applications/auto-assign', { auth: s.a.subA }));
    expect(r.assigned).toBe(6);
    const { applications } = await json(await req('GET', '/api/admin/applications', { auth: s.a.sup }));
    expect(applications.every((x: any) => x.reviews.length === 2)).toBe(true);
  });

  it('審査の担当・評価・仮決定は、管理者以外には一切返さない', async () => {
    const { appId, u } = await withApplication();
    expect((await req('GET', `/api/admin/applications/${appId}`, { auth: u.auth })).status).toBe(403);
    expect((await req('GET', '/api/admin/provisional', { auth: u.auth })).status).toBe(403);
    for (const path of ['/api/recruitment', '/api/applications/mine']) {
      const text = JSON.stringify(await json(await req('GET', path, { auth: u.auth })));
      for (const f of ['grade', 'comment', 'review', 'provisional', 'draft_role', 'draftRole']) expect(text, `${path} に ${f}`).not.toContain(f);
    }
  });
});

describe('仮決定表と発表', () => {
  async function reviewed(n: number) {
    const s = await setup();
    const people: { id: string; auth: Auth; appId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const u = await applicant();
      const { id } = await json(await apply(u.auth));
      await req('PUT', `/api/admin/applications/${id}/reviewers`, { auth: s.a.sup, body: { reviewerIds: [s.ids.subA, s.ids.subB] } });
      await req('PUT', `/api/admin/applications/${id}/review`, { auth: s.a.subA, body: { grade: 'B' } });
      await req('PUT', `/api/admin/applications/${id}/review`, { auth: s.a.subB, body: { grade: 'C' } });
      people.push({ ...u, appId: id });
    }
    return { ...s, people };
  }

  it('仮決定表に入れられるのは 2 人の審査の後。ロール別の人数が数えられる', async () => {
    const s = await setup();
    const u = await applicant();
    const { id } = await json(await apply(u.auth));
    expect((await req('PUT', `/api/admin/applications/${id}/provisional`, { auth: s.a.sup, body: { memberType: 'player', draftRole: 'MID' } })).status).toBe(409);
    const r = await reviewed(1);
    expect((await req('PUT', `/api/admin/applications/${r.people[0]!.appId}/provisional`, { auth: r.a.subB, body: { memberType: 'player', draftRole: 'MID' } })).status).toBe(200);
    const table = await json(await req('GET', '/api/admin/provisional', { auth: r.a.sup }));
    expect(table.roleCounts.MID).toBe(1);
    expect(table.teamCount).toBe(2);
    expect(table.lastUpdate.by).toBe('審査B');
  });

  it('発表は締切後だけ。仮決定表の人は採用、それ以外は不採用で、不採用の人の応募・審査・宣材写真は消え、記録だけ残る', async () => {
    const r = await reviewed(2);
    const [win, lose] = r.people as [typeof r.people[0], typeof r.people[0]];
    await req('PUT', `/api/admin/applications/${win.appId}/provisional`, { auth: r.a.sup, body: { memberType: 'player', draftRole: 'TOP' } });
    expect((await req('POST', '/api/admin/selection/announce', { auth: r.a.sup })).status).toBe(409);
    expect((await json(await req('GET', '/api/applications/mine', { auth: win.auth }))).status).toBe('submitted');
    r.closeLater();
    // 締切後・発表前は、採用予定でも「選考中」としか見えない
    const winAuth = await loginAs(win.id);
    const loseAuth = await loginAs(lose.id);
    expect((await json(await req('GET', '/api/applications/mine', { auth: winAuth }))).status).toBe('selecting');
    expect((await json(await req('GET', '/api/applications/mine', { auth: loseAuth }))).status).toBe('selecting');
    const losePhoto = (await env.DB.prepare('SELECT photo_image_id FROM applications WHERE id = ?').bind(lose.appId).first<{ photo_image_id: string }>())!.photo_image_id;
    const loseKey = (await env.DB.prepare('SELECT r2_key FROM images WHERE id = ?').bind(losePhoto).first<{ r2_key: string }>())!.r2_key;
    const supAuth = await loginAs(r.ids.sup);
    const res = await json(await req('POST', '/api/admin/selection/announce', { auth: supAuth }));
    expect([res.accepted, res.rejected]).toEqual([1, 1]);
    const m = await env.DB.prepare('SELECT member_type, draft_role FROM tournament_members WHERE user_id = ?').bind(win.id).first();
    expect(m).toEqual({ member_type: 'player', draft_role: 'TOP' });
    expect(await env.DB.prepare('SELECT 1 FROM applications WHERE id = ?').bind(lose.appId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM reviews WHERE application_id = ?').bind(lose.appId).first()).toBeNull();
    expect(await env.IMAGES.get(loseKey)).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rejection_records WHERE user_id = ?').bind(lose.id).first()).toBeTruthy();
    expect((await json(await req('GET', '/api/applications/mine', { auth: await loginAs(lose.id) }))).status).toBe('rejected');
    expect((await json(await req('GET', '/api/applications/mine', { auth: await loginAs(win.id) }))).status).toBe('accepted');
    expect(sent.at(-1)).toContain('選考結果を発表しました');
    expect((await req('POST', '/api/admin/selection/announce', { auth: supAuth })).status).toBe(409);
  });

  it('不採用だった人は、同じ大会には応募し直せない', async () => {
    const r = await reviewed(1);
    r.closeLater();
    await req('POST', '/api/admin/selection/announce', { auth: await loginAs(r.ids.sup) });
    const res = await req('POST', '/api/applications', { auth: await loginAs(r.people[0]!.id), body: {} });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('already_decided');
  });

  it('採用の取り消しはドラフト開始前まで。取り消すと不採用と同じ扱いになる', async () => {
    const r = await reviewed(1);
    const p = r.people[0]!;
    await req('PUT', `/api/admin/applications/${p.appId}/provisional`, { auth: r.a.sup, body: { memberType: 'player', draftRole: 'SUP' } });
    r.closeLater();
    const sup = await loginAs(r.ids.sup);
    await req('POST', '/api/admin/selection/announce', { auth: sup });
    await env.DB.prepare("UPDATE tournaments SET phase = 'drafting' WHERE id = ?").bind(r.t.id).run();
    expect((await req('POST', `/api/admin/applications/${p.appId}/cancel-acceptance`, { auth: sup })).status).toBe(409);
    await env.DB.prepare("UPDATE tournaments SET phase = 'selecting' WHERE id = ?").bind(r.t.id).run();
    expect((await req('POST', `/api/admin/applications/${p.appId}/cancel-acceptance`, { auth: sup })).status).toBe(200);
    expect(await env.DB.prepare('SELECT 1 FROM tournament_members WHERE user_id = ?').bind(p.id).first()).toBeNull();
    expect((await json(await req('GET', '/api/applications/mine', { auth: await loginAs(p.id) }))).status).toBe('rejected');
  });
});
