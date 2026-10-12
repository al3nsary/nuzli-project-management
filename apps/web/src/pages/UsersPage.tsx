import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Drawer,
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
  Textarea,
  UnstyledButton,
  useDirection,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconDots,
  IconPlayerPlay,
  IconSearch,
  IconShieldUp,
  IconUserPlus,
  IconUserSearch,
  IconUserX,
  IconArrowsExchange,
} from '@tabler/icons-react';
import {
  createUserSchema,
  suspendUserSchema,
  ROLES,
  type Role,
  type UserDto,
  type UserStatus,
} from '@nuzli/shared';
import { useApi } from '../api/context';
import { ApiError, errorMessage } from '../api/errors';
import { useInvalidateAccounts, useUser, useUsers } from '../api/queries';
import { useAuthStore } from '../stores/auth';
import { useZodForm } from '../forms/useZodForm';
import {
  EmptyState,
  ErrorBlock,
  FormError,
  Ltr,
  LoadingBlock,
  Mobile,
  PageHeader,
  RoleBadge,
  StatusBadge,
  roleLabel,
} from '../components/ui';
import { formatDateTime, t, tKey } from '../i18n';
import { useOverlayParam } from '../lib/useUrlState';

const STATUSES: UserStatus[] = ['ACTIVE', 'PENDING', 'SUSPENDED', 'REJECTED'];

type Dialog =
  { kind: 'role'; user: UserDto; role: Role } | { kind: 'suspend'; user: UserDto } | null;

// ------------------------------------------------------------------ actions

