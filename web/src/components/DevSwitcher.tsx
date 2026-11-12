import { Box, Button, Container, Group, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api } from '../api';

/** 開発・テスト環境だけに出る「立場を切り替える」欄。本番ではサーバーが 404 を返すので表示されない */
export function DevSwitcher() {
  const [personas, setPersonas] = useState<{ key: string; label: string }[] | null>(null);
  useEffect(() => { api<{ personas: { key: string; label: string }[] }>('GET', '/api/dev/personas').then((r) => setPersonas(r.personas)).catch(() => setPersonas(null)); }, []);
  if (!personas) return null;
  const switchTo = async (key: string) => { await api('POST', '/api/dev/login-as', { persona: key }); window.location.href = '/'; };
  return (
    <Box style={{ borderTop: '2px dashed #c99a2e', background: '#fff8e6' }}>
      <Container size="lg" py="sm">
        <Text size="xs" fw={700} c="#6b4e00" mb={6}>開発用：立場を切り替える（PC・テスト環境だけに表示。テスト用アカウントでログインし直します）</Text>
        <Group gap={6}>{personas.map((p) => <Button key={p.key} size="compact-xs" variant="default" onClick={() => switchTo(p.key)}>{p.label}</Button>)}</Group>
      </Container>
    </Box>
  );
}
