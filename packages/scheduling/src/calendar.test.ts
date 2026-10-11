import { describe, expect, it } from 'vitest';
import { WorkCalendar } from './calendar';
import { addCalendarDays, dayOfWeek, fromDayNumber, toDayNumber } from './dates';

// October 2026: Thu 01, Fri 02, Sat 03, Sun 04 … Thu 08, Fri 09, Sat 10, Sun 11, Mon 12.

describe('dates', () => {
  it('converts ISO dates to UTC day numbers and back', () => {
    expect(toDayNumber('1970-01-01')).toBe(0);
    expect(toDayNumber('1970-01-02')).toBe(1);
    expect(toDayNumber('1969-12-31')).toBe(-1);
    expect(toDayNumber('2026-10-11')).toBe(Date.UTC(2026, 9, 11) / 86_400_000);
    for (const d of ['2024-02-29', '2000-02-29', '1900-03-01', '2026-12-31', '2100-01-01']) {
      expect(fromDayNumber(toDayNumber(d))).toBe(d);
    }
    for (let day = -800_000; day < 800_000; day += 997) {
      expect(toDayNumber(fromDayNumber(day))).toBe(day);
    }
  });

  it('ignores a trailing time part and rejects invalid dates', () => {
    expect(toDayNumber('2026-10-11T23:59:59+03:00')).toBe(toDayNumber('2026-10-11'));
    expect(() => toDayNumber('2026-02-29')).toThrow(RangeError);
    expect(() => toDayNumber('2026-13-01')).toThrow(RangeError);
    expect(() => toDayNumber('11/10/2026')).toThrow(RangeError);
    expect(() => toDayNumber('')).toThrow(RangeError);
  });

  it('knows the day of week (0 = Sunday)', () => {
    expect(dayOfWeek('2026-10-09')).toBe(5);
    expect(dayOfWeek('2026-10-10')).toBe(6);
    expect(dayOfWeek('2026-10-11')).toBe(0);
    expect(dayOfWeek('1970-01-01')).toBe(4);
    expect(addCalendarDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('WorkCalendar — default Friday/Saturday weekend', () => {
  const cal = new WorkCalendar();

  it('treats Friday and Saturday as non-working', () => {
    expect(cal.weekendDays).toEqual([5, 6]);
    expect(cal.isWorkingDay('2026-10-08')).toBe(true); // Thu
    expect(cal.isWorkingDay('2026-10-09')).toBe(false); // Fri
    expect(cal.isWorkingDay('2026-10-10')).toBe(false); // Sat
    expect(cal.isWorkingDay('2026-10-11')).toBe(true); // Sun
  });

  it('Thursday + 1 working day = Sunday', () => {
    expect(cal.addWorkingDays('2026-10-08', 1)).toBe('2026-10-11');
    expect(cal.addWorkingDays('2026-10-11', 5)).toBe('2026-10-18');
    expect(cal.addWorkingDays('2026-10-09', 1)).toBe('2026-10-11'); // from a Friday
  });

  it('adding 0 snaps a non-working day forward and keeps a working day', () => {
    expect(cal.addWorkingDays('2026-10-11', 0)).toBe('2026-10-11');
    expect(cal.addWorkingDays('2026-10-09', 0)).toBe('2026-10-11');
    expect(cal.addWorkingDays('2026-10-10', 0)).toBe('2026-10-11');
  });

  it('supports negative offsets', () => {
    expect(cal.addWorkingDays('2026-10-11', -1)).toBe('2026-10-08'); // Sun - 1 = Thu
    expect(cal.addWorkingDays('2026-10-11', -5)).toBe('2026-10-04');
    expect(cal.addWorkingDays('2026-10-10', -1)).toBe('2026-10-08'); // from a Saturday
    expect(cal.addWorkingDays('2026-10-11', -6)).toBe('2026-10-01');
  });

  it('next/prev working day are strict', () => {
    expect(cal.nextWorkingDay('2026-10-08')).toBe('2026-10-11');
    expect(cal.nextWorkingDay('2026-10-11')).toBe('2026-10-12');
    expect(cal.prevWorkingDay('2026-10-11')).toBe('2026-10-08');
    expect(cal.prevWorkingDay('2026-10-12')).toBe('2026-10-11');
  });

  it('counts working days inclusively', () => {
    expect(cal.workingDaysBetween('2026-10-04', '2026-10-17')).toBe(10);
    expect(cal.workingDaysBetween('2026-10-11', '2026-10-11')).toBe(1);
    expect(cal.workingDaysBetween('2026-10-09', '2026-10-10')).toBe(0);
    expect(cal.workingDaysBetween('2026-10-08', '2026-10-11')).toBe(2);
    expect(cal.workingDaysBetween('2026-10-12', '2026-10-11')).toBe(0);
  });

  it('derives ends from durations and durations from ranges', () => {
    expect(cal.endFromDuration('2026-10-11', 1)).toBe('2026-10-11');
    expect(cal.endFromDuration('2026-10-11', 5)).toBe('2026-10-15');
    expect(cal.endFromDuration('2026-10-11', 6)).toBe('2026-10-18');
    expect(cal.endFromDuration('2026-10-09', 1)).toBe('2026-10-11'); // Friday start snaps forward
    expect(cal.endFromDuration('2026-10-09', 0)).toBe('2026-10-09'); // milestone
    expect(cal.endFromDuration('2026-10-11', 0)).toBe('2026-10-11');
    expect(cal.durationFromRange('2026-10-11', '2026-10-18')).toBe(6);
    expect(cal.durationFromRange('2026-10-11', '2026-10-11')).toBe(1);
  });

  it('round-trips duration and end for every start in a year', () => {
    for (let day = toDayNumber('2026-01-01'); day < toDayNumber('2027-01-01'); day++) {
      const start = cal.addWorkingDays(fromDayNumber(day), 0);
      for (const d of [1, 2, 7, 30]) {
        expect(cal.durationFromRange(start, cal.endFromDuration(start, d))).toBe(d);
      }
    }
  });

  it('rejects non-integer offsets', () => {
    expect(() => cal.addWorkingDays('2026-10-11', 1.5)).toThrow(RangeError);
  });
});

describe('WorkCalendar — custom weekends and exceptions', () => {
  it('honours a Saturday/Sunday weekend', () => {
    const cal = new WorkCalendar({ weekendDays: [6, 0], exceptions: [] });
    expect(cal.isWorkingDay('2026-10-09')).toBe(true); // Fri
    expect(cal.addWorkingDays('2026-10-09', 1)).toBe('2026-10-12'); // Fri + 1 = Mon
    expect(cal.addWorkingDays('2026-10-12', -1)).toBe('2026-10-09');
    expect(cal.weekendDays).toEqual([0, 6]);
  });

  it('skips holidays', () => {
    const cal = new WorkCalendar({
      weekendDays: [5, 6],
      exceptions: [{ date: '2026-10-12', isWorking: false }],
    });
    expect(cal.isWorkingDay('2026-10-12')).toBe(false);
    expect(cal.addWorkingDays('2026-10-08', 1)).toBe('2026-10-11');
    expect(cal.addWorkingDays('2026-10-08', 2)).toBe('2026-10-13'); // Thu → Sun → (Mon holiday) → Tue
    expect(cal.addWorkingDays('2026-10-13', -1)).toBe('2026-10-11');
    expect(cal.addWorkingDays('2026-10-12', 0)).toBe('2026-10-13');
    expect(cal.workingDaysBetween('2026-10-11', '2026-10-15')).toBe(4);
    expect(cal.endFromDuration('2026-10-11', 2)).toBe('2026-10-13');
  });

  it('a working-Saturday exception overrides the weekend', () => {
    const cal = new WorkCalendar({ exceptions: [{ date: '2026-10-10', isWorking: true }] });
    expect(cal.isWorkingDay('2026-10-10')).toBe(true);
    expect(cal.isWorkingDay('2026-10-09')).toBe(false);
    expect(cal.addWorkingDays('2026-10-08', 1)).toBe('2026-10-10');
    expect(cal.addWorkingDays('2026-10-08', 2)).toBe('2026-10-11');
    expect(cal.workingDaysBetween('2026-10-08', '2026-10-11')).toBe(3);
  });

  it('rejects a calendar with no working day', () => {
    expect(() => new WorkCalendar({ weekendDays: [0, 1, 2, 3, 4, 5, 6] })).toThrow(RangeError);
    expect(() => new WorkCalendar({ weekendDays: [7] })).toThrow(RangeError);
  });

  it('matches a naive day-by-day implementation, far in the past and future', () => {
    let seed = 42;
    const rnd = (k: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % k;
    };
    const base = toDayNumber('2026-01-01');
    const exceptions = Array.from({ length: 60 }, () => ({
      date: fromDayNumber(base + rnd(4000) - 2000),
      isWorking: rnd(3) === 0,
    }));
    const cal = new WorkCalendar({ weekendDays: [5, 6], exceptions });
    const naiveWorking = new Map<number, boolean>();
    for (const e of exceptions) naiveWorking.set(toDayNumber(e.date), e.isWorking);
    const isW = (d: number): boolean =>
      naiveWorking.get(d) ?? ![5, 6].includes((((d + 4) % 7) + 7) % 7);
    const naiveAdd = (d: number, n: number): number => {
      if (n === 0) {
        while (!isW(d)) d++;
        return d;
      }
      const step = n > 0 ? 1 : -1;
      let left = Math.abs(n);
      while (left > 0) {
        d += step;
        if (isW(d)) left--;
      }
      return d;
    };
    for (let k = 0; k < 400; k++) {
      const d = base + rnd(30_000) - 15_000; // ±40 years: forces the table to grow both ways
      const n = rnd(1_600) - 800;
      expect(cal.addWorkingDaysNum(d, n)).toBe(naiveAdd(d, n));
      const e = d + rnd(900);
      let count = 0;
      for (let x = d; x <= e; x++) if (isW(x)) count++;
      expect(cal.workingDaysBetweenNum(d, e)).toBe(count);
    }
  });

  it('WorkCalendar.from reuses an existing instance', () => {
    const cal = new WorkCalendar();
    expect(WorkCalendar.from(cal)).toBe(cal);
    expect(WorkCalendar.from({ weekendDays: [5, 6], exceptions: [] })).toBeInstanceOf(WorkCalendar);
  });
});
