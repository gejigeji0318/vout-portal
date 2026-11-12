import { Card, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { BodyText } from '../components/BodyText';
import { showDate } from '../labels';

export function PrivacyPage() {
  const [d, setD] = useState<{ page: { body: string; updatedAt: string } | null } | null>(null);
  useEffect(() => { api<{ page: { body: string; updatedAt: string } | null }>('GET', '/api/pages/privacy').then(setD).catch(() => setD({ page: null })); }, []);
  if (!d) return <Loader />;
  return (
    <Stack gap="lg" maw={880}>
      <Title order={1}>プライバシーポリシー</Title>
      {d.page ? (
        <><Text size="sm" c="var(--muted)">最終更新：{showDate(d.page.updatedAt)}</Text><Card withBorder padding="xl"><BodyText>{d.page.body}</BodyText></Card></>
      ) : <Text>準備中です。</Text>}
    </Stack>
  );
}
