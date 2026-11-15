import { Alert, Badge, Button, Card, Chip, Group, Loader, Modal, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { showDateTime } from '../labels';
import { useSession } from '../session';

interface Applicant { id: string; userId: string; name: string; kind: string; status: string; lane: string | null }
interface Slot { id: string; lane: string; filled: boolean; filledByName?: string; myApplication: { id: string; status: string } | null; applicants?: Applicant[] }
interface Req { id: string; status: string; startsAt: string; endsAt: string; format: string; obPosted: boolean; teamName?: string; opponentName?: string; note?: string | null; canManage: boolean; slots: Slot[] }
const laneLabel = (l: string) => (l === 'ANY' ? 'どのレーンでも' : l);
const range = (s: string, e: string) => `${showDateTime(s)}〜${showDateTime(e).split(' ')[1]}`;
const APP: Record<string, { label: string; color: string }> = {
  invited: { label: '声かけ中', color: 'blue' }, applied: { label: '応募中', color: 'orange' }, approved: { label: '決定', color: 'green' },
  declined: { label: '辞退', color: 'gray' }, not_selected: { label: '今回は見送り', color: 'gray' }, withdrawn: { label: '取り下げ', color: 'gray' },
};
const KIND: Record<string, string> = { player: '選手', staff: '運営', admin: '運営', ob: 'OB' };
const fail = (e: unknown) => notifications.show({ color: 'red', title: 'できませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });
const ok = (m: string) => notifications.show({ color: 'green', message: m });
const OB_RESULT: Record<string, { color: string; text: string }> = {
  ok: { color: 'green', text: 'OB として確認できました。OB 向けの募集に応募できます。' },
  not_member: { color: 'red', text: 'Vout の Discord サーバーに参加していることを確認できませんでした。サーバーに参加してから、もう一度お試しください。' },
  mismatch: { color: 'red', text: 'ポータルにログインしているものと、別の Discord アカウントで認証されました。同じアカウントでお試しください。' },
  error: { color: 'red', text: 'Discord との確認に失敗しました。時間をおいてもう一度お試しください。' },
};

/** SC-12 人員補充／SC-13 OB 向け補充募集（F-07） */
export function FillPage() {
  const { me } = useSession();
  const [params] = useSearchParams();
  const [d, setD] = useState<{ kind: string; requests: Req[] } | null>(null);
  const [needVerify, setNeedVerify] = useState(false);
  const [inviting, setInviting] = useState<{ req: Req; slot: Slot } | null>(null);
  const load = useCallback(() => api<{ kind: string; requests: Req[] }>('GET', '/api/fill').then(setD).catch((e) => { if (e instanceof ApiError && e.status === 403) setNeedVerify(true); else fail(e); }), []);
  useEffect(() => { if (me?.loggedIn) void load(); }, [me?.loggedIn, load]);
  const ob = params.get('ob');
  if (!me) return null;
  if (!me.loggedIn) return <Stack maw={720}><Title order={1}>人員補充</Title><Text>応募には Discord でのログインが必要です。</Text><Button component="a" href="/auth/login" w="fit-content">Discord でログイン</Button></Stack>;
  if (needVerify) {
    return (
      <Stack maw={720} gap="md">
        <Title order={1}>OB 向けの補充募集</Title>
        {ob && OB_RESULT[ob] && <Alert color={OB_RESULT[ob].color}>{OB_RESULT[ob].text}</Alert>}
        <Text>以前の大会に参加した OB の方は、Vout の Discord サーバーに参加していることを確認すると、スクリムの人員補充に応募できます。</Text>
        <Text size="sm" c="var(--muted)">Discord でもう一度認証し、参加しているサーバーの一覧から Vout のサーバーがあるかだけを確かめます。サーバーの一覧は保存しません。</Text>
        <Button component="a" href="/auth/ob-verify" w="fit-content">Discord で OB の確認をする</Button>
      </Stack>
    );
  }
  if (!d) return <Loader />;
  const act = async (method: 'POST', path: string, msg: string) => { try { await api(method, path); ok(msg); void load(); } catch (e) { fail(e); } };
  const isOb = d.kind === 'ob';
  return (
    <Stack gap="lg" maw={960}>
      <Title order={1}>{isOb ? 'OB 向けの補充募集' : '人員補充'}</Title>
      {ob === 'ok' && <Alert color="green">{OB_RESULT.ok!.text}</Alert>}
      <Text size="sm" c="var(--muted)">{isOb ? 'スクリムに人が足りないときの募集です。応募すると、募集したチームが確認して決めます。' : '声をかけられただけでは決まりません。応募して、募集したチームのコーチか運営が承認すると決まります。'}</Text>
      {d.requests.length === 0 && <Text c="var(--muted)">いま募集はありません。</Text>}
      {d.requests.map((r) => (
        <Card key={r.id} withBorder padding="lg">
          <Group justify="space-between" mb="xs">
            <div>
              <Text fw={700}>{range(r.startsAt, r.endsAt)}（{r.format}）</Text>
              {r.teamName && <Text size="sm" c="var(--muted)">{r.teamName} vs {r.opponentName}</Text>}
            </div>
            <Group gap="xs">
              {r.status === 'filled' && <Badge color="green" variant="light">すべて決定</Badge>}
              {!isOb && r.obPosted && <Badge variant="light" color="grape">OB 向けにも募集中</Badge>}
              {me.user?.isAdmin && r.status === 'open' && !r.obPosted && <Button size="compact-xs" variant="default" onClick={() => act('POST', `/api/admin/fill/${r.id}/ob-now`, 'OB 向けに募集を出しました')}>今すぐ OB に募集</Button>}
              {r.canManage && r.status === 'open' && <Button size="compact-xs" variant="subtle" color="red" onClick={() => act('POST', `/api/fill/${r.id}/cancel`, '募集を締め切りました')}>募集をやめる</Button>}
            </Group>
          </Group>
          {r.note && <Text size="sm" mb="xs" style={{ whiteSpace: 'pre-wrap' }}>{r.note}</Text>}
          <Stack gap="xs">
            {r.slots.map((s) => (
              <Card key={s.id} withBorder padding="sm" bg={s.filled ? '#f3faf5' : undefined}>
                <Group justify="space-between">
                  <Group gap="xs"><Badge variant="outline">{laneLabel(s.lane)}</Badge>{s.filled ? <Text size="sm">決定{s.filledByName ? `：${s.filledByName}` : ''}</Text> : <Text size="sm" c="var(--muted)">募集中</Text>}</Group>
                  {!s.filled && !r.canManage && (
                    s.myApplication && ['applied'].includes(s.myApplication.status)
                      ? <Group gap="xs"><Badge color="orange" variant="light">応募中</Badge><Button size="compact-xs" variant="subtle" onClick={() => act('POST', `/api/fill/slots/${s.id}/withdraw`, '応募を取り下げました')}>取り下げる</Button></Group>
                      : s.myApplication?.status === 'invited'
                        ? <Group gap="xs"><Badge color="blue" variant="light">声がかかっています</Badge><Button size="compact-xs" onClick={() => act('POST', `/api/fill/slots/${s.id}/apply`, '応募しました')}>参加できる（応募する）</Button><Button size="compact-xs" variant="subtle" onClick={() => act('POST', `/api/fill/slots/${s.id}/withdraw`, '辞退しました')}>辞退する</Button></Group>
                        : s.myApplication && APP[s.myApplication.status] && s.myApplication.status !== 'withdrawn' && s.myApplication.status !== 'declined'
                          ? <Badge color={APP[s.myApplication.status]!.color} variant="light">{APP[s.myApplication.status]!.label}</Badge>
                          : <Button size="compact-xs" onClick={() => act('POST', `/api/fill/slots/${s.id}/apply`, '応募しました')}>応募する</Button>
                  )}
                  {!s.filled && r.canManage && <Button size="compact-xs" variant="default" onClick={() => setInviting({ req: r, slot: s })}>声をかける</Button>}
                </Group>
                {r.canManage && s.applicants && s.applicants.length > 0 && (
                  <Table mt="xs" verticalSpacing={2}><Table.Tbody>{s.applicants.map((a) => (
                    <Table.Tr key={a.id}>
                      <Table.Td>{a.name}</Table.Td><Table.Td>{KIND[a.kind]}{a.lane ? `・${a.lane}` : ''}</Table.Td>
                      <Table.Td><Badge size="sm" color={APP[a.status]!.color} variant="light">{APP[a.status]!.label}</Badge></Table.Td>
                      <Table.Td align="right">{a.status === 'applied' && !s.filled && <Button size="compact-xs" onClick={() => act('POST', `/api/fill/applications/${a.id}/approve`, `${a.name} さんで決定しました`)}>この人で決定</Button>}</Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody></Table>
                )}
              </Card>
            ))}
          </Stack>
        </Card>
      ))}
      {inviting && <InviteDialog req={inviting.req} slot={inviting.slot} onClose={() => setInviting(null)} onDone={() => { setInviting(null); void load(); }} />}
    </Stack>
  );
}

const SYM: Record<string, string> = { o: '○', t: '△', x: '×' };
function InviteDialog({ req, slot, onClose, onDone }: { req: Req; slot: Slot; onClose: () => void; onDone: () => void }) {
  const [people, setPeople] = useState<{ userId: string; name: string; lane: string | null; kind: string; availability: { status: string; start: string | null; end: string | null } | null }[] | null>(null);
  useEffect(() => { api<{ people: NonNullable<typeof people> }>('GET', `/api/fill/${req.id}/candidates`).then((r) => setPeople(r.people)).catch(fail); }, [req.id]);
  const invite = async (userId: string, name: string) => { try { await api('POST', `/api/fill/slots/${slot.id}/invite`, { userId }); ok(`${name} さんに声をかけました（Discord で本人に届きます）`); onDone(); } catch (e) { fail(e); } };
  return (
    <Modal opened onClose={onClose} title={`声をかける：${laneLabel(slot.lane)}（${range(req.startsAt, req.endsAt)}）`} size="lg">
      <Text size="sm" c="var(--muted)" mb="sm">その日の予定表で ○ の人から順に並んでいます。声をかけても、本人が応募するまでは決まりません。</Text>
      {!people ? <Loader /> : (
        <Table verticalSpacing={4}><Table.Tbody>{people.map((p) => (
          <Table.Tr key={p.userId}>
            <Table.Td>{p.name}</Table.Td><Table.Td>{p.kind}{p.lane ? `・${p.lane}` : ''}</Table.Td>
            <Table.Td>{p.availability ? `${SYM[p.availability.status]} ${p.availability.start ? `${p.availability.start}〜${p.availability.end}` : ''}` : <Text size="xs" c="var(--muted)">未入力</Text>}</Table.Td>
            <Table.Td align="right"><Button size="compact-xs" variant="default" onClick={() => invite(p.userId, p.name)}>声をかける</Button></Table.Td>
          </Table.Tr>
        ))}</Table.Tbody></Table>
      )}
    </Modal>
  );
}

/** スクリムの画面から開く：補充の募集を出す */
export function OpenFillDialog({ scrimId, teamId, onClose, onDone }: { scrimId: string; teamId?: string | null; onClose: () => void; onDone: () => void }) {
  const [lanes, setLanes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const submit = async () => {
    try { await api('POST', '/api/fill', { scrimId, lanes, note: note || null, teamId }); ok('補充の募集を出しました'); onDone(); } catch (e) { fail(e); }
  };
  return (
    <Modal opened onClose={onClose} title="人員補充を募集">
      <Stack>
        <Text size="sm">足りないレーンを選んでください（同じレーンを 2 人以上募集するときは、もう一度押すと増えます）</Text>
        <Group gap={6}>{['TOP', 'JG', 'MID', 'BOT', 'SUP', 'ANY'].map((l) => <Button key={l} size="compact-sm" variant="default" disabled={lanes.length >= 5} onClick={() => setLanes((x) => [...x, l])}>{laneLabel(l)}</Button>)}</Group>
        {lanes.length > 0 && <Chip.Group><Group gap={6}>{lanes.map((l, i) => <Chip key={i} checked onClick={() => setLanes((x) => x.filter((_, j) => j !== i))}>{laneLabel(l)} ×</Chip>)}</Group></Chip.Group>}
        <Textarea label="補足（任意。OB 向けの募集には表示されません）" value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={200} autosize minRows={2} />
        <Text size="xs" c="var(--muted)">埋まらないときは、スクリム開始の 24 時間前に、OB 向けにも自動で募集します（日時・時間・レーン・人数だけ）。</Text>
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button disabled={!lanes.length} onClick={submit}>募集する</Button></Group>
      </Stack>
    </Modal>
  );
}
