import { Anchor, Box, Burger, Button, Container, Drawer, Group, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link, NavLink, Outlet } from 'react-router';
import { ImportantBanner } from './ImportantBanner';
import { DevSwitcher } from './DevSwitcher';
import { api } from '../api';
import { useSession } from '../session';

const linkStyle = ({ isActive }: { isActive: boolean }) => ({
  padding: '8px 10px', borderRadius: 6, whiteSpace: 'nowrap' as const, textDecoration: 'none', fontWeight: isActive ? 700 : 400,
  color: isActive ? '#1b3fa0' : '#3d4350', background: isActive ? '#e8eefc' : 'transparent',
});

export function UserLayout() {
  const { me } = useSession();
  const [open, { toggle, close }] = useDisclosure(false);
  const nav = (
    <>
      <NavLink to="/" end style={linkStyle} onClick={close}>TOP</NavLink>
      <NavLink to="/about" style={linkStyle} onClick={close}>はじめに</NavLink>
      <NavLink to="/overview" style={linkStyle} onClick={close}>大会概要</NavLink>
      <NavLink to="/news" style={linkStyle} onClick={close}>お知らせ</NavLink>
      <NavLink to="/participants" style={linkStyle} onClick={close}>参加者</NavLink>
      {me?.loggedIn && <NavLink to="/rules" style={linkStyle} onClick={close}>ルールブック</NavLink>}
      {me?.loggedIn && <NavLink to="/inquiries" style={linkStyle} onClick={close}>問い合わせ</NavLink>}
    </>
  );
  // 大会の参加者・運営だけのメニュー（2 段目）。ページの移動だけを並べ、別タブで開くツールは右端に分ける
  const isParticipant = Boolean(me?.user?.membership || me?.user?.isAdmin);
  const isCoach = me?.user?.membership?.memberType === 'coach';
  const showDraft = Boolean(me?.draftOpen && (isCoach || me?.user?.isAdmin));
  const memberNav = isParticipant ? (
    me?.tournamentActive ? (
      <>
        <NavLink to="/schedule" style={linkStyle} onClick={close}>予定表</NavLink>
        <NavLink to="/scrims" style={linkStyle} onClick={close}>スクリム</NavLink>
        <NavLink to="/fill" style={linkStyle} onClick={close}>人員補充</NavLink>
        {me?.user?.membership?.teamId && (me.user.membership.memberType === 'player' || isCoach) && <NavLink to="/team" style={linkStyle} onClick={close}>チームページ</NavLink>}
      </>
    ) : <Text size="sm" c="var(--muted)" px={8}>（開催中の大会がありません）</Text>
  ) : null;
  const toolStyle = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', border: '1px solid #c3cad5', borderRadius: 999, color: '#1a1d23', textDecoration: 'none', fontSize: 13, whiteSpace: 'nowrap' as const };
  const tools = (
    <>
      <a href="/tools/lanes/" target="_blank" rel="noopener" style={toolStyle} onClick={close}>適性レーン ↗</a>
      {isCoach && showDraft && <a href="/draft" target="_blank" rel="noopener" style={toolStyle} onClick={close}>ドラフト ↗</a>}
    </>
  );
  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => {});
    window.location.href = '/';
  };
  // 右側：アカウントまわり（名前を押すとマイページ）
  const account = me?.loggedIn ? (
    <Group gap="sm" wrap="nowrap">
      {me.user?.isAdmin && <NavLink to="/admin" style={linkStyle} onClick={close}>管理者画面</NavLink>}
      <NavLink to="/me" style={({ isActive }) => ({ ...linkStyle({ isActive }), whiteSpace: 'nowrap', fontWeight: 700, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block' })}
        onClick={close} aria-label={`マイページ（${me.user?.displayName}）`} title={me.user?.displayName}>
        {me.user?.displayName}
      </NavLink>
      <Button variant="default" size="xs" onClick={logout} style={{ flex: 'none' }}>ログアウト</Button>
    </Group>
  ) : (
    <Button component="a" href="/auth/login" style={{ flex: 'none' }}>Discord でログイン</Button>
  );
  return (
    <Box mih="100vh">
      <Box component="header" bg="white" style={{ borderBottom: '1px solid var(--line)' }}>
        <Container size="lg" py={10}>
          <Group justify="space-between" wrap="nowrap">
            <Anchor href="/" c="dark" fw={700} underline="never" style={{ whiteSpace: 'nowrap', flex: 'none' }}>Vout 大会ポータル</Anchor>
            <Group gap={2} visibleFrom="lg" component="nav" aria-label="メインメニュー" wrap="nowrap">{nav}</Group>
            <Box visibleFrom="lg">{account}</Box>
            <Burger hiddenFrom="lg" opened={open} onClick={toggle} aria-label="メニューを開く" />
          </Group>
        </Container>
        {isParticipant && (
          <Box visibleFrom="lg" style={{ borderTop: '1px solid var(--line)', background: '#fafbfc' }}>
            <Container size="lg" py={4}>
              <Group gap={2} wrap="nowrap" justify="space-between">
                <Group gap={2} component="nav" aria-label="大会メニュー" wrap="nowrap">
                  <Text size="xs" c="var(--muted)" mr="xs" fw={700}>大会メニュー</Text>
                  {memberNav ?? <Text size="sm" c="var(--muted)">（開催中の大会がありません）</Text>}
                </Group>
                <Group gap={6} aria-label="ツール" role="group" wrap="nowrap">{tools}</Group>
              </Group>
            </Container>
          </Box>
        )}
      </Box>
      <Drawer opened={open} onClose={close} title="メニュー" position="right" hiddenFrom="lg">
        <Stack component="nav" aria-label="メインメニュー" gap={4}>{nav}
          {memberNav && <><Text size="xs" c="var(--muted)" fw={700} mt="sm">大会メニュー</Text>{memberNav}</>}
          <Text size="xs" c="var(--muted)" fw={700} mt="sm">ツール</Text>
          <Group gap={6}>{tools}</Group>
          <Text size="xs" c="var(--muted)" fw={700} mt="sm">ツール</Text><Group gap={6}>{tools}</Group>
          <Box mt="md">{account}</Box></Stack>
      </Drawer>
      {me?.preview !== undefined && me?.preview !== null && (
        <Box role="status" style={{ background: '#2148b8', color: '#fff' }}>
          <Container size="lg" py={8}><Group justify="space-between">
            <Text size="sm" fw={700}>プレビュー中：{me.preview.memberType ? { player: '選手', coach: 'コーチ', staff: '補助スタッフ' }[me.preview.memberType] : '登録済み閲覧者'}として表示しています。操作はできません。</Text>
            <Button size="compact-xs" variant="white" onClick={async () => { await api('POST', '/api/preview/stop'); window.location.href = '/admin'; }}>プレビューを終了</Button>
          </Group></Container>
        </Box>
      )}
      {isCoach && showDraft && (
        <Box role="status" style={{ background: '#fff6d6', borderBottom: '1px solid #f0d38a' }}>
          <Container size="lg" py={8}><Group justify="space-between">
            <Text size="sm" fw={700} c="#6b4e00">ドラフトの期間です。ドラフトの画面から参加してください。</Text>
            <Button size="compact-sm" component="a" href="/draft" target="_blank" rel="noopener">ドラフト画面を開く ↗</Button>
          </Group></Container>
        </Box>
      )}
      <ImportantBanner />
      <Container size="lg" py="xl" component="main"><Outlet /></Container>
      <Box component="footer" py="lg" style={{ borderTop: '1px solid var(--line)' }}>
        <Container size="lg"><Group gap="lg">
          <Anchor component={Link} to="/privacy" size="sm" c="var(--muted)">プライバシーポリシー</Anchor>
          <Anchor href="/tools/lanes/" target="_blank" rel="noopener" size="sm" c="var(--muted)">適性レーン ↗</Anchor>
        </Group></Container>
      </Box>
      <DevSwitcher />
    </Box>
  );
}
