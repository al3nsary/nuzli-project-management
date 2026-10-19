/**
 * The project page — GanttPRO's layout (owner screenshot 1), mirrored for RTL:
 * header (folder icon, editable name, favourite star, status select, menu) · tabs
 * (مخطط جانت · لوحة · قائمة · تقويم · عبء العمل · الأشخاص · لوحة المعلومات) · toolbar
 * (تراجع/إعادة · تحديد متعدد · توسيع الكل · طيّ الكل · ترتيب متسلسل · ملاءمة الشاشة · ملء
 * الشاشة · التصفية والتجميع · العروض المحفوظة · التكبير · تصدير) · the active view · the
 * bulk bar · the task drawer and the settings drawer. Drawers, the tab and the filter live in
 * the URL / view preferences so links and back work.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconArchive,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconBookmark,
  IconCalendarMonth,
  IconChartBar,
  IconChartDonut,
  IconChecks,
  IconChevronsDown,
  IconChevronsUp,
  IconDots,
  IconDownload,
  IconFileSpreadsheet,
  IconFileTypeCsv,
  IconFileTypePdf,
  IconFilter,
  IconFolder,
  IconLayoutKanban,
  IconListTree,
  IconTimeline,
  IconPalette,
  IconPhoto,
  IconSettings,
  IconSortAscending2,
  IconStar,
  IconStarFilled,
  IconTag,
  IconTemplate,
  IconTrash,
  IconUserCheck,
  IconUsers,
  IconX,
  IconZoomScan,
  IconChartArcs,
} from '@tabler/icons-react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { can, type PhotoUrlDto, type ProjectExportFormat, type Priority, type TaskDto, type TaskStatus } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError, errorMessage } from '../../api/errors';
import { useGantt } from '../../api/projectQueries';
import { useProjectWrites, type ProjectWrites } from '../../api/projectWrites';
import { invalidateProjectReads, useViewPref } from '../../api/a9Queries';
import { photoKey } from '../../api/photoQueries';
import { unitOf, type GanttView, type TaskView } from '../../api/hoursWire';
import { useSupervisors } from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { ErrorBlock, LoadingBlock } from '../../components/ui';
import { formatNumber, getDisplayPrefs, t, tCount } from '../../i18n';
import { Gantt, linkMessage, type AddTaskInput, type ReorderChange } from '../../features/gantt/Gantt';
import { DEFAULT_COLUMNS, normalizeColumns, type ColumnPref } from '../../features/gantt/columns';
import { dayOf, fitZoom, zoomsFor, type Zoom } from '../../features/gantt/geometry';
import { exportGanttPng, printGantt } from '../../features/gantt/exportGantt';
import { riyadhToday } from '../../features/projects/engine';
import {
  EMPTY_FILTER,
  NONE,
  activeCount,
  cascadeChanges,
  filterWithAncestors,
  groupFn,
  matchTask,
  normalizeFilter,
  type GroupBy,
  type TaskFilter,
} from '../../features/projects/filters';
import { inverseOf } from '../../features/projects/undo';
import { ListView } from './ListView';
import { BoardView } from './BoardView';
import { ConflictAlert, TaskDrawer } from './TaskDrawer';
import { ProjectSettingsDrawer } from './ProjectSettingsDrawer';
import { PRIORITIES, PROJECT_STATUSES, TASK_STATUSES, priorityLabel, projectStatusLabel, taskStatusLabel } from './parts';
import { ProjectCalendarTab } from './tabs/CalendarTab';
import { ProjectWorkloadTab } from './tabs/WorkloadTab';
import { ProjectPeopleTab } from './tabs/PeopleTab';
import { ProjectDashboardTab } from './tabs/DashboardTab';
import { useOverlayParam, useTabParam } from '../../lib/useUrlState';
import { TaskChatDrawer } from './TaskWorkspace';
import { useTaskChatCounts } from '../../features/tasks/TaskChatButton';
import { EDGE_SAFE_MIDDLEWARES } from '../../lib/floating';
import './projects.css';
import './a9-projects.css';

const VIEWS = ['gantt', 'board', 'list', 'calendar', 'workload', 'people', 'dashboard'] as const;
type View = (typeof VIEWS)[number];
const TAB_ICONS: Record<View, typeof IconChartBar> = {
  gantt: IconChartBar,
  board: IconLayoutKanban,
  list: IconListTree,
  calendar: IconCalendarMonth,
  workload: IconChartArcs,
  people: IconUsers,
  dashboard: IconChartDonut,
};
/** Views whose rows the toolbar acts on (select, expand, filter…). */
const TASK_VIEWS = new Set<View>(['gantt', 'board', 'list', 'calendar']);

interface SavedView {
  id: string;
  name: string;
  filter: TaskFilter;
  groupBy: GroupBy;
  zoom?: Zoom;
  columns?: ColumnPref[];
}

const BAR_SWATCHES = ['#303F9F', '#1565C0', '#00838F', '#2E7D32', '#9E9D24', '#F9A825', '#EF6C00', '#C62828', '#AD1457', '#6A1B9A', '#5D4037', '#546E7A'];

