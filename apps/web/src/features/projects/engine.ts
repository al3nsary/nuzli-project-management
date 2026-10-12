/**
 * The API's write rules around `@nuzli/scheduling` (apps/api/src/projects/task-engine.ts),
 * copied as pure functions so the demo adapter behaves exactly like the server (ADR-056/057)
 * and screens can preview the same result. No React, no storage.
 */
import {
  CycleError,
  HierarchyError,
  WorkCalendar,
  computeWbs,
  schedule,
  type ScheduleDependency,
} from '@nuzli/scheduling';
import type { Priority, TaskStatus, TaskType } from '@nuzli/shared';
import { ApiError } from '../../api/errors';

/** The persisted fields of a task that a write may change (dates as `YYYY-MM-DD`). */
export interface StoredTask {
  id: string;
  projectId: string;
  parentId: string | null;
  sortOrder: number;
  wbsCache: string;
  name: string;
  type: TaskType;
  startDate: string;
  endDate: string;
  durationDays: number;
  progress: number;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  description: string | null;
  version: number;
}

/** Fields compared to decide whether a task really changed (→ `version + 1`). */
export const VERSIONED_FIELDS = [
  'parentId',
  'sortOrder',
  'name',
  'type',
  'startDate',
  'endDate',
  'durationDays',
  'progress',
  'status',
  'priority',
  'assigneeId',
  'description',
] as const satisfies ReadonlyArray<keyof StoredTask>;
export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export interface CalendarLike {
  weekendDays: readonly number[];
  exceptions: ReadonlyArray<{ date: string; isWorking: boolean }>;
}

export function workCalendarOf(c: CalendarLike): WorkCalendar {
  return new WorkCalendar({
    weekendDays: c.weekendDays,
    exceptions: c.exceptions.map((e) => ({ date: e.date.slice(0, 10), isWorking: e.isWorking })),
  });
}

/** A milestone has duration 0; a task lasts ≥ 1 working day; end = endFromDuration(start, d). */
export function normalizeLeaf<T extends StoredTask>(t: T, cal: WorkCalendar, snapStart = true): T {
  const start = snapStart ? cal.addWorkingDays(t.startDate, 0) : t.startDate;
  if (t.type === 'MILESTONE') return { ...t, startDate: start, endDate: start, durationDays: 0 };
  const duration = Math.max(1, Math.trunc(t.durationDays));
  return { ...t, startDate: start, durationDays: duration, endDate: cal.endFromDuration(start, duration) };
}

export interface ScheduleEdit {
  startDate?: string;
  endDate?: string;
  durationDays?: number;
}

/** `durationDays` wins over `endDate`; an `endDate` alone becomes a working-day count. */
export function applyScheduleEdit<T extends StoredTask>(t: T, edit: ScheduleEdit, cal: WorkCalendar): T {
  let next: T = { ...t };
  if (edit.startDate !== undefined) next.startDate = edit.startDate;
  next = { ...next, startDate: cal.addWorkingDays(next.startDate, 0) };
  if (edit.durationDays !== undefined) next.durationDays = edit.durationDays;
  else if (edit.endDate !== undefined) next.durationDays = cal.workingDaysBetween(next.startDate, edit.endDate);
  return normalizeLeaf(next, cal, false);
}

/** Ids of `rootId` and every descendant (iterative). */
export function subtreeIds(tasks: ReadonlyArray<Pick<StoredTask, 'id' | 'parentId'>>, rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t.id);
    else children.set(t.parentId, [t.id]);
  }
  const out = [rootId];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
  return out;
}

const invalidParent = (details: unknown) => ApiError.of('TASK_PARENT_INVALID', 400, details);

/** Not a milestone, same project, and neither the task itself nor one of its descendants. */
export function assertValidParent(
  tasks: ReadonlyMap<string, StoredTask>,
  taskId: string | null,
  parentId: string | null,
): void {
  if (parentId === null) return;
  const parent = tasks.get(parentId);
  if (!parent || parent.type === 'MILESTONE') throw invalidParent({ parentId });
  let cur: StoredTask | undefined = parent;
  for (let guard = 0; cur && guard <= tasks.size; guard++) {
    if (cur.id === taskId) throw invalidParent({ parentId });
    cur = cur.parentId ? tasks.get(cur.parentId) : undefined;
  }
}

/** Sort key between two siblings (fractional insert); `null` = no neighbour on that side. */
export function sortOrderBetween(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 1;
  if (prev === null) return next! - 1;
  if (next === null) return prev + 1;
  return (prev + next) / 2;
}

