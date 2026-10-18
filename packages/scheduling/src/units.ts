/**
 * Unit strategies: the few time operations the scheduler needs, expressed once
 * in working days (DAY projects, day numbers) and once in working minutes
 * (HOUR projects, minute numbers). The DAY strategy calls exactly the
 * functions the engine always called, so DAY projects behave bit-for-bit as before.
 *
 * @internal
 */
import type { WorkCalendar } from './calendar';
import { fromDayNumber, fromMinuteNumber, toDayNumber, toMinuteNumber } from './dates';
import type { DurationUnit, ScheduleDependency, ScheduleTask } from './types';

export interface Units {
  readonly hour: boolean;
  readonly cal: WorkCalendar;
  /** Date string → time number (day number or minute number). */
  parse(s: string): number;
  /** Time number → date string. */
  format(n: number): string;
  /** Duration of a task in units (days or minutes), never negative. */
  readDuration(t: ScheduleTask): number;
  /** Lag of a dependency in units. */
  readLag(d: ScheduleDependency): number;
  /** Earliest start of an FS successor of a predecessor ending at `predEnd`. */
  fsEarliest(predEnd: number, lag: number): number;
  /** Snaps a start forward into working time. */
  snapStart(x: number): number;
  /** Moves a start by a signed number of working units, landing on a working start. */
  shiftStart(s: number, delta: number): number;
  /** Signed working units from start `from` to start `to`. */
  delta(from: number, to: number): number;
  /** End of a task starting at `s` lasting `dur` units. */
  endFrom(s: number, dur: number): number;
  /** Duration in units of a rolled-up range `[s, e]`. */
  span(s: number, e: number): number;
}

export function dayUnits(cal: WorkCalendar): Units {
  return {
    hour: false,
    cal,
    parse: toDayNumber,
    format: fromDayNumber,
    readDuration: (t) => Math.max(0, Math.trunc(t.durationDays)),
    readLag: (d) => Math.trunc(d.lagDays) || 0,
    fsEarliest: (e, lag) => cal.addWorkingDaysNum(e, 1 + lag),
    snapStart: (x) => cal.addWorkingDaysNum(x, 0),
    shiftStart: (s, delta) => cal.addWorkingDaysNum(s, delta),
    delta: (from, to) =>
      to >= from
        ? cal.workingDaysBetweenNum(from + 1, to)
        : -cal.workingDaysBetweenNum(to, from - 1),
    endFrom: (s, dur) => cal.endFromDurationNum(s, dur),
    span: (s, e) => cal.workingDaysBetweenNum(s, e),
  };
}

/** Hours → whole minutes. */
export const hoursToMinutes = (h: number): number => Math.round(h * 60);
/** Minutes → hours, rounded to 4 decimals (exact for any 15-minute multiple). */
export const minutesToHours = (m: number): number => Math.round((m / 60) * 10000) / 10000 || 0;

export function hourUnits(cal: WorkCalendar): Units {
  const snap = (x: number): number => cal.addWorkingMinutesNum(x, 0);
  return {
    hour: true,
    cal,
    parse: toMinuteNumber,
    format: fromMinuteNumber,
    readDuration: (t) => {
      const h = t.durationHours;
      if (h != null && Number.isFinite(h)) return Math.max(0, hoursToMinutes(h));
      return cal.workingMinutesBetweenNum(toMinuteNumber(t.startDate), toMinuteNumber(t.endDate));
    },
    readLag: (d) =>
      d.lagHours != null && Number.isFinite(d.lagHours)
        ? hoursToMinutes(d.lagHours)
        : (Math.trunc(d.lagDays) || 0) * cal.standardMinutesPerDay,
    fsEarliest: (e, lag) => snap(cal.addWorkingMinutesNum(e, lag)),
    snapStart: snap,
    shiftStart: (s, delta) => snap(cal.addWorkingMinutesNum(s, delta)),
    delta: (from, to) =>
      to >= from ? cal.workingMinutesBetweenNum(from, to) : -cal.workingMinutesBetweenNum(to, from),
    endFrom: (s, dur) => cal.endFromDurationMinutesNum(s, dur),
    span: (s, e) => cal.workingMinutesBetweenNum(s, e),
  };
}

export function unitsFor(cal: WorkCalendar, unit: DurationUnit | undefined): Units {
  return unit === 'HOUR' ? hourUnits(cal) : dayUnits(cal);
}
