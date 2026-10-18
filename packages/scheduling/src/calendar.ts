import {
  MINUTES_PER_DAY,
  fromDayNumber,
  fromMinuteNumber,
  toDayNumber,
  toMinuteNumber,
  weekdayOf,
  type IsoDate,
  type LocalDateTime,
} from './dates';

/** One working-time interval of a day, local wall clock, `HH:MM` (end may be `24:00`). */
export interface WorkingHours {
  readonly start: string;
  readonly end: string;
}

/** One calendar exception: a holiday (`isWorking: false`) or a working override (`isWorking: true`). */
export interface CalendarException {
  readonly date: IsoDate;
  readonly isWorking: boolean;
  /**
   * HOUR projects only: the working intervals of that date when `isWorking` is
   * true (default: the calendar's `workingHours`). Ignored for a holiday.
   */
  readonly workingHours?: readonly WorkingHours[];
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
  /**
   * Working intervals of a normal working day, used by HOUR projects only.
   * Default `[{09:00–13:00}, {14:00–18:00}]` (8 hours). Overlaps are merged.
   */
  readonly workingHours?: readonly WorkingHours[];
}

/** The default weekend: Friday and Saturday. */
export const DEFAULT_WEEKEND_DAYS: readonly number[] = Object.freeze([5, 6]);

/** The default working day: 09:00–13:00 and 14:00–18:00 (8 hours). */
export const DEFAULT_WORKING_HOURS: readonly WorkingHours[] = Object.freeze([
  Object.freeze({ start: '09:00', end: '13:00' }),
  Object.freeze({ start: '14:00', end: '18:00' }),
]);

const HM_RE = /^(\d{2}):(\d{2})$/;

function parseHm(v: string, allow24: boolean): number {
  const m = HM_RE.exec(v);
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  const t = h * 60 + mi;
  if (!m || mi > 59 || t > (allow24 ? MINUTES_PER_DAY : MINUTES_PER_DAY - 1)) {
    throw new RangeError(`Invalid working time "${v}" (expected HH:MM)`);
  }
  return t;
}

/** Parses, validates, sorts and merges intervals into a flat `[s0, e0, s1, e1, …]` table (minutes of day). */
function parseIntervals(list: readonly WorkingHours[]): Int32Array {
  const raw: [number, number][] = list.map((w) => {
    const s = parseHm(w.start, false);
    const e = parseHm(w.end, true);
    if (e <= s) throw new RangeError(`Working interval ${w.start}–${w.end} ends before it starts`);
    return [s, e];
  });
  raw.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [s, e] of raw) {
    const last = out.length - 1;
    if (last > 0 && s <= out[last]!) out[last] = Math.max(out[last]!, e);
    else out.push(s, e);
  }
  return Int32Array.from(out);
}

const NO_HOURS = new Int32Array(0);

function sumIntervals(iv: Int32Array): number {
  let t = 0;
  for (let k = 0; k < iv.length; k += 2) t += iv[k + 1]! - iv[k]!;
  return t;
}

const hm = (t: number): string => {
  const h = Math.floor(t / 60);
  const m = t - h * 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
};

