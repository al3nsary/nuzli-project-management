import { fromDayNumber, toDayNumber, weekdayOf, type IsoDate } from './dates';

/** One calendar exception: a holiday (`isWorking: false`) or a working override (`isWorking: true`). */
export interface CalendarException {
  readonly date: IsoDate;
  readonly isWorking: boolean;
}

/**
 * A working calendar as stored per project. Structurally compatible with
 * `CalendarDto` from `@nuzli/shared` (extra fields are ignored).
 */
export interface Calendar {
  /** Weekend days, 0 = Sunday … 6 = Saturday. Default `[5, 6]` (Friday and Saturday). */
  readonly weekendDays?: readonly number[];
  /** Holidays and working overrides; an exception always wins over the weekend rule. */
  readonly exceptions?: readonly CalendarException[];
}

/** The default weekend: Friday and Saturday. */
export const DEFAULT_WEEKEND_DAYS: readonly number[] = Object.freeze([5, 6]);

/** Hard limit on the span the prefix table may cover (about 400 years). */
const MAX_SPAN = 146_100;
const INITIAL_HALF_SPAN = 800;

/**
 * Fast working-day arithmetic for one {@link Calendar}.
 *
 * Exceptions are cached in a `Map`, and a lazily grown prefix table of
 * cumulative working-day counts makes {@link WorkCalendar.workingDaysBetween}
 * O(1) and {@link WorkCalendar.addWorkingDays} O(log n), whatever the distance.
 *
 * The methods come in two flavours: ISO-string methods (`addWorkingDays`) for
 * callers, and day-number methods (`addWorkingDaysNum`) used by the scheduler.
 * Day numbers are days since 1970-01-01 UTC (see `toDayNumber`).
 */
export class WorkCalendar {
  /** Weekend days, 0 = Sunday … 6 = Saturday, sorted and de-duplicated. */
  readonly weekendDays: readonly number[];
  private readonly weekendMask: number;
  private readonly exceptions = new Map<number, boolean>();
  /** Day number of `cum[0]`. */
  private lo = 0;
  /** `cum[i]` = working days in `[lo, lo + i]`, inclusive. */
  private cum: Int32Array = new Int32Array(0);

  constructor(calendar: Calendar = {}) {
    const weekend = calendar.weekendDays ?? DEFAULT_WEEKEND_DAYS;
    let mask = 0;
    for (const d of weekend) {
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new RangeError(`Invalid weekend day ${d}`);
      mask |= 1 << d;
    }
    this.weekendMask = mask;
    this.weekendDays = Object.freeze([...new Set(weekend)].sort((a, b) => a - b));
    for (const ex of calendar.exceptions ?? []) {
      this.exceptions.set(toDayNumber(ex.date), ex.isWorking);
    }
    let anyWorkingException = false;
    for (const v of this.exceptions.values()) if (v) anyWorkingException = true;
    if (mask === 0x7f && !anyWorkingException) {
      throw new RangeError('A calendar needs at least one working day');
    }
  }

  /** Returns `calendar` itself when it is already a `WorkCalendar`, otherwise builds one. */
  static from(calendar?: Calendar | WorkCalendar): WorkCalendar {
    return calendar instanceof WorkCalendar ? calendar : new WorkCalendar(calendar);
  }

  // ---------------------------------------------------------------- ISO-string API

  /** True when `date` is a working day (exceptions first, then the weekend rule). */
  isWorkingDay(date: IsoDate): boolean {
    return this.isWorkingDayNum(toDayNumber(date));
  }

  /** The first working day strictly **after** `date`. */
  nextWorkingDay(date: IsoDate): IsoDate {
    return fromDayNumber(this.addWorkingDaysNum(toDayNumber(date), 1));
  }

  /** The last working day strictly **before** `date`. */
  prevWorkingDay(date: IsoDate): IsoDate {
    return fromDayNumber(this.addWorkingDaysNum(toDayNumber(date), -1));
  }

  /**
   * Moves `n` working days from `date`.
   * - `n > 0`: the n-th working day after `date` (Thursday + 1 = Sunday with a Fri/Sat weekend).
   * - `n < 0`: the |n|-th working day before `date`.
   * - `n = 0`: `date` itself when it is a working day, otherwise the next working day (snap forward).
   */
  addWorkingDays(date: IsoDate, n: number): IsoDate {
    return fromDayNumber(this.addWorkingDaysNum(toDayNumber(date), n));
  }

