/**
 * Server-side glue around `@nuzli/scheduling` (brief §6.4): the API never trusts dates sent by
 * the client. Every write runs through here: edited leaves get `endDate` recomputed from
 * `startDate + durationDays` with the project calendar, groups are rolled up, successors are
 * shifted by the forward pass (when auto-schedule is on) and WBS numbers are refreshed.
 * Pure functions only — no Prisma — so the rules are unit-tested directly.
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
import { AppError } from '../common/app-error';

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
  /** A9 budget (2 decimals). Groups hold the sum of their children (rollUpCosts). */
  plannedCost: number;
  actualCost: number;
  /** A9: `YYYY-MM-DD` or null. */
  deadline: string | null;
  barColor: string | null;
  /** A9: label ids, sorted (persisted in task_labels, versioned like a column). */
  labelIds: string[];
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
  'plannedCost',
  'actualCost',
  'deadline',
  'barColor',
  'labelIds',
] as const satisfies ReadonlyArray<keyof StoredTask>;
export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
export const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

export interface CalendarLike {
  weekendDays: number[];
  exceptions: Array<{ date: Date | string; isWorking: boolean }>;
}

export function workCalendarOf(c: CalendarLike): WorkCalendar {
  return new WorkCalendar({
    weekendDays: c.weekendDays,
    exceptions: c.exceptions.map((e) => ({
      date: typeof e.date === 'string' ? e.date.slice(0, 10) : isoOf(e.date),
      isWorking: e.isWorking,
    })),
  });
}

/**
 * Normalises one edited leaf: a milestone has duration 0 and ends on its start; any other
 * task lasts at least one working day and its end is `endFromDuration(start, duration)`.
 * `snapStart` moves a start that falls on a weekend or holiday to the next working day
 * (applied to the tasks the user edited, like `moveTask` does in the browser).
 */
export function normalizeLeaf<T extends StoredTask>(t: T, cal: WorkCalendar, snapStart = true): T {
  const start = snapStart ? cal.addWorkingDays(t.startDate, 0) : t.startDate;
  if (t.type === 'MILESTONE') return { ...t, startDate: start, endDate: start, durationDays: 0 };
  const duration = Math.max(1, Math.trunc(t.durationDays));
  return { ...t, startDate: start, durationDays: duration, endDate: cal.endFromDuration(start, duration) };
}

/** What a client may ask to change on a task's schedule. */
export interface ScheduleEdit {
  startDate?: string;
  endDate?: string;
  durationDays?: number;
}

/**
 * Applies a date edit. `durationDays` wins over `endDate`; an `endDate` alone becomes a
 * duration in working days (both ends included). The end is then always recomputed.
 */
export function applyScheduleEdit<T extends StoredTask>(t: T, edit: ScheduleEdit, cal: WorkCalendar): T {
  let next: T = { ...t };
  if (edit.startDate !== undefined) next.startDate = edit.startDate;
  next = { ...next, startDate: cal.addWorkingDays(next.startDate, 0) };
  if (edit.durationDays !== undefined) next.durationDays = edit.durationDays;
  else if (edit.endDate !== undefined) next.durationDays = cal.workingDaysBetween(next.startDate, edit.endDate);
  return normalizeLeaf(next, cal, false);
}

/** Ids of `rootId` and every descendant (iterative). */
export function subtreeIds(tasks: readonly Pick<StoredTask, 'id' | 'parentId'>[], rootId: string): string[] {
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

/**
 * Throws `TASK_PARENT_INVALID` unless `parentId` may hold `taskId`: same project, not a
 * milestone, and neither the task itself nor one of its descendants.
 */
export function assertValidParent(
  tasks: ReadonlyMap<string, StoredTask>,
  taskId: string | null,
  parentId: string | null,
): void {
  if (parentId === null) return;
  const parent = tasks.get(parentId);
  if (!parent || parent.type === 'MILESTONE') throw new AppError('TASK_PARENT_INVALID', { parentId });
  let cur: StoredTask | undefined = parent;
  for (let guard = 0; cur && guard <= tasks.size; guard++) {
    if (cur.id === taskId) throw new AppError('TASK_PARENT_INVALID', { parentId });
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

/** True when two neighbours are too close for another fractional insert (float precision). */
export const needsRenumber = (prev: number | null, next: number | null): boolean =>
  prev !== null && next !== null && Math.abs(next - prev) < 1e-9;

/** A TASK that holds children is a summary task: promote it to GROUP (documented in ADR-057). */
export function promoteParents<T extends StoredTask>(tasks: T[]): T[] {
  const parents = new Set(tasks.map((t) => t.parentId).filter((p): p is string => !!p));
  return tasks.map((t) => (t.type === 'TASK' && parents.has(t.id) ? { ...t, type: 'GROUP' as const } : t));
}

export interface RecomputeInput<T extends StoredTask> {
  tasks: T[];
  dependencies: readonly ScheduleDependency[];
  calendar: WorkCalendar;
  autoSchedule: boolean;
  /** Ids the user edited; only tasks downstream of them may be shifted. Omit = whole project. */
  changed?: string[];
}

/**
 * Promotes parents, re-runs the engine and refreshes the WBS cache. Engine errors become
 * Arabic API errors: a dependency cycle → `DEPENDENCY_CYCLE` with `details.path`; a parent
 * loop → `TASK_PARENT_INVALID`.
 */
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
  return rollUpCosts(
    scheduled.map((t) => {
      const code = wbs.get(t.id) ?? '';
      return t.wbsCache === code ? t : { ...t, wbsCache: code };
    }),
  );
}

/** Money in integer cents, so sums never drift (numeric(14,2) in the database). */
export const toCents = (v: number): number => Math.round(v * 100);
export const fromCents = (c: number): number => c / 100;

/**
 * A9 budget roll-up: every task that has children gets planned/actual cost = the sum of its
 * children (recursively, so = the sum of its leaves), like dates and progress. Leaves keep
 * their own values. Tasks whose values do not change keep their object identity.
 */
export function rollUpCosts<T extends StoredTask>(tasks: T[]): T[] {
  const children = new Map<string, T[]>();
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (!t.parentId || !ids.has(t.parentId)) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t);
    else children.set(t.parentId, [t]);
  }
  if (!children.size) return tasks;
  const sums = new Map<string, { planned: number; actual: number }>();
  const visit = (t: T, depth: number): { planned: number; actual: number } => {
    const cached = sums.get(t.id);
    if (cached) return cached;
    const kids = children.get(t.id);
    let out: { planned: number; actual: number };
    if (!kids || depth > tasks.length) out = { planned: toCents(t.plannedCost), actual: toCents(t.actualCost) };
    else {
      out = { planned: 0, actual: 0 };
      for (const k of kids) {
        const s = visit(k, depth + 1);
        out.planned += s.planned;
        out.actual += s.actual;
      }
    }
    sums.set(t.id, out);
    return out;
  };
  return tasks.map((t) => {
    if (!children.has(t.id)) return t;
    const s = visit(t, 0);
    const planned = fromCents(s.planned);
    const actual = fromCents(s.actual);
    return planned === t.plannedCost && actual === t.actualCost ? t : { ...t, plannedCost: planned, actualCost: actual };
  });
}

