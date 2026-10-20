/**
 * A12 — «كل المشاريع» on phones, in the style of the owner's Figma reference (Projects 0:1793) in
 * our identity: a large title with round actions, a search field with a filter button (sort), the
 * status as chips, and one large card per project — the cover (uploaded or generated) with a «⋮»
 * menu, the progress bar and %, the title with its status tag, the task count, the owner and the
 * dates. Data, favourites and the create form are the desktop page's (ProjectsPage passes them).
 */
import { Link, useNavigate } from 'react-router-dom';
import { ActionIcon, Drawer, Menu, Progress } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAdjustmentsHorizontal,
  IconCalendarEvent,
  IconChartBar,
  IconCheck,
  IconDotsVertical,
  IconExternalLink,
  IconFileImport,
  IconLayoutKanban,
  IconListCheck,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react';
import type { ProjectStatus } from '@nuzli/shared';
import type { ProjectView } from '../../api/hoursWire';
import { ProjectCover } from '../../features/projects/ProjectCover';
import { UserPhotoAvatar } from '../../components/UserAvatar';
import { formatDate, formatNumber, t, tCount } from '../../i18n';
import { PROJECT_STATUSES, projectStatusLabel } from './parts';

const TONE: Record<ProjectStatus, string> = { ACTIVE: 'brand', PLANNING: 'blue', ON_HOLD: 'wait', COMPLETED: 'live', ARCHIVED: 'grey' };

export function PhoneProjectCard({
  project,
  favourite,
  onToggleFavourite,
  admin,
}: {
  project: ProjectView;
  favourite: boolean;
  onToggleFavourite(): void;
  admin: boolean;
}) {
  const navigate = useNavigate();
  const to = `/projects/${project.id}`;
  const pct = Math.round(project.progress);
  return (
    <article className="nz-pc" aria-label={project.name}>
      <div className="nz-pc-cover">
        <Link to={to} tabIndex={-1} aria-hidden className="nz-pc-cover-link">
          <ProjectCover project={project} variant="card" />
        </Link>
        <Menu position="bottom-end" withinPortal shadow="md" width={220}>
          <Menu.Target>
            <ActionIcon className="nz-pc-menu" variant="white" size={44} radius={12} aria-label={t('mprojects.menu', { name: project.name })}>
              <IconDotsVertical size={20} stroke={2} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconExternalLink size={18} />} onClick={() => navigate(to)}>
              {t('mprojects.open')}
            </Menu.Item>
            <Menu.Item leftSection={<IconChartBar size={18} />} onClick={() => navigate(`${to}?view=gantt`)}>
              {t('mprojects.gantt')}
            </Menu.Item>
            <Menu.Item leftSection={<IconLayoutKanban size={18} />} onClick={() => navigate(`${to}?view=board`)}>
              {t('mprojects.board')}
            </Menu.Item>
            {admin ? (
              <Menu.Item leftSection={<IconSettings size={18} />} onClick={() => navigate(`${to}?panel=settings`)}>
                {t('mprojects.settings')}
              </Menu.Item>
            ) : null}
            <Menu.Divider />
            <Menu.Item leftSection={favourite ? <IconStarFilled size={18} style={{ color: '#F5A524' }} /> : <IconStar size={18} />} onClick={onToggleFavourite}>
              {favourite ? t('projects.unfavourite') : t('projects.favourite')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        {favourite ? (
          <span className="nz-pc-fav" aria-label={t('projects.favourites')}>
            <IconStarFilled size={14} aria-hidden />
          </span>
        ) : null}
      </div>
      <Link to={to} className="nz-pc-body" aria-label={t('projects.open', { name: project.name })}>
        <span className="nz-pc-progress">
          <Progress value={pct} color={pct >= 100 ? 'ok' : 'field'} size={8} radius="xl" aria-label={t('projects.progress')} style={{ flex: 1 }} />
          <b className="num">{t('mprojects.progressPct', { pct: formatNumber(pct) })}</b>
        </span>
        <span className="nz-pc-title">
          <h2>{project.name}</h2>
          <span className={`pill ${TONE[project.status]}`}>{projectStatusLabel(project.status)}</span>
        </span>
        <span className="nz-pc-line nz-pc-tasks">
          <IconListCheck size={18} stroke={1.7} aria-hidden />
          {tCount('projects.taskCount', project.taskCount)}
        </span>
        <span className="nz-pc-line">
          <UserPhotoAvatar user={project.owner} size={26} />
          <span className="nz-pc-owner">{project.owner.fullName}</span>
        </span>
        <span className="nz-pc-line">
          <IconCalendarEvent size={18} stroke={1.7} aria-hidden />
          {project.endDate
            ? t('projects.dates', { start: formatDate(project.startDate), end: formatDate(project.endDate.slice(0, 10)) })
            : t('projects.startsOn', { start: formatDate(project.startDate) })}
        </span>
      </Link>
    </article>
  );
}