  /** Working days in `[start, end]`, both ends inclusive; 0 when `end < start`. */
  workingDaysBetween(start: IsoDate, end: IsoDate): number {
    return this.workingDaysBetweenNum(toDayNumber(start), toDayNumber(end));
  }

  /**
   * End date of a task that starts on `start` and lasts `durationDays` working days.
   * Duration 1 on a working day ends the same day; duration 0 (milestone) returns `start`.
   * A non-working `start` is first snapped forward to the next working day.
   */
  endFromDuration(start: IsoDate, durationDays: number): IsoDate {
    return fromDayNumber(this.endFromDurationNum(toDayNumber(start), durationDays));
  }

  /** Duration in working days of `[start, end]` (inclusive); 0 when `end < start`. */
  durationFromRange(start: IsoDate, end: IsoDate): number {
    return this.workingDaysBetweenNum(toDayNumber(start), toDayNumber(end));
  }

  // ---------------------------------------------------------------- day-number API

  /** {@link isWorkingDay} on a day number. */
  isWorkingDayNum(day: number): boolean {
    const ex = this.exceptions.get(day);
    if (ex !== undefined) return ex;
    return (this.weekendMask & (1 << weekdayOf(day))) === 0;
  }

  /** {@link addWorkingDays} on a day number. */
  addWorkingDaysNum(day: number, n: number): number {
    if (!Number.isInteger(n))
      throw new RangeError(`Working-day offset must be an integer, got ${n}`);
    if (n === 0 && this.isWorkingDayNum(day)) return day;
    for (;;) {
      this.ensure(day - 1);
      this.ensure(day);
      const cum = this.cum;
      const at = day - this.lo;
      if (n >= 0) {
        // n = 0 reaching here means `day` is not working: take the first working day after it.
        const target = cum[at]! + Math.max(n, 1);
        if (cum[cum.length - 1]! >= target) return this.lo + this.search(target);
        this.grow(this.lo, this.lo + cum.length * 2);
      } else {
        const target = cum[at - 1]! + n + 1;
        if (target >= 1) return this.lo + this.search(target);
        this.grow(this.lo - cum.length, this.lo + cum.length - 1);
      }
    }
  }

  /** {@link workingDaysBetween} on day numbers. */
  workingDaysBetweenNum(start: number, end: number): number {
    if (end < start) return 0;
    this.ensure(start - 1);
    this.ensure(end);
    return this.cum[end - this.lo]! - this.cum[start - 1 - this.lo]!;
  }

  /** {@link endFromDuration} on a day number. */
  endFromDurationNum(start: number, durationDays: number): number {
    if (durationDays <= 0) return start;
    return this.addWorkingDaysNum(this.addWorkingDaysNum(start, 0), durationDays - 1);
  }

  // ---------------------------------------------------------------- prefix table

  /** Smallest index whose cumulative count reaches `target` (always a working day). */
  private search(target: number): number {
    const cum = this.cum;
    let a = 0;
    let b = cum.length - 1;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (cum[mid]! >= target) b = mid;
      else a = mid + 1;
    }
    return a;
  }

  /** Makes sure `day` lies inside the prefix table. */
  private ensure(day: number): void {
    const len = this.cum.length;
    if (len === 0) this.grow(day - INITIAL_HALF_SPAN, day + INITIAL_HALF_SPAN);
    else if (day < this.lo)
      this.grow(Math.min(day - INITIAL_HALF_SPAN, this.lo - len), this.lo + len - 1);
    else if (day >= this.lo + len)
      this.grow(this.lo, Math.max(day + INITIAL_HALF_SPAN, this.lo + len * 2));
  }

  /** Rebuilds the table to cover `[from, to]` (always a superset of the current range). */
  private grow(from: number, to: number): void {
    const len = to - from + 1;
    if (len > MAX_SPAN) {
      throw new RangeError('Date outside the supported scheduling range (about 400 years)');
    }
    const cum = new Int32Array(len);
    let c = 0;
    for (let i = 0; i < len; i++) {
      if (this.isWorkingDayNum(from + i)) c++;
      cum[i] = c;
    }
    this.lo = from;
    this.cum = cum;
  }
}
