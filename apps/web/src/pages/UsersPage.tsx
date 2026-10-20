import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  Pagination,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowsExchange,
  IconDots,
  IconEye,
  IconPlayerPlay,
  IconSearch,
  IconShieldUp,
  IconUserPlus,
  IconUserSearch,
  IconUsersPlus,
  IconUserX,
} from '@tabler/icons-react';
import { can, ROLES, type Role, type UserDto, type UserStatus } from '@nuzli/shared';
import { useApi } from '../api/context';
import { errorMessage } from '../api/errors';
import { useUsers } from '../api/queries';
import { useAuthStore } from '../stores/auth';
import { EmptyState, ErrorBlock, FormError, Ltr, LoadingBlock, Mobile, PageHeader, roleLabel } from '../components/ui';
import { formatDateTime, t, tKey } from '../i18n';
import { useOverlayParam } from '../lib/useUrlState';
import { PersonName, StatePill, WorkspaceRolePills } from '../features/users/components';
import { AddMembershipDialog, CreateAccountDialog, SuspendAccountDialog } from '../features/users/dialogs';
import { UserEditor, accountRights } from '../features/users/UserEditor';
import { useInvalidateUserAdmin } from '../features/users/queries';

const STATUSES: UserStatus[] = ['ACTIVE', 'PENDING', 'SUSPENDED', 'REJECTED'];

type Dialog = { kind: 'role'; user: UserDto; role: Role } | { kind: 'suspend'; user: UserDto } | null;

// ------------------------------------------------------------------ row actions

