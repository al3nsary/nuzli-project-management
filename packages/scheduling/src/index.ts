/**
 * @nuzli/scheduling — the pure TypeScript Gantt engine.
 *
 * Working-day math, roll-ups, FS propagation with lag/lead, cycle detection
 * and WBS numbering. No runtime dependencies, no DOM, no database: it runs in
 * the browser while dragging and on the server before persisting.
 *
 * Dates are `YYYY-MM-DD` strings handled internally as UTC day numbers. HOUR
 * projects (`durationUnit: 'HOUR'`) use local date-times `YYYY-MM-DDTHH:MM`
 * handled as minute numbers and schedule in working minutes.
 * The engine is direction-agnostic: it never deals with pixels or RTL.
 *
 * @packageDocumentation
 */
export {
  addCalendarDays,
  dayOfWeek,
  MINUTES_PER_DAY,
  fromDayNumber,
  fromMinuteNumber,
  toDayNumber,
  toMinuteNumber,
  weekdayOf,
  type IsoDate,
  type LocalDateTime,
} from './dates';
export {
  DEFAULT_WEEKEND_DAYS,
  DEFAULT_WORKING_HOURS,
  WorkCalendar,
  type Calendar,
  type CalendarException,
  type WorkingHours,
} from './calendar';
export { CycleError, HierarchyError, TaskEditError } from './errors';
export { computeWbs } from './wbs';
export { rollUp } from './rollup';
export { detectCycle, wouldCreateCycle } from './cycles';
export { moveTask, resizeTask, schedule } from './schedule';
export { dependenciesToDays, dependenciesToHours, tasksToDays, tasksToHours } from './convert';
export type {
  DependencyType,
  DurationUnit,
  ScheduleDependency,
  ScheduleInput,
  ScheduleResult,
  ScheduleTask,
  TaskEditResult,
  TaskType,
} from './types';
