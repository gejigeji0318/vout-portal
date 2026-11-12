import { Card, Group, Loader, Select, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { BodyText } from '../components/BodyText';
import { showDate } from '../labels';

/** SC-02 ルールブック（F-16）：版の履歴を選んで見られる */
export function RulesPage() {
  const [versions, setVersions] = useState<{ version: number; updatedAt: string }[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<{ version: number; body: string; updatedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ versions: { version: number; updatedAt: string }[] }>('GET', '/api/pages/rules/versions')
      .then((r) => { setVersions(r.versions); setSelected(r.versions[0] ? String(r.versions[0].version) : null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : '表示できませんでした'));
  }, []);
  useEffect(() => {
    if (!selected) return;
    api<{ version: number; body: string; updatedAt: string }>('GET', `/api/pages/rules/versions/${selected}`).then(setPage).catch(() => setPage(null));
  }, [selected]);
  if (error) return <Stack><Title order={1}>ルールブック</Title><Text>{error}</Text></Stack>;
  if (!versions) return <Loader />;
  if (!versions.length) return <Stack><Title order={1}>ルールブック</Title><Text>準備中です。</Text></Stack>;
  const latest = versions[0]!.version;
  return (
    <Stack gap="lg" maw={880}>
      <Group justify="space-between" align="flex-end">
        <Title order={1}>ルールブック</Title>
        <Select aria-label="表示する版" value={selected} onChange={setSelected} allowDeselect={false} w={240}
          data={versions.map((v) => ({ value: String(v.version), label: `第 ${v.version} 版（${showDate(v.updatedAt)}）${v.version === latest ? '・最新' : ''}` }))} />
      </Group>
      {page && Number(selected) !== latest && <Text c="orange.9" fw={700} size="sm">古い版を表示しています。最新は第 {latest} 版です。</Text>}
      <Card withBorder padding="xl">{page ? <BodyText>{page.body}</BodyText> : <Loader />}</Card>
    </Stack>
  );
}
