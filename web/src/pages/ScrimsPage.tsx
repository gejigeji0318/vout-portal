import { Badge, Button, Card, Checkbox, Group, Loader, Modal, Select, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';
import { showDateTime } from '../labels';
import { label } from './SchedulePage';
import { OpenFillDialog } from './FillPage';

interface Team { id: string; name: string }
interface Cand { id: string; startsAt: string; endsAt: string; proposedBy: string }
interface Scrim { id: string; format: string; status: string; startsAt: string | null; endsAt: string | null; cancelReason: string | null; requester: Team; opponent: Team; candidates: Cand[]; mine: boolean }
const STATUS: Record<string, { label: string; color: string }> = {
  requested: { label: '申請中', color: 'orange' }, negotiating: { label: '調整中', color: 'yellow' }, confirmed: { label: '確定', color: 'green' }, done: { label: '実施済み', color: 'gray' }, cancelled: { label: '中止', color: 'red' },
};
const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const fromJst = (date: string, time: string) => new Date(new Date(`${date}T00:00:00+09:00`).getTime() + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60000).toISOString();
const range = (s: string | null, e: string | null) => (s && e ? `${showDateTime(s)}〜${showDateTime(e).split(' ')[1]}` : '日時未定');
const fail = (e: unknown) => notifications.show({ color: 'red', title: 'できませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });
const done = (m: string) => notifications.show({ color: 'green', message: m });

/** SC-11 スクリム（F-06） */
export function ScrimsPage() {
  const [d, setD] = useState<{ myTeamId: string | null; canManage: boolean; scrims: Scrim[] } | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [slots, setSlots] = useState<{ id: string; date: string }[]>([]);
  const [dialog, setDialog] = useState<{ kind: 'request' } | { kind: 'propose' | 'cancel' | 'members' | 'fill'; scrim: Scrim } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<NonNullable<typeof d>>('GET', '/api/scrims').then(setD).catch((e) => setError(e instanceof ApiError ? e.message : '表示できませんでした')), []);
  useEffect(() => {
    void load();
    api<{ teams: Team[]; slots: { id: string; date: string }[] }>('GET', '/api/schedule').then((r) => { setTeams(r.teams); setSlots(r.slots); }).catch(() => {});
  }, [load]);
  if (error) return <Stack><Title order={1}>スクリム</Title><Text>{error}</Text></Stack>;
  if (!d) return <Loader />;
  const act = async (path: string, body: unknown, msg: string) => {
    try { const r = await api<{ warnings?: string[] }>('POST', path, body); done(msg); r.warnings?.forEach((w) => notifications.show({ color: 'orange', title: '注意', message: w })); void load(); } catch (e) { fail(e); }
  };
  const open = d.scrims.filter((s) => ['requested', 'negotiating'].includes(s.status));
  const confirmed = d.scrims.filter((s) => s.status === 'confirmed');
  const closed = d.scrims.filter((s) => ['done', 'cancelled'].includes(s.status));
  const card = (s: Scrim) => {
    const canAct = d.canManage && (s.mine || !d.myTeamId);
    const myTeam = d.myTeamId;
    return (
      <Card key={s.id} withBorder padding="md" style={s.mine ? { borderColor: '#2148b8' } : undefined}>
        <Group justify="space-between" mb={4}>
          <Group gap="xs"><Badge color={STATUS[s.status]!.color} variant="light">{STATUS[s.status]!.label}</Badge><Text fw={700}>{s.requester.name} vs {s.opponent.name}</Text><Text size="sm" c="var(--muted)">{s.format}</Text></Group>
          <Text size="sm">{range(s.startsAt, s.endsAt)}</Text>
        </Group>
        {s.cancelReason && <Text size="sm" c="var(--muted)">中止の理由：{s.cancelReason}</Text>}
        {s.candidates.length > 0 && (
          <Stack gap={4} mt="xs">
            {s.candidates.map((c) => (
              <Group key={c.id} gap="sm">
                <Text size="sm">候補：{range(c.startsAt, c.endsAt)}（{c.proposedBy === s.requester.id ? s.requester.name : s.opponent.name} が提案）</Text>
                {canAct && (c.proposedBy !== myTeam || !myTeam) && <Button size="compact-xs" onClick={() => act(`/api/scrims/${s.id}/confirm`, { candidateId: c.id }, 'スクリムを確定しました')}>この日時で確定</Button>}
              </Group>
            ))}
          </Stack>
        )}
        {canAct && (
          <Group gap="xs" mt="sm">
            {['requested', 'negotiating'].includes(s.status) && <Button size="compact-sm" variant="default" onClick={() => setDialog({ kind: 'propose', scrim: s })}>別案を返す</Button>}
            {s.status === 'confirmed' && <Button size="compact-sm" variant="default" onClick={() => setDialog({ kind: 'members', scrim: s })}>参加メンバー</Button>}
            {s.status === 'confirmed' && s.startsAt && new Date(s.startsAt) > new Date() && <Button size="compact-sm" variant="default" onClick={() => setDialog({ kind: 'fill', scrim: s })}>人員補充を募集</Button>}
            {s.status === 'confirmed' && s.startsAt && new Date(s.startsAt) < new Date() && <Button size="compact-sm" variant="default" onClick={() => act(`/api/scrims/${s.id}/done`, {}, '実施済みにしました')}>実施済みにする</Button>}
            {!['done', 'cancelled'].includes(s.status) && <Button size="compact-sm" variant="subtle" color="red" onClick={() => setDialog({ kind: 'cancel', scrim: s })}>中止</Button>}
          </Group>
        )}
      </Card>
    );
  };
  return (
    <Stack gap="lg">
      <Group justify="space-between"><Title order={1}>スクリム</Title>{d.canManage && <Button onClick={() => setDialog({ kind: 'request' })}>スクリムを申請</Button>}</Group>
      {!d.canManage && <Text size="sm" c="var(--muted)">確定したスクリムが表示されます。</Text>}
      {d.canManage && <Section title="調整中" items={open.map(card)} empty="調整中のスクリムはありません。" />}
      <Section title="確定" items={confirmed.map(card)} empty="確定したスクリムはありません。" />
      <Section title="実施済み・中止" items={closed.map(card)} empty="まだありません。" />
      {dialog?.kind === 'request' && <RequestDialog teams={teams} slots={slots} myTeamId={d.myTeamId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'propose' && <RequestDialog teams={teams} slots={slots} myTeamId={d.myTeamId} proposeFor={dialog.scrim} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'cancel' && <CancelDialog scrim={dialog.scrim} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />}
      {dialog?.kind === 'fill' && <OpenFillDialog scrimId={dialog.scrim.id} teamId={d.myTeamId ?? dialog.scrim.requester.id} onClose={() => setDialog(null)} onDone={() => setDialog(null)} />}
      {dialog?.kind === 'members' && <MembersDialog scrim={dialog.scrim} myTeamId={d.myTeamId} onClose={() => setDialog(null)} />}
    </Stack>
  );
}

const Section = ({ title, items, empty }: { title: string; items: ReactNode[]; empty: string }) => (
  <Stack gap="xs"><Title order={2} size="h4">{title}</Title>{items.length ? items : <Text size="sm" c="var(--muted)">{empty}</Text>}</Stack>
);

interface Suggestion { date: string; mine: number; opponent: number; window: [string, string]; startsAt: string; endsAt: string }

/** 申請（proposeFor があれば別案を返す） */
function RequestDialog({ teams, slots, myTeamId, proposeFor, onClose, onDone }: { teams: Team[]; slots: { id: string; date: string }[]; myTeamId: string | null; proposeFor?: Scrim; onClose: () => void; onDone: () => void }) {
  const [requester, setRequester] = useState<string | null>(myTeamId);
  const [opponent, setOpponent] = useState<string | null>(proposeFor ? (proposeFor.requester.id === myTeamId ? proposeFor.opponent.id : proposeFor.requester.id) : null);
  const [format, setFormat] = useState('BO3');
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [chosen, setChosen] = useState<{ startsAt: string; endsAt: string }[]>([]);
  const [manual, setManual] = useState<{ date: string | null; start: string | null; end: string | null }>({ date: null, start: '21:00', end: '23:00' });
  useEffect(() => {
    const base = requester ?? myTeamId;
    if (!opponent || !base) return;
    api<{ suggestions: Suggestion[] }>('GET', `/api/scrims/suggest/${opponent}${myTeamId ? '' : `?teamId=${base}`}`).then((r) => setSugs(r.suggestions)).catch(() => setSugs([]));
  }, [opponent, requester, myTeamId]);
  const toggle = (c: { startsAt: string; endsAt: string }) => setChosen((x) => (x.some((y) => y.startsAt === c.startsAt) ? x.filter((y) => y.startsAt !== c.startsAt) : [...x, c].slice(0, 5)));
  const submit = async () => {
    try {
      if (proposeFor) await api('POST', `/api/scrims/${proposeFor.id}/propose`, { candidates: chosen, asTeamId: requester });
      else await api('POST', '/api/scrims', { opponentTeamId: opponent, requesterTeamId: requester, format, candidates: chosen });
      done(proposeFor ? '別案を返しました' : 'スクリムを申請しました');
      onDone();
    } catch (e) { fail(e); }
  };
  const teamData = teams.map((t) => ({ value: t.id, label: t.name }));
  return (
    <Modal opened onClose={onClose} title={proposeFor ? '別案を返す' : 'スクリムを申請'} size="lg">
      <Stack>
        {!myTeamId && <Select label="申請するチーム（管理者）" data={teamData} value={requester} onChange={setRequester} />}
        {!proposeFor && <Group grow>
          <Select label="相手チーム" data={teamData.filter((t) => t.value !== (requester ?? myTeamId))} value={opponent} onChange={setOpponent} />
          <Select label="形式" data={['BO1', 'BO3', 'BO5']} value={format} onChange={(v) => v && setFormat(v)} allowDeselect={false} />
        </Group>}
        {opponent && (
          <Stack gap={4}>
            <Text size="sm" fw={500}>予定表から、両チームの選手がそろう日程（そろう人数の多い順）</Text>
            {sugs.length === 0 ? <Text size="sm" c="var(--muted)">両チームがそろう日程は見つかりませんでした。下から日時を指定してください。</Text> : sugs.map((s) => (
              <Checkbox key={s.date} checked={chosen.some((c) => c.startsAt === s.startsAt)} onChange={() => toggle(s)}
                label={`${label(s.date)} ${s.window[0]}〜${s.window[1]}（自チーム ${s.mine} 人・相手 ${s.opponent} 人）`} />
            ))}
          </Stack>
        )}
        <Group align="flex-end" gap="xs">
          <Select label="日時を指定して追加" w={150} data={slots.map((s) => ({ value: s.date, label: label(s.date) }))} value={manual.date} onChange={(v) => setManual({ ...manual, date: v })} />
          <Select w={90} aria-label="開始" data={TIMES.slice(0, -1)} value={manual.start} onChange={(v) => setManual({ ...manual, start: v })} />
          <Select w={90} aria-label="終了" data={TIMES.slice(1)} value={manual.end} onChange={(v) => setManual({ ...manual, end: v })} />
          <Button variant="default" disabled={!manual.date || !manual.start || !manual.end || manual.start >= manual.end}
            onClick={() => toggle({ startsAt: fromJst(manual.date!, manual.start!), endsAt: fromJst(manual.date!, manual.end!) })}>追加</Button>
        </Group>
        {chosen.length > 0 && <Text size="sm">選んだ候補：{chosen.map((c) => range(c.startsAt, c.endsAt)).join('、')}</Text>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={submit} disabled={!opponent || !chosen.length}>{proposeFor ? '別案を返す' : '申請する'}</Button></Group>
      </Stack>
    </Modal>
  );
}

function CancelDialog({ scrim, onClose, onDone }: { scrim: Scrim; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const submit = async () => { try { await api('POST', `/api/scrims/${scrim.id}/cancel`, { reason }); done('中止しました'); onDone(); } catch (e) { fail(e); } };
  return (
    <Modal opened onClose={onClose} title={`${scrim.requester.name} vs ${scrim.opponent.name} を中止`}>
      <Stack><Textarea label="中止の理由（相手チームと運営に伝わります）" value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={200} autosize minRows={2} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button color="red" disabled={!reason} onClick={submit}>中止する</Button></Group></Stack>
    </Modal>
  );
}

function MembersDialog({ scrim, myTeamId, onClose }: { scrim: Scrim; myTeamId: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ participants: { user_id: string; team_id: string; name: string; lane: string | null; via: string }[] } | null>(null);
  const [roster, setRoster] = useState<{ userId: string; name: string; lane: string | null }[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const team = myTeamId ?? scrim.requester.id;
  useEffect(() => {
    api<NonNullable<typeof data>>('GET', `/api/scrims/${scrim.id}`).then((r) => { setData(r); setIds(r.participants.filter((p) => p.team_id === team && p.via === 'team').map((p) => p.user_id)); });
    api<{ teams: { id: string; members?: { userId: string; name: string; lane: string | null; memberType: string }[] }[] }>('GET', '/api/schedule')
      .then((r) => setRoster((r.teams.find((t) => t.id === team)?.members ?? []).filter((m) => m.memberType === 'player')));
  }, [scrim.id, team]);
  const save = async () => { try { await api('PUT', `/api/scrims/${scrim.id}/participants`, { userIds: ids, teamId: team }); done('参加メンバーを保存しました'); onClose(); } catch (e) { fail(e); } };
  return (
    <Modal opened onClose={onClose} title="参加メンバー">
      {!data ? <Loader /> : (
        <Stack>
          <Table><Table.Tbody>{roster.map((m) => (
            <Table.Tr key={m.userId}><Table.Td><Checkbox label={`${m.name}（${m.lane ?? '—'}）`} checked={ids.includes(m.userId)} onChange={(e) => { const on = e.currentTarget.checked; setIds((x) => (on ? [...x, m.userId] : x.filter((y) => y !== m.userId))); }} /></Table.Td></Table.Tr>
          ))}</Table.Tbody></Table>
          <Text size="xs" c="var(--muted)">人数が足りないときは、「人員補充を募集」から募集できます。補充で決まった人は自動でここに入ります。</Text>
          <Group justify="flex-end"><Button variant="default" onClick={onClose}>閉じる</Button><Button onClick={save}>保存</Button></Group>
        </Stack>
      )}
    </Modal>
  );
}
