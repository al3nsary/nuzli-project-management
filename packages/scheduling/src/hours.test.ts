import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKING_HOURS, WorkCalendar, type Calendar } from './calendar';
import { dependenciesToDays, dependenciesToHours, tasksToDays, tasksToHours } from './convert';
import { fromMinuteNumber, toDayNumber, toMinuteNumber } from './dates';
import { CycleError, TaskEditError } from './errors';
import { rollUp } from './rollup';
import { moveTask, resizeTask, schedule } from './schedule';
import { byId, fs, fsh, group, htask, task } from './test-helpers';
import type { ScheduleDependency, ScheduleTask } from './types';

// October 2026: Thu 01, Fri 02, Sat 03, Sun 04, Mon 05, Tue 06, Wed 07, Thu 08,
// Fri 09, Sat 10, Sun 11, Mon 12, Tue 13. Default day: 09:00–13:00 + 14:00–18:00.

const HOLIDAY: Calendar = {
  weekendDays: [5, 6],
  exceptions: [{ date: '2026-10-12', isWorking: false }],
};
const SPECIAL: Calendar = {
  weekendDays: [5, 6],
  exceptions: [
    // A short day (e.g. Ramadan hours) and a working Saturday with its own hours.
    { date: '2026-10-05', isWorking: true, workingHours: [{ start: '08:00', end: '12:00' }] },
    { date: '2026-10-10', isWorking: true, workingHours: [{ start: '10:00', end: '14:00' }] },
  ],
};
const H = 'HOUR' as const;

describe('local date-times', () => {
  it('converts YYYY-MM-DDTHH:MM to minute numbers and back', () => {
    expect(toMinuteNumber('1970-01-01T00:00')).toBe(0);
    expect(toMinuteNumber('1970-01-02T01:30')).toBe(1440 + 90);
    expect(toMinuteNumber('2026-10-04')).toBe(toDayNumber('2026-10-04') * 1440);
    expect(toMinuteNumber('2026-10-04T09:15:59')).toBe(toMinuteNumber('2026-10-04T09:15'));
    expect(toMinuteNumber('2026-10-04T09:15+03:00')).toBe(toMinuteNumber('2026-10-04T09:15'));
    expect(fromMinuteNumber(toMinuteNumber('2026-10-04T09:05'))).toBe('2026-10-04T09:05');
    expect(fromMinuteNumber(-1)).toBe('1969-12-31T23:59');
  });

  it('rejects UTC instants, other offsets and invalid times', () => {
    expect(() => toMinuteNumber('2026-10-04T09:00Z')).toThrow(RangeError);
    expect(() => toMinuteNumber('2026-10-04T09:00:00.000Z')).toThrow(RangeError);
    expect(() => toMinuteNumber('2026-10-04T09:00+02:00')).toThrow(RangeError);
    expect(() => toMinuteNumber('2026-10-04T24:00')).toThrow(RangeError);
    expect(() => toMinuteNumber('2026-10-04T09:60')).toThrow(RangeError);
    expect(() => toMinuteNumber('2026-02-30T09:00')).toThrow(RangeError);
  });
});

