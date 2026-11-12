import { Badge, Box, Button, Card, Group, Loader, Modal, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { api, ApiError } from '../api';
import { showDateTime } from '../labels';
import { useSession } from '../session';

export const INQUIRY_STATUS: Record<string, { label: string; color: string }> = {
  open: { label: '未対応', color: 'red' }, in_progress: { label: '対応中', color: 'orange' }, done: { label: '完了', color: 'gray' },
};
const no = (n: number) => `No.${String(n).padStart(4, '0')}`;
const fail = (e: unknown) => notifications.show({ color: 'red', title: '送れませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });

interface Row { id: string; number: number; subject: string; status: string; created_at: string; last_reply_at: string | null }
interface Msg { id: string; fromStaff: boolean; body: string; createdAt: string }

/** SC-09 問い合わせ：自分の問い合わせの作成・一覧・やり取り */
export function InquiryPage() {
  const { me } = useSession();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, { open, close }] = useDisclosure(false);
  const load = useCallback(() => api<{ inquiries: Row[] }>('GET', '/api/inquiries').then((r) => setRows(r.inquiries)).catch(() => setRows([])), []);
  useEffect(() => { if (me?.loggedIn) void load(); }, [me?.loggedIn, load]);
  if (!me) return null;
  if (!me.loggedIn) return <Navigate to="/" replace />;
  return (
    <Stack gap="lg" maw={760}>
      <Group justify="space-between"><Title order={1}>問い合わせ</Title><Button onClick={open}>新しく問い合わせる</Button></Group>
      <Text size="sm" c="var(--muted)">運営への質問や相談はここから送れます。返信もこの画面に届きます（画像の添付はできません）。</Text>
      {!rows ? <Loader /> : rows.length === 0 ? <Text c="var(--muted)">まだ問い合わせはありません。</Text> : (
        <Stack gap="xs">{rows.map((r) => (
          <Card key={r.id} withBorder padding="md" onClick={() => setOpenId(r.id)} style={{ cursor: 'pointer' }} role="button" tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setOpenId(r.id)}>
            <Group justify="space-between" mb={2}>
              <Text size="sm" c="var(--muted)">{no(r.number)}・{showDateTime(r.created_at)}</Text>
              <Group gap={6}>{r.last_reply_at && r.status !== 'done' && <Badge color="blue" variant="light">返信あり</Badge>}
                <Badge color={INQUIRY_STATUS[r.status]!.color} variant="light">{INQUIRY_STATUS[r.status]!.label}</Badge></Group>
            </Group>
            <Text fw={700}>{r.subject}</Text>
          </Card>))}</Stack>
      )}
      {creating && <NewInquiry onClose={close} onSent={(id) => { close(); void load(); setOpenId(id); }} />}
      {openId && <Thread id={openId} onClose={() => { setOpenId(null); void load(); }} />}
    </Stack>
  );
}

function NewInquiry({ onClose, onSent }: { onClose: () => void; onSent: (id: string) => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const send = async () => {
    try { const r = await api<{ id: string; number: number }>('POST', '/api/inquiries', { subject, body }); notifications.show({ color: 'green', message: `受け付けました（${no(r.number)}）` }); onSent(r.id); } catch (e) { fail(e); }
  };
  return (
    <Modal opened onClose={onClose} title="新しく問い合わせる">
      <Stack>
        <TextInput label="件名" value={subject} onChange={(e) => setSubject(e.currentTarget.value)} maxLength={60} />
        <Textarea label="内容" value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={5} maxLength={2000} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={send} disabled={!subject || !body}>送信</Button></Group>
      </Stack>
    </Modal>
  );
}

function Thread({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<{ inquiry: Row; messages: Msg[] } | null>(null);
  const [text, setText] = useState('');
  const load = useCallback(() => api<{ inquiry: Row; messages: Msg[] }>('GET', `/api/inquiries/${id}`).then(setD).catch(onClose), [id, onClose]);
  useEffect(() => { void load(); }, [load]);
  const send = async () => { try { await api('POST', `/api/inquiries/${id}/messages`, { body: text }); setText(''); void load(); } catch (e) { fail(e); } };
  return (
    <Modal opened onClose={onClose} title={d ? `${no(d.inquiry.number)}：${d.inquiry.subject}` : ''} size="lg">
      {!d ? <Loader /> : (
        <Stack>
          {d.messages.map((m) => (
            <Box key={m.id} style={{ alignSelf: m.fromStaff ? 'flex-start' : 'flex-end', maxWidth: '85%', padding: '10px 12px', borderRadius: 12,
              background: m.fromStaff ? '#f5f6f8' : '#e8eefc' }}>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</Text>
              <Text size="xs" c="var(--muted)" mt={4}>{m.fromStaff ? '運営' : 'あなた'}・{showDateTime(m.createdAt)}</Text>
            </Box>
          ))}
          <Textarea aria-label="返信する" placeholder="返信する" value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={3} maxLength={2000} />
          <Button onClick={send} disabled={!text} w="fit-content" ml="auto">送信</Button>
        </Stack>
      )}
    </Modal>
  );
}
