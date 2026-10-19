import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Button,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconArrowsExchange,
  IconChevronRight,
  IconPlus,
  IconSearch,
  IconUsersGroup,
} from '@tabler/icons-react';
import { canAny, type TeamDto, type TeamStatus, can } from '@nuzli/shared';
import { useTeams } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { VestBand } from '../../theme/VestBand';
import { formatDate, formatNumber, t } from '../../i18n';
import { SupervisorAvatars, TeamStatusBadge, supervisorsOf } from './shared';
import { CreateTeamDialog } from './CreateTeamDialog';
import { useOverlayParam } from '../../lib/useUrlState';

type Filter = 'ALL' | TeamStatus;
const FILTERS: Filter[] = ['ALL', 'ACTIVE', 'PENDING_APPROVAL', 'ARCHIVED'];

export function TeamCard({ team }: { team: TeamDto }) {
  return (
    <UnstyledButton
      component={Link}
      to={`/teams/${team.id}`}
      className="nz-team-card"
      aria-label={t('team.badgeTitle', { name: team.name })}
    >
      <VestBand color={team.color.hex} className="nz-team-card-inner">
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <div style={{ minWidth: 0 }}>
            <Text fw={700} fz="lg" lh={1.35} className="nz-clamp-2">
              {team.name}
            </Text>
            <Text size="sm" c="dimmed">
              {t('teams.colorName', { name: team.color.name })}
            </Text>
          </div>
          <TeamStatusBadge status={team.status} />
        </Group>
        <Group justify="space-between" mt="sm" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <SupervisorAvatars supervisors={supervisorsOf(team)} size={24} max={3} />
            <Text size="sm" truncate>
              {supervisorsOf(team)
                .map((s) => (s.isPrimary && (team.supervisors?.length ?? 1) > 1 ? t('teams.sup.namePrimary', { name: s.fullName }) : s.fullName))
                .join('، ') || t('teams.noSupervisor')}
            </Text>
          </Group>
          <Group gap={4} wrap="nowrap" c="dimmed">
            <IconUsersGroup size={16} aria-hidden />
            <Text size="sm" className="num">
              {t('teams.memberCount', { count: team.memberCount })}
            </Text>
            <IconChevronRight size={16} className="mirror-rtl" aria-hidden />
          </Group>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t('teams.createdAt', { date: formatDate(team.createdAt) })}
        </Text>
      </VestBand>
    </UnstyledButton>
  );
}

export function TeamsPage() {
  const user = useAuthStore((s) => s.user);
  const [params, setParams] = useSearchParams();
  const initial = (params.get('status') as Filter | null) ?? 'ALL';
  const [filter, setFilter] = useState<Filter>(FILTERS.includes(initial) ? initial : 'ALL');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 250);
  // «إنشاء» is a URL (?create=1): the command palette opens it, and back closes it.
  const create = useOverlayParam('create');
  const creating = create.value === '1';
  const setCreating = (on: boolean) => (on ? create.open('1') : create.close());
  const teams = useTeams({ status: filter, q: q || undefined });
  const all = useTeams({ status: 'ALL' });
  const canCreate = canAny(user, ['teams.create', 'teams.createOwn']);

  const count = (s: Filter) =>
    s === 'ALL' ? all.data?.length : all.data?.filter((x) => x.status === s).length;

  return (
    <>
      <PageHeader
        title={t('teams.title')}
        lead={can(user, 'teams.readAll') ? t('teams.leadAdmin') : t('teams.leadSupervisor')}
        actions={
          <>
            {can(user, 'members.move') ? (
              <Button
                variant="light"
                component={Link}
                to="/teams/formation"
                leftSection={<IconArrowsExchange size={18} />}
              >
                {t('nav.formation')}
              </Button>
            ) : null}
            {canCreate ? (
              <Button leftSection={<IconPlus size={18} />} onClick={() => setCreating(true)}>
                {t('teams.create')}
              </Button>
            ) : null}
          </>
        }
      />
      <Stack gap="md">
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={t('teams.search')}
            aria-label={t('teams.search')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ flex: '1 1 220px' }}
          />
          <SegmentedControl
            value={filter}
            onChange={(v) => {
              setFilter(v as Filter);
              setParams(v === 'ALL' ? {} : { status: v }, { replace: true });
            }}
            data={FILTERS.map((f) => ({
              value: f,
              label: `${f === 'ALL' ? t('common.all') : t(`teamStatus.${f}`)}${
                count(f) !== undefined ? ` (${formatNumber(count(f) ?? 0)})` : ''
              }`,
            }))}
            className="nz-scroll-x"
          />
        </Group>
        {teams.isLoading ? (
          <LoadingBlock variant="cards" />
        ) : teams.isError ? (
          <ErrorBlock error={teams.error} onRetry={() => void teams.refetch()} />
        ) : !teams.data?.length ? (
          <EmptyState
            icon={IconUsersGroup}
            title={search || filter !== 'ALL' ? t('teams.emptyFiltered') : t('teams.empty')}
            body={canCreate ? t('teams.emptyBody') : undefined}
            action={canCreate ? { label: t('teams.create'), onClick: () => setCreating(true) } : undefined}
          />
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {teams.data.map((team) => (
              <TeamCard key={team.id} team={team} />
            ))}
          </SimpleGrid>
        )}
      </Stack>
      {canCreate ? <CreateTeamDialog opened={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}
