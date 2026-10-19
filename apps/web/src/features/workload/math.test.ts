import { describe, expect, it } from 'vitest';
import {
  MAX_RANGE_DAYS,
  clampRange,
  dayTotals,
  daysInclusive,
  daysOf,
  gridSummary,
  isWeekend,
  loadLevel,
  overloadDays,
  personTotals,
  presetOf,
  presetRange,
  projectRange,
} from './math';

const CAP = 480;

describe('loadLevel thresholds', () => {
  it('idle without allocation, light under 50 %, balanced under 90 %, full up to 100 %, over above', () => {
    expect(loadLevel(0, CAP)).toBe('idle');
    expect(loadLevel(60, CAP)).toBe('light');
    expect(loadLevel(239, CAP)).toBe('light');
    expect(loadLevel(240, CAP)).toBe('balanced');
    expect(loadLevel(431, CAP)).toBe('balanced');
    expect(loadLevel(432, CAP)).toBe('full');
    expect(loadLevel(480, CAP)).toBe('full');
    expect(loadLevel(481, CAP)).toBe('over');
    expect(loadLevel(960, CAP)).toBe('over');
  });
  it('treats work on a zero capacity as an overload', () => {
    expect(loadLevel(30, 0)).toBe('over');
    expect(loadLevel(0, 0)).toBe('idle');
  });
});

describe('overload detection and totals', () => {
  // 2026-10-18 is a Sunday; 23 Fri and 24 Sat are the weekend.
  const days = daysOf('2026-10-18', '2026-10-24').map((date, i) => ({
    date,
    assignedMinutes: [960, 0, 480, 1230, 300, 0, 600][i]!,
    loggedMinutes: [60, 0, 0, 120, 0, 0, 0][i]!,
    taskCount: [2, 0, 1, 4, 1, 0, 1][i]!,
  }));

  it('lists the days above capacity (equal to the capacity is not an overload)', () => {
    expect(overloadDays(days, CAP)).toEqual(['2026-10-18', '2026-10-21', '2026-10-24']);
  });

  it('sums a person over the range with capacity on working days only', () => {
    const tot = personTotals({ days }, CAP);
    expect(tot.assignedMinutes).toBe(3570);
    expect(tot.loggedMinutes).toBe(180);
    expect(tot.capacityMinutes).toBe(5 * CAP);
    expect(tot.utilisation).toBe(Math.round((3570 / 2400) * 100));
    expect(tot.overloadDays).toBe(3);
    expect(tot.peakMinutes).toBe(1230);
  });

  it('honours a project calendar weekend', () => {
    // Saturday only off → six working days.
    expect(personTotals({ days }, CAP, [6]).capacityMinutes).toBe(6 * CAP);
  });

  it('adds up per day across people and summarises the grid', () => {
    const other = days.map((d) => ({ ...d, assignedMinutes: 100, loggedMinutes: 30 }));
    const totals = dayTotals([{ days }, { days: other }]);
    expect(totals.get('2026-10-18')).toEqual({ assignedMinutes: 1060, loggedMinutes: 90 });
    expect(totals.get('2026-10-19')).toEqual({ assignedMinutes: 100, loggedMinutes: 30 });
    const people = [
      { user: { id: 'a', fullName: 'أ' }, days, totalAssignedMinutes: 0, totalLoggedMinutes: 0 },
      { user: { id: 'b', fullName: 'ب' }, days: other, totalAssignedMinutes: 0, totalLoggedMinutes: 0 },
    ];
    expect(gridSummary({ people, capacityMinutesPerDay: CAP })).toEqual({ people: 2, overloadedPeople: 1, overloadDays: 3 });
  });
});

describe('dates and ranges', () => {
  it('knows the Saudi weekend (Friday, Saturday)', () => {
    expect(isWeekend('2026-10-23')).toBe(true);
    expect(isWeekend('2026-10-24')).toBe(true);
    expect(isWeekend('2026-10-25')).toBe(false);
  });

  it('orders the ends and keeps a range within 92 days', () => {
    expect(clampRange('2026-10-30', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-30', clamped: false });
    const long = clampRange('2026-01-01', '2026-12-31');
    expect(long.clamped).toBe(true);
    expect(daysInclusive(long.from, long.to)).toBe(MAX_RANGE_DAYS);
  });

  it('builds the presets from today (Sunday-first week)', () => {
    const today = '2026-10-21'; // Wednesday
    expect(presetRange('week', today)).toEqual({ from: '2026-10-18', to: '2026-10-24' });
    expect(presetRange('twoWeeks', today)).toEqual({ from: '2026-10-21', to: '2026-11-03' });
    expect(presetRange('month', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(presetOf({ from: '2026-10-18', to: '2026-10-24' }, today)).toBe('week');
    expect(presetOf({ from: '2026-10-18', to: '2026-10-25' }, today)).toBeNull();
  });

  it('defaults a project tab to its span, clipped to 92 days around today', () => {
    expect(projectRange('2026-09-29', '2026-12-13', '2026-10-19')).toEqual({ from: '2026-09-29', to: '2026-12-13' });
    // HOUR projects send local date-times.
    expect(projectRange('2026-10-19', '2026-10-20T17:45', '2026-10-19')).toEqual({ from: '2026-10-19', to: '2026-10-20' });
    const long = projectRange('2026-10-11', '2027-04-22', '2026-10-19');
    expect(long.from).toBe('2026-10-11');
    expect(daysInclusive(long.from, long.to)).toBe(MAX_RANGE_DAYS);
    const mid = projectRange('2026-01-01', '2027-12-31', '2026-10-19');
    expect(mid.from).toBe('2026-10-05');
    expect(daysInclusive(mid.from, mid.to)).toBe(MAX_RANGE_DAYS);
    const ending = projectRange('2025-01-01', '2026-10-25', '2026-10-19');
    expect(ending.to).toBe('2026-10-25');
    expect(daysInclusive(ending.from, ending.to)).toBe(MAX_RANGE_DAYS);
  });
});

describe('M4 — the per-day capacity of the API (calculations audit)', () => {
  // Sun 18 normal, Mon 19 holiday (0), Tue 20 short day (180), Wed 21 normal.
  const days = [
    { date: '2026-10-18', assignedMinutes: 480, loggedMinutes: 0, taskCount: 1, capacityMinutes: 480 },
    { date: '2026-10-19', assignedMinutes: 480, loggedMinutes: 0, taskCount: 1, capacityMinutes: 0 },
    { date: '2026-10-20', assignedMinutes: 240, loggedMinutes: 0, taskCount: 1, capacityMinutes: 180 },
    { date: '2026-10-21', assignedMinutes: 0, loggedMinutes: 0, taskCount: 0, capacityMinutes: 480 },
  ];
  it('8 h on a holiday and 4 h on a 3 h day are overloads (were «ممتلئ» / balanced)', () => {
    expect(overloadDays(days, CAP)).toEqual(['2026-10-19', '2026-10-20']);
    expect(gridSummary({ people: [{ days }] as never, capacityMinutesPerDay: CAP }).overloadDays).toBe(2);
  });
  it('utilisation uses the real capacity: the holiday is not capacity', () => {
    const tot = personTotals({ days }, CAP);
    expect(tot.capacityMinutes).toBe(480 + 0 + 180 + 480);
    expect(personTotals({ days, totalCapacityMinutes: 1140 }, CAP).capacityMinutes).toBe(1140);
    // An older answer without per-day capacity falls back to working days × the standard day.
    expect(personTotals({ days: days.map(({ capacityMinutes: _c, ...d }) => d) }, CAP).capacityMinutes).toBe(4 * CAP);
  });
});
