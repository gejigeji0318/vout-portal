import { ActionIcon, Badge, Box, Button, Card, Checkbox, Group, Image, Loader, Modal, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, ApiError, apiUpload } from '../api';
import { BodyText } from '../components/BodyText';
import { ImageCropper } from '../components/ImageCropper';
import { ACCEPT_IMAGES, loadBitmap, MAX_SOURCE_BYTES } from '../imageTools';
import { APEX_TIERS, APPLY_LANES, APPLY_STATUS, DIVISION_TIERS, DIVISIONS, joinRank, MEMBER_TYPE, showDateTime, splitRank } from '../labels';
import { useSession } from '../session';
import { opggUrlError, streamUrlError, xAccountError } from '../validators';

interface Recruitment { tournamentName: string; body: string; kinds: string[]; opensAt: string; closesAt: string; open: boolean; checks: { id: string; label: string }[] }
interface Mine { staffEditedAt?: string | null; kind: string; opggUrl: string; rank: string | null; mainLane: string | null; secondLane: string | null; xAccount: string | null; streamUrls: string[]; photoUrl: string | null }
const fail = (e: unknown) => notifications.show({ color: 'red', title: '送れませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });

/** SC-07 応募：募集要項・応募フォーム・応募状況 */
export function EntryPage() {
  const { me } = useSession();
  const [rec, setRec] = useState<Recruitment | null | undefined>(undefined);
  const [status, setStatus] = useState<string>('none');
  const [mine, setMine] = useState<Mine | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => {
    const r = await api<{ recruitment: Recruitment | null; myStatus: string | null }>('GET', '/api/recruitment').catch(() => ({ recruitment: null, myStatus: null }));
    setRec(r.recruitment);
    if (me?.loggedIn && !me.user?.isAdmin) {
      const m = await api<{ status: string; application: Mine | null }>('GET', '/api/applications/mine').catch(() => ({ status: 'none', application: null }));
      setStatus(m.status); setMine(m.application);
    }
  }, [me?.loggedIn, me?.user?.isAdmin]);
  useEffect(() => { if (me) void load(); }, [me, load]);
  if (!me || rec === undefined) return <Loader />;
  if (!rec) return <Stack><Title order={1}>大会に応募</Title><Text>現在、募集はありません。</Text></Stack>;
  const st = APPLY_STATUS[status]!;
  return (
    <Stack gap="lg" maw={760}>
      <div>
        <Title order={1}>大会に応募</Title>
        <Text size="sm" c="var(--muted)">{rec.tournamentName}・受付期間 {showDateTime(rec.opensAt)}〜{showDateTime(rec.closesAt)}{rec.open ? '' : '（受付期間外）'}</Text>
      </div>
      <Card withBorder padding="lg"><Title order={2} size="h4" mb="xs">募集要項</Title><BodyText>{rec.body}</BodyText></Card>

      {!me.loggedIn && (
        <Card withBorder padding="lg"><Text mb="sm">応募には Discord でのログインが必要です。</Text><Button component="a" href="/auth/login" w="fit-content">Discord でログインして応募する</Button></Card>
      )}
      {me.loggedIn && me.user?.isAdmin && <Text c="var(--muted)">運営は応募できません。</Text>}

      {me.loggedIn && !me.user?.isAdmin && status !== 'none' && (
        <Card withBorder padding="lg">
          <Group justify="space-between" mb="xs"><Title order={2} size="h4">応募状況</Title><Badge color={st.color} size="lg" variant="light">{st.label}</Badge></Group>
          <Steps status={status} />
          <Text size="sm" mt="sm">{st.note}</Text>
          {mine && !editing && <Summary mine={mine} />}
          {status === 'submitted' && rec.open && !editing && <WithdrawOrEdit onEdit={() => setEditing(true)} onWithdrawn={load} />}
        </Card>
      )}

      {me.loggedIn && !me.user?.isAdmin && rec.open && (status === 'none' || (status === 'submitted' && editing)) && (
        <EntryForm rec={rec} initial={editing ? mine : null} onDone={() => { setEditing(false); void load(); }} onCancel={editing ? () => setEditing(false) : undefined} />
      )}
      {me.loggedIn && !me.user?.isAdmin && !rec.open && status === 'none' && <Text c="var(--muted)">受付期間外のため、応募できません。</Text>}
    </Stack>
  );
}

function Steps({ status }: { status: string }) {
  const steps = ['応募済み', '選考中', '結果'];
  const idx = status === 'submitted' ? 0 : status === 'selecting' ? 1 : 2;
  return (
    <Box component="ol" aria-label="選考の流れ" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: 0, margin: 0, listStyle: 'none' }}>
      {steps.map((s, i) => (
        <li key={s} aria-current={i === idx ? 'step' : undefined} style={{ textAlign: 'center', padding: '8px 4px', borderRadius: 8, fontSize: 13,
          background: i === idx ? '#2148b8' : i < idx ? '#ddf0e5' : '#fff', color: i === idx ? '#fff' : '#1a1d23', border: '1px solid #dde1e7', fontWeight: i <= idx ? 700 : 400 }}>{s}</li>
      ))}
    </Box>
  );
}

