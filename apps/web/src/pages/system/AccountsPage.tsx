import { useState } from 'react';
import { Box, Card, Group, Pagination, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconUserSearch } from '@tabler/icons-react';
import type { UserDto, UserStatus } from '@nuzli/shared';
import { useAllUsers } from '../../api/a12Queries';
import { EmptyState, ErrorBlock, Ltr, LoadingBlock, PageHeader } from '../../components/ui';
import { useOverlayParam } from '../../lib/useUrlState';
import { useAuthStore } from '../../stores/auth';
import { ACCOUNT_STATUSES, AllRolesList, OwnerPill, PersonName, StatePill } from '../../features/users/components';
import { UserEditor } from '../../features/users/UserEditor';
import { t, tKey } from '../../i18n';
import '../../features/users/users.css';

type AccountKind = 'OWNER' | 'USER';

/** «كل الحسابات» (owners): every account of the system, with every role and its workspace. */
export function AccountsPage() {
  const me = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 300);
  const [status, setStatus] = useState<UserStatus | null>(null);
  const [kind, setKind] = useState<AccountKind | null>(null);
  const [page, setPage] = useState(1);
  const detail = useOverlayParam('account');
  const query = useAllUsers({
    q: q || undefined,
    status: status ?? undefined,
    accountRole: kind ?? undefined,
    page,
    pageSize: 25,
  });
  const filtered = Boolean(q || status || kind);
  const clear = () => {
    setSearch('');
    setStatus(null);
    setKind(null);
    setPage(1);
  };

  const accountRole = (u: UserDto) =>
    u.accountRole === 'OWNER' ? <OwnerPill /> : <span className="pill grey">{t('accountRole.USER')}</span>;

  return (
    <>
      <PageHeader title={t('nav.systemAccounts')} lead={t('a12admin.accounts.lead')} />
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
            data-testid="accounts-search"
          />
          <Select
            aria-label={t('users.filterStatus')}
            placeholder={`${t('users.filterStatus')}: ${t('common.all')}`}
            data={ACCOUNT_STATUSES.map((s) => ({ value: s, label: tKey(`status.${s}`, 'common.none') }))}
            value={status}
            onChange={(v) => {
              setStatus(v as UserStatus | null);
              setPage(1);
            }}
            clearable
          />
          <Select
            aria-label={t('a12admin.accountRole')}
            placeholder={`${t('a12admin.accountRole')}: ${t('common.all')}`}
            data={[
              { value: 'OWNER', label: t('accountRole.OWNER') },
              { value: 'USER', label: t('accountRole.USER') },
            ]}
            value={kind}
            onChange={(v) => {
              setKind(v as AccountKind | null);
              setPage(1);
            }}
            clearable
            data-testid="accounts-kind"
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
          body={filtered ? t('a12admin.accounts.emptyFiltered') : undefined}
          action={filtered ? { label: t('users.clearFilters'), onClick: clear } : undefined}
        />
      ) : (
        <>
          <Stack hiddenFrom="md" gap="sm">
            {query.data.items.map((u) => (
              <Box key={u.id} className="nz-row-card" data-testid={`account-${u.username ?? u.id}`}>
                <PersonName user={u} self={u.id === me?.id} onOpen={() => detail.open(u.id)} />
                <Text size="sm" c="dimmed" truncate>
                  {u.username ? <Ltr mono>{u.username}</Ltr> : null}
                </Text>
                <Text size="sm" c="dimmed" truncate>
                  <Ltr>{u.email}</Ltr>
                </Text>
                <Group gap={6} mt="xs">
                  {accountRole(u)}
                  <StatePill status={u.status} />
                </Group>
                <Box mt={6}>
                  <AllRolesList roles={u.allRoles} />
                </Box>
              </Box>
            ))}
          </Stack>
          <Card p={0} visibleFrom="md">
            <Table.ScrollContainer minWidth={960}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('users.col.name')}</Table.Th>
                    <Table.Th>{t('a12admin.username')}</Table.Th>
                    <Table.Th>{t('register.email')}</Table.Th>
                    <Table.Th>{t('a12admin.accountRole')}</Table.Th>
                    <Table.Th>{t('users.col.status')}</Table.Th>
                    <Table.Th>{t('a12admin.allRoles')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {query.data.items.map((u) => (
                    <Table.Tr key={u.id} data-testid={`account-row-${u.username ?? u.id}`}>
                      <Table.Td>
                        <PersonName user={u} self={u.id === me?.id} onOpen={() => detail.open(u.id)} />
                      </Table.Td>
                      <Table.Td>{u.username ? <Ltr mono>{u.username}</Ltr> : t('common.none')}</Table.Td>
                      <Table.Td>
                        <Ltr>{u.email}</Ltr>
                      </Table.Td>
                      <Table.Td>{accountRole(u)}</Table.Td>
                      <Table.Td>
                        <StatePill status={u.status} />
                      </Table.Td>
                      <Table.Td>
                        <AllRolesList roles={u.allRoles} />
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
      <UserEditor id={detail.value} onClose={detail.close} />
    </>
  );
}
