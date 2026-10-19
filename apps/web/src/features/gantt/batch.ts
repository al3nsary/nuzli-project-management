/**
 * Drag edits (brief §6.4, ADR-017): the browser runs `@nuzli/scheduling` for instant feedback,
 * then sends ONE batch with every task the engine changed and the version it was read at.
 * The server re-runs the engine; its answer replaces the optimistic state, and any error
 * restores the snapshot (409 → the refresh prompt).
 */
import {
  CycleError,
  TaskEditError,
  WorkCalendar,
  addCalendarDays,
  detectCycle,
  fromMinuteNumber,
  toMinuteNumber,
  moveTask,
  resizeTask,
  schedule,
  wouldCreateCycle,
} from '@nuzli/scheduling';
import type { CalendarDto, DependencyDto, GanttDto, TaskBatchResult, TaskDto } from '@nuzli/shared';
import type { DurationUnit, TaskBatchInputH } from '../../api/hoursWire';
import { ApiError } from '../../api/errors';

export interface EngineState {
  tasks: TaskDto[];
  dependencies: DependencyDto[];
  calendar: WorkCalendar;
  autoSchedule: boolean;
  /** HOUR projects schedule in working minutes (ADR-105). */
  durationUnit?: DurationUnit;
}

export function engineState(
  g: Pick<GanttDto, 'tasks' | 'dependencies' | 'calendar'> & { project: GanttDto['project'] & { durationUnit?: DurationUnit } },
  cal?: WorkCalendar,
): EngineState {
  return {
    tasks: g.tasks,
    dependencies: g.dependencies,
    calendar: cal ?? calendarOf(g.calendar),
    autoSchedule: g.project.autoSchedule,
    durationUnit: g.project.durationUnit === 'HOUR' ? 'HOUR' : 'DAY',
  };
}

export const calendarOf = (
  c: Pick<CalendarDto, 'weekendDays' | 'exceptions'> & { workingHours?: ReadonlyArray<{ start: string; end: string }> },
): WorkCalendar =>
  new WorkCalendar({
    weekendDays: c.weekendDays,
    exceptions: c.exceptions.map((e) => ({
      date: e.date,
      isWorking: e.isWorking,
      ...((e as { workingHours?: { start: string; end: string }[] | null }).workingHours?.length ? { workingHours: (e as { workingHours: { start: string; end: string }[] }).workingHours } : {}),
    })),
    ...(c.workingHours?.length ? { workingHours: c.workingHours } : {}),
  });

/** Moving an HOUR bar by `deltaMinutes` wall-clock minutes (callers snap to 15 minutes). */
export function previewMoveMinutes(state: EngineState, task: TaskDto, deltaMinutes: number): Preview {
  if (!deltaMinutes) return asPreview([]);
  const r = moveTask(state, task.id, fromMinuteNumber(toMinuteNumber(task.startDate) + deltaMinutes));
  return asPreview(r.changes);
}

/** Dragging an HOUR bar's later edge by `deltaMinutes` (snapped back to working time; ≥ 15 minutes). */
export function previewResizeMinutes(state: EngineState, task: TaskDto, deltaMinutes: number): Preview {
  if (!deltaMinutes) return asPreview([]);
  try {
    return asPreview(resizeTask(state, task.id, fromMinuteNumber(toMinuteNumber(task.endDate) + deltaMinutes)).changes);
  } catch (err) {
    if (err instanceof TaskEditError) return asPreview([]);
    throw err;
  }
}

export interface Preview {
  /** Every task the engine changed (the batch), in project order. */
  changes: TaskDto[];
  /** Quick lookup for rendering. */
  byId: Map<string, TaskDto>;
}

const asPreview = (changes: TaskDto[]): Preview => ({ changes, byId: new Map(changes.map((t) => [t.id, t])) });

/** Moving a bar by `deltaDays` calendar days (snapped forward to a working day by the engine). */
export function previewMove(state: EngineState, task: TaskDto, deltaDays: number): Preview {
  if (!deltaDays) return asPreview([]);
  const r = moveTask(state, task.id, addCalendarDays(task.startDate, deltaDays));
  return asPreview(r.changes);
}

/** Moving a task by whole working days (keyboard Alt+←/→). */
export function previewShiftWorkingDays(state: EngineState, task: TaskDto, workingDays: number): Preview {
  if (!workingDays) return asPreview([]);
  const r = moveTask(state, task.id, state.calendar.addWorkingDays(task.startDate, workingDays));
  return asPreview(r.changes);
}

