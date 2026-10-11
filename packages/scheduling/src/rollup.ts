import { WorkCalendar, type Calendar } from './calendar';
import { buildModel, cloneModel, emit, rollUpModel } from './model';
import type { ScheduleResult, ScheduleTask } from './types';

/**
 * Recomputes every summary task (any task that has children) from its children:
 * - start = earliest child start, end = latest child end;
 * - durationDays = working days in `[start, end]`;
 * - progress = duration-weighted average of the children (milestones weigh 0;
 *   when every weight is 0, the plain average), rounded to 2 decimals.
 *
 * Works bottom-up and iteratively, so trees of any depth are fine. Leaf tasks
 * are never modified.
 */
export function rollUp<T extends ScheduleTask>(
  tasks: readonly T[],
  calendar?: Calendar | WorkCalendar,
): ScheduleResult<T> {
  const cal = WorkCalendar.from(calendar);
  const before = buildModel(tasks);
  const after = cloneModel(before);
  rollUpModel(after, cal);
  return emit(tasks, before, after);
}
