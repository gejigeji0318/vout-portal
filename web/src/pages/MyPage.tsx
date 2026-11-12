import { ActionIcon, Avatar, Button, Card, FileButton, Group, Modal, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { api, ApiError, apiUpload } from '../api';
import { ImageCropper } from '../components/ImageCropper';
import { ACCEPT_IMAGES, loadBitmap, MAX_SOURCE_BYTES } from '../imageTools';
import { MEMBER_TYPE } from '../labels';
import { useSession } from '../session';

const TIMES = Array.from({ length: 49 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const fail = (e: unknown) => notifications.show({ color: 'red', title: '保存できませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });

export function MyPage() {
  const { me, reload } = useSession();
  if (!me) return null;
  if (!me.loggedIn || !me.user) return <Navigate to="/" replace />;
  const u = me.user;
  const canWriteBio = u.isAdmin || u.membership?.memberType === 'staff';
  return (
    <Stack gap="xl" maw={720}>
      <Title order={1}>マイページ</Title>
      <ProfileCard key={`${u.displayName}${u.xAccount}${u.streamUrls.join()}${u.bio}`} canWriteBio={canWriteBio} onSaved={reload} />
      <TimePresetsCard initial={u.timePresets} onSaved={reload} />
      <Card withBorder padding="lg">
        <Title order={2} size="h4" mb="xs">大会での立場</Title>
        <Text>
          {u.membership
            ? `${MEMBER_TYPE[u.membership.memberType]}${u.membership.lane ? `（${u.membership.lane}）` : ''}`
            : u.isAdmin ? '運営' : '大会には参加していません（登録済み閲覧者）'}
        </Text>
      </Card>
      <LoginCard />
    </Stack>
  );
}

function ProfileCard({ canWriteBio, onSaved }: { canWriteBio: boolean; onSaved: () => Promise<void> }) {
  const u = useSession().me!.user!;
  const [displayName, setDisplayName] = useState(u.displayName === u.discordName ? '' : u.displayName);
  const [xAccount, setXAccount] = useState(u.xAccount ?? '');
  const [streamUrls, setStreamUrls] = useState<string[]>(u.streamUrls.length ? u.streamUrls : ['']);
  const [bio, setBio] = useState(u.bio ?? '');
  // アイコン：選んだ時点ではプレビューだけ。保存するを押したときに送る
  const [newIcon, setNewIcon] = useState<{ blob: Blob; url: string } | null>(null);
  const [removeIcon, setRemoveIcon] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cropping, setCropping] = useState<ImageBitmap | null>(null);
  useEffect(() => () => { if (newIcon) URL.revokeObjectURL(newIcon.url); }, [newIcon]);

  const choose = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_SOURCE_BYTES) { fail(new ApiError(422, 'too_large', '画像が大きすぎます（20MB まで）')); return; }
    try {
      setCropping(await loadBitmap(file)); // 範囲を決める画面を開く
    } catch {
      fail(new ApiError(422, 'invalid_image', 'この画像は使えません。PNG・JPEG・WebP の画像を選んでください'));
    }
  };
  const shownIcon = newIcon?.url ?? (removeIcon ? null : u.iconUrl);
  const iconChanged = Boolean(newIcon) || removeIcon;

  const save = async () => {
    setSaving(true);
    try {
      await api('PATCH', '/api/me', { displayName: displayName || null, xAccount: xAccount || null, streamUrls: streamUrls.map((x) => x.trim()).filter(Boolean), ...(canWriteBio ? { bio: bio || null } : {}) });
      if (newIcon) await apiUpload('/api/me/icon', newIcon.blob, 'icon.webp');
      else if (removeIcon) await api('DELETE', '/api/me/icon');
      setNewIcon(null);
      setRemoveIcon(false);
      notifications.show({ color: 'green', message: 'プロフィールを保存しました' });
      await onSaved();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb="md">プロフィール</Title>
      <Stack gap="md">
        {canWriteBio && (
          <Stack gap={6}>
            <Text fw={500} size="sm">アイコン</Text>
            <Text size="xs" c="dimmed" mt={-6}>「はじめに」の運営メンバー紹介に表示されます。表示する範囲は画像を選んだあとに調整できます。撮影場所などの情報は保存しません</Text>
            <Group gap="lg">
              <Avatar src={shownIcon} alt={`${u.displayName} のアイコン`} size={96} radius={96}>{u.displayName.slice(0, 1)}</Avatar>
              <Group gap="xs">
                <FileButton onChange={choose} accept={ACCEPT_IMAGES}>
                  {(props) => <Button {...props} variant="default">{shownIcon ? '画像を変更' : '画像を選ぶ'}</Button>}
                </FileButton>
                {shownIcon && <Button variant="subtle" color="red" onClick={() => { setNewIcon(null); setRemoveIcon(true); }}>削除</Button>}
              </Group>
            </Group>
            {iconChanged && <Text size="xs" c="orange.9">「保存する」を押すとアイコンが変わります</Text>}
            <ImageCropper bitmap={cropping} onCancel={() => { cropping?.close(); setCropping(null); }}
              onDone={(blob) => { cropping?.close(); setCropping(null); setNewIcon({ blob, url: URL.createObjectURL(blob) }); setRemoveIcon(false); }} />
          </Stack>
        )}
        <TextInput label="表示名" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} placeholder={u.discordName}
          description={`空にすると Discord の名前（${u.discordName}）を表示します。他の人と同じ名前や、運営と紛らわしい名前は使えません`} maxLength={20} />
        <TextInput label="X アカウント" value={xAccount} onChange={(e) => setXAccount(e.currentTarget.value)} placeholder="@" maxLength={16} />
        <Stack gap={6}>
          <Text component="label" fw={500} size="sm">配信 URL</Text>
          <Text size="xs" c="dimmed" mt={-6}>Twitch・YouTube などの配信ページ（3 件まで）</Text>
          {streamUrls.map((url, i) => (
            <Group key={i} gap="xs" wrap="nowrap">
              <TextInput aria-label={`配信 URL ${i + 1}`} value={url} placeholder="https://" type="url" style={{ flex: 1 }}
                onChange={(e) => { const v = e.currentTarget.value; setStreamUrls((l) => l.map((x, j) => (j === i ? v : x))); }} />
              {streamUrls.length > 1 && (
                <ActionIcon variant="subtle" color="red" size="lg" aria-label={`配信 URL ${i + 1} を削除`} onClick={() => setStreamUrls((l) => l.filter((_, j) => j !== i))}>×</ActionIcon>
              )}
            </Group>
          ))}
          {streamUrls.length < 3 && (
            <Button variant="subtle" size="compact-sm" w="fit-content" onClick={() => setStreamUrls((l) => [...l, ''])}>配信 URL を追加</Button>
          )}
        </Stack>
        {canWriteBio && (
          <Textarea label="紹介文" description="「はじめに」の運営メンバー紹介に表示されます" value={bio} onChange={(e) => setBio(e.currentTarget.value)} maxLength={300} autosize minRows={3} />
        )}
        <Button onClick={save} loading={saving} w="fit-content">保存する</Button>
      </Stack>
    </Card>
  );
}

interface Preset { label: string; start: string; end: string }

function TimePresetsCard({ initial, onSaved }: { initial: Preset[]; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<Preset[]>(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setRows(initial), [initial]);
  const update = (i: number, patch: Partial<Preset>) => setRows((r) => r.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const save = async () => {
    setSaving(true);
    try {
      await api('PATCH', '/api/me', { timePresets: rows });
      notifications.show({ color: 'green', message: 'よく使う時間を保存しました' });
      await onSaved();
    } catch (e) { fail(e); } finally { setSaving(false); }
  };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb={4}>よく使う時間</Title>
      <Text size="sm" c="var(--muted)" mb="md">予定表の入力で、ワンタップで入れられる時間です（5 件まで、30 分刻み）。</Text>
      <Stack gap="sm">
        {rows.length === 0 && <Text size="sm" c="var(--muted)">まだ登録していません。</Text>}
        {rows.map((p, i) => (
          <Group key={i} gap="xs" align="flex-end" wrap="wrap">
            <TextInput label={i === 0 ? '名前' : undefined} aria-label="名前" value={p.label} onChange={(e) => update(i, { label: e.currentTarget.value })} placeholder="平日夜" maxLength={10} w={140} />
            <Select label={i === 0 ? '開始' : undefined} aria-label="開始" data={TIMES.slice(0, -1)} value={p.start} onChange={(v) => v && update(i, { start: v })} w={110} allowDeselect={false} />
            <Select label={i === 0 ? '終了' : undefined} aria-label="終了" data={TIMES.slice(1)} value={p.end} onChange={(v) => v && update(i, { end: v })} w={110} allowDeselect={false} />
            <ActionIcon variant="subtle" color="red" size="lg" aria-label={`${p.label || 'この行'}を削除`} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>×</ActionIcon>
          </Group>
        ))}
        <Group>
          <Button variant="default" disabled={rows.length >= 5} onClick={() => setRows((r) => [...r, { label: '', start: '20:00', end: '24:00' }])}>時間を追加</Button>
          <Button onClick={save} loading={saving}>保存する</Button>
        </Group>
      </Stack>
    </Card>
  );
}

function LoginCard() {
  const [opened, { open, close }] = useDisclosure(false);
  const logoutAll = async () => {
    try {
      await api('POST', '/auth/logout-all');
      window.location.href = '/';
    } catch (e) { fail(e); }
  };
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb={4}>ログイン中の端末</Title>
      <Text size="sm" c="var(--muted)" mb="md">スマホを無くしたときなど、他の端末でログインしたままにしたくない場合に使います。</Text>
      <Button variant="default" color="red" onClick={open} w="fit-content">すべての端末からログアウト</Button>
      <Modal opened={opened} onClose={close} title="すべての端末からログアウトしますか？">
        <Text mb="lg">この端末も含めて、ログインしているすべての端末（PC・スマホなど）でログアウトされます。</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>やめる</Button>
          <Button color="red" onClick={logoutAll}>すべての端末からログアウト</Button>
        </Group>
      </Modal>
    </Card>
  );
}
