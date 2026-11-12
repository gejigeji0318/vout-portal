import { Anchor, Avatar, Box, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { BodyText } from '../components/BodyText';

interface Staff { name: string; bio: string | null; iconUrl: string | null; streamUrls: string[]; xAccount: string | null }
interface OfficialLink { kind: 'x' | 'stream' | 'other'; label: string; url: string }
interface AboutRes { page: { body: string } | null; staff: Staff[]; officialLinks: OfficialLink[] }

export const streamLabel = (url: string) => {
  const h = new URL(url).hostname;
  return h.includes('twitch') ? 'Twitch' : h.includes('youtu') ? 'YouTube' : h.includes('twitcasting') ? 'ツイキャス' : '配信';
};
const chip = { display: 'inline-flex', alignItems: 'center', minHeight: 36, padding: '0 14px', border: '1px solid #c3cad5', borderRadius: 999, color: '#1a1d23', textDecoration: 'none', fontSize: 14 };

/** SC-02 はじめに：趣旨 → 公式リンク → 運営メンバー */
export function AboutPage() {
  const [d, setD] = useState<AboutRes | null>(null);
  useEffect(() => { api<AboutRes>('GET', '/api/pages/about').then(setD).catch(() => setD({ page: null, staff: [], officialLinks: [] })); }, []);
  if (!d) return <Loader />;
  return (
    <Stack gap={48} maw={880}>
      <Box style={{ background: '#1a1d23', color: '#fff', borderRadius: 16, padding: '48px 40px' }}>
        <Title order={1} fz={40} mb={12}>はじめに</Title>
        <Box w={56} h={4} mb="lg" style={{ background: '#5b80e6', borderRadius: 2 }} />
        {d.page ? <BodyText c="#e3e6eb" fz={17}>{d.page.body}</BodyText> : <Text c="#d5d9e0">準備中です。</Text>}
        <Anchor component={Link} to="/overview" c="#fff" fw={700} mt="lg" display="inline-block">大会概要と大会の流れを見る</Anchor>
      </Box>

      {d.officialLinks.length > 0 && (
        <Stack gap="md">
          <Title order={2} fz={26}>公式リンク</Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {d.officialLinks.map((l) => (
              <Anchor key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" underline="never"
                style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '20px 24px', background: '#fff', border: '1px solid #dde1e7', borderRadius: 16, color: '#1a1d23' }}>
                <Box w={48} h={48} style={{ borderRadius: 12, background: l.kind === 'x' ? '#1a1d23' : '#2148b8', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: 'none' }} aria-hidden>
                  {l.kind === 'x' ? 'X' : '▶'}
                </Box>
                <Box style={{ flex: 1 }}><Text fw={700} fz={17}>{l.label}</Text><Text size="sm" c="var(--muted)">{new URL(l.url).hostname}</Text></Box>
              </Anchor>
            ))}
          </SimpleGrid>
        </Stack>
      )}

      <Stack gap={0}>
        <Title order={2} fz={26} mb="sm">運営メンバー</Title>
        {d.staff.length === 0 && <Text c="var(--muted)">準備中です。</Text>}
        {d.staff.map((s, i) => (
          <Group key={i} align="flex-start" gap={24} py={24} wrap="nowrap" style={{ borderTop: '1px solid #e3e6eb' }}>
            <Avatar src={s.iconUrl} alt="" size={96} radius={96} style={{ boxShadow: '0 0 0 4px #fff, 0 0 0 6px #dde3f3', flex: 'none' }}>{s.name.slice(0, 1)}</Avatar>
            <Stack gap={8} style={{ minWidth: 0 }}>
              <Text fw={700} fz={20}>{s.name}</Text>
              {s.bio && <BodyText c="#3d4350">{s.bio}</BodyText>}
              {(s.streamUrls.length > 0 || s.xAccount) && (
                <Group gap={8}>
                  {s.streamUrls.map((u) => <a key={u} href={u} target="_blank" rel="noopener noreferrer" style={chip}>{streamLabel(u)}</a>)}
                  {s.xAccount && <a href={`https://x.com/${s.xAccount}`} target="_blank" rel="noopener noreferrer" style={chip}>X</a>}
                </Group>
              )}
            </Stack>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}
