/**
 * Calculations audit 2026-10 (docs/calculations-audit-2026-10.md), web port: the auditor's
 * reproduction scripts (par.ts, stale.ts, night.ts, bb.ts) and the API's calc-audit.spec cases run
 * against the demo engine and reports, which now import the shared rules — each finding has a test.
 */
import { describe, expect, it } from 'vitest';
import { WorkCalendar, rollUp } from '@nuzli/scheduling';
import { calendarDaysOverdue, isEditWindowOpen, perMemberRate, weekChangePct } from '@nuzli/shared';
import {
  applyScheduleEdit,
  dueFlags,
  normalizeLeaf,
  projectProgress,
  recompute,
  rootsForProgress,
  type StoredTask,
} from './engine';
import { BY_LABEL_OVERLAP_NOTE, buildBudgetReport, buildDashboard, buildPeople, computeWorkload, plannedByWeek, portfolioTotals } from './reports';
import { matchesFilter, parseBbox } from '../violations/stats';
import { overdueDays } from '../gantt/Gantt';
import { withStatusSync } from './statusSync';
import type { GanttDto, TaskDto } from '@nuzli/shared';

const cal = new WorkCalendar({});
const st = (o: Partial<StoredTask> & Pick<StoredTask, 'id'>): StoredTask => ({
  projectId: 'p',
  sortOrder: 1,
  wbsCache: '',
  name: 'x',
  status: 'NOT_STARTED',
  priority: 'MEDIUM',
  assigneeId: null,
  description: null,
  version: 1,
  plannedCost: 0,
  actualCost: 0,
  deadline: null,
  barColor: null,
  labelIds: [],
  parentId: null,
  type: 'TASK',
  startDate: '2026-10-18',
  endDate: '2026-10-18',
  durationDays: 1,
  progress: 0,
  ...o,
});

describe('H1 — group status derived; status ↔ progress on leaves (par.ts)', () => {
  it('a group whose children are both DONE at 100 % is DONE (was NOT_STARTED)', () => {
    const out = recompute({
      tasks: [
        st({ id: 'g', type: 'GROUP', status: 'NOT_STARTED' }),
        st({ id: 'a', parentId: 'g', endDate: '2026-10-19', durationDays: 2, progress: 100, status: 'DONE' }),
        st({ id: 'b', parentId: 'g', sortOrder: 2, startDate: '2026-10-20', endDate: '2026-10-20', progress: 100, status: 'DONE' }),
      ],
      dependencies: [],
      calendar: cal,
      autoSchedule: true,
    });
    expect(out.find((t) => t.id === 'g')).toMatchObject({ progress: 100, status: 'DONE' });
  });

  it('nested groups derive bottom-up; ON_HOLD only when nothing is done', () => {
    const out = recompute({
      tasks: [
        st({ id: 'g', type: 'GROUP' }),
        st({ id: 'h', parentId: 'g', type: 'GROUP' }),
        st({ id: 'a', parentId: 'h', status: 'ON_HOLD' }),
        st({ id: 'b', parentId: 'g', sortOrder: 2, status: 'ON_HOLD' }),
      ],
      dependencies: [],
      calendar: cal,
      autoSchedule: false,
    });
    expect(out.find((t) => t.id === 'h')!.status).toBe('ON_HOLD');
    expect(out.find((t) => t.id === 'g')!.status).toBe('ON_HOLD');
  });

  it('a leaf at 100 % IN_PROGRESS becomes DONE and is no longer overdue', () => {
    const [t] = recompute({ tasks: [st({ id: 'a', progress: 100, status: 'IN_PROGRESS', endDate: '2026-10-01', startDate: '2026-10-01' })], dependencies: [], calendar: cal, autoSchedule: false });
    expect(t).toMatchObject({ status: 'DONE', progress: 100 });
    expect(dueFlags(t!, '2026-10-19', cal).overdue).toBe(false);
  });

  it('the optimistic grid/board/drawer value follows the same rule; groups are never touched', () => {
    const task = (o: Partial<TaskDto>) => ({ id: 'a', parentId: null, type: 'TASK', status: 'IN_PROGRESS', progress: 30, ...o }) as TaskDto;
    const g = { tasks: [task({}), task({ id: 'g', type: 'GROUP' }), task({ id: 'c', parentId: 'g' })] } as GanttDto;
    expect(withStatusSync(g, 'a', { status: 'DONE' })!.tasks[0]).toMatchObject({ status: 'DONE', progress: 100 });
    expect(withStatusSync(g, 'a', { progress: 100 })!.tasks[0]).toMatchObject({ status: 'DONE', progress: 100 });
    expect(withStatusSync(g, 'a', { status: 'NOT_STARTED' })!.tasks[0]).toMatchObject({ status: 'NOT_STARTED', progress: 0 });
    expect(withStatusSync(g, 'g', { status: 'DONE' })).toBeNull();
    // An undo step sends both fields: taken as sent.
    const done = { tasks: [task({ status: 'DONE', progress: 100 })] } as GanttDto;
    expect(withStatusSync(done, 'a', { status: 'IN_PROGRESS', progress: 30 })!.tasks[0]).toMatchObject({ status: 'IN_PROGRESS', progress: 30 });
  });
});

