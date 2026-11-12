import { Stack, Tabs, Title } from '@mantine/core';
import { useSearchParams } from 'react-router';
import { TournamentTab } from './TournamentTab';
import { TeamsTab } from './TeamsTab';
import { UsersTab } from './UsersTab';
import { InquiriesTab } from './InquiriesTab';

/** SC-18 大会・メンバー管理（応募・選考のタブは段階 3 で追加） */
export function MembersPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'tournament';
  return (
    <Stack gap="lg">
      <Title order={1}>大会・メンバー管理</Title>
      <Tabs value={tab} onChange={(v) => setParams(v ? { tab: v } : {})} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="tournament">大会設定</Tabs.Tab>
          <Tabs.Tab value="teams">チーム</Tabs.Tab>
          <Tabs.Tab value="users">ユーザー</Tabs.Tab>
          <Tabs.Tab value="inquiries">問い合わせ対応</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="tournament"><TournamentTab /></Tabs.Panel>
        <Tabs.Panel value="teams"><TeamsTab /></Tabs.Panel>
        <Tabs.Panel value="users"><UsersTab /></Tabs.Panel>
        <Tabs.Panel value="inquiries"><InquiriesTab /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
