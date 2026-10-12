import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  Switch,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconChartBar,
  IconDownload,
  IconFileSpreadsheet,
  IconFileTypePdf,
  IconHelpCircle,
  IconLayoutKanban,
  IconListTree,
  IconPhoto,
  IconPlus,
  IconSettings,
} from '@tabler/icons-react';
import { can, type TaskDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useGantt } from '../../api/projectQueries';
import { useProjectWrites } from '../../api/projectWrites';
import { useAuthStore } from '../../stores/auth';
import { ErrorBlock, LoadingBlock } from '../../components/ui';
import { formatDate, formatNumber, getDisplayPrefs, t } from '../../i18n';
import { Gantt, gridWidth, linkMessage, type GridMode } from '../../features/gantt/Gantt';
import { ZOOMS, dayOf, type Zoom } from '../../features/gantt/geometry';
import { exportGanttPng, printGantt } from '../../features/gantt/exportGantt';
import { riyadhToday } from '../../features/projects/engine';
import { ApiError } from '../../api/errors';
import { ListView } from './ListView';
import { BoardView } from './BoardView';
import { ConflictAlert, TaskDrawer } from './TaskDrawer';
import { ProjectSettingsDrawer } from './ProjectSettingsDrawer';
import { ProgressLine, ProjectStatusBadge } from './parts';
import './projects.css';
import { useOverlayParam, useTabParam } from '../../lib/useUrlState';

type View = 'gantt' | 'list' | 'board';

export function ProjectPage() {
  const { id = '' } = useParams();
  const [view, setView] = useTabParam<View>('view', ['gantt', 'list', 'board'], 'gantt');
  const user = useAuthStore((s) => s.user);
  const gantt = useGantt(id);
  const writes = useProjectWrites(id);
  // Drawers live in the URL (?task=, ?panel=settings): deep links work and back closes them.
  const task = useOverlayParam('task', { drop: ['ttab'] });
  const panel = useOverlayParam('panel');
  const setOpenTask = (taskId: string | null) => (taskId ? task.open(taskId) : task.close());

  if (gantt.isLoading) return <LoadingBlock variant="gantt" header />;
  if (gantt.isError || !gantt.data) return <ErrorBlock error={gantt.error} onRetry={() => void gantt.refetch()} />;
  const data = gantt.data;
  const admin = can(user, 'projects.manage');

  return (
    <div className="nz-project-shell">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <Group gap="sm" wrap="wrap">
            <Title order={1} fz="xl" tabIndex={-1}>
              {data.project.name}
            </Title>
            <ProjectStatusBadge status={data.project.status} />
          </Group>
          <Group gap="lg" mt={4} wrap="wrap">
            <Text size="sm" c="dimmed">
              {data.project.endDate
                ? t('projects.dates', { start: formatDate(data.project.startDate), end: formatDate(data.project.endDate) })
                : t('projects.startsOn', { start: formatDate(data.project.startDate) })}
            </Text>
            <Text size="sm" c="dimmed">
              {t('projects.taskCount', { count: formatNumber(data.project.taskCount) })} · {data.calendar.name}
              {data.project.autoSchedule ? '' : ` · ${t('projects.manualSchedule')}`}
            </Text>
            <div style={{ width: 180 }}>
              <ProgressLine value={data.project.progress} label={t('projects.progress')} />
            </div>
          </Group>
        </div>
        {admin ? (
          <Button variant="default" leftSection={<IconSettings size={18} />} onClick={() => panel.open('settings')}>
            {t('projects.settings')}
          </Button>
        ) : null}
      </Group>

      <Tabs value={view} onChange={setView} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="gantt" leftSection={<IconChartBar size={16} />}>
            {t('projects.view.gantt')}
          </Tabs.Tab>
          <Tabs.Tab value="list" leftSection={<IconListTree size={16} />}>
            {t('projects.view.list')}
          </Tabs.Tab>
          <Tabs.Tab value="board" leftSection={<IconLayoutKanban size={16} />}>
            {t('projects.view.board')}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <div className="nz-project-view">
        {view === 'gantt' ? (
          <GanttView data={data} writes={writes} onOpenTask={setOpenTask} />
        ) : view === 'list' ? (
          <ListView data={data} writes={writes} onOpenTask={setOpenTask} />
        ) : (
          <BoardView data={data} writes={writes} onOpenTask={setOpenTask} />
        )}
      </div>

      <TaskDrawer data={data} taskId={task.value} writes={writes} onClose={task.close} />
      {admin ? <ProjectSettingsDrawer opened={panel.value === 'settings'} onClose={panel.close} project={data.project} /> : null}
    </div>
  );
}

