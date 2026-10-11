// Test-only helpers (not exported from the package entry).
import { WorkCalendar, type Calendar } from './calendar';
import type { ScheduleDependency, ScheduleTask, TaskType } from './types';

export interface TestTask extends ScheduleTask {
  readonly name?: string;
}

/** Builds a task whose end is derived from start + duration on `calendar`. */
export function task(
  id: string,
  startDate: string,
  durationDays: number,
  opts: {
    parentId?: string | null;
    sortOrder?: number;
    type?: TaskType;
    progress?: number;
    calendar?: Calendar;
  } = {},
): TestTask {
  const cal = new WorkCalendar(opts.calendar);
  const type = opts.type ?? (durationDays === 0 ? 'MILESTONE' : 'TASK');
  return {
    id,
    parentId: opts.parentId ?? null,
    sortOrder: opts.sortOrder ?? 0,
    type,
    startDate,
    endDate: cal.endFromDuration(startDate, durationDays),
    durationDays,
    progress: opts.progress ?? 0,
  };
}

/** A group placeholder; its dates are recomputed by roll-up. */
export function group(
  id: string,
  opts: { parentId?: string | null; sortOrder?: number } = {},
): TestTask {
  return {
    id,
    parentId: opts.parentId ?? null,
    sortOrder: opts.sortOrder ?? 0,
    type: 'GROUP',
    startDate: '2000-01-01',
    endDate: '2000-01-01',
    durationDays: 1,
    progress: 0,
  };
}

export function fs(predecessorId: string, successorId: string, lagDays = 0): ScheduleDependency {
  return { predecessorId, successorId, type: 'FS', lagDays };
}

export function byId<T extends ScheduleTask>(tasks: readonly T[]): Record<string, T> {
  return Object.fromEntries(tasks.map((t) => [t.id, t]));
}
