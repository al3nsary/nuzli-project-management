/**
 * «كل المشاريع» (owner request A9, GanttPRO's «All projects»): folder rows (or cards) with the
 * favourite star (per user, `/me/view-prefs` key `projects.favourites`), status, progress, dates,
 * budget used %, search, status filter and sort. «+ إنشاء مشروع جديد» opens the create form
 * (`?create=1`, also from the sidebar and the command palette).
 */
import { useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ActionIcon, Button, Group, Progress, SegmentedControl, Select, SimpleGrid, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import {
  IconCalendarEvent,
  IconChevronRight,
  IconClockHour4,
  IconFolder,
  IconLayoutGrid,
  IconLayoutKanban,
  IconLayoutList,
  IconFileImport,
  IconPlus,
  IconSearch,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react';
import { can, type ProjectDto, type ProjectListQuery } from '@nuzli/shared';
import { useProjects } from '../../api/projectQueries';
import { useViewPref } from '../../api/a9Queries';
import { unitOf, type ProjectView } from '../../api/hoursWire';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatMoney, formatNumber, t } from '../../i18n';
import { useOverlayParam } from '../../lib/useUrlState';
import { ProgressLine, ProjectStatusBadge, PROJECT_STATUSES, projectStatusLabel } from './parts';
import { CreateProjectDialog } from './CreateProjectDialog';
import './projects.css';
import './a9-projects.css';

type Sort = 'recent' | 'name' | 'start' | 'end' | 'progress' | 'budget';
type Layout = 'rows' | 'cards';

const FAV_KEY = 'projects.favourites';

function dates(p: ProjectDto) {
  return p.endDate
    ? t('projects.dates', { start: formatDate(p.startDate), end: formatDate(p.endDate.slice(0, 10)) })
    : t('projects.startsOn', { start: formatDate(p.startDate) });
}

/** % of the budget used, coloured by state: amber over 90 %, red over 100 %. */
function BudgetMeter({ project, compact }: { project: ProjectView; compact?: boolean }) {
  if (project.budget == null) {
    return (
      <Text size="xs" c="dimmed">
        {t('projects.noBudget')}
      </Text>
    );
  }
  const pct = project.budgetUsedPct ?? 0;
  const tone = pct > 100 ? 'breach' : pct > 90 ? 'signal' : 'field';
  return (
    <div className="nz-pl-budget" title={`${formatMoney(project.actualCost ?? 0, project.currency)} / ${formatMoney(project.budget, project.currency)}`}>
      <Progress value={Math.min(100, pct)} color={tone} size="sm" radius="xl" aria-label={t('projects.col.budget')} />
      <Text size="xs" className="num" c={pct > 100 ? 'var(--red)' : 'dimmed'} fw={pct > 100 ? 600 : 400}>
        {compact ? `${formatNumber(Math.round(pct))}٪` : t('projects.budgetUsed', { pct: formatNumber(Math.round(pct)) })}
      </Text>
    </div>
  );
}

function Star({ on, onToggle, name }: { on: boolean; onToggle(): void; name: string }) {
  return (
    <Tooltip label={on ? t('projects.unfavourite') : t('projects.favourite')} withinPortal>
      <ActionIcon
        variant="subtle"
        color={on ? 'yellow' : 'gray'}
        aria-pressed={on}
        aria-label={`${on ? t('projects.unfavourite') : t('projects.favourite')}: ${name}`}
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        className="nz-star"
      >
        {on ? <IconStarFilled size={17} style={{ color: '#F5A524' }} /> : <IconStar size={17} />}
      </ActionIcon>
    </Tooltip>
  );
}

export function ProjectCard({ project, favourite, onToggleFavourite }: { project: ProjectView; favourite?: boolean; onToggleFavourite?: () => void }) {
  return (
    <UnstyledButton component={Link} to={`/projects/${project.id}`} className="surface-card nz-project-card" aria-label={t('projects.open', { name: project.name })}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <span className="nz-pl-folder" aria-hidden>
            <IconFolder size={18} />
          </span>
          <Text fw={700} fz="md" lh={1.35} className="nz-clamp-2">
            {project.name}
          </Text>
        </Group>
        {onToggleFavourite ? <Star on={Boolean(favourite)} onToggle={onToggleFavourite} name={project.name} /> : <ProjectStatusBadge status={project.status} />}
      </Group>
      <Group gap={6} mt={8} wrap="wrap">
        {onToggleFavourite ? <ProjectStatusBadge status={project.status} /> : null}
        {unitOf(project) === 'HOUR' ? (
          <span className="pill brand">
            <IconClockHour4 size={12} aria-hidden /> {t('projects.hourBadge')}
          </span>
        ) : null}
      </Group>
      <Group gap={6} mt={8} c="dimmed" wrap="nowrap">
        <IconCalendarEvent size={16} aria-hidden />
        <Text size="sm">{dates(project)}</Text>
      </Group>
      <div style={{ marginBlockStart: 12 }}>
        <ProgressLine value={project.progress} label={t('projects.progress')} />
      </div>
      <div style={{ marginBlockStart: 10 }}>
        <BudgetMeter project={project} />
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

function sortProjects(list: ProjectView[], sort: Sort): ProjectView[] {
  const out = [...list];
  switch (sort) {
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    case 'start':
      return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
    case 'end':
      return out.sort((a, b) => (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999'));
    case 'progress':
      return out.sort((a, b) => b.progress - a.progress);
    case 'budget':
      return out.sort((a, b) => (b.budgetUsedPct ?? -1) - (a.budgetUsedPct ?? -1));
    default:
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function ProjectsPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const phone = useMediaQuery('(max-width: 767px)') ?? false;
  const [status, setStatus] = useState<string>('OPEN');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search, 250);
  const [sort, setSort] = useViewPref<Sort>('projects.sort', null, 'recent');
  const [layoutPref, setLayout] = useViewPref<Layout>('projects.layout', null, 'rows');
  const layout: Layout = phone ? 'cards' : layoutPref;
  const [favourites, setFavourites] = useViewPref<string[]>(FAV_KEY, null, []);
  // «إنشاء» is a URL (?create=1): the sidebar button and the command palette open it, back closes it.
  const create = useOverlayParam('create');
  const creating = create.value === '1';
  const setCreating = (on: boolean) => (on ? create.open('1') : create.close());
  const query: ProjectListQuery = {
    ...(status === 'OPEN' ? {} : { status: status as ProjectListQuery['status'] }),
    ...(q.trim() ? { q: q.trim() } : {}),
  };
  const projects = useProjects(query);
  const canCreate = can(user, 'projects.create');
  const favSet = useMemo(() => new Set(favourites), [favourites]);
  const toggleFav = (id: string) => setFavourites(favSet.has(id) ? favourites.filter((x) => x !== id) : [...favourites, id]);

  const sorted = useMemo(() => sortProjects(projects.data ?? [], sort), [projects.data, sort]);
  const favs = sorted.filter((p) => favSet.has(p.id));
  const others = sorted.filter((p) => !favSet.has(p.id));

  const section = (title: string, list: ProjectView[], key: string) =>
    list.length ? (
      <section key={key} aria-labelledby={`pl-${key}`} className="nz-pl-section">
        <h2 id={`pl-${key}`} className="nz-pl-heading">
          {key === 'fav' ? <IconStarFilled size={14} style={{ color: '#F5A524' }} aria-hidden /> : <IconFolder size={14} aria-hidden />}
          {title}
          <span className="nz-pl-count num">{formatNumber(list.length)}</span>
        </h2>
        {layout === 'cards' ? (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {list.map((p) => (
              <ProjectCard key={p.id} project={p} favourite={favSet.has(p.id)} onToggleFavourite={() => toggleFav(p.id)} />
            ))}
          </SimpleGrid>
        ) : (
          <div className="nz-pl-table" role="table" aria-labelledby={`pl-${key}`}>
            <div className="nz-pl-row nz-pl-head" role="row">
              <span role="columnheader" className="nz-pl-c-star" aria-label={t('projects.favourites')} />
              <span role="columnheader">{t('projects.col.name')}</span>
              <span role="columnheader">{t('projects.col.status')}</span>
              <span role="columnheader">{t('projects.col.progress')}</span>
              <span role="columnheader">{t('projects.col.dates')}</span>
              <span role="columnheader">{t('projects.col.budget')}</span>
              <span role="columnheader">{t('projects.col.owner')}</span>
            </div>
            {list.map((p) => (
              <div
                key={p.id}
                className="nz-pl-row"
                role="row"
                tabIndex={0}
                onClick={() => navigate(`/projects/${p.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(`/projects/${p.id}`);
                }}
                aria-label={t('projects.open', { name: p.name })}
              >
                <span role="cell" className="nz-pl-c-star">
                  <Star on={favSet.has(p.id)} onToggle={() => toggleFav(p.id)} name={p.name} />
                </span>
                <span role="cell" className="nz-pl-c-name">
                  <span className="nz-pl-folder" aria-hidden>
                    <IconFolder size={18} />
                  </span>
                  <span className="nz-pl-name-text">
                    <Link to={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()} className="nz-pl-link">
                      {p.name}
                    </Link>
                    <Text size="xs" c="dimmed">
                      {t('projects.taskCount', { count: formatNumber(p.taskCount) })}
                      {unitOf(p) === 'HOUR' ? ` · ${t('projects.hourBadge')}` : ''}
                    </Text>
                  </span>
                </span>
                <span role="cell">
                  <ProjectStatusBadge status={p.status} />
                </span>
                <span role="cell">
                  <ProgressLine value={p.progress} label={t('projects.progress')} />
                </span>
                <span role="cell">
                  <Text size="sm" c="dimmed">
                    {dates(p)}
                  </Text>
                </span>
                <span role="cell">
                  <BudgetMeter project={p} compact />
                </span>
                <span role="cell">
                  <Text size="sm" truncate>
                    {p.owner.fullName}
                  </Text>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    ) : null;

  return (
    <>
      <PageHeader
        title={t('projects.allTitle')}
        lead={t('projects.lead')}
        actions={
          canCreate ? (
            <Group gap="xs">
              <Button component={Link} to="/projects/import" variant="default" leftSection={<IconFileImport size={18} />}>
                {t('projects.import')}
              </Button>
              <Button leftSection={<IconPlus size={18} />} onClick={() => setCreating(true)}>
                {t('projects.createNew')}
              </Button>
            </Group>
          ) : undefined
        }
      />
      <div className="nz-pl-tools">
        <TextInput
          leftSection={<IconSearch size={16} />}
          placeholder={t('projects.searchPlaceholder')}
          aria-label={t('projects.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          className="nz-pl-search"
        />
        <Select
          aria-label={t('projects.filterStatus')}
          value={status}
          onChange={(v) => setStatus(v ?? 'OPEN')}
          allowDeselect={false}
          data={[
            { value: 'OPEN', label: t('projects.filter.open') },
            ...PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((s) => ({ value: s, label: projectStatusLabel(s) })),
            { value: 'ARCHIVED', label: projectStatusLabel('ARCHIVED') },
            { value: 'ALL', label: t('projects.allStatuses') },
          ]}
          w={170}
        />
        <Select
          aria-label={t('projects.sort')}
          leftSection={<Text size="xs" c="dimmed" px={6}>{t('projects.sort')}</Text>}
          leftSectionWidth={64}
          value={sort}
          onChange={(v) => setSort((v as Sort) ?? 'recent')}
          allowDeselect={false}
          data={(['recent', 'name', 'start', 'end', 'progress', 'budget'] as const).map((s) => ({ value: s, label: t(`projects.sort.${s}`) }))}
          w={230}
        />
        {!phone ? (
          <SegmentedControl
            aria-label={t('projects.view.rows')}
            value={layout}
            onChange={(v) => setLayout(v as Layout)}
            data={[
              { value: 'rows', label: <IconLayoutList size={16} aria-label={t('projects.view.rows')} /> },
              { value: 'cards', label: <IconLayoutGrid size={16} aria-label={t('projects.view.cards')} /> },
            ]}
          />
        ) : null}
      </div>
      {projects.isLoading ? (
        <LoadingBlock variant={layout === 'cards' ? 'cards' : 'table'} />
      ) : projects.isError ? (
        <ErrorBlock error={projects.error} onRetry={() => void projects.refetch()} />
      ) : sorted.length ? (
        <>
          {section(t('projects.favourites'), favs, 'fav')}
          {section(favs.length ? t('projects.others') : t('projects.allTitle'), others, 'all')}
        </>
      ) : q.trim() || status !== 'OPEN' ? (
        <EmptyState icon={IconSearch} title={t('projects.noMatch')} body={t('projects.noMatchBody')} />
      ) : (
        <EmptyState
          icon={IconLayoutKanban}
          title={t('projects.empty')}
          body={canCreate ? t('projects.emptyAdmin') : t('projects.emptySupervisor')}
          action={canCreate ? { label: t('projects.createNew'), onClick: () => setCreating(true) } : undefined}
        />
      )}
      {canCreate ? <CreateProjectDialog opened={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}
