import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Group,
  List,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconHistory,
  IconListCheck,
  IconMapPin,
  IconShieldCheck,
  IconUserCheck,
  IconUserOff,
  IconUsersGroup,
} from '@tabler/icons-react';
import { can, type Role } from '@nuzli/shared';
import { useAuthStore } from '../stores/auth';
import { useAudit, useRegistrations, useTeams, useUsers } from '../api/queries';
import { TeamBadge } from '../theme/TeamBadge';
import { formatDateTime, formatNumber, t, tKey } from '../i18n';
import { MonitorHome } from './violations/MonitorHome';
import { MyTasksSummary, ProjectsKpi } from './projects/DashboardWidgets';
import { PageHeader, roleLabel } from '../components/ui';

function Kpi({
  label,
  value,
  loading,
  tone,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  tone?: string;
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      {loading ? (
        <Skeleton h={40} w={60} />
      ) : (
        <Text className="nz-kpi" c={tone}>
          {formatNumber(value ?? 0)}
        </Text>
      )}
    </Stack>
  );
}

function RoleCount({ role }: { role: Role }) {
  const q = useUsers({ role, status: 'ACTIVE', pageSize: 1 });
  return <Kpi label={roleLabel(role)} value={q.data?.total} loading={q.isLoading} />;
}

/** Admin: active teams and teams waiting for approval (brief §5.1). */
function TeamsKpi() {
  const navigate = useNavigate();
  const teams = useTeams({});
  const active = teams.data?.filter((x) => x.status === 'ACTIVE').length;
  const pending = teams.data?.filter((x) => x.status === 'PENDING_APPROVAL').length ?? 0;
  return (
    <Card className="nz-kpi-card" data-tone={pending ? 'wait' : undefined}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <SimpleGrid cols={2} spacing="md">
          <Kpi label={t('dash.activeTeams')} value={active} loading={teams.isLoading} />
          <Kpi
            label={t('dash.pendingTeams')}
            value={pending}
            loading={teams.isLoading}
            tone={pending ? 'var(--amber)' : 'dimmed'}
          />
        </SimpleGrid>
        <ThemeIcon size={40} radius="xl" variant="light" color={pending ? 'signal' : 'field'} aria-hidden>
          <IconUsersGroup size={22} />
        </ThemeIcon>
      </Group>
      <Button
        mt="md"
        fullWidth
        variant={pending ? 'filled' : 'light'}
        onClick={() => navigate(pending ? '/teams?status=PENDING_APPROVAL' : '/teams')}
      >
        {pending ? t('dash.reviewTeams') : t('dash.openTeams')}
      </Button>
    </Card>
  );
}

