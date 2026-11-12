import { Anchor, Box, Button, Container, Group, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '../api';
import { useSession } from '../session';

interface Item { id: string; title: string }

/** 未確認の重要なお知らせ。確認するまで、ログイン後の画面上部に出し続ける（F-15） */
export function ImportantBanner() {
  const { me } = useSession();
  const [items, setItems] = useState<Item[]>([]);
  const location = useLocation();
  const load = useCallback(() => {
    if (!me?.loggedIn) { setItems([]); return; }
    api<{ announcements: Item[] }>('GET', '/api/announcements/unconfirmed').then((r) => setItems(r.announcements)).catch(() => {});
  }, [me?.loggedIn]);
  useEffect(() => { load(); }, [load, location.pathname]);
  if (!items.length) return null;
  const confirm = async (id: string) => { await api('POST', `/api/announcements/${id}/confirm`).catch(() => {}); load(); };
  return (
    <Box role="region" aria-label="未確認の重要なお知らせ" style={{ background: '#fdf1ef', borderBottom: '1px solid #e9a79e' }}>
      <Container size="lg" py={10}>
        {items.map((a) => (
          <Group key={a.id} justify="space-between" gap="sm" py={4} wrap="wrap">
            <Text size="sm"><Text span fw={700} c="#8e2318">重要：</Text>{a.title}</Text>
            <Group gap="xs">
              <Anchor component={Link} to={`/news/${a.id}`} size="sm">読む</Anchor>
              <Button size="xs" onClick={() => confirm(a.id)}>確認しました</Button>
            </Group>
          </Group>
        ))}
      </Container>
    </Box>
  );
}