function UserActions({ user, onDialog }: { user: UserDto; onDialog: (d: Dialog) => void }) {
  const api = useApi();
  const invalidate = useInvalidateAccounts();
  const [busy, setBusy] = useState(false);
  if (user.status === 'PENDING' || user.status === 'REJECTED') return null;

  const reactivate = async () => {
    setBusy(true);
    try {
      await api.users.reactivate(user.id);
      await invalidate();
      notifications.show({ color: 'ok', message: t('users.reactivated', { name: user.fullName }) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu position="bottom-end" width={240} shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="slate"
          size={44}
          aria-label={`${t('common.actions')}: ${user.fullName}`}
          loading={busy}
        >
          <IconDots size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {ROLES.filter((r) => r !== user.role).map((r) => (
          <Menu.Item
            key={r}
            leftSection={
              r === 'ADMIN' ? <IconShieldUp size={18} /> : <IconArrowsExchange size={18} />
            }
            onClick={() => onDialog({ kind: 'role', user, role: r })}
          >
            {r === 'ADMIN' ? t('users.promote') : t('users.demoteTo', { role: roleLabel(r) })}
          </Menu.Item>
        ))}
        <Menu.Divider />
        {user.status === 'ACTIVE' ? (
          <Menu.Item
            color="breach"
            leftSection={<IconUserX size={18} />}
            onClick={() => onDialog({ kind: 'suspend', user })}
          >
            {t('users.suspend')}
          </Menu.Item>
        ) : (
          <Menu.Item
            leftSection={<IconPlayerPlay size={18} className="mirror-rtl" />}
            onClick={() => void reactivate()}
          >
            {t('users.reactivate')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

function RoleDialog({
  dialog,
  onClose,
}: {
  dialog: Extract<Dialog, { kind: 'role' }>;
  onClose: () => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateAccounts();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { user, role } = dialog;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.users.changeRole(user.id, { role });
      await invalidate();
      notifications.show({
        color: 'ok',
        message: t('users.roleChanged', { name: user.fullName, role: roleLabel(role) }),
      });
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
          <Button
            onClick={() => void confirm()}
            loading={busy}
            leftSection={role === 'ADMIN' ? <IconShieldUp size={18} /> : undefined}
          >
            {role === 'ADMIN' ? t('users.promote') : t('users.roleConfirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function SuspendDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateAccounts();
  const [error, setError] = useState<unknown>(null);
  const form = useZodForm(suspendUserSchema, { reason: '' });

  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      await api.users.suspend(user.id, data);
      await invalidate();
      notifications.show({ color: 'ok', message: t('users.suspended', { name: user.fullName }) });
      onClose();
    } catch (err) {
      setError(err);
    }
  });

  return (
    <Modal opened onClose={onClose} title={t('users.suspendTitle', { name: user.fullName })}>
      <form onSubmit={submit} noValidate>
        <Stack>
          <Text>{t('users.suspendBody')}</Text>
          <FormError error={error} />
          <Textarea
            label={`${t('users.suspendReason')} (${t('common.optional')})`}
            autosize
            minRows={2}
            {...form.getInputProps('reason')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              color="breach"
              loading={form.submitting}
              leftSection={<IconUserX size={18} />}
            >
              {t('users.suspendConfirm')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function CreateUserDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const api = useApi();
  const invalidate = useInvalidateAccounts();
  const [error, setError] = useState<unknown>(null);
  const initial = {
    fullName: '',
    email: '',
    mobile: '',
    nationalId: '',
    role: 'SUPERVISOR' as Role,
  };
  const form = useZodForm(createUserSchema, initial);

  const close = () => {
    form.reset(initial);
    setError(null);
    onClose();
  };

  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      const created = await api.users.create(data);
      await invalidate();
      notifications.show({
        color: 'ok',
        message: t(api.demo ? 'users.createdDemo' : 'users.created', { name: created.fullName }),
      });
      close();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) {
        form.setErrors(err.fieldErrors);
        if (err.code === 'VALIDATION_FAILED') return;
      }
      setError(err);
    }
  });

  const ltr = { dir: 'ltr' as const, styles: { input: { textAlign: 'start' as const } } };

  return (
    <Modal opened={opened} onClose={close} title={t('users.createTitle')} size="lg">
      <form onSubmit={submit} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t('users.createBody')}
          </Text>
          <FormError error={error} />
          <TextInput
            label={t('register.fullName')}
            withAsterisk
            data-autofocus
            {...form.getInputProps('fullName')}
          />
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              label={t('register.email')}
              placeholder={t('register.emailPlaceholder')}
              type="email"
              withAsterisk
              {...ltr}
              {...form.getInputProps('email')}
            />
            <TextInput
              label={t('register.mobile')}
              placeholder={t('register.mobilePlaceholder')}
              type="tel"
              withAsterisk
              {...ltr}
              {...form.getInputProps('mobile')}
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              label={t('register.nationalId')}
              description={t('register.nationalIdHint')}
              inputMode="numeric"
              maxLength={10}
              withAsterisk
              {...ltr}
              {...form.getInputProps('nationalId')}
            />
            <Select
              label={t('users.role')}
              data={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
              allowDeselect={false}
              withAsterisk
              {...form.getInputProps('role')}
            />
          </SimpleGrid>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              loading={form.submitting}
              leftSection={<IconUserPlus size={18} />}
            >
              {t('users.createSubmit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ detail (admin: full national ID)

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      py={8}
      style={{ borderBottom: '1px solid var(--line)' }}
      gap="md"
    >
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ta="end" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </Group>
  );
}

function UserDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useUser(id);
  const u = q.data;
  // Drawer position is physical: open it on the inline-end side.
  const { dir } = useDirection();
  return (
    <Drawer
      opened={Boolean(id)}
      onClose={onClose}
      title={t('users.detailTitle')}
      position={dir === 'rtl' ? 'left' : 'right'}
      size="md"
    >
      {q.isLoading ? (
        <LoadingBlock variant="detail" rows={3} />
      ) : q.isError ? (
        <ErrorBlock error={q.error} />
      ) : u ? (
        <Stack gap={0}>
          <Text fw={600} fz="lg" mb="sm">
            {u.fullName}
          </Text>
          <Row label={t('users.col.role')}>
            <RoleBadge role={u.role} />
          </Row>
          <Row label={t('users.col.status')}>
            <StatusBadge status={u.status} />
          </Row>
          <Row label={t('register.email')}>
            <Ltr>{u.email}</Ltr>
          </Row>
          <Row label={t('register.mobile')}>
            <Mobile value={u.mobile} />
          </Row>
          <Row label={t('register.nationalId')}>
            <Ltr mono>{u.nationalId ?? u.nationalIdMasked}</Ltr>
          </Row>
          {u.requestedTeamName ? (
            <Row label={t('reg.requestedTeam')}>{u.requestedTeamName}</Row>
          ) : null}
          {u.rejectionReason ? (
            <Row label={t('users.rejectionReason')}>{u.rejectionReason}</Row>
          ) : null}
          <Row label={t('users.createdAt')}>{formatDateTime(u.createdAt)}</Row>
          <Row label={t('users.col.lastLogin')}>
            {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.neverLoggedIn')}
          </Row>
        </Stack>
      ) : null}
    </Drawer>
  );
}

// ------------------------------------------------------------------ page

export function UsersPage() {
  const me = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 300);
  const [role, setRole] = useState<Role | null>(null);
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [creating, setCreating] = useState(false);
  const detail = useOverlayParam('user');

  const query = useUsers({
    q: q || undefined,
    role: role ?? undefined,
    status: status ?? undefined,
    page,
    pageSize: 20,
  });
  const adminsQ = useUsers({ role: 'ADMIN', status: 'ACTIVE', pageSize: 1 });
  const iAmLastAdmin = me?.role === 'ADMIN' && adminsQ.data?.total === 1;
  const filtered = Boolean(q || role || status);

  const clear = () => {
    setSearch('');
    setRole(null);
    setStatus(null);
    setPage(1);
  };

  const nameButton = (u: UserDto) => (
    <UnstyledButton
      onClick={() => detail.open(u.id)}
      style={{ fontWeight: 600, color: 'var(--field)' }}
    >
      {u.fullName}
      {u.id === me?.id ? (
        <Text span size="xs" c="dimmed" fw={400}>
          {' '}
          ({t('users.you')})
        </Text>
      ) : null}
    </UnstyledButton>
  );

  return (
    <>
      <PageHeader
        title={t('users.title')}
        lead={t('users.lead')}
        actions={
          <Button leftSection={<IconUserPlus size={18} />} onClick={() => setCreating(true)}>
            {t('users.create')}
          </Button>
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
            placeholder={t('users.searchPlaceholder')}
            leftSection={<IconSearch size={18} />}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setPage(1);
            }}
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
              : { label: t('users.create'), onClick: () => setCreating(true) }
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
                    {nameButton(u)}
                    <Text size="sm" c="dimmed" truncate>
                      <Ltr>{u.email}</Ltr>
                    </Text>
                  </Box>
                  <UserActions user={u} onDialog={setDialog} />
                </Group>
                <Group gap={6} mt="xs">
                  <RoleBadge role={u.role} />
                  <StatusBadge status={u.status} />
                  <Text size="xs" c="dimmed">
                    <Ltr mono>{u.nationalIdMasked}</Ltr>
                  </Text>
                </Group>
              </Box>
            ))}
          </Stack>

          {/* Tablets and up: table. */}
          <Card p={0} visibleFrom="sm">
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm" horizontalSpacing="md">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('users.col.name')}</Table.Th>
                    <Table.Th>{t('users.col.contact')}</Table.Th>
                    <Table.Th>{t('users.col.nationalId')}</Table.Th>
                    <Table.Th>{t('users.col.role')}</Table.Th>
                    <Table.Th>{t('users.col.status')}</Table.Th>
                    <Table.Th>{t('users.col.lastLogin')}</Table.Th>
                    <Table.Th w={56}>
                      <span className="sr-only">{t('common.actions')}</span>
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {query.data.items.map((u) => (
                    <Table.Tr key={u.id} style={{ height: 44 }}>
                      <Table.Td>{nameButton(u)}</Table.Td>
                      <Table.Td>
                        <Text size="sm">
                          <Ltr>{u.email}</Ltr>
                        </Text>
                        <Text size="xs" c="dimmed">
                          <Mobile value={u.mobile} />
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Ltr mono>{u.nationalIdMasked}</Ltr>
                      </Table.Td>
                      <Table.Td>
                        <RoleBadge role={u.role} />
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={u.status} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={u.lastLoginAt ? undefined : 'dimmed'}>
                          {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.neverLoggedIn')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <UserActions user={u} onDialog={setDialog} />
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
              <Pagination
                total={Math.ceil(query.data.total / query.data.pageSize)}
                value={page}
                onChange={setPage}
              />
            ) : null}
          </Group>
        </>
      )}

      {dialog?.kind === 'role' ? (
        <RoleDialog dialog={dialog} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'suspend' ? (
        <SuspendDialog user={dialog.user} onClose={() => setDialog(null)} />
      ) : null}
      <CreateUserDialog opened={creating} onClose={() => setCreating(false)} />
      <UserDetail id={detail.value} onClose={detail.close} />
    </>
  );
}