export function engineError(err: unknown): unknown {
  if (err instanceof CycleError) return new AppError('DEPENDENCY_CYCLE', { path: err.path });
  if (err instanceof HierarchyError) return new AppError('TASK_PARENT_INVALID', { taskIds: err.taskIds });
  return err;
}

export interface TaskDiff<T extends StoredTask> {
  /** Real changes: persisted with `version + 1`. */
  versioned: Array<{ before: T; after: T; fields: VersionedField[] }>;
  /** Only the WBS cache moved (an earlier sibling was inserted or moved): no version bump. */
  wbsOnly: T[];
}

/** Compares the recomputed list with what was loaded. New tasks (no `before`) are skipped. */
export function diffTasks<T extends StoredTask>(before: ReadonlyMap<string, T>, after: readonly T[]): TaskDiff<T> {
  const versioned: TaskDiff<T>['versioned'] = [];
  const wbsOnly: T[] = [];
  for (const a of after) {
    const b = before.get(a.id);
    if (!b) continue;
    const fields = VERSIONED_FIELDS.filter((f) => !sameValue(b[f], a[f]));
    if (fields.length) versioned.push({ before: b, after: a, fields });
    else if (b.wbsCache !== a.wbsCache) wbsOnly.push(a);
  }
  return { versioned, wbsOnly };
}

/** Field equality; label id lists compare as sets. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
  }
  return a === b;
}

/** `{ field: value }` for the given fields — audit before/after snapshots. */
export function pick(t: StoredTask, fields: readonly VersionedField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = f === 'description' ? (t.description ? `${t.description.length} حرفًا` : null) : t[f];
  return out;
}

/**
 * Project progress = the roll-up of the root tasks (duration-weighted, milestones weigh 0,
 * plain average when every weight is 0), rounded to 2 decimals like `rollUp`.
 */
export function projectProgress(
  roots: ReadonlyArray<Pick<StoredTask, 'type' | 'durationDays' | 'progress'>>,
): number {
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
  const value = weights > 0 ? weighted / weights : plain / roots.length;
  return Math.round(value * 100) / 100;
}

/** Asia/Riyadh is UTC+03:00 all year (no DST). */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Today's calendar date in Riyadh. */
export function riyadhToday(now: Date = new Date()): string {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** Working days ahead that still count as "due soon" (brief §9, docs/API.md). */
export const DUE_SOON_WORKING_DAYS = 2;

/**
 * Overdue: ended before today and not DONE. Due soon: not overdue, not DONE, and ends on or
 * before the second working day after today (today itself included).
 */
export function dueFlags(
  t: Pick<StoredTask, 'endDate' | 'status'>,
  today: string,
  cal: WorkCalendar,
): { overdue: boolean; dueSoon: boolean } {
  if (t.status === 'DONE') return { overdue: false, dueSoon: false };
  if (t.endDate < today) return { overdue: true, dueSoon: false };
  return { overdue: false, dueSoon: t.endDate <= cal.addWorkingDays(today, DUE_SOON_WORKING_DAYS) };
}

/** A9: the deadline is before today (Riyadh) and the task is not DONE. */
export function deadlinePassed(t: Pick<StoredTask, 'deadline' | 'status'>, today: string): boolean {
  return !!t.deadline && t.status !== 'DONE' && t.deadline < today;
}

/** `YYYY-MM-DD` + n calendar days. */
export function addCalendarDaysIso(iso: string, days: number): string {
  return isoOf(new Date(dateOf(iso).getTime() + days * 86_400_000));
}
