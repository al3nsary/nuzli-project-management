/**
 * Gantt geometry (ADR-016, skill nuzli-arabic-rtl "Gantt"). Pure functions, no DOM.
 *
 * Time flows right → left. Positions are computed in "logical x" (pixels from the chart's
 * right edge, growing with time) and converted once: `x = width − logicalX`. So a later date
 * always has a smaller physical x, and dragging a bar to the LEFT moves it LATER.
 * The timeline itself is drawn in an LTR box (ADR-077) so `scrollLeft` and SVG x are plain
 * physical pixels in every browser.
 */
import { toDayNumber, fromDayNumber } from '@nuzli/scheduling';
import type { TaskDto, TaskType } from '@nuzli/shared';

export type Zoom = 'day' | 'week' | 'month' | 'quarter';
export const ZOOMS: Zoom[] = ['day', 'week', 'month', 'quarter'];

/** Pixels per calendar day at each zoom level. */
export const DAY_WIDTH: Record<Zoom, number> = { day: 34, week: 14, month: 4.5, quarter: 1.6 };
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

/** Scale for a project: its tasks plus padding (more padding on the "later" side for drags). */
export function projectScale(
  tasks: ReadonlyArray<Pick<TaskDto, 'startDate' | 'endDate'>>,
  zoom: Zoom,
  today: number,
  projectStart?: string,
  /** The chart is at least this wide: extra days are added on the later (left) side. */
  minWidth = 0,
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
  const pad = zoom === 'day' ? 14 : zoom === 'week' ? 28 : zoom === 'month' ? 60 : 120;
  const s = makeScale(lo - pad, hi + pad * 2, zoom);
  if (s.width >= minWidth) return s;
  return makeScale(s.startDay, s.startDay + Math.ceil(minWidth / s.dayWidth), zoom);
}

/** Logical x (from the right edge) of the start of `day`. */
export const logicalX = (s: TimeScale, day: number): number => (day - s.startDay) * s.dayWidth;

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

// ---------------------------------------------------------------- rows

export interface GanttRow {
  index: number;
  id: string;
  depth: number;
  hasChildren: boolean;
  task: TaskDto;
}

/**
 * The visible rows: tasks in WBS order (the API sends them sorted), skipping the descendants
 * of collapsed groups. Depth comes from the WBS code. O(n).
 */
export function buildRows(tasks: readonly TaskDto[], collapsed: ReadonlySet<string>): GanttRow[] {
  const hasChildren = new Set<string>();
  for (const t of tasks) if (t.parentId) hasChildren.add(t.parentId);
  const rows: GanttRow[] = [];
  const hidden = new Set<string>();
  for (const t of tasks) {
    if (t.parentId && (hidden.has(t.parentId) || collapsed.has(t.parentId))) {
      hidden.add(t.id);
      continue;
    }
    rows.push({
      index: rows.length,
      id: t.id,
      depth: t.wbs ? t.wbs.split('.').length - 1 : 0,
      hasChildren: hasChildren.has(t.id),
      task: t,
    });
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

/** Geometry of one task bar on one row. */
export function barFor(row: GanttRow, task: Pick<TaskDto, 'startDate' | 'endDate' | 'progress' | 'type'>, s: TimeScale, rowHeight = ROW_HEIGHT): BarGeom {
  const sd = toDayNumber(task.startDate);
  const ed = toDayNumber(task.endDate);
  const kind = kindOf(task.type, row.hasChildren);
  const startX = dayStartX(s, sd);
  const endX = kind === 'milestone' ? startX - s.dayWidth : dayEndX(s, ed);
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
 * under one frame (benchmarked in geometry.test.ts).
 */
export function barGeometry(rows: readonly GanttRow[], s: TimeScale, override?: ReadonlyMap<string, TaskDto>, rowHeight = ROW_HEIGHT): BarGeom[] {
  const out = new Array<BarGeom>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    out[i] = barFor(r, override?.get(r.id) ?? r.task, s, rowHeight);
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

export const isoOfDay = fromDayNumber;
export const dayOf = toDayNumber;