const ZOOM_KEY = 'nz.gantt.zoom';
const COLS_KEY = 'nz.gantt.cols';
const readPref = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const writePref = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    // private mode
  }
};

function GanttView({ data, writes, onOpenTask }: { data: NonNullable<ReturnType<typeof useGantt>['data']>; writes: ReturnType<typeof useProjectWrites>; onOpenTask(id: string): void }) {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const editable = can(user, 'tasks.manage');
  const phone = useMediaQuery('(max-width: 767px)') ?? false;
  const wide = useMediaQuery('(min-width: 1500px)') ?? false;
  const [zoom, setZoomState] = useState<Zoom>(() => readPref<Zoom>(ZOOM_KEY, ZOOMS, 'week'));
  const [cols, setColsState] = useState<GridMode | null>(() => {
    const v = readPref<GridMode | 'auto'>(COLS_KEY, ['full', 'compact', 'narrow', 'auto'], 'auto');
    return v === 'auto' ? null : v;
  });
  const gridMode: GridMode = phone ? 'narrow' : (cols ?? (wide ? 'full' : 'compact'));
  const showHijri = user?.preferences.showHijri ?? false;
  const digits = getDisplayPrefs().digits;
  const viewRef = useRef({ fromDay: 0, toDay: 0, firstRow: 0, lastRow: 0 });
  const [exporting, setExporting] = useState(false);

  const setZoom = (z: Zoom) => {
    setZoomState(z);
    writePref(ZOOM_KEY, z);
  };
  const setCols = (c: GridMode) => {
    setColsState(c);
    writePref(COLS_KEY, c);
  };

  const toggleHijri = async (on: boolean) => {
    try {
      const updated = await api.me.update({ preferences: { showHijri: on } });
      setUser(updated);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

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
        notifications.show({ color: 'ok', message: t('gantt.linkAdded', { count: formatNumber(dep.affected.length) }) });
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

  const onViewChange = useCallback((v: typeof viewRef.current) => {
    viewRef.current = v;
  }, []);

  const exportPng = async () => {
    setExporting(true);
    try {
      const v = viewRef.current;
      await exportGanttPng(
        { data, fromDay: v.fromDay, toDay: v.toDay, dayWidth: zoom === 'day' ? 26 : zoom === 'week' ? 12 : zoom === 'month' ? 4 : 1.6, zoom, showHijri, digits },
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
    printGantt({ data, fromDay: from - 2, toDay: to + 2, zoom: span > 400 ? 'quarter' : span > 120 ? 'month' : 'week', showHijri, digits });
  };

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const blob = await api.projects.exportXlsx(data.project.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${riyadhToday()}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    } finally {
      setExporting(false);
    }
  };

  const addTask = async () => {
    try {
      const start = data.project.startDate > riyadhToday() ? data.project.startDate : riyadhToday();
      const created = await writes.run(() => api.tasks.create(data.project.id, { name: t('list.newTask'), startDate: start, durationDays: 1 }));
      await writes.refresh();
      onOpenTask(created.id);
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {writes.conflict ? <ConflictAlert onRefresh={() => void writes.refresh()} /> : null}
      {!editable && !phone ? (
        <Alert color="gray" variant="light" py={6}>
          <Text size="sm">{t('gantt.readOnly')}</Text>
        </Alert>
      ) : null}
      <div className="nz-toolbar">
        <SegmentedControl
          size="xs"
          aria-label={t('gantt.zoom')}
          value={zoom}
          onChange={(v) => setZoom(v as Zoom)}
          data={ZOOMS.map((z) => ({ value: z, label: t(`gantt.zoom.${z}` as 'gantt.zoom.day') }))}
        />
        <Switch size="sm" label={t('gantt.hijri')} checked={showHijri} onChange={(e) => void toggleHijri(e.currentTarget.checked)} />
        {!phone ? (
          <SegmentedControl
            size="xs"
            aria-label={t('gantt.columns')}
            value={gridMode}
            onChange={(v) => setCols(v as GridMode)}
            data={(['full', 'compact', 'narrow'] as const).map((c) => ({ value: c, label: t(`gantt.columns.${c}`) }))}
          />
        ) : null}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button size="xs" variant="default" leftSection={exporting ? <Loader size={12} /> : <IconDownload size={16} />}>
              {t('gantt.export')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconPhoto size={16} />} onClick={() => void exportPng()}>
              {t('gantt.exportPng')}
            </Menu.Item>
            <Menu.Item leftSection={<IconFileTypePdf size={16} />} onClick={exportPdf}>
              {t('gantt.exportPdf')}
            </Menu.Item>
            <Menu.Item leftSection={<IconFileSpreadsheet size={16} />} onClick={() => void exportXlsx()}>
              {t('gantt.exportXlsx')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        {editable ? (
          <Button size="xs" leftSection={<IconPlus size={16} />} onClick={() => void addTask()}>
            {t('list.addTask')}
          </Button>
        ) : null}
        <Tooltip label={t('gantt.help')} multiline w={320} withinPortal>
          <ActionIcon variant="subtle" aria-label={t('gantt.help')}>
            <IconHelpCircle size={18} />
          </ActionIcon>
        </Tooltip>
        {writes.saving ? (
          <Group gap={6} role="status">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              {t('gantt.saving')}
            </Text>
          </Group>
        ) : null}
        <Legend />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {data.tasks.length ? (
          <Gantt
            data={data}
            zoom={zoom}
            showHijri={showHijri}
            digits={digits}
            editable={editable}
            busy={writes.saving}
            gridMode={gridMode}
            onOpenTask={onOpenTask}
            onCommit={(c) => void commit(c)}
            onLink={(a, b) => void link(a, b)}
            onLinkRefused={(msg) => notifications.show({ color: 'breach', message: msg })}
            onViewChange={onViewChange}
          />
        ) : (
          <EmptyGantt editable={editable} onAdd={() => void addTask()} />
        )}
      </div>
      <span hidden data-grid-width={gridWidth(gridMode)} />
    </div>
  );
}

function Legend() {
  const item = (swatch: ReactNode, label: string) => (
    <Group gap={4} wrap="nowrap">
      {swatch}
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
  const box = (bg: string, border?: string) => <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: bg, border: border ? `1.5px solid ${border}` : undefined, display: 'inline-block' }} />;
  return (
    <Group gap="sm" style={{ marginInlineStart: 'auto' }} wrap="wrap" visibleFrom="sm">
      {item(box('color-mix(in srgb, var(--muted) 14%, transparent)'), t('gantt.legend.weekend'))}
      {item(box('color-mix(in srgb, var(--signal) 25%, transparent)'), t('gantt.legend.holiday'))}
      {item(<span aria-hidden style={{ width: 2, height: 14, background: 'var(--field)', display: 'inline-block' }} />, t('gantt.legend.today'))}
      {item(box('color-mix(in srgb, var(--breach) 14%, transparent)', 'var(--breach)'), t('gantt.legend.late'))}
    </Group>
  );
}

function EmptyGantt({ editable, onAdd }: { editable: boolean; onAdd(): void }) {
  return (
    <div className="surface-card" style={{ padding: 48, textAlign: 'center' }}>
      <Title order={3}>{t('gantt.empty')}</Title>
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

