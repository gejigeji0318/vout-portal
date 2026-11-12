import { Anchor, Badge, Box, Button, Card, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { CATEGORY, PHASE, showDateTime } from '../labels';
import { useSession } from '../session';

interface Home {
  tournament: { name: string; phase: string } | null;
  events: { kind: string; title: string; starts_at: string; ends_at: string }[];
  news: { id: string; title: string; category: string; important: boolean; publishedAt: string }[];
  todos: { kind: string; title: string; link: string }[];
  admin?: { openInquiries: number };
}

/** SC-01 TOP：ログイン前は大会の案内、ログイン後は「自分に関係する予定」と「やること」 */
export function TopPage() {
  const { me } = useSession();
  const [h, setH] = useState<Home | null>(null);
  useEffect(() => { api<Home>('GET', '/api/home').then(setH).catch(() => setH({ tournament: null, events: [], news: [], todos: [] })); }, [me?.loggedIn]);
  if (!h || !me) return <Loader />;
  const name = h.tournament?.name ?? 'Vout 大会ポータル';
  return (
    <Stack gap="xl">
      <Box style={{ background: '#1a1d23', color: '#fff', borderRadius: 16, padding: '36px 32px' }}>
        {h.tournament && <Badge color="gray" variant="light" mb="sm">{PHASE[h.tournament.phase]}</Badge>}
        <Title order={1} fz={34}>{name}</Title>
        {h.tournament?.phase === 'recruiting' && !me.user?.isAdmin && <Button component={Link} to="/entry" mt="md" mr="sm">応募する・応募状況</Button>}
        {me.loggedIn
          ? <Text c="#d5d9e0" mt="xs">ようこそ、{me.user?.displayName} さん。</Text>
          : <Group mt="md" gap="sm"><Button component="a" href="/auth/login">Discord でログイン</Button><Button component={Link} to="/about" variant="white" color="dark">はじめに</Button></Group>}
      </Box>

      {h.admin && h.admin.openInquiries > 0 && (
        <Box className="admin-only"><Group gap="md"><Text className="admin-only__label">管理者のみ表示</Text>
          <Anchor component={Link} to="/admin?tab=inquiries">未対応の問い合わせ {h.admin.openInquiries} 件</Anchor></Group></Box>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
        <Stack gap="xl">
          {me.loggedIn && (
            <Card withBorder padding="lg">
              <Title order={2} size="h4" mb="sm">やること</Title>
              {h.todos.length === 0 ? <Text c="var(--muted)">今やることはありません。</Text> : (
                <Stack gap="xs">{h.todos.map((t) => (
                  <Group key={t.link} justify="space-between" p="sm" style={{ border: '1px solid #f2c9a0', background: '#fff8f0', borderRadius: 10 }}>
                    <Text size="sm">{t.title}</Text><Anchor component={Link} to={t.link} size="sm">開く</Anchor>
                  </Group>))}</Stack>
              )}
            </Card>
          )}
          <Card withBorder padding="lg">
            <Title order={2} size="h4" mb="sm">{me.loggedIn ? '次の予定' : 'スケジュール'}</Title>
            {h.events.length === 0 ? <Text c="var(--muted)">予定はまだありません。</Text> : (
              <Stack gap="xs">{h.events.map((e) => (
                <Group key={e.title + e.starts_at} justify="space-between" p="sm" style={{ border: '1px solid #ebedf1', borderRadius: 10 }}>
                  <Text size="sm"><Text span fw={700}>{showDateTime(e.starts_at)}</Text>　{e.title}</Text>
                  <Badge variant="light" color={e.kind === 'main' ? 'gray' : 'blue'}>{e.kind === 'main' ? '本番' : '配信'}</Badge>
                </Group>))}</Stack>
            )}
          </Card>
        </Stack>
        <Card withBorder padding="lg">
          <Group justify="space-between" mb="sm"><Title order={2} size="h4">お知らせ</Title><Anchor component={Link} to="/news" size="sm">すべて見る</Anchor></Group>
          {h.news.length === 0 ? <Text c="var(--muted)">お知らせはまだありません。</Text> : (
            <Stack gap={0}>{h.news.map((n) => (
              <Anchor key={n.id} component={Link} to={`/news/${n.id}`} underline="never" c="inherit" py="sm" style={{ borderTop: '1px solid #ebedf1' }}>
                <Group gap={6} mb={2}><Text size="xs" c="var(--muted)">{showDateTime(n.publishedAt)}</Text><Badge size="xs" variant="light" color="gray">{CATEGORY[n.category]}</Badge>
                  {n.important && <Badge size="xs" color="red" variant="light">重要</Badge>}</Group>
                <Text fw={500}>{n.title}</Text>
              </Anchor>))}</Stack>
          )}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