describe('WorkCalendar — working hours', () => {
  const cal = new WorkCalendar();

  it('defaults to 09:00–13:00 and 14:00–18:00 (8 h) on working days', () => {
    expect(cal.workingHours).toEqual(DEFAULT_WORKING_HOURS);
    expect(cal.standardMinutesPerDay).toBe(480);
    expect(cal.hoursPerDay('2026-10-04')).toBe(8);
    expect(cal.hoursPerDay('2026-10-09')).toBe(0); // Friday
    expect(cal.workingIntervals('2026-10-04')).toEqual([
      { start: '09:00', end: '13:00' },
      { start: '14:00', end: '18:00' },
    ]);
    expect(cal.workingIntervals('2026-10-10')).toEqual([]);
  });

  it('isWorkingMinute: the lunch break, both ends and the weekend', () => {
    expect(cal.isWorkingMinute('2026-10-04T08:59')).toBe(false);
    expect(cal.isWorkingMinute('2026-10-04T09:00')).toBe(true);
    expect(cal.isWorkingMinute('2026-10-04T12:59')).toBe(true);
    expect(cal.isWorkingMinute('2026-10-04T13:00')).toBe(false);
    expect(cal.isWorkingMinute('2026-10-04T13:59')).toBe(false);
    expect(cal.isWorkingMinute('2026-10-04T14:00')).toBe(true);
    expect(cal.isWorkingMinute('2026-10-04T17:59')).toBe(true);
    expect(cal.isWorkingMinute('2026-10-04T18:00')).toBe(false);
    expect(cal.isWorkingMinute('2026-10-09T10:00')).toBe(false); // Friday
    expect(cal.isWorkingMinute('2026-10-10T10:00')).toBe(false); // Saturday
  });

  it('nextWorkingMinute snaps forward over lunch, evenings and Fri/Sat', () => {
    expect(cal.nextWorkingMinute('2026-10-04T10:15')).toBe('2026-10-04T10:15');
    expect(cal.nextWorkingMinute('2026-10-04T07:00')).toBe('2026-10-04T09:00');
    expect(cal.nextWorkingMinute('2026-10-04T13:00')).toBe('2026-10-04T14:00');
    expect(cal.nextWorkingMinute('2026-10-08T18:00')).toBe('2026-10-11T09:00'); // Thu → Sun
    expect(cal.nextWorkingMinute('2026-10-09')).toBe('2026-10-11T09:00');
  });

  it('endFromDurationMinutes: a 6 h task from 11:00 spans the lunch break', () => {
    // 11:00–13:00 (2 h) + 14:00–18:00 (4 h) = 6 h: ends the same day at 18:00.
    expect(cal.endFromDurationMinutes('2026-10-04T11:00', 360)).toBe('2026-10-04T18:00');
    // 7 h: one more hour on the next working day, 09:00–10:00.
    expect(cal.endFromDurationMinutes('2026-10-04T11:00', 420)).toBe('2026-10-05T10:00');
    // From Thursday 11:00, the 7th hour falls on Sunday (Fri/Sat skipped).
    expect(cal.endFromDurationMinutes('2026-10-08T11:00', 420)).toBe('2026-10-11T10:00');
    // Ending exactly at the lunch break gives 13:00, not 14:00.
    expect(cal.endFromDurationMinutes('2026-10-04T11:00', 120)).toBe('2026-10-04T13:00');
    // A start inside the break snaps to 14:00 first; 15 minutes then end at 14:15.
    expect(cal.endFromDurationMinutes('2026-10-04T13:20', 15)).toBe('2026-10-04T14:15');
    // 0 = milestone at start (unchanged).
    expect(cal.endFromDurationMinutes('2026-10-04T13:20', 0)).toBe('2026-10-04T13:20');
  });

  it('addWorkingMinutes forwards, backwards (negative) and 0 (snap)', () => {
    expect(cal.addWorkingMinutes('2026-10-04T11:00', 120)).toBe('2026-10-04T13:00');
    expect(cal.addWorkingMinutes('2026-10-04T11:00', 121)).toBe('2026-10-04T14:01');
    expect(cal.addWorkingMinutes('2026-10-04T14:00', -60)).toBe('2026-10-04T12:00');
    expect(cal.addWorkingMinutes('2026-10-04T14:00', -1)).toBe('2026-10-04T12:59');
    expect(cal.addWorkingMinutes('2026-10-11T09:00', -60)).toBe('2026-10-08T17:00'); // Sun → Thu
    expect(cal.addWorkingMinutes('2026-10-11T10:30', -480)).toBe('2026-10-08T10:30');
    expect(cal.addWorkingMinutes('2026-10-04T13:00', 0)).toBe('2026-10-04T14:00');
    expect(() => cal.addWorkingMinutes('2026-10-04T13:00', 1.5)).toThrow(RangeError);
  });

  it('workingMinutesBetween counts the half-open span [a, b)', () => {
    expect(cal.workingMinutesBetween('2026-10-04T11:00', '2026-10-04T18:00')).toBe(360);
    expect(cal.workingMinutesBetween('2026-10-04T12:30', '2026-10-04T14:30')).toBe(60);
    expect(cal.workingMinutesBetween('2026-10-08T17:00', '2026-10-11T10:00')).toBe(120);
    expect(cal.workingMinutesBetween('2026-10-04T18:00', '2026-10-04T11:00')).toBe(0);
    expect(cal.workingMinutesBetween('2026-10-04T00:00', '2026-10-11T00:00')).toBe(5 * 480);
  });

  it('round-trips add/between far away (table growth both ways)', () => {
    const a = '2026-10-04T10:07';
    for (const n of [1, 59, 480, 12_345, 1_000_000, -1, -481, -2_000_000]) {
      const b = cal.addWorkingMinutes(a, n);
      if (n > 0) expect(cal.workingMinutesBetween(a, b)).toBe(n);
      else expect(cal.workingMinutesBetween(b, a)).toBe(-n);
    }
  });

  it('skips holidays', () => {
    const c = new WorkCalendar(HOLIDAY);
    expect(c.hoursPerDay('2026-10-12')).toBe(0);
    // Sun 11 16:00 + 6 h: 2 h on Sunday, Monday 12 is a holiday, 4 h on Tuesday.
    expect(c.endFromDurationMinutes('2026-10-11T16:00', 360)).toBe('2026-10-13T13:00');
    expect(c.addWorkingMinutes('2026-10-13T09:00', -30)).toBe('2026-10-11T17:30');
  });

  it('applies an exception with special hours (short day, working Saturday)', () => {
    const c = new WorkCalendar(SPECIAL);
    expect(c.hoursPerDay('2026-10-05')).toBe(4);
    expect(c.workingIntervals('2026-10-05')).toEqual([{ start: '08:00', end: '12:00' }]);
    expect(c.isWorkingMinute('2026-10-05T08:30')).toBe(true);
    expect(c.isWorkingMinute('2026-10-05T14:30')).toBe(false);
    // Sun 14:00 + 8 h: 4 h on Sunday, then Monday's 08:00–12:00.
    expect(c.endFromDurationMinutes('2026-10-04T14:00', 480)).toBe('2026-10-05T12:00');
    // Thu 17:00 + 3 h: 1 h Thursday, Friday off, Saturday 10:00–12:00.
    expect(c.endFromDurationMinutes('2026-10-08T17:00', 180)).toBe('2026-10-10T12:00');
    expect(c.isWorkingMinute('2026-10-10T09:30')).toBe(false);
    expect(c.nextWorkingMinute('2026-10-10T14:00')).toBe('2026-10-11T09:00');
    // The day mode sees the Saturday as a working day too.
    expect(c.isWorkingDay('2026-10-10')).toBe(true);
  });

  it('custom working hours: validation, sorting and merging', () => {
    const c = new WorkCalendar({
      workingHours: [
        { start: '11:00', end: '13:00' },
        { start: '07:30', end: '12:00' },
      ],
    });
    expect(c.workingHours).toEqual([{ start: '07:30', end: '13:00' }]);
    expect(c.standardMinutesPerDay).toBe(330);
    expect(
      new WorkCalendar({ workingHours: [{ start: '00:00', end: '24:00' }] }).hoursPerDay(
        '2026-10-04',
      ),
    ).toBe(24);
    expect(() => new WorkCalendar({ workingHours: [{ start: '25:00', end: '26:00' }] })).toThrow(
      RangeError,
    );
    expect(() => new WorkCalendar({ workingHours: [{ start: '9:00', end: '13:00' }] })).toThrow(
      RangeError,
    );
    expect(() => new WorkCalendar({ workingHours: [{ start: '13:00', end: '09:00' }] })).toThrow(
      RangeError,
    );
    expect(() => new WorkCalendar({ workingHours: [] }).nextWorkingMinute('2026-10-04')).toThrow(
      RangeError,
    );
  });

  it('prevWorkingEnd snaps an end back to the previous working minute', () => {
    expect(cal.prevWorkingEnd('2026-10-04T13:30')).toBe('2026-10-04T13:00');
    expect(cal.prevWorkingEnd('2026-10-04T10:30')).toBe('2026-10-04T10:30');
    expect(cal.prevWorkingEnd('2026-10-04T18:00')).toBe('2026-10-04T18:00');
    expect(cal.prevWorkingEnd('2026-10-11T08:00')).toBe('2026-10-08T18:00');
  });
});

