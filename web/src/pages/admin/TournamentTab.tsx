import { Button, Card, Group, Loader, Modal, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { fromInputDate, fromInputDateTime, PHASE, showDateTime, toInputDate, toInputDateTime } from '../../labels';
import { done, fail, type Tournament } from './shared';

const EDITABLE_PHASES = ['preparing', 'recruiting', 'selecting', 'drafting', 'scrim', 'main'];

export function TournamentTab() {
  const [t, setT] = useState<Tournament | null | undefined>(undefined);
  const load = useCallback(() => api<{ tournament: Tournament | null }>('GET', '/api/admin/tournament').then((r) => setT(r.tournament)).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  if (t === undefined) return <Loader />;
  if (t === null) return <CreateTournament onCreated={load} />;
  return (
    <Stack gap="xl">
      <EditTournament key={t.id + t.team_count + t.phase} t={t} onSaved={load} />
      <EventsCard />
    </Stack>
  );
}

function CreateTournament({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [teams, setTeams] = useState<number | string>(3);
  const create = async () => {
    try {
      await api('POST', '/api/admin/tournament', { name, periodStart: fromInputDate(start), periodEnd: fromInputDate(end), teamCount: Number(teams) });
      done('大会を作りました');
      onCreated();
    } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg" maw={720}>
      <Title order={2} size="h4" mb={4}>大会を作る</Title>
      <Text size="sm" c="var(--muted)" mb="md">開催中の大会はまだありません。作ると、参加チーム数の分だけチーム枠ができます。</Text>
      <Stack>
        <TextInput label="大会名" value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={60} />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput type="date" label="大会期間（開始）" value={start} onChange={(e) => setStart(e.currentTarget.value)} required />
          <TextInput type="date" label="大会期間（終了）" value={end} onChange={(e) => setEnd(e.currentTarget.value)} required />
          <NumberInput label="参加チーム数" value={teams} onChange={setTeams} min={2} max={16} required />
        </SimpleGrid>
        <Button onClick={create} w="fit-content">大会を作る</Button>
      </Stack>
    </Card>
  );
}

function EditTournament({ t, onSaved }: { t: Tournament; onSaved: () => void }) {
  const [f, setF] = useState({
    name: t.name, periodStart: toInputDate(t.period_start), periodEnd: toInputDate(t.period_end), teamCount: t.team_count as number | string,
    scrimStart: toInputDate(t.scrim_start), scrimEnd: toInputDate(t.scrim_end), deadline: toInputDateTime(t.schedule_deadline), phase: t.phase,
  });
  const set = (k: keyof typeof f) => (v: string | number) => setF((s) => ({ ...s, [k]: v }));
  const draftStarted = ['drafting', 'scrim', 'main'].includes(t.phase);
  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        name: f.name, periodStart: fromInputDate(f.periodStart), periodEnd: fromInputDate(f.periodEnd),
        scrimStart: fromInputDate(f.scrimStart), scrimEnd: fromInputDate(f.scrimEnd), scheduleDeadline: fromInputDateTime(f.deadline), phase: f.phase,
      };
      if (Number(f.teamCount) !== t.team_count) body.teamCount = Number(f.teamCount);
      await api('PATCH', `/api/admin/tournament/${t.id}`, body);
      done('大会設定を保存しました');
      onSaved();
    } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb="md">基本設定</Title>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="大会名" value={f.name} onChange={(e) => set('name')(e.currentTarget.value)} maxLength={60} />
          <Select label="今の段階" data={EDITABLE_PHASES.map((p) => ({ value: p, label: PHASE[p]! }))} value={f.phase} onChange={(v) => v && set('phase')(v)} allowDeselect={false}
            description="大会終了はシステム設定の二人承認で行います" />
          <TextInput type="date" label="大会期間（開始）" value={f.periodStart} onChange={(e) => set('periodStart')(e.currentTarget.value)} />
          <TextInput type="date" label="大会期間（終了）" value={f.periodEnd} onChange={(e) => set('periodEnd')(e.currentTarget.value)} />
          <NumberInput label="参加チーム数" value={f.teamCount} onChange={set('teamCount')} min={2} max={16} disabled={draftStarted}
            description={draftStarted ? 'ドラフト開始後は変更できません' : '応募状況を見て、ドラフト開始まで変更できます'} />
          <TextInput type="datetime-local" label="予定表の入力締切" value={f.deadline} onChange={(e) => set('deadline')(e.currentTarget.value)} />
          <TextInput type="date" label="スクリム期間（開始）" value={f.scrimStart} onChange={(e) => set('scrimStart')(e.currentTarget.value)} description="この日以降はチーム名を変更できません" />
          <TextInput type="date" label="スクリム期間（終了）" value={f.scrimEnd} onChange={(e) => set('scrimEnd')(e.currentTarget.value)} />
        </SimpleGrid>
        <Button onClick={save} w="fit-content">保存する</Button>
      </Stack>
    </Card>
  );
}

