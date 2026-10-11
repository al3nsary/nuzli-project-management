/**
 * Asia/Riyadh calendar helpers with the same semantics as the API (ADR-049):
 * Riyadh is UTC+03:00 with no DST, days are `[D 00:00+03:00, D+1 00:00+03:00)`, weeks start
 * on Sunday, weekday 0 = Sunday.
 */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant a Riyadh calendar day (`YYYY-MM-DD`) starts. */
export function riyadhDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - RIYADH_OFFSET_MS);
}

/** The instant the day after `day` starts (exclusive end of `day`). */
export function riyadhDayEnd(day: string): Date {
  return new Date(riyadhDayStart(day).getTime() + DAY_MS);
}

/** `YYYY-MM-DD` of an instant in Riyadh. */
export function riyadhDate(at: Date | string | number): string {
  const t = new Date(at).getTime() + RIYADH_OFFSET_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** Riyadh weekday (0 = Sunday) and hour of an instant. */
export function riyadhWeekdayHour(at: Date | string | number): { weekday: number; hour: number } {
  const local = new Date(new Date(at).getTime() + RIYADH_OFFSET_MS);
  return { weekday: local.getUTCDay(), hour: local.getUTCHours() };
}

/** Sunday-start weeks relative to `now`: previous, this and next week starts. */
export function riyadhWeekBounds(now: Date): { prevStart: Date; thisStart: Date; nextStart: Date } {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const dow = local.getUTCDay();
  const today = riyadhDayStart(local.toISOString().slice(0, 10)).getTime();
  const thisStart = today - dow * DAY_MS;
  return {
    prevStart: new Date(thisStart - 7 * DAY_MS),
    thisStart: new Date(thisStart),
    nextStart: new Date(thisStart + 7 * DAY_MS),
  };
}

/** The instant of a Riyadh wall-clock time `HH:MM` on the day `daysAgo` days before `now`. */
export function riyadhTimeDaysAgo(now: Date, daysAgo: number, hhmm: string): Date {
  const day = riyadhDate(now.getTime() - daysAgo * DAY_MS);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(riyadhDayStart(day).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}