describe('schedule — HOUR projects', () => {
  it('FS: the successor starts at the next working minute after the predecessor ends', () => {
    const tasks = [
      htask('A', '2026-10-04T11:00', 6), // ends Sun 18:00
      htask('B', '2026-10-04T09:00', 2),
    ];
    const r = schedule({ tasks, dependencies: [fsh('A', 'B')], durationUnit: H });
    expect(byId(r.tasks).B).toMatchObject({
      startDate: '2026-10-05T09:00',
      endDate: '2026-10-05T11:00',
      durationHours: 2,
      durationDays: 1,
    });
    expect(r.changedIds).toEqual(['B']);
  });

  it('a predecessor ending at 13:00 lets the successor start after lunch', () => {
    const tasks = [htask('A', '2026-10-04T09:00', 4), htask('B', '2026-10-04T09:00', 1)];
    const r = schedule({ tasks, dependencies: [fsh('A', 'B')], durationUnit: H });
    expect(byId(r.tasks).B).toMatchObject({
      startDate: '2026-10-04T14:00',
      endDate: '2026-10-04T15:00',
    });
  });

  it('FS with a lag in working hours spills over to the next day', () => {
    const tasks = [htask('A', '2026-10-04T09:00', 3), htask('B', '2026-10-04T09:00', 4)];
    const r = schedule({ tasks, dependencies: [fsh('A', 'B', 3)], durationUnit: H });
    // A ends 12:00; +3 h = 12:00–13:00 and 14:00–16:00 → 16:00. B: 16–18 + Mon 09–11.
    expect(byId(r.tasks).B).toMatchObject({
      startDate: '2026-10-04T16:00',
      endDate: '2026-10-05T11:00',
      durationHours: 4,
      durationDays: 2,
    });
  });

  it('a fractional lag (0.25 h) and a lead (negative lag)', () => {
    const tasks = [
      htask('A', '2026-10-04T11:00', 6),
      htask('B', '2026-10-04T09:00', 1),
      htask('C', '2026-10-04T09:00', 1),
    ];
    const r = schedule({
      tasks,
      dependencies: [fsh('A', 'B', -1), fsh('A', 'C', 0.25)],
      durationUnit: H,
    });
    expect(byId(r.tasks).B!.startDate).toBe('2026-10-04T17:00');
    expect(byId(r.tasks).C!.startDate).toBe('2026-10-05T09:15');
  });

  it('falls back to lagDays × the standard day when lagHours is absent', () => {
    const tasks = [htask('A', '2026-10-04T11:00', 6), htask('B', '2026-10-04T09:00', 1)];
    const dep: ScheduleDependency = {
      predecessorId: 'A',
      successorId: 'B',
      type: 'FS',
      lagDays: 1,
    };
    const r = schedule({ tasks, dependencies: [dep], durationUnit: H });
    // Sun 18:00 + 8 h = Mon 18:00 → next working minute Tue 09:00.
    expect(byId(r.tasks).B!.startDate).toBe('2026-10-06T09:00');
  });

  it('crosses Fri/Sat and a holiday', () => {
    const c = HOLIDAY;
    const tasks = [
      htask('A', '2026-10-08T15:00', 5, { calendar: c }), // Thu 15–18, Sun 09–11
      htask('B', '2026-10-01T09:00', 6, { calendar: c }),
    ];
    const r = schedule({ tasks, dependencies: [fsh('A', 'B')], calendar: c, durationUnit: H });
    expect(byId(r.tasks).A!.endDate).toBe('2026-10-11T11:00');
    // B: Sun 11–13, 14–18 (6 h) → ends Sun 18:00.
    expect(byId(r.tasks).B).toMatchObject({
      startDate: '2026-10-11T11:00',
      endDate: '2026-10-11T18:00',
    });
    const r2 = schedule({ tasks, dependencies: [fsh('A', 'B', 7)], calendar: c, durationUnit: H });
    // 11:00 + 7 h: 6 h left on Sunday, Monday is a holiday, 1 h on Tuesday → 10:00; 6 h → 17:00.
    expect(byId(r2.tasks).B).toMatchObject({
      startDate: '2026-10-13T10:00',
      endDate: '2026-10-13T17:00',
    });
  });

  it('special hours on an exception day', () => {
    const c = SPECIAL;
    const tasks = [
      htask('A', '2026-10-04T14:00', 4, { calendar: c }),
      htask('B', '2026-10-04T09:00', 6, { calendar: c }),
    ];
    const r = schedule({ tasks, dependencies: [fsh('A', 'B')], calendar: c, durationUnit: H });
    // A ends Sun 18:00; Monday works 08:00–12:00 only, so B = Mon 08–12 + Tue 09–11.
    expect(byId(r.tasks).B).toMatchObject({
      startDate: '2026-10-05T08:00',
      endDate: '2026-10-06T11:00',
      durationDays: 2,
    });
  });

  it('milestones: duration 0, end = start, as successor and as predecessor', () => {
    const tasks = [
      htask('A', '2026-10-04T09:00', 4), // ends 13:00
      htask('M', '2026-10-01T09:00', 0),
      htask('B', '2026-10-01T09:00', 2),
    ];
    const r = schedule({ tasks, dependencies: [fsh('A', 'M'), fsh('M', 'B')], durationUnit: H });
    const o = byId(r.tasks);
    expect(o.M).toMatchObject({
      startDate: '2026-10-04T14:00',
      endDate: '2026-10-04T14:00',
      durationHours: 0,
      durationDays: 0,
    });
    expect(o.B).toMatchObject({ startDate: '2026-10-04T14:00', endDate: '2026-10-04T16:00' });
  });

  it('a consistent plan reports no change; equal instants written differently are not changes', () => {
    const tasks = [htask('A', '2026-10-04T09:00', 4), htask('B', '2026-10-04T14:00', 2)];
    expect(schedule({ tasks, dependencies: [fsh('A', 'B')], durationUnit: H }).changedIds).toEqual(
      [],
    );
    const r = moveTask(
      {
        tasks: [{ ...tasks[0]!, startDate: '2026-10-04T09:00:00' }, tasks[1]!],
        dependencies: [fsh('A', 'B')],
        durationUnit: H,
      },
      'B',
      '2026-10-04T14:00',
    );
    expect(r.changes).toEqual([]);
  });

  it('derives the duration from the range when durationHours is absent', () => {
    const t: ScheduleTask = {
      id: 'A',
      parentId: null,
      sortOrder: 0,
      type: 'TASK',
      startDate: '2026-10-04T11:00',
      endDate: '2026-10-05T10:00',
      durationDays: 1,
      progress: 0,
    };
    const r = rollUp([t], undefined, H);
    expect(r.tasks[0]).toMatchObject({ durationHours: 7, durationDays: 2 });
  });

  it('a group successor shifts its leaves by the same working minutes', () => {
    const tasks = [
      htask('A', '2026-10-04T09:00', 6), // ends 16:00
      group('G'),
      htask('x', '2026-10-04T09:00', 2, { parentId: 'G' }),
      htask('y', '2026-10-04T11:00', 1, { parentId: 'G', sortOrder: 1 }),
    ];
    const r = schedule({ tasks, dependencies: [fsh('A', 'G')], durationUnit: H });
    const o = byId(r.tasks);
    // G starts 09:00, must start at 16:00: shift = 6 working hours.
    expect(o.x).toMatchObject({ startDate: '2026-10-04T16:00', endDate: '2026-10-04T18:00' });
    // y: 11:00 + 6 h = 18:00 → next working minute Mon 09:00.
    expect(o.y).toMatchObject({ startDate: '2026-10-05T09:00', endDate: '2026-10-05T10:00' });
    expect(o.G).toMatchObject({
      startDate: '2026-10-04T16:00',
      endDate: '2026-10-05T10:00',
      durationHours: 3,
    });
  });

  it('still detects cycles', () => {
    const tasks = [htask('A', '2026-10-04T09:00', 1), htask('B', '2026-10-04T09:00', 1)];
    expect(() =>
      schedule({ tasks, dependencies: [fsh('A', 'B'), fsh('B', 'A')], durationUnit: H }),
    ).toThrow(CycleError);
  });
});

