/**
 * Calculations audit 2026-10 — the shared rules the API and the web demo both use.
 * Each block reproduces the audit's input and asserts the expected output.
 */
import { describe, expect, it } from 'vitest';
import {
  WorkCalendar,
  applyScheduleEdit,
  coerceEndLocal,
  deadlinePassed,
  dependenciesToDays,
  deriveGroupStatus,
  dueDayOf,
  dueFlags,
  elapsedToWorkingMinutes,
  normalizeLeaf,
  normalizeStatusProgress,
  progressWeight,
  rollUp,
  rollUpStatus,
  roundHalfAway,
  syncStatusProgress,
  weightedProgress,
  type ScheduleTask,
  type WorkStatus,
} from './index';

const cal = new WorkCalendar({});

describe('H1 — status ↔ progress', () => {
  it('leaf invariant: DONE ⇒ 100, 100 ⇒ DONE, NOT_STARTED with progress ⇒ IN_PROGRESS', () => {
    expect(normalizeStatusProgress('DONE', 30)).toEqual({ status: 'DONE', progress: 100 });
    expect(normalizeStatusProgress('IN_PROGRESS', 100)).toEqual({ status: 'DONE', progress: 100 });
    expect(normalizeStatusProgress('ON_HOLD', 100)).toEqual({ status: 'DONE', progress: 100 });
    expect(normalizeStatusProgress('NOT_STARTED', 10)).toEqual({ status: 'IN_PROGRESS', progress: 10 });
    expect(normalizeStatusProgress('ON_HOLD', 40)).toEqual({ status: 'ON_HOLD', progress: 40 });
    expect(normalizeStatusProgress('IN_PROGRESS', 0)).toEqual({ status: 'IN_PROGRESS', progress: 0 });
  });

  it('edit sync: the field that was changed decides', () => {
    // A board move to «منجزة» sends only the status (audit: card DONE at 30 %).
    expect(syncStatusProgress({ status: 'IN_PROGRESS', progress: 30 }, { status: 'DONE' })).toEqual({ status: 'DONE', progress: 100 });
    // Progress set to 100 (audit: 100 % IN_PROGRESS counted overdue).
    expect(syncStatusProgress({ status: 'IN_PROGRESS', progress: 30 }, { progress: 100 })).toEqual({ status: 'DONE', progress: 100 });
    // Lowering progress below 100 on a DONE task reopens it.
    expect(syncStatusProgress({ status: 'DONE', progress: 100 }, { progress: 80 })).toEqual({ status: 'IN_PROGRESS', progress: 80 });
    // Progress on a NOT_STARTED task starts it.
    expect(syncStatusProgress({ status: 'NOT_STARTED', progress: 0 }, { progress: 5 })).toEqual({ status: 'IN_PROGRESS', progress: 5 });
    // Status back to NOT_STARTED clears progress; reopening a DONE task clears its 100.
    expect(syncStatusProgress({ status: 'IN_PROGRESS', progress: 40 }, { status: 'NOT_STARTED' })).toEqual({ status: 'NOT_STARTED', progress: 0 });
    expect(syncStatusProgress({ status: 'DONE', progress: 100 }, { status: 'IN_PROGRESS' })).toEqual({ status: 'IN_PROGRESS', progress: 0 });
    expect(syncStatusProgress({ status: 'IN_PROGRESS', progress: 40 }, { status: 'ON_HOLD' })).toEqual({ status: 'ON_HOLD', progress: 40 });
    // Both sent (an undo step): as sent, then the invariant.
    expect(syncStatusProgress({ status: 'DONE', progress: 100 }, { status: 'IN_PROGRESS', progress: 30 })).toEqual({ status: 'IN_PROGRESS', progress: 30 });
    expect(syncStatusProgress({ status: 'NOT_STARTED', progress: 0 }, { status: 'IN_PROGRESS', progress: 100 })).toEqual({ status: 'DONE', progress: 100 });
    // Re-sending the current values changes nothing.
    expect(syncStatusProgress({ status: 'ON_HOLD', progress: 20 }, { status: 'ON_HOLD', progress: 20 })).toEqual({ status: 'ON_HOLD', progress: 20 });
  });

  it('group status is derived from the children', () => {
    const s = (...xs: WorkStatus[]) => xs.map((status) => ({ status }));
    expect(deriveGroupStatus(s('DONE', 'DONE'), 100)).toBe('DONE');
    expect(deriveGroupStatus(s('DONE', 'NOT_STARTED'), 50)).toBe('IN_PROGRESS');
    expect(deriveGroupStatus(s('NOT_STARTED', 'NOT_STARTED'), 0)).toBe('NOT_STARTED');
    expect(deriveGroupStatus(s('ON_HOLD', 'ON_HOLD'), 0)).toBe('ON_HOLD');
    expect(deriveGroupStatus(s('ON_HOLD', 'DONE'), 50)).toBe('IN_PROGRESS');
    expect(deriveGroupStatus(s('ON_HOLD', 'ON_HOLD'), 20)).toBe('IN_PROGRESS');
    expect(deriveGroupStatus(s('ON_HOLD', 'NOT_STARTED'), 0)).toBe('NOT_STARTED');
    expect(deriveGroupStatus(s('ON_HOLD', 'IN_PROGRESS'), 10)).toBe('IN_PROGRESS');
    expect(deriveGroupStatus(s('NOT_STARTED', 'NOT_STARTED'), 0.5)).toBe('IN_PROGRESS');
    expect(deriveGroupStatus([], 0)).toBe('NOT_STARTED');
  });

  it('rollUpStatus: audit repro — a group whose children are DONE becomes DONE (nested, bottom-up)', () => {
    const t = (id: string, parentId: string | null, type: 'TASK' | 'GROUP', status: WorkStatus, progress: number) => ({ id, parentId, type, status, progress });
    const out = rollUpStatus([
      t('root', null, 'GROUP', 'NOT_STARTED', 100),
      t('g', 'root', 'GROUP', 'NOT_STARTED', 100),
      t('a', 'g', 'TASK', 'DONE', 100),
      t('b', 'g', 'TASK', 'IN_PROGRESS', 100), // invariant: 100 ⇒ DONE
      t('c', 'root', 'TASK', 'DONE', 100),
    ]);
    const by = new Map(out.map((x) => [x.id, x]));
    expect(by.get('b')!.status).toBe('DONE');
    expect(by.get('g')!.status).toBe('DONE');
    expect(by.get('root')!.status).toBe('DONE');
  });

  it('rollUpStatus keeps object identity when nothing changes', () => {
    const a = { id: 'a', parentId: null, type: 'TASK' as const, status: 'IN_PROGRESS' as const, progress: 10 };
    expect(rollUpStatus([a])[0]).toBe(a);
  });
});

