/**
 * The API's write rules around `@nuzli/scheduling` (apps/api/src/projects/task-engine.ts),
 * as pure functions so the demo adapter behaves exactly like the server (ADR-056/057)
 * and screens can preview the same result. No React, no storage.
 */
import {
  CycleError,
  HierarchyError,
  WorkCalendar,
  computeWbs,
  normalizeStatusProgress,
  rollUpStatus,
  schedule,
  weightedProgress,
  type DurationUnit,
  type ProgressItem,
  type ScheduleDependency,
} from '@nuzli/scheduling';
import type { Priority, TaskPrevious, TaskStatus, TaskType } from '@nuzli/shared';
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
  /** A9 budget (2 decimals). Groups hold the sum of their children (rollUpCosts). */
  plannedCost: number;
  actualCost: number;
  /** A9: `YYYY-MM-DD` or null. */
  deadline: string | null;
  barColor: string | null;
  /** A9: label ids, sorted (versioned like a column). */
  labelIds: string[];
  /** HOUR projects: working hours (minute resolution); absent in DAY projects. */
  durationHours?: number;
}

/** Defaults of the A9 columns for a new (or pre-A9) task. */
export const A9_TASK_DEFAULTS = { plannedCost: 0, actualCost: 0, deadline: null, barColor: null, labelIds: [] as string[] };

/** Fills the A9 columns of rows stored before A9 (demo IndexedDB upgrade). */
export function withA9<T extends Partial<StoredTask>>(t: T): T & Pick<StoredTask, 'plannedCost' | 'actualCost' | 'deadline' | 'barColor' | 'labelIds'> {
  return {
    ...t,
    plannedCost: t.plannedCost ?? 0,
    actualCost: t.actualCost ?? 0,
    deadline: t.deadline ?? null,
    barColor: t.barColor ?? null,
    labelIds: t.labelIds ?? [],
  };
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
  'durationHours',
] as const satisfies ReadonlyArray<keyof StoredTask>;
export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export interface CalendarLike {
  weekendDays: readonly number[];
  exceptions: ReadonlyArray<{ date: string; isWorking: boolean; workingHours?: ReadonlyArray<{ start: string; end: string }> | null }>;
  /** HOUR projects: working intervals of a normal day (default 09:00–13:00, 14:00–18:00). */
  workingHours?: ReadonlyArray<{ start: string; end: string }> | null;
}

export function workCalendarOf(c: CalendarLike): WorkCalendar {
  return new WorkCalendar({
    weekendDays: c.weekendDays,
    exceptions: c.exceptions.map((e) => ({
      date: e.date.slice(0, 10),
      isWorking: e.isWorking,
      ...(e.workingHours?.length ? { workingHours: e.workingHours } : {}),
    })),
    ...(c.workingHours?.length ? { workingHours: c.workingHours } : {}),
  });
}

/**
 * The date-edit, due-day, status and weighting rules are the API's own, imported from
 * `@nuzli/scheduling` (calculations audit 2026-10, ADR-133/134) — never copied here.
 */
export {
  applyScheduleEdit,
  applyScheduleEditHours,
  coerceEndLocal,
  coerceStart,
  deadlinePassed,
  deriveGroupStatus,
  dueDayOf,
  dueFlags,
  DUE_SOON_WORKING_DAYS,
  endDayOfLocal,
  isLocalDateTime,
  MIN_TASK_MINUTES,
  minutesToHours,
  normalizeLeaf,
  normalizeLeafHours,
  normalizeStatusProgress,
  progressWeight,
  rollUpStatus,
  roundHalfAway,
  syncStatusProgress,
  touchedWorkingDays,
  weightedProgress,
  type ScheduleEdit,
} from '@nuzli/scheduling';

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
  /** HOUR projects schedule in working minutes (dates `YYYY-MM-DDTHH:MM`). */
  durationUnit?: DurationUnit;
}

/** Engine errors as the API's: cycle → DEPENDENCY_CYCLE (details.path), parent loop → TASK_PARENT_INVALID. */
export function engineError(err: unknown): unknown {
  if (err instanceof CycleError) return ApiError.of('DEPENDENCY_CYCLE', 409, { path: err.path });
  if (err instanceof HierarchyError) return invalidParent({ taskIds: err.taskIds });
  return err;
}

