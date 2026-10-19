/**
 * Canonical date-edit rules (calculations audit 2026-10, M2/M3/L6). The API runs them on every
 * write; the web demo imports the same functions so both behave identically.
 *
 * DAY projects (`YYYY-MM-DD`):
 * - start is snapped to a working day when edited (`snapStart`); a full reschedule keeps it;
 * - `durationDays` wins over `endDate`; a bare `endDate` becomes the working days between
 *   start and end (both included); fractions are truncated; a non-milestone lasts ≥ 1 day.
 *
 * HOUR projects (`YYYY-MM-DDTHH:MM`, Asia/Riyadh wall time):
 * - start: a bare date = the first working minute of that day; a date-time is ALWAYS snapped
 *   forward to working time (also in a full reschedule, `snapStart` is ignored);
 * - priority `durationHours` > `durationDays` > `endDate`;
 * - `durationDays` = whole days × the calendar's standard day (fractions truncated: 1.5 → 1 day);
 * - a bare `endDate` = the END of that day's working time (`coerceEndLocal`), so
 *   `{endDate:'2026-10-20'}` on a task starting Sun 09:00 ends Tue 18:00 (24 working hours);
 * - a date-time `endDate` = working minutes from the start to it;
 * - a non-milestone lasts ≥ 15 working minutes; a milestone has 0 h and ends at its start;
 * - the end is always recomputed from start + duration.
 *
 * Due day (overdue, due soon, reminders, dashboard lists): the day of the LAST WORKING MINUTE
 * (`dueDayOf`) — an HOUR task ending at 24:00 (`…T00:00` of the next day) is due the day before.
 */
import type { WorkCalendar } from './calendar';
import { MINUTES_PER_DAY, fromMinuteNumber, toMinuteNumber } from './dates';
import type { DurationUnit, ScheduleTask } from './types';
import { hoursToMinutes, minutesToHours } from './units';

export { hoursToMinutes, minutesToHours };

/** Minimum duration of a non-milestone HOUR task (the engine's resize floor). */
export const MIN_TASK_MINUTES = 15;

/** True for a local date-time `YYYY-MM-DDTHH:MM` (HOUR projects), false for `YYYY-MM-DD`. */
export const isLocalDateTime = (s: string): boolean => s.length > 10;

/** Canonical `YYYY-MM-DDTHH:MM` (seconds and `+03:00` dropped). */
export const normalizeLocal = (local: string): string => fromMinuteNumber(toMinuteNumber(local));

/** The day of the last working minute of an HOUR task (its start day for a zero-length task). */
export function endDayOfLocal(start: string, end: string): string {
  const s = toMinuteNumber(start);
  const e = toMinuteNumber(end);
  return fromMinuteNumber(e > s ? e - 1 : s).slice(0, 10);
}

/**
 * The calendar day a task is due: DAY tasks their `endDate`; HOUR tasks the day of their last
 * working minute (`endDayOfLocal`), so an end at 24:00 counts on the day it belongs to.
 */
export function dueDayOf(t: { startDate: string; endDate: string }): string {
  return isLocalDateTime(t.endDate) ? endDayOfLocal(t.startDate, t.endDate) : t.endDate.slice(0, 10);
}

/** Working days touched by `[start, end)` (0 when empty). */
export function touchedWorkingDays(cal: WorkCalendar, start: string, end: string): number {
  const s = cal.nextWorkingMinuteNum(toMinuteNumber(start));
  const e = toMinuteNumber(end);
  if (e <= s) return 0;
  return cal.workingDaysBetweenNum(Math.floor(s / MINUTES_PER_DAY), Math.floor(cal.addWorkingMinutesNum(e, -1) / MINUTES_PER_DAY));
}

/**
 * A start value for a project of unit `unit`: an HOUR project turns a bare date into the first
 * working minute of that day and normalises a date-time; a DAY project keeps the date part.
 */
export function coerceStart(value: string, unit: DurationUnit, cal: WorkCalendar): string {
  if (unit === 'DAY') return value.slice(0, 10);
  return isLocalDateTime(value) ? normalizeLocal(value) : cal.nextWorkingMinute(`${value}T00:00`);
}

/** An end value for an HOUR project: a bare date means the end of that day's last working minute. */
export function coerceEndLocal(value: string, cal: WorkCalendar): string {
  if (isLocalDateTime(value)) return normalizeLocal(value);
  return fromMinuteNumber(cal.prevWorkingEndNum(toMinuteNumber(value) + MINUTES_PER_DAY));
}

/**
 * HOUR-project version of {@link normalizeLeaf}: the start is snapped forward to a working minute
 * (a bare date becomes the first working minute of that day), a milestone has 0 hours and ends
 * on its start, any other task lasts at least 15 working minutes (`durationHours`, or
 * `durationDays` × the standard day when hours are missing) and ends after them.
 */
export function normalizeLeafHours<T extends ScheduleTask>(t: T, cal: WorkCalendar): T {
  const start = cal.nextWorkingMinute(coerceStart(t.startDate, 'HOUR', cal));
  if (t.type === 'MILESTONE') return { ...t, startDate: start, endDate: start, durationDays: 0, durationHours: 0 };
  const raw =
    t.durationHours != null && Number.isFinite(t.durationHours)
      ? hoursToMinutes(t.durationHours)
      : Math.max(1, Math.trunc(t.durationDays)) * cal.standardMinutesPerDay;
  const minutes = Math.max(MIN_TASK_MINUTES, raw);
  const end = cal.endFromDurationMinutes(start, minutes);
  return { ...t, startDate: start, endDate: end, durationHours: minutesToHours(minutes), durationDays: touchedWorkingDays(cal, start, end) };
}

