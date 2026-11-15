import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { setClockForTest } from '../src/lib/time';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, req } from './helpers';

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

// スクリム期間：2027-02-10〜2027-02-20（日本時間）
const SCRIM_START = '2027-02-09T15:00:00.000Z';
const SCRIM_END = '2027-02-19T15:00:00.000Z';
const jst = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+09:00`).toISOString();

async function world() {
  const t = await makeTournament(3, 'scrim');
  await env.DB.prepare('UPDATE tournaments SET scrim_start = ?, scrim_end = ? WHERE id = ?').bind(SCRIM_START, SCRIM_END, t.id).run();
  const [A, B, C] = t.teams as [string, string, string];
  const mk = async (type: 'player' | 'coach' | 'staff', team: string | null, name: string, lane: string | null = null) => {
    const id = await makeUser({ name }); await addMember(t.id, id, type, team, lane); return { id, auth: await loginAs(id) };
  };
  const lanes = ['TOP', 'JG', 'MID', 'BOT', 'SUP'];
  const a: Awaited<ReturnType<typeof mk>>[] = [];
  const b: Awaited<ReturnType<typeof mk>>[] = [];
  for (const [i, l] of lanes.entries()) { a.push(await mk('player', A, `A選手${i}`, l)); b.push(await mk('player', B, `B選手${i}`, l)); }
  return {
    t, A, B, C, a, b,
    coachA: await mk('coach', A, 'Aコーチ'), coachB: await mk('coach', B, 'Bコーチ'), coachC: await mk('coach', C, 'Cコーチ'),
    staff: await mk('staff', null, '運営スタッフ'), unassigned: await mk('player', null, '未所属さん', 'MID'),
    admin: await loginAs(await makeUser({ adminLevel: 'sub', name: '補助管理者' })), viewer: await loginAs(await makeUser()),
  };
}
type W = Awaited<ReturnType<typeof world>>;

async function slots(w: W, dates = ['2027-02-12', '2027-02-13']) {
  expect((await req('POST', '/api/admin/schedule/slots', { auth: w.admin, body: { dates, stdStart: '21:00', stdEnd: '24:00' } })).status).toBe(200);
  return (await json(await req('GET', '/api/schedule', { auth: w.admin }))).slots as { id: string; date: string }[];
}
const enter = (auth: Auth, entries: unknown[]) => req('PUT', '/api/schedule/mine', { auth, body: { entries } });

describe('予定表：日程の用意と入力', () => {
  it('見られるのは参加者と運営だけ', async () => {
    const w = await world();
    expect((await req('GET', '/api/schedule')).status).toBe(401);
    expect((await req('GET', '/api/schedule', { auth: w.viewer })).status).toBe(403);
    expect((await req('GET', '/api/schedule', { auth: w.a[0]!.auth })).status).toBe(200);
  });

  it('日程はスクリム期間内だけ登録でき、選手は登録できない', async () => {
    const w = await world();
    expect((await req('POST', '/api/admin/schedule/slots', { auth: w.admin, body: { dates: ['2027-02-25'], stdStart: '21:00', stdEnd: '24:00' } })).status).toBe(422);
    expect((await req('POST', '/api/admin/schedule/slots', { auth: w.a[0]!.auth, body: { dates: ['2027-02-12'], stdStart: '21:00', stdEnd: '24:00' } })).status).toBe(403);
    expect((await slots(w)).length).toBe(2);
  });

  it('○・△ は 30 分刻みの時間が必須。× は時間なしでよい。まとめて入力できる', async () => {
    const w = await world();
    const [s1, s2] = await slots(w);
    const me = w.a[0]!.auth;
    expect((await enter(me, [{ slotId: s1!.id, status: 'o' }])).status).toBe(422);
    expect((await enter(me, [{ slotId: s1!.id, status: 'o', start: '20:15', end: '23:00' }])).status).toBe(422);
    expect((await enter(me, [{ slotId: s1!.id, status: 't', start: '23:00', end: '22:00' }])).status).toBe(422);
    expect((await enter(me, [{ slotId: s1!.id, status: 'o', start: '21:00', end: '24:00' }, { slotId: s2!.id, status: 'x' }])).status).toBe(200);
    const mine = (await json(await req('GET', '/api/schedule', { auth: me }))).mine;
    expect(mine[s1!.id]).toMatchObject({ status: 'o', start: '21:00', end: '24:00' });
    expect(mine[s2!.id].status).toBe('x');
  });

  it('締切後の変更には印が付く', async () => {
    const w = await world();
    const [s1] = await slots(w);
    await env.DB.prepare('UPDATE tournaments SET schedule_deadline = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', w.t.id).run();
    expect((await json(await enter(w.a[0]!.auth, [{ slotId: s1!.id, status: 'x' }]))).late).toBe(true);
    const team = (await json(await req('GET', '/api/schedule', { auth: w.coachA.auth }))).teams.find((t: any) => t.isMine);
    expect(team.members.find((m: any) => m.userId === w.a[0]!.id).entries[s1!.id].changedAfterDeadline).toBe(true);
  });
});

describe('予定表：見え方', () => {
  it('同じ時間にそろう選手の人数で数える（コーチは数えない）', async () => {
    const w = await world();
    const [s1] = await slots(w);
    for (const p of w.a) await enter(p.auth, [{ slotId: s1!.id, status: 'o', start: '21:00', end: '23:00' }]);
    await enter(w.coachA.auth, [{ slotId: s1!.id, status: 'o', start: '21:00', end: '23:00' }]);
    const team = (await json(await req('GET', '/api/schedule', { auth: w.b[0]!.auth }))).teams.find((t: any) => t.id === w.A);
    expect(team.perSlot[s1!.id]).toMatchObject({ count: 5, window: ['21:00', '23:00'] });
  });

  it('他チームには人数と △ の時間帯だけ。個人の名前や入力は返さない', async () => {
    const w = await world();
    const [s1] = await slots(w);
    await enter(w.b[0]!.auth, [{ slotId: s1!.id, status: 't', start: '22:00', end: '23:00' }]);
    const data = await json(await req('GET', '/api/schedule', { auth: w.a[0]!.auth }));
    const teamB = data.teams.find((t: any) => t.id === w.B);
    expect(teamB.members).toBeUndefined();
    expect(teamB.perSlot[s1!.id].triangles).toEqual([['22:00', '23:00']]);
    expect(JSON.stringify(teamB)).not.toContain('B選手');
    expect(JSON.stringify(teamB)).not.toContain(w.b[0]!.id);
    expect(data.teams.find((t: any) => t.id === w.A).members.length).toBe(6); // 自チーム：選手 5＋コーチ 1
  });

  it('運営の入力は「運営」として全員に見える。所属が決まる前の選手の入力は管理者だけ', async () => {
    const w = await world();
    const [s1] = await slots(w);
    await enter(w.staff.auth, [{ slotId: s1!.id, status: 'o', start: '21:00', end: '24:00' }]);
    await enter(w.unassigned.auth, [{ slotId: s1!.id, status: 'o', start: '21:00', end: '24:00' }]);
    const asPlayer = await json(await req('GET', '/api/schedule', { auth: w.a[0]!.auth }));
    expect(asPlayer.staff.some((s: any) => s.name === '運営スタッフ' && s.entries[s1!.id])).toBe(true);
    expect(asPlayer.unassigned).toBeUndefined();
    expect(JSON.stringify(asPlayer)).not.toContain('未所属さん');
    const asAdmin = await json(await req('GET', '/api/schedule', { auth: w.admin }));
    expect(asAdmin.unassigned.map((u: any) => u.name)).toEqual(['未所属さん']);
  });
});

describe('TOP の「やること」と「次の予定」', () => {
  it('予定表の未入力の日数が「やること」に出る。確定した自分のスクリムが「次の予定」に出る', async () => {
    const w = await world();
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    await env.DB.prepare('UPDATE tournaments SET scrim_start = ?, scrim_end = ? WHERE id = ?').bind(new Date(Date.now() - 86400e3).toISOString(), new Date(Date.now() + 30 * 86400e3).toISOString(), w.t.id).run();
    const later = new Date(Date.now() + 9 * 3600e3 + 2 * 86400e3).toISOString().slice(0, 10);
    await req('POST', '/api/admin/schedule/slots', { auth: w.admin, body: { dates: [today, later], stdStart: '21:00', stdEnd: '24:00' } });
    const home = await json(await req('GET', '/api/home', { auth: w.a[0]!.auth }));
    expect(home.todos.map((x: any) => x.title)).toContain('予定表に未入力の日が 2 日あります');
    const s = new Date(`${later}T21:00:00+09:00`).toISOString();
    await env.DB.prepare("INSERT INTO scrims (id, tournament_id, requester_team_id, opponent_team_id, format, status, starts_at, ends_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'BO1', 'confirmed', ?, ?, 'x', '', '')")
      .bind(`home-${w.t.id}`, w.t.id, w.A, w.B, s, new Date(new Date(s).getTime() + 7200e3).toISOString()).run();
    await env.DB.prepare("INSERT INTO scrim_participants (scrim_id, user_id, team_id, via, created_at, updated_at) VALUES (?, ?, ?, 'team', '', '')").bind(`home-${w.t.id}`, w.a[0]!.id, w.A).run();
    const events = (await json(await req('GET', '/api/home', { auth: w.a[0]!.auth }))).events;
    expect(events.some((e: any) => e.kind === 'scrim' && e.title === 'スクリム チーム 1 vs チーム 2')).toBe(true);
    expect((await json(await req('GET', '/api/home', { auth: w.b[0]!.auth }))).events.some((e: any) => e.kind === 'scrim')).toBe(false);
  });
});

describe('スクリム', () => {
  const cand = (date: string, s: string, e: string) => ({ startsAt: jst(date, s), endsAt: jst(date, e) });
  const request = (w: W, auth: Auth, opponent: string, candidates = [cand('2027-02-12', '21:00', '23:00')]) =>
    req('POST', '/api/scrims', { auth, body: { opponentTeamId: opponent, format: 'BO3', candidates } });

  it('申請できるのはコーチと管理者。相手は別チーム、日付はスクリム期間内だけ', async () => {
    const w = await world();
    expect((await request(w, w.a[0]!.auth, w.B)).status).toBe(403);
    expect((await request(w, w.coachA.auth, w.A)).status).toBe(422);
    expect((await request(w, w.coachA.auth, w.B, [cand('2027-03-01', '21:00', '23:00')])).status).toBe(422);
    expect((await request(w, w.coachA.auth, w.B)).status).toBe(201);
    expect(sent.at(-1)).toContain('スクリムの申請');
  });

  it('確定までは選手には見えない。確定は相手側が行い、自チームが出した候補は自分では確定できない', async () => {
    const w = await world();
    const { id } = await json(await request(w, w.coachA.auth, w.B));
    expect((await json(await req('GET', '/api/scrims', { auth: w.a[0]!.auth }))).scrims).toEqual([]);
    expect((await json(await req('GET', '/api/scrims', { auth: w.coachC.auth }))).scrims).toHaveLength(1); // コーチは全チームを見られる
    const [c1] = (await json(await req('GET', '/api/scrims', { auth: w.coachB.auth }))).scrims[0].candidates;
    expect((await req('POST', `/api/scrims/${id}/confirm`, { auth: w.coachA.auth, body: { candidateId: c1.id } })).status).toBe(409);
    expect((await req('POST', `/api/scrims/${id}/confirm`, { auth: w.coachC.auth, body: { candidateId: c1.id } })).status).toBe(403);
    expect((await req('POST', `/api/scrims/${id}/confirm`, { auth: w.coachB.auth, body: { candidateId: c1.id } })).status).toBe(200);
    expect((await json(await req('GET', '/api/scrims', { auth: w.a[0]!.auth }))).scrims[0].status).toBe('confirmed');
    expect(sent.at(-1)).toMatch(/スクリム確定：チーム 1 vs チーム 2　2\/12.*21:00〜23:00（BO3）/);
    const detail = await json(await req('GET', `/api/scrims/${id}`, { auth: w.coachA.auth }));
    expect(detail.participants).toHaveLength(10); // 両チームの選手全員
  });

  it('別案を返すと候補が入れ替わり、今度は申請した側が確定する', async () => {
    const w = await world();
    const { id } = await json(await request(w, w.coachA.auth, w.B));
    expect((await req('POST', `/api/scrims/${id}/propose`, { auth: w.coachB.auth, body: { candidates: [cand('2027-02-13', '22:00', '24:00')] } })).status).toBe(200);
    const s = (await json(await req('GET', '/api/scrims', { auth: w.coachA.auth }))).scrims[0];
    expect(s.status).toBe('negotiating');
    expect(s.candidates).toHaveLength(1);
    expect((await req('POST', `/api/scrims/${id}/confirm`, { auth: w.coachB.auth, body: { candidateId: s.candidates[0].id } })).status).toBe(409);
    expect((await req('POST', `/api/scrims/${id}/confirm`, { auth: w.coachA.auth, body: { candidateId: s.candidates[0].id } })).status).toBe(200);
  });

  it('同じチームの確定済みスクリムと時間が重なると確定できない。配信と重なると注意が出る', async () => {
    const w = await world();
    const first = await json(await request(w, w.coachA.auth, w.B));
    const c1 = (await json(await req('GET', '/api/scrims', { auth: w.coachB.auth }))).scrims.find((s: any) => s.id === first.id).candidates[0];
    await req('POST', `/api/scrims/${first.id}/confirm`, { auth: w.coachB.auth, body: { candidateId: c1.id } });
    const second = await json(await request(w, w.coachC.auth, w.A, [cand('2027-02-12', '22:00', '24:00')]));
    const c2 = (await json(await req('GET', '/api/scrims', { auth: w.coachA.auth }))).scrims.find((s: any) => s.id === second.id).candidates[0];
    expect((await req('POST', `/api/scrims/${second.id}/confirm`, { auth: w.coachA.auth, body: { candidateId: c2.id } })).status).toBe(409);
    await env.DB.prepare("INSERT INTO events (id, tournament_id, kind, title, starts_at, ends_at, created_at, updated_at) VALUES ('ev1', ?, 'stream', '配信X', ?, ?, '', '')")
      .bind(w.t.id, jst('2027-02-14', '20:00'), jst('2027-02-14', '22:00')).run();
    const third = await json(await request(w, w.coachC.auth, w.B, [cand('2027-02-14', '21:00', '23:00')]));
    const c3 = (await json(await req('GET', '/api/scrims', { auth: w.coachB.auth }))).scrims.find((s: any) => s.id === third.id).candidates[0];
    const r = await json(await req('POST', `/api/scrims/${third.id}/confirm`, { auth: w.coachB.auth, body: { candidateId: c3.id } }));
    expect(r.warnings).toEqual(['配信「配信X」と時間が重なっています']);
  });

  it('候補の自動提示：両チームの選手がそろう日程を、そろう人数の多い順に出す', async () => {
    const w = await world();
    const [s1, s2] = await slots(w);
    for (const p of w.a) await enter(p.auth, [{ slotId: s1!.id, status: 'o', start: '21:00', end: '24:00' }, { slotId: s2!.id, status: 'o', start: '20:00', end: '23:00' }]);
    for (const [i, p] of w.b.entries()) await enter(p.auth, [{ slotId: s1!.id, status: i < 3 ? 'o' : 'x', start: i < 3 ? '22:00' : undefined, end: i < 3 ? '24:00' : undefined }, { slotId: s2!.id, status: 'o', start: '21:00', end: '24:00' }]);
    const { suggestions } = await json(await req('GET', `/api/scrims/suggest/${w.B}`, { auth: w.coachA.auth }));
    expect(suggestions[0]).toMatchObject({ date: '2027-02-13', mine: 5, opponent: 5, window: ['21:00', '23:00'] });
    expect(suggestions[1]).toMatchObject({ date: '2027-02-12', opponent: 3 });
  });

  it('参加メンバーは自チームの選手だけ選べる。実施済みは開始後だけ。中止には理由が必要', async () => {
    const w = await world();
    const { id } = await json(await request(w, w.coachA.auth, w.B));
    const c1 = (await json(await req('GET', '/api/scrims', { auth: w.coachB.auth }))).scrims[0].candidates[0];
    await req('POST', `/api/scrims/${id}/confirm`, { auth: w.coachB.auth, body: { candidateId: c1.id } });
    expect((await req('PUT', `/api/scrims/${id}/participants`, { auth: w.coachA.auth, body: { userIds: [w.b[0]!.id] } })).status).toBe(422);
    expect((await req('PUT', `/api/scrims/${id}/participants`, { auth: w.coachA.auth, body: { userIds: w.a.slice(0, 4).map((p) => p.id) } })).status).toBe(200);
    expect((await req('POST', `/api/scrims/${id}/done`, { auth: w.coachA.auth })).status).toBe(409);
    expect((await req('POST', `/api/scrims/${id}/cancel`, { auth: w.coachA.auth, body: {} })).status).toBe(422);
    setClockForTest(() => new Date('2027-02-12T15:00:00Z'));
    // 時計を進めたのでログインの期限（7 日）が切れている。ログインし直す
    expect((await req('POST', `/api/scrims/${id}/done`, { auth: await loginAs(w.coachA.id) })).status).toBe(200);
  });
});
