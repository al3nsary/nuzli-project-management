import { useState } from 'react';
import {
  Badge,
  Card,
  Group,
  Pagination,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconId, IconSearch } from '@tabler/icons-react';
import { useMembers, useTeams } from '../../api/queries';
import { EmptyState, ErrorBlock, Ltr, LoadingBlock, PageHeader } from '../../components/ui';
import { TeamBadge } from '../../theme/TeamBadge';
import { localizeDigits, t } from '../../i18n';
import { MemberDrawer } from './MemberDrawer';
import { useOverlayParam } from '../../lib/useUrlState';
import { MemberAvatar } from '../../components/UserAvatar';
import { ForemanAvatar, ForemanBadge } from '../../components/Foreman';

const PAGE_SIZE = 25;

/**
 * Team members: search by name, by the full national ID, or by its last four digits
 * (docs/API.md). The query is never put in the page URL (no personal data in links).
 */
export function MembersPage() {
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState(false);
  const [page, setPage] = useState(1);
  const member = useOverlayParam('member');
  const teams = useTeams({ status: 'ALL' });
  const members = useMembers({
    q: q || undefined,
    teamId: unassigned ? undefined : teamId ?? undefined,
    unassigned: unassigned || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const pages = members.data ? Math.max(1, Math.ceil(members.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader title={t('members.title')} lead={t('members.lead')} />
      <Stack gap="md">
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={t('members.searchPlaceholder')}
            aria-label={t('members.searchPlaceholder')}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setPage(1);
            }}
            style={{ flex: '2 1 240px' }}
            autoComplete="off"
          />
          <Select
            aria-label={t('members.filterTeam')}
            placeholder={t('members.filterTeam')}
            data={(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name }))}
            value={teamId}
            onChange={(v) => {
              setTeamId(v);
              setPage(1);
            }}
            clearable
            searchable
            disabled={unassigned}
            style={{ flex: '1 1 200px' }}
          />
          <Switch
            label={t('members.onlyUnassigned')}
            checked={unassigned}
            onChange={(e) => {
              setUnassigned(e.currentTarget.checked);
              setPage(1);
            }}
            mb={8}
          />
        </Group>
        {members.isLoading ? (
          <LoadingBlock variant="table" />
        ) : members.isError ? (
          <ErrorBlock error={members.error} onRetry={() => void members.refetch()} />
        ) : !members.data?.items.length ? (
          <EmptyState icon={IconId} title={t('members.empty')} body={t('members.emptyBody')} />
        ) : (
          <Card p={0}>
            <Table.ScrollContainer minWidth={640}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('members.fullName')}</Table.Th>
                    <Table.Th>{t('members.nationalId')}</Table.Th>
                    <Table.Th>{t('members.team')}</Table.Th>
                    <Table.Th>{t('members.jobTitle')}</Table.Th>
                    <Table.Th>{t('members.department')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {members.data.items.map((m) => (
                    <Table.Tr key={m.id} className={m.isForeman ? 'nz-foreman-row' : undefined} data-foreman={m.isForeman || undefined}>
                      <Table.Td>
                        <Group gap={8} wrap="nowrap">
                          <UnstyledButton
                            onClick={() => member.open(m.id)}
                            fw={600}
                            c="var(--field)"
                            style={{ minHeight: 32, display: 'inline-flex', alignItems: 'center', gap: 8 }}
                          >
                            <ForemanAvatar foreman={m.isForeman} size={28}>
                              <MemberAvatar member={m} size={28} />
                            </ForemanAvatar>
                            {m.fullName}
                          </UnstyledButton>
                          {m.isForeman ? <ForemanBadge size="xs" /> : null}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Ltr mono>{localizeDigits(m.nationalIdMasked)}</Ltr>
                      </Table.Td>
                      <Table.Td>
                        {m.team ? (
                          <TeamBadge name={m.team.name} color={m.team.color.hex} size="sm" />
                        ) : (
                          <Badge color="slate" variant="outline">
                            {t('formation.unassigned')}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>{m.jobTitle ?? t('common.none')}</Table.Td>
                      <Table.Td>{m.department ?? t('common.none')}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        )}
        {members.data ? (
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {t('common.total', { count: members.data.total })}
            </Text>
            {pages > 1 ? <Pagination total={pages} value={page} onChange={setPage} /> : null}
          </Group>
        ) : null}
      </Stack>
      <MemberDrawer memberId={member.value} onClose={member.close} />
    </>
  );
}