describe('H2 — a group left without children (stale.ts)', () => {
  const tasks = () =>
    recompute({
      tasks: [
        st({ id: 'g', type: 'GROUP', status: 'IN_PROGRESS' }),
        st({ id: 'a', parentId: 'g', endDate: '2026-10-19', durationDays: 2, progress: 100, status: 'DONE', plannedCost: 100, actualCost: 150 }),
        st({ id: 'b', parentId: 'g', sortOrder: 2, startDate: '2026-10-20', endDate: '2026-10-20', plannedCost: 200, status: 'IN_PROGRESS' }),
        st({ id: 'c', sortOrder: 2, startDate: '2026-10-20', endDate: '2026-10-20', plannedCost: 50, status: 'IN_PROGRESS' }),
      ],
      dependencies: [],
      calendar: cal,
      autoSchedule: true,
    });

  it('archiving a and b leaves g at 0 / 0 / 0 %, NOT_STARTED, dates kept; reports agree', () => {
    const before = tasks().find((t) => t.id === 'g')!;
    expect(before).toMatchObject({ plannedCost: 300, actualCost: 150 });
    const after = recompute({ tasks: tasks().filter((t) => t.id !== 'a' && t.id !== 'b'), dependencies: [], calendar: cal, autoSchedule: true, changed: [] });
    const g = after.find((t) => t.id === 'g')!;
    expect(g).toMatchObject({ type: 'GROUP', plannedCost: 0, actualCost: 0, progress: 0, status: 'NOT_STARTED', startDate: before.startDate, endDate: before.endDate });
    const rep = buildBudgetReport({ projectId: 'p', currency: 'SAR', budget: 1000, tasks: after, labels: [], users: new Map(), loggedByUser: new Map() });
    expect([rep.plannedCost, rep.actualCost]).toEqual([50, 0]);
    expect(rep.byAssignee.reduce((s, x) => s + x.taskCount, 0)).toBe(1);
    const people = buildPeople({ tasks: after, cal, today: '2026-10-19', people: new Map(), loggedByUser: new Map() });
    expect(people.reduce((s, p) => s + p.plannedCost, 0)).toBe(50);
    expect(projectProgress(rootsForProgress(after))).toBe(0);
  });

  it('an empty group weighs 0 next to real work', () => {
    const roots = rootsForProgress([st({ id: 'g', type: 'GROUP', durationDays: 5 }), st({ id: 'c', progress: 100, status: 'DONE' })]);
    expect(projectProgress(roots)).toBe(100);
  });
});

