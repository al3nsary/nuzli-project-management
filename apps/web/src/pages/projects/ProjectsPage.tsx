import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconCalendarEvent, IconChevronRight, IconLayoutKanban, IconPlus, IconSearch } from '@tabler/icons-react';
import { can, createProjectSchema, type ProjectDto, type ProjectListQuery } from '@nuzli/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { useCalendars, useProjects } from '../../api/projectQueries';
import { useAuthStore } from '../../stores/auth';
import { useZodForm } from '../../forms/useZodForm';
import { EmptyState, ErrorBlock, FormError, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatNumber, t } from '../../i18n';
import { riyadhToday } from '../../features/projects/engine';
import './projects.css';
import { ProgressLine, ProjectStatusBadge, PROJECT_STATUSES, projectStatusLabel } from './parts';
import { useOverlayParam } from '../../lib/useUrlState';

type Filter = 'OPEN' | 'ALL' | NonNullable<ProjectListQuery['status']>;

export function ProjectCard({ project }: { project: ProjectDto }) {
  return (
    <UnstyledButton component={Link} to={`/projects/${project.id}`} className="surface-card nz-project-card" aria-label={t('projects.open', { name: project.name })}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <Text fw={700} fz="lg" lh={1.35} className="nz-clamp-2">
          {project.name}
        </Text>
        <ProjectStatusBadge status={project.status} />
      </Group>
      <Group gap={6} mt={6} c="dimmed" wrap="nowrap">
        <IconCalendarEvent size={16} aria-hidden />
        <Text size="sm">
          {project.endDate
            ? t('projects.dates', { start: formatDate(project.startDate), end: formatDate(project.endDate) })
            : t('projects.startsOn', { start: formatDate(project.startDate) })}
        </Text>
      </Group>
      <div style={{ marginBlockStart: 12 }}>
        <ProgressLine value={project.progress} label={t('projects.progress')} />
      </div>
      <Group justify="space-between" mt="sm" gap="xs" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {t('projects.taskCount', { count: formatNumber(project.taskCount) })}
        </Text>
        <IconChevronRight size={16} className="mirror-rtl" aria-hidden color="var(--muted)" />
      </Group>
    </UnstyledButton>
  );
}

export function ProjectsPage() {
  const user = useAuthStore((s) => s.user);
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 250);
  // «إنشاء» is a URL (?create=1): the command palette opens it, and back closes it.
  const create = useOverlayParam('create');
  const creating = create.value === '1';
  const setCreating = (on: boolean) => (on ? create.open('1') : create.close());
  const query: ProjectListQuery = {
    ...(filter === 'OPEN' ? {} : { status: filter }),
    ...(q.trim() ? { q: q.trim() } : {}),
  };
  const projects = useProjects(query);
  const canCreate = can(user, 'projects.create');

  return (
    <>
      <PageHeader
        title={t('nav.projects')}
        lead={canCreate ? t('projects.leadAdmin') : t('projects.leadSupervisor')}
        actions={
          canCreate ? (
            <Button leftSection={<IconPlus size={18} />} onClick={() => setCreating(true)}>
              {t('projects.create')}
            </Button>
          ) : undefined
        }
      />
      <Group gap="sm" mb="md" wrap="wrap">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t('projects.search')}
          aria-label={t('projects.search')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ flex: '1 1 220px', maxWidth: 360 }}
        />
        <SegmentedControl
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: 'OPEN', label: t('projects.filter.open') },
            { value: 'ACTIVE', label: projectStatusLabel('ACTIVE') },
            { value: 'PLANNING', label: projectStatusLabel('PLANNING') },
            { value: 'COMPLETED', label: projectStatusLabel('COMPLETED') },
            ...(canCreate ? [{ value: 'ARCHIVED', label: projectStatusLabel('ARCHIVED') }] : []),
          ]}
        />
      </Group>
      {projects.isLoading ? (
        <LoadingBlock variant="cards" />
      ) : projects.isError ? (
        <ErrorBlock error={projects.error} onRetry={() => void projects.refetch()} />
      ) : projects.data?.length ? (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {projects.data.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </SimpleGrid>
      ) : (
        <EmptyState
          icon={IconLayoutKanban}
          title={t('projects.empty')}
          body={canCreate ? t('projects.emptyAdmin') : t('projects.emptySupervisor')}
          action={canCreate ? { label: t('projects.create'), onClick: () => setCreating(true) } : undefined}
        />
      )}
      {canCreate ? <CreateProjectDialog opened={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function CreateProjectDialog({ opened, onClose }: { opened: boolean; onClose(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const calendars = useCalendars(opened);
  const [error, setError] = useState<unknown>(null);
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const form = useZodForm(createProjectSchema, {
    name: '',
    description: '',
    startDate: riyadhToday(),
    autoSchedule: true,
    status: 'PLANNING' as const,
  });
  const submit = form.onSubmit(async (data) => {
    setError(null);
    try {
      const p = await api.projects.create({ ...data, ...(calendarId ? { calendarId } : {}) });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      notifications.show({ color: 'ok', message: t('projects.created', { name: p.name }) });
      // Replace the ?create=1 entry: back from the new project returns to the list.
      navigate(`/projects/${p.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) form.setErrors(err.fieldErrors);
      setError(err);
    }
  });
  const calendarOptions = (calendars.data ?? []).map((c) => ({ value: c.id, label: c.isDefault ? t('calendars.defaultName', { name: c.name }) : c.name }));
  return (
    <Modal opened={opened} onClose={onClose} title={t('projects.create')} size="lg">
      <form onSubmit={submit} noValidate>
        <Stack>
          <FormError error={error} />
          <TextInput label={t('projects.name')} required data-autofocus {...form.getInputProps('name')} />
          <Textarea label={t('projects.description')} autosize minRows={2} {...form.getInputProps('description')} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput type="date" label={t('projects.startDate')} required {...form.getInputProps('startDate')} />
            <Select
              label={t('projects.status')}
              data={PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((s) => ({ value: s, label: projectStatusLabel(s) }))}
              allowDeselect={false}
              {...form.getInputProps('status')}
            />
          </SimpleGrid>
          <Select
            label={t('projects.calendar')}
            description={t('projects.calendarHint')}
            placeholder={t('projects.calendarDefault')}
            data={calendarOptions}
            clearable
            value={calendarId}
            onChange={setCalendarId}
          />
          <Switch
            label={t('projects.autoSchedule')}
            description={t('projects.autoScheduleHint')}
            checked={Boolean(form.values.autoSchedule)}
            onChange={(e) => form.setFieldValue('autoSchedule', e.currentTarget.checked)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.submitting}>
              {t('projects.createSubmit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