function intervalsToHours(iv: Int32Array): WorkingHours[] {
  const out: WorkingHours[] = [];
  for (let k = 0; k < iv.length; k += 2) out.push({ start: hm(iv[k]!), end: hm(iv[k + 1]!) });
  return out;
}

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

  /** Normal working-day intervals, normalised (sorted, merged). */
  readonly workingHours: readonly WorkingHours[];
  /** Working minutes of a normal working day (480 by default). */
  readonly standardMinutesPerDay: number;
  private readonly defaultIntervals: Int32Array;
  /** Per-date interval tables for exception days (holiday = empty). */
  private readonly hourExceptions = new Map<number, Int32Array>();
  /** Day number of `mcum[0]`. */
  private mlo = 0;
  /** `mcum[i]` = working minutes in days `[mlo, mlo + i]`, inclusive. Built lazily, HOUR mode only. */
  private mcum: Int32Array = new Int32Array(0);

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
    this.defaultIntervals = parseIntervals(calendar.workingHours ?? DEFAULT_WORKING_HOURS);
    this.standardMinutesPerDay = sumIntervals(this.defaultIntervals);
    this.workingHours = Object.freeze(intervalsToHours(this.defaultIntervals));
    for (const ex of calendar.exceptions ?? []) {
      this.hourExceptions.set(
        toDayNumber(ex.date),
        !ex.isWorking
          ? NO_HOURS
          : ex.workingHours
            ? parseIntervals(ex.workingHours)
            : this.defaultIntervals,
      );
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

  // ---------------------------------------------------------------- working time (HOUR projects)
  //
  // Instants are minute numbers (minutes since 1970-01-01T00:00 local, see
  // `toMinuteNumber`). "Working minute t" is the minute `[t, t + 1)`. Spans are
  // half-open: `[a, b)`. A task end is the instant right after its last
  // working minute (a 09:00–13:00 block ends at 13:00).

  /** Working intervals of `date` (empty on a weekend or holiday), `HH:MM`. */
  workingIntervals(date: IsoDate): WorkingHours[] {
    return intervalsToHours(this.intervalsNum(toDayNumber(date)));
  }

  /** Working minutes on `date` (0 on a weekend or holiday). */
  workingMinutesOfDay(date: IsoDate): number {
    return sumIntervals(this.intervalsNum(toDayNumber(date)));
  }

  /** Working hours on `date` (8 on a default working day, 0 on a weekend or holiday). */
  hoursPerDay(date: IsoDate): number {
    return this.workingMinutesOfDay(date) / 60;
  }

  /** True when the minute starting at `dt` is working time. */
  isWorkingMinute(dt: LocalDateTime): boolean {
    return this.isWorkingMinuteNum(toMinuteNumber(dt));
  }

  /**
   * Snaps forward: `dt` itself when it is working time, otherwise the start
   * of the next working interval (13:00 → 14:00; Thursday 18:00 → Sunday 09:00).
   */
  nextWorkingMinute(dt: LocalDateTime): LocalDateTime {
    return fromMinuteNumber(this.nextWorkingMinuteNum(toMinuteNumber(dt)));
  }

  /**
   * Moves `n` working minutes from `dt` (`n` must be an integer).
   * - `n > 0`: the earliest instant with exactly `n` working minutes in `[dt, result)`
   *   (11:00 + 120 = 13:00, not 14:00).
   * - `n < 0`: the latest instant with exactly `|n|` working minutes in `[result, dt)`
   *   (14:00 − 60 = 12:00).
   * - `n = 0`: snaps forward, like {@link nextWorkingMinute}.
   */
  addWorkingMinutes(dt: LocalDateTime, n: number): LocalDateTime {
    return fromMinuteNumber(this.addWorkingMinutesNum(toMinuteNumber(dt), n));
  }

  /** Working minutes in the half-open span `[a, b)`; 0 when `b <= a`. */
  workingMinutesBetween(a: LocalDateTime, b: LocalDateTime): number {
    return this.workingMinutesBetweenNum(toMinuteNumber(a), toMinuteNumber(b));
  }

  /**
   * End of a task that starts at `start` and lasts `minutes` working minutes:
   * `start` is snapped forward into working time, and the result is the end of
   * the last working minute. `minutes = 0` (milestone) returns `start` unchanged.
   */
  endFromDurationMinutes(start: LocalDateTime, minutes: number): LocalDateTime {
    return fromMinuteNumber(this.endFromDurationMinutesNum(toMinuteNumber(start), minutes));
  }

  /**
   * Snaps an end instant back: `dt` itself when it is inside working time or
   * exactly at the end of an interval, otherwise the end of the previous
   * working interval (13:30 → 13:00; Sunday 08:00 → Thursday 18:00).
   */
  prevWorkingEnd(dt: LocalDateTime): LocalDateTime {
    return fromMinuteNumber(this.prevWorkingEndNum(toMinuteNumber(dt)));
  }

  /** {@link isWorkingMinute} on a minute number. */
  isWorkingMinuteNum(t: number): boolean {
    const day = Math.floor(t / MINUTES_PER_DAY);
    const m = t - day * MINUTES_PER_DAY;
    const iv = this.intervalsNum(day);
    for (let k = 0; k < iv.length; k += 2) if (m >= iv[k]! && m < iv[k + 1]!) return true;
    return false;
  }

  /** {@link nextWorkingMinute} on a minute number. */
  nextWorkingMinuteNum(t: number): number {
    return this.addWorkingMinutesNum(t, 0);
  }

  /** {@link addWorkingMinutes} on a minute number. */
  addWorkingMinutesNum(t: number, n: number): number {
    if (!Number.isInteger(n))
      throw new RangeError(`Working-minute offset must be an integer, got ${n}`);
    const day = Math.floor(t / MINUTES_PER_DAY);
    for (;;) {
      const w = this.minutesBefore(t, day);
      const len = this.mcum.length;
      const total = this.mcum[len - 1]!;
      // k-th working minute counted from the table start (1-based).
      const k = n > 0 ? w + n : w + n + 1;
      if (k >= 1 && k <= total) return this.minuteAt(k, n > 0);
      if (k < 1) this.growM(this.mlo - len, this.mlo + len - 1);
      else this.growM(this.mlo, this.mlo + len * 2);
    }
  }

  /** {@link workingMinutesBetween} on minute numbers. */
  workingMinutesBetweenNum(a: number, b: number): number {
    if (b <= a) return 0;
    const da = Math.floor(a / MINUTES_PER_DAY);
    const db = Math.floor(b / MINUTES_PER_DAY);
    // Cover both ends first: growing the table renumbers the cumulative counts.
    this.ensureM(da - 1);
    this.ensureM(db);
    return this.minutesBefore(b, db) - this.minutesBefore(a, da);
  }

  /** {@link endFromDurationMinutes} on a minute number. */
  endFromDurationMinutesNum(start: number, minutes: number): number {
    if (minutes <= 0) return start;
    return this.addWorkingMinutesNum(this.addWorkingMinutesNum(start, 0), minutes);
  }

  /** {@link prevWorkingEnd} on a minute number. */
  prevWorkingEndNum(t: number): number {
    return this.addWorkingMinutesNum(this.addWorkingMinutesNum(t, -1), 1);
  }

  // ---------------------------------------------------------------- working-minute table

  /** Interval table of a day number: exception first, then the weekend rule, then the default day. */
  private intervalsNum(day: number): Int32Array {
    const ex = this.hourExceptions.get(day);
    if (ex !== undefined) return ex;
    return (this.weekendMask & (1 << weekdayOf(day))) === 0 ? this.defaultIntervals : NO_HOURS;
  }

  /** Working minutes from the table start up to instant `t` (lying on day `day`), exclusive. */
  private minutesBefore(t: number, day: number): number {
    this.ensureM(day - 1);
    this.ensureM(day);
    const m = t - day * MINUTES_PER_DAY;
    let w = this.mcum[day - 1 - this.mlo]!;
    const iv = this.intervalsNum(day);
    for (let k = 0; k < iv.length; k += 2) {
      const s = iv[k]!;
      if (m <= s) break;
      const e = iv[k + 1]!;
      w += (m < e ? m : e) - s;
    }
    return w;
  }

  /** Start instant (or end instant, when `end`) of the k-th working minute of the table (1-based). */
  private minuteAt(k: number, end: boolean): number {
    const cum = this.mcum;
    let a = 0;
    let b = cum.length - 1;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (cum[mid]! >= k) b = mid;
      else a = mid + 1;
    }
    const day = this.mlo + a;
    let r = k - (a > 0 ? cum[a - 1]! : 0);
    const iv = this.intervalsNum(day);
    for (let j = 0; j < iv.length; j += 2) {
      const len = iv[j + 1]! - iv[j]!;
      if (r <= len) return day * MINUTES_PER_DAY + iv[j]! + r - (end ? 0 : 1);
      r -= len;
    }
    throw new Error('Working-minute table out of sync');
  }

  /** Makes sure `day` lies inside the working-minute table. */
  private ensureM(day: number): void {
    const len = this.mcum.length;
    if (len === 0) this.growM(day - INITIAL_HALF_SPAN, day + INITIAL_HALF_SPAN);
    else if (day < this.mlo)
      this.growM(Math.min(day - INITIAL_HALF_SPAN, this.mlo - len), this.mlo + len - 1);
    else if (day >= this.mlo + len)
      this.growM(this.mlo, Math.max(day + INITIAL_HALF_SPAN, this.mlo + len * 2));
  }

  /** Rebuilds the working-minute table to cover `[from, to]`. */
  private growM(from: number, to: number): void {
    const len = to - from + 1;
    if (len > MAX_SPAN) {
      throw new RangeError(
        'Date outside the supported scheduling range (about 400 years), or the calendar has no working hours',
      );
    }
    const cum = new Int32Array(len);
    let c = 0;
    for (let i = 0; i < len; i++) {
      c += sumIntervals(this.intervalsNum(from + i));
      cum[i] = c;
    }
    this.mlo = from;
    this.mcum = cum;
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
