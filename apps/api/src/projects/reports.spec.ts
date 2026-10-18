import { WorkCalendar } from '@nuzli/scheduling';
import type { ProjectDto } from '@nuzli/shared';
import { buildBudgetReport, buildDashboard, buildPeople, computeWorkload, plannedByWeek, rangeProblem, WORKDAY_MINUTES } from './reports';
import { recompute, type StoredTask } from './task-engine';
import { portfolioTotals, rebaseTasks, workingOffset } from './templates.service';

const cal = new WorkCalendar({ weekendDays: [5, 6], exceptions: [{ date: '2026-10-20', isWorking: false }] });

function t(id: string, over: Partial<StoredTask> = {}): StoredTask {
  return {
    id,
    projectId: 'p',
    parentId: null,
    sortOrder: 1,
    wbsCache: '',
    name: id,
    type: 'TASK',
    startDate: '2026-10-11',
    endDate: '2026-10-11',
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeId: null,
    description: null,
    version: 0,
    plannedCost: 0,
    actualCost: 0,
    deadline: null,
    barColor: null,
    labelIds: [],
    ...over,
  };
}

/** g1 { a (sup1, L1, 100/120), b (sup2, L1+L2, 50.10/20) }, c root (unassigned, 0.2/0.1). */
function project(): StoredTask[] {
  return recompute({
    tasks: [
      t('g1', { type: 'GROUP', sortOrder: 1 }),
      t('a', { parentId: 'g1', sortOrder: 1, assigneeId: 'sup1', labelIds: ['L1'], plannedCost: 100, actualCost: 120, startDate: '2026-10-11', durationDays: 2, endDate: '2026-10-12', status: 'DONE' }),
      t('b', { parentId: 'g1', sortOrder: 2, assigneeId: 'sup2', labelIds: ['L1', 'L2'], plannedCost: 50.1, actualCost: 20, startDate: '2026-10-13', durationDays: 2, endDate: '2026-10-14' }),
      t('c', { sortOrder: 2, plannedCost: 0.2, actualCost: 0.1, startDate: '2026-10-15', endDate: '2026-10-15', deadline: '2026-10-13' }),
    ],
    dependencies: [],
    calendar: cal,
    autoSchedule: true,
  });
}

describe('A9 budget roll-up (recompute)', () => {
  it('groups hold the exact cent sums of their children', () => {
    const g = project().find((x) => x.id === 'g1')!;
    expect(g).toMatchObject({ plannedCost: 150.1, actualCost: 140 });
  });

  it('nested groups roll up recursively and 0.1 + 0.2 stays 0.3', () => {
    const out = recompute({
      tasks: [t('top', { type: 'GROUP' }), t('mid', { type: 'GROUP', parentId: 'top' }), t('x', { parentId: 'mid', plannedCost: 0.1 }), t('y', { parentId: 'mid', sortOrder: 2, plannedCost: 0.2 })],
      dependencies: [],
      calendar: cal,
      autoSchedule: true,
    });
    expect(out.find((x) => x.id === 'top')!.plannedCost).toBe(0.3);
  });
});

describe('A9 budget report', () => {
  const users = new Map([
    ['sup1', { id: 'sup1', fullName: 'أحمد' }],
    ['sup2', { id: 'sup2', fullName: 'بدر' }],
  ]);
  const labels = [
    { id: 'L1', projectId: 'p', name: 'كهرباء', color: '#303F9F' },
    { id: 'L2', projectId: 'p', name: 'سباكة', color: '#00897B' },
  ];

  it('totals, variance and % used against the budget; by group, assignee and label; over-budget tasks', () => {
    const r = buildBudgetReport({ projectId: 'p', currency: 'SAR', budget: 125, tasks: project(), labels, users, loggedByUser: new Map([['sup1', 90], ['sup3', 30]]) });
    expect(r).toMatchObject({ plannedCost: 150.3, actualCost: 140.1, variance: 10.2, budget: 125, budgetVariance: -15.1, budgetUsedPct: 112.08, loggedMinutes: 120 });
    expect(r.byGroup.map((g) => [g.taskId, g.plannedCost, g.actualCost])).toEqual([
      ['g1', 150.1, 140],
      ['c', 0.2, 0.1],
    ]);
    expect(r.byAssignee.map((a) => [a.assignee?.id ?? null, a.plannedCost, a.taskCount, a.loggedMinutes])).toEqual([
      ['sup1', 100, 1, 90],
      ['sup2', 50.1, 1, 0],
      [null, 0.2, 1, 0],
      ['sup3', 0, 0, 30],
    ]);
    // b carries both labels and counts under each; c has none.
    expect(r.byLabel.map((l) => [l.label?.id ?? null, l.plannedCost, l.taskCount])).toEqual([
      ['L1', 150.1, 2],
      ['L2', 50.1, 1],
      [null, 0.2, 1],
    ]);
    expect(r.overBudgetTasks).toEqual([{ taskId: 'a', wbs: '1.1', name: 'a', plannedCost: 100, actualCost: 120, overBy: 20 }]);
  });

  it('without a budget the budget figures are null', () => {
    const r = buildBudgetReport({ projectId: 'p', currency: 'SAR', budget: null, tasks: project(), labels, users, loggedByUser: new Map() });
    expect(r).toMatchObject({ budget: null, budgetVariance: null, budgetUsedPct: null });
  });
});

