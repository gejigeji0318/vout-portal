import { Anchor, Box, Container, Group, Loader, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { api } from '../api';
import { ADMIN_LEVEL } from '../labels';
import { useSession } from '../session';

const linkStyle = ({ isActive }: { isActive: boolean }) => ({
  padding: '8px 12px', borderRadius: 6, textDecoration: 'none', color: isActive ? '#fff' : '#d5d9e0',
  fontWeight: isActive ? 700 : 400, background: isActive ? '#343a46' : 'transparent',
});

export interface AdminContext { adminLevel: 'sub' | 'super' }

/** 管理者画面の枠。暗い帯で「管理者画面にいる」ことが一目で分かるようにする */
export function AdminLayout() {
  const { me } = useSession();
  const [level, setLevel] = useState<'sub' | 'super' | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    api<{ adminLevel: 'sub' | 'super' }>('GET', '/api/admin/me').then((r) => setLevel(r.adminLevel)).catch(() => setDenied(true));
  }, []);
  if (me && !me.loggedIn) return <Navigate to="/" replace />;
  if (denied) return <Container py="xl"><Text>この画面を見る権限がありません。</Text></Container>;
  if (!level) return <Container py="xl"><Loader /></Container>;
  return (
    <Box mih="100vh">
      <Box component="header" bg="var(--admin-bar)" c="white">
        <Container size="xl" py={10}>
          <Group justify="space-between">
            <Group gap="lg">
              <Text fw={700}>Vout 大会ポータル 管理</Text>
              <Group gap={4} component="nav" aria-label="管理メニュー">
                <NavLink to="/admin" end style={linkStyle}>大会・メンバー管理</NavLink>
                <NavLink to="/admin/content" style={linkStyle}>お知らせ・ページ・ツール</NavLink>
                <a href="/admin/draft" target="_blank" rel="noopener" style={linkStyle({ isActive: false })}>ドラフト進行 ↗</a>
                {level === 'super' && <NavLink to="/admin/system" style={linkStyle}>システム設定</NavLink>}
              </Group>
            </Group>
            <Group gap="md">
              <Text size="sm" c="#d5d9e0">{me?.user?.displayName}（{ADMIN_LEVEL[level]}）</Text>
              <Anchor href="/" c="#d5d9e0" size="sm">ポータルに戻る</Anchor>
            </Group>
          </Group>
        </Container>
      </Box>
      <Container size="xl" py="xl" component="main"><Outlet context={{ adminLevel: level } satisfies AdminContext} /></Container>
    </Box>
  );
}
