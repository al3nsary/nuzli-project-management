/**
 * «سجل وقتي» (A9): pure aggregation of `GET /me/time-entries` into the week grid day × task.
 * Weeks are Sunday-first; entries outside the week are ignored.
 */
import type { TimeEntryDto } from '@nuzli/shared';

export interface TaskRef {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

export interface WeekRow {
  task: TaskRef;
  /** Minutes per day, aligned with `days`. */
  byDay: number[];
  /** Entries per day, aligned with `days` (for the edit list). */
  entries: TimeEntryDto[][];
  total: number;
}

export interface WeekGrid {
  days: string[];
  rows: WeekRow[];
  dayTotals: number[];
  total: number;
}

/**
 * Rows = tasks with entries in the week, plus `extra` tasks (assigned to me) with zero minutes.
 * Sorted by project name, then task name (Arabic collation).
 */
export function buildWeekGrid(entries: readonly TimeEntryDto[], days: readonly string[], extra: readonly TaskRef[] = []): WeekGrid {
  const index = new Map(days.map((d, i) => [d, i]));
  const rows = new Map<string, WeekRow>();
  const rowOf = (task: TaskRef) => {
    let r = rows.get(task.id);
    if (!r) {
      r = { task, byDay: days.map(() => 0), entries: days.map(() => []), total: 0 };
      rows.set(task.id, r);
    }
    return r;
  };
  const dayTotals = days.map(() => 0);
  let total = 0;
  for (const e of entries) {
    const i = index.get(e.date.slice(0, 10));
    if (i === undefined) continue;
    const r = rowOf(e.task);
    r.byDay[i]! += e.minutes;
    r.entries[i]!.push(e);
    r.total += e.minutes;
    dayTotals[i]! += e.minutes;
    total += e.minutes;
  }
  for (const t of extra) rowOf(t);
  const coll = new Intl.Collator('ar');
  const sorted = [...rows.values()].sort(
    (a, b) => coll.compare(a.task.projectName, b.task.projectName) || coll.compare(a.task.name, b.task.name),
  );
  for (const r of sorted) for (const list of r.entries) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { days: [...days], rows: sorted, dayTotals, total };
}

/** Hours + minutes fields → minutes (NaN-safe). */
export function toMinutes(hours: number | string | null | undefined, minutes: number | string | null | undefined): number {
  const h = Number(hours) || 0;
  const m = Number(minutes) || 0;
  return Math.round(h * 60 + m);
}

/** Minutes → the two fields of the form. */
export const splitMinutes = (total: number): { hours: number; minutes: number } => ({
  hours: Math.floor(total / 60),
  minutes: total % 60,
});

/** The API accepts 1..1440 minutes per entry. */
export const validMinutes = (m: number): boolean => Number.isInteger(m) && m >= 1 && m <= 1440;

/** Quick durations offered as chips (minutes). */
export const QUICK_MINUTES = [15, 30, 60, 120, 240, 480] as const;
