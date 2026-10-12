/**
 * Dashboard cards for Phase 4: admins see active projects and the overdue task count;
 * supervisors see their «مهامي» summary (brief §12 "Dashboard (per role)").
 */
import { useNavigate } from 'react-router-dom';
import { Button, Card, Group, SimpleGrid, Skeleton, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconChartArcs, IconChecklist } from '@tabler/icons-react';
import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { qk4, useMyTasks, useProjects } from '../../api/projectQueries';
import { formatNumber, t } from '../../i18n';
import { riyadhToday } from '../../features/projects/today';
import { bucketOf } from './parts';

/** Overdue = leaf tasks ended before today (Riyadh) and not DONE, across up to 12 active projects. */
export function ProjectsKpi() {
  const api = useApi();
  const navigate = useNavigate();
  const projects = useProjects({ status: 'ACTIVE' });
  const ids = (projects.data ?? []).slice(0, 12).map((p) => p.id);
  const gantts = useQueries({ queries: ids.map((id) => ({ queryKey: qk4.gantt(id), queryFn: () => api.projects.gantt(id), staleTime: 60_000 })) });
  const today = riyadhToday();
  const loading = projects.isLoading || gantts.some((g) => g.isLoading);
  const overdue = gantts.reduce((n, g) => {
    const tasks = g.data?.tasks ?? [];
    const parents = new Set(tasks.map((x) => x.parentId).filter(Boolean));
    return n + tasks.filter((x) => !parents.has(x.id) && x.status !== 'DONE' && x.endDate < today).length;
  }, 0);
  return (
    <Card className="nz-kpi-card" data-tone={overdue ? 'no' : undefined}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <SimpleGrid cols={2} spacing="md">
          <Stack gap={2}>
            <Text size="sm" c="dimmed">
              {t('dash.activeProjects')}
            </Text>
            {projects.isLoading ? <Skeleton h={40} w={60} /> : <Text className="nz-kpi">{formatNumber(projects.data?.length ?? 0)}</Text>}
          </Stack>
          <Stack gap={2}>
            <Text size="sm" c="dimmed">
              {t('dash.overdueTasks')}
            </Text>
            {loading ? <Skeleton h={40} w={60} /> : <Text className="nz-kpi" c={overdue ? 'var(--breach)' : 'dimmed'}>{formatNumber(overdue)}</Text>}
          </Stack>
        </SimpleGrid>
        <ThemeIcon size={40} radius="xl" variant="light" color={overdue ? 'breach' : 'field'} aria-hidden>
          <IconChartArcs size={22} />
        </ThemeIcon>
      </Group>
      <Button mt="md" fullWidth variant="light" onClick={() => navigate('/projects')}>
        {t('dash.openProjects')}
      </Button>
    </Card>
  );
}

export function MyTasksSummary() {
  const navigate = useNavigate();
  const tasks = useMyTasks();
  const counts = { overdue: 0, soon: 0, later: 0, done: 0 };
  for (const x of tasks.data ?? []) counts[bucketOf(x)]++;
  const open = counts.overdue + counts.soon + counts.later;
  return (
    <Card>
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <div>
          <Title order={2} fz="lg">
            {t('dash.myTasks')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('dash.myTasksLead')}
          </Text>
        </div>
        <ThemeIcon size={40} radius="xl" variant="light" color={counts.overdue ? 'breach' : 'field'} aria-hidden>
          <IconChecklist size={22} />
        </ThemeIcon>
      </Group>
      {tasks.isLoading ? (
        <Skeleton h={60} />
      ) : open ? (
        <SimpleGrid cols={3} spacing="xs">
          {(['overdue', 'soon', 'later'] as const).map((b) => (
            <Stack key={b} gap={0}>
              <Text size="sm" c="dimmed">
                {t(`myTasks.bucket.${b}`)}
              </Text>
              <Text className="nz-kpi" c={b === 'overdue' && counts.overdue ? 'var(--breach)' : undefined}>
                {formatNumber(counts[b])}
              </Text>
            </Stack>
          ))}
        </SimpleGrid>
      ) : (
        <Text c="dimmed">{t('dash.noMyTasks')}</Text>
      )}
      <Button mt="md" fullWidth variant={counts.overdue ? 'filled' : 'light'} onClick={() => navigate('/my-tasks')}>
        {t('dash.openMyTasks')}
      </Button>
    </Card>
  );
}
