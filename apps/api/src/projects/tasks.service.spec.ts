import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task, type FakeData } from '../../test/unit/fake-project-db';
import { mapTaskDbError, ProjectStore } from './project-store';
import { TasksService } from './tasks.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const SUP = { id: 'sup1', role: 'SUPERVISOR' as const, status: 'ACTIVE' as const, fullName: 'مشرف ١' };
const SUP2 = { id: 'sup2', role: 'SUPERVISOR' as const, status: 'ACTIVE' as const, fullName: 'مشرف ٢' };
const P = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const G = 'f0000000-0000-4000-8000-00000000000f';

async function expectCode(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

/**
 * Chain A → B → C (FS, lag 0), two working days each, weekend Fri/Sat and a holiday on
 * Tue 2026-10-20: A 11–12, B 13–14, C Thu 15 – Sun 18.
 */
function setup(over: Partial<FakeData> = {}) {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'sup1', fullName: 'مشرف ١', role: 'SUPERVISOR', status: 'ACTIVE' },
      { id: 'sup2', fullName: 'مشرف ٢', role: 'SUPERVISOR', status: 'ACTIVE' },
      { id: 'sup-off', fullName: 'مشرف موقوف', role: 'SUPERVISOR', status: 'SUSPENDED' },
      { id: 'mon', fullName: 'مراقب', role: 'MONITOR', status: 'ACTIVE' },
    ],
    calendars: [
      { id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [{ id: 'h1', date: d('2026-10-20'), isWorking: false, name: 'عطلة اختبار' }] },
    ],
    projects: [
      { id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' },
      { id: P2, name: 'مشروع آخر', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin' },
    ],
    tasks: [
      task({ id: A, projectId: P, sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, assigneeId: 'sup1', version: 3 }),
      task({ id: B, projectId: P, sortOrder: 2, wbsCache: '2', startDate: d('2026-10-13'), endDate: d('2026-10-14'), durationDays: 2, version: 1 }),
      task({ id: C, projectId: P, sortOrder: 3, wbsCache: '3', startDate: d('2026-10-15'), endDate: d('2026-10-18'), durationDays: 2, version: 0 }),
    ],
    deps: [
      { id: 'd1', projectId: P, predecessorId: A, successorId: B, type: 'FS', lagDays: 0 },
      { id: 'd2', projectId: P, predecessorId: B, successorId: C, type: 'FS', lagDays: 0 },
    ],
    ...over,
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const service = new TasksService(fake.db as never, store, audit, fake.notifications as never);
  return { fake, service };
}

describe('TasksService — batch (ADR-017, Phase 4 acceptance at service level)', () => {
  it('delaying the first task shifts its FS successors over Fri/Sat and the holiday, and returns them', async () => {
    const { fake, service } = setup();
    const res = await service.batch(P, { changes: [{ id: A, version: 3, startDate: '2026-10-14' }] }, ADMIN, ctx);

    expect(fake.t(A)).toMatchObject({ startDate: '2026-10-14', endDate: '2026-10-15', version: 4 });
    // Next working day after Thu 15 is Sun 18 (Fri/Sat weekend).
    expect(fake.t(B)).toMatchObject({ startDate: '2026-10-18', endDate: '2026-10-19', version: 2 });
    // Tue 20 is a holiday → C starts Wed 21.
    expect(fake.t(C)).toMatchObject({ startDate: '2026-10-21', endDate: '2026-10-22', version: 1 });
    expect(res.tasks.map((t) => t.id).sort()).toEqual([A, B, C].sort());
    expect(res.tasks.find((t) => t.id === C)).toMatchObject({ startDate: '2026-10-21', endDate: '2026-10-22', version: 1 });

    const moved = fake.data.audit.filter((a) => a.action === 'task.moved');
    expect(moved).toHaveLength(3);
    expect(moved.find((a) => a.entityId === C)?.after).toMatchObject({ auto: true, startDate: '2026-10-21' });
    expect(moved.find((a) => a.entityId === A)?.after).not.toHaveProperty('auto');
  });

  it('a stale version anywhere in the batch → 409 CONFLICT_VERSION with ids and current versions; nothing is written', async () => {
    const { fake, service } = setup();
    const before = JSON.stringify(fake.data.tasks);
    const err = await expectCode(
      service.batch(
        P,
        {
          changes: [
            { id: A, version: 3, startDate: '2026-10-14' },
            { id: B, version: 0, startDate: '2026-10-25' },
            { id: '99999999-0000-4000-8000-000000000099', version: 0, progress: 10 },
          ],
        },
        ADMIN,
        ctx,
      ),
      'CONFLICT_VERSION',
    );
    expect(err.status).toBe(409);
    expect(err.details).toEqual({
      refresh: 'tasks',
      conflicts: [
        { id: B, currentVersion: 1 },
        { id: '99999999-0000-4000-8000-000000000099', currentVersion: null },
      ],
    });
    expect(JSON.stringify(fake.data.tasks)).toBe(before);
    expect(fake.calls.taskUpdates).toBe(0);
    expect(fake.data.audit).toHaveLength(0);
  });

  it('client-sent successor dates are not trusted: the server re-runs the engine', async () => {
    const { fake, service } = setup();
    // The client claims B may start on Thu 15 although A now ends that day.
    await service.batch(
      P,
      {
        changes: [
          { id: A, version: 3, startDate: '2026-10-14' },
          { id: B, version: 1, startDate: '2026-10-15' },
        ],
      },
      ADMIN,
      ctx,
    );
    expect(fake.t(B)).toMatchObject({ startDate: '2026-10-18', endDate: '2026-10-19', durationDays: 2 });
  });

  it('indent via parentId makes the parent a GROUP, rolls it up and refreshes WBS', async () => {
    const { fake, service } = setup({ deps: [] });
    const res = await service.batch(P, { changes: [{ id: B, version: 1, parentId: A }] }, ADMIN, ctx);
    expect(fake.t(A)).toMatchObject({ type: 'GROUP', startDate: '2026-10-13', endDate: '2026-10-14', wbsCache: '1' });
    expect(fake.t(B)).toMatchObject({ parentId: A, wbsCache: '1.1', version: 2 });
    // C moved from WBS 3 to 2 only: cache refreshed without a version bump.
    expect(fake.t(C)).toMatchObject({ wbsCache: '2', version: 0 });
    expect(res.tasks.map((t) => t.id).sort()).toEqual([A, B, C].sort());
  });

  it('rejects making a task its own ancestor (TASK_PARENT_INVALID) and writes nothing', async () => {
    const { fake, service } = setup({
      deps: [],
      tasks: [
        task({ id: G, projectId: P, type: 'GROUP', sortOrder: 1, startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2 }),
        task({ id: A, projectId: P, parentId: G, sortOrder: 1, startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2 }),
      ],
    });
    await expectCode(service.batch(P, { changes: [{ id: G, version: 0, parentId: A }] }, ADMIN, ctx), 'TASK_PARENT_INVALID');
    await expectCode(service.batch(P, { changes: [{ id: G, version: 0, parentId: G }] }, ADMIN, ctx), 'TASK_PARENT_INVALID');
    expect(fake.calls.taskUpdates).toBe(0);
  });
});

describe('TasksService — dependencies', () => {
  it('a cycle is rejected with DEPENDENCY_CYCLE and the closed path', async () => {
    const { service } = setup();
    const err = await expectCode(service.createDependency(P, { predecessorId: C, successorId: A, type: 'FS', lagDays: 0 }, ADMIN, ctx), 'DEPENDENCY_CYCLE');
    expect(err.status).toBe(409);
    const path = (err.details as { path: string[] }).path;
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path)).toEqual(new Set([A, B, C]));
  });

  it('self dependency → DEPENDENCY_SELF; duplicate → DEPENDENCY_EXISTS; non-FS → DEPENDENCY_TYPE_DISABLED', async () => {
    const { service } = setup();
    await expectCode(service.createDependency(P, { predecessorId: A, successorId: A, type: 'FS', lagDays: 0 }, ADMIN, ctx), 'DEPENDENCY_SELF');
    await expectCode(service.createDependency(P, { predecessorId: A, successorId: B, type: 'FS', lagDays: 0 }, ADMIN, ctx), 'DEPENDENCY_EXISTS');
    await expectCode(service.createDependency(P, { predecessorId: A, successorId: C, type: 'SS', lagDays: 0 }, ADMIN, ctx), 'DEPENDENCY_TYPE_DISABLED');
  });

  it('a link between a task and its own ancestor is a cycle', async () => {
    const { service } = setup({
      deps: [],
      tasks: [
        task({ id: G, projectId: P, type: 'GROUP', sortOrder: 1, startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2 }),
        task({ id: A, projectId: P, parentId: G, sortOrder: 1, startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2 }),
      ],
    });
    await expectCode(service.createDependency(P, { predecessorId: G, successorId: A, type: 'FS', lagDays: 0 }, ADMIN, ctx), 'DEPENDENCY_CYCLE');
  });

  it('creating a link shifts the successor (with lag) and returns it in affected', async () => {
    const { fake, service } = setup({ deps: [] });
    const res = await service.createDependency(P, { predecessorId: A, successorId: C, type: 'FS', lagDays: 2 }, ADMIN, ctx);
    // A ends Mon 12 → next working day Tue 13, + 2 working days lag → Thu 15: C already starts there.
    expect(res.affected).toHaveLength(0);
    const res2 = await service.createDependency(P, { predecessorId: C, successorId: B, type: 'FS', lagDays: 0 }, ADMIN, ctx);
    // C ends Sun 18 → B from Mon 19 for 2 working days (Tue 20 is a holiday) → ends Wed 21.
    expect(fake.t(B)).toMatchObject({ startDate: '2026-10-19', endDate: '2026-10-21' });
    expect(res2.affected.map((t) => t.id)).toEqual([B]);
    expect(fake.data.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dependency.created', 'task.moved']));
  });
});

