/**
 * Gantt geometry (ADR-016, skill nuzli-arabic-rtl "Gantt"). Pure functions, no DOM.
 *
 * Time flows right → left. Positions are computed in "logical x" (pixels from the chart's
 * right edge, growing with time) and converted once: `x = width − logicalX`. So a later date
 * always has a smaller physical x, and dragging a bar to the LEFT moves it LATER.
 * The timeline itself is drawn in an LTR box (ADR-077) so `scrollLeft` and SVG x are plain
 * physical pixels in every browser.
 *
 * A9: HOUR projects use fractional day positions (minute number / 1440) with wider zoom levels
 * (hour / day / week); rows also carry the inline «إضافة مهمة | إضافة معلَم» lines and the
 * grouping headers.
 */
import { MINUTES_PER_DAY, toDayNumber, fromDayNumber, toMinuteNumber } from '@nuzli/scheduling';
import type { TaskDto, TaskType } from '@nuzli/shared';

export type Zoom = 'hour' | 'day' | 'week' | 'month' | 'quarter';
/** DAY projects. */
export const ZOOMS: Zoom[] = ['day', 'week', 'month', 'quarter'];
/** HOUR projects (A9): hour / day / week. */
export const HOUR_ZOOMS: Zoom[] = ['hour', 'day', 'week'];
export const zoomsFor = (unit: 'DAY' | 'HOUR' = 'DAY'): Zoom[] => (unit === 'HOUR' ? HOUR_ZOOMS : ZOOMS);

/** Pixels per calendar day at each zoom level (DAY projects; `hour` falls back to `day`). */
export const DAY_WIDTH: Record<Zoom, number> = { hour: 34, day: 34, week: 14, month: 4.5, quarter: 1.6 };
/** Pixels per calendar day in HOUR projects: 40 px, 8 px and 2 px an hour. */
export const HOUR_DAY_WIDTH: Record<Zoom, number> = { hour: 960, day: 192, week: 48, month: 12, quarter: 4 };

export function dayWidthFor(zoom: Zoom, unit: 'DAY' | 'HOUR' = 'DAY'): number {
  return unit === 'HOUR' ? HOUR_DAY_WIDTH[zoom] : DAY_WIDTH[zoom];
}

export const ROW_HEIGHT = 36;
export const BAR_HEIGHT = 18;
export const OVERSCAN_ROWS = 8;

/** −1: time runs right-to-left (the product is Arabic-first). Kept explicit for tests. */
export const TIME_DIR = -1 as const;

export interface TimeScale {
  /** First and last day shown (day numbers, UTC). */
  startDay: number;
  endDay: number;
  dayWidth: number;
  /** Total width of the timeline in px. */
  width: number;
}

export function makeScale(fromDay: number, toDay: number, zoom: Zoom | number): TimeScale {
  const dayWidth = typeof zoom === 'number' ? zoom : DAY_WIDTH[zoom];
  const startDay = Math.min(fromDay, toDay);
  const endDay = Math.max(fromDay, toDay);
  return { startDay, endDay, dayWidth, width: Math.ceil((endDay - startDay + 1) * dayWidth) };
}

/**
 * Timeline position of a task edge, in (fractional) day numbers. DAY projects: the start is the
 * start of its day and the end the end of its (inclusive) last day. HOUR projects: local
 * date-times (`YYYY-MM-DDTHH:MM`, end exclusive) → minute numbers / 1440.
 */
export const posOf = (iso: string): number => (iso.length > 10 ? toMinuteNumber(iso) / MINUTES_PER_DAY : toDayNumber(iso));
export const startPos = (t: Pick<TaskDto, 'startDate'>): number => posOf(t.startDate);
export const endPos = (t: Pick<TaskDto, 'endDate'>): number => (t.endDate.length > 10 ? posOf(t.endDate) : toDayNumber(t.endDate) + 1);

