import { ActionIcon, Badge, Button, Card, Checkbox, Group, Loader, Modal, SegmentedControl, Select, Stack, Table, Tabs, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { api } from '../../api';
import type { AdminContext } from '../../components/AdminLayout';
import { CATEGORY, fromInputDateTime, MEMBER_TYPE, showDateTime, teamLabel, toInputDateTime, VISIBILITY } from '../../labels';
import { PRIVACY_TEMPLATE } from './privacyTemplate';
import { LanesTab } from './LanesTab';
import { done, fail, type Team } from './shared';

/** お知らせ・案内ページの管理 */
export function ContentPage() {
  const { adminLevel } = useOutletContext<AdminContext>();
  const [params, setParams] = useSearchParams();
  return (
    <Stack gap="lg">
      <Title order={1}>お知らせ・ページ・ツール</Title>
      <Tabs value={params.get('tab') ?? 'news'} onChange={(v) => setParams(v ? { tab: v } : {})} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="news">お知らせ</Tabs.Tab>
          <Tabs.Tab value="pages">案内ページ</Tabs.Tab>
          {adminLevel === 'super' && <Tabs.Tab value="links">公式リンク</Tabs.Tab>}
          <Tabs.Tab value="lanes">適性レーン</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="news"><AnnouncementsTab /></Tabs.Panel>
        <Tabs.Panel value="pages"><PagesTab adminLevel={adminLevel} /></Tabs.Panel>
        {adminLevel === 'super' && <Tabs.Panel value="links"><LinksTab /></Tabs.Panel>}
        <Tabs.Panel value="lanes"><LanesTab adminLevel={adminLevel} /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

// ---------------- お知らせ ----------------
interface Target { memberType: string | null; teamId: string | null }
interface Ann {
  id: string; title: string; body: string; category: string; visibility: string; important: boolean;
  publishedAt: string | null; status: 'draft' | 'scheduled' | 'published'; targets: Target[];
}
const STATUS: Record<Ann['status'], { label: string; color: string }> = {
  draft: { label: '下書き', color: 'gray' }, scheduled: { label: '予約', color: 'orange' }, published: { label: '公開中', color: 'green' },
};

function AnnouncementsTab() {
  const [list, setList] = useState<Ann[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [editing, setEditing] = useState<Ann | 'new' | null>(null);
  const [confirmations, setConfirmations] = useState<Ann | null>(null);
  const load = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([api<{ announcements: Ann[] }>('GET', '/api/admin/announcements'), api<{ teams: Team[] }>('GET', '/api/admin/teams')]);
      setList(a.announcements); setTeams(t.teams);
    } catch (e) { fail(e); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!list) return <Loader />;
  const remove = async (a: Ann) => { try { await api('DELETE', `/api/admin/announcements/${a.id}`); done('お知らせを削除しました'); void load(); } catch (e) { fail(e); } };
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="var(--muted)">公開すると Discord に通知します。予約したものは、その時刻に自動で公開・通知します。</Text>
        <Button onClick={() => setEditing('new')}>お知らせを作成</Button>
      </Group>
      {list.length === 0 ? <Text c="var(--muted)">まだありません。</Text> : (
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="sm">
            <Table.Thead><Table.Tr><Table.Th>状態</Table.Th><Table.Th>タイトル</Table.Th><Table.Th>カテゴリー</Table.Th><Table.Th>公開範囲</Table.Th><Table.Th>公開日時</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {list.map((a) => (
                <Table.Tr key={a.id}>
                  <Table.Td><Badge color={STATUS[a.status].color} variant="light">{STATUS[a.status].label}</Badge></Table.Td>
                  <Table.Td><Group gap={6}>{a.important && <Badge color="red" variant="light">重要</Badge>}{a.title}</Group></Table.Td>
                  <Table.Td>{CATEGORY[a.category]}</Table.Td>
                  <Table.Td>{VISIBILITY[a.visibility]}</Table.Td>
                  <Table.Td>{showDateTime(a.publishedAt)}</Table.Td>
                  <Table.Td><Group gap="xs" justify="flex-end" wrap="nowrap">
                    {a.important && a.status === 'published' && <Button size="xs" variant="default" onClick={() => setConfirmations(a)}>確認状況</Button>}
                    <Button size="xs" variant="default" onClick={() => setEditing(a)}>編集</Button>
                    <Button size="xs" variant="subtle" color="red" onClick={() => remove(a)}>削除</Button>
                  </Group></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {editing && <AnnouncementDialog initial={editing === 'new' ? null : editing} teams={teams} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {confirmations && <ConfirmationsDialog a={confirmations} onClose={() => setConfirmations(null)} />}
    </Stack>
  );
}

function AnnouncementDialog({ initial, teams, onClose, onSaved }: { initial: Ann | null; teams: Team[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [category, setCategory] = useState(initial?.category ?? 'general');
  const [visibility, setVisibility] = useState(initial?.visibility ?? 'public');
  const [important, setImportant] = useState(initial?.important ?? false);
  const [targets, setTargets] = useState<Target[]>(initial?.targets.length ? initial.targets : [{ memberType: null, teamId: null }]);
  const [timing, setTiming] = useState<'draft' | 'now' | 'at'>(initial ? (initial.status === 'draft' ? 'draft' : initial.status === 'scheduled' ? 'at' : 'now') : 'now');
  const [at, setAt] = useState(toInputDateTime(initial?.status === 'scheduled' ? initial.publishedAt : null));
  const alreadyPublished = initial?.status === 'published';
  const save = async () => {
    const publishAt = timing === 'draft' ? null : timing === 'at' ? fromInputDateTime(at) : alreadyPublished ? initial!.publishedAt : 'now';
    const payload = { title, body, category, visibility, important: visibility !== 'public' && important, targets: visibility === 'targeted' ? targets : [], publishAt };
    try {
      await (initial ? api('PUT', `/api/admin/announcements/${initial.id}`, payload) : api('POST', '/api/admin/announcements', payload));
      done(timing === 'draft' ? '下書きを保存しました' : timing === 'at' ? '公開を予約しました' : alreadyPublished ? 'お知らせを更新しました' : 'お知らせを公開しました');
      onSaved();
    } catch (e) { fail(e); }
  };
  const teamOptions = [{ value: '', label: 'すべてのチーム' }, ...teams.map((t) => ({ value: t.id, label: teamLabel(teams, t.id) }))];
  const typeOptions = [{ value: '', label: 'すべての立場' }, ...Object.entries(MEMBER_TYPE).map(([value, label]) => ({ value, label }))];
  return (
    <Modal opened onClose={onClose} title={initial ? 'お知らせを編集' : 'お知らせを作成'} size="lg">
      <Stack>
        <TextInput label="タイトル" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={80} required />
        <Textarea label="本文" value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={6} maxLength={10000} required />
        <Select label="カテゴリー" value={category} onChange={(v) => v && setCategory(v)} allowDeselect={false} data={Object.entries(CATEGORY).map(([value, label]) => ({ value, label }))} />
        <Stack gap={6}>
          <Text size="sm" fw={500}>公開範囲</Text>
          <SegmentedControl value={visibility} onChange={setVisibility} data={Object.entries(VISIBILITY).map(([value, label]) => ({ value, label }))} />
        </Stack>
        {visibility === 'targeted' && (
          <Stack gap="xs">
            <Text size="sm" c="var(--muted)">「立場 × チーム」の組み合わせで対象者を選びます。いずれかの行に当てはまる人に表示します。</Text>
            {targets.map((t, i) => (
              <Group key={i} gap="xs" wrap="nowrap">
                <Select aria-label="立場" value={t.memberType ?? ''} data={typeOptions} allowDeselect={false} style={{ flex: 1 }}
                  onChange={(v) => setTargets((l) => l.map((x, j) => (j === i ? { ...x, memberType: v || null } : x)))} />
                <Select aria-label="チーム" value={t.teamId ?? ''} data={teamOptions} allowDeselect={false} style={{ flex: 1 }}
                  onChange={(v) => setTargets((l) => l.map((x, j) => (j === i ? { ...x, teamId: v || null } : x)))} />
                {targets.length > 1 && <ActionIcon variant="subtle" color="red" size="lg" aria-label={`${i + 1} 行目を削除`} onClick={() => setTargets((l) => l.filter((_, j) => j !== i))}>×</ActionIcon>}
              </Group>
            ))}
            <Button variant="subtle" size="compact-sm" w="fit-content" onClick={() => setTargets((l) => [...l, { memberType: null, teamId: null }])}>組み合わせを追加</Button>
          </Stack>
        )}
        <Checkbox label="重要なお知らせ（確認するまで画面上部に表示し、誰が確認したかを見られる）" checked={important && visibility !== 'public'}
          disabled={visibility === 'public'} onChange={(e) => setImportant(e.currentTarget.checked)}
          description={visibility === 'public' ? '重要なお知らせは、ログインした人か対象者向けにしてください' : undefined} />
        <Stack gap={6}>
          <Text size="sm" fw={500}>公開</Text>
          <SegmentedControl value={timing} onChange={(v) => setTiming(v as typeof timing)}
            data={[{ value: 'draft', label: '下書き' }, { value: 'now', label: alreadyPublished ? '公開中のまま' : '今すぐ公開' }, { value: 'at', label: '日時を指定' }]} />
          {timing === 'at' && <TextInput type="datetime-local" aria-label="公開する日時" value={at} onChange={(e) => setAt(e.currentTarget.value)} />}
        </Stack>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>やめる</Button>
          <Button onClick={save} disabled={!title || !body || (timing === 'at' && !at)}>
            {timing === 'draft' ? '下書きを保存' : timing === 'at' ? '公開を予約' : alreadyPublished ? '更新する' : '公開する'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ConfirmationsDialog({ a, onClose }: { a: Ann; onClose: () => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; memberType: string; confirmedAt: string | null }[] | null>(null);
  const load = useCallback(() => api<{ people: NonNullable<typeof people> }>('GET', `/api/admin/announcements/${a.id}/confirmations`).then((r) => setPeople(r.people)).catch(fail), [a.id]);
  useEffect(() => { void load(); }, [load]);
  const remind = async () => {
    try { const r = await api<{ reminded: number }>('POST', `/api/admin/announcements/${a.id}/remind`); done(`未確認の ${r.reminded} 人に Discord で再通知しました`); } catch (e) { fail(e); }
  };
  const unconfirmed = people?.filter((p) => !p.confirmedAt) ?? [];
  return (
    <Modal opened onClose={onClose} title={`確認状況：${a.title}`} size="lg">
      {!people ? <Loader /> : (
        <Stack>
          <Group justify="space-between">
            <Text fw={700}>確認済み {people.length - unconfirmed.length} / {people.length} 人</Text>
            <Button disabled={!unconfirmed.length} onClick={remind}>未確認の人に再通知</Button>
          </Group>
          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing="xs">
              <Table.Thead><Table.Tr><Table.Th>名前</Table.Th><Table.Th>立場</Table.Th><Table.Th>確認</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {people.map((p) => (
                  <Table.Tr key={p.id}><Table.Td>{p.name}</Table.Td><Table.Td>{MEMBER_TYPE[p.memberType]}</Table.Td>
                    <Table.Td>{p.confirmedAt ? <Text size="sm" c="green.8">{showDateTime(p.confirmedAt)}</Text> : <Badge color="orange" variant="light">未確認</Badge>}</Table.Td></Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}
    </Modal>
  );
}

// ---------------- 案内ページ ----------------
const PAGES = [
  { kind: 'about', label: 'はじめに', superOnly: true, path: '/about' },
  { kind: 'overview', label: '大会概要（その他の欄）', superOnly: true, path: '/overview' },
  { kind: 'rules', label: 'ルールブック', superOnly: false, path: '/rules' },
  { kind: 'privacy', label: 'プライバシーポリシー', superOnly: true, path: '/privacy' },
];

function PagesTab({ adminLevel }: { adminLevel: 'sub' | 'super' }) {
  const [kind, setKind] = useState('rules');
  const [body, setBody] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const page = PAGES.find((p) => p.kind === kind)!;
  const canEdit = adminLevel === 'super' || !page.superOnly;
  useEffect(() => {
    setBody(null);
    api<{ page: { version?: number; body: string } | null }>('GET', `/api/pages/${kind}`)
      .then((r) => { setVersion(r.page?.version ?? null); setBody(r.page?.body ?? (kind === 'privacy' ? PRIVACY_TEMPLATE : '')); })
      .catch(() => { setVersion(null); setBody(''); });
  }, [kind]);
  const save = async () => {
    try { const r = await api<{ version: number }>('PUT', `/api/admin/pages/${kind}`, { body }); setVersion(r.version); done(`${page.label}を保存しました（第 ${r.version} 版）`); } catch (e) { fail(e); }
  };
  return (
    <Stack gap="md" maw={880}>
      <Group align="flex-end" gap="sm">
        <Select label="編集するページ" value={kind} onChange={(v) => v && setKind(v)} allowDeselect={false} w={260} data={PAGES.map((p) => ({ value: p.kind, label: p.label }))} />
        <Text size="sm" c="var(--muted)" pb={8}>{version ? `公開中：第 ${version} 版` : 'まだ公開していません'}</Text>
        <Button component="a" href={page.path} target="_blank" variant="subtle" size="compact-sm" mb={6}>公開ページを見る</Button>
      </Group>
      {kind === 'rules' && <Text size="sm" c="var(--muted)">保存するたびに新しい版として残り、参加者は過去の版も見られます。内容を変えたら、重要なお知らせで参加者に知らせてください。</Text>}
      {kind === 'privacy' && version === null && <Card className="admin-only"><Text size="sm">現在の内容は、このシステムのデータの扱いに合わせたひな形です。[大会名] などを書き換え、内容を確認してから保存してください。</Text></Card>}
      {!canEdit && <Text size="sm" c="orange.9">このページを編集できるのは全体管理者だけです。</Text>}
      {body === null ? <Loader /> : (
        <Textarea aria-label={`${page.label}の本文`} value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={14} maxLength={20000} disabled={!canEdit}
          description="改行はそのまま表示されます" />
      )}
      {canEdit && <Button onClick={save} w="fit-content" disabled={!body}>保存する</Button>}
    </Stack>
  );
}

// ---------------- 公式リンク ----------------
interface Link { kind: 'x' | 'stream' | 'other'; label: string; url: string }
function LinksTab() {
  const [links, setLinks] = useState<Link[] | null>(null);
  useEffect(() => { api<{ officialLinks: Link[] }>('GET', '/api/pages/about').then((r) => setLinks(r.officialLinks)).catch(() => setLinks([])); }, []);
  if (!links) return <Loader />;
  const save = async () => { try { await api('PUT', '/api/admin/official-links', { links }); done('公式リンクを保存しました'); } catch (e) { fail(e); } };
  return (
    <Stack gap="sm" maw={880}>
      <Text size="sm" c="var(--muted)">「はじめに」の公式リンクに表示されます（5 件まで、https の URL のみ）。</Text>
      {links.map((l, i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
          <Select label={i === 0 ? '種類' : undefined} aria-label="種類" value={l.kind} w={140} allowDeselect={false}
            data={[{ value: 'x', label: 'X' }, { value: 'stream', label: '配信' }, { value: 'other', label: 'その他' }]}
            onChange={(v) => setLinks((s) => s!.map((x, j) => (j === i ? { ...x, kind: v as Link['kind'] } : x)))} />
          <TextInput label={i === 0 ? '表示名' : undefined} aria-label="表示名" value={l.label} w={200} maxLength={30} onChange={(e) => { const v = e.currentTarget.value; setLinks((s) => s!.map((x, j) => (j === i ? { ...x, label: v } : x))); }} />
          <TextInput label={i === 0 ? 'URL' : undefined} aria-label="URL" value={l.url} style={{ flex: 1 }} placeholder="https://" onChange={(e) => { const v = e.currentTarget.value; setLinks((s) => s!.map((x, j) => (j === i ? { ...x, url: v } : x))); }} />
          <ActionIcon variant="subtle" color="red" size="lg" aria-label={`${l.label || i + 1}を削除`} onClick={() => setLinks((s) => s!.filter((_, j) => j !== i))}>×</ActionIcon>
        </Group>
      ))}
      <Group>
        <Button variant="default" disabled={links.length >= 5} onClick={() => setLinks((s) => [...s!, { kind: 'x', label: '', url: '' }])}>リンクを追加</Button>
        <Button onClick={save}>保存する</Button>
      </Group>
    </Stack>
  );
}
