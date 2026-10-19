/**
 * The custom RTL Gantt (brief §6.1/§6.4, ADR-016/017/077; GanttPRO parity, owner request A9):
 * React + SVG, no third-party chart.
 *
 * - Task grid on the right, timeline on the left; time flows right → left.
 * - One vertical scroller (the timeline body) drives the grid; rows are virtualised (fixed
 *   height, visible rows + overscan) and the SVG only covers the visible window of rows and days.
 * - Grid columns are configurable (A9): «+» adds columns (dates, duration, deadline, priority,
 *   progress, costs, labels, WBS, custom fields), headers drag to reorder and their edge resizes.
 *   Hovering a row shows «فتح» / «حذف» / more; a handle drags rows to reorder; inline
 *   «إضافة مهمة | إضافة معلَم» lines end each group and the project; a checkbox column appears in
 *   multi-select mode (Shift/Ctrl click works anywhere).
 * - Bars: assignee avatar, «متأخرة N يومًا» after overdue bars, summary bars with their date
 *   range, milestones as diamonds, deadline flags (red when passed), custom bar colours, optional
 *   label chips, the «اليوم» marker, weekend/holiday shading, orange dependency arrows and a
 *   hover card (name + description excerpt). HOUR projects: zoom hour/day/week, bars by working
 *   time, non-working hours shaded, drags snap to 15 minutes.
 * - Drag a bar to move it (left = later), drag its left edge to change its end, drag the round
 *   handle onto another bar to add a finish-to-start link. While dragging, `@nuzli/scheduling`
 *   runs locally for an instant preview of every shifted successor; the drag-end sends one batch.
 * - Keyboard: ↑/↓ rows, Enter opens, ←/→ expand/collapse (RTL), Alt+←/→ one working day (HOUR:
 *   one hour) later/earlier, F2 renames.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Checkbox, Menu } from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconDots,
  IconExternalLink,
  IconFlag3,
  IconGripVertical,
  IconPlus,
  IconSubtask,
  IconTrash,
} from '@tabler/icons-react';
import { MINUTES_PER_DAY, toDayNumber, toMinuteNumber } from '@nuzli/scheduling';
import type { CustomFieldDto, GanttDto, LabelDto, TaskDto } from '@nuzli/shared';
import { formatMoney, formatNumber, t } from '../../i18n';
import type { Digits } from '../../i18n/format';
import { RIYADH_OFFSET_MS, riyadhToday } from '../projects/today';
import { sortOrderBetween } from '../projects/engine';
import { unitOf, type GanttView } from '../../api/hoursWire';
import {
  BAR_HEIGHT,
  ROW_HEIGHT,
  barFor,
  barGeometry,
  buildRows,
  dayEndX,
  dayStartX,
  dayWindow,
  daysBetweenIso,
  dependencyPath,
  dragDeltaDays,
  dragDeltaMinutes,
  endPos,
  isTaskRow,
  projectScale,
  rowWindow,
  scrollLeftFor,
  xOfPos,
  xToDay,
  type BarGeom,
  type GanttRow,
  type RowOptions,
  type TimeScale,
  type Zoom,
} from './geometry';
import { dateTimeLabel, dayLabel, gregorianRows, headerRowCount, hijriRows, hourRows } from './timeHeader';
import {
  calendarOf,
  checkNewLink,
  engineState,
  previewMove,
  previewMoveMinutes,
  previewResize,
  previewResizeMinutes,
  previewShiftWorkingDays,
  type Preview,
} from './batch';
import {
  COLUMN_DEFS,
  availableColumns,
  clampWidth,
  columnsWidth,
  dropIndex,
  fieldIdOf,
  isCustom,
  moveColumn,
  resizeColumn,
  type BaseColumnId,
  type ColumnId,
  type ColumnPref,
} from './columns';
import classes from './Gantt.module.css';

export type GridMode = 'full' | 'compact' | 'narrow';

export interface AddTaskInput {
  parentId: string | null;
  type: 'TASK' | 'MILESTONE';
  name: string;
}

export interface ReorderChange {
  id: string;
  parentId: string | null;
  sortOrder: number;
}

export interface GanttProps {
  data: GanttDto | GanttView;
  zoom: Zoom;
  showHijri: boolean;
  digits: Digits;
  /** Admin (`tasks.manage`): drag, resize, link, keyboard shifts, add, reorder, delete. */
  editable: boolean;
  /** A batch is in flight: interactions wait. */
  busy?: boolean;
  /** Legacy fixed layouts (tests, exports). Ignored when `columns` is given. */
  gridMode?: GridMode;
  /** A9: the user's columns (`gantt.columns`), and where changes go. */
  columns?: ColumnPref[];
  onColumnsChange?(cols: ColumnPref[]): void;
  /** A9: filter and grouping (toolbar). */
  rowOptions?: Pick<RowOptions, 'visible' | 'groupBy'>;
  /** Controlled collapse state (toolbar «توسيع الكل / طيّ الكل»). */
  collapsed?: ReadonlySet<string>;
  onCollapsedChange?(next: Set<string>): void;
  /** A9 multi-select. */
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  onSelectionChange?(next: Set<string>): void;
  /** Coloured label chips on the bars. */
  showLabels?: boolean;
  /** Assignee photo URLs by user id (initials otherwise). */
  photos?: ReadonlyMap<string, string>;
  onOpenTask(id: string): void;
  /** Drag-end / keyboard: every task the engine changed. */
  onCommit(changes: TaskDto[]): void;
  onLink(predecessorId: string, successorId: string): void;
  /** Arabic message for a refused link (self, existing, cycle with names). */
  onLinkRefused(message: string): void;
  onAddTask?(input: AddTaskInput): Promise<void> | void;
  onDeleteTask?(id: string): void;
  onDuplicate?(id: string, withSubtasks: boolean): void;
  onReorder?(change: ReorderChange): void;
  onRename?(id: string, name: string): void;
  /** Fixed viewport for tests (jsdom has no layout). */
  viewport?: { width: number; height: number };
  /** Exposes the visible window for exports. */
  onViewChange?(view: { fromDay: number; toDay: number; firstRow: number; lastRow: number }): void;
}

type DragMode = 'move' | 'resize' | 'link';

interface DragState {
  mode: DragMode;
  task: TaskDto;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
  /** Link mode: pointer position in content coordinates and the target under it. */
  px?: number;
  py?: number;
  targetId?: string | null;
}

const LEGACY_COLUMNS: Record<GridMode, ColumnId[]> = {
  full: ['wbs', 'name', 'start', 'end', 'duration', 'progress', 'assignee'],
  compact: ['wbs', 'name', 'assignee'],
  narrow: ['name'],
};
const LEGACY_WIDTH: Partial<Record<ColumnId, number>> = { wbs: 52, name: 230, start: 84, end: 84, duration: 52, progress: 52, assignee: 150 };

const SELECT_W = 34;
const ADD_W = 36;
const HEADER_ROW = 24;

/** Width of the legacy grid (exports and tests). */
export function gridWidth(mode: GridMode): number {
  if (mode === 'narrow') return 160;
  return LEGACY_COLUMNS[mode].reduce((s, c) => s + (LEGACY_WIDTH[c] ?? 80), 0);
}

const statusColor: Record<string, string> = {
  NOT_STARTED: 'var(--dim2)',
  IN_PROGRESS: 'var(--primary)',
  ON_HOLD: 'var(--amber)',
  DONE: 'var(--live)',
};

/** Riyadh now as a minute number (HOUR projects' «الآن»). */
const nowMinute = () => Math.floor((Date.now() + RIYADH_OFFSET_MS) / 60_000);

/** Initials of a name (first letters of the first two words). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => !['بن', 'بنت', 'ابن', 'آل', 'أبو'].includes(p));
  return (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
}

/** Whole calendar days a task is overdue (end before today, not DONE); 0 otherwise. */
export function overdueDays(task: Pick<TaskDto, 'endDate' | 'status' | 'type'>, today: string): number {
  if (task.status === 'DONE' || task.type === 'GROUP') return 0;
  const end = task.endDate.length > 10 ? task.endDate.slice(0, 10) : task.endDate;
  if (task.endDate.length > 10) {
    // HOUR tasks end exclusively at a time: overdue from the end instant.
    return toMinuteNumber(task.endDate) < nowMinute() ? Math.max(0, daysBetweenIso(end, today)) : 0;
  }
  return end < today ? daysBetweenIso(end, today) : 0;
}