export const needsRenumber = (prev: number | null, next: number | null): boolean =>
  prev !== null && next !== null && Math.abs(next - prev) < 1e-9;

const cmpId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function siblingsOf<T extends StoredTask>(tasks: readonly T[], parentId: string | null, exceptId?: string): T[] {
  return tasks
    .filter((t) => t.parentId === parentId && t.id !== exceptId)
    .sort((a, b) => a.sortOrder - b.sortOrder || cmpId(a.id, b.id));
}

/** A TASK that holds children becomes a GROUP (ADR-057). */
export function promoteParents<T extends StoredTask>(tasks: T[]): T[] {
  const parents = new Set(tasks.map((t) => t.parentId).filter((p): p is string => !!p));
  return tasks.map((t) => (t.type === 'TASK' && parents.has(t.id) ? { ...t, type: 'GROUP' as const } : t));
}

export interface RecomputeInput<T extends StoredTask> {
  tasks: T[];
  dependencies: readonly ScheduleDependency[];
  calendar: WorkCalendar;
  autoSchedule: boolean;
  changed?: string[];
}

/** Engine errors as the API's: cycle → DEPENDENCY_CYCLE (details.path), parent loop → TASK_PARENT_INVALID. */
export function engineError(err: unknown): unknown {
  if (err instanceof CycleError) return ApiError.of('DEPENDENCY_CYCLE', 409, { path: err.path });
  if (err instanceof HierarchyError) return invalidParent({ taskIds: err.taskIds });
  return err;
}

/** Promotes parents, re-runs the engine and refreshes the WBS cache. */
export function recompute<T extends StoredTask>(input: RecomputeInput<T>): T[] {
  const promoted = promoteParents(input.tasks);
  let scheduled: T[];
  try {
    scheduled = schedule({
      tasks: promoted,
      dependencies: input.dependencies,
      calendar: input.calendar,
      autoSchedule: input.autoSchedule,
      ...(input.changed ? { changed: input.changed } : {}),
    }).tasks;
  } catch (err) {
    throw engineError(err);
  }
  const wbs = computeWbs(scheduled);
  return scheduled.map((t) => {
    const code = wbs.get(t.id) ?? '';
    return t.wbsCache === code ? t : { ...t, wbsCache: code };
  });
}

export interface TaskDiff<T extends StoredTask> {
  versioned: Array<{ before: T; after: T; fields: VersionedField[] }>;
  wbsOnly: T[];
}

export function diffTasks<T extends StoredTask>(before: ReadonlyMap<string, T>, after: readonly T[]): TaskDiff<T> {
  const versioned: TaskDiff<T>['versioned'] = [];
  const wbsOnly: T[] = [];
  for (const a of after) {
    const b = before.get(a.id);
    if (!b) continue;
    const fields = VERSIONED_FIELDS.filter((f) => b[f] !== a[f]);
    if (fields.length) versioned.push({ before: b, after: a, fields });
    else if (b.wbsCache !== a.wbsCache) wbsOnly.push(a);
  }
  return { versioned, wbsOnly };
}

/** Project progress = roll-up of the roots (duration-weighted, milestones weigh 0). */
export function projectProgress(roots: ReadonlyArray<Pick<StoredTask, 'type' | 'durationDays' | 'progress'>>): number {
  if (!roots.length) return 0;
  let weighted = 0;
  let weights = 0;
  let plain = 0;
  for (const r of roots) {
    const w = r.type === 'MILESTONE' ? 0 : Math.max(0, r.durationDays);
    weighted += w * r.progress;
    weights += w;
    plain += r.progress;
  }
  return Math.round((weights > 0 ? weighted / weights : plain / roots.length) * 100) / 100;
}

export { RIYADH_OFFSET_MS, riyadhToday } from './today';

export const DUE_SOON_WORKING_DAYS = 2;

/** Overdue: ended before today, not DONE. Due soon: not overdue/DONE, ends by the 2nd working day. */
export function dueFlags(
  t: Pick<StoredTask, 'endDate' | 'status'>,
  today: string,
  cal: WorkCalendar,
): { overdue: boolean; dueSoon: boolean } {
  if (t.status === 'DONE') return { overdue: false, dueSoon: false };
  if (t.endDate < today) return { overdue: true, dueSoon: false };
  return { overdue: false, dueSoon: t.endDate <= cal.addWorkingDays(today, DUE_SOON_WORKING_DAYS) };
}

/** `1.10` after `1.9`. */
export function compareWbs(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