describe('A9 people and dashboard', () => {
  it('per assignee: counts, overdue, progress and share of the planned cost', () => {
    const people = buildPeople({
      tasks: project(),
      cal,
      today: '2026-10-19',
      people: new Map([
        ['sup1', { id: 'sup1', fullName: 'أحمد', teamColor: '#111111', teamName: 'فريق ١' }],
        ['sup2', { id: 'sup2', fullName: 'بدر', teamColor: null, teamName: null }],
      ]),
      loggedByUser: new Map([['sup2', 45]]),
    });
    expect(people.map((p) => [p.assignee?.id ?? null, p.taskCount, p.doneCount, p.overdueCount, p.progress, p.budgetShare, p.loggedMinutes])).toEqual([
      ['sup1', 1, 1, 0, 0, 66.53, 0],
      ['sup2', 1, 0, 1, 0, 33.33, 45],
      [null, 1, 0, 1, 0, 0.13, 0],
    ]);
  });

  it('KPIs, distributions, overdue list, deadlines and the planned-cost curve', () => {
    const dash = buildDashboard({ tasks: project(), cal, today: '2026-10-14', budget: 300, people: new Map(), loggedMinutes: 15 });
    expect(dash.kpis).toMatchObject({ leafCount: 3, done: 1, notStarted: 2, overdue: 0, deadlinePassed: 1, loggedMinutes: 15 });
    expect(dash.statusDistribution).toEqual({ NOT_STARTED: 2, IN_PROGRESS: 0, DONE: 1, ON_HOLD: 0 });
    expect(dash.upcoming.map((u) => [u.taskId, u.kind, u.date])).toEqual([
      ['b', 'END', '2026-10-14'],
      ['c', 'END', '2026-10-15'],
    ]);
    expect(dash.budgetBurn).toMatchObject({ budget: 300, plannedCost: 150.3, actualCost: 140.1, budgetUsedPct: 46.7 });
    expect(dash.budgetBurn.plannedByWeek).toEqual([{ weekStart: '2026-10-11', planned: 150.3, cumulative: 150.3 }]);
  });

  it('the planned-cost curve spreads a task over its working days to the cent', () => {
    // 10.00 over Thu 15, Sun 18, Mon 19 (Fri/Sat off) → 3.34 + 3.33 + 3.33 across two weeks.
    const weeks = plannedByWeek([t('x', { startDate: '2026-10-15', endDate: '2026-10-19', durationDays: 3, plannedCost: 10 })], cal);
    expect(weeks).toEqual([
      { weekStart: '2026-10-11', planned: 3.34, cumulative: 3.34 },
      { weekStart: '2026-10-18', planned: 6.66, cumulative: 10 },
    ]);
  });
});

describe('A9 workload', () => {
  it('each working day of a task is one working day for its assignee; overlaps add up; milestones and days off count 0', () => {
    const w = computeWorkload({
      from: '2026-10-15',
      to: '2026-10-21',
      users: [{ id: 'u1', fullName: 'أحمد' }],
      tasks: [
        { assigneeId: 'u1', type: 'TASK', startDate: '2026-10-14', endDate: '2026-10-19', cal },
        { assigneeId: 'u1', type: 'TASK', startDate: '2026-10-19', endDate: '2026-10-21', cal },
        { assigneeId: 'u1', type: 'MILESTONE', startDate: '2026-10-18', endDate: '2026-10-18', cal },
        { assigneeId: 'other', type: 'TASK', startDate: '2026-10-15', endDate: '2026-10-15', cal },
      ],
      entries: [
        { userId: 'u1', date: '2026-10-19', minutes: 300 },
        { userId: 'u1', date: '2026-10-30', minutes: 60 },
      ],
    });
    const days = Object.fromEntries(w.people[0]!.days.map((x) => [x.date, [x.assignedMinutes / 60, x.taskCount, x.loggedMinutes]]));
    expect(days).toEqual({
      '2026-10-15': [8, 1, 0],
      '2026-10-16': [0, 0, 0],
      '2026-10-17': [0, 0, 0],
      '2026-10-18': [8, 1, 0],
      '2026-10-19': [16, 2, 300],
      '2026-10-20': [0, 0, 0],
      '2026-10-21': [8, 1, 0],
    });
    expect(w.people[0]).toMatchObject({ totalAssignedMinutes: 40 * 60, totalLoggedMinutes: 300 });
    expect(w.capacityMinutesPerDay).toBe(WORKDAY_MINUTES);
  });

  it('ranges are checked', () => {
    expect(rangeProblem('2026-10-10', '2026-10-01')).not.toBeNull();
    expect(rangeProblem('2026-01-01', '2026-12-31', 92)).not.toBeNull();
    expect(rangeProblem('2026-10-01', '2026-10-31')).toBeNull();
  });
});