function UserActions({ user, onDialog, onOpen }: { user: UserDto; onDialog: (d: Dialog) => void; onOpen: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const me = useAuthStore((s) => s.user);
  const active = useAuthStore((s) => s.activeWorkspace);
  const [busy, setBusy] = useState(false);
  const rights = accountRights(me, user, active?.id ?? null);
  const settled = user.status !== 'PENDING' && user.status !== 'REJECTED';
  const canRoles = settled && rights.roles;
  const canSuspend = settled && rights.suspend;

  const reactivate = async () => {
    setBusy(true);
    try {
      await api.users.reactivate(user.id, { scope: 'workspace' });
      await invalidate();
      notifications.show({ color: 'ok', message: t('users.reactivated', { name: user.fullName }) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu position="bottom-end" width={260} shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="slate"
          size={44}
          aria-label={`${t('common.actions')}: ${user.fullName}`}
          loading={busy}
          data-testid={`user-actions-${user.username ?? user.id}`}
        >
          <IconDots size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<IconEye size={18} />} onClick={onOpen}>
          {rights.edit ? t('a12admin.openEditor') : t('a12admin.openDetails')}
        </Menu.Item>
        {canRoles ? (
          <>
            <Menu.Divider />
            {ROLES.filter((r) => r !== user.role).map((r) => (
              <Menu.Item
                key={r}
                leftSection={r === 'ADMIN' ? <IconShieldUp size={18} /> : <IconArrowsExchange size={18} />}
                onClick={() => onDialog({ kind: 'role', user, role: r })}
              >
                {r === 'ADMIN' ? t('users.promote') : t('users.demoteTo', { role: roleLabel(r) })}
              </Menu.Item>
            ))}
          </>
        ) : null}
        {canSuspend ? (
          <>
            <Menu.Divider />
            {user.status === 'ACTIVE' ? (
              <Menu.Item color="breach" leftSection={<IconUserX size={18} />} onClick={() => onDialog({ kind: 'suspend', user })}>
                {t('users.suspend')}
              </Menu.Item>
            ) : (
              <Menu.Item leftSection={<IconPlayerPlay size={18} className="mirror-rtl" />} onClick={() => void reactivate()}>
                {t('users.reactivate')}
              </Menu.Item>
            )}
          </>
        ) : null}
      </Menu.Dropdown>
    </Menu>
  );
}

function RoleDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: 'role' }>; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateUserAdmin();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { user, role } = dialog;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.users.changeRole(user.id, { role });
      await invalidate();
      notifications.show({ color: 'ok', message: t('users.roleChanged', { name: user.fullName, role: roleLabel(role) }) });
      onClose();
    } catch (err) {
      // LAST_ADMIN and friends come back in Arabic from the API; show them as they are.
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={t('users.roleTitle', { name: user.fullName })}>
      <Stack>
        <Text>{t('users.roleBody', { from: roleLabel(user.role), to: roleLabel(role) })}</Text>
        <FormError error={error} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void confirm()} loading={busy} leftSection={role === 'ADMIN' ? <IconShieldUp size={18} /> : undefined}>
            {role === 'ADMIN' ? t('users.promote') : t('users.roleConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ------------------------------------------------------------------ page

export function UsersPage() {
  const me = useAuthStore((s) => s.user);
  const active = useAuthStore((s) => s.activeWorkspace);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 300);
  const [role, setRole] = useState<Role | null>(null);
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const detail = useOverlayParam('user');

  const canCreate = can(me, 'users.create');
  const canAdd = can(me, 'users.manageRoles') && Boolean(active);
  const readOnly = !canCreate && !canAdd;

  const query = useUsers({ q: q || undefined, role: role ?? undefined, status: status ?? undefined, page, pageSize: 20 });
  const adminsQ = useUsers({ role: 'ADMIN', status: 'ACTIVE', pageSize: 1 });
  const iAmLastAdmin = me?.role === 'ADMIN' && me?.accountRole !== 'OWNER' && adminsQ.data?.total === 1;
  const filtered = Boolean(q || role || status);

  const clear = () => {
    setSearch('');
    setRole(null);
    setStatus(null);
    setPage(1);
  };

  const person = (u: UserDto) => <PersonName user={u} self={u.id === me?.id} onOpen={() => detail.open(u.id)} />;
  const username = (u: UserDto) => (u.username ? <Ltr mono>{u.username}</Ltr> : <span>{t('common.none')}</span>);

  return (
    <>
      <PageHeader
        title={t('users.title')}
        lead={readOnly ? t('a12admin.users.readOnlyLead') : t('a12admin.users.lead')}
        actions={
          readOnly ? undefined : (
            <>
              {canAdd ? (
                <Button variant="default" leftSection={<IconUsersPlus size={18} />} onClick={() => setAdding(true)} data-testid="user-add-existing">
                  {t('a12admin.member.addOpen')}
                </Button>
              ) : null}
              {canCreate ? (
                <Button leftSection={<IconUserPlus size={18} />} onClick={() => setCreating(true)} data-testid="user-create">
                  {t('users.create')}
                </Button>
              ) : null}
            </>
          )
        }
      />

      {iAmLastAdmin ? (
        <Alert color="signal" mb="md">
          {t('users.lastAdminHint')}
        </Alert>
      ) : null}

      <Card mb="md" p="md">
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <TextInput
            aria-label={t('common.search')}
            placeholder={t('a12admin.users.searchPlaceholder')}
            leftSection={<IconSearch size={18} />}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setPage(1);
            }}
            data-testid="users-search"
          />
          <Select
            aria-label={t('users.filterRole')}
            placeholder={`${t('users.filterRole')}: ${t('common.all')}`}
            data={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
            value={role}
            onChange={(v) => {
              setRole(v as Role | null);
              setPage(1);
            }}
            clearable
          />
          <Select
            aria-label={t('users.filterStatus')}
            placeholder={`${t('users.filterStatus')}: ${t('common.all')}`}
            data={STATUSES.map((s) => ({ value: s, label: tKey(`status.${s}`, 'common.none') }))}
            value={status}
            onChange={(v) => {
              setStatus(v as UserStatus | null);
              setPage(1);
            }}
            clearable
          />
        </SimpleGrid>
      </Card>

      {query.isLoading ? (
        <LoadingBlock variant="table" />
      ) : query.isError ? (
        <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState
          icon={IconUserSearch}
          title={t('users.empty')}
          body={t('users.emptyBody')}
          action={
            filtered
              ? { label: t('users.clearFilters'), onClick: clear }
              : canCreate
                ? { label: t('users.create'), onClick: () => setCreating(true) }
                : undefined
          }
        />
      ) : (
        <>
          {/* Phones: cards. */}
          <Stack hiddenFrom="sm" gap="sm">
            {query.data.items.map((u) => (
              <Box key={u.id} className="nz-row-card">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Box style={{ minWidth: 0 }}>
                    {person(u)}
                    <Text size="sm" c="dimmed" truncate>
                      {username(u)}
                    </Text>
                    <Text size="sm" c="dimmed" truncate>
                      <Ltr>{u.email}</Ltr>
                    </Text>
                  </Box>
                  <UserActions user={u} onDialog={setDialog} onOpen={() => detail.open(u.id)} />
                </Group>
                <Group gap={6} mt="xs">
                  <WorkspaceRolePills user={u} />
                  <StatePill status={u.status} />
                </Group>
              </Box>
            ))}
          </Stack>

          {/* Tablets and up: table, scrolling inside its card. */}
          <Card p={0} visibleFrom="sm">
            <Table.ScrollContainer minWidth={860}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('users.col.name')}</Table.Th>
                    <Table.Th>{t('a12admin.username')}</Table.Th>
                    <Table.Th>{t('users.col.contact')}</Table.Th>
                    <Table.Th>{t('a12admin.col.roles')}</Table.Th>
                    <Table.Th>{t('users.col.status')}</Table.Th>
                    <Table.Th>{t('users.col.lastLogin')}</Table.Th>
                    <Table.Th w={56}>
                      <span className="sr-only">{t('common.actions')}</span>
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {query.data.items.map((u) => (
                    <Table.Tr key={u.id} style={{ height: 44 }} data-testid={`user-row-${u.username ?? u.id}`}>
                      <Table.Td>{person(u)}</Table.Td>
                      <Table.Td>{username(u)}</Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          <Ltr>{u.email}</Ltr>
                        </Text>
                        <Text size="xs" c="dimmed">
                          <Mobile value={u.mobile} />
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <WorkspaceRolePills user={u} />
                      </Table.Td>
                      <Table.Td>
                        <StatePill status={u.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={u.lastLoginAt ? undefined : 'dimmed'}>
                          {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.neverLoggedIn')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <UserActions user={u} onDialog={setDialog} onOpen={() => detail.open(u.id)} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>

          <Group justify="space-between" mt="md" wrap="wrap">
            <Text size="sm" c="dimmed">
              {t('common.total', { count: query.data.total })}
            </Text>
            {query.data.total > query.data.pageSize ? (
              <Pagination total={Math.ceil(query.data.total / query.data.pageSize)} value={page} onChange={setPage} />
            ) : null}
          </Group>
        </>
      )}

      {dialog?.kind === 'role' ? <RoleDialog dialog={dialog} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'suspend' ? <SuspendAccountDialog user={dialog.user} onClose={() => setDialog(null)} /> : null}
      {canCreate ? <CreateAccountDialog opened={creating} onClose={() => setCreating(false)} /> : null}
      {canAdd && active ? <AddMembershipDialog opened={adding} onClose={() => setAdding(false)} workspaceId={active.id} /> : null}
      <UserEditor id={detail.value} onClose={detail.close} />
    </>
  );
}