interface EventRow { id: string; kind: 'main' | 'stream'; title: string; starts_at: string; ends_at: string; url: string | null }
const emptyEvent = { kind: 'stream' as 'main' | 'stream', title: '', start: '', end: '', url: '' };

function EventsCard() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [opened, { open, close }] = useDisclosure(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState(emptyEvent);
  const load = useCallback(() => api<{ events: EventRow[] }>('GET', '/api/admin/events').then((r) => setEvents(r.events)).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  const startNew = (kind: 'main' | 'stream') => { setEditing(null); setF({ ...emptyEvent, kind }); open(); };
  const startEdit = (e: EventRow) => {
    setEditing(e.id);
    setF({ kind: e.kind, title: e.title, start: toInputDateTime(e.starts_at), end: toInputDateTime(e.ends_at), url: e.url ?? '' });
    open();
  };
  const save = async () => {
    const body = { kind: f.kind, title: f.title, startsAt: fromInputDateTime(f.start), endsAt: fromInputDateTime(f.end), url: f.url || null };
    try {
      await (editing ? api('PUT', `/api/admin/events/${editing}`, body) : api('POST', '/api/admin/events', body));
      done(editing ? '日程を変更しました' : '日程を追加しました');
      close();
      void load();
    } catch (e) { fail(e); }
  };
  const remove = async (id: string) => {
    try { await api('DELETE', `/api/admin/events/${id}`); done('日程を削除しました'); void load(); } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md">
        <Title order={2} size="h4">本番日程・配信日程</Title>
        <Group gap="xs">
          <Button variant="default" onClick={() => startNew('main')}>本番日程を追加</Button>
          <Button variant="default" onClick={() => startNew('stream')}>配信日程を追加</Button>
        </Group>
      </Group>
      {events.length === 0 ? (
        <Text c="var(--muted)">まだ登録していません。配信日程は TOP ページのスケジュールに表示されます。</Text>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="sm">
            <Table.Thead><Table.Tr><Table.Th>種類</Table.Th><Table.Th>タイトル</Table.Th><Table.Th>日時</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {events.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{e.kind === 'main' ? '本番' : '配信'}</Table.Td>
                  <Table.Td>{e.title}</Table.Td>
                  <Table.Td>{showDateTime(e.starts_at)}〜{showDateTime(e.ends_at).split(' ')[1]}</Table.Td>
                  <Table.Td><Group gap="xs" justify="flex-end">
                    <Button size="xs" variant="default" onClick={() => startEdit(e)}>編集</Button>
                    <Button size="xs" variant="subtle" color="red" onClick={() => remove(e.id)}>削除</Button>
                  </Group></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={opened} onClose={close} title={`${f.kind === 'main' ? '本番日程' : '配信日程'}を${editing ? '編集' : '追加'}`}>
        <Stack>
          <TextInput label="タイトル" placeholder={f.kind === 'main' ? '本戦 Day1' : 'ドラフト配信'} value={f.title} onChange={(e) => setF({ ...f, title: e.currentTarget.value })} maxLength={40} />
          <TextInput type="datetime-local" label="開始" value={f.start} onChange={(e) => setF({ ...f, start: e.currentTarget.value })} />
          <TextInput type="datetime-local" label="終了" value={f.end} onChange={(e) => setF({ ...f, end: e.currentTarget.value })} />
          <TextInput type="url" label="配信 URL（任意）" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.currentTarget.value })} />
          <Group justify="flex-end"><Button variant="default" onClick={close}>やめる</Button><Button onClick={save}>{editing ? '変更を保存' : '追加する'}</Button></Group>
        </Stack>
      </Modal>
    </Card>
  );
}
