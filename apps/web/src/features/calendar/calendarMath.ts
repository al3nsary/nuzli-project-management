/**
 * Pure date math of the project calendar tab (A9 «تقويم», GanttPRO parity).
 *
 * Days are ISO `YYYY-MM-DD` strings computed in UTC (no time zone drift). Weeks start on
 * **Sunday** (skill nuzli-arabic-rtl). Columns are logical: column 0 is Sunday, on the inline
 * start (the right in RTL); CSS grid places it, so only pointer deltas need the direction sign.
 */
import type { DurationUnit } from '../../api/hoursWire';

export type IsoDay = string;

const DAY_MS = 86_400_000;
const ms = (iso: IsoDay) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const iso = (t: number): IsoDay => new Date(t).toISOString().slice(0, 10);

export const addDays = (day: IsoDay, n: number): IsoDay => iso(ms(day) + n * DAY_MS);

/** Whole days from `a` to `b` (b − a). */
export const diffDays = (a: IsoDay, b: IsoDay): number => Math.round((ms(b) - ms(a)) / DAY_MS);

/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (day: IsoDay): number => new Date(ms(day)).getUTCDay();

/** The Sunday that starts the week of `day`. */
export const startOfWeek = (day: IsoDay): IsoDay => addDays(day, -weekdayOf(day));

