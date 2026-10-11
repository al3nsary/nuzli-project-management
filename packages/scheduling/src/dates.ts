/**
 * Calendar-date arithmetic on plain `YYYY-MM-DD` strings.
 *
 * Every date is converted to a **day number**: the count of days since
 * 1970-01-01 (UTC). Day numbers are plain integers, so there is no local time,
 * no timezone and no daylight-saving surprise anywhere in the engine.
 *
 * @module
 */

/** A calendar date in ISO form, `YYYY-MM-DD`. */
export type IsoDate = string;

/** Day of week of day number 0 (1970-01-01 was a Thursday). */
const EPOCH_WEEKDAY = 4;

const ISO_RE = /^(-?\d{4,6})-(\d{2})-(\d{2})(?:$|T)/;

/**
 * Days since 1970-01-01 for a proleptic-Gregorian civil date
 * (H. Hinnant's `days_from_civil`).
 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * Converts `YYYY-MM-DD` to a day number (days since 1970-01-01 UTC).
 * A trailing time part (`2026-10-11T00:00:00Z`) is tolerated and ignored: only
 * the literal date part is used.
 *
 * @throws RangeError when the string is not a valid calendar date.
 */
export function toDayNumber(date: IsoDate): number {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new RangeError(`Invalid date "${date}"`);
  }
  return daysFromCivil(y, mo, d);
}

/** Converts a day number back to `YYYY-MM-DD` (H. Hinnant's `civil_from_days`). */
export function fromDayNumber(day: number): IsoDate {
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  const ys = y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0');
  return `${ys}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/** Day of week of a day number: 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: number): number {
  return (((day + EPOCH_WEEKDAY) % 7) + 7) % 7;
}

/** Day of week of an ISO date: 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return weekdayOf(toDayNumber(date));
}

/** Adds calendar (not working) days to an ISO date. */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}
