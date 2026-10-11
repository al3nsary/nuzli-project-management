/**
 * @nuzli/scheduling — the pure TypeScript Gantt engine.
 *
 * Working-day math, roll-ups, FS propagation with lag/lead, cycle detection
 * and WBS numbering. No runtime dependencies, no DOM, no database: it runs in
 * the browser while dragging and on the server before persisting.
 *
 * Dates are `YYYY-MM-DD` strings handled internally as UTC day numbers.
 * The engine is direction-agnostic: it never deals with pixels or RTL.
 *
 * @packageDocumentation
 */
export {
  addCalendarDays,
  dayOfWeek,
  fromDayNumber,
  toDayNumber,
  weekdayOf,
  type IsoDate,
} from './dates';
export {
  DEFAULT_WEEKEND_DAYS,
  WorkCalendar,
  type Calendar,
  type CalendarException,
} from './calendar';
export { CycleError, HierarchyError, TaskEditError } from './errors';
export { computeWbs } from './wbs';
export { rollUp } from './rollup';
export { detectCycle, wouldCreateCycle } from './cycles';
export { moveTask, resizeTask, schedule } from './schedule';
export type {
  DependencyType,
  ScheduleDependency,
  ScheduleInput,
  ScheduleResult,
  ScheduleTask,
  TaskEditResult,
  TaskType,
} from './types';
