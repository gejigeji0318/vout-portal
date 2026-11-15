import { Badge, Box, Button, Card, Checkbox, Chip, Collapse, Group, Loader, SegmentedControl, Select, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { LANES, showDateTime } from '../labels';
import { useSession } from '../session';

type Status = 'o' | 't' | 'x';
interface Entry { status: Status; start: string | null; end: string | null; changedAfterDeadline?: boolean }
interface Slot { id: string; date: string; stdStart: string; stdEnd: string }
interface Overlap { count: number; window: [string, string] | null; countWithT: number; windowWithT: [string, string] | null; players: number; triangles: [string, string][] }
interface Member { userId: string; name: string; memberType: string; lane: string | null; entries: Record<string, Entry> }
interface Data {
  deadline: string | null; slots: Slot[]; mine: Record<string, Entry>; myTeamId: string | null; isAdmin: boolean;
  teams: { id: string; name: string; isMine: boolean; perSlot: Record<string, Overlap>; members?: Member[] }[];
  staff: { userId: string; name: string; entries: Record<string, Entry> }[]; unassigned?: Member[];
  scrims: { id: string; date: string; start: string; end: string; teams: string[]; teamIds: string[] }[];
}

const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
/** 曜日（日本時間の正午は UTC でも同じ日付なので、その曜日を使う） */
export const dayOf = (date: string) => new Date(`${date}T12:00:00+09:00`).getUTCDay();
export const label = (date: string) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}（${WEEK[dayOf(date)]}）`; };
const SYMBOL: Record<Status, string> = { o: '○', t: '△', x: '×' };
/** 同時にそろう選手の人数の色（5 人＝緑、4 人＝オレンジ、3 人以下＝薄い色）。色だけに頼らず人数も出す */
const countStyle = (n: number) => ({ background: n >= 5 ? '#2e9e5b' : n === 4 ? '#f0a33a' : n >= 1 ? '#f6e3c4' : 'transparent', color: n >= 4 ? '#fff' : '#1a1d23' });
const fail = (e: unknown) => notifications.show({ color: 'red', title: '保存できませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });

/** SC-10 予定表（F-05） */
export function SchedulePage() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Data>('GET', '/api/schedule').then(setD).catch((e) => setError(e instanceof ApiError ? e.message : '表示できませんでした')), []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <Stack><Title order={1}>予定表</Title><Text>{error}</Text></Stack>;
  if (!d) return <Loader />;
  if (!d.slots.length) return <Stack><Title order={1}>予定表</Title><Text>スクリムの日程はまだ用意されていません。運営が日程を用意すると、ここで入力できます。</Text></Stack>;
  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end">
        <Title order={1}>予定表</Title>
        {d.deadline && <Text size="sm" c={new Date(d.deadline) < new Date() ? 'red.8' : 'var(--muted)'}>入力締切：{showDateTime(d.deadline)}{new Date(d.deadline) < new Date() ? '（締切後の変更には印が付きます）' : ''}</Text>}
      </Group>
      <MyInput d={d} onSaved={load} />
      <TeamGrid d={d} />
      {d.staff.some((s) => Object.keys(s.entries).length) && <PeopleTable title="運営（人員補充の候補探しに）" people={d.staff.map((s) => ({ ...s, memberType: 'staff', lane: null }))} slots={d.slots} />}
      {d.unassigned && d.unassigned.length > 0 && (
        <Box className="admin-only"><Text className="admin-only__label" mb="xs">管理者のみ表示：所属チームが決まる前の選手</Text>
          <PeopleTable title="" people={d.unassigned} slots={d.slots} /></Box>
      )}
    </Stack>
  );
}

function MyInput({ d, onSaved }: { d: Data; onSaved: () => void }) {
  const { me } = useSession();
  const presets = me?.user?.timePresets ?? [];
  const [draft, setDraft] = useState<Record<string, Entry>>(() => ({ ...d.mine }));
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<Entry>({ status: 'o', start: null, end: null });
  const [busy, setBusy] = useState(false);
  const filled = d.slots.filter((sl) => d.mine[sl.id]).length;
  const complete = filled === d.slots.length;
  // 全部の日を入力済みなら、最初は閉じておく（未入力があれば開く）
  const [open, setOpen] = useState(!complete);
  const set = (slot: Slot, patch: Partial<Entry>) => setDraft((x) => {
    const cur = x[slot.id] ?? { status: 'x', start: null, end: null };
    let next = { ...cur, ...patch } as Entry;
    // ○ を選んだら標準の時間帯を自動で入れる。× は時間を消す
    if (patch.status === 'o' && !cur.start) next = { ...next, start: slot.stdStart, end: slot.stdEnd };
    if (patch.status === 'x') next = { ...next, start: null, end: null };
    return { ...x, [slot.id]: next };
  });
  const dirty = d.slots.filter((s) => JSON.stringify(draft[s.id] ?? null) !== JSON.stringify(d.mine[s.id] ?? null) && draft[s.id]);
  const invalid = dirty.filter((s) => draft[s.id]!.status !== 'x' && (!draft[s.id]!.start || !draft[s.id]!.end || draft[s.id]!.start! >= draft[s.id]!.end!));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ late: boolean }>('PUT', '/api/schedule/mine', { entries: dirty.map((s) => ({ slotId: s.id, ...draft[s.id] })) });
      notifications.show({ color: 'green', message: r.late ? '保存しました（締切後の変更として、コーチに印が表示されます）' : '保存しました' });
      // 保存して全部の日が埋まったら閉じる
      if (d.slots.every((sl) => draft[sl.id])) setOpen(false);
      onSaved();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const applyBulk = () => {
    for (const id of selected) { const slot = d.slots.find((s) => s.id === id)!; set(slot, { status: bulk.status }); if (bulk.status !== 'x' && bulk.start) setDraft((x) => ({ ...x, [id]: { ...x[id]!, start: bulk.start, end: bulk.end } })); }
    setSelected([]);
  };
  const byWeekday = (w: number) => setSelected(d.slots.filter((s) => dayOf(s.date) === w).map((s) => s.id));
  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm">
          <Title order={2} size="h4">自分の予定を入力</Title>
          {complete ? <Badge color="green" variant="light">入力済み {filled}/{d.slots.length} 日</Badge>
            : <Badge color="orange" variant="light">未入力 {d.slots.length - filled} 日</Badge>}
        </Group>
        <Button variant="subtle" size="compact-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="my-schedule-input">{open ? '閉じる' : '開く'}</Button>
      </Group>
      <Collapse expanded={open} id="my-schedule-input">
      <Text size="sm" c="var(--muted)" mt="xs" mb="md">○ 参加できる／△ 一部なら参加できる／× 参加できない。○ を選ぶと標準の時間が入るので、違うときだけ直してください。</Text>
      <Group gap="xs" mb="sm" wrap="wrap">
        <Text size="sm" fw={500}>まとめて入力：</Text>
        {[1, 2, 3, 4, 5, 6, 0].map((w) => <Button key={w} size="compact-xs" variant="default" onClick={() => byWeekday(w)}>{WEEK[w]}曜を選ぶ</Button>)}
        <SegmentedControl size="xs" value={bulk.status} onChange={(v) => setBulk({ ...bulk, status: v as Status })} data={[{ value: 'o', label: '○' }, { value: 't', label: '△' }, { value: 'x', label: '×' }]} />
        {bulk.status !== 'x' && <><Select size="xs" w={90} aria-label="まとめて入力の開始" data={TIMES.slice(0, -1)} value={bulk.start} onChange={(v) => setBulk({ ...bulk, start: v })} placeholder="開始" />
          <Select size="xs" w={90} aria-label="まとめて入力の終了" data={TIMES.slice(1)} value={bulk.end} onChange={(v) => setBulk({ ...bulk, end: v })} placeholder="終了" /></>}
        <Button size="compact-sm" disabled={!selected.length} onClick={applyBulk}>選んだ {selected.length} 日に入れる</Button>
      </Group>
      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing={6}>
          <Table.Tbody>
            {d.slots.map((s) => {
              const e = draft[s.id];
              const scrim = d.scrims.find((x) => x.date === s.date && d.myTeamId && x.teamIds.includes(d.myTeamId));
              return (
                <Table.Tr key={s.id}>
                  <Table.Td w={32}><Checkbox aria-label={`${label(s.date)}を選ぶ`} checked={selected.includes(s.id)} onChange={(ev) => { const on = ev.currentTarget.checked; setSelected((x) => (on ? [...x, s.id] : x.filter((y) => y !== s.id))); }} /></Table.Td>
                  <Table.Td w={110} fw={500}>{label(s.date)}</Table.Td>
                  <Table.Td w={150}><SegmentedControl size="xs" value={e?.status ?? ''} onChange={(v) => set(s, { status: v as Status })} data={[{ value: 'o', label: '○' }, { value: 't', label: '△' }, { value: 'x', label: '×' }]} aria-label={`${label(s.date)}の参加`} /></Table.Td>
                  <Table.Td>
                    {e && e.status !== 'x' && (
                      <Group gap={4} wrap="nowrap">
                        <Select size="xs" w={86} aria-label={`${label(s.date)}の開始`} data={TIMES.slice(0, -1)} value={e.start} onChange={(v) => set(s, { start: v })} allowDeselect={false} />
                        <Text size="xs">〜</Text>
                        <Select size="xs" w={86} aria-label={`${label(s.date)}の終了`} data={TIMES.slice(1)} value={e.end} onChange={(v) => set(s, { end: v })} allowDeselect={false} />
                        {presets.map((p) => <Button key={p.label} size="compact-xs" variant="subtle" onClick={() => set(s, { start: p.start, end: p.end })}>{p.label}</Button>)}
                      </Group>
                    )}
                  </Table.Td>
                  <Table.Td>{scrim && <Badge variant="light">スクリム {scrim.start}〜</Badge>}{e?.changedAfterDeadline && <Badge color="orange" variant="light" ml={4}>締切後に変更</Badge>}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Group mt="sm">
        <Button onClick={save} loading={busy} disabled={!dirty.length || invalid.length > 0}>{dirty.length ? `${dirty.length} 日分を保存` : '保存する'}</Button>
        {invalid.length > 0 && <Text size="sm" c="red.8">○・△ の日は、終わりの時間を始まりより後にしてください</Text>}
        {presets.length === 0 && <Text size="xs" c="var(--muted)">よく使う時間はマイページで登録できます</Text>}
      </Group>
      </Collapse>
    </Card>
  );
}

function CountCell({ o }: { o?: Overlap }) {
  if (!o || (!o.count && !o.countWithT)) return <Text size="xs" c="var(--muted)">—</Text>;
  return (
    <Box px={6} py={4} style={{ borderRadius: 6, ...countStyle(o.count) }}>
      <Text size="sm" fw={700}>{o.count} 人</Text>
      {o.window && <Text size="xs">{o.window[0]}〜{o.window[1]}</Text>}
      {o.countWithT > o.count && <Text size="xs">△を含め {o.countWithT} 人</Text>}
    </Box>
  );
}

function TeamGrid({ d }: { d: Data }) {
  const mine = d.teams.find((t) => t.isMine);
  const [team, setTeam] = useState<string>(mine?.id ?? d.teams[0]?.id ?? '');
  const shown = d.teams.find((t) => t.id === team);
  return (
    <Stack gap="lg">
      <Card withBorder padding="lg">
        <Title order={2} size="h4" mb={4}>チームごとの空き状況</Title>
        <Text size="sm" c="var(--muted)" mb="md">同じ時間に参加できる選手の人数です（コーチは数えません）。5 人＝緑、4 人＝オレンジ。</Text>
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing={4} withColumnBorders>
            <Table.Thead><Table.Tr><Table.Th>日程</Table.Th>{d.teams.map((t) => <Table.Th key={t.id}>{t.name}{t.isMine ? '（自チーム）' : ''}</Table.Th>)}</Table.Tr></Table.Thead>
            <Table.Tbody>{d.slots.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td fw={500}>{label(s.date)}</Table.Td>
                {d.teams.map((t) => {
                  const sc = d.scrims.find((x) => x.date === s.date && x.teamIds.includes(t.id));
                  return <Table.Td key={t.id}><CountCell o={t.perSlot[s.id]} />{sc && <Text size="xs" c="blue.8" mt={2}>スクリム {sc.start}〜{sc.end}</Text>}
                    {t.perSlot[s.id]?.triangles.length ? <Text size="xs" c="var(--muted)">△ {t.perSlot[s.id]!.triangles.map((x) => `${x[0]}〜${x[1]}`).join('、')}</Text> : null}</Table.Td>;
                })}
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      {d.teams.some((t) => t.members) && (
        <Card withBorder padding="lg">
          <Group justify="space-between" mb="sm">
            <Title order={2} size="h4">メンバーごとの入力</Title>
            {d.isAdmin && <Chip.Group value={team} onChange={(v) => setTeam(v as string)}><Group gap={4}>{d.teams.map((t) => <Chip key={t.id} value={t.id} size="xs">{t.name}</Chip>)}</Group></Chip.Group>}
          </Group>
          {shown?.members ? <PeopleTable title="" people={shown.members} slots={d.slots} perSlot={shown.perSlot} /> : <Text c="var(--muted)">自チームの分だけ表示されます。</Text>}
        </Card>
      )}
    </Stack>
  );
}

function PeopleTable({ title, people, slots, perSlot }: { title: string; people: Member[]; slots: Slot[]; perSlot?: Record<string, Overlap> }) {
  const sorted = useMemo(() => [...people].sort((a, b) => (a.memberType === 'coach' ? 1 : 0) - (b.memberType === 'coach' ? 1 : 0) || LANES.indexOf(a.lane ?? '') - LANES.indexOf(b.lane ?? '')), [people]);
  return (
    <Stack gap="xs">
      {title && <Title order={2} size="h4">{title}</Title>}
      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing={4} withColumnBorders>
          <Table.Thead><Table.Tr><Table.Th>日程</Table.Th>{sorted.map((p) => <Table.Th key={p.userId}>{p.name}<Text size="xs" c="var(--muted)">{p.memberType === 'coach' ? 'コーチ' : p.lane ?? ''}</Text></Table.Th>)}{perSlot && <Table.Th>そろう人数</Table.Th>}</Table.Tr></Table.Thead>
          <Table.Tbody>{slots.map((s) => {
            const all = perSlot?.[s.id];
            const full = all && all.players > 0 && all.count >= Math.min(5, all.players);
            return (
              <Table.Tr key={s.id} style={full ? { background: '#e6f4ec' } : undefined}>
                <Table.Td fw={500}>{label(s.date)}</Table.Td>
                {sorted.map((p) => {
                  const e = p.entries[s.id];
                  const coach = p.memberType === 'coach';
                  const bg = !e ? undefined : coach || p.memberType === 'staff' ? (e.status === 'o' ? '#e6f4ec' : e.status === 't' ? '#fff6d6' : undefined) : undefined;
                  return <Table.Td key={p.userId} bg={bg}>
                    {e ? <Text size="sm">{SYMBOL[e.status]} {e.start ? `${e.start}〜${e.end}` : ''}{e.changedAfterDeadline ? <Badge size="xs" color="orange" variant="light" ml={4}>変更</Badge> : null}</Text> : <Text size="xs" c="var(--muted)">未入力</Text>}
                  </Table.Td>;
                })}
                {perSlot && <Table.Td><CountCell o={all} /></Table.Td>}
              </Table.Tr>
            );
          })}</Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
