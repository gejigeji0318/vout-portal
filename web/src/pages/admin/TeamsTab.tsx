import { Button, Card, Group, Loader, SimpleGrid, Switch, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { done, fail, type Team } from './shared';

export function TeamsTab() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const load = useCallback(() => api<{ teams: Team[] }>('GET', '/api/admin/teams').then((r) => setTeams(r.teams)).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  if (!teams) return <Loader />;
  if (teams.length === 0) return <Text c="var(--muted)">チーム枠はまだありません。大会設定で大会を作ると、参加チーム数の分だけできます。</Text>;
  return (
    <>
      <Text size="sm" c="var(--muted)" mb="md">チーム名は本来コーチが決めます。ここでは誤りの修正だけを行ってください。チームの数は大会設定で変えられます。</Text>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {teams.map((t, i) => <TeamCard key={t.id} team={t} index={i} onSaved={load} />)}
      </SimpleGrid>
    </>
  );
}

function TeamCard({ team, index, onSaved }: { team: Team; index: number; onSaved: () => void }) {
  const [name, setName] = useState(team.name ?? '');
  const save = async () => {
    try { await api('PATCH', `/api/admin/teams/${team.id}`, { name: name || null }); done('チーム名を変更しました'); onSaved(); } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb="xs">{team.name ?? `チーム ${index + 1}`}</Title>
      <Text size="sm" c={team.coaches === 0 ? 'red.8' : 'var(--muted)'} mb="md">
        コーチ {team.coaches} 人・選手 {team.players} 人{team.coaches === 0 ? '（コーチ未割当）' : ''}
      </Text>
      <Group align="flex-end" gap="xs">
        <TextInput label="チーム名" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={30} style={{ flex: 1 }} />
        <Button variant="default" onClick={save}>変更</Button>
      </Group>
      <Group justify="space-between" mt="sm">
        <Switch label="チーム紹介を公開" checked={Boolean(team.intro_published_at)} onChange={async (e) => {
          const published = e.currentTarget.checked;
          try { await api('PUT', `/api/admin/teams/${team.id}/intro`, { published }); done(published ? 'チーム紹介を公開しました' : 'チーム紹介を非公開にしました'); onSaved(); } catch (err) { fail(err); }
        }} />
        <Button component="a" href={`/team?teamId=${team.id}`} variant="subtle" size="compact-sm">チームページを見る</Button>
      </Group>
    </Card>
  );
}