/** Scale for a project: its tasks plus padding (more padding on the "later" side for drags). */
export function projectScale(
  tasks: ReadonlyArray<Pick<TaskDto, 'startDate' | 'endDate'>>,
  zoom: Zoom,
  today: number,
  projectStart?: string,
  /** The chart is at least this wide: extra days are added on the later (left) side. */
  minWidth = 0,
  unit: 'DAY' | 'HOUR' = 'DAY',
): TimeScale {
  let lo = projectStart ? toDayNumber(projectStart) : today;
  let hi = lo;
  for (const t of tasks) {
    const s = toDayNumber(t.startDate);
    const e = toDayNumber(t.endDate);
    if (s < lo) lo = s;
    if (e > hi) hi = e;
  }
  lo = Math.min(lo, today);
  hi = Math.max(hi, today);
  const dw = dayWidthFor(zoom, unit);
  const pad =
    unit === 'HOUR'
      ? zoom === 'hour'
        ? 1
        : zoom === 'day'
          ? 3
          : 10
      : zoom === 'day'
        ? 14
        : zoom === 'week'
          ? 28
          : zoom === 'month'
            ? 60
            : 120;
  const s = makeScale(lo - pad, hi + pad * 2, dw);
  if (s.width >= minWidth) return s;
  return makeScale(s.startDay, s.startDay + Math.ceil(minWidth / s.dayWidth), dw);
}

/**
 * «ملاءمة الشاشة»: the largest zoom of the unit whose scale fits the project span (plus a little
 * padding) in `viewportWidth`; the smallest zoom when nothing fits.
 */
export function fitZoom(
  tasks: ReadonlyArray<Pick<TaskDto, 'startDate' | 'endDate'>>,
  viewportWidth: number,
  unit: 'DAY' | 'HOUR' = 'DAY',
): Zoom {
  if (!tasks.length) return unit === 'HOUR' ? 'day' : 'week';
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of tasks) {
    lo = Math.min(lo, startPos(t));
    hi = Math.max(hi, endPos(t));
  }
  const span = Math.max(1, hi - lo) * 1.1;
  const zooms = zoomsFor(unit);
  for (const z of zooms) if (span * dayWidthFor(z, unit) <= viewportWidth) return z;
  return zooms[zooms.length - 1]!;
}

/** Logical x (from the right edge) of the start of `day`. */
export const logicalX = (s: TimeScale, day: number): number => (day - s.startDay) * s.dayWidth;

/** Physical x of a (fractional) day position. Later → smaller x (RTL). */
export const xOfPos = (s: TimeScale, pos: number): number => s.width - (pos - s.startDay) * s.dayWidth;

/** Physical x of the START edge of a day (its right side in RTL). Later day → smaller x. */
export const dayStartX = (s: TimeScale, day: number): number => s.width - logicalX(s, day);

/** Physical x of the END edge of a day (its left side in RTL). */
export const dayEndX = (s: TimeScale, day: number): number => s.width - logicalX(s, day + 1);

/** The day under a physical x. */
export const xToDay = (s: TimeScale, x: number): number => s.startDay + Math.floor((s.width - x) / s.dayWidth);

/**
 * Calendar days moved by a pointer drag of `dx` physical pixels. In RTL (`TIME_DIR = −1`),
 * a negative dx (towards the left) is a positive (later) delta.
 */
export function dragDeltaDays(dx: number, dayWidth: number, dir: 1 | -1 = TIME_DIR): number {
  const days = (dx * dir) / dayWidth;
  return Math.round(days) || 0;
}

/** HOUR projects (A9): wall-clock minutes moved by a drag of `dx` px, snapped to `step` (15) minutes. */
export function dragDeltaMinutes(dx: number, dayWidth: number, step = 15, dir: 1 | -1 = TIME_DIR): number {
  const minutes = ((dx * dir) / dayWidth) * MINUTES_PER_DAY;
  return Math.round(minutes / step) * step || 0;
}

// ---------------------------------------------------------------- rows

export interface GanttRow {
  index: number;
  id: string;
  depth: number;
  hasChildren: boolean;
  /** The task of a task line; for a header line its first task; for an add line `undefined`. */
  task: TaskDto;
  /** A9 line kinds: a task (default), the inline «إضافة مهمة | إضافة معلَم» line, a grouping header. */
  kind?: 'task' | 'add' | 'header';
  /** `add` lines: the parent of the task to create (null = the project root). */
  addParentId?: string | null;
  /** `header` lines: the group label, its count and an optional colour. */
  header?: { key: string; label: string; count: number; color?: string | null };
}

export const isTaskRow = (r: GanttRow): boolean => !r.kind || r.kind === 'task';

export interface RowGroup {
  key: string;
  label: string;
  color?: string | null;
  order?: number;
}

export interface RowOptions {
  /** Toolbar filter: matching tasks are shown with their ancestors (hierarchy mode). */
  visible?: (t: TaskDto) => boolean;
  /** Inline add lines after each expanded group's children and at the end (editable users). */
  addRows?: boolean;
  /** Grouping (A9 «التجميع»): leaf tasks under header lines; null = the WBS hierarchy. */
  groupBy?: ((t: TaskDto) => RowGroup[]) | null;
}

