/**
 * A9 hours in the API (ADR-109): HOUR projects scheduled end-to-end through the real services
 * and ProjectStore (lock → engine with durationUnit → persist start_at/end_at/duration_minutes),
 * DAY ↔ HOUR conversion, the create form's calendar, and workload in real working minutes.
 */
import { WorkCalendar } from '@nuzli/scheduling';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task, type FakeData } from '../../test/unit/fake-project-db';
import { ProjectReportsService } from './project-reports.service';
import { ProjectStore, timeColumns } from './project-store';
import { ProjectsService } from './projects.service';
import { computeWorkload } from './reports';
import { instantOf, localOf } from './task-engine';
import { TemplatesService } from './templates.service';
import { TasksService } from './tasks.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const H = '00000000-0000-4000-8000-0000000000c1';
const DP = '00000000-0000-4000-8000-0000000000d2';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const X = 'e0000000-0000-4000-8000-00000000000e';
const Y = 'f0000000-0000-4000-8000-00000000000f';
const M = '10000000-0000-4000-8000-000000000001';

/** An HOUR task row (fake DB) from local wall times. */
function hourTask(id: string, projectId: string, start: string, end: string, minutes: number, over: Record<string, unknown> = {}) {
  const cols = timeColumns({ startDate: start, endDate: end, durationHours: minutes / 60 });
  return task({ id, projectId, ...cols, durationDays: 1, ...over } as never);
}