/**
 * Normalises one leaf: a milestone has duration 0 and ends on its start; any other task lasts
 * at least one working day and its end is `endFromDuration(start, duration)`. DAY projects:
 * `snapStart` moves a start on a weekend or holiday to the next working day. HOUR projects
 * always snap the start into working time (see the module doc).
 */
export function normalizeLeaf<T extends ScheduleTask>(t: T, cal: WorkCalendar, snapStart = true, unit?: DurationUnit): T {
  if ((unit ?? (isLocalDateTime(t.startDate) ? 'HOUR' : 'DAY')) === 'HOUR') return normalizeLeafHours(t, cal);
  const start = snapStart ? cal.addWorkingDays(t.startDate, 0) : t.startDate;
  if (t.type === 'MILESTONE') return { ...t, startDate: start, endDate: start, durationDays: 0 };
  const duration = Math.max(1, Math.trunc(t.durationDays));
  return { ...t, startDate: start, durationDays: duration, endDate: cal.endFromDuration(start, duration) };
}

/** What a client may ask to change on a task's schedule. */
export interface ScheduleEdit {
  startDate?: string | undefined;
  endDate?: string | undefined;
  durationDays?: number | undefined;
  /** HOUR projects. */
  durationHours?: number | undefined;
}

/** HOUR-project date edit (rules in the module doc). */
export function applyScheduleEditHours<T extends ScheduleTask>(t: T, edit: ScheduleEdit, cal: WorkCalendar): T {
  const startDate = cal.nextWorkingMinute(coerceStart(edit.startDate ?? t.startDate, 'HOUR', cal));
  let durationHours = t.durationHours;
  if (edit.durationHours !== undefined) durationHours = edit.durationHours;
  else if (edit.durationDays !== undefined) durationHours = minutesToHours(Math.max(0, Math.trunc(edit.durationDays)) * cal.standardMinutesPerDay);
  else if (edit.endDate !== undefined) durationHours = minutesToHours(cal.workingMinutesBetween(startDate, coerceEndLocal(edit.endDate, cal)));
  return normalizeLeafHours({ ...t, startDate, durationHours }, cal);
}

/**
 * Applies a date edit (rules in the module doc). DAY: `durationDays` wins over `endDate`; an
 * `endDate` alone becomes a duration in working days (both ends included). The end is then
 * always recomputed.
 */
export function applyScheduleEdit<T extends ScheduleTask>(t: T, edit: ScheduleEdit, cal: WorkCalendar, unit?: DurationUnit): T {
  if ((unit ?? (isLocalDateTime(t.startDate) ? 'HOUR' : 'DAY')) === 'HOUR') return applyScheduleEditHours(t, edit, cal);
  const startDate = cal.addWorkingDays((edit.startDate ?? t.startDate).slice(0, 10), 0);
  let durationDays = t.durationDays;
  if (edit.durationDays !== undefined) durationDays = edit.durationDays;
  else if (edit.endDate !== undefined) durationDays = cal.workingDaysBetween(startDate, edit.endDate.slice(0, 10));
  return normalizeLeaf({ ...t, startDate, durationDays }, cal, false);
}

/** Working days ahead that still count as "due soon" (brief §9, docs/API.md). */
export const DUE_SOON_WORKING_DAYS = 2;

/**
 * Overdue: due (see {@link dueDayOf}) before `today` and not DONE. Due soon: not overdue, not
 * DONE, and due on or before the second working day after today (today itself included).
 * A DONE task is never overdue nor due soon. "Days overdue" elsewhere are CALENDAR days from
 * the due day to today.
 */
export function dueFlags(
  t: { startDate: string; endDate: string; status: string },
  today: string,
  cal: WorkCalendar,
): { overdue: boolean; dueSoon: boolean } {
  if (t.status === 'DONE') return { overdue: false, dueSoon: false };
  const end = dueDayOf(t);
  if (end < today) return { overdue: true, dueSoon: false };
  return { overdue: false, dueSoon: end <= cal.addWorkingDays(today, DUE_SOON_WORKING_DAYS) };
}

/** The deadline is before `today` and the task is not DONE (a DONE task never has a passed deadline). */
export function deadlinePassed(t: { deadline: string | null; status: string }, today: string): boolean {
  return !!t.deadline && t.status !== 'DONE' && t.deadline < today;
}

/**
 * Converts an ELAPSED (calendar) span that starts at `from` into signed working minutes on
 * `cal` (calculations audit L8: MS Project `edays`/elapsed lag formats). Positive spans count the
 * working minutes in `[from, from + elapsed)`, negative ones those in `[from + elapsed, from)`.
 */
export function elapsedToWorkingMinutes(cal: WorkCalendar, from: string, elapsedMinutes: number): number {
  const a = toMinuteNumber(from);
  const e = Math.round(elapsedMinutes);
  if (e >= 0) return cal.workingMinutesBetweenNum(a, a + e);
  return -cal.workingMinutesBetweenNum(a + e, a);
}