/**
 * The visible rows: tasks in WBS order (the API sends them sorted), skipping the descendants
 * of collapsed groups. Depth comes from the WBS code. O(n). With options (A9): a filter keeps the
 * matches and their ancestors; `addRows` inserts the inline add lines; `groupBy` flattens leaves
 * under header lines (a task with two labels appears under both).
 */
export function buildRows(tasks: readonly TaskDto[], collapsed: ReadonlySet<string>, opts: RowOptions = {}): GanttRow[] {
  const hasChildren = new Set<string>();
  for (const t of tasks) if (t.parentId) hasChildren.add(t.parentId);
  const rows: GanttRow[] = [];
  const push = (r: Omit<GanttRow, 'index'>) => {
    rows.push({ ...r, index: rows.length });
  };
  const depthOf = (t: TaskDto) => (t.wbs ? t.wbs.split('.').length - 1 : 0);

  if (opts.groupBy) {
    const buckets = new Map<string, { label: string; color?: string | null; order: number; tasks: TaskDto[] }>();
    for (const t of tasks) {
      if (hasChildren.has(t.id)) continue;
      if (opts.visible && !opts.visible(t)) continue;
      for (const g of opts.groupBy(t)) {
        const b = buckets.get(g.key) ?? { label: g.label, color: g.color, order: g.order ?? 0, tasks: [] };
        b.tasks.push(t);
        buckets.set(g.key, b);
      }
    }
    const ordered = [...buckets.entries()].sort((a, b) => a[1].order - b[1].order || a[1].label.localeCompare(b[1].label, 'ar'));
    for (const [key, b] of ordered) {
      const hid = `hdr:${key}`;
      push({ id: hid, depth: 0, hasChildren: true, task: b.tasks[0]!, kind: 'header', header: { key, label: b.label, count: b.tasks.length, color: b.color } });
      if (collapsed.has(hid)) continue;
      for (const t of b.tasks) push({ id: `${hid}|${t.id}`, depth: 1, hasChildren: false, task: t });
    }
    return rows;
  }

  let include: Set<string> | null = null;
  if (opts.visible) {
    include = new Set();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (!opts.visible(t)) continue;
      for (let cur: TaskDto | undefined = t, guard = 0; cur && !include.has(cur.id) && guard < 500; guard++) {
        include.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
  }
  // Open groups whose add line is still pending, innermost last.
  const open: Array<{ id: string; depth: number }> = [];
  const flushTo = (depth: number) => {
    while (open.length && open[open.length - 1]!.depth >= depth) {
      const g = open.pop()!;
      push({ id: `add:${g.id}`, depth: g.depth + 1, hasChildren: false, task: undefined as unknown as TaskDto, kind: 'add', addParentId: g.id });
    }
  };
  const hidden = new Set<string>();
  for (const t of tasks) {
    if (t.parentId && (hidden.has(t.parentId) || collapsed.has(t.parentId))) {
      hidden.add(t.id);
      continue;
    }
    if (include && !include.has(t.id)) continue;
    const depth = depthOf(t);
    if (opts.addRows) flushTo(depth);
    push({ id: t.id, depth, hasChildren: hasChildren.has(t.id), task: t });
    if (opts.addRows && hasChildren.has(t.id) && !collapsed.has(t.id)) open.push({ id: t.id, depth });
  }
  if (opts.addRows) {
    flushTo(0);
    push({ id: 'add:root', depth: 0, hasChildren: false, task: undefined as unknown as TaskDto, kind: 'add', addParentId: null });
  }
  return rows;
}

export type BarKind = 'task' | 'group' | 'milestone';

export interface BarGeom {
  id: string;
  row: number;
  /** Physical left edge (= the task's END in RTL) and width. */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: BarKind;
  /** Physical x of the start edge (right side) and end edge (left side). */
  startX: number;
  endX: number;
  /** Width of the progress fill, measured from the start edge. */
  progressW: number;
}

const kindOf = (type: TaskType, hasChildren: boolean): BarKind =>
  type === 'MILESTONE' && !hasChildren ? 'milestone' : type === 'GROUP' || hasChildren ? 'group' : 'task';

/** Geometry of one task bar on one row (fractional positions for HOUR projects). */
export function barFor(row: GanttRow, task: Pick<TaskDto, 'startDate' | 'endDate' | 'progress' | 'type'>, s: TimeScale, rowHeight = ROW_HEIGHT): BarGeom {
  const kind = kindOf(task.type, row.hasChildren);
  const hour = task.startDate.length > 10;
  const startX = xOfPos(s, startPos(task));
  // A DAY milestone occupies its day; an HOUR milestone is an instant (a small fixed width).
  const endX = kind === 'milestone' ? startX - (hour ? Math.min(16, Math.max(8, s.dayWidth / 24)) : s.dayWidth) : xOfPos(s, endPos(task));
  const w = Math.max(kind === 'milestone' ? 0 : 2, startX - endX);
  const h = kind === 'group' ? 10 : BAR_HEIGHT;
  return {
    id: row.id,
    row: row.index,
    x: endX,
    y: row.index * rowHeight + (rowHeight - h) / 2,
    w,
    h,
    kind,
    startX,
    endX,
    progressW: (w * Math.max(0, Math.min(100, task.progress))) / 100,
  };
}

/**
 * Bars for every row (the "render model"). Kept allocation-light so 2,000 tasks stay well
 * under one frame (benchmarked in gantt.test.ts). Add and header lines get an empty geometry.
 */
export function barGeometry(rows: readonly GanttRow[], s: TimeScale, override?: ReadonlyMap<string, TaskDto>, rowHeight = ROW_HEIGHT): BarGeom[] {
  const out = new Array<BarGeom>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === 'add' || r.kind === 'header') {
      out[i] = { id: r.id, row: r.index, x: 0, y: r.index * rowHeight, w: 0, h: 0, kind: 'task', startX: 0, endX: 0, progressW: 0 };
      continue;
    }
    out[i] = barFor(r, override?.get(r.task.id) ?? r.task, s, rowHeight);
  }
  return out;
}

