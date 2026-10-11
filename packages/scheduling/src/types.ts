import type { Calendar, WorkCalendar } from './calendar';
import type { IsoDate } from './dates';

/** Task kinds. A `MILESTONE` always has duration 0 (end = start). */
export type TaskType = 'TASK' | 'GROUP' | 'MILESTONE';

/** Dependency kinds. All four are modelled; only `FS` is computed for now. */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

/**
 * The minimal task shape the engine needs. `TaskDto` from `@nuzli/shared`
 * satisfies it, and every function is generic over `T extends ScheduleTask`,
 * so extra fields (name, version, assignee, …) pass through untouched.
 */
export interface ScheduleTask {
  readonly id: string;
  /** Parent task id; `null` (or an id not in the list) makes the task a root. */
  readonly parentId: string | null;
  /** Order among siblings (ties broken by id). */
  readonly sortOrder: number;
  readonly type: TaskType;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
  /** Duration in working days, inclusive of start and end. 0 for milestones. */
  readonly durationDays: number;
  /** Percent complete, 0–100. */
  readonly progress: number;
}

/** A dependency between two tasks. `DependencyDto` from `@nuzli/shared` satisfies it. */
export interface ScheduleDependency {
  readonly id?: string;
  readonly predecessorId: string;
  readonly successorId: string;
  readonly type: DependencyType;
  /** Lag (> 0) or lead (< 0) in working days. */
  readonly lagDays: number;
}

/** Input of {@link schedule}. */
export interface ScheduleInput<T extends ScheduleTask = ScheduleTask> {
  readonly tasks: readonly T[];
  readonly dependencies: readonly ScheduleDependency[];
  readonly calendar?: Calendar | WorkCalendar;
  /** Per-project auto-scheduling toggle (default `true`). When `false` only roll-ups run. */
  readonly autoSchedule?: boolean;
  /**
   * Ids of the tasks the user just edited. When given, only tasks downstream of
   * them (through dependencies and the hierarchy) may be shifted, so unrelated
   * pre-existing violations stay untouched. When omitted the whole project is checked.
   */
  readonly changed?: readonly string[];
}

/** Output of {@link schedule} and {@link rollUp}. */
export interface ScheduleResult<T extends ScheduleTask = ScheduleTask> {
  /** The full task list in input order; unchanged tasks keep their object identity. */
  readonly tasks: T[];
  /** Ids of the tasks whose start, end, duration or progress changed, in input order. */
  readonly changedIds: string[];
}

/** Output of {@link moveTask} and {@link resizeTask}: what the UI persists in one request. */
export interface TaskEditResult<T extends ScheduleTask = ScheduleTask> extends ScheduleResult<T> {
  /** The changed tasks themselves (the batch to send), in input order. */
  readonly changes: T[];
}
