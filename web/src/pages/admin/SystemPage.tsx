import { Button, Card, Group, Loader, Modal, Select, Stack, Table, Tabs, Text, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useOutletContext, useSearchParams } from 'react-router';
import { notifications } from '@mantine/notifications';
import { api, ApiError } from '../../api';
import type { AdminContext } from '../../components/AdminLayout';
import { AUDIT_ACTION, fromInputDate, NOTIFICATION_KIND, showDateTime } from '../../labels';
import { done, fail } from './shared';

/** SC-19 システム設定（全体管理者のみ）。二人承認・大会終了のタブは段階 6 で追加 */
export function SystemPage() {
  const { adminLevel } = useOutletContext<AdminContext>();
  const [params, setParams] = useSearchParams();
  if (adminLevel !== 'super') return <Navigate to="/admin" replace />;
  return (
    <Stack gap="lg">
      <Title order={1}>システム設定</Title>
      <Tabs value={params.get('tab') ?? 'notify'} onChange={(v) => setParams(v ? { tab: v } : {})} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="notify">Discord 通知</Tabs.Tab>
          <Tabs.Tab value="logs">操作ログ</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="notify"><NotificationsTab /></Tabs.Panel>
        <Tabs.Panel value="logs"><AuditLogTab /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

interface NotifRow { kind: string; configured: boolean; channelId: string | null; channelName: string | null; categoryName: string | null }
interface Channel { id: string; name: string; kind: 'text' | 'announcement'; categoryId: string | null; categoryName: string | null }
interface Group { categoryId: string | null; categoryName: string | null; channels: Channel[] }
const NO_CATEGORY = '__none__';
const where = (r: { categoryName: string | null; channelName: string | null }) => `${r.categoryName ?? 'カテゴリーなし'} ／ #${r.channelName}`;

function NotificationsTab() {
  const [rows, setRows] = useState<NotifRow[] | null>(null);
  const [editing, setEditing] = useState<NotifRow | null>(null);
  const load = useCallback(() => api<{ notifications: NotifRow[] }>('GET', '/api/admin/settings/notifications').then((r) => setRows(r.notifications)).catch(fail), []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <Loader />;
  const test = async (kind: string) => {
    try {
      const r = await api<{ ok: boolean; reason?: string }>('POST', `/api/admin/settings/notifications/${kind}/test`);
      const r2 = r as { ok: boolean; reason?: string };
      r2.ok ? done('テスト送信しました。Discord を確認してください') : notifications.show({ color: 'red', title: '送れませんでした', message: r2.reason ?? '' });
    } catch (e) { fail(e); }
  };
  const remove = async (kind: string) => {
    try { await api('DELETE', `/api/admin/settings/notifications/${kind}`); done('送り先を削除しました'); void load(); } catch (e) { fail(e); }
  };
  return (
    <Stack gap="md">
      <Text size="sm" c="var(--muted)">通知の種類ごとに、送り先のチャンネルを選べます。指定のない種類は「大会全体」のチャンネルに送ります。通知は Bot が投稿します。</Text>
      <Table.ScrollContainer minWidth={640}>
        <Table verticalSpacing="sm">
          <Table.Thead><Table.Tr><Table.Th>通知の種類</Table.Th><Table.Th>送り先</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.kind}>
                <Table.Td fw={r.kind === 'default' ? 700 : 400}>{NOTIFICATION_KIND[r.kind] ?? r.kind}</Table.Td>
                <Table.Td c={r.configured ? undefined : 'var(--muted)'}>{r.configured ? where(r) : r.kind === 'default' ? '未設定（通知は送られません）' : '大会全体と同じ'}</Table.Td>
                <Table.Td><Group gap="xs" justify="flex-end">
                  <Button size="xs" variant="default" onClick={() => setEditing(r)}>{r.configured ? '変更' : '設定'}</Button>
                  {r.configured && <Button size="xs" variant="default" onClick={() => test(r.kind)}>テスト送信</Button>}
                  {r.configured && <Button size="xs" variant="subtle" color="red" onClick={() => remove(r.kind)}>削除</Button>}
                </Group></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {editing && <NotifDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </Stack>
  );
}

function NotifDialog({ row, onClose, onSaved }: { row: NotifRow; onClose: () => void; onSaved: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(row.channelId);
  useEffect(() => {
    api<{ groups: Group[] }>('GET', '/api/admin/discord/channels')
      .then((r) => {
        setGroups(r.groups);
        const cur = r.groups.find((g) => g.channels.some((c) => c.id === row.channelId));
        setCategory(cur ? cur.categoryId ?? NO_CATEGORY : null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Discord からチャンネルの一覧を取得できませんでした'));
  }, [row.channelId]);
  const group = groups?.find((g) => (g.categoryId ?? NO_CATEGORY) === category);
  const save = async () => {
    try {
      await api('PUT', `/api/admin/settings/notifications/${row.kind}`, { channelId });
      done('送り先を保存しました');
      onSaved();
    } catch (e) { fail(e); }
  };
  return (
    <Modal opened onClose={onClose} title={`送り先：${NOTIFICATION_KIND[row.kind] ?? row.kind}`}>
      {error ? <Text c="red.8" role="alert">{error}</Text> : !groups ? <Loader /> : (
        <Stack>
          <Select label="カテゴリー" placeholder="選んでください" value={category} allowDeselect={false}
            onChange={(v) => { setCategory(v); setChannelId(null); }}
            data={groups.map((g) => ({ value: g.categoryId ?? NO_CATEGORY, label: g.categoryName ?? 'カテゴリーなし' }))} />
          <Select label="チャンネル" placeholder={category ? '選んでください' : '先にカテゴリーを選んでください'} disabled={!group} value={channelId}
            onChange={setChannelId} allowDeselect={false}
            data={(group?.channels ?? []).map((c) => ({ value: c.id, label: `#${c.name}${c.kind === 'announcement' ? '（アナウンス）' : ''}` }))}
            description="テキストチャンネルとアナウンスチャンネルだけが選べます" />
          <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={save} disabled={!channelId}>保存する</Button></Group>
        </Stack>
      )}
    </Modal>
  );
}

interface LogRow { id: string; at: string; actor_user_id: string | null; action: string; target_type: string | null; target_id: string | null }

function AuditLogTab() {
  const [logs, setLogs] = useState<LogRow[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [action, setAction] = useState<string | null>(null);
  const [actor, setActor] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const search = useCallback(async () => {
    const p = new URLSearchParams();
    if (from) p.set('from', fromInputDate(from)!);
    if (to) p.set('to', new Date(new Date(fromInputDate(to)!).getTime() + 86400e3 - 1).toISOString());
    if (action) p.set('action', action);
    if (actor) p.set('actor', actor);
    try { setLogs((await api<{ logs: LogRow[] }>('GET', `/api/admin/audit-logs?${p}`)).logs); } catch (e) { fail(e); }
  }, [from, to, action, actor]);
  useEffect(() => {
    void search();
    api<{ users: { id: string; display_name: string }[] }>('GET', '/api/admin/users')
      .then((r) => setNames(Object.fromEntries(r.users.map((u) => [u.id, u.display_name])))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Stack gap="md">
      <Card withBorder padding="md">
        <Group align="flex-end" gap="sm">
          <TextInput type="date" label="期間（から）" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <TextInput type="date" label="期間（まで）" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
          <Select label="操作の種類" clearable value={action} onChange={setAction} w={220} data={Object.entries(AUDIT_ACTION).map(([value, label]) => ({ value, label }))} />
          <Select label="操作した人" clearable value={actor || null} onChange={(v) => setActor(v ?? '')} w={200} searchable
            data={Object.entries(names).map(([value, label]) => ({ value, label }))} />
          <Button onClick={search}>絞り込む</Button>
        </Group>
      </Card>
      {!logs ? <Loader /> : logs.length === 0 ? <Text c="var(--muted)">条件に合う操作はありません。</Text> : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="xs">
            <Table.Thead><Table.Tr><Table.Th>日時</Table.Th><Table.Th>操作した人</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {logs.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td>{showDateTime(l.at)}</Table.Td>
                  <Table.Td>{l.actor_user_id ? names[l.actor_user_id] ?? '削除済みの利用者' : '定期処理'}</Table.Td>
                  <Table.Td>{AUDIT_ACTION[l.action] ?? l.action}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Text size="sm" c="var(--muted)">操作ログは 1 年間保存され、誰も編集・削除できません。新しい順に 100 件まで表示します。</Text>
    </Stack>
  );
}
