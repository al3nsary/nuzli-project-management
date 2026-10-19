/**
 * Calculations audit 2026-10 (docs/calculations-audit-2026-10.md): every server-side finding is
 * reproduced with the audit's own input and checked against the expected output.
 */
import { WorkCalendar } from '@nuzli/scheduling';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task } from '../../test/unit/fake-project-db';
import { ProjectStore } from './project-store';
import { BY_LABEL_OVERLAP_NOTE, buildBudgetReport, buildDashboard, buildPeople, computeWorkload, plannedByWeek } from './reports';
import {
  applyScheduleEdit,
  dueFlags,
  normalizeLeaf,
  projectProgress,
  recompute,
  rootsForProgress,
  type StoredTask,
} from './task-engine';
import { TasksService } from './tasks.service';
import { portfolioTotals } from './templates.service';

const cal = new WorkCalendar({});
const base: Omit<StoredTask, 'id' | 'parentId' | 'type' | 'startDate' | 'endDate' | 'durationDays' | 'progress'> = {
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
};
const st = (o: Partial<StoredTask> & Pick<StoredTask, 'id'>): StoredTask => ({
  ...base,
  parentId: null,
  type: 'TASK',
  startDate: '2026-10-18',
  endDate: '2026-10-18',
  durationDays: 1,
  progress: 0,
  ...o,
});