describe('A9 templates — re-basing', () => {
  it('working-day offsets are signed and snap to working days', () => {
    expect(workingOffset(cal, '2026-10-11', '2026-10-11')).toBe(0);
    expect(workingOffset(cal, '2026-10-11', '2026-10-15')).toBe(4);
    // Fri 16 snaps to Sun 18 (5 working days after Sun 11).
    expect(workingOffset(cal, '2026-10-11', '2026-10-16')).toBe(5);
    expect(workingOffset(cal, '2026-10-15', '2026-10-11')).toBe(-4);
  });

  it('round trip: re-based to a new start keeps working-day offsets and durations; re-based back gives the same dates', () => {
    const source = project();
    const moved = recompute({ tasks: rebaseTasks(source, { start: '2026-10-11', cal }, { start: '2026-11-01', cal }), dependencies: [], calendar: cal, autoSchedule: true });
    expect(moved.find((x) => x.id === 'a')).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-02', durationDays: 2 });
    expect(moved.find((x) => x.id === 'b')).toMatchObject({ startDate: '2026-11-03', endDate: '2026-11-04' });
    expect(moved.find((x) => x.id === 'c')).toMatchObject({ startDate: '2026-11-05', deadline: '2026-11-03' });
    expect(moved.find((x) => x.id === 'g1')).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-04' });
    const back = recompute({ tasks: rebaseTasks(moved, { start: '2026-11-01', cal }, { start: '2026-10-11', cal }), dependencies: [], calendar: cal, autoSchedule: true });
    for (const x of source) expect(back.find((y) => y.id === x.id)).toMatchObject({ startDate: x.startDate, endDate: x.endDate, durationDays: x.durationDays, deadline: x.deadline });
  });

  it('a holiday in the new period stretches the task (durations are working days)', () => {
    const out = rebaseTasks([t('x', { startDate: '2026-10-11', endDate: '2026-10-14', durationDays: 4 })], { start: '2026-10-11', cal }, { start: '2026-10-18', cal });
    // Sun 18, Mon 19, (Tue 20 holiday), Wed 21, Thu 22.
    expect(out[0]).toMatchObject({ startDate: '2026-10-18', endDate: '2026-10-22', durationDays: 4 });
  });
});

describe('A9 portfolio totals', () => {
  const p = (over: Partial<ProjectDto>): ProjectDto => ({
    id: 'x',
    name: 'x',
    description: null,
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    status: 'ACTIVE',
    calendarId: 'c',
    autoSchedule: true,
    owner: { id: 'o', fullName: 'o' },
    progress: 0,
    taskCount: 0,
    createdAt: '2026-10-01T00:00:00Z',
    budget: null,
    plannedCost: 0,
    actualCost: 0,
    ...over,
  });

  it('progress weighted by leaf count, budgets summed when present, date span, overdue and status counts', () => {
    const totals = portfolioTotals([
      { project: p({ progress: 100, budget: 1000, plannedCost: 800, actualCost: 900.5, startDate: '2026-09-01', endDate: '2026-10-10', status: 'COMPLETED' }), leafCount: 1, overdueCount: 0 },
      { project: p({ progress: 40, plannedCost: 200.25, actualCost: 10, startDate: '2026-10-05', endDate: '2026-12-01' }), leafCount: 3, overdueCount: 2 },
    ]);
    expect(totals).toEqual({
      projectCount: 2,
      progress: 55,
      budget: 1000,
      plannedCost: 1000.25,
      actualCost: 910.5,
      startDate: '2026-09-01',
      endDate: '2026-12-01',
      overdueCount: 2,
      byStatus: { COMPLETED: 1, ACTIVE: 1 },
    });
    expect(portfolioTotals([]).budget).toBeNull();
  });
});