export function ProjectPage() {
  const { id = '' } = useParams();
  const [view, setView] = useTabParam<View>('view', VIEWS, 'gantt');
  const user = useAuthStore((s) => s.user);
  const gantt = useGantt(id);
  const writes = useProjectWrites(id);
  // Drawers live in the URL (?task=, ?panel=settings): deep links work and back closes them.
  const task = useOverlayParam('task', { drop: ['ttab'] });
  const panel = useOverlayParam('panel', { drop: ['stab'] });
  // A10: the task screen of the supervisor, opened from a row's chat icon (?chat=<taskId>).
  const chat = useOverlayParam('chat');
  const setOpenTask = useCallback((taskId: string | null) => (taskId ? task.open(taskId) : task.close()), [task]);
  const shellRef = useRef<HTMLDivElement>(null);

  // Filter, grouping and saved views (per user per project).
  const [filterRaw, setFilterPref] = useViewPref<TaskFilter>('gantt.filter', id || null, EMPTY_FILTER, Boolean(id));
  const [groupBy, setGroupBy] = useViewPref<GroupBy>('gantt.groupBy', id || null, 'none', Boolean(id));
  const filter = useMemo(() => normalizeFilter(filterRaw), [filterRaw]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [fullscreen, setFullscreen] = useState(false);

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z): undo / redo, never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const k = e.code;
      if (k === 'KeyZ' && !e.shiftKey) {
        e.preventDefault();
        if (writes.canUndo) void writes.undo();
      } else if (k === 'KeyY' || (k === 'KeyZ' && e.shiftKey)) {
        e.preventDefault();
        if (writes.canRedo) void writes.redo();
      } else if (k === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [writes]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  if (gantt.isLoading) return <LoadingBlock variant="gantt" header />;
  if (gantt.isError || !gantt.data) return <ErrorBlock error={gantt.error} onRetry={() => void gantt.refetch()} />;
  const data = gantt.data;
  const admin = can(user, 'projects.manage');

  return (
    <div className="nz-project-shell nz-ps" ref={shellRef} data-fullscreen={fullscreen || undefined}>
      <ProjectHeader data={data} admin={admin} onSettings={() => panel.open('settings')} />
      <Tabs value={view} onChange={(v) => setView(v)} keepMounted={false} className="nz-ps-tabs">
        <Tabs.List>
          {VIEWS.map((v) => {
            const Icon = TAB_ICONS[v];
            return (
              <Tabs.Tab key={v} value={v} leftSection={<Icon size={16} />}>
                {t(`project.tab.${v}`)}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      </Tabs>
      <ProjectBody
        key={id}
        view={view}
        data={data}
        writes={writes}
        onOpenTask={setOpenTask}
        onOpenChat={can(user, 'tasks.comment') ? chat.open : undefined}
        filter={filter}
        setFilter={setFilterPref}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        selecting={selecting}
        setSelecting={setSelecting}
        selected={selected}
        setSelected={setSelected}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        fullscreen={fullscreen}
        onFullscreen={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void shellRef.current?.requestFullscreen?.().catch(() => undefined);
        }}
      />
      <TaskDrawer data={data} taskId={task.value} writes={writes} onClose={task.close} />
      <TaskChatDrawer taskId={chat.value && data.tasks.some((x) => x.id === chat.value) ? chat.value : null} projectName={data.project.name} onClose={chat.close} />
      {admin ? <ProjectSettingsDrawer opened={panel.value === 'settings'} onClose={panel.close} project={data.project} data={data} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- header

function ProjectHeader({ data, admin, onSettings }: { data: GanttView; admin: boolean; onSettings(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const p = data.project;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [favourites, setFavourites] = useViewPref<string[]>('projects.favourites', null, []);
  const fav = favourites.includes(p.id);
  const [tplOpen, setTplOpen] = useState(false);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['gantt', p.id] });
    invalidateProjectReads(qc, p.id);
  };
  const saveName = async () => {
    setEditing(false);
    const v = name.trim();
    if (v.length < 2 || v === p.name) {
      setName(p.name);
      return;
    }
    try {
      await api.projects.update(p.id, { name: v });
      await refresh();
      notifications.show({ color: 'ok', message: t('project.renamed') });
    } catch (err) {
      setName(p.name);
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };
  const setStatus = async (status: string | null) => {
    if (!status || status === p.status) return;
    try {
      await api.projects.update(p.id, { status: status as typeof p.status });
      await refresh();
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };
  return (
    <header className="nz-ps-head">
      <span className="nz-pl-folder nz-ps-folder" aria-hidden>
        <IconFolder size={20} />
      </span>
      {editing ? (
        <TextInput
          autoFocus
          aria-label={t('project.rename')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveName();
            if (e.key === 'Escape') {
              setName(p.name);
              setEditing(false);
            }
          }}
          className="nz-ps-name-input"
        />
      ) : (
        <h1 tabIndex={-1} className="nz-ps-name" title={admin ? t('project.rename') : undefined} onClick={() => admin && setEditing(true)} data-editable={admin || undefined}>
          {p.name}
        </h1>
      )}
      <Tooltip label={fav ? t('projects.unfavourite') : t('projects.favourite')} withinPortal>
        <ActionIcon
          variant="subtle"
          color={fav ? 'yellow' : 'gray'}
          aria-pressed={fav}
          aria-label={fav ? t('projects.unfavourite') : t('projects.favourite')}
          onClick={() => setFavourites(fav ? favourites.filter((x) => x !== p.id) : [...favourites, p.id])}
        >
          {fav ? <IconStarFilled size={18} style={{ color: '#F5A524' }} /> : <IconStar size={18} />}
        </ActionIcon>
      </Tooltip>
      {admin ? (
        <Select
          aria-label={t('project.statusLabel')}
          size="xs"
          w={140}
          value={p.status}
          onChange={(v) => void setStatus(v)}
          allowDeselect={false}
          data={PROJECT_STATUSES.filter((s) => s !== 'ARCHIVED').map((s) => ({ value: s, label: projectStatusLabel(s) }))}
          classNames={{ input: 'nz-ps-status' }}
          data-status={p.status}
        />
      ) : null}
      {unitOf(p) === 'HOUR' ? <span className="pill brand">{t('projects.hourBadge')}</span> : null}
      <span className="nz-ps-spacer" />
      {admin ? (
        <Group gap={4} wrap="nowrap">
          <Button variant="default" size="xs" leftSection={<IconSettings size={16} />} onClick={onSettings}>
            {t('project.menu.settings')}
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="default" size={30} aria-label={t('project.menu')}>
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconTemplate size={16} />} onClick={() => setTplOpen(true)}>
                {t('project.menu.saveTemplate')}
              </Menu.Item>
              <Menu.Item leftSection={<IconSettings size={16} />} onClick={onSettings}>
                {t('project.menu.settings')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      ) : null}
      <SaveTemplateModal opened={tplOpen} onClose={() => setTplOpen(false)} projectId={p.id} projectName={p.name} />
    </header>
  );
}

function SaveTemplateModal({ opened, onClose, projectId, projectName }: { opened: boolean; onClose(): void; projectId: string; projectName: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opened) setName(`${projectName} (قالب)`.slice(0, 160));
  }, [opened, projectName]);
  const save = async () => {
    setBusy(true);
    try {
      const tpl = await api.projects.saveAsTemplate(projectId, { name: name.trim() || undefined });
      void qc.invalidateQueries({ queryKey: ['project-templates'] });
      notifications.show({ color: 'ok', message: t('project.savedTemplate', { name: tpl.name }) });
      onClose();
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t('project.saveTemplateTitle')} centered>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('project.saveTemplateBody')}
        </Text>
        <TextInput label={t('project.templateName')} value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            {t('project.saveTemplate')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- body: toolbar + view

interface BodyProps {
  view: View;
  data: GanttView;
  writes: ProjectWrites;
  onOpenTask(id: string): void;
  /** A10: opens the task chat screen; undefined when the viewer cannot write in task chats. */
  onOpenChat?(id: string): void;
  filter: TaskFilter;
  setFilter(f: TaskFilter): void;
  groupBy: GroupBy;
  setGroupBy(g: GroupBy): void;
  selecting: boolean;
  setSelecting(on: boolean): void;
  selected: Set<string>;
  setSelected(s: Set<string>): void;
  collapsed: Set<string>;
  setCollapsed(s: Set<string>): void;
  fullscreen: boolean;
  onFullscreen(): void;
}

function useAssigneePhotos(data: GanttView): Map<string, string> {
  const api = useApi();
  const ids = useMemo(() => [...new Set(data.tasks.map((x) => x.assignee?.id).filter((x): x is string => !!x))].slice(0, 40), [data.tasks]);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: photoKey({ kind: 'user', id }),
      queryFn: async (): Promise<PhotoUrlDto | null> => {
        try {
          return await api.photos.url({ kind: 'user', id });
        } catch {
          return null;
        }
      },
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    results.forEach((r, i) => {
      if (r.data?.url) m.set(ids[i]!, r.data.url);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.data?.url ?? '').join('|'), ids]);
}

function ProjectBody(p: BodyProps) {
  const { data, writes, view } = p;
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const editable = can(user, 'tasks.manage');
  const phone = useMediaQuery('(max-width: 767px)') ?? false;
  const unit = unitOf(data.project);
  const zooms = zoomsFor(unit);
  const [zoomPref, setZoomPref] = useViewPref<Zoom>(unit === 'HOUR' ? 'gantt.zoomHours' : 'gantt.zoom', data.project.id, unit === 'HOUR' ? 'day' : 'week');
  const zoom = zooms.includes(zoomPref) ? zoomPref : zooms[1]!;
  const [colsRaw, setColsPref] = useViewPref<ColumnPref[] | null>('gantt.columns', data.project.id, null);
  const [showLabels, setShowLabels] = useViewPref<boolean>('gantt.showLabels', data.project.id, false);
  const columns = useMemo(() => normalizeColumns(colsRaw ?? DEFAULT_COLUMNS, data.customFields ?? []), [colsRaw, data.customFields]);
  const phoneColumns = useMemo(() => [{ id: 'name' as const, width: 170 }, { id: 'chat' as const, width: 62 }], []);
  const chatCounts = useTaskChatCounts(data.project.id, data.tasks, Boolean(p.onOpenChat));
  const showHijri = user?.preferences.showHijri ?? false;
  const digits = getDisplayPrefs().digits;
  const viewRef = useRef({ fromDay: 0, toDay: 0, firstRow: 0, lastRow: 0 });
  const [exporting, setExporting] = useState(false);
  const photos = useAssigneePhotos(data);
  const timelineWidth = useRef(900);

  const labels = useMemo(() => new Map((data.labels ?? []).map((l) => [l.id, l])), [data.labels]);
  const fields = useMemo(() => new Map((data.customFields ?? []).map((f) => [f.id, f])), [data.customFields]);
  const filtering = activeCount(p.filter) > 0;
  const visible = useCallback((x: TaskDto) => matchTask(x, p.filter, fields), [p.filter, fields]);
  const grouping = useMemo(
    () =>
      groupFn(p.groupBy, {
        labels,
        fields,
        statusLabel: (s) => taskStatusLabel(s),
        priorityLabel: (x) => priorityLabel(x),
        words: { unassigned: t('filter.unassigned'), noLabel: t('filter.noLabel'), noTeam: t('filter.noTeam'), noValue: t('filter.noValue'), yes: t('common.yes'), no: t('common.no') },
      }),
    [p.groupBy, labels, fields],
  );
  const rowOptions = useMemo(() => ({ visible: filtering ? visible : undefined, groupBy: grouping }), [filtering, visible, grouping]);
  const filteredData = useMemo<GanttView>(() => (filtering ? { ...data, tasks: filterWithAncestors(data.tasks, visible) } : data), [data, filtering, visible]);

  const commit = useCallback(
    async (changes: TaskDto[]) => {
      const out = await writes.commitBatch(changes);
      if (!out.ok && !(out.error instanceof ApiError && out.error.code === 'CONFLICT_VERSION')) {
        notifications.show({ color: 'breach', message: errorMessage(out.error) });
      }
    },
    [writes],
  );

  const link = useCallback(
    async (predecessorId: string, successorId: string) => {
      try {
        const dep = await writes.run(() => api.dependencies.create(data.project.id, { predecessorId, successorId, type: 'FS', lagDays: 0 }));
        writes.merge(dep.affected);
        await writes.refresh();
        notifications.show({ color: 'ok', message: tCount('gantt.linkAdded', dep.affected.length) });
      } catch (err) {
        const msg =
          err instanceof ApiError && err.code === 'DEPENDENCY_CYCLE'
            ? linkMessage('cycle', (err.details as { path?: string[] } | undefined)?.path, data.tasks)
            : errorMessage(err);
        notifications.show({ color: 'breach', message: msg });
      }
    },
    [api, data, writes],
  );

  const addTask = useCallback(
    async (input: AddTaskInput) => {
      const parent = input.parentId ? data.tasks.find((x) => x.id === input.parentId) : null;
      const base = parent?.startDate ?? (data.project.startDate > riyadhToday() ? data.project.startDate : riyadhToday());
      const startDate = unit === 'HOUR' ? (base.length > 10 ? base : `${base}T09:00`) : base.slice(0, 10);
      try {
        await writes.createTask(
          {
            name: input.name,
            type: input.type,
            parentId: input.parentId,
            startDate,
            durationDays: input.type === 'MILESTONE' ? 0 : 1,
            ...(unit === 'HOUR' && input.type !== 'MILESTONE' ? { durationHours: 2 } : {}),
          },
          input.type === 'MILESTONE' ? t('grid.addMilestone') : t('undo.label.create'),
        );
      } catch (err) {
        notifications.show({ color: 'breach', message: errorMessage(err) });
      }
    },
    [data, writes, unit],
  );

  const deleteTask = useCallback(
    (id: string) => {
      const x = data.tasks.find((y) => y.id === id);
      if (!x) return;
      modals.openConfirmModal({
        title: t('grid.deleteTitle'),
        children: <Text size="sm">{t('grid.deleteBody', { name: x.name })}</Text>,
        labels: { confirm: t('grid.delete'), cancel: t('common.cancel') },
        confirmProps: { color: 'breach' },
        onConfirm: async () => {
          try {
            const res = await writes.archive([id]);
            p.setSelected(new Set([...p.selected].filter((s) => !res.archivedIds.includes(s))));
            notifications.show({ color: 'ok', message: tCount('grid.deleted', res.archivedIds.length) });
          } catch (err) {
            notifications.show({ color: 'breach', message: errorMessage(err) });
          }
        },
      });
    },
    [data.tasks, writes, p],
  );

  const duplicate = useCallback(
    async (id: string, withSubtasks: boolean) => {
      try {
        const res = await writes.duplicate(id, withSubtasks);
        notifications.show({ color: 'ok', message: tCount('grid.duplicated', res.tasks.length, { name: data.tasks.find((x) => x.id === id)?.name ?? '' }) });
      } catch (err) {
        notifications.show({ color: 'breach', message: errorMessage(err) });
      }
    },
    [writes, data.tasks],
  );

  const reorder = useCallback(
    async (c: ReorderChange) => {
      const x = data.tasks.find((y) => y.id === c.id);
      if (!x) return;
      try {
        const res = await writes.run(() => api.tasks.batch(data.project.id, { changes: [{ id: c.id, version: x.version, parentId: c.parentId, sortOrder: c.sortOrder }] }));
        await writes.refresh();
        writes.record(t('undo.label.reorder'), inverseOf(res.previous, res.tasks));
        notifications.show({ color: 'ok', message: t('grid.moved', { name: x.name }) });
      } catch (err) {
        notifications.show({ color: 'breach', message: errorMessage(err) });
      }
    },
    [api, data, writes],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      const x = data.tasks.find((y) => y.id === id);
      if (!x) return;
      try {
        await writes.updateTask(id, { version: x.version, name }, t('undo.label.rename'));
      } catch (err) {
        notifications.show({ color: 'breach', message: errorMessage(err) });
      }
    },
    [data.tasks, writes],
  );

  const cascade = async () => {
    const changes = cascadeChanges(data.tasks);
    if (!changes.length) {
      notifications.show({ color: 'ok', message: t('toolbar.cascadeDone') });
      return;
    }
    try {
      const res = await writes.run(() => api.tasks.batch(data.project.id, { changes }));
      await writes.refresh();
      writes.record(t('toolbar.cascade'), inverseOf(res.previous, res.tasks));
      notifications.show({ color: 'ok', message: t('toolbar.cascadeDone') });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const groups = useMemo(() => data.tasks.filter((x) => data.tasks.some((y) => y.parentId === x.id)).map((x) => x.id), [data.tasks]);

  const toggleHijri = async (on: boolean) => {
    try {
      const updated = await api.me.update({ preferences: { showHijri: on } });
      setUser(updated);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  const exportPng = async () => {
    setExporting(true);
    try {
      const v = viewRef.current;
      await exportGanttPng(
        { data, fromDay: v.fromDay, toDay: v.toDay, dayWidth: zoom === 'day' ? 26 : zoom === 'week' ? 12 : zoom === 'month' ? 4 : 1.6, zoom: zoom === 'hour' ? 'day' : zoom, showHijri, digits },
        `gantt-${riyadhToday()}.png`,
      );
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };
  const exportPdf = () => {
    const starts = data.tasks.map((x) => dayOf(x.startDate));
    const ends = data.tasks.map((x) => dayOf(x.endDate));
    const from = starts.length ? Math.min(...starts) : dayOf(data.project.startDate);
    const to = ends.length ? Math.max(...ends) : from + 30;
    const span = to - from;
    printGantt({ data, fromDay: from - 2, toDay: to + 2, zoom: span > 400 ? 'quarter' : span > 120 ? 'month' : span < 20 ? 'day' : 'week', showHijri, digits });
  };
  /** A9 exports (ADR-110): xlsx (RTL, never frozen), CSV (UTF-8 BOM) and MS Project XML. */
  const exportFile = async (format: ProjectExportFormat) => {
    setExporting(true);
    try {
      const blob = await api.projects.export(data.project.id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${riyadhToday()}${format === 'ganttpro' ? '-ganttpro.xlsx' : `.${format}`}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      notifications.show({ color: 'ok', message: t('gantt.exported', { format: t(`gantt.exportFormat.${format}`) }) });
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  const tabProps = { data: filtering ? filteredData : data, writes, onOpenTask: p.onOpenTask, visible: (x: TaskView) => (filtering ? visible(x) : true) };
  const taskView = TASK_VIEWS.has(view);

  return (
    <div className="nz-ps-body">
      {taskView ? (
        <div className="nz-ps-toolbar" role="toolbar" aria-label={t('toolbar.label')}>
          <ToolGroup>
            <ToolButton icon={<IconArrowBackUp size={18} className="mirror-rtl" />} label={writes.undoLabel ? t('undo.undoLabel', { label: writes.undoLabel }) : t('undo.nothing')} disabled={!writes.canUndo || writes.saving} onClick={() => void writes.undo()} text={phone ? undefined : t('undo.undo')} />
            <ToolButton icon={<IconArrowForwardUp size={18} className="mirror-rtl" />} label={writes.redoLabel ? t('undo.redoLabel', { label: writes.redoLabel }) : t('undo.nothingRedo')} disabled={!writes.canRedo || writes.saving} onClick={() => void writes.redo()} text={phone ? undefined : t('undo.redo')} />
          </ToolGroup>
          {editable && (view === 'gantt' || view === 'list') ? (
            <ToolGroup>
              <ToolButton
                icon={<IconChecks size={18} />}
                label={t('toolbar.select')}
                active={p.selecting}
                onClick={() => {
                  p.setSelecting(!p.selecting);
                  if (p.selecting) p.setSelected(new Set());
                }}
                text={phone ? undefined : t('toolbar.select')}
              />
            </ToolGroup>
          ) : null}
          {view === 'gantt' || view === 'list' ? (
            <ToolGroup>
              <ToolButton icon={<IconChevronsDown size={18} />} label={t('toolbar.expandAll')} onClick={() => p.setCollapsed(new Set())} text={phone ? undefined : t('toolbar.expandAll')} />
              <ToolButton icon={<IconChevronsUp size={18} />} label={t('toolbar.collapseAll')} onClick={() => p.setCollapsed(new Set(p.groupBy !== 'none' ? [] : groups))} text={phone ? undefined : t('toolbar.collapseAll')} />
              {editable ? <ToolButton icon={<IconSortAscending2 size={18} />} label={t('toolbar.cascadeHint')} onClick={() => void cascade()} text={phone ? undefined : t('toolbar.cascade')} disabled={writes.saving} /> : null}
            </ToolGroup>
          ) : null}
          {view === 'gantt' ? (
            <ToolGroup>
              <ToolButton icon={<IconZoomScan size={18} />} label={t('toolbar.fit')} onClick={() => setZoomPref(fitZoom(data.tasks, timelineWidth.current, unit))} text={phone ? undefined : t('toolbar.fit')} />
              <ToolButton icon={p.fullscreen ? <IconArrowsMinimize size={18} /> : <IconArrowsMaximize size={18} />} label={p.fullscreen ? t('toolbar.exitFullscreen') : t('toolbar.fullscreen')} onClick={p.onFullscreen} text={phone ? undefined : p.fullscreen ? t('toolbar.exitFullscreen') : t('toolbar.fullscreen')} />
            </ToolGroup>
          ) : null}
          <ToolGroup>
            <FilterPopover data={data} filter={p.filter} setFilter={p.setFilter} groupBy={p.groupBy} setGroupBy={p.setGroupBy} canGroup={view === 'gantt'} />
            {view === 'gantt' ? (
              <SavedViews
                projectId={data.project.id}
                current={{ filter: p.filter, groupBy: p.groupBy, zoom, columns }}
                apply={(v) => {
                  p.setFilter(v.filter);
                  p.setGroupBy(v.groupBy);
                  if (v.zoom && zooms.includes(v.zoom)) setZoomPref(v.zoom);
                  if (v.columns) setColsPref(v.columns);
                }}
              />
            ) : null}
          </ToolGroup>
          {view === 'gantt' ? (
            <ToolGroup>
              <SegmentedControl
                size="xs"
                aria-label={t('toolbar.zoom')}
                value={zoom}
                onChange={(v) => setZoomPref(v as Zoom)}
                data={zooms.map((z) => ({ value: z, label: t(`zoom.${z}`) }))}
              />
            </ToolGroup>
          ) : null}
          <span className="nz-ps-spacer" />
          {writes.saving ? (
            <Group gap={6} role="status">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">
                {t('gantt.saving')}
              </Text>
            </Group>
          ) : null}
          {view === 'gantt' ? (
            <Menu position="bottom-end" withinPortal closeOnItemClick={false}>
              <Menu.Target>
                <ActionIcon variant="subtle" size={32} aria-label={t('toolbar.more')}>
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item>
                  <Switch size="sm" label={t('gantt.hijri')} checked={showHijri} onChange={(e) => void toggleHijri(e.currentTarget.checked)} />
                </Menu.Item>
                <Menu.Item>
                  <Switch size="sm" label={t('gantt.showLabels')} checked={showLabels} onChange={(e) => setShowLabels(e.currentTarget.checked)} />
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
          {view === 'gantt' || view === 'list' ? (
            <Menu position="bottom-end" withinPortal width={290} middlewares={EDGE_SAFE_MIDDLEWARES}>
              <Menu.Target>
                <Button size="xs" variant="default" leftSection={exporting ? <Loader size={12} /> : <IconDownload size={16} />}>
                  {t('toolbar.export')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown className="nz-export-menu">
                {/* A10 (ADR-130): to the two project tools first, then tables, then image/document. */}
                <Menu.Label>{t('gantt.exportTo.title')}</Menu.Label>
                <ExportItem icon={<IconTimeline size={18} />} label={t('gantt.exportTo.ganttpro')} hint={t('gantt.exportTo.ganttproHint')} onClick={() => void exportFile('ganttpro')} testId="export-ganttpro" />
                <ExportItem icon={<IconListTree size={18} />} label={t('gantt.exportTo.msproject')} hint={t('gantt.exportTo.msprojectHint')} onClick={() => void exportFile('xml')} testId="export-xml" />
                <Menu.Divider />
                <Menu.Label>{t('gantt.exportTo.data')}</Menu.Label>
                <ExportItem icon={<IconFileSpreadsheet size={18} />} label={t('gantt.exportTo.excel')} hint={t('gantt.exportTo.excelHint')} onClick={() => void exportFile('xlsx')} testId="export-xlsx" />
                <ExportItem icon={<IconFileTypeCsv size={18} />} label={t('gantt.exportTo.csv')} hint={t('gantt.exportTo.csvHint')} onClick={() => void exportFile('csv')} testId="export-csv" />
                <Menu.Divider />
                <Menu.Label>{t('gantt.exportTo.image')}</Menu.Label>
                <ExportItem icon={<IconPhoto size={18} />} label={t('gantt.exportTo.png')} hint={t('gantt.exportTo.pngHint')} onClick={() => void exportPng()} testId="export-png" />
                <ExportItem icon={<IconFileTypePdf size={18} />} label={t('gantt.exportTo.pdf')} hint={t('gantt.exportTo.pdfHint')} onClick={exportPdf} testId="export-pdf" />
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </div>
      ) : null}
      {writes.conflict ? <ConflictAlert onRefresh={() => void writes.refresh()} /> : null}
      {p.selected.size && editable ? <BulkBar data={data} writes={writes} selected={p.selected} onClear={() => p.setSelected(new Set())} /> : null}
      {view === 'gantt' && p.groupBy !== 'none' ? (
        <Text size="xs" c="dimmed">
          {t('filter.groupedReadOnly')}
        </Text>
      ) : null}
      <div className="nz-project-view">
        {view === 'gantt' ? (
          data.tasks.length ? (
            <GanttWidth onWidth={(w) => (timelineWidth.current = w)}>
              <Gantt
                data={data}
                zoom={zoom}
                showHijri={showHijri}
                digits={digits}
                editable={editable}
                busy={writes.saving}
                columns={phone ? phoneColumns : columns}
                onColumnsChange={phone ? undefined : (cols) => setColsPref(cols.length ? cols : DEFAULT_COLUMNS)}
                rowOptions={rowOptions}
                collapsed={p.collapsed}
                onCollapsedChange={p.setCollapsed}
                selecting={p.selecting}
                selected={p.selected}
                onSelectionChange={
                  editable
                    ? (s) => {
                        p.setSelected(s);
                        if (s.size && !p.selecting) p.setSelecting(true);
                      }
                    : undefined
                }
                showLabels={showLabels}
                photos={photos}
                onOpenTask={p.onOpenTask}
                chatCounts={chatCounts}
                onOpenChat={p.onOpenChat}
                onCommit={(c) => void commit(c)}
                onLink={(a, b) => void link(a, b)}
                onLinkRefused={(msg) => notifications.show({ color: 'breach', message: msg })}
                onAddTask={editable ? addTask : undefined}
                onDeleteTask={editable ? deleteTask : undefined}
                onDuplicate={editable ? (id, sub) => void duplicate(id, sub) : undefined}
                onReorder={editable ? (c) => void reorder(c) : undefined}
                onRename={editable ? (id, name) => void rename(id, name) : undefined}
                onViewChange={(v) => (viewRef.current = v)}
              />
            </GanttWidth>
          ) : (
            <EmptyGantt editable={editable} onAdd={() => void addTask({ parentId: null, type: 'TASK', name: t('list.newTask') })} />
          )
        ) : view === 'list' ? (
          <ListView data={filteredData} writes={writes} onOpenTask={p.onOpenTask} chatCounts={chatCounts} onOpenChat={p.onOpenChat} selecting={p.selecting} selected={p.selected} onSelectionChange={p.setSelected} />
        ) : view === 'board' ? (
          <BoardView data={filteredData} writes={writes} onOpenTask={p.onOpenTask} chatCounts={chatCounts} onOpenChat={p.onOpenChat} />
        ) : view === 'calendar' ? (
          <ProjectCalendarTab {...tabProps} data={data} />
        ) : view === 'workload' ? (
          <ProjectWorkloadTab {...tabProps} data={data} />
        ) : view === 'people' ? (
          <ProjectPeopleTab {...tabProps} data={data} />
        ) : (
          <ProjectDashboardTab {...tabProps} data={data} />
        )}
      </div>
    </div>
  );
}

/** Measures the timeline width for «ملاءمة الشاشة». */
function GanttWidth({ children, onWidth }: { children: ReactNode; onWidth(w: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const body = el.querySelector('[data-testid=gantt-body]') as HTMLElement | null;
      onWidth(body?.clientWidth ?? el.clientWidth * 0.6);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidth]);
  return (
    <div ref={ref} style={{ height: '100%' }}>
      {children}
    </div>
  );
}

function ToolGroup({ children }: { children: ReactNode }) {
  return <div className="nz-ps-tgroup">{children}</div>;
}

function ToolButton({ icon, label, onClick, disabled, active, text }: { icon: ReactNode; label: string; onClick(): void; disabled?: boolean; active?: boolean; text?: string }) {
  const btn = (
    <button type="button" className="nz-ps-tool" aria-label={label} aria-pressed={active ?? undefined} data-active={active || undefined} disabled={disabled} onClick={onClick}>
      {icon}
      {text ? <span className="nz-ps-tool-text">{text}</span> : null}
    </button>
  );
  return (
    <Tooltip label={label} withinPortal openDelay={400}>
      {btn}
    </Tooltip>
  );
}

// ---------------------------------------------------------------- filter & grouping

function FilterPopover({
  data,
  filter,
  setFilter,
  groupBy,
  setGroupBy,
  canGroup,
}: {
  data: GanttView;
  filter: TaskFilter;
  setFilter(f: TaskFilter): void;
  groupBy: GroupBy;
  setGroupBy(g: GroupBy): void;
  canGroup: boolean;
}) {
  const count = activeCount(filter) + (groupBy !== 'none' && canGroup ? 1 : 0);
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of data.tasks) if (x.assignee) m.set(x.assignee.id, x.assignee.fullName);
    return [{ value: NONE, label: t('filter.unassigned') }, ...[...m].sort((a, b) => a[1].localeCompare(b[1], 'ar')).map(([value, label]) => ({ value, label }))];
  }, [data.tasks]);
  const teams = useMemo(() => {
    const s = new Set<string>();
    for (const x of data.tasks) if (x.assignee?.teamName) s.add(x.assignee.teamName);
    return [{ value: NONE, label: t('filter.noTeam') }, ...[...s].sort((a, b) => a.localeCompare(b, 'ar')).map((v) => ({ value: v, label: v }))];
  }, [data.tasks]);
  const labelOptions = [{ value: NONE, label: t('filter.noLabel') }, ...(data.labels ?? []).map((l) => ({ value: l.id, label: l.name }))];
  const fields = data.customFields ?? [];
  const field = filter.field ? fields.find((f) => f.id === filter.field!.id) : undefined;
  const set = (patch: Partial<TaskFilter>) => setFilter({ ...filter, ...patch });
  return (
    <Popover position="bottom-start" withinPortal shadow="md" width={340} trapFocus>
      <Popover.Target>
        <button type="button" className="nz-ps-tool" data-keep data-active={count > 0 || undefined} aria-label={t('toolbar.filter')}>
          <IconFilter size={18} />
          <span className="nz-ps-tool-text">{t('toolbar.filter')}</span>
          {count ? (
            <Badge size="xs" circle variant="filled">
              {formatNumber(count)}
            </Badge>
          ) : null}
        </button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text fw={700} size="sm">
            {t('filter.title')}
          </Text>
          <TextInput size="xs" label={t('filter.search')} value={filter.q} onChange={(e) => set({ q: e.currentTarget.value })} />
          <MultiSelect size="xs" label={t('filter.assignee')} data={people} value={filter.assignees} onChange={(v) => set({ assignees: v })} clearable searchable comboboxProps={{ withinPortal: false }} />
          <MultiSelect size="xs" label={t('filter.status')} data={TASK_STATUSES.map((s) => ({ value: s, label: taskStatusLabel(s) }))} value={filter.statuses} onChange={(v) => set({ statuses: v as TaskStatus[] })} clearable comboboxProps={{ withinPortal: false }} />
          <MultiSelect size="xs" label={t('filter.priority')} data={PRIORITIES.map((s) => ({ value: s, label: priorityLabel(s) }))} value={filter.priorities} onChange={(v) => set({ priorities: v as Priority[] })} clearable comboboxProps={{ withinPortal: false }} />
          <MultiSelect size="xs" label={t('filter.label')} data={labelOptions} value={filter.labels} onChange={(v) => set({ labels: v })} clearable comboboxProps={{ withinPortal: false }} />
          <MultiSelect size="xs" label={t('filter.team')} data={teams} value={filter.teams} onChange={(v) => set({ teams: v })} clearable comboboxProps={{ withinPortal: false }} />
          {fields.length ? (
            <Group gap="xs" grow align="flex-end">
              <Select
                size="xs"
                label={t('filter.field')}
                data={fields.map((f) => ({ value: f.id, label: f.name }))}
                value={filter.field?.id ?? null}
                onChange={(v) => set({ field: v ? { id: v, value: '' } : null })}
                clearable
                comboboxProps={{ withinPortal: false }}
              />
              {field ? (
                field.type === 'DROPDOWN' || field.type === 'CHECKBOX' ? (
                  <Select
                    size="xs"
                    label={t('filter.fieldValue')}
                    data={
                      field.type === 'CHECKBOX'
                        ? [
                            { value: 'true', label: t('common.yes') },
                            { value: 'false', label: t('common.no') },
                          ]
                        : [{ value: NONE, label: t('filter.noValue') }, ...field.options.map((o) => ({ value: o, label: o }))]
                    }
                    value={filter.field?.value || null}
                    onChange={(v) => set({ field: { id: field.id, value: v ?? '' } })}
                    comboboxProps={{ withinPortal: false }}
                  />
                ) : (
                  <TextInput size="xs" label={t('filter.fieldValue')} value={filter.field?.value ?? ''} onChange={(e) => set({ field: { id: field.id, value: e.currentTarget.value } })} />
                )
              ) : null}
            </Group>
          ) : null}
          {canGroup ? (
            <>
              <Divider my={4} />
              <Select
                size="xs"
                label={t('filter.groupBy')}
                value={groupBy}
                onChange={(v) => setGroupBy((v as GroupBy) ?? 'none')}
                allowDeselect={false}
                comboboxProps={{ withinPortal: false }}
                data={[
                  { value: 'none', label: t('filter.group.none') },
                  { value: 'assignee', label: t('filter.group.assignee') },
                  { value: 'status', label: t('filter.group.status') },
                  { value: 'priority', label: t('filter.group.priority') },
                  { value: 'label', label: t('filter.group.label') },
                  { value: 'team', label: t('filter.group.team') },
                  ...fields.map((f) => ({ value: `field:${f.id}`, label: `${t('filter.group.field')}: ${f.name}` })),
                ]}
              />
            </>
          ) : null}
          <Group justify="flex-end">
            <Button size="xs" variant="subtle" leftSection={<IconX size={14} />} onClick={() => (setFilter(EMPTY_FILTER), setGroupBy('none'))} disabled={!count}>
              {t('filter.clear')}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function SavedViews({ projectId, current, apply }: { projectId: string; current: Omit<SavedView, 'id' | 'name'>; apply(v: SavedView): void }) {
  const [views, setViews] = useViewPref<SavedView[]>('gantt.views', projectId, []);
  const [name, setName] = useState('');
  const save = () => {
    const n = name.trim();
    if (!n) return;
    setViews([...views.filter((v) => v.name !== n), { id: crypto.randomUUID(), name: n, ...current }]);
    setName('');
    notifications.show({ color: 'ok', message: t('views.saved', { name: n }) });
  };
  return (
    <Popover position="bottom-start" withinPortal shadow="md" width={300} trapFocus>
      <Popover.Target>
        <button type="button" className="nz-ps-tool" data-keep aria-label={t('toolbar.views')}>
          <IconBookmark size={18} />
          <span className="nz-ps-tool-text">{t('toolbar.views')}</span>
        </button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text fw={700} size="sm">
            {t('views.title')}
          </Text>
          {views.length ? (
            views.map((v) => (
              <Group key={v.id} justify="space-between" wrap="nowrap" gap={4}>
                <Button size="xs" variant="subtle" onClick={() => apply({ ...v, filter: normalizeFilter(v.filter) })} style={{ flex: 1 }} justify="flex-start">
                  {v.name}
                </Button>
                <ActionIcon size="sm" variant="subtle" color="breach" aria-label={t('views.delete', { name: v.name })} onClick={() => setViews(views.filter((x) => x.id !== v.id))}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ))
          ) : (
            <Text size="xs" c="dimmed">
              {t('views.empty')}
            </Text>
          )}
          <Divider />
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <TextInput size="xs" label={t('views.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && save()} style={{ flex: 1 }} />
            <Button size="xs" onClick={save} disabled={!name.trim()}>
              {t('views.save')}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

// ---------------------------------------------------------------- bulk bar

function BulkBar({ data, writes, selected, onClear }: { data: GanttView; writes: ProjectWrites; selected: Set<string>; onClear(): void }) {
  const supervisors = useSupervisors(true);
  const [shift, setShift] = useState<number | ''>(1);
  const ids = [...selected].filter((id) => data.tasks.some((x) => x.id === id));
  const run = async (patch: Parameters<ProjectWrites['bulk']>[1]) => {
    try {
      const res = await writes.bulk(ids, patch);
      notifications.show({ color: 'ok', message: tCount('bulk.done', res.tasks.length) });
    } catch (err) {
      notifications.show({ color: 'breach', message: err instanceof ApiError && err.code === 'CONFLICT_VERSION' ? t('gantt.conflict') : errorMessage(err) });
    }
  };
  const archive = () =>
    modals.openConfirmModal({
      title: t('bulk.archiveTitle'),
      children: <Text size="sm">{tCount('bulk.archiveBody', ids.length)}</Text>,
      labels: { confirm: t('bulk.archive'), cancel: t('common.cancel') },
      confirmProps: { color: 'breach' },
      onConfirm: async () => {
        try {
          await writes.archive(ids);
          onClear();
        } catch (err) {
          notifications.show({ color: 'breach', message: errorMessage(err) });
        }
      },
    });
  return (
    <div className="nz-bulk" role="region" aria-label={t('bulk.selected', { count: ids.length })}>
      <span className="nz-bulk-count">{t('bulk.selected', { count: ids.length })}</span>
      <Menu withinPortal position="bottom-start">
        <Menu.Target>
          <Button size="xs" variant="default" leftSection={<IconChecks size={15} />}>
            {t('bulk.status')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {TASK_STATUSES.map((s) => (
            <Menu.Item key={s} onClick={() => void run({ status: s })}>
              {taskStatusLabel(s)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <Menu withinPortal position="bottom-start">
        <Menu.Target>
          <Button size="xs" variant="default">
            {t('bulk.priority')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {PRIORITIES.map((s) => (
            <Menu.Item key={s} onClick={() => void run({ priority: s })}>
              {priorityLabel(s)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <Menu withinPortal position="bottom-start">
        <Menu.Target>
          <Button size="xs" variant="default" leftSection={<IconUserCheck size={15} />}>
            {t('bulk.assignee')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown mah={320} style={{ overflowY: 'auto' }}>
          <Menu.Item onClick={() => void run({ assigneeId: null })}>{t('bulk.unassign')}</Menu.Item>
          <Menu.Divider />
          {(supervisors.data ?? []).map((u) => (
            <Menu.Item key={u.id} onClick={() => void run({ assigneeId: u.id })}>
              {u.fullName}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      {(data.labels ?? []).length ? (
        <Menu withinPortal position="bottom-start">
          <Menu.Target>
            <Button size="xs" variant="default" leftSection={<IconTag size={15} />}>
              {t('bulk.labels')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('bulk.addLabel')}</Menu.Label>
            {(data.labels ?? []).map((l) => (
              <Menu.Item key={`a${l.id}`} leftSection={<span className="nz-label-swatch" style={{ background: l.color }} />} onClick={() => void run({ labelIdsAdd: [l.id] })}>
                {l.name}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Label>{t('bulk.removeLabel')}</Menu.Label>
            {(data.labels ?? []).map((l) => (
              <Menu.Item key={`r${l.id}`} leftSection={<span className="nz-label-swatch" style={{ background: l.color }} />} onClick={() => void run({ labelIdsRemove: [l.id] })}>
                {l.name}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      ) : null}
      <Menu withinPortal position="bottom-start">
        <Menu.Target>
          <Button size="xs" variant="default" leftSection={<IconPalette size={15} />}>
            {t('bulk.color')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <div className="nz-swatches">
            {BAR_SWATCHES.map((c) => (
              <button key={c} type="button" className="nz-swatch" style={{ background: c }} aria-label={c} onClick={() => void run({ barColor: c })} />
            ))}
          </div>
          <Menu.Item onClick={() => void run({ barColor: null })}>{t('bulk.noColor')}</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Popover withinPortal position="bottom-start" trapFocus shadow="md">
        <Popover.Target>
          <Button size="xs" variant="default">
            {t('bulk.shift')}
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <NumberInput size="xs" label={t('bulk.shiftDays')} value={shift} onChange={(v) => setShift(v === '' ? '' : Number(v))} min={-365} max={365} w={170} allowDecimal={false} />
            <Button size="xs" onClick={() => shift && void run({ shiftWorkingDays: Number(shift) })} disabled={!shift}>
              {t('bulk.shiftApply')}
            </Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
      <Button size="xs" variant="light" color="breach" leftSection={<IconArchive size={15} />} onClick={archive}>
        {t('bulk.archive')}
      </Button>
      <span className="nz-ps-spacer" />
      <Button size="xs" variant="subtle" leftSection={<IconX size={15} />} onClick={onClear}>
        {t('bulk.clear')}
      </Button>
    </div>
  );
}

function EmptyGantt({ editable, onAdd }: { editable: boolean; onAdd(): void }) {
  return (
    <div className="surface-card" style={{ padding: 48, textAlign: 'center' }}>
      <Text fw={700} fz="lg">
        {t('gantt.empty')}
      </Text>
      {editable ? (
        <>
          <Text c="dimmed" mt={4}>
            {t('gantt.emptyBody')}
          </Text>
          <Button mt="md" variant="light" onClick={onAdd}>
            {t('list.addTask')}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** One export choice: what it is and, under it, what it is for (A10). */
function ExportItem({ icon, label, hint, onClick, testId }: { icon: ReactNode; label: string; hint: string; onClick(): void; testId: string }) {
  return (
    <Menu.Item leftSection={icon} onClick={onClick} data-testid={testId}>
      <span className="nz-export-item">
        <span className="nz-export-item-label">{label}</span>
        <span className="nz-export-item-hint">{hint}</span>
      </span>
    </Menu.Item>
  );
}