function Summary({ mine }: { mine: Mine }) {
  const rows: [string, string][] = [
    ['区分', MEMBER_TYPE[mine.kind] ?? mine.kind], ['ランク', mine.rank ?? '—'], ['得意レーン', mine.mainLane ?? '—'], ['セカンド', mine.secondLane ?? '—'],
    ['OP.GG', mine.opggUrl], ['X', mine.xAccount ? `@${mine.xAccount}` : '—'], ['配信', mine.streamUrls.join('\n') || '—'],
  ];
  return (
    <>
    {mine.staffEditedAt && <Text size="sm" c="orange.9" mt="md">{showDateTime(mine.staffEditedAt)} に運営が内容を修正しました（書き間違いの修正など）。気になる点があれば問い合わせからご連絡ください。</Text>}
    <Group align="flex-start" mt="md" gap="lg" wrap="nowrap">
      {mine.photoUrl && <Image src={mine.photoUrl} alt="宣材写真" w={96} h={96} radius="md" />}
      <Box component="dl" style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '4px 12px', margin: 0, fontSize: 14, minWidth: 0 }}>
        {rows.map(([k, v]) => <Fragment key={k}><dt style={{ color: 'var(--muted)' }}>{k}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v}</dd></Fragment>)}
      </Box>
    </Group>
    </>
  );
}

function WithdrawOrEdit({ onEdit, onWithdrawn }: { onEdit: () => void; onWithdrawn: () => void }) {
  const [opened, { open, close }] = useDisclosure(false);
  const withdraw = async () => {
    try { await api('DELETE', '/api/applications/mine'); notifications.show({ color: 'green', message: '応募を取り下げました' }); close(); onWithdrawn(); } catch (e) { fail(e); }
  };
  return (
    <Group mt="md">
      <Button variant="default" onClick={onEdit}>内容を修正</Button>
      <Button variant="subtle" color="red" onClick={open}>取り下げる</Button>
      <Modal opened={opened} onClose={close} title="応募を取り下げますか？">
        <Text mb="lg">応募の内容と宣材写真はすぐに削除されます。受付期間中なら、もう一度応募できます。</Text>
        <Group justify="flex-end"><Button variant="default" onClick={close}>やめる</Button><Button color="red" onClick={withdraw}>取り下げる</Button></Group>
      </Modal>
    </Group>
  );
}

