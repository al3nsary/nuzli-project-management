import { WorkCalendar, type Calendar } from './calendar';
import { buildModel, cloneModel, emit, rollUpModel } from './model';
import type { DurationUnit, ScheduleResult, ScheduleTask } from './types';
import { unitsFor } from './units';

/**
 * Recomputes every summary task (any task that has children) from its children:
 * - start = earliest child start, end = latest child end;
 * - durationDays = working days in `[start, end]`;
 * - progress = duration-weighted average of the children (milestones weigh 0;
 *   when every weight is 0, the plain average), rounded to 2 decimals.
 *
 * With `durationUnit = 'HOUR'` the dates are local date-times, the group's
 * `durationHours` = working hours in `[start, end)`, and progress is weighted
 * by working minutes.
 *
 * Works bottom-up and iteratively, so trees of any depth are fine. Leaf tasks
 * are never modified (in HOUR mode a leaf's derived `durationDays` and
 * normalised `durationHours` may be written back).
 */
export function rollUp<T extends ScheduleTask>(
  tasks: readonly T[],
  calendar?: Calendar | WorkCalendar,
  durationUnit: DurationUnit = 'DAY',
): ScheduleResult<T> {
  const cal = WorkCalendar.from(calendar);
  const u = unitsFor(cal, durationUnit);
  const before = buildModel(tasks, undefined, u);
  const after = cloneModel(before);
  rollUpModel(after, u);
  return emit(tasks, before, after, u);
}