describe('H2 — a group with no children', () => {
  it('rollUpStatus zeroes progress, status and costs of an empty GROUP (dates untouched)', () => {
    const g = { id: 'g', parentId: null, type: 'GROUP' as const, status: 'IN_PROGRESS' as const, progress: 66.67, plannedCost: 300, actualCost: 150, startDate: '2026-10-18', endDate: '2026-10-20' };
    const [out] = rollUpStatus([g]);
    expect(out).toMatchObject({ progress: 0, status: 'NOT_STARTED', plannedCost: 0, actualCost: 0, startDate: '2026-10-18', endDate: '2026-10-20' });
  });

  it('the engine gives an empty GROUP progress 0 and weight 0 in its parent', () => {
    const tasks: ScheduleTask[] = [
      { id: 'p', parentId: null, sortOrder: 0, type: 'GROUP', startDate: '2026-10-18', endDate: '2026-10-18', durationDays: 1, progress: 0 },
      { id: 'g', parentId: 'p', sortOrder: 1, type: 'GROUP', startDate: '2026-10-18', endDate: '2026-10-22', durationDays: 5, progress: 66.67 },
      { id: 'a', parentId: 'p', sortOrder: 2, type: 'TASK', startDate: '2026-10-18', endDate: '2026-10-18', durationDays: 1, progress: 100 },
    ];
    const out = rollUp(tasks, cal).tasks;
    expect(out.find((t) => t.id === 'g')!.progress).toBe(0);
    expect(out.find((t) => t.id === 'g')!.startDate).toBe('2026-10-18');
    expect(out.find((t) => t.id === 'g')!.durationDays).toBe(5);
    // Only `a` weighs: 100 %, not (5 × 0 + 1 × 100) / 6.
    expect(out.find((t) => t.id === 'p')!.progress).toBe(100);
  });

  it('progressWeight: empty groups and milestones weigh 0', () => {
    expect(progressWeight({ type: 'GROUP', durationDays: 5, progress: 0, isEmptyGroup: true })).toBe(0);
    expect(progressWeight({ type: 'MILESTONE', durationDays: 0, progress: 0 })).toBe(0);
    expect(progressWeight({ type: 'GROUP', durationDays: 5, progress: 0 })).toBe(5);
  });
});

describe('M1 — progress weighted by working minutes in HOUR projects', () => {
  it('audit repro: A = 1 h at 100 %, B = 7 h at 0 % on the same day → 12.5, like the engine', () => {
    const roots = [
      { type: 'TASK' as const, durationDays: 1, durationHours: 1, progress: 100 },
      { type: 'TASK' as const, durationDays: 1, durationHours: 7, progress: 0 },
    ];
    expect(weightedProgress(roots, 'HOUR')).toBe(12.5);
    expect(weightedProgress(roots, 'DAY')).toBe(50);
    const eng = rollUp(
      [
        { id: 'g', parentId: null, sortOrder: 0, type: 'GROUP', startDate: '2026-10-18T09:00', endDate: '2026-10-18T09:00', durationDays: 0, progress: 0 },
        { id: 'a', parentId: 'g', sortOrder: 1, type: 'TASK', startDate: '2026-10-18T09:00', endDate: '2026-10-18T10:00', durationDays: 1, durationHours: 1, progress: 100 },
        { id: 'b', parentId: 'g', sortOrder: 2, type: 'TASK', startDate: '2026-10-18T10:00', endDate: '2026-10-18T18:00', durationDays: 1, durationHours: 7, progress: 0 },
      ],
      cal,
      'HOUR',
    );
    expect(eng.tasks[0]!.progress).toBe(weightedProgress(roots, 'HOUR'));
  });

  it('plain average when every weight is 0; 0 for nothing', () => {
    expect(weightedProgress([{ type: 'MILESTONE', durationDays: 0, progress: 100 }, { type: 'MILESTONE', durationDays: 0, progress: 0 }])).toBe(50);
    expect(weightedProgress([])).toBe(0);
  });
});