// ---------------------------------------------------------------- virtual window

export interface RowWindow {
  first: number;
  last: number;
}

/** Rows to render: the visible ones plus `overscan` on each side. Bounded by the viewport. */
export function rowWindow(scrollTop: number, viewportHeight: number, rowCount: number, rowHeight = ROW_HEIGHT, overscan = OVERSCAN_ROWS): RowWindow {
  if (rowCount === 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { first, last };
}

export interface DayWindow {
  fromDay: number;
  toDay: number;
  /** Physical x range covered (with margin). */
  x0: number;
  x1: number;
}

/** Days to render for a horizontal scroll position (LTR box: scrollLeft ≥ 0). */
export function dayWindow(scrollLeft: number, viewportWidth: number, s: TimeScale, marginPx = 200): DayWindow {
  const x0 = Math.max(0, scrollLeft - marginPx);
  const x1 = Math.min(s.width, scrollLeft + viewportWidth + marginPx);
  // Physical left (x0) is the LATER end in RTL.
  const toDay = Math.min(s.endDay, xToDay(s, x0));
  const fromDay = Math.max(s.startDay, xToDay(s, Math.max(0, x1 - 0.001)));
  return { fromDay, toDay, x0, x1 };
}

/** Initial scroll so `day` sits at ~70 % of the viewport from its left edge (earlier dates to its right). */
export function scrollLeftFor(s: TimeScale, day: number, viewportWidth: number): number {
  const x = dayStartX(s, day);
  return Math.max(0, Math.min(s.width - viewportWidth, x - viewportWidth * 0.7));
}

// ---------------------------------------------------------------- dependency arrows

/**
 * FS arrow from the predecessor's END (its left edge) to the successor's START (its right
 * edge), routed below the predecessor and entering the successor from the right, pointing left
 * (the direction time flows).
 */
export function dependencyPath(pred: BarGeom, succ: BarGeom, rowHeight = ROW_HEIGHT): string {
  const py = pred.y + pred.h / 2;
  const sy = succ.y + succ.h / 2;
  const px = pred.endX;
  const sx = succ.startX + (succ.kind === 'milestone' ? 2 : 0);
  const out = px - 8;
  if (sx <= out - 4) {
    // Room to go straight: left, down, left into the successor.
    return `M${px} ${py}H${out}V${sy}H${sx}`;
  }
  const midY = succ.row > pred.row ? succ.row * rowHeight : (succ.row + 1) * rowHeight;
  return `M${px} ${py}H${out}V${midY}H${sx + 10}V${sy}H${sx}`;
}

/** Calendar days from `a` to `b` (b − a), date parts only. */
export const daysBetweenIso = (a: string, b: string): number => toDayNumber(b.slice(0, 10)) - toDayNumber(a.slice(0, 10));

export const isoOfDay = fromDayNumber;
export const dayOf = toDayNumber;
