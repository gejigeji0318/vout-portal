import { Badge, Box, Button, Card, Group, Loader, Select, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { showDateTime } from '../../labels';
import { INQUIRY_STATUS } from '../InquiryPage';
import { done, fail } from './shared';

interface Row { id: string; number: number; subject: string; status: string; updated_at: string; user_name: string; assignee_user_id: string | null }
interface Msg { id: string; from_staff: number; body: string; created_at: string; sender_name: string }
const no = (n: number) => `No.${String(n).padStart(4, '0')}`;

/** SC-18 問い合わせ対応 */
export function InquiriesTab() {
  const [filter, setFilter] = useState('active');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [admins, setAdmins] = useState<{ id: string; name: string }[]>([]);
  const load = useCallback(() => api<{ inquiries: Row[] }>('GET', `/api/admin/inquiries?status=${filter}`).then((r) => setRows(r.inquiries)).catch(fail), [filter]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api<{ admins: { id: string; name: string }[] }>('GET', '/api/admin/admins').then((r) => setAdmins(r.admins)).catch(() => {}); }, []);
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
      <Stack gap="xs">
        <Select aria-label="対応状況で絞り込み" value={filter} onChange={(v) => v && setFilter(v)} allowDeselect={false} w={220}
          data={[{ value: 'active', label: '未対応・対応中' }, { value: 'open', label: '未対応' }, { value: 'in_progress', label: '対応中' }, { value: 'done', label: '完了' }, { value: 'all', label: 'すべて' }]} />
        {!rows ? <Loader /> : rows.length === 0 ? <Text c="var(--muted)">該当する問い合わせはありません。</Text> : rows.map((r) => (
          <Card key={r.id} withBorder padding="sm" onClick={() => setSel(r.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(r.id)}
            style={{ cursor: 'pointer', borderColor: sel === r.id ? '#2148b8' : undefined, borderWidth: sel === r.id ? 2 : 1 }}>
            <Group justify="space-between"><Text size="xs" c="var(--muted)">{no(r.number)}・{r.user_name}</Text>
              <Badge size="sm" color={INQUIRY_STATUS[r.status]!.color} variant="light">{INQUIRY_STATUS[r.status]!.label}</Badge></Group>
            <Text fw={700}>{r.subject}</Text>
          </Card>
        ))}
      </Stack>
      {sel ? <Detail key={sel} id={sel} admins={admins} onChanged={() => void load()} /> : <Text c="var(--muted)">左の一覧から問い合わせを選んでください。</Text>}
    </SimpleGrid>
  );
}

function Detail({ id, admins, onChanged }: { id: string; admins: { id: string; name: string }[]; onChanged: () => void }) {
  const [d, setD] = useState<{ inquiry: Row; messages: Msg[] } | null>(null);
  const [text, setText] = useState('');
  const load = useCallback(() => api<{ inquiry: Row; messages: Msg[] }>('GET', `/api/admin/inquiries/${id}`).then(setD).catch(fail), [id]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <Loader />;
  const patch = async (body: Record<string, unknown>) => { try { await api('PATCH', `/api/admin/inquiries/${id}`, body); void load(); onChanged(); } catch (e) { fail(e); } };
  const reply = async (finish: boolean) => {
    try { await api('POST', `/api/admin/inquiries/${id}/messages`, { body: text, done: finish }); setText(''); done(finish ? '返信して完了にしました' : '返信しました'); void load(); onChanged(); } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb="sm">{no(d.inquiry.number)}：{d.inquiry.subject}</Title>
      <Group gap="sm" mb="md">
        <Select label="対応状況" w={140} value={d.inquiry.status} allowDeselect={false} onChange={(v) => v && patch({ status: v })}
          data={Object.entries(INQUIRY_STATUS).map(([value, s]) => ({ value, label: s.label }))} />
        <Select label="担当" w={180} value={d.inquiry.assignee_user_id} clearable placeholder="未定" onChange={(v) => patch({ assigneeUserId: v })}
          data={admins.map((a) => ({ value: a.id, label: a.name }))} />
      </Group>
      <Stack gap="sm">
        {d.messages.map((m) => (
          <Box key={m.id} style={{ padding: '10px 12px', borderRadius: 10, background: m.from_staff ? '#e8eefc' : '#f5f6f8' }}>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</Text>
            <Text size="xs" c="var(--muted)" mt={4}>{m.from_staff ? `運営（${m.sender_name}）` : m.sender_name}・{showDateTime(m.created_at)}</Text>
          </Box>
        ))}
        <Textarea aria-label="返信する" placeholder="返信する（相手には「運営」として表示されます）" value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={3} maxLength={2000} />
        <Group justify="flex-end"><Button variant="default" disabled={!text} onClick={() => reply(true)}>返信して完了にする</Button><Button disabled={!text} onClick={() => reply(false)}>返信</Button></Group>
      </Stack>
    </Card>
  );
}
