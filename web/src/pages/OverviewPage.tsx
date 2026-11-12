import { Box, Card, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { BodyText } from '../components/BodyText';
import { showDate, showDateTime } from '../labels';

interface Overview {
  page: { body: string } | null;
  tournament: null | { name: string; phase: string; periodStart: string; periodEnd: string; teamCount: number; scrimStart: string | null; scrimEnd: string | null;
    events: { kind: string; title: string; starts_at: string; ends_at: string }[] };
}

const STEPS = [
  { key: 'recruiting', name: '募集', note: 'Discord でログインして応募' },
  { key: 'selecting', name: '選考', note: '運営が採用を決定' },
  { key: 'drafting', name: 'ドラフト', note: '配信でチームを決定' },
  { key: 'scrim', name: 'スクリム期間', note: 'チームで練習試合' },
  { key: 'main', name: '本戦', note: '配信あり' },
];

/** SC-02 大会概要（F-19）：日程・チーム数は大会設定から自動で表示する */
export function OverviewPage() {
  const [d, setD] = useState<Overview | null>(null);
  useEffect(() => { api<Overview>('GET', '/api/pages/overview').then(setD).catch(() => setD({ page: null, tournament: null })); }, []);
  if (!d) return <Loader />;
  const t = d.tournament;
  if (!t) return <Stack><Title order={1}>大会概要</Title><Text>次の大会の情報は準備中です。</Text></Stack>;
  const current = STEPS.findIndex((s) => s.key === t.phase);
  const rows: [string, string][] = [
    ['大会名', t.name],
    ['開催期間', `${showDate(t.periodStart)}〜${showDate(t.periodEnd)}`],
    ['形式', `ドラフト制・${t.teamCount} チーム（1 チーム 選手 5 人＋コーチ）`],
    ...(t.scrimStart ? [['スクリム期間', `${showDate(t.scrimStart)}〜${showDate(t.scrimEnd)}`] as [string, string]] : []),
    ...t.events.map((e) => [e.kind === 'main' ? e.title : `${e.title}（配信）`, showDateTime(e.starts_at)] as [string, string]),
  ];
  return (
    <Stack gap="xl" maw={960}>
      <Title order={1}>大会概要</Title>
      <Card withBorder padding="lg">
        <Table verticalSpacing="sm"><Table.Tbody>
          {rows.map(([k, v]) => <Table.Tr key={k}><Table.Th w={160} c="var(--muted)" fw={500}>{k}</Table.Th><Table.Td>{v}</Table.Td></Table.Tr>)}
        </Table.Tbody></Table>
        {d.page && <Box mt="md"><BodyText>{d.page.body}</BodyText></Box>}
      </Card>
      <Stack gap="sm">
        <Title order={2} size="h3">大会の流れ</Title>
        <Box component="ol" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: 0, margin: 0, listStyle: 'none' }}>
          {STEPS.map((s, i) => {
            const now = i === current;
            return (
              <li key={s.key} aria-current={now ? 'step' : undefined} style={{ flex: '1 1 160px', padding: 16, borderRadius: 12, border: '1px solid #dde1e7',
                background: now ? '#2148b8' : i < current ? '#eef0f3' : '#fff', color: now ? '#fff' : '#1a1d23' }}>
                <Text size="xs" style={{ opacity: 0.85 }}>{now ? '今ここ' : i < current ? '終了' : ''}&nbsp;</Text>
                <Text fw={700} fz={18}>{s.name}</Text>
                <Text size="sm" style={{ opacity: 0.85 }}>{s.note}</Text>
              </li>
            );
          })}
        </Box>
      </Stack>
    </Stack>
  );
}
