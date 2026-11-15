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
        <Group gap={6} mt={6}>
          <Button size="compact-xs" variant="default" color="orange" onClick={async () => { const r = await api<{ teams: number; players: number }>('POST', '/api/dev/seed-draft'); alert(`ドラフト用の見本データを用意しました（${r.teams} チーム・選手 ${r.players} 人）。コーチ（チーム1・2）と全体管理者で試せます`); }}>ドラフト用の見本データを作る</Button>
          <Button size="compact-xs" variant="default" color="orange" onClick={async () => { await api('POST', '/api/dev/seed-scrim'); alert('スクリム用の見本データを用意しました（今日から 2 週間がスクリム期間、チーム 1・2 に選手 5 人ずつ、1 週間分の予定）。コーチ（チーム1・2）で試せます'); }}>スクリム用の見本データを作る</Button>
        </Group>
      </Container>
    </Box>
  );
}
