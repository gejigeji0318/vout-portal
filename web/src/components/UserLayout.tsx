import { Anchor, Box, Burger, Button, Container, Drawer, Group, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link, NavLink, Outlet } from 'react-router';
import { ImportantBanner } from './ImportantBanner';
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
      {me?.loggedIn && <NavLink to="/rules" style={linkStyle} onClick={close}>ルールブック</NavLink>}
      <a href="/tools/lanes/" target="_blank" rel="noopener" style={linkStyle({ isActive: false })} onClick={close}>適性レーン ↗</a>
      {me?.loggedIn && <NavLink to="/inquiries" style={linkStyle} onClick={close}>問い合わせ</NavLink>}
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
      <NavLink to="/me" style={({ isActive }) => ({ ...linkStyle({ isActive }), whiteSpace: 'nowrap', fontWeight: 700 })} onClick={close} aria-label={`マイページ（${me.user?.displayName}）`}>
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
      </Box>
      <Drawer opened={open} onClose={close} title="メニュー" position="right" hiddenFrom="lg">
        <Stack component="nav" aria-label="メインメニュー" gap={4}>{nav}<Box mt="md">{account}</Box></Stack>
      </Drawer>
      <ImportantBanner />
      <Container size="lg" py="xl" component="main"><Outlet /></Container>
      <Box component="footer" py="lg" style={{ borderTop: '1px solid var(--line)' }}>
        <Container size="lg"><Anchor component={Link} to="/privacy" size="sm" c="var(--muted)">プライバシーポリシー</Anchor></Container>
      </Box>
    </Box>
  );
}