/** Promotes parents, re-runs the engine and refreshes the WBS cache. */
export function recompute<T extends StoredTask>(input: RecomputeInput<T>): T[] {
  // Calculations audit H1 (as the API): leaves obey the status/progress invariant before the roll-up.
  const promoted = promoteParents(input.tasks).map((t) => {
    if (t.type === 'GROUP') return t;
    const n = normalizeStatusProgress(t.status, t.progress);
    return n.status === t.status && n.progress === t.progress ? t : { ...t, ...n };
  });
  let scheduled: T[];
  try {
    scheduled = schedule({
      tasks: promoted,
      dependencies: input.dependencies,
      calendar: input.calendar,
      autoSchedule: input.autoSchedule,
      ...(input.durationUnit === 'HOUR' ? { durationUnit: 'HOUR' as const } : {}),
      ...(input.changed ? { changed: input.changed } : {}),
    }).tasks;
  } catch (err) {
    throw engineError(err);
  }
  const wbs = computeWbs(scheduled);
  // H1/H2: group status derived bottom-up; a GROUP without children is zeroed (dates kept).
  return rollUpStatus(
    rollUpCosts(
      scheduled.map((t) => {
        const code = wbs.get(t.id) ?? '';
        return t.wbsCache === code ? t : { ...t, wbsCache: code };
      }),
    ),
  );
}

/** Money in integer cents, so sums never drift (numeric(14,2) on the server). */
export const toCents = (v: number): number => Math.round(v * 100);
export const fromCents = (c: number): number => c / 100;

/**
 * A9 budget roll-up (as apps/api task-engine): every task with children gets planned/actual cost
 * = the sum of its children; leaves keep their values; unchanged tasks keep their identity.
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
    if (!kids || depth > tasks.length) out = { planned: toCents(t.plannedCost ?? 0), actual: toCents(t.actualCost ?? 0) };
    else {
      out = { planned: 0, actual: 0 };
      for (const k of kids) {
        const sub = visit(k, depth + 1);
        out.planned += sub.planned;
        out.actual += sub.actual;
      }
    }
    sums.set(t.id, out);
    return out;
  };
  return tasks.map((t) => {
    if (!children.has(t.id)) return t;
    const sum = visit(t, 0);
    const planned = fromCents(sum.planned);
    const actual = fromCents(sum.actual);
    return planned === t.plannedCost && actual === t.actualCost ? t : { ...t, plannedCost: planned, actualCost: actual };
  });
}

/** Field equality; label id lists compare as sets; null and undefined are the same. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
  }
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return a === b;
}

/** Before-values of the changed fields in wire format (the undo contract, ADR-095). */
export function previousOf(t: StoredTask, fields: readonly VersionedField[]): TaskPrevious & { durationHours?: number | null } {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = f === 'labelIds' ? [...t.labelIds] : (t[f] ?? null);
  return out as TaskPrevious;
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
    const fields = VERSIONED_FIELDS.filter((f) => !sameValue(b[f], a[f]));
    if (fields.length) versioned.push({ before: b, after: a, fields });
    else if (b.wbsCache !== a.wbsCache) wbsOnly.push(a);
  }
  return { versioned, wbsOnly };
}

/**
 * Project progress = the shared `weightedProgress` of the roots (milestones and empty groups
 * weigh 0; HOUR projects weigh by working minutes — audit M1). The unit is inferred from
 * `durationHours` when not given (only HOUR tasks carry it).
 */
export function projectProgress(
  roots: ReadonlyArray<Pick<ProgressItem, 'type' | 'durationDays' | 'durationHours' | 'progress' | 'isEmptyGroup'>>,
  unit?: DurationUnit,
): number {
  const u = unit ?? (roots.some((r) => r.durationHours != null) ? 'HOUR' : 'DAY');
  return weightedProgress(roots, u);
}

/** Roots of a task list, each flagged `isEmptyGroup` when it is a GROUP without children in the list. */
export function rootsForProgress<T extends Pick<StoredTask, 'id' | 'parentId' | 'type'>>(tasks: readonly T[]): Array<T & { isEmptyGroup: boolean }> {
  const ids = new Set(tasks.map((t) => t.id));
  const parents = new Set(tasks.map((t) => t.parentId).filter((p): p is string => !!p));
  return tasks.filter((t) => !t.parentId || !ids.has(t.parentId)).map((t) => ({ ...t, isEmptyGroup: t.type === 'GROUP' && !parents.has(t.id) }));
}

export { RIYADH_OFFSET_MS, riyadhToday } from './today';

/** `YYYY-MM-DD` + n calendar days. */
export function addCalendarDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
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
