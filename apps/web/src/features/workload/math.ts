/**
 * Workload math (A9 «عبء العمل»): pure functions shared by the workload page and the project
 * workload tab. Dates are calendar days `YYYY-MM-DD`; weekdays are 0 = Sunday … 6 = Saturday
 * (the Saudi week starts on Sunday; the default weekend is Friday and Saturday).
 */
import type { WorkloadDto } from '@nuzli/shared';

/** `GET /workload` accepts at most 92 days. */
export const MAX_RANGE_DAYS = 92;
export const DEFAULT_WEEKEND = [5, 6] as const;

export type LoadLevel = 'idle' | 'light' | 'balanced' | 'full' | 'over';

/**
 * Load level of one day: nothing allocated → idle; under half the capacity → light; under 90 %
 * → balanced; up to the capacity (inclusive) → full; anything above the capacity → over.
 * A zero capacity with allocated work is an overload.
 */
export function loadLevel(assignedMinutes: number, capacityMinutes: number): LoadLevel {
  if (assignedMinutes <= 0) return 'idle';
  if (capacityMinutes <= 0) return 'over';
  const r = assignedMinutes / capacityMinutes;
  if (r > 1) return 'over';
  if (r >= 0.9) return 'full';
  if (r >= 0.5) return 'balanced';
  return 'light';
}

export const isOverloaded = (assignedMinutes: number, capacityMinutes: number) => loadLevel(assignedMinutes, capacityMinutes) === 'over';

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY_MS);
export const weekdayOf = (iso: string) => new Date(toMs(iso)).getUTCDay();
/** Inclusive number of calendar days from `from` to `to` (0 when `to` is before `from`). */
export const daysInclusive = (from: string, to: string) => Math.max(0, Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1);

export function isWeekend(iso: string, weekendDays: readonly number[] = DEFAULT_WEEKEND): boolean {
  return weekendDays.includes(weekdayOf(iso));
}

/** Every date of the range, inclusive. */
export function daysOf(from: string, to: string): string[] {
  const n = daysInclusive(from, to);
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

export interface Range {
  from: string;
  to: string;
}

/** Orders the two ends and keeps the range within `max` days (cut at the end). `clamped` tells the UI. */
export function clampRange(from: string, to: string, max = MAX_RANGE_DAYS): Range & { clamped: boolean } {
  let a = from.slice(0, 10);
  let b = to.slice(0, 10);
  if (b < a) [a, b] = [b, a];
  if (daysInclusive(a, b) > max) return { from: a, to: addDays(a, max - 1), clamped: true };
  return { from: a, to: b, clamped: false };
}

export type RangePreset = 'week' | 'twoWeeks' | 'month';

/** This week (Sunday → Saturday), the next two weeks (today + 13 days), this calendar month. */
export function presetRange(preset: RangePreset, today: string): Range {
  if (preset === 'week') {
    const from = addDays(today, -weekdayOf(today));
    return { from, to: addDays(from, 6) };
  }
  if (preset === 'twoWeeks') return { from: today, to: addDays(today, 13) };
  const [y, m] = today.split('-').map(Number) as [number, number];
  const first = `${today.slice(0, 7)}-01`;
  const last = fromMs(Date.UTC(y, m, 0));
  return { from: first, to: last };
}

/** Which preset (if any) the range is. */
export function presetOf(range: Range, today: string): RangePreset | null {
  for (const p of ['week', 'twoWeeks', 'month'] as const) {
    const r = presetRange(p, today);
    if (r.from === range.from && r.to === range.to) return p;
  }
  return null;
}

/**
 * Default range of a project's workload tab: the project span, clipped to at most `max` days
 * around today (two weeks of history, the rest ahead) when the project is longer.
 */
export function projectRange(start: string, end: string | null, today: string, max = MAX_RANGE_DAYS): Range {
  const s = start.slice(0, 10);
  const e = (end ?? addDays(s, 30)).slice(0, 10);
  const lo = e < s ? e : s;
  const hi = e < s ? s : e;
  if (daysInclusive(lo, hi) <= max) return { from: lo, to: hi };
  let from = addDays(today, -14);
  if (from < lo) from = lo;
  if (from > hi) from = addDays(hi, -(max - 1));
  let to = addDays(from, max - 1);
  if (to > hi) {
    to = hi;
    from = addDays(hi, -(max - 1));
  }
  return { from, to };
}

type Person = WorkloadDto['people'][number];
type Day = Person['days'][number];

/** Dates where the allocation exceeds the capacity. */
export function overloadDays(days: readonly Pick<Day, 'date' | 'assignedMinutes'>[], capacityMinutes: number): string[] {
  return days.filter((d) => isOverloaded(d.assignedMinutes, capacityMinutes)).map((d) => d.date);
}

export interface PersonTotals {
  assignedMinutes: number;
  loggedMinutes: number;
  /** Capacity over the working days of the range. */
  capacityMinutes: number;
  /** assigned / capacity × 100, rounded (0 without capacity). */
  utilisation: number;
  overloadDays: number;
  /** Highest single-day allocation. */
  peakMinutes: number;
}

export function personTotals(person: Pick<Person, 'days'>, capacityPerDay: number, weekendDays: readonly number[] = DEFAULT_WEEKEND): PersonTotals {
  let assigned = 0;
  let logged = 0;
  let working = 0;
  let peak = 0;
  for (const d of person.days) {
    assigned += d.assignedMinutes;
    logged += d.loggedMinutes;
    if (!isWeekend(d.date, weekendDays)) working++;
    if (d.assignedMinutes > peak) peak = d.assignedMinutes;
  }
  const capacity = working * capacityPerDay;
  return {
    assignedMinutes: assigned,
    loggedMinutes: logged,
    capacityMinutes: capacity,
    utilisation: capacity > 0 ? Math.round((assigned / capacity) * 100) : 0,
    overloadDays: overloadDays(person.days, capacityPerDay).length,
    peakMinutes: peak,
  };
}

/** Per-day sums over everyone (the footer row) keyed by date. */
export function dayTotals(people: readonly Pick<Person, 'days'>[]): Map<string, { assignedMinutes: number; loggedMinutes: number }> {
  const out = new Map<string, { assignedMinutes: number; loggedMinutes: number }>();
  for (const p of people) {
    for (const d of p.days) {
      const cur = out.get(d.date) ?? { assignedMinutes: 0, loggedMinutes: 0 };
      cur.assignedMinutes += d.assignedMinutes;
      cur.loggedMinutes += d.loggedMinutes;
      out.set(d.date, cur);
    }
  }
  return out;
}

/** Headline numbers of a grid: people over capacity at least once and all overload days. */
export function gridSummary(data: Pick<WorkloadDto, 'people' | 'capacityMinutesPerDay'>): { people: number; overloadedPeople: number; overloadDays: number } {
  let overloadedPeople = 0;
  let total = 0;
  for (const p of data.people) {
    const n = overloadDays(p.days, data.capacityMinutesPerDay).length;
    if (n) overloadedPeople++;
    total += n;
  }
  return { people: data.people.length, overloadedPeople, overloadDays: total };
}

/** Minutes as hours with at most one decimal (for the dense grid cells). */
export const hoursOf = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