describe('M1 — HOUR projects weigh progress by working minutes (par.ts)', () => {
  it('roots A = 1 h at 100 %, B = 7 h at 0 % → 12.5 (was 50), like the engine and the people tab', () => {
    const a = st({ id: 'a', startDate: '2026-10-18T09:00', endDate: '2026-10-18T10:00', durationHours: 1, progress: 100, status: 'DONE', assigneeId: 'u' });
    const b = st({ id: 'b', startDate: '2026-10-18T10:00', endDate: '2026-10-18T18:00', durationHours: 7, assigneeId: 'u' });
    expect(projectProgress([a, b])).toBe(12.5);
    expect(projectProgress([a, b], 'HOUR')).toBe(12.5);
    const eng = rollUp(
      [
        { id: 'g', parentId: null, sortOrder: 0, type: 'GROUP', startDate: '2026-10-18T09:00', endDate: '2026-10-18T09:00', durationDays: 0, progress: 0 },
        { ...a, parentId: 'g' },
        { ...b, parentId: 'g' },
      ],
      cal,
      'HOUR',
    );
    expect(eng.tasks[0]!.progress).toBe(12.5);
    const people = buildPeople({ tasks: [a, b], cal, today: '2026-10-18', people: new Map(), loggedByUser: new Map() });
    expect(people[0]!.progress).toBe(12.5);
  });
});

describe('M2/M3 — HOUR edit rules are the API\'s (par.ts parity table)', () => {
  const ht = st({ id: 'h', startDate: '2026-10-18T09:00', endDate: '2026-10-18T13:00', durationHours: 4 });
  it.each([
    [{ endDate: '2026-10-20' }, '2026-10-20T18:00', 24],
    [{ endDate: '2026-10-20T13:00' }, '2026-10-20T13:00', 20],
    [{ endDate: '2026-10-20', durationDays: 1 }, '2026-10-18T18:00', 8],
    [{ durationDays: 1.5 }, '2026-10-18T18:00', 8],
  ])('%j → %s (%d h)', (edit, end, hours) => {
    expect(applyScheduleEdit(ht, edit, cal, 'HOUR')).toMatchObject({ endDate: end, durationHours: hours });
  });
  it('a full reschedule snaps an HOUR start on Friday 10:00 to Sunday 09:00 (was kept on Friday)', () => {
    expect(normalizeLeaf({ ...ht, startDate: '2026-10-23T10:00' }, cal, false, 'HOUR').startDate).toBe('2026-10-25T09:00');
  });
});

describe('L6 — 24:00 calendars: due day = the day of the last working minute (night.ts)', () => {
  const night = new WorkCalendar({ workingHours: [{ start: '16:00', end: '24:00' }] });
  const n = normalizeLeaf(st({ id: 'n', startDate: '2026-10-22T16:00', durationHours: 8, status: 'IN_PROGRESS' }), night, true, 'HOUR');
  it('ends 23rd 00:00, overdue on the 23rd (same as the cron), days overdue counted from the 22nd', () => {
    expect(n.endDate).toBe('2026-10-23T00:00');
    expect(dueFlags(n, '2026-10-23', night)).toEqual({ overdue: true, dueSoon: false });
    const dash = buildDashboard({ tasks: [n], cal: night, today: '2026-10-25', budget: null, people: new Map(), loggedMinutes: 0 });
    expect(dash.overdue[0]!.daysOverdue).toBe(3);
    const up = buildDashboard({ tasks: [n], cal: night, today: '2026-10-22', budget: null, people: new Map(), loggedMinutes: 0 });
    expect(up.upcoming.find((u) => u.kind === 'END')!.date).toBe('2026-10-22');
    // The Gantt bar shows the same number of calendar days as the dashboard (L1).
    expect(overdueDays({ ...n, type: 'TASK' }, '2026-10-25')).toBe(3);
    expect(calendarDaysOverdue('2026-10-22', '2026-10-25')).toBe(3);
  });
  it('plannedByWeek spreads over the 22nd only', () => {
    expect(plannedByWeek([{ ...n, plannedCost: 100 }], night)).toEqual([{ weekStart: '2026-10-18', planned: 100, cumulative: 100 }]);
  });
  it('a DONE task never shows overdue on the Gantt', () => {
    expect(overdueDays({ ...n, type: 'TASK', status: 'DONE' }, '2026-10-25')).toBe(0);
  });
});