describe('TasksService — assignee and supervisor rules (ADR-007)', () => {
  it('the assignee must be an ACTIVE SUPERVISOR', async () => {
    const { service } = setup();
    const base = { name: 'مهمة', type: 'TASK' as const, startDate: '2026-10-11', durationDays: 1, status: 'NOT_STARTED' as const, priority: 'MEDIUM' as const, progress: 0 };
    for (const assigneeId of ['admin', 'mon', 'sup-off', 'missing']) {
      await expectCode(service.create(P, { ...base, assigneeId }, ADMIN, ctx), 'ASSIGNEE_NOT_SUPERVISOR');
    }
    await expectCode(service.update(B, { version: 1, assigneeId: 'mon' }, ADMIN, ctx), 'ASSIGNEE_NOT_SUPERVISOR');
    // The database trigger (SQLSTATE 23514) is mapped to the same code.
    const mapped = mapTaskDbError(new Error('Raw query failed. Code: `23514`. Message: `ASSIGNEE_NOT_SUPERVISOR`'));
    expect(mapped).toBeInstanceOf(AppError);
    expect((mapped as AppError).code).toBe('ASSIGNEE_NOT_SUPERVISOR');
  });

  it('(re)assignment notifies TASK_ASSIGNED', async () => {
    const { fake, service } = setup();
    await service.update(B, { version: 1, assigneeId: 'sup2' }, ADMIN, ctx);
    expect(fake.data.notifications).toEqual([expect.objectContaining({ userId: 'sup2', type: 'TASK_ASSIGNED' })]);
  });

  it('a supervisor may change progress/status of their own task, and the roll-up follows', async () => {
    const { fake, service } = setup({
      deps: [],
      tasks: [
        task({ id: G, projectId: P, type: 'GROUP', sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-14'), durationDays: 4 }),
        task({ id: A, projectId: P, parentId: G, sortOrder: 1, wbsCache: '1.1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, assigneeId: 'sup1' }),
        task({ id: B, projectId: P, parentId: G, sortOrder: 2, wbsCache: '1.2', startDate: d('2026-10-13'), endDate: d('2026-10-14'), durationDays: 2 }),
      ],
    });
    const res = await service.update(A, { version: 0, progress: 50, status: 'IN_PROGRESS' }, SUP, ctx);
    expect(res.task).toMatchObject({ progress: 50, status: 'IN_PROGRESS', version: 1 });
    expect(res.affected.map((t) => t.id)).toEqual([G]);
    expect(fake.t(G).progress).toBe(25);
  });

  it('anything else from a supervisor is 403; another project is 404', async () => {
    const { fake, service } = setup({
      tasks: [
        task({ id: A, projectId: P, assigneeId: 'sup1' }),
        task({ id: B, projectId: P }),
        task({ id: C, projectId: P2 }),
      ],
      deps: [],
    });
    await expectCode(service.update(A, { version: 0, startDate: '2026-10-13' }, SUP, ctx), 'FORBIDDEN');
    await expectCode(service.update(A, { version: 0, progress: 10, name: 'اسم' }, SUP, ctx), 'FORBIDDEN');
    // Visible (sup1 has a task in P) but not assigned to them.
    await expectCode(service.update(B, { version: 0, progress: 10 }, SUP, ctx), 'FORBIDDEN');
    // No grant and no task in P2.
    await expectCode(service.update(C, { version: 0, progress: 10 }, SUP, ctx), 'NOT_FOUND');
    await expectCode(service.update(A, { version: 0, progress: 10 }, SUP2, ctx), 'NOT_FOUND');
    expect(fake.calls.taskUpdates).toBe(0);
  });
});

describe('TasksService — create, WBS and archive', () => {
  it('inserts between siblings with a fractional sort order and refreshes the WBS of later siblings', async () => {
    const { fake, service } = setup({ deps: [] });
    const created = await service.create(
      P,
      { afterId: A, name: 'جديدة', type: 'TASK', startDate: '2026-10-16', durationDays: 3, status: 'NOT_STARTED', priority: 'HIGH', progress: 0 },
      ADMIN,
      ctx,
    );
    // Fri 16 snaps to Sun 18; 3 working days with the Tue 20 holiday → Sun 18, Mon 19, Wed 21.
    expect(created).toMatchObject({ sortOrder: 1.5, wbs: '2', startDate: '2026-10-18', endDate: '2026-10-21', durationDays: 3 });
    expect(fake.t(B)).toMatchObject({ wbsCache: '3', version: 1 });
    expect(fake.t(C)).toMatchObject({ wbsCache: '4', version: 0 });
    expect(created.affected.map((t) => t.id).sort()).toEqual([B, C].sort());
    expect(fake.data.audit.map((a) => a.action)).toEqual(['task.created']);
  });

  it('a child under a TASK promotes the parent to GROUP; a milestone has duration 0 and cannot be a parent', async () => {
    const { fake, service } = setup({ deps: [] });
    const m = await service.create(
      P,
      { parentId: A, name: 'معلم', type: 'MILESTONE', startDate: '2026-10-15', durationDays: 5, status: 'NOT_STARTED', priority: 'MEDIUM', progress: 0 },
      ADMIN,
      ctx,
    );
    expect(m).toMatchObject({ type: 'MILESTONE', durationDays: 0, startDate: '2026-10-15', endDate: '2026-10-15', wbs: '1.1' });
    expect(fake.t(A)).toMatchObject({ type: 'GROUP', startDate: '2026-10-15', endDate: '2026-10-15' });
    await expectCode(
      service.create(P, { parentId: m.id, name: 'x', type: 'TASK', startDate: '2026-10-15', durationDays: 1, status: 'NOT_STARTED', priority: 'MEDIUM', progress: 0 }, ADMIN, ctx),
      'TASK_PARENT_INVALID',
    );
  });

  it('archiving a task archives its subtree and removes its dependencies', async () => {
    const { fake, service } = setup();
    const res = await service.archive(B, ADMIN, ctx);
    expect(res.archivedIds).toEqual([B]);
    expect(fake.data.tasks.find((t) => t.id === B)?.archivedAt).toBeInstanceOf(Date);
    expect(fake.data.deps).toHaveLength(0);
    expect(fake.t(C)).toMatchObject({ wbsCache: '2' });
    expect(fake.data.audit.find((a) => a.action === 'task.archived')).toBeDefined();
  });
});

describe('TasksService — my tasks', () => {
  it('lists assigned tasks by end date with overdue / due-soon flags (Riyadh today, project calendar)', async () => {
    const { service } = setup({
      deps: [],
      tasks: [
        task({ id: A, projectId: P, assigneeId: 'sup1', endDate: d('2026-10-08'), startDate: d('2026-10-07') }),
        task({ id: B, projectId: P, assigneeId: 'sup1', endDate: d('2026-10-14'), startDate: d('2026-10-14') }),
        task({ id: C, projectId: P2, assigneeId: 'sup1', endDate: d('2026-10-25'), startDate: d('2026-10-25') }),
        task({ id: G, projectId: P, assigneeId: 'sup1', endDate: d('2026-10-01'), startDate: d('2026-10-01'), status: 'DONE' }),
      ],
    });
    // Sun 2026-10-11 21:30 UTC is already Mon 12 in Riyadh: due soon = up to Wed 14.
    const mine = await service.mine(SUP, new Date('2026-10-11T21:30:00Z'));
    expect(mine.map((t) => [t.id, t.overdue, t.dueSoon])).toEqual([
      [G, false, false],
      [A, true, false],
      [B, false, true],
      [C, false, false],
    ]);
    expect(mine[0]!.project).toEqual({ id: P, name: 'مشروع' });
  });
});

describe('ProjectStore — calendar changes and reminder flags', () => {
  it('a new holiday re-derives ends from durations and shifts successors (rescheduleProject)', async () => {
    const { fake } = setup();
    // Holiday added on Thu 15: C (Thu 15, Sun 18) must start Sun 18 and end Mon 19.
    fake.data.calendars[0]!.exceptions.push({ id: 'h2', date: d('2026-10-15'), isWorking: false, name: 'عطلة ثانية' });
    const audit = new AuditService(fake.db as never);
    const store = new ProjectStore(fake.db as never, audit);
    const written = await fake.db.$transaction((tx: never) => store.rescheduleProject(tx, P, ctx, 'calendar_exception.created'));
    expect(written).toBe(1);
    expect(fake.t(C)).toMatchObject({ startDate: '2026-10-18', endDate: '2026-10-19', version: 1 });
    expect(fake.data.audit[0]).toMatchObject({ action: 'task.moved', after: expect.objectContaining({ cause: 'calendar_exception.created' }) });
  });

  it('moving an end date clears the due-soon / overdue flags so the task is reminded again', async () => {
    const { fake, service } = setup();
    const a = fake.data.tasks.find((t) => t.id === C)!;
    a.dueSoonNotifiedAt = new Date();
    a.overdueNotifiedAt = new Date();
    await service.batch(P, { changes: [{ id: A, version: 3, startDate: '2026-10-14' }] }, ADMIN, ctx);
    expect(fake.data.tasks.find((t) => t.id === C)).toMatchObject({ dueSoonNotifiedAt: null, overdueNotifiedAt: null });
  });
});
