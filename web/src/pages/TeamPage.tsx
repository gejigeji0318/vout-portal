import { ActionIcon, Badge, Button, Card, Group, Image, Loader, Menu, Modal, SimpleGrid, Stack, Tabs, Text, Textarea, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError, apiUpload } from '../api';
import { ACCEPT_IMAGES, MAX_SOURCE_BYTES, shrinkImage } from '../imageTools';
import { showDateTime } from '../labels';

interface Info { team: { id: string; name: string; named: boolean; nameLocked: boolean }; isCoach: boolean; emojis: string[]; pages: { id: string; title: string }[]; deletedPages: { id: string; title: string; deletedAt: string }[] }
interface Post { id: string; body: string; createdAt: string; author: string; canDelete: boolean; images: string[]; reactions: { emoji: string; count: number; names: string[]; mine: boolean }[] }
const fail = (e: unknown) => notifications.show({ color: 'red', title: 'できませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });
const ok = (m: string) => notifications.show({ color: 'green', message: m });

/** SC-05 チームページ（F-08） */
export function TeamPage() {
  const [params] = useSearchParams();
  const teamQ = params.get('teamId') ? `?teamId=${params.get('teamId')}` : '';
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const load = useCallback(() => api<Info>('GET', `/api/team${teamQ}`).then((r) => { setInfo(r); setPageId((p) => (p && r.pages.some((x) => x.id === p) ? p : r.pages[0]?.id ?? null)); })
    .catch((e) => setError(e instanceof ApiError ? e.message : '表示できませんでした')), [teamQ]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <Stack><Title order={1}>チームページ</Title><Text>{error}</Text></Stack>;
  if (!info) return <Loader />;
  const call = async (method: string, path: string, body?: unknown, msg?: string) => { try { await api(method, `${path}${teamQ}`, body); if (msg) ok(msg); void load(); } catch (e) { fail(e); } };
  const addPage = async () => { const title = prompt('新しいページの名前（例：作戦、連絡、振り返り）'); if (title) await call('POST', '/api/team/pages', { title }, 'ページを追加しました'); };
  return (
    <Stack gap="lg" maw={900}>
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="sm" c="var(--muted)">チームページ（このチームの選手とコーチだけが見られます）</Text>
          <Group gap="xs"><Title order={1}>{info.team.name}</Title>
            {info.isCoach && !info.team.nameLocked && <Button size="compact-xs" variant="default" onClick={() => setRenaming(true)}>{info.team.named ? 'チーム名を変更' : 'チーム名を決める'}</Button>}
            {info.team.nameLocked && <Badge variant="light" color="gray">スクリム期間中は変更できません</Badge>}</Group>
        </div>
        {info.isCoach && <Button variant="default" onClick={addPage}>ページを追加</Button>}
      </Group>
      <Tabs value={pageId} onChange={setPageId}>
        <Tabs.List>
          {info.pages.map((p) => (
            <Tabs.Tab key={p.id} value={p.id} rightSection={info.isCoach && info.pages.length > 1 && pageId === p.id ? (
              <Menu position="bottom-end"><Menu.Target><ActionIcon size="xs" variant="subtle" component="span" aria-label={`${p.title}の操作`}>⋯</ActionIcon></Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={() => { const t = prompt('ページの名前', p.title); if (t) void call('PATCH', `/api/team/pages/${p.id}`, { title: t }, '名前を変えました'); }}>名前を変更</Menu.Item>
                  <Menu.Item color="red" onClick={() => call('DELETE', `/api/team/pages/${p.id}`, undefined, 'ページを削除しました（30 日以内なら戻せます）')}>削除</Menu.Item>
                </Menu.Dropdown></Menu>) : undefined}>{p.title}</Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
      {pageId && <Feed key={pageId} pageId={pageId} teamQ={teamQ} emojis={info.emojis} />}
      {info.deletedPages.length > 0 && (
        <Text size="sm" c="var(--muted)">削除したページ：{info.deletedPages.map((p) => (
          <Button key={p.id} size="compact-xs" variant="subtle" onClick={() => call('POST', `/api/team/pages/${p.id}/restore`, undefined, '元に戻しました')}>{p.title} を戻す</Button>
        ))}</Text>
      )}
      {renaming && <RenameTeam current={info.team.named ? info.team.name : ''} onClose={() => setRenaming(false)} onDone={() => { setRenaming(false); void load(); }} />}
    </Stack>
  );
}

function RenameTeam({ current, onClose, onDone }: { current: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(current);
  const save = async () => { try { await api('PUT', '/api/team/name', { name }); ok('チーム名を決めました'); onDone(); } catch (e) { fail(e); } };
  return (
    <Modal opened onClose={onClose} title="チーム名">
      <Stack><TextInput label="チーム名（30 文字まで）" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={30} />
        <Text size="xs" c="var(--muted)">スクリム期間に入ると変更できなくなります。チーム紹介や配信でも使われます。</Text>
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={save} disabled={!name.trim()}>保存</Button></Group></Stack>
    </Modal>
  );
}

function Feed({ pageId, teamQ, emojis }: { pageId: string; teamQ: string; emojis: string[] }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [body, setBody] = useState('');
  const [images, setImages] = useState<{ blob: Blob; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ posts: Post[] }>('GET', `/api/team/pages/${pageId}/posts${teamQ}`).then((r) => setPosts(r.posts)).catch(fail), [pageId, teamQ]);
  useEffect(() => { void load(); }, [load]);
  const attach = async (files: FileList | null) => {
    for (const f of Array.from(files ?? []).slice(0, 4 - images.length)) {
      if (f.size > MAX_SOURCE_BYTES) { fail(new ApiError(422, 'too_large', '画像が大きすぎます（20MB まで）')); continue; }
      try { const blob = await shrinkImage(f); setImages((x) => [...x, { blob, url: URL.createObjectURL(blob) }].slice(0, 4)); } catch { fail(new ApiError(422, 'invalid', 'この画像は使えません')); }
    }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const imageIds: string[] = [];
      for (const i of images) imageIds.push((await apiUpload<{ imageId: string }>(`/api/team/images${teamQ}`, i.blob, 'shot.webp')).imageId);
      await api('POST', `/api/team/pages/${pageId}/posts${teamQ}`, { body, imageIds });
      setBody(''); setImages([]); void load();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const react = async (postId: string, emoji: string) => { try { await api('POST', `/api/team/posts/${postId}/reactions${teamQ}`, { emoji }); void load(); } catch (e) { fail(e); } };
  const remove = async (postId: string) => { try { await api('DELETE', `/api/team/posts/${postId}${teamQ}`); void load(); } catch (e) { fail(e); } };
  return (
    <Stack gap="md">
      <Card withBorder padding="md">
        <Textarea aria-label="投稿する内容" placeholder="チームに共有したいこと" value={body} onChange={(e) => setBody(e.currentTarget.value)} autosize minRows={2} maxLength={2000} />
        {images.length > 0 && <Group gap="xs" mt="xs">{images.map((i, n) => <Image key={n} src={i.url} alt={`添付 ${n + 1}`} h={64} w="auto" radius="sm" onClick={() => setImages((x) => x.filter((_, j) => j !== n))} style={{ cursor: 'pointer' }} />)}</Group>}
        <Group justify="space-between" mt="xs">
          <Button variant="subtle" size="compact-sm" component="label" disabled={images.length >= 4}>画像を添付（4 枚まで）
            <input type="file" accept={ACCEPT_IMAGES} multiple hidden onChange={(e) => { void attach(e.currentTarget.files); e.currentTarget.value = ''; }} /></Button>
          <Button onClick={submit} loading={busy} disabled={!body.trim() && !images.length}>投稿</Button>
        </Group>
      </Card>
      {!posts ? <Loader /> : posts.length === 0 ? <Text c="var(--muted)">まだ投稿はありません。</Text> : posts.map((p) => (
        <Card key={p.id} withBorder padding="md">
          <Group justify="space-between" mb={4}><Text size="sm" fw={700}>{p.author}</Text>
            <Group gap="xs"><Text size="xs" c="var(--muted)">{showDateTime(p.createdAt)}</Text>{p.canDelete && <Button size="compact-xs" variant="subtle" color="red" onClick={() => remove(p.id)}>削除</Button>}</Group></Group>
          {p.body && <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{p.body}</Text>}
          {p.images.length > 0 && <SimpleGrid cols={{ base: 1, sm: Math.min(p.images.length, 2) }} mt="xs">{p.images.map((u, i) => <a key={i} href={u} target="_blank" rel="noopener"><Image src={u} alt={`${p.author} の画像 ${i + 1}`} radius="sm" /></a>)}</SimpleGrid>}
          <Group gap={4} mt="xs">
            {p.reactions.map((r) => (
              <Tooltip key={r.emoji} label={r.names.join('、')} withArrow>
                <Button size="compact-xs" variant={r.mine ? 'light' : 'default'} onClick={() => react(p.id, r.emoji)} aria-label={`${r.emoji} ${r.count}（${r.names.join('、')}）`}>{r.emoji} {r.count}</Button>
              </Tooltip>
            ))}
            <Menu><Menu.Target><Button size="compact-xs" variant="subtle" aria-label="リアクションを付ける">＋</Button></Menu.Target>
              <Menu.Dropdown><Group gap={2} p={4}>{emojis.map((e) => <ActionIcon key={e} variant="subtle" onClick={() => react(p.id, e)} aria-label={`${e} を付ける`}>{e}</ActionIcon>)}</Group></Menu.Dropdown></Menu>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