function EntryForm({ rec, initial, onDone, onCancel }: { rec: Recruitment; initial: Mine | null; onDone: () => void; onCancel?: () => void }) {
  const [kind, setKind] = useState(initial?.kind ?? rec.kinds[0]!);
  const [opgg, setOpgg] = useState(initial?.opggUrl ?? '');
  const [tier, setTier] = useState<string | null>(splitRank(initial?.rank).tier);
  const [division, setDivision] = useState<string | null>(splitRank(initial?.rank).division);
  const rank = joinRank(tier, division);
  const needsDivision = Boolean(tier && !APEX_TIERS.includes(tier));
  const [main, setMain] = useState<string | null>(initial?.mainLane ?? null);
  const [second, setSecond] = useState<string | null>(initial?.secondLane ?? null);
  const [x, setX] = useState(initial?.xAccount ?? '');
  const [streams, setStreams] = useState<string[]>(initial?.streamUrls.length ? initial.streamUrls : ['']);
  const [agreed, setAgreed] = useState<string[]>(initial ? rec.checks.map((c) => c.id) : []);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [cropping, setCropping] = useState<ImageBitmap | null>(null);
  const [busy, setBusy] = useState(false);
  const isPlayer = kind === 'player';
  const choose = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_SOURCE_BYTES) { fail(new ApiError(422, 'too_large', '画像が大きすぎます（20MB まで）')); return; }
    try { setCropping(await loadBitmap(file)); } catch { fail(new ApiError(422, 'invalid', 'この画像は使えません。PNG・JPEG・WebP の画像を選んでください')); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      let photoId: string | undefined;
      if (photo) photoId = (await apiUpload<{ photoId: string }>('/api/applications/photo', photo.blob, 'photo.webp')).photoId;
      const body = { kind, opggUrl: opgg, rank, mainLane: main, secondLane: main === 'ALL' ? second || null : second, xAccount: x || null,
        streamUrls: streams.map((s) => s.trim()).filter(Boolean), agreedCheckIds: agreed, ...(photoId ? { photoId } : {}) };
      await api(initial ? 'PUT' : 'POST', initial ? '/api/applications/mine' : '/api/applications', body);
      notifications.show({ color: 'green', message: initial ? '応募内容を修正しました' : '応募しました' });
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const laneData = APPLY_LANES.map((l) => ({ value: l, label: l }));
  const req = (on: boolean) => (on ? ' ' : '（任意）');
  const hasError = Boolean(opggUrlError(opgg) || xAccountError(x) || streams.some((u) => streamUrlError(u)));
  const canSubmit = !hasError && opgg && (initial || photo) && agreed.length === rec.checks.length && (!needsDivision || division) && (!isPlayer || (rank && main && (main === 'ALL' || second)));
  return (
    <Card withBorder padding="lg">
      <Title order={2} size="h4" mb="md">{initial ? '応募内容を修正' : '応募フォーム'}</Title>
      <Stack gap="md">
        {rec.kinds.length > 1 && <Select label="応募区分" value={kind} onChange={(v) => v && setKind(v)} allowDeselect={false} data={rec.kinds.map((k) => ({ value: k, label: MEMBER_TYPE[k]! }))} />}
        <TextInput label="OP.GG" withAsterisk value={opgg} onChange={(e) => setOpgg(e.currentTarget.value)} placeholder="https://op.gg/..." type="url" error={opggUrlError(opgg)} />
        <SimpleGrid cols={2}>
          <Select label={`ランク${req(isPlayer)}`} withAsterisk={isPlayer} value={tier} onChange={(v) => { setTier(v); if (!v || APEX_TIERS.includes(v)) setDivision(null); }}
            data={[...DIVISION_TIERS, ...APEX_TIERS]} clearable={!isPlayer} placeholder="選んでください" />
          {needsDivision && <Select label="区分" withAsterisk value={division} onChange={setDivision} data={DIVISIONS} allowDeselect={false} error={!division ? '区分を選んでください' : null} placeholder="Ⅰ〜Ⅳ" />}
        </SimpleGrid>
        <SimpleGrid cols={2}>
          <Select label={`得意レーン${req(isPlayer)}`} withAsterisk={isPlayer} value={main} onChange={(v) => { setMain(v); if (v === second) setSecond(null); }} data={laneData} clearable={!isPlayer} placeholder="選んでください" />
          <Select label={`セカンド${req(isPlayer && main !== 'ALL')}`} withAsterisk={isPlayer && main !== 'ALL'} value={second} onChange={setSecond} clearable
            data={laneData.map((l) => ({ ...l, disabled: l.value === main }))} placeholder="選んでください" description={main === 'ALL' ? 'ALL の場合は任意です' : undefined} />
        </SimpleGrid>
        <TextInput label="X アカウント（任意）" value={x} onChange={(e) => setX(e.currentTarget.value)} placeholder="@" maxLength={16} error={xAccountError(x)} />
        <Stack gap={6}>
          <Text size="sm" fw={500}>配信 URL（任意・3 件まで）</Text>
          {streams.map((u, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
              <TextInput aria-label={`配信 URL ${i + 1}`} value={u} placeholder="https://" style={{ flex: 1 }} error={streamUrlError(u)} onChange={(e) => { const v = e.currentTarget.value; setStreams((l) => l.map((s, j) => (j === i ? v : s))); }} />
              {streams.length > 1 && <ActionIcon variant="subtle" color="red" size="lg" aria-label={`配信 URL ${i + 1} を削除`} onClick={() => setStreams((l) => l.filter((_, j) => j !== i))}>×</ActionIcon>}
            </Group>
          ))}
          {streams.length < 3 && <Button variant="subtle" size="compact-sm" w="fit-content" onClick={() => setStreams((l) => [...l, ''])}>配信 URL を追加</Button>}
        </Stack>
        <Stack gap={6}>
          <Text size="sm" fw={500}>宣材写真 <Text span c="red">*</Text></Text>
          <Text size="xs" c="dimmed">ドラフトや参加者一覧のアイコンに使います。撮影場所などの情報は保存しません（PNG・JPEG・WebP）</Text>
          <Group gap="md">
            {(photo?.url || initial?.photoUrl) && <Image src={photo?.url ?? initial?.photoUrl ?? ''} alt="宣材写真のプレビュー" w={96} h={96} radius="md" />}
            <Button variant="default" component="label">
              {photo || initial ? '写真を変更' : '写真を選ぶ'}
              <input type="file" accept={ACCEPT_IMAGES} hidden onChange={(e) => { void choose(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ''; }} />
            </Button>
          </Group>
          <ImageCropper bitmap={cropping} round={false} outputSize={768} onCancel={() => { cropping?.close(); setCropping(null); }}
            onDone={(blob) => { cropping?.close(); setCropping(null); setPhoto({ blob, url: URL.createObjectURL(blob) }); }} />
        </Stack>
        <Checkbox.Group label="確認事項（すべて必須）" value={agreed} onChange={setAgreed}>
          <Stack gap="xs" mt="xs">{rec.checks.map((c) => <Checkbox key={c.id} value={c.id} label={c.label} />)}</Stack>
        </Checkbox.Group>
        <Group>
          {onCancel && <Button variant="default" onClick={onCancel}>やめる</Button>}
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>{initial ? '修正を保存' : '応募する'}</Button>
        </Group>
        {hasError && <Text size="sm" c="red.8">赤く表示された欄を直すと、送れるようになります。</Text>}
        {!initial && <Text size="xs" c="var(--muted)">締切までは、内容の修正・取り下げができます。</Text>}
      </Stack>
    </Card>
  );
}