/** Supervisor: the teams they lead with member counts. */
function MyTeams() {
  const navigate = useNavigate();
  const teams = useTeams({});
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Title order={2} fz="lg">
          {t('dash.myTeams')}
        </Title>
        <Button variant="subtle" onClick={() => navigate('/teams')}>
          {t('dash.openTeams')}
        </Button>
      </Group>
      {teams.isLoading ? (
        <Skeleton h={60} />
      ) : teams.data?.length ? (
        <Stack gap={0}>
          {teams.data.map((tm) => (
            <Group
              key={tm.id}
              justify="space-between"
              py="xs"
              wrap="nowrap"
              style={{ borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
              onClick={() => navigate(`/teams/${tm.id}`)}
            >
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <TeamBadge name={tm.name} color={tm.color.hex} />
                {tm.status === 'PENDING_APPROVAL' ? (
                  <Text size="xs" c="var(--signal)" fw={600}>
                    {t('teamStatus.PENDING_APPROVAL')}
                  </Text>
                ) : null}
              </Group>
              <Text size="sm" className="num" style={{ flex: 'none' }}>
                {t('teams.memberCount', { count: tm.memberCount })}
              </Text>
            </Group>
          ))}
        </Stack>
      ) : (
        <Stack align="flex-start" gap="xs">
          <Text c="dimmed">{t('dash.noTeamsYet')}</Text>
          <Button variant="light" onClick={() => navigate('/teams')}>
            {t('teams.create')}
          </Button>
        </Stack>
      )}
    </Card>
  );
}

function AdminDashboard() {
  const navigate = useNavigate();
  const pending = useRegistrations({ pageSize: 1 });
  const suspended = useUsers({ status: 'SUSPENDED', pageSize: 1 });
  const audit = useAudit({ pageSize: 6 });
  const pendingCount = pending.data?.total ?? 0;

  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <Card className="nz-kpi-card" data-tone={pendingCount ? 'wait' : undefined}>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Kpi
              label={t('dash.pendingRegistrations')}
              value={pendingCount}
              loading={pending.isLoading}
              tone={pendingCount ? 'var(--amber)' : 'dimmed'}
            />
            <ThemeIcon
              size={40}
              radius="xl"
              variant="light"
              color={pendingCount ? 'signal' : 'slate'}
              aria-hidden
            >
              <IconUserCheck size={22} />
            </ThemeIcon>
          </Group>
          <Button
            mt="md"
            variant={pendingCount ? 'filled' : 'light'}
            onClick={() => navigate('/registrations')}
            fullWidth
          >
            {pendingCount ? t('dash.reviewRegistrations') : t('dash.noPending')}
          </Button>
        </Card>

        <TeamsKpi />

        <ProjectsKpi />

        <Card className="nz-kpi-card">
          <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
            <Text fw={600}>{t('dash.activeByRole')}</Text>
            <ThemeIcon size={40} radius="xl" variant="light" color="field" aria-hidden>
              <IconUsersGroup size={22} />
            </ThemeIcon>
          </Group>
          <SimpleGrid cols={3} spacing="xs">
            <RoleCount role="ADMIN" />
            <RoleCount role="SUPERVISOR" />
            <RoleCount role="MONITOR" />
          </SimpleGrid>
        </Card>

        <Card className="nz-kpi-card">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Kpi
              label={t('dash.suspended')}
              value={suspended.data?.total}
              loading={suspended.isLoading}
            />
            <ThemeIcon size={40} radius="xl" variant="light" color="slate" aria-hidden>
              <IconUserOff size={22} />
            </ThemeIcon>
          </Group>
          <Button mt="md" variant="light" onClick={() => navigate('/users')} fullWidth>
            {t('dash.manageUsers')}
          </Button>
        </Card>
      </SimpleGrid>

      <Card>
        <Group justify="space-between" mb="sm">
          <Group gap="xs">
            <IconHistory size={20} aria-hidden />
            <Title order={2} fz="lg">
              {t('dash.recentAudit')}
            </Title>
          </Group>
          <Button variant="subtle" onClick={() => navigate('/audit')}>
            {t('dash.openAudit')}
          </Button>
        </Group>
        {audit.isLoading ? (
          <Stack gap="xs">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} h={36} />
            ))}
          </Stack>
        ) : audit.data?.items.length ? (
          <Stack gap={0}>
            {audit.data.items.map((a) => (
              <Group
                key={a.id}
                justify="space-between"
                wrap="wrap"
                py="xs"
                gap={4}
                style={{ borderBottom: '1px solid var(--line)' }}
              >
                <Text size="sm">
                  <Text span fw={600}>
                    {tKey(`audit.action.${a.action}`, 'audit.action.other')}
                  </Text>
                  {' — '}
                  {a.actor?.fullName ?? t('common.system')}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatDateTime(a.at)}
                </Text>
              </Group>
            ))}
          </Stack>
        ) : (
          <Text c="dimmed">{t('dash.noAudit')}</Text>
        )}
      </Card>
    </Stack>
  );
}

function ComingSoon({
  lead,
  items,
}: {
  lead: string;
  items: { icon: typeof IconMapPin; text: string }[];
}) {
  const navigate = useNavigate();
  return (
    <Card>
      <Title order={2} fz="lg" mb={4}>
        {t('dash.comingTitle')}
      </Title>
      <Text c="dimmed" mb="md">
        {lead}
      </Text>
      <List spacing="sm" center>
        {items.map(({ icon: Icon, text }) => (
          <List.Item
            key={text}
            icon={
              <ThemeIcon size={32} radius="xl" variant="light" color="field" aria-hidden>
                <Icon size={18} />
              </ThemeIcon>
            }
          >
            {text}
          </List.Item>
        ))}
      </List>
      <Text mt="lg" size="sm" c="dimmed">
        {t('dash.meanwhile')}
      </Text>
      <Button
        mt="sm"
        variant="light"
        onClick={() => navigate('/profile')}
        style={{ alignSelf: 'flex-start' }}
      >
        {t('dash.openProfile')}
      </Button>
    </Card>
  );
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;
  const isAdmin = can(user, 'users.read');
  return (
    <>
      <PageHeader
        title={t('dash.welcome', { name: user.fullName.split(' ')[0] ?? user.fullName })}
        lead={isAdmin ? t('dash.adminLead') : undefined}
      />
      {isAdmin ? (
        <AdminDashboard />
      ) : user.role === 'SUPERVISOR' ? (
        <Stack gap="lg">
          <MyTasksSummary />
          <MyTeams />
        </Stack>
      ) : (
        <MonitorHome />
      )}
    </>
  );
}