describe('rollUp — HOUR projects', () => {
  it('weights progress by working minutes', () => {
    const tasks = [
      group('G'),
      htask('a', '2026-10-04T09:00', 8, { parentId: 'G', progress: 100 }),
      htask('b', '2026-10-05T09:00', 2, { parentId: 'G', sortOrder: 1, progress: 0 }),
      htask('m', '2026-10-05T11:00', 0, { parentId: 'G', sortOrder: 2, progress: 0 }),
    ];
    const r = rollUp(tasks, undefined, H);
    // 8 h at 100 % and 2 h at 0 % → 80 %; the milestone weighs nothing.
    expect(byId(r.tasks).G).toMatchObject({
      startDate: '2026-10-04T09:00',
      endDate: '2026-10-05T11:00',
      durationHours: 10,
      durationDays: 2,
      progress: 80,
    });
    expect(r.changedIds).toEqual(['G']);
    // The same tasks in a DAY project weigh 1 day each → 50 %.
    const days = tasksToDays(tasks);
    expect(byId(rollUp(days).tasks).G!.progress).toBe(50);
  });
});

describe('moveTask / resizeTask — HOUR projects', () => {
  const state = () => ({
    tasks: [htask('A', '2026-10-04T09:00', 6), htask('B', '2026-10-04T16:00', 2)],
    dependencies: [fsh('A', 'B')],
    durationUnit: H,
  });

  it('moves a task into the lunch break: it snaps to 14:00 and pushes its successor', () => {
    const r = moveTask(state(), 'A', '2026-10-04T13:30');
    const o = byId(r.tasks);
    expect(o.A).toMatchObject({
      startDate: '2026-10-04T14:00',
      endDate: '2026-10-05T11:00',
      durationHours: 6,
      durationDays: 2,
    });
    expect(o.B).toMatchObject({ startDate: '2026-10-05T11:00', endDate: '2026-10-05T13:00' });
    expect(r.changedIds).toEqual(['A', 'B']);
  });

  it('moves earlier without pulling the successor back', () => {
    const r = moveTask(state(), 'A', '2026-10-01T09:00');
    expect(byId(r.tasks).A).toMatchObject({
      startDate: '2026-10-01T09:00',
      endDate: '2026-10-01T16:00',
    });
    expect(r.changedIds).toEqual(['A']);
  });

  it('moves a group by signed working minutes', () => {
    const tasks = [
      group('G'),
      htask('x', '2026-10-04T09:00', 2, { parentId: 'G' }),
      htask('y', '2026-10-04T14:00', 1, { parentId: 'G', sortOrder: 1 }),
    ];
    const fwd = byId(
      moveTask({ tasks, dependencies: [], durationUnit: H }, 'G', '2026-10-04T12:00').tasks,
    );
    // +3 working hours: x 12:00–13:00 + 14:00–15:00; y 14:00 + 3 h = 17:00.
    expect(fwd.x).toMatchObject({ startDate: '2026-10-04T12:00', endDate: '2026-10-04T15:00' });
    expect(fwd.y).toMatchObject({ startDate: '2026-10-04T17:00', endDate: '2026-10-04T18:00' });
    const back = byId(
      moveTask({ tasks, dependencies: [], durationUnit: H }, 'G', '2026-10-01T17:00').tasks,
    );
    // −1 working hour (Thu 17:00 → Sun 09:00): x spans the weekend, y moves 14:00 → 12:00.
    expect(back.x).toMatchObject({ startDate: '2026-10-01T17:00', endDate: '2026-10-04T10:00' });
    expect(back.y).toMatchObject({ startDate: '2026-10-04T12:00', endDate: '2026-10-04T13:00' });
  });

  it('resizes to the lunch break (snaps back to 13:00) and recomputes hours', () => {
    const r = resizeTask(state(), 'A', '2026-10-04T13:30');
    expect(byId(r.tasks).A).toMatchObject({
      endDate: '2026-10-04T13:00',
      durationHours: 4,
      durationDays: 1,
    });
    expect(r.changedIds).toEqual(['A']); // B (16:00) is still after A
    const longer = resizeTask(state(), 'A', '2026-10-05T10:30');
    expect(byId(longer.tasks).A).toMatchObject({
      endDate: '2026-10-05T10:30',
      durationHours: 9.5,
      durationDays: 2,
    });
    expect(byId(longer.tasks).B).toMatchObject({
      startDate: '2026-10-05T10:30',
      endDate: '2026-10-05T12:30',
    });
  });

  it('never resizes below a quarter-hour, and refuses milestones', () => {
    const r = resizeTask(state(), 'A', '2026-10-01T09:00');
    expect(byId(r.tasks).A).toMatchObject({ endDate: '2026-10-04T09:15', durationHours: 0.25 });
    const s = { tasks: [htask('M', '2026-10-04T09:00', 0)], dependencies: [], durationUnit: H };
    expect(() => resizeTask(s, 'M', '2026-10-05T09:00')).toThrow(TaskEditError);
  });
});

