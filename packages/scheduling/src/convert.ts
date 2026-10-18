import { WorkCalendar, type Calendar } from './calendar';
import {
  MINUTES_PER_DAY,
  fromDayNumber,
  fromMinuteNumber,
  toDayNumber,
  toMinuteNumber,
} from './dates';
import type { ScheduleDependency, ScheduleTask } from './types';
import { hoursToMinutes, minutesToHours } from './units';

/**
 * Converts the tasks of a DAY project to an HOUR project on the same calendar,
 * keeping every task on the same working days:
 * - start = the first working minute of `startDate` (snapped forward);
 * - end = the end of the last working minute of `endDate`;
 * - `durationHours` = working hours between them (8 per default day, the
 *   exception's own hours on a special day);
 * - a milestone (or duration 0) sits at the first working minute of its date.
 */
export function tasksToHours<T extends ScheduleTask>(
  tasks: readonly T[],
  calendar?: Calendar | WorkCalendar,
): T[] {
  const cal = WorkCalendar.from(calendar);
  return tasks.map((t) => {
    const s = cal.nextWorkingMinuteNum(toDayNumber(t.startDate) * MINUTES_PER_DAY);
    if (t.type === 'MILESTONE' || t.durationDays <= 0) {
      return {
        ...t,
        startDate: fromMinuteNumber(s),
        endDate: fromMinuteNumber(s),
        durationHours: 0,
      };
    }
    const lastDay = Math.max(toDayNumber(t.endDate), Math.floor(s / MINUTES_PER_DAY));
    let e = cal.prevWorkingEndNum((lastDay + 1) * MINUTES_PER_DAY);
    if (e <= s) e = cal.endFromDurationMinutesNum(s, cal.standardMinutesPerDay);
    return {
      ...t,
      startDate: fromMinuteNumber(s),
      endDate: fromMinuteNumber(e),
      durationHours: minutesToHours(cal.workingMinutesBetweenNum(s, e)),
    };
  });
}

/**
 * Converts the tasks of an HOUR project to a DAY project on the same calendar:
 * `startDate` = the day of the first working minute, `endDate` = the day of the
 * last working minute, `durationDays` = working days in between (at least 1).
 * A partial day counts as a whole day. Milestones keep their date with
 * duration 0. `durationHours` is passed through untouched.
 */
export function tasksToDays<T extends ScheduleTask>(
  tasks: readonly T[],
  calendar?: Calendar | WorkCalendar,
): T[] {
  const cal = WorkCalendar.from(calendar);
  return tasks.map((t) => {
    const s0 = toMinuteNumber(t.startDate);
    const e0 = toMinuteNumber(t.endDate);
    const s = cal.nextWorkingMinuteNum(s0);
    const sd = Math.floor(s / MINUTES_PER_DAY);
    if (t.type === 'MILESTONE' || e0 <= s0 || cal.workingMinutesBetweenNum(s, e0) === 0) {
      const day = cal.addWorkingDaysNum(sd, 0);
      return { ...t, startDate: fromDayNumber(day), endDate: fromDayNumber(day), durationDays: 0 };
    }
    const ed = Math.floor(cal.addWorkingMinutesNum(e0, -1) / MINUTES_PER_DAY);
    const startDay = cal.addWorkingDaysNum(sd, 0);
    const d = Math.max(1, cal.workingDaysBetweenNum(startDay, ed));
    return {
      ...t,
      startDate: fromDayNumber(startDay),
      endDate: fromDayNumber(cal.endFromDurationNum(startDay, d)),
      durationDays: d,
    };
  });
}

/** DAY → HOUR dependencies: `lagHours` = `lagDays` × the calendar's standard day length. */
export function dependenciesToHours<D extends ScheduleDependency>(
  deps: readonly D[],
  calendar?: Calendar | WorkCalendar,
): D[] {
  const cal = WorkCalendar.from(calendar);
  return deps.map((d) => ({
    ...d,
    lagHours: minutesToHours((Math.trunc(d.lagDays) || 0) * cal.standardMinutesPerDay),
  }));
}

/**
 * HOUR → DAY dependencies: `lagDays` = `lagHours` ÷ the standard day length,
 * rounded to the nearest whole day (a missing `lagHours` keeps `lagDays`).
 */
export function dependenciesToDays<D extends ScheduleDependency>(
  deps: readonly D[],
  calendar?: Calendar | WorkCalendar,
): D[] {
  const cal = WorkCalendar.from(calendar);
  return deps.map((d) =>
    d.lagHours == null
      ? d
      : { ...d, lagDays: Math.round(hoursToMinutes(d.lagHours) / cal.standardMinutesPerDay) || 0 },
  );
}
