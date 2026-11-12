import { Anchor, Badge, Button, Card, Chip, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { BodyText } from '../components/BodyText';
import { CATEGORY, showDateTime } from '../labels';
import { useSession } from '../session';

interface Item { id: string; title: string; category: string; important: boolean; publishedAt: string; confirmed: boolean | null }

/** SC-03 お知らせ一覧（カテゴリーで絞り込み） */
export function NewsListPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [cat, setCat] = useState('all');
  useEffect(() => {
    setItems(null);
    api<{ announcements: Item[] }>('GET', `/api/announcements${cat === 'all' ? '' : `?category=${cat}`}`).then((r) => setItems(r.announcements)).catch(() => setItems([]));
  }, [cat]);
  return (
    <Stack gap="lg" maw={880}>
      <Title order={1}>お知らせ</Title>
      <Chip.Group value={cat} onChange={(v) => setCat(v as string)}>
        <Group gap="xs">
          <Chip value="all">すべて</Chip>
          {Object.entries(CATEGORY).map(([k, v]) => <Chip key={k} value={k}>{v}</Chip>)}
        </Group>
      </Chip.Group>
      {!items ? <Loader /> : items.length === 0 ? <Text c="var(--muted)">お知らせはまだありません。</Text> : (
        <Stack gap="xs">
          {items.map((a) => (
            <Card key={a.id} withBorder padding="md" component={Link} to={`/news/${a.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Group gap="xs" mb={4}>
                <Text size="sm" c="var(--muted)">{showDateTime(a.publishedAt)}</Text>
                <Badge variant="light" color="gray">{CATEGORY[a.category]}</Badge>
                {a.important && <Badge color="red" variant="light">重要</Badge>}
                {a.important && a.confirmed === false && <Badge color="orange" variant="light">未確認</Badge>}
              </Group>
              <Text fw={700}>{a.title}</Text>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function NewsDetailPage() {
  const { id } = useParams();
  const { me } = useSession();
  const [a, setA] = useState<(Item & { body: string }) | null | undefined>(undefined);
  const load = () => api<{ announcement: Item & { body: string } }>('GET', `/api/announcements/${id}`).then((r) => setA(r.announcement)).catch(() => setA(null));
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (a === undefined) return <Loader />;
  if (a === null) return <Stack><Title order={1}>お知らせが見つかりません</Title><Text>削除されたか、見る権限がありません。{!me?.loggedIn && 'ログインすると見られる場合があります。'}</Text></Stack>;
  const confirm = async () => { await api('POST', `/api/announcements/${a.id}/confirm`); void load(); };
  return (
    <Stack gap="md" maw={880}>
      <Anchor component={Link} to="/news" size="sm">お知らせ一覧に戻る</Anchor>
      <Group gap="xs">
        <Text size="sm" c="var(--muted)">{showDateTime(a.publishedAt)}</Text>
        <Badge variant="light" color="gray">{CATEGORY[a.category]}</Badge>
        {a.important && <Badge color="red" variant="light">重要</Badge>}
      </Group>
      <Title order={1} fz={28}>{a.title}</Title>
      <Card withBorder padding="xl"><BodyText>{a.body}</BodyText></Card>
      {a.important && (a.confirmed ? <Text c="green.8" fw={700}>確認済みです。</Text> : <Button onClick={confirm} w="fit-content">確認しました</Button>)}
    </Stack>
  );
}