describe('DAY ↔ HOUR conversion', () => {
  it('day tasks become hour tasks on the same working days', () => {
    const tasks = [
      task('A', '2026-10-04', 2),
      task('M', '2026-10-06', 0),
      task('W', '2026-10-08', 2),
    ];
    const h = byId(tasksToHours(tasks));
    expect(h.A).toMatchObject({
      startDate: '2026-10-04T09:00',
      endDate: '2026-10-05T18:00',
      durationHours: 16,
    });
    expect(h.M).toMatchObject({
      startDate: '2026-10-06T09:00',
      endDate: '2026-10-06T09:00',
      durationHours: 0,
    });
    // Thu + Sun across the weekend.
    expect(h.W).toMatchObject({
      startDate: '2026-10-08T09:00',
      endDate: '2026-10-11T18:00',
      durationHours: 16,
    });
    // Special hours count as they are: Sun 8 h + Mon 4 h.
    expect(byId(tasksToHours(tasks, SPECIAL)).A).toMatchObject({
      endDate: '2026-10-05T12:00',
      durationHours: 12,
    });
  });

  it('hour tasks become day tasks (a partial day counts as a whole day) and round-trip', () => {
    const tasks = [
      task('A', '2026-10-04', 2),
      task('M', '2026-10-06', 0),
      task('W', '2026-10-08', 2),
    ];
    const strip = (t: ScheduleTask) => [t.id, t.type, t.startDate, t.endDate, t.durationDays];
    expect(tasksToDays(tasksToHours(tasks)).map(strip)).toEqual(tasks.map(strip));
    const d = byId(
      tasksToDays([htask('P', '2026-10-04T16:00', 4), htask('Q', '2026-10-04T11:00', 6)]),
    );
    expect(d.P).toMatchObject({ startDate: '2026-10-04', endDate: '2026-10-05', durationDays: 2 });
    // Ending exactly at 18:00 stays on Sunday.
    expect(d.Q).toMatchObject({ startDate: '2026-10-04', endDate: '2026-10-04', durationDays: 1 });
  });

  it('converts lags with the standard day length', () => {
    const deps = [fs('A', 'B', 2), fs('B', 'C', -1)];
    expect(dependenciesToHours(deps).map((d) => d.lagHours)).toEqual([16, -8]);
    const back = dependenciesToDays([fsh('A', 'B', 12), fsh('B', 'C', 3), fsh('C', 'D', -8)]);
    expect(back.map((d) => d.lagDays)).toEqual([2, 0, -1]);
  });

  it('a day project and its hour conversion schedule to the same days (no milestones)', () => {
    const tasks: ScheduleTask[] = [];
    const deps: ScheduleDependency[] = [];
    for (let i = 0; i < 40; i++) {
      tasks.push(task(`t${i}`, '2026-10-04', 1 + (i % 4), { calendar: HOLIDAY, sortOrder: i }));
      if (i > 0) deps.push(fs(`t${i - 1}`, `t${i}`, (i % 3) - 1));
    }
    const day = schedule({ tasks, dependencies: deps, calendar: HOLIDAY });
    const hour = schedule({
      tasks: tasksToHours(tasks, HOLIDAY),
      dependencies: dependenciesToHours(deps, HOLIDAY),
      calendar: HOLIDAY,
      durationUnit: H,
    });
    const strip = (t: ScheduleTask) => [t.id, t.startDate, t.endDate, t.durationDays];
    expect(tasksToDays(hour.tasks, HOLIDAY).map(strip)).toEqual(day.tasks.map(strip));
  });
});