type Sort = 'recent' | 'name' | 'start' | 'end' | 'progress' | 'budget';

/** Title row with round actions, search + filter button, status chips (phones). */
export function PhoneProjectsTools({
  search,
  setSearch,
  status,
  setStatus,
  sort,
  setSort,
  sorts,
  canCreate,
  onCreate,
}: {
  search: string;
  setSearch(v: string): void;
  status: string;
  setStatus(v: string): void;
  sort: Sort;
  setSort(v: Sort): void;
  sorts: readonly Sort[];
  canCreate: boolean;
  onCreate(): void;
}) {
  const [open, { open: show, close }] = useDisclosure(false);
  const chips = ['OPEN', ...PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED'), 'ARCHIVED', 'ALL'];
  const chipLabel = (s: string) => (s === 'OPEN' ? t('projects.filter.open') : s === 'ALL' ? t('projects.allStatuses') : projectStatusLabel(s));
  return (
    <>
      <div className="nz-mhead">
        <h1 tabIndex={-1}>{t('projects.allTitle')}</h1>
        {canCreate ? (
          <span className="nz-mhead-actions">
            <Link to="/projects/import" className="nz-roundbtn" aria-label={t('projects.import')}>
              <IconFileImport size={20} stroke={1.7} aria-hidden />
            </Link>
            <button type="button" className="nz-roundbtn primary" onClick={onCreate} aria-label={t('projects.createNew')}>
              <IconPlus size={22} stroke={2.1} aria-hidden />
            </button>
          </span>
        ) : null}
      </div>
      <div className="nz-msearch">
        <IconSearch size={20} stroke={1.7} aria-hidden />
        <input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder={t('projects.searchPlaceholder')}
          aria-label={t('projects.searchPlaceholder')}
        />
        <button type="button" className="nz-msearch-filter" onClick={show} aria-label={t('mprojects.filters')} aria-haspopup="dialog">
          <IconAdjustmentsHorizontal size={20} stroke={1.7} aria-hidden />
        </button>
      </div>
      <div className="nz-chips" role="radiogroup" aria-label={t('projects.filterStatus')}>
        {chips.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={status === s} className="nz-chip-btn" onClick={() => setStatus(s)}>
            {chipLabel(s)}
          </button>
        ))}
      </div>
      <Drawer
        opened={open}
        onClose={close}
        position="bottom"
        size="auto"
        title={t('projects.sort')}
        classNames={{ content: 'nz-sheet-content', header: 'nz-sheet-header', body: 'nz-sheet-body' }}
      >
        <ul className="nz-actions" role="radiogroup" aria-label={t('projects.sort')}>
          {sorts.map((s) => (
            <li key={s}>
              <button
                type="button"
                role="radio"
                aria-checked={sort === s}
                className="nz-action nz-action--pick"
                onClick={() => {
                  setSort(s);
                  close();
                }}
              >
                <span className="nz-action-text">
                  <b>{t(`projects.sort.${s}`)}</b>
                </span>
                {sort === s ? <IconCheck size={20} color="var(--accent)" aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      </Drawer>
    </>
  );
}