function setup(over: Partial<FakeData> = {}) {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'sup1', fullName: 'مشرف ١', role: 'SUPERVISOR', status: 'ACTIVE' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], isDefault: true, exceptions: [{ id: 'h', date: d('2026-10-28'), isWorking: false, name: 'عطلة' }] }],
    projects: [
      { id: H, name: 'مشروع بالساعات', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', startDate: d('2026-10-11'), durationUnit: 'HOUR' },
      { id: DP, name: 'مشروع بالأيام', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', startDate: d('2026-10-11') },
    ],
    tasks: [
      // A Sun 09:00–12:00 (3 h); B (4 h) violates "A + 2 h" on purpose: it must be pushed.
      hourTask(A, H, '2026-10-11T09:00', '2026-10-11T12:00', 180, { sortOrder: 1, wbsCache: '1', name: 'تركيب', version: 1 }),
      hourTask(B, H, '2026-10-11T09:00', '2026-10-11T13:00', 240, { sortOrder: 2, wbsCache: '2', name: 'فحص', version: 1 }),
      task({ id: X, projectId: DP, sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, name: 'حفر' }),
      task({ id: Y, projectId: DP, sortOrder: 2, wbsCache: '2', startDate: d('2026-10-14'), endDate: d('2026-10-14'), durationDays: 1, name: 'صب' }),
      task({ id: M, projectId: DP, sortOrder: 3, wbsCache: '3', type: 'MILESTONE', startDate: d('2026-10-15'), endDate: d('2026-10-15'), durationDays: 0, name: 'تسليم' }),
    ],
    deps: [
      { id: 'd1', projectId: H, predecessorId: A, successorId: B, type: 'FS', lagDays: 0, lagMinutes: 120 },
      { id: 'd2', projectId: DP, predecessorId: X, successorId: Y, type: 'FS', lagDays: 1 },
    ],
    ...over,
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const tasks = new TasksService(fake.db as never, store, audit, fake.notifications as never);
  const reports = new ProjectReportsService(fake.db as never, store);
  const templates = new TemplatesService(fake.db as never, store, audit, tasks, reports);
  const projects = new ProjectsService(fake.db as never, store, audit, templates);
  const row = (id: string) => fake.data.tasks.find((t) => t.id === id)!;
  const local = (id: string) => {
    const r = row(id);
    return { start: localOf(r.startAt!), end: localOf(r.endAt!), minutes: r.durationMinutes, startDate: r.startDate.toISOString().slice(0, 10), endDate: r.endDate.toISOString().slice(0, 10) };
  };
  return { fake, store, tasks, projects, reports, row, local };
}

describe('A9 hours — HOUR projects through the write path (ADR-109)', () => {
  it('FS + 2 h over the lunch break: A ends 12:00 → B starts 15:00 and runs into Monday 10:00', async () => {
    const { tasks, local } = setup();
    await tasks.batch(H, { changes: [{ id: A, version: 1, durationHours: 3 }] }, ADMIN, ctx);
    // 12:00–13:00 (1 h) + lunch + 14:00–15:00 (1 h) = 2 working hours of lag.
    expect(local(B)).toEqual({ start: '2026-10-11T15:00', end: '2026-10-12T10:00', minutes: 240, startDate: '2026-10-11', endDate: '2026-10-12' });
  });

  it('FS + 2 h over the weekend: A Thu 14:00–17:00 → B Sun 10:00–15:00 (Fri/Sat skipped)', async () => {
    const { tasks, local, row } = setup();
    const res = await tasks.batch(H, { changes: [{ id: A, version: 1, startDate: '2026-10-15T14:00' }] }, ADMIN, ctx);
    expect(local(A)).toMatchObject({ start: '2026-10-15T14:00', end: '2026-10-15T17:00', minutes: 180 });
    expect(local(B)).toEqual({ start: '2026-10-18T10:00', end: '2026-10-18T15:00', minutes: 240, startDate: '2026-10-18', endDate: '2026-10-18' });
    expect(row(B).durationDays).toBe(1);
    const dto = res.tasks.find((t) => t.id === B)!;
    expect(dto).toMatchObject({ startDate: '2026-10-18T10:00', endDate: '2026-10-18T15:00', startAt: '2026-10-18T10:00', endAt: '2026-10-18T15:00', durationHours: 4 });
    // The undo contract carries the before-values in the HOUR wire format.
    expect(res.previous?.[A]).toMatchObject({ startDate: '2026-10-11T09:00' });
    // The stored instants are Riyadh wall time − 3 h.
    expect(row(B).startAt!.toISOString()).toBe('2026-10-18T07:00:00.000Z');
  });

  it('a new task from a bare date starts at the first working minute; 6 h end at 16:00 after lunch', async () => {
    const { tasks } = setup();
    const t = await tasks.create(
      H,
      { name: 'تمديد', type: 'TASK', startDate: '2026-10-18', durationDays: 1, durationHours: 6, status: 'NOT_STARTED', priority: 'MEDIUM', progress: 0 },
      ADMIN,
      ctx,
    );
    expect(t).toMatchObject({ startDate: '2026-10-18T09:00', endDate: '2026-10-18T16:00', durationHours: 6, durationDays: 1 });
  });

  it('dependencies take lagHours in HOUR projects (stored in minutes, rounded days kept)', async () => {
    const { tasks, fake } = setup({ deps: [] });
    const dep = await tasks.createDependency(H, { predecessorId: A, successorId: B, type: 'FS', lagDays: 0, lagHours: 1.5 }, ADMIN, ctx);
    expect(dep).toMatchObject({ lagHours: 1.5, lagDays: 0 });
    expect(fake.data.deps[0]).toMatchObject({ lagMinutes: 90, lagDays: 0 });
    // A ends 12:00; + 1.5 h → 12:00–13:00 + 14:00–14:30.
    const b = dep.affected.find((t) => t.id === B)!;
    expect(b.startDate).toBe('2026-10-11T14:30');
  });

  it('the Gantt payload carries durationUnit, hours, lagHours and the calendar working hours', async () => {
    const { projects } = setup();
    const g = await projects.gantt(H, ADMIN);
    expect(g.project.durationUnit).toBe('HOUR');
    expect(g.calendar.workingHours).toEqual([
      { start: '09:00', end: '13:00' },
      { start: '14:00', end: '18:00' },
    ]);
    expect(g.dependencies[0]).toMatchObject({ lagDays: 0, lagHours: 2 });
    expect(g.tasks.find((t) => t.id === A)).toMatchObject({ startAt: '2026-10-11T09:00', durationHours: 3 });
    expect(g.project.endDate).toBe('2026-10-11');
  });
});

describe('A9 hours — converting a project DAY ↔ HOUR (POST /projects/:id/convert)', () => {
  it('DAY → HOUR keeps the working days, gives lags in hours, then HOUR → DAY restores the project', async () => {
    const { projects, local, row, fake } = setup();
    const p = await projects.convert(DP, 'HOUR', ADMIN, ctx);
    expect(p.durationUnit).toBe('HOUR');
    expect(local(X)).toEqual({ start: '2026-10-11T09:00', end: '2026-10-12T18:00', minutes: 960, startDate: '2026-10-11', endDate: '2026-10-12' });
    expect(local(Y)).toMatchObject({ start: '2026-10-14T09:00', end: '2026-10-14T18:00', minutes: 480 });
    // Milestone caveat: an instant at the first working minute of its day.
    expect(local(M)).toMatchObject({ start: '2026-10-15T09:00', end: '2026-10-15T09:00', minutes: 0 });
    expect(fake.data.deps.find((x) => x.id === 'd2')).toMatchObject({ lagDays: 1, lagMinutes: 480 });

    const back = await projects.convert(DP, 'DAY', ADMIN, ctx);
    expect(back.durationUnit).toBe('DAY');
    expect(row(X)).toMatchObject({ startAt: null, endAt: null, durationMinutes: null, durationDays: 2 });
    expect(row(X).endDate.toISOString().slice(0, 10)).toBe('2026-10-12');
    expect(row(Y).startDate.toISOString().slice(0, 10)).toBe('2026-10-14');
    expect(fake.data.deps.find((x) => x.id === 'd2')).toMatchObject({ lagDays: 1, lagMinutes: 0 });
    const audits = fake.data.audit.filter((a) => a.action === 'project.converted');
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ before: { durationUnit: 'DAY' }, after: { durationUnit: 'HOUR' } });
  });

  it('PATCH with the same unit is a no-op; PATCH with another unit converts', async () => {
    const { projects, row } = setup();
    expect((await projects.update(DP, { durationUnit: 'DAY' }, ADMIN, ctx)).durationUnit).toBe('DAY');
    expect((await projects.update(DP, { durationUnit: 'HOUR' }, ADMIN, ctx)).durationUnit).toBe('HOUR');
    expect(row(X).durationMinutes).toBe(960);
  });
});

