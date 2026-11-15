import { Button, Card, Checkbox, Group, Loader, Select, Stack, Table, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { dayOf, label } from '../SchedulePage';
import { done, fail, type Tournament } from './shared';

const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const jstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

/** 予定表の日程の用意（F-05）：スクリム期間の日付から選んで、標準の時間帯と一緒に登録する */
export function ScheduleTab() {
  const [t, setT] = useState<Tournament | null | undefined>(undefined);
  const [slots, setSlots] = useState<{ id: string; date: string; stdStart: string; stdEnd: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [std, setStd] = useState({ s: '21:00', e: '24:00' });
  const load = useCallback(async () => {
    try {
      const r = await api<{ tournament: Tournament | null }>('GET', '/api/admin/tournament');
      setT(r.tournament);
      if (r.tournament) setSlots((await api<{ slots: typeof slots }>('GET', '/api/schedule')).slots);
    } catch (e) { fail(e); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (t === undefined) return <Loader />;
  if (!t?.scrim_start || !t.scrim_end) return <Text c="var(--muted)">先に「大会設定」でスクリム期間を設定してください。</Text>;
  const days: string[] = [];
  for (let d = jstDate(t.scrim_start); d <= jstDate(t.scrim_end); d = new Date(new Date(`${d}T12:00:00+09:00`).getTime() + 86400e3 + 9 * 3600e3).toISOString().slice(0, 10)) days.push(d);
  const add = async () => { try { await api('POST', '/api/admin/schedule/slots', { dates: picked, stdStart: std.s, stdEnd: std.e }); done(`${picked.length} 日分の日程を登録しました`); setPicked([]); void load(); } catch (e) { fail(e); } };
  const remove = async (id: string) => { try { await api('DELETE', `/api/admin/schedule/slots/${id}`); done('日程を削除しました（その日の入力も消えます）'); void load(); } catch (e) { fail(e); } };
  return (
    <Stack gap="lg" maw={900}>
      <Card withBorder padding="lg">
        <Text fw={700} mb={4}>日程を登録</Text>
        <Text size="sm" c="var(--muted)" mb="sm">スクリム期間（{label(days[0]!)}〜{label(days[days.length - 1]!)}）の中から、スクリムの候補にする日を選びます。登録済みの日を選ぶと、標準の時間帯を上書きします。</Text>
        <Group gap="xs" mb="xs">{[1, 2, 3, 4, 5, 6, 0].map((w) => <Button key={w} size="compact-xs" variant="default" onClick={() => setPicked(days.filter((d) => dayOf(d) === w))}>{['日', '月', '火', '水', '木', '金', '土'][w]}曜</Button>)}
          <Button size="compact-xs" variant="default" onClick={() => setPicked(days)}>すべて</Button><Button size="compact-xs" variant="subtle" onClick={() => setPicked([])}>選択を外す</Button></Group>
        <Group gap={6} mb="md">{days.map((d) => <Checkbox key={d} label={label(d)} checked={picked.includes(d)} onChange={(e) => { const on = e.currentTarget.checked; setPicked((x) => (on ? [...x, d] : x.filter((y) => y !== d))); }} />)}</Group>
        <Group align="flex-end" gap="xs">
          <Select label="標準の時間帯（開始）" w={150} data={TIMES.slice(0, -1)} value={std.s} onChange={(v) => v && setStd({ ...std, s: v })} />
          <Select label="（終了）" w={110} data={TIMES.slice(1)} value={std.e} onChange={(v) => v && setStd({ ...std, e: v })} />
          <Button onClick={add} disabled={!picked.length || std.s >= std.e}>選んだ {picked.length} 日を登録</Button>
        </Group>
      </Card>
      <Card withBorder padding="lg">
        <Text fw={700} mb="sm">登録済みの日程（{slots.length} 日）</Text>
        {slots.length === 0 ? <Text c="var(--muted)">まだありません。</Text> : (
          <Table verticalSpacing={4}><Table.Tbody>{slots.map((s) => (
            <Table.Tr key={s.id}><Table.Td>{label(s.date)}</Table.Td><Table.Td>{s.stdStart}〜{s.stdEnd}</Table.Td><Table.Td align="right"><Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(s.id)}>削除</Button></Table.Td></Table.Tr>
          ))}</Table.Tbody></Table>
        )}
      </Card>
    </Stack>
  );
}