describe('H1 — group status derived; status ↔ progress on leaves (pure)', () => {
  it('par.ts: a group whose children are both DONE at 100 % is DONE (was NOT_STARTED)', () => {
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

  it('a leaf at 100 % IN_PROGRESS becomes DONE and is no longer overdue', () => {
    const [t] = recompute({ tasks: [st({ id: 'a', progress: 100, status: 'IN_PROGRESS', endDate: '2026-10-01', startDate: '2026-10-01' })], dependencies: [], calendar: cal, autoSchedule: false });
    expect(t).toMatchObject({ status: 'DONE', progress: 100 });
    expect(dueFlags(t!, '2026-10-19', cal).overdue).toBe(false);
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
    // c is at 0 % and g (empty) weighs nothing → 0, not 50.
    expect(projectProgress(rootsForProgress(after))).toBe(0);
  });

  it('an empty group weighs 0 next to real work', () => {
    const roots = rootsForProgress([st({ id: 'g', type: 'GROUP', durationDays: 5 }), st({ id: 'c', progress: 100, status: 'DONE' })]);
    expect(projectProgress(roots)).toBe(100);
  });
});

describe('M1 — HOUR projects weigh progress by working minutes', () => {
  it('roots A = 1 h at 100 %, B = 7 h at 0 % → 12.5 (was 50), like the engine and the people tab', () => {
    const a = st({ id: 'a', startDate: '2026-10-18T09:00', endDate: '2026-10-18T10:00', durationHours: 1, progress: 100, status: 'DONE', assigneeId: 'u' });
    const b = st({ id: 'b', startDate: '2026-10-18T10:00', endDate: '2026-10-18T18:00', durationHours: 7, assigneeId: 'u' });
    expect(projectProgress([a, b])).toBe(12.5);
    expect(projectProgress([a, b], 'HOUR')).toBe(12.5);
    const people = buildPeople({ tasks: [a, b], cal, today: '2026-10-18', people: new Map(), loggedByUser: new Map() });
    expect(people[0]!.progress).toBe(12.5);
  });
});

describe('M2/M3 — canonical HOUR edit rules (shared with the demo)', () => {
  const ht = st({ id: 'h', startDate: '2026-10-18T09:00', endDate: '2026-10-18T13:00', durationHours: 4 });
  it.each([
    [{ endDate: '2026-10-20' }, '2026-10-20T18:00', 24],
    [{ endDate: '2026-10-20T13:00' }, '2026-10-20T13:00', 20],
    [{ endDate: '2026-10-20', durationDays: 1 }, '2026-10-18T18:00', 8],
    [{ durationDays: 1.5 }, '2026-10-18T18:00', 8],
  ])('%j → %s (%d h)', (edit, end, hours) => {
    expect(applyScheduleEdit(ht, edit, cal, 'HOUR')).toMatchObject({ endDate: end, durationHours: hours });
  });
  it('a full reschedule snaps an HOUR start on Friday 10:00 to Sunday 09:00', () => {
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
  });
  it('plannedByWeek spreads over the 22nd only', () => {
    const w = plannedByWeek([{ ...n, plannedCost: 100 }], night);
    expect(w).toEqual([{ weekStart: '2026-10-18', planned: 100, cumulative: 100 }]);
  });
});

describe('L11 — label budgets overlap', () => {
  it('flags overlap with an Arabic note when a task has two labels', () => {
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
  it('totalCapacityMinutes sums the real per-day capacity', () => {
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

// ─────────────────────────────────────────── service level (fake DB)

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const P = '00000000-0000-4000-8000-0000000000a1';
const G = 'f0000000-0000-4000-8000-00000000000f';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';

function setup() {
  const fake = createFakeDb({
    users: [{ id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' }],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [] }],
    projects: [{ id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' }],
    tasks: [
      task({ id: G, projectId: P, type: 'GROUP', sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-14'), durationDays: 4, plannedCost: 300, actualCost: 150 }),
      task({ id: A, projectId: P, parentId: G, sortOrder: 1, wbsCache: '1.1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, plannedCost: 100, actualCost: 150, progress: 30, status: 'IN_PROGRESS' }),
      task({ id: B, projectId: P, parentId: G, sortOrder: 2, wbsCache: '1.2', startDate: d('2026-10-13'), endDate: d('2026-10-14'), durationDays: 2, plannedCost: 200 }),
    ],
    deps: [],
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const service = new TasksService(fake.db as never, store, audit, fake.notifications as never);
  return { fake, service, row: (id: string) => fake.data.tasks.find((t) => t.id === id)! };
}

describe('H1/H2 through the write path', () => {
  it('a board move to DONE sets progress 100; the group follows', async () => {
    const { service, row } = setup();
    await service.update(A, { version: 0, status: 'DONE' }, ADMIN, ctx);
    expect(row(A)).toMatchObject({ status: 'DONE', progress: 100 });
    expect(row(G)).toMatchObject({ status: 'IN_PROGRESS', progress: 50 });
    await service.update(B, { version: 0, progress: 100 }, ADMIN, ctx);
    expect(row(B)).toMatchObject({ status: 'DONE', progress: 100 });
    expect(row(G)).toMatchObject({ status: 'DONE', progress: 100 });
  });

  it('lowering progress on a DONE task reopens it (batch, as an undo step would)', async () => {
    const { service, row } = setup();
    await service.update(A, { version: 0, progress: 100 }, ADMIN, ctx);
    await service.batch(P, { changes: [{ id: A, version: 1, progress: 60 }] }, ADMIN, ctx);
    expect(row(A)).toMatchObject({ status: 'IN_PROGRESS', progress: 60 });
  });

  it("a group's status cannot be edited (TASK_GROUP_STATUS_DERIVED); re-sending it unchanged is fine", async () => {
    const { service } = setup();
    const err = await service.update(G, { version: 0, status: 'DONE' }, ADMIN, ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TASK_GROUP_STATUS_DERIVED');
    await expect(service.update(G, { version: 0, status: 'NOT_STARTED', name: 'مرحلة' }, ADMIN, ctx)).resolves.toBeDefined();
  });

  it('bulk status on a selection skips groups and syncs leaves', async () => {
    const { service, row } = setup();
    await service.bulk(P, { ids: [G, A], versions: { [G]: 0, [A]: 0 }, patch: { status: 'DONE' } }, ADMIN, ctx);
    expect(row(A)).toMatchObject({ status: 'DONE', progress: 100 });
    expect(row(G).status).toBe('IN_PROGRESS');
  });

  it('archiving every child zeroes the group (cost, progress, status) and keeps its dates', async () => {
    const { service, row } = setup();
    await service.bulkArchive(P, { ids: [A, B], versions: { [A]: 0, [B]: 0 } }, ADMIN, ctx);
    expect(row(G)).toMatchObject({ type: 'GROUP', plannedCost: 0, actualCost: 0, progress: 0, status: 'NOT_STARTED' });
    expect(row(G).startDate).toEqual(d('2026-10-11'));
  });
});

describe('L10 — reminders re-armed only when the due DAY moves', () => {
  it('an HOUR edit that changes only the time on the same day keeps the reminder flags', async () => {
    const fake = createFakeDb({
      users: [{ id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' }],
      calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [] }],
      projects: [{ id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', durationUnit: 'HOUR' } as never],
      tasks: [
        task({
          id: A,
          projectId: P,
          startDate: d('2026-10-18'),
          endDate: d('2026-10-18'),
          startAt: new Date('2026-10-18T06:00:00Z'),
          endAt: new Date('2026-10-18T10:00:00Z'),
          durationMinutes: 240,
          dueSoonNotifiedAt: new Date('2026-10-18T04:00:00Z'),
        }),
      ],
      deps: [],
    });
    const audit = new AuditService(fake.db as never);
    const store = new ProjectStore(fake.db as never, audit);
    const service = new TasksService(fake.db as never, store, audit, fake.notifications as never);
    await service.update(A, { version: 0, durationHours: 6 }, ADMIN, ctx);
    const row = fake.data.tasks.find((t) => t.id === A)!;
    expect(row.durationMinutes).toBe(360);
    expect(row.dueSoonNotifiedAt).not.toBeNull();
    await service.update(A, { version: 1, durationHours: 16 }, ADMIN, ctx);
    expect(fake.data.tasks.find((t) => t.id === A)!.dueSoonNotifiedAt).toBeNull();
  });
});