describe('A9 hours — the create form (working days and hours)', () => {
  it('custom working days and hours create a calendar for the project with the base holidays', async () => {
    const { projects, fake } = setup();
    const p = await projects.create(
      {
        name: 'مشروع الورشة',
        startDate: '2026-11-01',
        autoSchedule: true,
        status: 'PLANNING',
        durationUnit: 'HOUR',
        workingDays: [0, 1, 2, 3, 4, 6],
        workingHours: [
          { start: '08:00', end: '12:00' },
          { start: '13:00', end: '17:00' },
        ],
      },
      ADMIN,
      ctx,
    );
    expect(p.durationUnit).toBe('HOUR');
    expect(p.calendarId).not.toBe('cal');
    const cal = fake.data.calendars.find((c) => c.id === p.calendarId)!;
    expect(cal).toMatchObject({ name: 'تقويم مشروع الورشة', weekendDays: [5] });
    expect(cal.workingHours).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ]);
    expect(cal.exceptions.map((e) => e.name)).toEqual(['عطلة']);
    expect(fake.data.audit.some((a) => a.action === 'calendar.created')).toBe(true);
  });

  it('working days and hours equal to the default calendar reuse it', async () => {
    const { projects, fake } = setup();
    const p = await projects.create(
      { name: 'مشروع عادي', startDate: '2026-11-01', autoSchedule: true, status: 'PLANNING', workingDays: [0, 1, 2, 3, 4], workingHours: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] },
      ADMIN,
      ctx,
    );
    expect(p.calendarId).toBe('cal');
    expect(p.durationUnit).toBe('DAY');
    expect(fake.data.calendars).toHaveLength(1);
  });
});

describe('A9 hours — workload in real working minutes', () => {
  it('DAY tasks count each day by its calendar minutes (short day included); HOUR tasks only the minutes they cover', () => {
    const cal = new WorkCalendar({
      weekendDays: [5, 6],
      exceptions: [{ date: '2026-10-19', isWorking: true, workingHours: [{ start: '08:00', end: '12:00' }] }],
    });
    const w = computeWorkload({
      from: '2026-10-18',
      to: '2026-10-20',
      users: [{ id: 'u1', fullName: 'أحمد' }],
      capacity: cal,
      tasks: [
        { assigneeId: 'u1', type: 'TASK', startDate: '2026-10-18', endDate: '2026-10-20', cal },
        // HOUR task Sun 10:00–15:00 = 3 h before lunch + 1 h after.
        { assigneeId: 'u1', type: 'TASK', startDate: '2026-10-18', endDate: '2026-10-18', startAt: '2026-10-18T10:00', endAt: '2026-10-18T15:00', cal },
      ],
      entries: [],
    });
    const days = Object.fromEntries(w.people[0]!.days.map((x) => [x.date, [x.assignedMinutes, x.taskCount, x.capacityMinutes]]));
    expect(days).toEqual({
      '2026-10-18': [480 + 240, 2, 480],
      '2026-10-19': [240, 1, 240],
      '2026-10-20': [480, 1, 480],
    });
    expect(w.capacityMinutesPerDay).toBe(480);
  });

  it('the workload endpoint reads start_at/end_at of HOUR tasks', async () => {
    const { reports } = setup({
      tasks: [hourTask(A, H, '2026-10-18T10:00', '2026-10-18T15:00', 240, { assigneeId: 'sup1' })],
      deps: [],
    });
    const w = await reports.workload({ from: '2026-10-18', to: '2026-10-18' });
    expect(w.people.find((p) => p.user.id === 'sup1')!.days[0]).toMatchObject({ assignedMinutes: 240, taskCount: 1, capacityMinutes: 480 });
  });
});

describe('A9 hours — instants', () => {
  it('Riyadh wall time ↔ instants', () => {
    expect(instantOf('2026-10-18T10:00').toISOString()).toBe('2026-10-18T07:00:00.000Z');
    expect(localOf(new Date('2026-10-18T21:30:00Z'))).toBe('2026-10-19T00:30');
  });
});
