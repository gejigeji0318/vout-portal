import { Anchor, Avatar, Badge, Card, Group, Loader, SimpleGrid, Stack, Tabs, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../api';
import { MEMBER_TYPE } from '../labels';
import { streamLabel } from './AboutPage';

interface Person { name: string; memberType: string; lane: string | null; rank: string | null; photoUrl: string | null; xAccount: string | null; streamUrls: string[] }
const chip = { display: 'inline-flex', alignItems: 'center', minHeight: 28, padding: '0 10px', border: '1px solid #c3cad5', borderRadius: 999, color: '#1a1d23', textDecoration: 'none', fontSize: 13 };

function PersonRow({ p }: { p: Person }) {
  return (
    <Group gap="sm" wrap="nowrap" py={6}>
      <Avatar src={p.photoUrl} alt="" size={48} radius="md">{p.name.slice(0, 1)}</Avatar>
      <div style={{ minWidth: 0 }}>
        <Group gap={6}><Text fw={700}>{p.name}</Text>
          <Badge variant="light" color={p.memberType === 'coach' ? 'gray' : 'blue'}>{p.memberType === 'coach' ? 'コーチ' : p.lane ?? MEMBER_TYPE[p.memberType]}</Badge>
          {p.rank && <Text size="xs" c="var(--muted)">{p.rank}</Text>}</Group>
        {(p.xAccount || p.streamUrls.length > 0) && (
          <Group gap={6} mt={4}>
            {p.streamUrls.map((u) => <a key={u} href={u} target="_blank" rel="noopener noreferrer" style={chip}>{streamLabel(u)}</a>)}
            {p.xAccount && <a href={`https://x.com/${p.xAccount}`} target="_blank" rel="noopener noreferrer" style={chip}>X</a>}
          </Group>
        )}
      </div>
    </Group>
  );
}

/** SC-14 大会参加者一覧 ／ SC-04 チーム紹介 */
export function ParticipantsPage() {
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<{ published: boolean; groups: { title: string; people: Person[] }[] } | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string; coaches: Person[]; players: Person[] }[] | null>(null);
  useEffect(() => {
    api<NonNullable<typeof list>>('GET', '/api/roster/participants').then(setList).catch(() => setList({ published: false, groups: [] }));
    api<{ teams: NonNullable<typeof teams> }>('GET', '/api/roster/teams').then((r) => setTeams(r.teams)).catch(() => setTeams([]));
  }, []);
  return (
    <Stack gap="lg" maw={1000}>
      <Title order={1}>参加者</Title>
      <Tabs value={params.get('tab') ?? 'list'} onChange={(v) => setParams(v ? { tab: v } : {})}>
        <Tabs.List mb="lg"><Tabs.Tab value="list">大会参加者一覧</Tabs.Tab><Tabs.Tab value="teams">チーム紹介</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="list">
          {!list ? <Loader /> : !list.published ? <Text c="var(--muted)">選考結果の発表後に公開します。</Text> : (
            <Stack gap="lg">{list.groups.map((g) => (
              <Card key={g.title} withBorder padding="lg"><Title order={2} size="h4" mb="xs">{g.title}</Title>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={0}>{g.people.map((p, i) => <PersonRow key={i} p={p} />)}</SimpleGrid></Card>
            ))}</Stack>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="teams">
          {!teams ? <Loader /> : teams.length === 0 ? <Text c="var(--muted)">チーム紹介はまだ公開されていません。</Text> : (
            <SimpleGrid cols={{ base: 1, md: 2 }}>{teams.map((t) => (
              <Card key={t.id} withBorder padding="lg">
                <Title order={2} size="h3" mb="xs">{t.name}</Title>
                {t.coaches.map((p, i) => <PersonRow key={`c${i}`} p={p} />)}
                {t.players.map((p, i) => <PersonRow key={`p${i}`} p={p} />)}
              </Card>
            ))}</SimpleGrid>
          )}
        </Tabs.Panel>
      </Tabs>
      <Text size="xs" c="var(--muted)">宣材写真・X・配信は、本人が公開を選んだ場合だけ表示します。<Anchor href="/me" size="xs">自分の公開設定</Anchor></Text>
    </Stack>
  );
}
