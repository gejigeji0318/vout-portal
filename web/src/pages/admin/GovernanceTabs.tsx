import { Alert, Badge, Button, Card, Group, Loader, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { showDateTime } from '../../labels';
import { done, fail } from './shared';

interface Approval { id: string; kind: string; label: string; status: string; requester: string; requestedBy: string; decider: string | null; expiresAt: string; createdAt: string; target: string }
const STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: '承認待ち', color: 'orange' }, approved: { label: '承認・実行済み', color: 'green' }, rejected: { label: '却下', color: 'red' }, expired: { label: '期限切れ', color: 'gray' }, cancelled: { label: '取り消し', color: 'gray' },
};

/** 二人承認（全体管理者のみ）：管理者の追加・解除、大会終了 */
export function ApprovalsTab() {
  const [d, setD] = useState<{ me: string; approvals: Approval[] } | null>(null);
  const [users, setUsers] = useState<{ id: string; display_name: string; admin_level: string }[]>([]);
  const [grant, setGrant] = useState<{ userId: string | null; level: string }>({ userId: null, level: 'sub' });
  const [revoke, setRevoke] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const load = useCallback(() => api<NonNullable<typeof d>>('GET', '/api/admin/approvals').then(setD).catch(fail), []);
  useEffect(() => { void load(); api<{ users: typeof users }>('GET', '/api/admin/users').then((r) => setUsers(r.users)).catch(() => {}); }, [load]);
  if (!d) return <Loader />;
  const request = async (body: Record<string, unknown>) => { try { await api('POST', '/api/admin/approvals', body); done('申請しました。もう 1 人の全体管理者が承認すると実行されます'); void load(); } catch (e) { fail(e); } };
  const decide = async (id: string, action: 'approve' | 'reject') => { try { await api('POST', `/api/admin/approvals/${id}/${action}`); done(action === 'approve' ? '承認しました（実行されました）' : '処理しました'); void load(); } catch (e) { fail(e); } };
  return (
    <Stack gap="lg" maw={960}>
      <Alert color="orange">取り返しのつかない操作は、全体管理者 2 人で行います。申請した人とは別の全体管理者が、24 時間以内に承認すると実行されます。</Alert>
      <Card withBorder padding="lg">
        <Title order={2} size="h5" mb="sm">申請する</Title>
        <Stack gap="md">
          <Group align="flex-end" gap="xs">
            <Select label="管理者にする人" searchable w={240} value={grant.userId} onChange={(v) => setGrant({ ...grant, userId: v })} data={users.filter((u) => u.admin_level === 'none').map((u) => ({ value: u.id, label: u.display_name }))} />
            <Select label="種別" w={150} value={grant.level} onChange={(v) => v && setGrant({ ...grant, level: v })} data={[{ value: 'sub', label: '補助管理者' }, { value: 'super', label: '全体管理者' }]} allowDeselect={false} />
            <Button variant="default" disabled={!grant.userId} onClick={() => request({ kind: 'admin_grant', userId: grant.userId, level: grant.level })}>管理者の追加を申請</Button>
          </Group>
          <Group align="flex-end" gap="xs">
            <Select label="管理者を解除する人" w={240} value={revoke} onChange={setRevoke} data={users.filter((u) => u.admin_level !== 'none').map((u) => ({ value: u.id, label: u.display_name }))} />
            <Button variant="default" disabled={!revoke} onClick={() => request({ kind: 'admin_revoke', userId: revoke })}>管理者の解除を申請</Button>
          </Group>
          <Group align="flex-end" gap="xs">
            <TextInput label="大会終了（確認のため「大会終了」と入力）" w={300} value={confirmText} onChange={(e) => setConfirmText(e.currentTarget.value)} />
            <Button color="red" variant="light" disabled={confirmText !== '大会終了'} onClick={() => { setConfirmText(''); void request({ kind: 'tournament_end' }); }}>大会終了を申請</Button>
          </Group>
          <Text size="xs" c="var(--muted)">大会終了が承認されると、大会のデータは画面から消えます。10 日以内なら元に戻せ、10 日を過ぎるとすべて削除されます。</Text>
        </Stack>
      </Card>
      <Card withBorder padding="lg">
        <Title order={2} size="h5" mb="sm">申請の一覧</Title>
        {d.approvals.length === 0 ? <Text c="var(--muted)">まだありません。</Text> : (
          <Table.ScrollContainer minWidth={700}><Table verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>内容</Table.Th><Table.Th>対象</Table.Th><Table.Th>申請</Table.Th><Table.Th>状態</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>{d.approvals.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td fw={500}>{a.label}</Table.Td><Table.Td>{a.target}</Table.Td>
                <Table.Td><Text size="sm">{a.requester}</Text><Text size="xs" c="var(--muted)">{showDateTime(a.createdAt)}</Text></Table.Td>
                <Table.Td><Badge color={STATUS[a.status]!.color} variant="light">{STATUS[a.status]!.label}</Badge>{a.decider && <Text size="xs" c="var(--muted)">{a.decider}</Text>}
                  {a.status === 'pending' && <Text size="xs" c="var(--muted)">{showDateTime(a.expiresAt)} まで</Text>}</Table.Td>
                <Table.Td align="right">{a.status === 'pending' && (a.requestedBy === d.me
                  ? <Button size="compact-xs" variant="subtle" onClick={() => decide(a.id, 'reject')}>取り消す</Button>
                  : <Group gap={4} justify="flex-end"><Button size="compact-xs" color={a.kind === 'tournament_end' ? 'red' : undefined} onClick={() => decide(a.id, 'approve')}>承認して実行</Button><Button size="compact-xs" variant="subtle" onClick={() => decide(a.id, 'reject')}>却下</Button></Group>)}</Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table></Table.ScrollContainer>
        )}
      </Card>
      <EndedTournaments />
    </Stack>
  );
}

function EndedTournaments() {
  const [list, setList] = useState<{ id: string; name: string; ended_at: string; purgeAt: string }[] | null>(null);
  const load = useCallback(() => api<{ tournaments: NonNullable<typeof list> }>('GET', '/api/admin/tournaments/ended').then((r) => setList(r.tournaments)).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  if (!list || list.length === 0) return null;
  const restore = async (id: string) => { try { await api('POST', `/api/admin/tournaments/${id}/restore`); done('大会を元に戻しました'); void load(); } catch (e) { fail(e); } };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h5" mb="sm">終了した大会（10 日以内なら元に戻せます）</Title>
      {list.map((t) => (
        <Group key={t.id} justify="space-between" py={4}>
          <Text size="sm">{t.name}（{showDateTime(t.ended_at)} に終了・{showDateTime(t.purgeAt)} に削除）</Text>
          {new Date(t.purgeAt) > new Date() && <Button size="compact-xs" variant="default" onClick={() => restore(t.id)}>元に戻す</Button>}
        </Group>
      ))}
    </Card>
  );
}

/** 人員補充の設定（全体管理者のみ） */
export function FillSettingsTab() {
  const [hours, setHours] = useState<number | string | null>(null);
  useEffect(() => { api<{ obHoursBefore: number }>('GET', '/api/admin/fill/settings').then((r) => setHours(r.obHoursBefore)).catch(fail); }, []);
  if (hours === null) return <Loader />;
  const save = async () => { try { await api('PUT', '/api/admin/fill/settings', { obHoursBefore: Number(hours) }); done('保存しました'); } catch (e) { fail(e); } };
  return (
    <Card withBorder padding="lg" maw={640}>
      <Title order={2} size="h5" mb="xs">OB への自動募集</Title>
      <Text size="sm" c="var(--muted)" mb="md">補充の募集が埋まっていないとき、スクリム開始の何時間前に OB 向けにも募集を出すか。0 にすると、募集を出した時点で OB にも出します。</Text>
      <Group align="flex-end"><NumberInput label="開始の何時間前" min={0} max={168} value={hours} onChange={setHours} w={160} suffix=" 時間" /><Button onClick={save}>保存</Button></Group>
    </Card>
  );
}