/** The seven days (Sunday → Saturday) of the week containing `day`. */
export function weekDays(day: IsoDay): IsoDay[] {
  const s = startOfWeek(day);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

export const startOfMonth = (day: IsoDay): IsoDay => `${day.slice(0, 7)}-01`;

/** First day of the month `n` months after the month of `day`. */
export function addMonths(day: IsoDay, n: number): IsoDay {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(yy).padStart(4, '0')}-${String(mm + 1).padStart(2, '0')}-01`;
}

/**
 * The month view: whole Sunday-first weeks from the week of the 1st to the week of the last
 * day (4–6 rows; always complete rows of seven days).
 */
export function monthGrid(day: IsoDay): IsoDay[][] {
  const first = startOfMonth(day);
  const last = addDays(addMonths(day, 1), -1);
  const weeks: IsoDay[][] = [];
  for (let s = startOfWeek(first); s <= last; s = addDays(s, 7)) weeks.push(weekDays(s));
  return weeks;
}

export type CalendarView = 'month' | 'week';

/** The weeks shown for a view anchored on `day`. */
export const viewWeeks = (view: CalendarView, day: IsoDay): IsoDay[][] =>
  view === 'month' ? monthGrid(day) : [weekDays(day)];

/** Previous/next page of a view. */
export const stepAnchor = (view: CalendarView, day: IsoDay, dir: 1 | -1): IsoDay =>
  view === 'month' ? addMonths(day, dir) : addDays(startOfWeek(day), 7 * dir);

/**
 * The days a task covers, inclusive. DAY projects store an inclusive end date; HOUR projects store
 * `YYYY-MM-DDTHH:MM` with an exclusive end, so a bar ending exactly at 00:00 ends the day before.
 * Milestones sit on their start day.
 */
export function taskDays(
  t: { startDate: string; endDate: string; type?: string },
  unit: DurationUnit,
): { start: IsoDay; end: IsoDay } {
  const start = t.startDate.slice(0, 10);
  if (t.type === 'MILESTONE') return { start, end: start };
  let end = t.endDate.slice(0, 10);
  if (unit === 'HOUR' && t.endDate.length > 10) {
    const clock = t.endDate.slice(11, 16);
    if (clock === '00:00' && t.endDate.slice(0, 16) > t.startDate.slice(0, 16)) end = addDays(end, -1);
  }
  if (end < start) end = start;
  return { start, end };
}

// ---------------------------------------------------------------- pointer → days

/**
 * Columns moved by a horizontal pointer delta. `sign` is `dirSign()` (−1 in RTL): in RTL a drag to
 * the left (negative dx) moves the bar to later days.
 */
export function dragDeltaColumns(dx: number, cellWidth: number, sign: 1 | -1): number {
  if (!cellWidth) return 0;
  const v = Math.round((dx * sign) / cellWidth);
  return v === 0 ? 0 : v; // avoid −0
}

/** Days moved by a drag: columns plus seven days per week row crossed. */
export const dragDeltaDays = (dCols: number, dRows: number): number => dCols + 7 * dRows;

// ---------------------------------------------------------------- lane packing

export interface SpanItem {
  id: string;
  start: IsoDay;
  end: IsoDay;
}

export interface Segment {
  id: string;
  /** Logical column (0 = Sunday) where the piece starts and ends, inclusive. */
  colStart: number;
  colEnd: number;
  lane: number;
  /** The item started before this week / goes on after it (square edges). */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface WeekLayout {
  segments: Segment[];
  /** Number of lanes used. */
  lanes: number;
  /** Per column: ids whose piece is in a lane ≥ `maxLanes` (shown as «+N»). */
  hidden: string[][];
}

/**
 * Packs the pieces of a week into lanes so that bars never overlap: items sorted by start, then
 * the longer first, each in the lowest lane free over its columns (`order` breaks ties stably).
 */
export function layoutWeek(week: IsoDay[], items: readonly SpanItem[], maxLanes = Infinity): WeekLayout {
  const first = week[0]!;
  const last = week[week.length - 1]!;
  const pieces = items
    .filter((it) => it.end >= first && it.start <= last)
    .map((it, i) => {
      const s = it.start < first ? first : it.start;
      const e = it.end > last ? last : it.end;
      return {
        id: it.id,
        i,
        colStart: diffDays(first, s),
        colEnd: diffDays(first, e),
        continuesBefore: it.start < first,
        continuesAfter: it.end > last,
      };
    })
    .sort((a, b) => a.colStart - b.colStart || b.colEnd - b.colStart - (a.colEnd - a.colStart) || a.i - b.i);

  const laneEnds: number[] = [];
  const segments: Segment[] = [];
  const hidden: string[][] = week.map(() => []);
  for (const p of pieces) {
    let lane = laneEnds.findIndex((end) => end < p.colStart);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(p.colEnd);
    } else laneEnds[lane] = p.colEnd;
    segments.push({ id: p.id, colStart: p.colStart, colEnd: p.colEnd, lane, continuesBefore: p.continuesBefore, continuesAfter: p.continuesAfter });
    if (lane >= maxLanes) for (let c = p.colStart; c <= p.colEnd; c++) hidden[c]!.push(p.id);
  }
  return { segments, lanes: laneEnds.length, hidden };
}

/** Items covering a given day (the phone day list and the «+N» popover). */
export const itemsOnDay = <T extends SpanItem>(items: readonly T[], day: IsoDay): T[] =>
  items.filter((it) => it.start <= day && it.end >= day);

// ---------------------------------------------------------------- deadlines

export interface DeadlineMark {
  id: string;
  passed: boolean;
}

/**
 * Deadline flags per day. `passed` follows the API flag (`deadlinePassed`) and falls back to the
 * same rule (before today in Riyadh and not DONE) when a preview lacks it.
 */
export function deadlinesByDay(
  tasks: ReadonlyArray<{ id: string; deadline?: string | null; deadlinePassed?: boolean; status: string }>,
  today: IsoDay,
): Map<IsoDay, DeadlineMark[]> {
  const out = new Map<IsoDay, DeadlineMark[]>();
  for (const t of tasks) {
    if (!t.deadline) continue;
    const day = t.deadline.slice(0, 10);
    const passed = t.deadlinePassed ?? (t.status !== 'DONE' && day < today);
    const list = out.get(day) ?? [];
    list.push({ id: t.id, passed });
    out.set(day, list);
  }
  return out;
}

/** Non-working days: weekend days of the calendar plus non-working exceptions (holidays, by name). */
export function dayKind(
  day: IsoDay,
  cal: { weekendDays: number[]; exceptions: ReadonlyArray<{ date: string; isWorking: boolean; name: string }> },
): { weekend: boolean; holiday: string | null; workingException: boolean } {
  const ex = cal.exceptions.find((e) => e.date.slice(0, 10) === day);
  const weekend = cal.weekendDays.includes(weekdayOf(day));
  return {
    weekend: weekend && !(ex?.isWorking ?? false),
    holiday: ex && !ex.isWorking ? ex.name || '' : null,
    workingException: !!ex?.isWorking,
  };
}

/** Where the calendar opens: today when the project covers it, otherwise the first task's start. */
export function initialAnchor(spans: readonly SpanItem[], today: IsoDay): IsoDay {
  if (!spans.length) return today;
  let min = spans[0]!.start;
  let max = spans[0]!.end;
  for (const s of spans) {
    if (s.start < min) min = s.start;
    if (s.end > max) max = s.end;
  }
  return today >= min && today <= max ? today : today < min ? min : max;
}

/** The nearest day with a task outside the range (for the empty state's «go to» action). */
export function nearestOutside(spans: readonly SpanItem[], from: IsoDay, to: IsoDay): IsoDay | null {
  let best: IsoDay | null = null;
  let bestDist = Infinity;
  for (const s of spans) {
    const d = s.start > to ? diffDays(to, s.start) : s.end < from ? diffDays(s.end, from) : 0;
    if (d > 0 && d < bestDist) {
      bestDist = d;
      best = s.start > to ? s.start : s.end;
    }
  }
  return best;
}