export function Gantt(props: GanttProps) {
  const { zoom, showHijri, digits, editable, busy } = props;
  const data = props.data as GanttView;
  const unit = unitOf(data.project);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [innerCollapsed, setInnerCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const collapsed = props.collapsed ?? innerCollapsed;
  const setCollapsed = useCallback(
    (fn: (c: ReadonlySet<string>) => Set<string>) => {
      const next = fn(props.collapsed ?? innerCollapsed);
      if (props.onCollapsedChange) props.onCollapsedChange(next);
      else setInnerCollapsed(next);
    },
    [props, innerCollapsed],
  );
  const [view, setView] = useState({ top: 0, left: 0, width: props.viewport?.width ?? 800, height: props.viewport?.height ?? 480 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [focus, setFocus] = useState(0);
  const [hover, setHover] = useState<{ task: TaskDto; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [rowDrag, setRowDrag] = useState<{ id: string; target: number; after: boolean } | null>(null);
  const anchorRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const today = toDayNumber(riyadhToday());
  const todayIso = riyadhToday();
  const cal = useMemo(() => calendarOf(data.calendar), [data.calendar]);
  const state = useMemo(() => engineState(data, cal), [data, cal]);
  const grouped = Boolean(props.rowOptions?.groupBy);
  const rowOpts = useMemo<RowOptions>(
    () => ({ ...props.rowOptions, addRows: editable && !!props.onAddTask && !grouped }),
    [props.rowOptions, editable, props.onAddTask, grouped],
  );
  const rows = useMemo(() => buildRows(data.tasks, collapsed, rowOpts), [data.tasks, collapsed, rowOpts]);
  const rowOfTask = useMemo(() => {
    const m = new Map<string, GanttRow>();
    for (const r of rows) if (isTaskRow(r) && !m.has(r.task.id)) m.set(r.task.id, r);
    return m;
  }, [rows]);
  const taskById = useMemo(() => new Map(data.tasks.map((x) => [x.id, x])), [data.tasks]);
  const scale = useMemo(
    () => projectScale(data.tasks, zoom, today, data.project.startDate, view.width, unit),
    [data.tasks, data.project.startDate, zoom, today, view.width, unit],
  );
  const bars = useMemo(() => barGeometry(rows, scale, preview?.byId), [rows, scale, preview]);
  const headerHeight = HEADER_ROW * (unit === 'HOUR' ? 2 : headerRowCount(showHijri, zoom));
  const totalHeight = rows.length * ROW_HEIGHT;
  const labels = useMemo(() => new Map((data.labels ?? []).map((l) => [l.id, l])), [data.labels]);
  const fields = useMemo(() => new Map((data.customFields ?? []).map((f) => [f.id, f])), [data.customFields]);

  // Columns: the user's layout or a legacy mode.
  const legacy = !props.columns;
  const cols: ColumnPref[] = useMemo(
    () => props.columns ?? LEGACY_COLUMNS[props.gridMode ?? 'compact'].map((id) => ({ id, width: LEGACY_WIDTH[id] ?? 80 })),
    [props.columns, props.gridMode],
  );
  const narrow = legacy && props.gridMode === 'narrow';
  const selecting = Boolean(props.selecting);
  const canEditCols = Boolean(props.onColumnsChange);
  const gw = narrow ? 160 : columnsWidth(cols) + (selecting ? SELECT_W : 0) + (canEditCols ? ADD_W : 0);

  // ------------------------------------------------------------ viewport and scrolling

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || props.viewport || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, width: el.clientWidth || v.width, height: el.clientHeight || v.height })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.viewport]);

  // First view: near today (or the project start), earlier dates to the right. On a zoom change
  // the day at the centre of the viewport stays at the centre.
  const anchored = useRef<{ project: string; zoom: Zoom; width: number } | null>(null);
  /** Until the user scrolls, a late viewport measurement (phones) re-anchors on today. */
  const userScrolled = useRef(false);
  const centerDay = useRef<number | null>(null);
  /** The scale currently laid out in the DOM (the scroll handler measures against it). */
  const laidOut = useRef<TimeScale | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const prev = anchored.current;
    const vw = el.clientWidth || view.width;
    if (prev && prev.project === data.project.id && prev.zoom === zoom && (userScrolled.current || Math.abs(prev.width - vw) < 2)) return;
    const reanchor = prev && prev.zoom === zoom && !userScrolled.current;
    let left: number;
    if (prev && !reanchor && prev.project === data.project.id && centerDay.current !== null) {
      // In the hour zoom a day is ~24 columns wide: centre on its working midday, not on midnight
      // (A9 QA: switching to «ساعة» used to show only the shaded night hours).
      const centreX = zoom === 'hour' ? xOfPos(scale, centerDay.current + 13 / 24) : dayStartX(scale, centerDay.current);
      left = Math.max(0, Math.min(scale.width - vw, centreX - vw / 2));
    } else {
      const anchor = Math.max(toDayNumber(data.project.startDate), Math.min(today, scale.endDay));
      left = unit === 'HOUR' ? Math.max(0, Math.min(scale.width - vw, xOfPos(scale, anchor + 9 / 24) - vw * 0.8)) : scrollLeftFor(scale, anchor, vw);
    }
    anchored.current = { project: data.project.id, zoom, width: vw };
    laidOut.current = scale;
    const apply = () => {
      el.scrollLeft = left;
      // Read back the real (clamped) position so the rendered window matches what is on screen.
      const actual = el.scrollLeft;
      // When the whole chart fits, the viewport centre says nothing: keep the previous one.
      if (scale.width > vw + 2 || centerDay.current === null) centerDay.current = xToDay(scale, actual + vw / 2);
      if (headRef.current) headRef.current.scrollLeft = actual;
      setView((v) => ({ ...v, left: actual, top: el.scrollTop }));
      return actual;
    };
    // Chrome may report the previous scroll width for a few frames after a zoom change and clamp
    // the position: apply it again until the new width is in place (bounded).
    let tries = 0;
    const retry = () => {
      if (Math.abs(apply() - left) <= 1 || el.scrollWidth >= Math.floor(scale.width) || ++tries > 30) return;
      requestAnimationFrame(retry);
    };
    if (Math.abs(apply() - left) > 1) requestAnimationFrame(retry);
  }, [data.project.id, data.project.startDate, zoom, scale, today, view.width, unit]);

  const frame = useRef(0);
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (headRef.current) headRef.current.scrollLeft = el.scrollLeft;
    if (laidOut.current && laidOut.current.width > el.clientWidth + 2) centerDay.current = xToDay(laidOut.current, el.scrollLeft + el.clientWidth / 2);
    if (gridRef.current && gridRef.current.scrollTop !== el.scrollTop) gridRef.current.scrollTop = el.scrollTop;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setView((v) => (v.top === el.scrollTop && v.left === el.scrollLeft ? v : { ...v, top: el.scrollTop, left: el.scrollLeft })));
  }, []);
  const markUserScroll = useCallback(() => {
    userScrolled.current = true;
  }, []);
  const onGridScroll = useCallback(() => {
    const g = gridRef.current;
    const b = bodyRef.current;
    if (g && b && b.scrollTop !== g.scrollTop) b.scrollTop = g.scrollTop;
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const win = rowWindow(view.top, view.height, rows.length);
  const days = dayWindow(view.left, view.width, scale);
  const { onViewChange } = props;
  useEffect(() => {
    onViewChange?.({ fromDay: days.fromDay, toDay: days.toDay, firstRow: win.first, lastRow: win.last });
  }, [onViewChange, days.fromDay, days.toDay, win.first, win.last]);

  // ------------------------------------------------------------ bar drag

  const contentPoint = (e: { clientX: number; clientY: number }) => {
    const el = bodyRef.current!;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top + el.scrollTop };
  };

  const previewFor = (mode: DragMode, task: TaskDto, dx: number): { delta: number; preview: Preview } => {
    if (unit === 'HOUR') {
      const minutes = dragDeltaMinutes(dx, scale.dayWidth);
      return { delta: minutes, preview: mode === 'resize' ? previewResizeMinutes(state, task, minutes) : previewMoveMinutes(state, task, minutes) };
    }
    const delta = dragDeltaDays(dx, scale.dayWidth);
    return { delta, preview: mode === 'resize' ? previewResize(state, task, delta) : previewMove(state, task, delta) };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const target = (e.target as Element).closest<SVGElement>('[data-task-id]');
    if (!target) return;
    const id = target.getAttribute('data-task-id')!;
    const handle = ((e.target as Element).closest('[data-handle]')?.getAttribute('data-handle') ?? 'move') as DragMode;
    const task = taskById.get(id);
    if (!task) return;
    setHover(null);
    const r = rowOfTask.get(id);
    if (r) setFocus(r.index);
    if (!editable || busy) {
      // Read-only: a click still opens the task.
      dragRef.current = { mode: 'move', task, pointerId: e.pointerId, startX: e.clientX, moved: false, delta: 0 };
      setDrag(dragRef.current);
    } else {
      const p = contentPoint(e);
      const d: DragState = { mode: handle, task, pointerId: e.pointerId, startX: e.clientX, moved: false, delta: 0, px: p.x, py: p.y, targetId: null };
      dragRef.current = d;
      setDrag(d);
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const moved = d.moved || Math.abs(dx) > 3 || d.mode === 'link';
    if (!editable || busy) {
      if (moved !== d.moved) setDrag({ ...d, moved });
      return;
    }
    if (d.mode === 'link') {
      const p = contentPoint(e);
      const row = rows[Math.floor(p.y / ROW_HEIGHT)];
      const next = { ...d, moved: true, px: p.x, py: p.y, targetId: row && isTaskRow(row) && row.task.id !== d.task.id ? row.task.id : null };
      dragRef.current = next;
      setDrag(next);
      return;
    }
    const out = previewFor(d.mode, d.task, dx);
    if (out.delta === d.delta && moved === d.moved) return;
    const next = { ...d, moved, delta: out.delta };
    dragRef.current = next;
    setDrag(next);
    // The engine runs locally: the preview shows every shifted successor.
    setPreview(out.preview);
  };

  const finishDrag = (commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    const p = preview;
    setPreview(null);
    if (!d || !commit) return;
    if (!d.moved) {
      props.onOpenTask(d.task.id);
      return;
    }
    if (!editable || busy) return;
    if (d.mode === 'link') {
      if (!d.targetId) return;
      const check = checkNewLink(state, d.task.id, d.targetId);
      if (check.ok) props.onLink(d.task.id, d.targetId);
      else props.onLinkRefused(linkMessage(check.reason, check.path, data.tasks));
      return;
    }
    if (p && p.changes.length) props.onCommit(p.changes);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    finishDrag(true);
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finishDrag(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------ hover card

  const onBarHover = useCallback((task: TaskDto | null, e?: ReactPointerEvent | ReactMouseEvent) => {
    if (!task || !e || dragRef.current) {
      setHover(null);
      return;
    }
    const root = rootRef.current?.getBoundingClientRect();
    if (!root) return;
    setHover({ task, x: e.clientX - root.left, y: e.clientY - root.top });
  }, []);

  // ------------------------------------------------------------ selection

  const toggle = useCallback(
    (id: string, open?: boolean) => {
      setCollapsed((c) => {
        const next = new Set(c);
        const isCollapsed = next.has(id);
        if (open === true || (open === undefined && isCollapsed)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [setCollapsed],
  );

  const selectRow = useCallback(
    (row: GanttRow, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean } | null, forceToggle = false) => {
      if (!props.onSelectionChange || !isTaskRow(row)) return false;
      const sel = new Set(props.selected ?? []);
      const id = row.task.id;
      if (e?.shiftKey && anchorRef.current !== null) {
        const [a, b] = [Math.min(anchorRef.current, row.index), Math.max(anchorRef.current, row.index)];
        for (let i = a; i <= b; i++) {
          const r = rows[i];
          if (r && isTaskRow(r)) sel.add(r.task.id);
        }
      } else if (forceToggle || e?.ctrlKey || e?.metaKey) {
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
        anchorRef.current = row.index;
      } else return false;
      props.onSelectionChange(sel);
      return true;
    },
    [props, rows],
  );

  const allVisibleSelected = useMemo(() => {
    const sel = props.selected;
    if (!sel || !sel.size) return false;
    return rows.every((r) => !isTaskRow(r) || sel.has(r.task.id));
  }, [rows, props.selected]);

  const toggleAll = () => {
    if (!props.onSelectionChange) return;
    if (allVisibleSelected) props.onSelectionChange(new Set());
    else props.onSelectionChange(new Set(rows.filter(isTaskRow).map((r) => r.task.id)));
  };

  // ------------------------------------------------------------ keyboard (grid)

  const scrollRowIntoView = (index: number) => {
    const b = bodyRef.current;
    if (!b) return;
    const top = index * ROW_HEIGHT;
    const height = b.clientHeight || view.height;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + ROW_HEIGHT > b.scrollTop + height) b.scrollTop = top + ROW_HEIGHT - height;
    onBodyScroll();
  };

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const row = rows[focus];
    if (!row) return;
    let next = focus;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (!editable || busy || !isTaskRow(row)) return;
      // RTL: left is later in time, right is earlier.
      const sign = e.key === 'ArrowLeft' ? 1 : -1;
      const p = unit === 'HOUR' ? previewMoveMinutes(state, row.task, sign * 60) : previewShiftWorkingDays(state, row.task, sign);
      if (p.changes.length) props.onCommit(p.changes);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, focus + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, focus - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'PageDown':
        next = Math.min(rows.length - 1, focus + Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1));
        break;
      case 'PageUp':
        next = Math.max(0, focus - Math.max(1, Math.floor(view.height / ROW_HEIGHT) - 1));
        break;
      case 'F2':
        if (editable && props.onRename && isTaskRow(row)) setRenaming(row.task.id);
        e.preventDefault();
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (isTaskRow(row)) props.onOpenTask(row.task.id);
        else if (row.kind === 'header') toggle(row.id);
        return;
      case 'ArrowLeft': // RTL: towards the children
        if (row.hasChildren) toggle(row.id, true);
        e.preventDefault();
        return;
      case 'ArrowRight':
        if (row.hasChildren && !collapsed.has(row.id)) toggle(row.id, false);
        else if (isTaskRow(row) && row.task.parentId) {
          const parent = rowOfTask.get(row.task.parentId);
          if (parent) next = parent.index;
        }
        break;
      default:
        return;
    }
    e.preventDefault();
    setFocus(next);
    scrollRowIntoView(next);
  };

  // Keep DOM focus on the focused row once it is rendered.
  const gridHasFocus = useRef(false);
  useEffect(() => {
    if (!gridHasFocus.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-row-index="${focus}"]`);
    if (el && document.activeElement !== el && el.tagName !== 'INPUT') el.focus({ preventScroll: true });
  }, [focus, win.first, win.last]);

  // ------------------------------------------------------------ row drag (reorder)

  const startRowDrag = (e: ReactPointerEvent, row: GanttRow) => {
    if (!props.onReorder || !editable || grouped || !isTaskRow(row)) return;
    e.preventDefault();
    e.stopPropagation();
    const gridBody = gridRef.current;
    if (!gridBody) return;
    const id = row.task.id;
    const descendants = new Set<string>([id]);
    for (const x of data.tasks) if (x.parentId && descendants.has(x.parentId)) descendants.add(x.id);
    let current: { target: number; after: boolean } | null = null;
    const move = (ev: PointerEvent) => {
      const r = gridBody.getBoundingClientRect();
      const y = ev.clientY - r.top + gridBody.scrollTop;
      const index = Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_HEIGHT)));
      const after = y - index * ROW_HEIGHT > ROW_HEIGHT / 2;
      const target = rows[index]!;
      const blocked = isTaskRow(target) ? descendants.has(target.task.id) : target.addParentId ? descendants.has(target.addParentId) : false;
      current = blocked ? null : { target: index, after };
      setRowDrag(current ? { id, ...current } : null);
      // Auto-scroll near the edges.
      if (ev.clientY < r.top + 24) gridBody.scrollTop -= 12;
      else if (ev.clientY > r.bottom - 24) gridBody.scrollTop += 12;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setRowDrag(null);
      if (!current) return;
      const change = reorderChange(data.tasks, rows, collapsed, id, current.target, current.after);
      if (change) props.onReorder?.(change);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ------------------------------------------------------------ column header (resize, reorder)

  const headerRef = useRef<HTMLDivElement>(null);
  const [colDrag, setColDrag] = useState<{ from: number; to: number } | null>(null);
  const startResize = (e: ReactPointerEvent, id: ColumnId) => {
    if (!props.onColumnsChange) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = cols.find((c) => c.id === id)?.width ?? 100;
    const rtl = document.documentElement.dir !== 'ltr';
    let latest = cols;
    const move = (ev: PointerEvent) => {
      // The column grows towards its inline-end edge: left in RTL (a physical delta × −1).
      const delta = (ev.clientX - startX) * (rtl ? -1 : 1);
      latest = resizeColumn(cols, id, clampWidth(id, start + delta));
      setLiveCols(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLiveCols(null);
      props.onColumnsChange?.(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [liveCols, setLiveCols] = useState<ColumnPref[] | null>(null);
  const shownCols = liveCols ?? cols;
  const startColDrag = (e: ReactPointerEvent, index: number) => {
    if (!props.onColumnsChange || index === 0 || e.button !== 0) return;
    const head = headerRef.current;
    if (!head) return;
    const startX = e.clientX;
    let moved = false;
    let to = index;
    const rtl = document.documentElement.dir !== 'ltr';
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 5) return;
      moved = true;
      const r = head.getBoundingClientRect();
      const offset = selecting ? SELECT_W : 0;
      const localX = rtl ? ev.clientX - r.left : ev.clientX - r.left - offset;
      const total = columnsWidth(cols) + (rtl ? (canEditCols ? ADD_W : 0) : 0);
      to = dropIndex(cols, rtl ? localX - (canEditCols ? ADD_W : 0) : localX, total - (canEditCols && rtl ? ADD_W : 0), rtl);
      setColDrag({ from: index, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setColDrag(null);
      if (moved && to !== index) props.onColumnsChange?.(moveColumn(cols, index, to));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addable = canEditCols ? availableColumns(cols, data.customFields ?? []) : [];
  const colLabel = (id: ColumnId) => (isCustom(id) ? (fields.get(fieldIdOf(id)!)?.name ?? '') : t(COLUMN_DEFS[id as BaseColumnId].label));

  // ------------------------------------------------------------ render

  const visibleRows = rows.slice(win.first, win.last + 1);
  const svgX0 = Math.max(0, days.x0);
  const svgW = Math.max(1, Math.min(scale.width, days.x1) - svgX0);
  const svgY0 = win.first * ROW_HEIGHT;
  const svgH = Math.max(1, (win.last - win.first + 1) * ROW_HEIGHT);
  const nowPos = unit === 'HOUR' ? nowMinute() / MINUTES_PER_DAY : today + 0.5;

  return (
    <div
      ref={rootRef}
      className={classes.root}
      style={{ '--gantt-grid': `${gw}px`, '--gantt-header': `${headerHeight}px` } as CSSProperties}
      data-testid="gantt"
      onPointerLeave={() => setHover(null)}
    >
      {/* Grid (inline-start = right in RTL) */}
      <div className={classes.grid} style={{ width: gw }}>
        <div ref={headerRef} className={classes.gridHeader} role="presentation" style={{ height: headerHeight }}>
          {selecting ? (
            <div className={classes.headCell} style={{ width: SELECT_W, justifyContent: 'center' }}>
              <Checkbox size="xs" aria-label={t('grid.selectAll')} checked={allVisibleSelected} indeterminate={!allVisibleSelected && Boolean(props.selected?.size)} onChange={toggleAll} />
            </div>
          ) : null}
          {shownCols.map((c, i) => (
            <div
              key={c.id}
              className={classes.headCell}
              data-dragging={colDrag?.from === i || undefined}
              data-drop={colDrag && colDrag.to === i && colDrag.from !== i ? (colDrag.to > colDrag.from ? 'after' : 'before') : undefined}
              style={narrow ? { flex: 1 } : { width: c.width }}
              onPointerDown={(e) => startColDrag(e, i)}
              title={canEditCols && i > 0 ? t('col.dragHint') : undefined}
            >
              <span className={classes.headLabel}>{colLabel(c.id)}</span>
              {canEditCols ? (
                <span
                  className={classes.colResize}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('col.resize', { name: colLabel(c.id) })}
                  onPointerDown={(e) => startResize(e, c.id)}
                />
              ) : null}
            </div>
          ))}
          {canEditCols ? (
            <Menu position="bottom-end" withinPortal shadow="md" width={240}>
              <Menu.Target>
                <button type="button" className={classes.addCol} aria-label={t('col.add')} title={t('col.add')}>
                  <IconPlus size={16} />
                </button>
              </Menu.Target>
              <Menu.Dropdown mah={420} style={{ overflowY: 'auto' }}>
                <Menu.Label>{t('col.addTitle')}</Menu.Label>
                {[...cols.map((c) => c.id), ...addable].map((id) => {
                  const on = cols.some((c) => c.id === id);
                  return (
                    <Menu.Item
                      key={id}
                      disabled={id === 'name'}
                      closeMenuOnClick={false}
                      leftSection={<span style={{ width: 16, display: 'inline-flex' }}>{on ? <IconCheck size={15} /> : null}</span>}
                      onClick={() => props.onColumnsChange?.(on ? cols.filter((x) => x.id !== id) : [...cols, { id, width: isCustom(id) ? 140 : COLUMN_DEFS[id as BaseColumnId].width }])}
                    >
                      {colLabel(id)}
                    </Menu.Item>
                  );
                })}
                <Menu.Divider />
                <Menu.Item onClick={() => props.onColumnsChange?.([])}>{t('col.reset')}</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </div>
        <div
          ref={gridRef}
          className={classes.gridBody}
          role="treegrid"
          aria-label={t('gantt.gridLabel', { name: data.project.name })}
          aria-rowcount={rows.length}
          aria-multiselectable={selecting || undefined}
          onScroll={onGridScroll}
          onKeyDown={onGridKeyDown}
          onFocus={() => (gridHasFocus.current = true)}
          onBlur={() => (gridHasFocus.current = false)}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleRows.map((r) =>
              r.kind === 'add' ? (
                <AddRow key={r.id} row={r} cols={shownCols} selecting={selecting} onAdd={props.onAddTask!} />
              ) : r.kind === 'header' ? (
                <HeaderRow key={r.id} row={r} collapsed={collapsed.has(r.id)} onToggle={toggle} focused={focus === r.index} onFocusRow={setFocus} />
              ) : (
                <GridRow
                  key={r.id}
                  row={r}
                  task={preview?.byId.get(r.task.id) ?? r.task}
                  cols={shownCols}
                  narrow={narrow}
                  digits={digits}
                  unit={unit}
                  today={todayIso}
                  focused={focus === r.index}
                  collapsed={collapsed.has(r.id)}
                  selecting={selecting}
                  selected={Boolean(props.selected?.has(r.task.id))}
                  editable={editable && !busy}
                  renaming={renaming === r.task.id}
                  labels={labels}
                  fields={fields}
                  dropLine={rowDrag && rowDrag.target === r.index ? (rowDrag.after ? 'after' : 'before') : null}
                  dragging={rowDrag?.id === r.task.id}
                  canReorder={Boolean(props.onReorder) && !grouped}
                  onToggle={toggle}
                  onOpen={props.onOpenTask}
                  onFocusRow={setFocus}
                  onSelect={selectRow}
                  onDelete={props.onDeleteTask}
                  onDuplicate={props.onDuplicate}
                  onAddSubtask={props.onAddTask ? (parentId) => void props.onAddTask!({ parentId, type: 'TASK', name: t('list.newTask') }) : undefined}
                  onStartRename={props.onRename ? setRenaming : undefined}
                  onRename={(id, name) => {
                    setRenaming(null);
                    if (name && name !== taskById.get(id)?.name) props.onRename?.(id, name);
                  }}
                  onRowDrag={startRowDrag}
                />
              ),
            )}
          </div>
        </div>
      </div>

      {/* Timeline: an LTR box with physical coordinates (ADR-077). */}
      <div className={classes.timeline} dir="ltr">
        <div ref={headRef} className={classes.timeHeader} style={{ height: headerHeight }} aria-hidden>
          <div style={{ width: scale.width, height: headerHeight, position: 'relative' }}>
            <TimeHeader
              scale={scale}
              fromDay={days.fromDay}
              toDay={days.toDay}
              x0={svgX0}
              width={svgW}
              zoom={zoom}
              digits={digits}
              showHijri={showHijri && unit !== 'HOUR'}
              unit={unit}
              nowPos={nowPos}
            />
          </div>
        </div>
        <div
          ref={bodyRef}
          className={classes.body}
          onScroll={onBodyScroll}
          onWheel={markUserScroll}
          onTouchStart={markUserScroll}
          onMouseDown={markUserScroll}
          onKeyDown={markUserScroll}
          data-testid="gantt-body"
        >
          <div style={{ width: scale.width, height: Math.max(totalHeight, 1), position: 'relative' }}>
            <svg
              className={classes.svg}
              style={{ left: svgX0, top: svgY0 }}
              width={svgW}
              height={svgH}
              viewBox={`${svgX0} ${svgY0} ${svgW} ${svgH}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => finishDrag(false)}
              role="img"
              aria-label={t('gantt.chartLabel')}
              data-gantt-svg
            >
              <defs>
                <clipPath id="nz-av" clipPathUnits="objectBoundingBox">
                  <circle cx="0.5" cy="0.5" r="0.5" />
                </clipPath>
              </defs>
              <Shading cal={cal} scale={scale} fromDay={days.fromDay} toDay={days.toDay} y0={svgY0} h={svgH} holidays={data.calendar.exceptions} hourly={unit === 'HOUR' && zoom !== 'week'} />
              <RowLines first={win.first} last={win.last} x0={svgX0} w={svgW} selectedRows={props.selected} rows={rows} />
              {nowPos >= scale.startDay && nowPos <= scale.endDay + 1 ? (
                <line className={classes.today} x1={xOfPos(scale, nowPos)} x2={xOfPos(scale, nowPos)} y1={svgY0} y2={svgY0 + svgH} />
              ) : null}
              <Arrows data={data} rowOf={rowOfTask} bars={bars} first={win.first} last={win.last} preview={preview} />
              {visibleRows.map((r) =>
                isTaskRow(r) ? (
                  <Bar
                    key={r.id}
                    bar={bars[r.index]!}
                    task={preview?.byId.get(r.task.id) ?? r.task}
                    scale={scale}
                    editable={editable && !busy}
                    today={todayIso}
                    dragging={drag?.task.id === r.task.id && drag.moved}
                    linkTarget={drag?.mode === 'link' && drag.targetId === r.task.id}
                    digits={digits}
                    labels={props.showLabels ? labels : null}
                    photo={r.task.assignee ? (props.photos?.get(r.task.assignee.id) ?? null) : null}
                    onHover={onBarHover}
                  />
                ) : null,
              )}
              {drag?.mode === 'link' && drag.moved && drag.px !== undefined ? (
                <line
                  className={classes.linkLine}
                  x1={bars[rowOfTask.get(drag.task.id)?.index ?? 0]?.endX ?? 0}
                  y1={(rowOfTask.get(drag.task.id)?.index ?? 0) * ROW_HEIGHT + ROW_HEIGHT / 2}
                  x2={drag.px}
                  y2={drag.py}
                />
              ) : null}
            </svg>
          </div>
        </div>
      </div>
      {drag?.moved && drag.mode !== 'link' && preview ? (
        <div className={classes.dragTip} role="status" aria-live="polite">
          {t('gantt.dragTip', {
            start: when((preview.byId.get(drag.task.id) ?? drag.task).startDate, digits),
            end: when((preview.byId.get(drag.task.id) ?? drag.task).endDate, digits),
            count: formatNumber(Math.max(0, preview.changes.length - 1)),
          })}
        </div>
      ) : null}
      {hover && !drag ? <HoverCard task={hover.task} x={hover.x} y={hover.y} digits={digits} rootWidth={rootRef.current?.clientWidth ?? 800} /> : null}
    </div>
  );
}

const when = (iso: string, digits: Digits) => (iso.length > 10 ? dateTimeLabel(iso, digits) : dayLabel(iso, digits));

/** «هذا الربط يصنع حلقة: أ ← ب ← ج ← أ» with task names. */
export function linkMessage(reason: 'self' | 'exists' | 'cycle', path: string[] | undefined, tasks: readonly TaskDto[]): string {
  if (reason === 'self') return t('gantt.link.self');
  if (reason === 'exists') return t('gantt.link.exists');
  const names = new Map(tasks.map((x) => [x.id, x.name]));
  return t('gantt.link.cycle', { path: (path ?? []).map((id) => names.get(id) ?? '؟').join(' ← ') });
}

/**
 * The batch change for dropping row `id` before/after line `targetIndex` (pure; tested): the
 * moved task becomes a sibling of the target (or the first child of an expanded group dropped
 * after, or the last child of a group whose add line is the target) with a fractional sort key.
 */
export function reorderChange(
  tasks: readonly TaskDto[],
  rows: readonly GanttRow[],
  collapsed: ReadonlySet<string>,
  id: string,
  targetIndex: number,
  after: boolean,
): ReorderChange | null {
  const target = rows[targetIndex];
  if (!target) return null;
  const siblings = (parentId: string | null) =>
    tasks.filter((x) => x.parentId === parentId && x.id !== id).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
  if (target.kind === 'add') {
    const parentId = target.addParentId ?? null;
    const list = siblings(parentId);
    return { id, parentId, sortOrder: sortOrderBetween(list.at(-1)?.sortOrder ?? null, null) };
  }
  if (target.kind === 'header') return null;
  const tt = target.task;
  if (tt.id === id) return null;
  if (after && target.hasChildren && !collapsed.has(tt.id)) {
    const list = siblings(tt.id);
    return { id, parentId: tt.id, sortOrder: sortOrderBetween(null, list[0]?.sortOrder ?? null) };
  }
  const parentId = tt.parentId;
  const list = siblings(parentId);
  const i = list.findIndex((x) => x.id === tt.id);
  const prev = after ? list[i]!.sortOrder : (list[i - 1]?.sortOrder ?? null);
  const next = after ? (list[i + 1]?.sortOrder ?? null) : list[i]!.sortOrder;
  return { id, parentId, sortOrder: sortOrderBetween(prev, next) };
}

// ---------------------------------------------------------------- grid parts

const shortFmt = new Map<string, Intl.DateTimeFormat>();
function shortDate(iso: string, digits: Digits) {
  if (iso.length > 10) return dateTimeLabel(iso, digits);
  let f = shortFmt.get(digits);
  if (!f) {
    f = new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${digits}`, { timeZone: 'UTC', day: 'numeric', month: 'short' });
    shortFmt.set(digits, f);
  }
  return f.format(new Date(`${iso}T00:00:00Z`));
}

function durationText(task: TaskDto & { durationHours?: number }, unit: 'DAY' | 'HOUR'): string {
  if (task.type === 'MILESTONE') return '—';
  if (unit === 'HOUR' && task.durationHours != null) return t('duration.hours', { n: formatNumber(Math.round(task.durationHours * 100) / 100) });
  return t('duration.days', { n: formatNumber(task.durationDays) });
}

function customValueText(field: CustomFieldDto | undefined, value: unknown, digits: Digits): string {
  if (!field || value === null || value === undefined || value === '') return '';
  switch (field.type) {
    case 'NUMBER':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'DATE':
      return typeof value === 'string' ? shortDate(value, digits) : '';
    case 'CHECKBOX':
      return value === true ? t('common.yes') : t('common.no');
    default:
      return String(value);
  }
}

/** How long a click on a task name waits for a second click (rename) before opening the task. */
export const DOUBLE_CLICK_MS = 260;

const GridRow = memo(function GridRow(p: {
  row: GanttRow;
  task: TaskDto & { durationHours?: number };
  cols: ColumnPref[];
  narrow: boolean;
  digits: Digits;
  unit: 'DAY' | 'HOUR';
  today: string;
  focused: boolean;
  collapsed: boolean;
  selecting: boolean;
  selected: boolean;
  editable: boolean;
  renaming: boolean;
  labels: ReadonlyMap<string, LabelDto>;
  fields: ReadonlyMap<string, CustomFieldDto>;
  dropLine: 'before' | 'after' | null;
  dragging: boolean;
  canReorder: boolean;
  onToggle(id: string): void;
  onOpen(id: string): void;
  onFocusRow(index: number): void;
  onSelect(row: GanttRow, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean } | null, forceToggle?: boolean): boolean;
  onDelete?(id: string): void;
  onDuplicate?(id: string, withSubtasks: boolean): void;
  onAddSubtask?(parentId: string): void;
  onStartRename?(id: string): void;
  onRename(id: string, name: string): void;
  onRowDrag(e: ReactPointerEvent, row: GanttRow): void;
}) {
  const { row, task } = p;
  const late = overdueDays(task, p.today) > 0;
  const isGroup = row.hasChildren;
  // A9 QA: the first click of a double-click used to open the drawer, whose overlay then took the
  // second click, so «نقر مزدوج لتغيير الاسم» never worked. When renaming is possible the open waits
  // for the double-click window and a double-click cancels it.
  const openTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
  }, []);
  const cell = (c: ColumnPref, children: ReactNode, cls = '') => (
    <div key={c.id} role="gridcell" className={`${classes.cell} ${cls}`} style={p.narrow ? { flex: 1, minWidth: 0 } : { width: c.width }}>
      {children}
    </div>
  );
  return (
    <div
      className={classes.row}
      role="row"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? !p.collapsed : undefined}
      aria-selected={p.selecting ? p.selected : p.focused}
      aria-rowindex={row.index + 1}
      tabIndex={p.focused ? 0 : -1}
      data-row-index={row.index}
      data-row
      data-selected={p.selected || undefined}
      data-drop={p.dropLine ?? undefined}
      data-dragging={p.dragging || undefined}
      style={{ top: row.index * ROW_HEIGHT, height: ROW_HEIGHT }}
      onClick={(e) => {
        p.onFocusRow(row.index);
        p.onSelect(row, e);
      }}
    >
      {p.selecting ? (
        <div role="gridcell" className={classes.cell} style={{ width: SELECT_W, justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
          <Checkbox size="xs" aria-label={t('grid.selectRow', { name: task.name })} checked={p.selected} onChange={(e) => p.onSelect(row, { shiftKey: (e.nativeEvent as MouseEvent).shiftKey ?? false, ctrlKey: false, metaKey: false }, true)} />
        </div>
      ) : null}
      {p.cols.map((c) => {
        switch (c.id) {
          case 'wbs':
            return cell(c, task.wbs, 'mono');
          case 'name':
            return (
              <div key={c.id} role="gridcell" className={`${classes.cell} ${classes.nameCell}`} style={p.narrow ? { flex: 1, minWidth: 0, paddingInlineStart: 2 + row.depth * 14 } : { width: c.width, paddingInlineStart: 2 + row.depth * 14 }}>
                {p.editable && p.canReorder ? (
                  <span className={classes.dragHandle} aria-label={t('grid.dragRow')} title={t('grid.dragRow')} onPointerDown={(e) => p.onRowDrag(e, row)}>
                    <IconGripVertical size={14} />
                  </span>
                ) : (
                  <span className={classes.dragSpacer} aria-hidden />
                )}
                {row.hasChildren ? (
                  <button
                    type="button"
                    className={classes.caret}
                    tabIndex={-1}
                    aria-label={p.collapsed ? t('gantt.expand') : t('gantt.collapse')}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onToggle(row.id);
                    }}
                  >
                    <span className={p.collapsed ? 'mirror-rtl' : undefined} aria-hidden>
                      {p.collapsed ? '▸' : '▾'}
                    </span>
                  </button>
                ) : (
                  <span className={classes.caretSpacer} aria-hidden />
                )}
                {p.renaming ? (
                  <input
                    className={classes.renameInput}
                    defaultValue={task.name}
                    aria-label={t('grid.renamePlaceholder')}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') p.onRename(task.id, e.currentTarget.value.trim());
                      if (e.key === 'Escape') p.onRename(task.id, '');
                    }}
                    onBlur={(e) => p.onRename(task.id, e.currentTarget.value.trim())}
                  />
                ) : (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={classes.name}
                    data-kind={isGroup ? 'GROUP' : task.type}
                    title={task.name}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onFocusRow(row.index);
                      if (p.onSelect(row, e)) return;
                      if (!(p.editable && p.onStartRename)) {
                        p.onOpen(task.id);
                        return;
                      }
                      if (e.detail > 1) return; // the second click of a double-click
                      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
                      openTimer.current = window.setTimeout(() => {
                        openTimer.current = null;
                        p.onOpen(task.id);
                      }, DOUBLE_CLICK_MS);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
                      openTimer.current = null;
                      if (p.editable && p.onStartRename) p.onStartRename(task.id);
                    }}
                  >
                    {task.type === 'MILESTONE' ? <span aria-hidden className={classes.diamond} /> : null}
                    {task.barColor && !isGroup ? <span aria-hidden className={classes.colorDot} style={{ background: task.barColor }} /> : null}
                    <span className={classes.nameText}>{task.name}</span>
                  </button>
                )}
                {late ? <span className={classes.lateDot} title={t('gantt.overdue')} aria-label={t('gantt.overdue')} /> : null}
                {!p.renaming ? (
                  <span className={classes.rowActions} onClick={(e) => e.stopPropagation()}>
                    <button type="button" className={classes.rowAction} aria-label={t('grid.open')} title={t('grid.open')} onClick={() => p.onOpen(task.id)}>
                      <IconExternalLink size={15} />
                    </button>
                    {p.editable && p.onDelete ? (
                      <button type="button" className={classes.rowAction} data-danger aria-label={t('grid.delete')} title={t('grid.delete')} onClick={() => p.onDelete?.(task.id)}>
                        <IconTrash size={15} />
                      </button>
                    ) : null}
                    {p.editable && (p.onDuplicate || p.onAddSubtask) ? (
                      <Menu position="bottom-end" withinPortal shadow="md">
                        <Menu.Target>
                          <button type="button" className={classes.rowAction} aria-label={t('grid.more')} title={t('grid.more')}>
                            <IconDots size={15} />
                          </button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {p.onDuplicate ? (
                            <Menu.Item leftSection={<IconCopy size={15} />} onClick={() => p.onDuplicate?.(task.id, true)}>
                              {t('grid.duplicate')}
                            </Menu.Item>
                          ) : null}
                          {p.onDuplicate && isGroup ? (
                            <Menu.Item leftSection={<IconCopy size={15} />} onClick={() => p.onDuplicate?.(task.id, false)}>
                              {t('grid.duplicateOnly')}
                            </Menu.Item>
                          ) : null}
                          {p.onAddSubtask && task.type !== 'MILESTONE' ? (
                            <Menu.Item leftSection={<IconSubtask size={15} />} onClick={() => p.onAddSubtask?.(task.id)}>
                              {t('grid.addSubtask')}
                            </Menu.Item>
                          ) : null}
                          {p.onDelete ? (
                            <>
                              <Menu.Divider />
                              <Menu.Item color="red" leftSection={<IconTrash size={15} />} onClick={() => p.onDelete?.(task.id)}>
                                {t('grid.delete')}
                              </Menu.Item>
                            </>
                          ) : null}
                        </Menu.Dropdown>
                      </Menu>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          case 'assignee':
            return cell(c, task.assignee ? <Assignee a={task.assignee} /> : <span className={classes.muted}>{t('common.none')}</span>);
          case 'status':
            return cell(
              c,
              <span className={classes.status}>
                <span className={classes.statusDot} style={{ background: statusColor[task.status] }} aria-hidden />
                {t(`taskStatus.${task.status}` as 'taskStatus.DONE')}
              </span>,
            );
          case 'start':
            return cell(c, shortDate(task.startDate, p.digits), 'num');
          case 'end':
            return cell(c, shortDate(task.endDate, p.digits), 'num');
          case 'duration':
            return cell(c, durationText(task, p.unit), 'num');
          case 'deadline':
            return cell(
              c,
              task.deadline ? (
                <span className={classes.deadlineCell} data-passed={task.deadlinePassed || undefined}>
                  <IconFlag3 size={13} aria-hidden />
                  {shortDate(task.deadline, p.digits)}
                </span>
              ) : (
                <span className={classes.muted}>{t('common.none')}</span>
              ),
              'num',
            );
          case 'priority':
            return cell(c, <span data-priority={task.priority} className={classes.priority}>{t(`priority.${task.priority}` as 'priority.LOW')}</span>);
          case 'progress':
            return cell(
              c,
              <span className={classes.progressCell}>
                <span className={classes.progressTrack}>
                  <span className={classes.progressFill} style={{ inlineSize: `${Math.max(0, Math.min(100, task.progress))}%` }} />
                </span>
                <span className="num">{`${formatNumber(Math.round(task.progress))}٪`}</span>
              </span>,
            );
          case 'plannedCost':
            return cell(c, task.plannedCost ? formatMoney(task.plannedCost) : <span className={classes.muted}>{t('common.none')}</span>, 'num');
          case 'actualCost':
            return cell(
              c,
              task.actualCost ? <span className={task.overBudget ? classes.over : undefined}>{formatMoney(task.actualCost)}</span> : <span className={classes.muted}>{t('common.none')}</span>,
              'num',
            );
          case 'labels':
            return cell(
              c,
              <span className={classes.labelChips}>
                {(task.labelIds ?? []).map((id) => {
                  const l = p.labels.get(id);
                  return l ? (
                    <span key={id} className={classes.labelChip} style={{ '--lc': l.color } as CSSProperties} title={l.name}>
                      {l.name}
                    </span>
                  ) : null;
                })}
              </span>,
            );
          default: {
            const fid = fieldIdOf(c.id);
            const field = fid ? p.fields.get(fid) : undefined;
            return cell(c, customValueText(field, fid ? task.customValues?.[fid] : null, p.digits), field?.type === 'NUMBER' || field?.type === 'DATE' ? 'num' : '');
          }
        }
      })}
    </div>
  );
});

function AddRow({ row, cols, selecting, onAdd }: { row: GanttRow; cols: ColumnPref[]; selecting: boolean; onAdd(input: AddTaskInput): Promise<void> | void }) {
  const [mode, setMode] = useState<null | 'TASK' | 'MILESTONE'>(null);
  const [busy, setBusy] = useState(false);
  const width = columnsWidth(cols) + (selecting ? SELECT_W : 0);
  const submit = async (name: string) => {
    if (!name || !mode) {
      setMode(null);
      return;
    }
    setBusy(true);
    try {
      await onAdd({ parentId: row.addParentId ?? null, type: mode, name });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`${classes.row} ${classes.addRow}`} data-row-index={row.index} style={{ top: row.index * ROW_HEIGHT, height: ROW_HEIGHT, width }}>
      <div className={classes.addInner} style={{ paddingInlineStart: (selecting ? SELECT_W : 0) + 6 + 16 + row.depth * 14 + 20 }}>
        {mode ? (
          <input
            key={mode + String(busy)}
            className={classes.renameInput}
            autoFocus
            disabled={busy}
            placeholder={mode === 'TASK' ? t('grid.newTaskPlaceholder') : t('grid.newMilestonePlaceholder')}
            aria-label={mode === 'TASK' ? t('grid.addTask') : t('grid.addMilestone')}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim();
                void submit(v).then(() => setMode((m) => (v ? m : null)));
              }
              if (e.key === 'Escape') setMode(null);
            }}
            onBlur={(e) => {
              if (!e.currentTarget.value.trim()) setMode(null);
            }}
          />
        ) : (
          <>
            <button type="button" className={classes.addLink} onClick={() => setMode('TASK')}>
              <IconPlus size={14} aria-hidden />
              {t('grid.addTask')}
            </button>
            <span className={classes.addSep} aria-hidden>
              |
            </span>
            <button type="button" className={classes.addLink} onClick={() => setMode('MILESTONE')}>
              {t('grid.addMilestone')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function HeaderRow({ row, collapsed, onToggle, focused, onFocusRow }: { row: GanttRow; collapsed: boolean; onToggle(id: string): void; focused: boolean; onFocusRow(i: number): void }) {
  const h = row.header!;
  return (
    <div
      className={`${classes.row} ${classes.headerRow}`}
      role="row"
      aria-level={1}
      aria-expanded={!collapsed}
      data-row
      data-row-index={row.index}
      tabIndex={focused ? 0 : -1}
      style={{ top: row.index * ROW_HEIGHT, height: ROW_HEIGHT }}
      onClick={() => {
        onFocusRow(row.index);
        onToggle(row.id);
      }}
    >
      <span className={classes.caret} aria-hidden>
        <span className={collapsed ? 'mirror-rtl' : undefined}>{collapsed ? '▸' : '▾'}</span>
      </span>
      {h.color ? <span className={classes.statusDot} style={{ background: h.color }} aria-hidden /> : null}
      <span className={classes.headerLabel}>{h.label}</span>
      <span className={classes.headerCount}>{formatNumber(h.count)}</span>
    </div>
  );
}

/** Assignee with the vest band in the team colour — always with the team name. */
function Assignee({ a }: { a: NonNullable<TaskDto['assignee']> }) {
  return (
    <span className={`vest ${classes.assignee}`} style={{ '--team': a.teamColor ?? 'var(--muted)' } as CSSProperties} title={a.teamName ? `${a.fullName} — ${a.teamName}` : a.fullName}>
      <span className={classes.assigneeName}>{a.fullName}</span>
      <span className={classes.assigneeTeam}>{a.teamName ?? t('gantt.noTeam')}</span>
    </span>
  );
}

function HoverCard({ task, x, y, digits, rootWidth }: { task: TaskDto; x: number; y: number; digits: Digits; rootWidth: number }) {
  const desc = task.description?.trim();
  const excerpt = desc ? (desc.length > 140 ? `${desc.slice(0, 139)}…` : desc) : t('bar.noDescription');
  const left = Math.max(8, Math.min(rootWidth - 288, x - 140));
  return (
    <div className={classes.hoverCard} style={{ left, top: y + 18 }} role="tooltip">
      <div className={classes.hoverTitle}>{task.name}</div>
      <div className={classes.hoverDesc} data-empty={!desc || undefined}>
        {excerpt}
      </div>
      <div className={classes.hoverMeta}>
        <span>{t('bar.tooltipDates', { start: when(task.startDate, digits), end: when(task.endDate, digits) })}</span>
        <span>{t('bar.tooltipProgress', { value: formatNumber(Math.round(task.progress)) })}</span>
        {task.assignee ? <span>{task.assignee.fullName}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- timeline parts

const TimeHeader = memo(function TimeHeader(p: {
  scale: TimeScale;
  fromDay: number;
  toDay: number;
  x0: number;
  width: number;
  zoom: Zoom;
  digits: Digits;
  showHijri: boolean;
  unit: 'DAY' | 'HOUR';
  nowPos: number;
}) {
  const { scale } = p;
  const h = HEADER_ROW * (p.unit === 'HOUR' ? 2 : 2 + (p.showHijri ? (p.zoom === 'day' ? 2 : 1) : 0));
  const seg = (from: number, to: number, label: string, y: number, cls: string | undefined, key: string) => {
    const x1 = xOfPos(scale, from);
    const x2 = xOfPos(scale, to);
    const w = x1 - x2;
    return (
      <g key={key}>
        <line className={classes.headSep} x1={x1} x2={x1} y1={y} y2={y + HEADER_ROW} />
        {/* A label is drawn only where it fits (≈ 6 px per character at 11 px). */}
        {label.length * 7 + 6 <= w ? (
          <text className={cls} x={x2 + w / 2} y={y + 16} textAnchor="middle">
            {label}
          </text>
        ) : null}
      </g>
    );
  };
  let rowsOut: JSX.Element[] = [];
  if (p.unit === 'HOUR') {
    const r = hourRows(p.fromDay, p.toDay, p.zoom, p.digits);
    rowsOut = [
      ...r.top.map((s) => seg(s.from, s.to, s.label, 0, classes.headTop, `t${s.from}`)),
      ...r.bottom.map((s) => seg(s.from, s.to, s.label, HEADER_ROW, classes.headText, `b${s.from}`)),
    ];
  } else {
    const greg = gregorianRows(p.fromDay, p.toDay, p.zoom, p.digits);
    const hijri = p.showHijri ? hijriRows(p.fromDay, p.toDay, p.zoom, p.digits) : [];
    rowsOut = [
      ...greg.top.map((s) => seg(s.fromDay, s.toDay + 1, s.label, 0, classes.headTop, `t${s.fromDay}`)),
      ...greg.bottom.map((s) => seg(s.fromDay, s.toDay + 1, s.label, HEADER_ROW, classes.headText, `b${s.fromDay}`)),
      ...hijri.flatMap((segs, i) => segs.map((s) => seg(s.fromDay, s.toDay + 1, s.label, HEADER_ROW * (2 + i), classes.headHijri, `h${i}${s.fromDay}`))),
      ...hijri.map((_, i) => <line key={`hs${i}`} className={classes.headSep} x1={p.x0} x2={p.x0 + p.width} y1={HEADER_ROW * (2 + i)} y2={HEADER_ROW * (2 + i)} />),
    ];
  }
  const nowX = xOfPos(scale, p.nowPos);
  const showNow = p.nowPos >= p.fromDay && p.nowPos <= p.toDay + 1;
  const label = p.unit === 'HOUR' ? t('bar.now') : t('bar.today');
  const lw = label.length * 7 + 14;
  return (
    <svg className={classes.headerSvg} style={{ left: p.x0 }} width={p.width} height={h} viewBox={`${p.x0} 0 ${p.width} ${h}`}>
      <rect x={p.x0} y={0} width={p.width} height={h} className={classes.headBg} />
      {rowsOut}
      <line className={classes.headSep} x1={p.x0} x2={p.x0 + p.width} y1={HEADER_ROW} y2={HEADER_ROW} />
      {showNow ? (
        <g>
          <rect className={classes.todayPill} x={nowX - lw / 2} y={h - 19} width={lw} height={17} rx={8.5} />
          <text className={classes.todayText} x={nowX} y={h - 6.5} textAnchor="middle">
            {label}
          </text>
        </g>
      ) : null}
    </svg>
  );
});

const Shading = memo(function Shading(p: {
  cal: ReturnType<typeof calendarOf>;
  scale: TimeScale;
  fromDay: number;
  toDay: number;
  y0: number;
  h: number;
  holidays: GanttDto['calendar']['exceptions'];
  /** HOUR projects at hour/day zoom: non-working hours of working days are shaded too. */
  hourly?: boolean;
}) {
  const holidayNames = useMemo(() => new Map(p.holidays.filter((e) => !e.isWorking).map((e) => [toDayNumber(e.date), e.name])), [p.holidays]);
  const out: JSX.Element[] = [];
  let runStart: number | null = null;
  const flush = (endDay: number) => {
    if (runStart === null) return;
    out.push(<rect key={`w${runStart}`} className={classes.weekend} x={dayEndX(p.scale, endDay)} width={(endDay - runStart + 1) * p.scale.dayWidth} y={p.y0} height={p.h} />);
    runStart = null;
  };
  for (let d = p.fromDay; d <= p.toDay; d++) {
    const name = holidayNames.get(d);
    if (name) {
      flush(d - 1);
      out.push(
        <rect key={`h${d}`} className={classes.holiday} x={dayEndX(p.scale, d)} width={p.scale.dayWidth} y={p.y0} height={p.h}>
          <title>{name}</title>
        </rect>,
      );
    } else if (!p.cal.isWorkingDayNum(d)) {
      if (runStart === null) runStart = d;
    } else {
      flush(d - 1);
      if (p.hourly) {
        const iso = new Date(d * 86_400_000).toISOString().slice(0, 10);
        let cursor = 0;
        const gaps: Array<[number, number]> = [];
        for (const w of p.cal.workingIntervals(iso)) {
          const s = Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3, 5));
          const e = Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3, 5));
          if (s > cursor) gaps.push([cursor, s]);
          cursor = e;
        }
        if (cursor < 1440) gaps.push([cursor, 1440]);
        for (const [s, e] of gaps) {
          const x1 = xOfPos(p.scale, d + s / 1440);
          const x2 = xOfPos(p.scale, d + e / 1440);
          out.push(<rect key={`n${d}-${s}`} className={classes.offHours} x={x2} width={x1 - x2} y={p.y0} height={p.h} />);
        }
      }
    }
  }
  flush(p.toDay);
  return <g aria-hidden>{out}</g>;
});

function RowLines({ first, last, x0, w, selectedRows, rows }: { first: number; last: number; x0: number; w: number; selectedRows?: ReadonlySet<string>; rows: GanttRow[] }) {
  const lines: JSX.Element[] = [];
  for (let i = first; i <= last + 1; i++) {
    const r = rows[i];
    if (r && selectedRows?.size && isTaskRow(r) && selectedRows.has(r.task.id)) {
      lines.push(<rect key={`s${i}`} className={classes.selectedRow} x={x0} width={w} y={i * ROW_HEIGHT} height={ROW_HEIGHT} />);
    }
    lines.push(<line key={i} className={classes.rowLine} x1={x0} x2={x0 + w} y1={i * ROW_HEIGHT} y2={i * ROW_HEIGHT} />);
  }
  return <g aria-hidden>{lines}</g>;
}

function Arrows(p: { data: GanttDto; rowOf: Map<string, GanttRow>; bars: BarGeom[]; first: number; last: number; preview: Preview | null }) {
  const out: JSX.Element[] = [];
  for (const d of p.data.dependencies) {
    if (d.type !== 'FS') continue;
    const a = p.rowOf.get(d.predecessorId);
    const b = p.rowOf.get(d.successorId);
    if (!a || !b) continue; // inside a collapsed group or filtered out
    const lo = Math.min(a.index, b.index);
    const hi = Math.max(a.index, b.index);
    if (hi < p.first || lo > p.last) continue; // fully outside the window
    const shifted = p.preview?.byId.has(d.successorId);
    out.push(<path key={d.id} className={shifted ? classes.arrowActive : classes.arrow} d={dependencyPath(p.bars[a.index]!, p.bars[b.index]!)} markerEnd="url(#nz-arrow)" />);
  }
  return (
    <g aria-hidden>
      <defs>
        <marker id="nz-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8z" className={classes.arrowHead} />
        </marker>
      </defs>
      {out}
    </g>
  );
}

/** Short date range of a summary bar: «١ أكت – ٢٠ نوف». */
function rangeLabel(task: TaskDto, digits: Digits): string {
  if (task.startDate.length > 10) {
    // HOUR projects: «٢٠ أكتوبر ٩:٠٠ ص – ١:٠٠ م» on one day, full date-times otherwise.
    const sameDay = task.startDate.slice(0, 10) === task.endDate.slice(0, 10);
    return `${dateTimeLabel(task.startDate, digits)} – ${sameDay ? dateTimeLabel(task.endDate, digits).split(' ').slice(-2).join(' ') : dateTimeLabel(task.endDate, digits)}`;
  }
  return `${shortDate(task.startDate.slice(0, 10), digits)} – ${shortDate(task.endDate.slice(0, 10), digits)}`;
}

/** «متأخرة يومًا واحدًا / يومين / ٥ أيام / ١٢ يومًا» (Arabic number agreement). */
export function overdueLabel(days: number): string {
  if (days === 1) return t('bar.overdueOne');
  if (days === 2) return t('bar.overdueTwo');
  if (days >= 3 && days <= 10) return t('bar.overdueFew', { count: formatNumber(days) });
  return t('bar.overdue', { count: formatNumber(days) });
}

const Bar = memo(function Bar(p: {
  bar: BarGeom;
  task: TaskDto;
  scale: TimeScale;
  editable: boolean;
  today: string;
  dragging: boolean;
  linkTarget: boolean;
  digits: Digits;
  labels: ReadonlyMap<string, LabelDto> | null;
  photo: string | null;
  onHover(task: TaskDto | null, e?: ReactPointerEvent): void;
}) {
  const { bar, task } = p;
  const late = overdueDays(task, p.today);
  const aria = `${task.wbs} ${task.name}`;
  const hoverProps = {
    onPointerEnter: (e: ReactPointerEvent) => p.onHover(task, e),
    onPointerMove: (e: ReactPointerEvent) => p.onHover(task, e),
    onPointerLeave: () => p.onHover(null),
  };
  // Deadline flag at the end of its day; dashed connector from the bar end when it is later.
  const deadline = task.deadline ? (
    <DeadlineFlag task={task} bar={bar} scale={p.scale} />
  ) : null;

  if (bar.kind === 'milestone') {
    const cx = (bar.startX + bar.endX) / 2;
    const cy = bar.y + bar.h / 2;
    const r = 8;
    return (
      <g data-task-id={task.id} data-bar className={`${classes.bar} ${p.dragging ? classes.dragging : ''}`} data-handle="move" aria-label={aria} {...hoverProps}>
        {deadline}
        <path d={`M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`} className={task.status === 'DONE' ? classes.milestoneDone : classes.milestone} style={task.barColor ? { fill: task.barColor } : undefined} />
        <text className={classes.barLabel} x={cx - r - 6} y={cy + 4} textAnchor="end">
          {task.name}
        </text>
        {p.editable ? <circle data-handle="link" className={classes.linkHandle} cx={cx - r - 6} cy={cy} r={5} /> : null}
      </g>
    );
  }
  if (bar.kind === 'group') {
    return (
      <g data-task-id={task.id} data-bar className={classes.bar} data-handle="move" aria-label={aria} {...hoverProps}>
        {deadline}
        <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} className={classes.group} rx={2} style={task.barColor ? { fill: task.barColor } : undefined} />
        <rect x={bar.startX - bar.progressW} y={bar.y} width={bar.progressW} height={bar.h} className={classes.groupProgress} rx={2} />
        <path d={`M${bar.x} ${bar.y + bar.h}l0 5l6 -5z`} className={classes.group} />
        <path d={`M${bar.startX} ${bar.y + bar.h}l0 5l-6 -5z`} className={classes.group} />
        <text className={classes.rangeLabel} x={bar.x - 8} y={bar.y + bar.h / 2 + 4} textAnchor="end">
          {rangeLabel(task, p.digits)}
        </text>
        {p.editable ? <circle data-handle="link" className={classes.linkHandle} cx={bar.x - 8} cy={bar.y + bar.h / 2} r={5} /> : null}
      </g>
    );
  }
  const color = task.barColor;
  const cls = task.status === 'DONE' ? classes.taskDone : late ? classes.taskLate : classes.task;
  const avR = 10;
  const avX = bar.x - 6 - avR;
  const cy = bar.y + BAR_HEIGHT / 2;
  const after = task.assignee ? avX - avR - 6 : bar.x - 8;
  const labelChips = p.labels ? (task.labelIds ?? []).map((id) => p.labels!.get(id)).filter((l): l is LabelDto => !!l).slice(0, 3) : [];
  return (
    <g data-task-id={task.id} data-bar className={`${classes.bar} ${p.dragging ? classes.dragging : ''} ${p.linkTarget ? classes.linkTarget : ''}`} data-handle="move" aria-label={aria} {...hoverProps}>
      {deadline}
      <rect
        x={bar.x}
        y={bar.y}
        width={bar.w}
        height={bar.h}
        rx={4}
        className={cls}
        style={color && task.status !== 'DONE' ? { fill: `color-mix(in srgb, ${color} 30%, var(--panel))`, stroke: late ? undefined : color } : undefined}
      />
      {/* Progress fills from the start edge (right) towards the end. */}
      <rect x={bar.startX - bar.progressW} y={bar.y} width={bar.progressW} height={bar.h} rx={4} className={classes.progress} style={color ? { fill: color } : undefined} />
      {labelChips.map((l, i) => (
        <rect key={l.id} x={bar.startX - 8 - i * 10} y={bar.y + 5} width={7} height={bar.h - 10} rx={2} className={classes.labelChipBar} style={{ fill: l.color }} />
      ))}
      {task.assignee ? (
        <g className={classes.avatar}>
          <circle cx={avX} cy={cy} r={avR + 1.5} className={classes.avatarRing} style={task.assignee.teamColor ? { stroke: task.assignee.teamColor } : undefined} />
          {p.photo ? (
            <image href={p.photo} x={avX - avR} y={cy - avR} width={avR * 2} height={avR * 2} clipPath="url(#nz-av)" preserveAspectRatio="xMidYMid slice" />
          ) : (
            <>
              <circle cx={avX} cy={cy} r={avR} className={classes.avatarBg} />
              <text className={classes.avatarText} x={avX} y={cy + 3.5} textAnchor="middle">
                {initials(task.assignee.fullName)}
              </text>
            </>
          )}
        </g>
      ) : null}
      {late > 0 ? (
        <text className={classes.overdueLabel} x={after} y={cy + 4} textAnchor="end">
          {overdueLabel(late)}
        </text>
      ) : task.assignee ? (
        <text className={classes.barLabel} x={after} y={cy + 4} textAnchor="end">
          {task.assignee.fullName}
        </text>
      ) : null}
      {p.editable ? (
        <>
          <rect data-handle="resize" className={classes.resize} x={bar.x - 3} y={bar.y} width={8} height={bar.h} />
          <circle data-handle="link" className={classes.linkHandle} cx={bar.startX + 9} cy={cy} r={5} />
        </>
      ) : null}
    </g>
  );
});

function DeadlineFlag({ task, bar, scale }: { task: TaskDto; bar: BarGeom; scale: TimeScale }) {
  const pos = toDayNumber(task.deadline!) + 1; // the end of the deadline day
  const x = xOfPos(scale, pos);
  const passed = Boolean(task.deadlinePassed);
  const y = bar.y + bar.h / 2;
  const later = x < bar.x - 2;
  const end = endPos(task);
  void end;
  return (
    <g className={passed ? classes.deadlinePassed : classes.deadline} aria-hidden>
      {later ? <line x1={bar.x} x2={x} y1={y} y2={y} className={classes.deadlineLink} /> : null}
      <line x1={x} x2={x} y1={bar.y - 6} y2={bar.y + bar.h + 4} className={classes.deadlinePole} />
      <path d={`M${x} ${bar.y - 6}l-9 3.5l9 3.5z`} className={classes.deadlineFlag} />
    </g>
  );
}

export { barFor };