describe('M2/M3 — canonical HOUR edit rules', () => {
  const ht: ScheduleTask = { id: 'h', parentId: null, sortOrder: 0, type: 'TASK', startDate: '2026-10-18T09:00', endDate: '2026-10-18T13:00', durationDays: 1, durationHours: 4, progress: 0 };
  it.each([
    [{ endDate: '2026-10-20' }, '2026-10-20T18:00', 24],
    [{ endDate: '2026-10-20T13:00' }, '2026-10-20T13:00', 20],
    [{ endDate: '2026-10-20', durationDays: 1 }, '2026-10-18T18:00', 8],
    [{ durationDays: 1.5 }, '2026-10-18T18:00', 8],
    [{ durationHours: 2, durationDays: 3, endDate: '2026-10-22' }, '2026-10-18T11:00', 2],
  ])('edit %j → end %s, %d h', (edit, end, hours) => {
    const out = applyScheduleEdit(ht, edit, cal, 'HOUR');
    expect(out.endDate).toBe(end);
    expect(out.durationHours).toBe(hours);
  });

  it('a bare end date is the end of that day’s working time', () => {
    expect(coerceEndLocal('2026-10-20', cal)).toBe('2026-10-20T18:00');
  });

  it('a full reschedule snaps an HOUR start out of non-working time even with snapStart = false', () => {
    expect(normalizeLeaf({ ...ht, startDate: '2026-10-23T10:00' }, cal, false, 'HOUR').startDate).toBe('2026-10-25T09:00');
  });
});

describe('L6 — due day = the day of the last working minute (24:00 included)', () => {
  const night = new WorkCalendar({ workingHours: [{ start: '16:00', end: '24:00' }] });
  it('audit repro: 16:00–24:00, 8 h from Thu 22nd ends 23rd 00:00 but is due the 22nd', () => {
    const n = normalizeLeaf({ id: 'n', parentId: null, sortOrder: 0, type: 'TASK', startDate: '2026-10-22T16:00', endDate: '2026-10-22T16:00', durationDays: 1, durationHours: 8, progress: 0 }, night, true, 'HOUR');
    expect(n.endDate).toBe('2026-10-23T00:00');
    expect(dueDayOf(n)).toBe('2026-10-22');
    // On the 23rd it is overdue, like the cron (DATE column = 22nd).
    expect(dueFlags({ ...n, status: 'IN_PROGRESS' }, '2026-10-23', night)).toEqual({ overdue: true, dueSoon: false });
  });
  it('DONE is never overdue, due soon or past its deadline', () => {
    expect(dueFlags({ startDate: '2026-10-01', endDate: '2026-10-02', status: 'DONE' }, '2026-10-19', cal)).toEqual({ overdue: false, dueSoon: false });
    expect(deadlinePassed({ deadline: '2026-10-01', status: 'DONE' }, '2026-10-19')).toBe(false);
    expect(deadlinePassed({ deadline: '2026-10-01', status: 'IN_PROGRESS' }, '2026-10-19')).toBe(true);
  });
});

describe('L7 — symmetric lag rounding', () => {
  it('±4 h on an 8-hour day → ±1 d', () => {
    const deps = dependenciesToDays(
      [
        { predecessorId: 'a', successorId: 'b', type: 'FS' as const, lagDays: 0, lagHours: 4 },
        { predecessorId: 'a', successorId: 'c', type: 'FS' as const, lagDays: 0, lagHours: -4 },
        { predecessorId: 'a', successorId: 'd', type: 'FS' as const, lagDays: 0, lagHours: -3 },
      ],
      cal,
    );
    expect(deps.map((d) => d.lagDays)).toEqual([1, -1, 0]);
    expect(Object.is(deps[2]!.lagDays, -0)).toBe(false);
  });
  it('roundHalfAway', () => {
    expect([0.5, -0.5, 1.49, -1.5, -0.2, 2.5].map(roundHalfAway)).toEqual([1, -1, 1, -2, 0, 3]);
  });
});

describe('L8 — elapsed spans become working minutes on the calendar', () => {
  it('1 elapsed day from Thursday 18:00 = 0 working minutes (Fri/Sat weekend); 3 elapsed days = 1 day', () => {
    expect(elapsedToWorkingMinutes(cal, '2026-10-22T18:00', 1440)).toBe(0);
    expect(elapsedToWorkingMinutes(cal, '2026-10-22T18:00', 3 * 1440)).toBe(480);
    expect(elapsedToWorkingMinutes(cal, '2026-10-19T00:00', 1440)).toBe(480);
    expect(elapsedToWorkingMinutes(cal, '2026-10-20T00:00', -1440)).toBe(-480);
  });
});
