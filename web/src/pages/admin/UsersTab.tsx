import { Badge, Button, Group, Loader, Menu, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { api, ApiError } from '../../api';
import type { AdminContext } from '../../components/AdminLayout';
import { ADMIN_LEVEL, LANES, MEMBER_TYPE, showDateTime, teamLabel } from '../../labels';
import { done, fail, type Team } from './shared';

interface UserRow {
  id: string; display_name: string; admin_level: string; last_login_at: string; suspended_at: string | null;
  member_type: string | null; team_id: string | null; lane: string | null; draft_role: string | null;
}

type Dialog = { kind: 'membership' | 'transfer' | 'suspend'; user: UserRow } | null;

export function UsersTab() {
  const { adminLevel } = useOutletContext<AdminContext>();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const load = useCallback(async () => {
    try {
      const [u, t] = await Promise.all([api<{ users: UserRow[] }>('GET', '/api/admin/users'), api<{ teams: Team[] }>('GET', '/api/admin/teams')]);
      setUsers(u.users); setTeams(t.teams);
    } catch (e) { fail(e); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const shown = useMemo(() => (users ?? []).filter((u) =>
    (!q || u.display_name.toLowerCase().includes(q.toLowerCase())) &&
    (!type || (type === 'none' ? !u.member_type && u.admin_level === 'none' : type === 'admin' ? u.admin_level !== 'none' : u.member_type === type)),
  ), [users, q, type]);
  if (!users) return <Loader />;
  const roleOf = (u: UserRow) => u.admin_level !== 'none' ? ADMIN_LEVEL[u.admin_level] : u.member_type ? MEMBER_TYPE[u.member_type] : '登録済み閲覧者';
  const closeAndReload = () => { setDialog(null); void load(); };
  return (
    <Stack gap="md">
      <Group gap="sm">
        <TextInput placeholder="名前で検索" aria-label="名前で検索" value={q} onChange={(e) => setQ(e.currentTarget.value)} w={240} />
        <Select placeholder="すべての立場" aria-label="立場で絞り込み" clearable value={type} onChange={setType} w={200}
          data={[{ value: 'player', label: '選手' }, { value: 'coach', label: 'コーチ' }, { value: 'staff', label: '補助スタッフ' }, { value: 'none', label: '登録済み閲覧者' }, { value: 'admin', label: '管理者' }]} />
        <Text size="sm" c="var(--muted)">{shown.length} 人</Text>
      </Group>
      <Table.ScrollContainer minWidth={760}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead><Table.Tr>
            <Table.Th>名前</Table.Th><Table.Th>立場</Table.Th><Table.Th>チーム</Table.Th><Table.Th>大会でのレーン</Table.Th><Table.Th>最後のログイン</Table.Th><Table.Th />
          </Table.Tr></Table.Thead>
          <Table.Tbody>
            {shown.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td><Group gap="xs">{u.display_name}{u.suspended_at && <Badge color="red" variant="light">利用停止中</Badge>}</Group></Table.Td>
                <Table.Td>{roleOf(u)}</Table.Td>
                <Table.Td>{teamLabel(teams, u.team_id)}</Table.Td>
                <Table.Td>{u.lane ?? '—'}</Table.Td>
                <Table.Td>{showDateTime(u.last_login_at)}</Table.Td>
                <Table.Td align="right">
                  {u.admin_level === 'none' && (
                    <Menu position="bottom-end">
                      <Menu.Target><Button size="xs" variant="default">操作</Button></Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item onClick={() => setDialog({ kind: 'membership', user: u })}>立場・チームを変更</Menu.Item>
                        <Menu.Item disabled={u.member_type !== 'player'} onClick={() => setDialog({ kind: 'transfer', user: u })}>チーム移動（移籍）</Menu.Item>
                        {adminLevel === 'super' && <Menu.Divider />}
                        {adminLevel === 'super' && (
                          <Menu.Item color="red" onClick={() => setDialog({ kind: 'suspend', user: u })}>{u.suspended_at ? '利用停止を解除' : '利用停止'}</Menu.Item>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {dialog?.kind === 'membership' && <MembershipDialog user={dialog.user} teams={teams} onClose={() => setDialog(null)} onDone={closeAndReload} />}
      {dialog?.kind === 'transfer' && <TransferDialog user={dialog.user} teams={teams} onClose={() => setDialog(null)} onDone={closeAndReload} />}
      {dialog?.kind === 'suspend' && <SuspendDialog user={dialog.user} onClose={() => setDialog(null)} onDone={closeAndReload} />}
    </Stack>
  );
}

const teamOptions = (teams: Team[]) => teams.map((t, i) => ({ value: t.id, label: t.name ?? `チーム ${i + 1}` }));
const laneOptions = LANES.map((l) => ({ value: l, label: l }));

function MembershipDialog({ user, teams, onClose, onDone }: { user: UserRow; teams: Team[]; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<string>(user.member_type ?? 'none');
  const [teamId, setTeamId] = useState<string | null>(user.team_id);
  const [lane, setLane] = useState<string | null>(user.lane);
  const [draftRole, setDraftRole] = useState<string | null>(user.draft_role);
  const save = async () => {
    try {
      await api('PUT', `/api/admin/users/${user.id}/membership`,
        type === 'none' ? { memberType: null } : { memberType: type, teamId: type === 'staff' ? null : teamId, lane, draftRole });
      done('立場・チームを変更しました');
      onDone();
    } catch (e) { fail(e); }
  };
  return (
    <Modal opened onClose={onClose} title={`${user.display_name} さんの立場・チーム`}>
      <Stack>
        <Select label="立場" value={type} onChange={(v) => v && setType(v)} allowDeselect={false}
          data={[{ value: 'none', label: '大会の参加者から外す（登録済み閲覧者）' }, { value: 'player', label: '選手' }, { value: 'coach', label: 'コーチ' }, { value: 'staff', label: '補助スタッフ' }]} />
        {(type === 'player' || type === 'coach') && <Select label="チーム" clearable value={teamId} onChange={setTeamId} data={teamOptions(teams)} placeholder="未定" />}
        {type === 'player' && (
          <Group grow>
            <Select label="ドラフト用ロール" clearable value={draftRole} onChange={setDraftRole} data={laneOptions} />
            <Select label="大会でのレーン" clearable value={lane} onChange={setLane} data={laneOptions} />
          </Group>
        )}
        <Text size="sm" c="var(--muted)">変更すると、この人は一度ログアウトされます（権限が変わるため）。</Text>
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button onClick={save}>変更を保存</Button></Group>
      </Stack>
    </Modal>
  );
}

function TransferDialog({ user, teams, onClose, onDone }: { user: UserRow; teams: Team[]; onClose: () => void; onDone: () => void }) {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [lane, setLane] = useState<string | null>(user.lane);
  const [warning, setWarning] = useState<string | null>(null);
  const submit = async (confirm: boolean) => {
    try {
      await api('POST', `/api/admin/users/${user.id}/transfer`, { teamId, lane, confirm });
      done('チームを移動しました');
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'same_lane_exists') setWarning(e.message); else fail(e);
    }
  };
  return (
    <Modal opened onClose={onClose} title={`${user.display_name} さんをチーム移動（移籍）`}>
      <Stack>
        <Text size="sm">今のチーム：{teamLabel(teams, user.team_id)}</Text>
        <Select label="移動先のチーム" value={teamId} onChange={(v) => { setTeamId(v); setWarning(null); }} data={teamOptions(teams).filter((t) => t.value !== user.team_id)} />
        <Select label="大会でのレーン" value={lane} onChange={(v) => { setLane(v); setWarning(null); }} data={laneOptions} clearable />
        {warning && <Text c="orange.9" fw={700} size="sm" role="alert">{warning}</Text>}
        <Text size="sm" c="var(--muted)">移動すると Discord に通知し、操作ログに残ります。確定済みのスクリムの参加メンバーからは自動では外しません。</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>やめる</Button>
          {warning ? <Button color="orange" onClick={() => submit(true)}>それでも移動する</Button> : <Button disabled={!teamId} onClick={() => submit(false)}>移動する</Button>}
        </Group>
      </Stack>
    </Modal>
  );
}

function SuspendDialog({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: () => void }) {
  const resume = Boolean(user.suspended_at);
  const submit = async () => {
    try {
      await api('POST', `/api/admin/users/${user.id}/${resume ? 'unsuspend' : 'suspend'}`);
      done(resume ? '利用停止を解除しました' : '利用停止にしました');
      onDone();
    } catch (e) { fail(e); }
  };
  return (
    <Modal opened onClose={onClose} title={resume ? '利用停止を解除しますか？' : `${user.display_name} さんを利用停止にしますか？`}>
      <Text mb="lg">{resume ? 'この人は再びログインできるようになります。' : 'この人はすぐにログアウトされ、解除するまでログインできなくなります。'}</Text>
      <Group justify="flex-end"><Button variant="default" onClick={onClose}>やめる</Button><Button color={resume ? undefined : 'red'} onClick={submit}>{resume ? '解除する' : '利用停止にする'}</Button></Group>
    </Modal>
  );
}