describe('L11 — label budgets overlap', () => {
  it('flags overlap with the Arabic note when a task has two labels', () => {
    const labels = [
      { id: 'L1', projectId: 'p', name: 'أ', color: '#111111' },
      { id: 'L2', projectId: 'p', name: 'ب', color: '#222222' },
    ];
    const two = buildBudgetReport({ projectId: 'p', currency: 'SAR', budget: null, tasks: [st({ id: 'a', plannedCost: 10, labelIds: ['L1', 'L2'] })], labels: labels as never, users: new Map(), loggedByUser: new Map() });
    expect(two).toMatchObject({ byLabelOverlapping: true, byLabelNote: BY_LABEL_OVERLAP_NOTE });
    expect(two.byLabel.reduce((s, x) => s + x.plannedCost, 0)).toBe(20);
    const one = buildBudgetReport({ projectId: 'p', currency: 'SAR', budget: null, tasks: [st({ id: 'a', plannedCost: 10, labelIds: ['L1'] })], labels: labels as never, users: new Map(), loggedByUser: new Map() });
    expect(one).toMatchObject({ byLabelOverlapping: false, byLabelNote: null });
  });
});

describe('M4 — workload capacity per day (holidays, short days)', () => {
  it('days[].capacityMinutes and totalCapacityMinutes follow the capacity calendar', () => {
    const capacity = new WorkCalendar({
      exceptions: [
        { date: '2026-10-19', isWorking: false },
        { date: '2026-10-20', isWorking: true, workingHours: [{ start: '09:00', end: '12:00' }] },
      ],
    });
    const w = computeWorkload({ from: '2026-10-18', to: '2026-10-24', users: [{ id: 'u', fullName: 'س' }], tasks: [], entries: [], capacity });
    const p = w.people[0]!;
    expect(p.days.map((x) => x.capacityMinutes)).toEqual([480, 0, 180, 480, 480, 0, 0]);
    expect(p.totalCapacityMinutes).toBe(480 * 3 + 180);
    expect(w.capacityMinutesPerDay).toBe(480);
  });
});

describe('portfolio progress — weighted by duration like a project', () => {
  it('a long project weighs more than a short one with many leaves', () => {
    const proj = (progress: number) => ({ progress, budget: null, plannedCost: 0, actualCost: 0, startDate: '2026-10-01', endDate: '2026-10-30', status: 'ACTIVE' }) as never;
    const t = portfolioTotals([
      { project: proj(100), leafCount: 50, overdueCount: 0, progressWeightDays: 2 },
      { project: proj(0), leafCount: 1, overdueCount: 0, progressWeightDays: 18 },
    ]);
    expect(t.progress).toBe(10);
  });
});

describe('L4 — bbox with south > north (bb.ts)', () => {
  it('is normalised like the API, so the point at 24.7 matches', () => {
    expect(parseBbox('25,46,24,47')).toEqual({ south: 24, west: 46, north: 25, east: 47 });
    const v = { id: '1', capturedAt: '2026-10-19T08:00:00Z', teamId: null, memberId: 'm', recordedById: 'u', typeId: 't', severity: null, status: 'SUBMITTED', latitude: 24.7, longitude: 46.7 };
    expect(matchesFilter(v as never, { bbox: '25,46,24,47' } as never)).toBe(true);
  });
});

describe('L13 and the design decisions (shared helpers)', () => {
  it('the edit window is closed at exactly editableUntil', () => {
    const until = '2026-10-19T10:00:00.000Z';
    expect(isEditWindowOpen(Date.parse(until) - 1, until)).toBe(true);
    expect(isEditWindowOpen(until, until)).toBe(false);
  });
  it('week change vs the same elapsed span; per-member rate null without members', () => {
    expect(weekChangePct(6, 4)).toBe(50);
    expect(weekChangePct(3, 0)).toBeNull();
    expect(perMemberRate(5, 0)).toBeNull();
    expect(perMemberRate(5, 2)).toBe(2.5);
  });
});