/** Dragging the later edge by `deltaDays` (snapped back to a working day; ≥ 1 day). */
export function previewResize(state: EngineState, task: TaskDto, deltaDays: number): Preview {
  if (!deltaDays) return asPreview([]);
  try {
    return asPreview(resizeTask(state, task.id, addCalendarDays(task.endDate, deltaDays)).changes);
  } catch (err) {
    if (err instanceof TaskEditError) return asPreview([]);
    throw err;
  }
}

/** `POST /projects/:id/tasks/batch` body: exactly the changed tasks, each with its read version. */
export function batchPayload(changes: readonly TaskDto[], original: ReadonlyMap<string, TaskDto>): TaskBatchInputH {
  return {
    changes: changes.map((t) => {
      const before = original.get(t.id);
      if (!before) throw new Error(`Unknown task ${t.id}`);
      const hours = (t as TaskDto & { durationHours?: number }).durationHours;
      return {
        id: t.id,
        version: before.version,
        startDate: t.startDate,
        endDate: t.endDate,
        durationDays: t.durationDays,
        ...(hours != null ? { durationHours: hours } : {}),
      };
    }),
  };
}

/** Replaces tasks by id (keeps order); used for optimistic state and for the server answer. */
export function mergeTasks(g: GanttDto, updated: readonly TaskDto[]): GanttDto {
  if (!updated.length) return g;
  const by = new Map(updated.map((t) => [t.id, t]));
  return { ...g, tasks: g.tasks.map((t) => by.get(t.id) ?? t) };
}

export type BatchOutcome = { ok: true; result?: TaskBatchResult } | { ok: false; conflict: boolean; error: unknown };

/**
 * Optimistic batch: apply the preview, send, then apply the server's tasks — or restore the
 * snapshot. `get`/`set` are the query cache; `send` is `api.tasks.batch`.
 */
export async function runOptimisticBatch(opts: {
  get: () => GanttDto | undefined;
  set: (g: GanttDto) => void;
  send: (body: TaskBatchInputH) => Promise<TaskBatchResult>;
  changes: readonly TaskDto[];
}): Promise<BatchOutcome> {
  const snapshot = opts.get();
  if (!snapshot || !opts.changes.length) return { ok: true };
  const original = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const body = batchPayload(opts.changes, original);
  opts.set(mergeTasks(snapshot, opts.changes));
  try {
    const res = await opts.send(body);
    const cur = opts.get() ?? snapshot;
    opts.set(mergeTasks(cur, res.tasks));
    return { ok: true, result: res };
  } catch (error) {
    opts.set(snapshot);
    return { ok: false, conflict: error instanceof ApiError && error.code === 'CONFLICT_VERSION', error };
  }
}

export type LinkCheck =
  | { ok: true }
  | { ok: false; reason: 'self' | 'exists' | 'cycle'; path?: string[] };

/**
 * Validates a new FS link before calling the API: self, duplicate, a dependency cycle (with its
 * path) — and a link between a task and its own ancestor, which the engine also treats as a cycle.
 */
export function checkNewLink(state: EngineState, predecessorId: string, successorId: string): LinkCheck {
  if (predecessorId === successorId) return { ok: false, reason: 'self', path: [predecessorId, predecessorId] };
  if (state.dependencies.some((d) => d.predecessorId === predecessorId && d.successorId === successorId)) {
    return { ok: false, reason: 'exists' };
  }
  const edge = { predecessorId, successorId, type: 'FS' as const, lagDays: 0 };
  if (wouldCreateCycle(state.dependencies, predecessorId, successorId)) {
    return { ok: false, reason: 'cycle', path: detectCycle(state.dependencies, edge) ?? [predecessorId, successorId, predecessorId] };
  }
  try {
    schedule({
      tasks: state.tasks,
      dependencies: [...state.dependencies, edge],
      calendar: state.calendar,
      autoSchedule: true,
      changed: [predecessorId],
      ...(state.durationUnit === 'HOUR' ? { durationUnit: 'HOUR' as const } : {}),
    });
  } catch (err) {
    if (err instanceof CycleError) return { ok: false, reason: 'cycle', path: err.path };
    throw err;
  }
  return { ok: true };
}
