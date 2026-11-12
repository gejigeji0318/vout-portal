import { Anchor, Badge, Button, Card, Checkbox, Group, Image, Loader, Modal, MultiSelect, Radio, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { APEX_TIERS, APPLY_LANES, DIVISION_TIERS, DIVISIONS, fromInputDateTime, joinRank, LANES, MEMBER_TYPE, showDateTime, splitRank, teamLabel, toInputDateTime } from '../../labels';
import { opggUrlError, streamUrlError, xAccountError } from '../../validators';
import { done, fail, type Team } from './shared';

/** SC-18 応募・選考：審査／仮決定表／募集設定 */
export function SelectionTab() {
  const [view, setView] = useState('review');
  return (
    <Stack gap="md">
      <SegmentedControl value={view} onChange={setView} w="fit-content" data={[{ value: 'review', label: '審査' }, { value: 'table', label: '仮決定表' }, { value: 'settings', label: '募集設定' }]} />
      {view === 'review' && <ReviewView />}
      {view === 'table' && <ProvisionalView />}
      {view === 'settings' && <SettingsView />}
    </Stack>
  );
}

const GRADE_COLOR: Record<string, string> = { A: 'green', B: 'green', C: 'orange', D: 'red', E: 'red' };
interface Review { reviewerId: string; reviewerName: string; submitted: boolean; grade: string | null; comment: string | null; hidden: boolean; mine: boolean }
interface AppRow { id: string; name: string; kind: string; rank: string | null; mainLane: string | null; secondLane: string | null; reviews: Review[]; provisional: { memberType: string; draftRole: string | null } | null }

const ReviewChips = ({ reviews }: { reviews: Review[] }) => {
  const sent = reviews.filter((r) => r.submitted);
  if (!reviews.length) return <Badge color="red" variant="light">担当未定</Badge>;
  return (
    <Group gap={4} wrap="nowrap">
      {sent.map((r) => (r.grade ? <Badge key={r.reviewerId} color={GRADE_COLOR[r.grade]} variant="light">{r.grade}</Badge> : <Badge key={r.reviewerId} color="gray" variant="light">済</Badge>))}
      {sent.length < 2 && <Badge color="gray" variant="outline">{sent.length} / 2</Badge>}
    </Group>
  );
};

// ---------------- 審査 ----------------
function ReviewView() {
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [admins, setAdmins] = useState<{ id: string; name: string }[]>([]);
  const [filter, setFilter] = useState('all');
  const load = useCallback(() => api<{ applications: AppRow[] }>('GET', '/api/admin/applications').then((r) => setApps(r.applications)).catch(fail), []);
  useEffect(() => { void load(); api<{ admins: { id: string; name: string }[] }>('GET', '/api/admin/admins').then((r) => setAdmins(r.admins)).catch(() => {}); }, [load]);
  if (!apps) return <Loader />;
  const autoAssign = async () => { try { const r = await api<{ assigned: number }>('POST', '/api/admin/applications/auto-assign'); done(`${r.assigned} 件の担当を割り当てました`); void load(); } catch (e) { fail(e); } };
  const count = (f: (a: AppRow) => boolean) => apps.filter(f).length;
  const shown = apps.filter((a) => filter === 'all' || (filter === 'mine' && a.reviews.some((r) => r.mine && !r.submitted)) || (filter === 'provisional' && a.provisional));
  return (
    <Stack gap="md">
      <Group gap="xs">
        <Badge size="lg" color="red" variant="light">担当未定 {count((a) => a.reviews.length < 2)}</Badge>
        <Badge size="lg" color="orange" variant="light">審査中 {count((a) => a.reviews.length === 2 && a.reviews.some((r) => !r.submitted))}</Badge>
        <Badge size="lg" color="green" variant="light">審査完了 {count((a) => a.reviews.length === 2 && a.reviews.every((r) => r.submitted))}</Badge>
        <Badge size="lg" color="blue" variant="light">仮決定 {count((a) => Boolean(a.provisional))}</Badge>
        <Button variant="default" size="xs" onClick={autoAssign}>担当をまとめて割り当て</Button>
      </Group>
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Stack gap="xs">
          <Select aria-label="絞り込み" w={240} value={filter} onChange={(v) => v && setFilter(v)} allowDeselect={false}
            data={[{ value: 'all', label: `すべて（${apps.length} 件）` }, { value: 'mine', label: '自分が担当で未審査' }, { value: 'provisional', label: '仮決定に入っている' }]} />
          <Table.ScrollContainer minWidth={520}>
            <Table highlightOnHover verticalSpacing="xs">
              <Table.Thead><Table.Tr><Table.Th>応募者</Table.Th><Table.Th>区分</Table.Th><Table.Th>ランク・レーン</Table.Th><Table.Th>審査</Table.Th><Table.Th>仮決定</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {shown.map((a) => (
                  <Table.Tr key={a.id} onClick={() => setSel(a.id)} style={{ cursor: 'pointer', background: sel === a.id ? '#f3f6fe' : undefined }}>
                    <Table.Td><Anchor component="button" onClick={() => setSel(a.id)} fw={700}>{a.name}</Anchor></Table.Td>
                    <Table.Td>{MEMBER_TYPE[a.kind]}</Table.Td>
                    <Table.Td>{a.rank ?? '—'}・{a.mainLane ?? '—'}{a.secondLane ? ` / ${a.secondLane}` : ''}</Table.Td>
                    <Table.Td><ReviewChips reviews={a.reviews} /></Table.Td>
                    <Table.Td>{a.provisional ? <Badge color="blue" variant="light">仮決定</Badge> : <Text size="sm" c="var(--muted)">候補</Text>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
        {sel ? <Detail key={sel} id={sel} admins={admins} onChanged={() => void load()} /> : <Text c="var(--muted)">一覧から応募者を選んでください。</Text>}
      </SimpleGrid>
    </Stack>
  );
}

interface DetailRes {
  application: { id: string; name: string; kind: string; opggUrl: string; rank: string | null; mainLane: string | null; secondLane: string | null; xAccount: string | null;
    streamUrls: string[]; photoUrl: string | null; agreedChecks: string[]; submittedAt: string; staffEditedAt: string | null };
  reviews: Review[];
}

function Detail({ id, admins, onChanged }: { id: string; admins: { id: string; name: string }[]; onChanged: () => void }) {
  const [d, setD] = useState<DetailRes | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api<DetailRes>('GET', `/api/admin/applications/${id}`).then(setD).catch(fail), [id]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <Loader />;
  const a = d.application;
  const mine = d.reviews.find((r) => r.mine);
  const reviewsDone = d.reviews.length === 2 && d.reviews.every((r) => r.submitted);
  const after = () => { void load(); onChanged(); };
  const rows: [string, React.ReactNode][] = [
    ['区分', MEMBER_TYPE[a.kind]], ['ランク', a.rank ?? '—'], ['レーン', `${a.mainLane ?? '—'}${a.secondLane ? ` / ${a.secondLane}` : ''}`],
    ['OP.GG', <Anchor href={a.opggUrl} target="_blank" rel="noopener noreferrer">開く</Anchor>],
    ['X', a.xAccount ? <Anchor href={`https://x.com/${a.xAccount}`} target="_blank" rel="noopener noreferrer">@{a.xAccount}</Anchor> : '—'],
    ['配信', a.streamUrls.length ? a.streamUrls.map((u) => <Anchor key={u} href={u} target="_blank" rel="noopener noreferrer" mr="xs">{new URL(u).hostname}</Anchor>) : '—'],
    ['確認事項', `${a.agreedChecks.length} 件すべて同意`], ['応募日時', showDateTime(a.submittedAt)],
  ];
  return (
    <Card withBorder padding="lg" style={{ borderColor: '#2148b8', borderWidth: 2 }}>
      <Group align="flex-start" gap="md" mb="md" wrap="nowrap">
        {a.photoUrl && <Image src={a.photoUrl} alt={`${a.name} の宣材写真`} w={88} h={88} radius="md" />}
        <div style={{ flex: 1 }}>
          <Group justify="space-between"><Title order={2} size="h3">{a.name}</Title><Button size="xs" variant="default" onClick={() => setEditing(true)}>内容を修正</Button></Group>
          {a.staffEditedAt && <Text size="xs" c="var(--muted)">{showDateTime(a.staffEditedAt)} に運営が修正済み</Text>}
        </div>
      </Group>
      <dl style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '4px 12px', margin: '0 0 16px', fontSize: 14 }}>
        {rows.map(([k, v]) => <Fragment key={k}><dt style={{ color: 'var(--muted)' }}>{k}</dt><dd style={{ margin: 0 }}>{v}</dd></Fragment>)}
      </dl>
      <Group justify="space-between" p="sm" mb="sm" style={{ border: '1px dashed #c3cad5', borderRadius: 10 }}>
        <Text size="sm">審査担当：{d.reviews.length ? d.reviews.map((r) => (r.mine ? 'あなた' : r.reviewerName)).join('・') : '未定'}</Text>
        <Button size="xs" variant="default" onClick={() => setAssigning(true)}>担当を変更</Button>
      </Group>
      <Stack gap="xs" mb="md">
        {d.reviews.filter((r) => !r.mine).map((r) => (
          <Card key={r.reviewerId} withBorder padding="sm" bg="#f5f6f8">
            <Text size="sm" fw={700}>{r.reviewerName} の審査</Text>
            {r.hidden ? <Text size="sm" c="var(--muted)">自分の審査を送信すると表示されます</Text>
              : !r.submitted ? <Text size="sm" c="var(--muted)">まだ送信されていません</Text>
              : <><Badge color={GRADE_COLOR[r.grade!]} variant="light">{r.grade}</Badge>{r.comment && <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap' }}>{r.comment}</Text>}</>}
          </Card>
        ))}
      </Stack>
      {mine && <MyReview appId={id} mine={mine} onSaved={after} />}
      <Provisional app={a} enabled={reviewsDone} onSaved={after} />
      {editing && <EditDialog app={a} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); after(); }} />}
      {assigning && <AssignDialog appId={id} admins={admins} current={d.reviews.map((r) => r.reviewerId)} onClose={() => setAssigning(false)} onSaved={() => { setAssigning(false); after(); }} />}
    </Card>
  );
}

function MyReview({ appId, mine, onSaved }: { appId: string; mine: Review; onSaved: () => void }) {
  const [grade, setGrade] = useState(mine.grade ?? '');
  const [comment, setComment] = useState(mine.comment ?? '');
  const save = async () => { try { await api('PUT', `/api/admin/applications/${appId}/review`, { grade, comment: comment || null }); done('審査を送信しました'); onSaved(); } catch (e) { fail(e); } };
  return (
    <Card withBorder padding="sm" mb="md">
      <Radio.Group label={`あなたの審査（A が最も高い評価）${mine.submitted ? '・送信済み' : ''}`} value={grade} onChange={setGrade}>
        <Group mt="xs" gap="md">{['A', 'B', 'C', 'D', 'E'].map((g) => <Radio key={g} value={g} label={g} />)}</Group>
      </Radio.Group>
      <Textarea label="コメント" mt="sm" value={comment} onChange={(e) => setComment(e.currentTarget.value)} autosize minRows={2} maxLength={1000} />
      <Button mt="sm" onClick={save} disabled={!grade}>{mine.submitted ? '審査を更新' : '審査を送信'}</Button>
    </Card>
  );
}

function Provisional({ app, enabled, onSaved }: { app: DetailRes['application']; enabled: boolean; onSaved: () => void }) {
  const [type, setType] = useState(app.kind);
  const [role, setRole] = useState<string | null>(LANES.includes(app.mainLane ?? '') ? app.mainLane : null);
  const add = async () => {
    try { await api('PUT', `/api/admin/applications/${app.id}/provisional`, { memberType: type, draftRole: type === 'player' ? role : null }); done('仮決定表に入れました'); onSaved(); } catch (e) { fail(e); }
  };
  return (
    <Group align="flex-end" gap="xs">
      <Select label="採用後の立場" w={140} value={type} onChange={(v) => v && setType(v)} allowDeselect={false} data={Object.entries(MEMBER_TYPE).map(([value, label]) => ({ value, label }))} />
      {type === 'player' && <Select label="ドラフト用ロール" w={140} value={role} onChange={setRole} data={LANES} />}
      <Button onClick={add} disabled={!enabled || (type === 'player' && !role)} variant={enabled ? 'filled' : 'default'}>{enabled ? '仮決定表に入れる' : '仮決定表に入れる（2 人の審査後）'}</Button>
    </Group>
  );
}

/** 運営による応募内容の修正（区分と宣材写真は本人だけが変えられる） */
function EditDialog({ app, onClose, onSaved }: { app: DetailRes['application']; onClose: () => void; onSaved: () => void }) {
  const [opgg, setOpgg] = useState(app.opggUrl);
  const [tier, setTier] = useState<string | null>(splitRank(app.rank).tier);
  const [division, setDivision] = useState<string | null>(splitRank(app.rank).division);
  const [main, setMain] = useState<string | null>(app.mainLane);
  const [second, setSecond] = useState<string | null>(app.secondLane);
  const [x, setX] = useState(app.xAccount ?? '');
  const [streams, setStreams] = useState<string[]>(app.streamUrls.length ? app.streamUrls : ['']);
  const needsDivision = Boolean(tier && !APEX_TIERS.includes(tier));
  const hasError = Boolean(opggUrlError(opgg) || xAccountError(x) || streams.some((u) => streamUrlError(u)) || (needsDivision && !division));
  const save = async () => {
    try {
      const r = await api<{ changed: string[] }>('PUT', `/api/admin/applications/${app.id}`, {
        opggUrl: opgg, rank: joinRank(tier, division), mainLane: main, secondLane: second, xAccount: x || null, streamUrls: streams.map((u) => u.trim()).filter(Boolean),
      });
      done(r.changed.length ? '応募内容を修正しました。本人の応募状況にも修正したことが表示されます' : '変更はありませんでした');
      onSaved();
    } catch (e) { fail(e); }
  };
  const lanes = APPLY_LANES.map((l) => ({ value: l, label: l }));
  return (
    <Modal opened onClose={onClose} title={`${app.name} の応募内容を修正`} size="lg">
      <Stack>
        <Text size="sm" c="var(--muted)">書き間違いの修正などに使います。区分と宣材写真は本人だけが変えられます。修正したことは本人の応募状況に表示され、操作ログにも残ります。</Text>
        <TextInput label="OP.GG" value={opgg} onChange={(e) => setOpgg(e.currentTarget.value)} error={opggUrlError(opgg)} />
        <SimpleGrid cols={2}>
          <Select label="ランク" value={tier} clearable={app.kind !== 'player'} data={[...DIVISION_TIERS, ...APEX_TIERS]} onChange={(v) => { setTier(v); if (!v || APEX_TIERS.includes(v)) setDivision(null); }} />
          {needsDivision && <Select label="区分" value={division} data={DIVISIONS} allowDeselect={false} error={!division ? '区分を選んでください' : null} onChange={setDivision} />}
        </SimpleGrid>
        <SimpleGrid cols={2}>
          <Select label="得意レーン" value={main} data={lanes} clearable={app.kind !== 'player'} onChange={(v) => { setMain(v); if (v === second) setSecond(null); }} />
          <Select label="セカンド" value={second} clearable data={lanes.map((l) => ({ ...l, disabled: l.value === main }))} onChange={setSecond} />
        </SimpleGrid>
        <TextInput label="X アカウント" value={x} onChange={(e) => setX(e.currentTarget.value)} placeholder="@" error={xAccountError(x)} />
        <Stack gap={6}>
          <Text size="sm" fw={500}>配信 URL（3 件まで）</Text>
          {streams.map((u, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
              <TextInput aria-label={`配信 URL ${i + 1}`} value={u} style={{ flex: 1 }} error={streamUrlError(u)} onChange={(e) => { const v = e.currentTarget.value; setStreams((l) => l.map((s, j) => (j === i ? v : s))); }} />
              {streams.length > 1 && <Button variant="subtle" color="red" onClick={() => setStreams((l) => l.filter((_, j) => j !== i))}>削除</Button>}
            </Group>
          ))}
          {streams.length < 3 && <Button variant="subtle" size="compact-sm" w="fit-content" onClick={() => setStreams((l) => [...l, ''])}>配信 URL を追加</Button>}
        </Stack>
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={save} disabled={hasError}>修正を保存</Button></Group>
      </Stack>
    </Modal>
  );
}

function AssignDialog({ appId, admins, current, onClose, onSaved }: { appId: string; admins: { id: string; name: string }[]; current: string[]; onClose: () => void; onSaved: () => void }) {
  const [ids, setIds] = useState<string[]>(current);
  const save = async () => { try { await api('PUT', `/api/admin/applications/${appId}/reviewers`, { reviewerIds: ids }); done('審査担当を変更しました'); onSaved(); } catch (e) { fail(e); } };
  return (
    <Modal opened onClose={onClose} title="審査担当を変更">
      <MultiSelect label="審査担当（2 人まで）" value={ids} onChange={setIds} maxValues={2} data={admins.map((a) => ({ value: a.id, label: a.name }))} />
      <Text size="xs" c="var(--muted)" mt="xs">審査を送信済みの担当は外せません。</Text>
      <Group justify="flex-end" mt="md"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={save}>保存</Button></Group>
    </Modal>
  );
}

// ---------------- 仮決定表 ----------------
interface Entry { application_id: string; member_type: string; draft_role: string | null; team_id: string | null; name: string; rank: string | null; main_lane: string | null; second_lane: string | null }
interface Table_ { teamCount: number; roleCounts: Record<string, number>; entries: Entry[]; candidates: number; lastUpdate: { at: string; by: string } | null; announcedAt: string | null }

function ProvisionalView() {
  const [t, setT] = useState<Table_ | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => api<Table_>('GET', '/api/admin/provisional').then(setT).catch(fail), []);
  useEffect(() => { void load(); api<{ teams: Team[] }>('GET', '/api/admin/teams').then((r) => setTeams(r.teams)).catch(() => {}); }, [load]);
  if (!t) return <Loader />;
  const setEntry = async (e: Entry, patch: Partial<{ draftRole: string | null; teamId: string | null }>) => {
    try { await api('PUT', `/api/admin/applications/${e.application_id}/provisional`, { memberType: e.member_type, draftRole: e.draft_role, teamId: e.team_id, ...patch }); void load(); } catch (err) { fail(err); }
  };
  const remove = async (e: Entry) => { try { await api('DELETE', `/api/admin/applications/${e.application_id}/provisional`); void load(); } catch (err) { fail(err); } };
  const cancel = async (e: Entry) => { try { await api('POST', `/api/admin/applications/${e.application_id}/cancel-acceptance`); done('採用を取り消しました'); void load(); } catch (err) { fail(err); } };
  const announce = async () => {
    try { const r = await api<{ accepted: number; rejected: number }>('POST', '/api/admin/selection/announce'); done(`発表しました（採用 ${r.accepted} 人・不採用 ${r.rejected} 人）`); setConfirm(false); void load(); } catch (e) { fail(e); }
  };
  const players = t.entries.filter((e) => e.member_type === 'player');
  const others = t.entries.filter((e) => e.member_type !== 'player');
  return (
    <Stack gap="md">
      {t.announcedAt && <Card className="admin-only"><Text size="sm">{showDateTime(t.announcedAt)} に発表済みです。ここに並んでいるのが採用した人です。採用の取り消しはドラフト開始前までできます。</Text></Card>}
      <Card withBorder padding="lg">
        <Group justify="space-between" mb="xs"><Title order={2} size="h5">ロール別の人数（参加チーム数 {t.teamCount} ＝ 各ロール {t.teamCount} 人）</Title>
          {t.lastUpdate && <Text size="xs" c="var(--muted)">最終更新 {t.lastUpdate.by}・{showDateTime(t.lastUpdate.at)}</Text>}</Group>
        <Group gap="xs">{LANES.map((l) => {
          const n = t.roleCounts[l] ?? 0;
          return <Badge key={l} size="lg" variant="light" color={n === t.teamCount ? 'green' : n > t.teamCount ? 'red' : 'orange'}>{l} {n} / {t.teamCount}</Badge>;
        })}</Group>
      </Card>
      <Card withBorder padding="lg">
        <Title order={2} size="h5" mb="sm">仮決定：選手（{players.length} 人）</Title>
        <Table.ScrollContainer minWidth={600}>
          <Table verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>名前</Table.Th><Table.Th>ランク</Table.Th><Table.Th>得意 / セカンド</Table.Th><Table.Th>ドラフト用ロール</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>{players.map((e) => {
              const over = e.draft_role && (t.roleCounts[e.draft_role] ?? 0) > t.teamCount;
              return (
                <Table.Tr key={e.application_id}>
                  <Table.Td fw={700}>{e.name}</Table.Td><Table.Td>{e.rank ?? '—'}</Table.Td><Table.Td>{e.main_lane ?? '—'} / {e.second_lane ?? '—'}</Table.Td>
                  <Table.Td><Select aria-label={`${e.name}のドラフト用ロール`} w={110} value={e.draft_role} data={LANES} allowDeselect={false} disabled={Boolean(t.announcedAt)} onChange={(v) => setEntry(e, { draftRole: v })} />
                    {over && <Text size="xs" c="red.8" fw={700}>{e.draft_role} が {t.teamCount} 人を超えています</Text>}</Table.Td>
                  <Table.Td>{t.announcedAt ? <Button size="xs" variant="subtle" color="red" onClick={() => cancel(e)}>採用を取り消す</Button> : <Button size="xs" variant="default" onClick={() => remove(e)}>外す</Button>}</Table.Td>
                </Table.Tr>);
            })}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Card withBorder padding="lg">
        <Title order={2} size="h5" mb="sm">仮決定：コーチ・補助スタッフ（{others.length} 人）</Title>
        <Stack gap="xs">{others.map((e) => (
          <Group key={e.application_id} gap="sm">
            <Text fw={700}>{e.name}</Text><Badge variant="light" color="gray">{MEMBER_TYPE[e.member_type]}</Badge>
            {e.member_type === 'coach' && <Select aria-label={`${e.name}のチーム枠`} w={160} placeholder="チーム枠" clearable value={e.team_id} disabled={Boolean(t.announcedAt)}
              data={teams.map((tm) => ({ value: tm.id, label: teamLabel(teams, tm.id) }))} onChange={(v) => setEntry(e, { teamId: v })} />}
            {t.announcedAt ? <Button size="xs" variant="subtle" color="red" onClick={() => cancel(e)}>採用を取り消す</Button> : <Button size="xs" variant="default" onClick={() => remove(e)}>外す</Button>}
          </Group>))}</Stack>
      </Card>
      {!t.announcedAt && (
        <Card withBorder padding="lg" style={{ borderColor: '#2148b8', borderWidth: 2 }}>
          <Group justify="space-between">
            <div><Title order={2} size="h5">最終決定して発表</Title><Text size="sm" c="var(--muted)">仮決定表の人を採用、入っていない {t.candidates} 人を不採用として、全員同時に確定します。</Text></div>
            <Button onClick={() => setConfirm(true)}>最終決定して発表</Button>
          </Group>
        </Card>
      )}
      <Modal opened={confirm} onClose={() => setConfirm(false)} title="最終決定して発表しますか？">
        <Stack>
          <Text>採用 {t.entries.length} 人、不採用 {t.candidates} 人で確定します。</Text>
          <Text size="sm" c="red.8">不採用の人の応募内容・審査・宣材写真はすぐに削除され、元に戻せません。</Text>
          <Group justify="flex-end"><Button variant="default" onClick={() => setConfirm(false)}>やめる</Button><Button color="red" onClick={announce}>発表する</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

// ---------------- 募集設定 ----------------
function SettingsView() {
  const [f, setF] = useState<{ body: string; kinds: string[]; opens: string; closes: string; checks: string[]; fixed: string[] } | null>(null);
  useEffect(() => {
    api<{ recruitment: null | { body: string; kinds: string[]; opensAt: string; closesAt: string; checks: { label: string; fixed: number }[] } }>('GET', '/api/admin/recruitment')
      .then(({ recruitment: r }) => setF(r ? { body: r.body, kinds: r.kinds, opens: toInputDateTime(r.opensAt), closes: toInputDateTime(r.closesAt),
        checks: r.checks.filter((c) => !c.fixed).map((c) => c.label), fixed: r.checks.filter((c) => c.fixed).map((c) => c.label) }
        : { body: '', kinds: ['player'], opens: '', closes: '', checks: [], fixed: ['ルールブックを読み、内容に同意します', '参加者一覧への掲載に同意します'] }))
      .catch(fail);
  }, []);
  if (!f) return <Loader />;
  const save = async () => {
    try { await api('PUT', '/api/admin/recruitment', { body: f.body, kinds: f.kinds, opensAt: fromInputDateTime(f.opens), closesAt: fromInputDateTime(f.closes), checks: f.checks.filter(Boolean) }); done('募集の設定を保存しました'); } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg" maw={760}>
      <Stack>
        <Textarea label="募集要項" value={f.body} onChange={(e) => setF({ ...f, body: e.currentTarget.value })} autosize minRows={6} maxLength={10000} />
        <Checkbox.Group label="募集する区分" value={f.kinds} onChange={(v) => setF({ ...f, kinds: v })}>
          <Group mt="xs">{Object.entries(MEMBER_TYPE).map(([v, l]) => <Checkbox key={v} value={v} label={l} />)}</Group>
        </Checkbox.Group>
        <SimpleGrid cols={2}>
          <TextInput type="datetime-local" label="受付開始" value={f.opens} onChange={(e) => setF({ ...f, opens: e.currentTarget.value })} />
          <TextInput type="datetime-local" label="締切" value={f.closes} onChange={(e) => setF({ ...f, closes: e.currentTarget.value })} />
        </SimpleGrid>
        <Stack gap={6}>
          <Text size="sm" fw={500}>確認事項</Text>
          {f.fixed.map((l) => <Text key={l} size="sm" c="var(--muted)">・{l}（必ず入ります）</Text>)}
          {f.checks.map((c, i) => (
            <Group key={i} gap="xs" wrap="nowrap">
              <TextInput aria-label={`確認事項 ${i + 1}`} value={c} style={{ flex: 1 }} maxLength={120} onChange={(e) => { const v = e.currentTarget.value; setF({ ...f, checks: f.checks.map((x, j) => (j === i ? v : x)) }); }} />
              <Button variant="subtle" color="red" onClick={() => setF({ ...f, checks: f.checks.filter((_, j) => j !== i) })}>削除</Button>
            </Group>
          ))}
          <Button variant="subtle" size="compact-sm" w="fit-content" onClick={() => setF({ ...f, checks: [...f.checks, ''] })}>確認事項を追加</Button>
          <Text size="xs" c="var(--muted)">受付中に変えた場合も、応募済みの人が同意した文言は記録として残ります。</Text>
        </Stack>
        <Button onClick={save} w="fit-content" disabled={!f.body || !f.kinds.length || !f.opens || !f.closes}>保存する</Button>
      </Stack>
    </Card>
  );
}
