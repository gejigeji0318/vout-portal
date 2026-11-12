import { Anchor, Button, Card, Group, Loader, SegmentedControl, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { showDateTime } from '../../labels';
import { done, fail } from './shared';

interface Status { lastSync: { at: string; ok: boolean; message: string } | null; dataUpdatedAt: string | null; count: number; visibility: string }

/** 適性レーン（F-09）：取り込みの状態、今すぐ更新、公開範囲（全体管理者のみ） */
export function LanesTab({ adminLevel }: { adminLevel: 'sub' | 'super' }) {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Status>('GET', '/api/admin/lanes/status').then(setS).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  if (!s) return <Loader />;
  const sync = async () => {
    setBusy(true);
    try { const r = await api<{ ok: boolean; message: string }>('POST', '/api/admin/lanes/sync'); r.ok ? done(r.message) : fail(new Error(r.message)); void load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const setVis = async (v: string) => { try { await api('PUT', '/api/admin/lanes/visibility', { visibility: v }); done('公開範囲を変更しました'); void load(); } catch (e) { fail(e); } };
  return (
    <Stack gap="md" maw={760}>
      <Card withBorder padding="lg">
        <Stack gap={6}>
          <Text>データの更新：<b>{s.dataUpdatedAt ? showDateTime(s.dataUpdatedAt) : 'まだ取り込んでいません'}</b>（{s.count} 体）</Text>
          {s.lastSync && <Text size="sm" c={s.lastSync.ok ? 'var(--muted)' : 'red.8'}>最後の取り込み：{showDateTime(s.lastSync.at)}　{s.lastSync.message}</Text>}
          <Text size="sm" c="var(--muted)">毎日 7:00 に自動で取り込みます。失敗したときは前日のデータを表示したまま、Discord で知らせます。</Text>
          <Group mt="sm"><Button onClick={sync} loading={busy}>今すぐ更新</Button><Anchor href="/tools/lanes/" target="_blank" rel="noopener">適性レーンを開く</Anchor></Group>
        </Stack>
      </Card>
      <Card withBorder padding="lg">
        <Text fw={500} mb={6}>公開範囲</Text>
        <SegmentedControl value={s.visibility} onChange={setVis} disabled={adminLevel !== 'super'}
          data={[{ value: 'public', label: '誰でも（ログインなしでも）' }, { value: 'logged_in', label: 'ログインした人だけ' }]} />
        {adminLevel !== 'super' && <Text size="sm" c="var(--muted)" mt={6}>公開範囲を変えられるのは全体管理者だけです。</Text>}
      </Card>
    </Stack>
  );
}
