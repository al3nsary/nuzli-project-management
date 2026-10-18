import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task, type FakeData } from '../../test/unit/fake-project-db';
import { ProjectStore } from './project-store';
import { ProjectsService } from './projects.service';
import { COPY_SUFFIX, TasksService } from './tasks.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r1', userAgent: null };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const P = '00000000-0000-4000-8000-0000000000a1';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const G = 'f0000000-0000-4000-8000-00000000000f';
const L1 = '11000000-0000-4000-8000-000000000001';
const L2 = '11000000-0000-4000-8000-000000000002';
const LX = '11000000-0000-4000-8000-0000000000ff';

async function expectCode(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

/** G (group) holds A and B; C is a root after G. A → B → C (FS). Weekend Fri/Sat, holiday Tue 20. */
function setup(over: Partial<FakeData> = {}) {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'sup1', fullName: 'مشرف ١', role: 'SUPERVISOR', status: 'ACTIVE' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [{ id: 'h1', date: d('2026-10-20'), isWorking: false, name: 'عطلة اختبار' }] }],
    projects: [{ id: P, name: 'مشروع', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', budget: 100 }],
    tasks: [
      task({ id: G, projectId: P, type: 'GROUP', sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-14'), durationDays: 4, plannedCost: 150.25, actualCost: 110.5, version: 2 }),
      task({ id: A, projectId: P, parentId: G, sortOrder: 1, wbsCache: '1.1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, plannedCost: 100, actualCost: 30.5, version: 3 }),
      task({ id: B, projectId: P, parentId: G, sortOrder: 2, wbsCache: '1.2', startDate: d('2026-10-13'), endDate: d('2026-10-14'), durationDays: 2, plannedCost: 50.25, actualCost: 80, version: 1 }),
      task({ id: C, projectId: P, sortOrder: 2, wbsCache: '2', startDate: d('2026-10-15'), endDate: d('2026-10-18'), durationDays: 2, version: 0 }),
    ],
    deps: [
      { id: 'd1', projectId: P, predecessorId: A, successorId: B, type: 'FS', lagDays: 0 },
      { id: 'd2', projectId: P, predecessorId: B, successorId: C, type: 'FS', lagDays: 0 },
    ],
    labels: [
      { id: L1, projectId: P, name: 'كهرباء', color: '#303F9F' },
      { id: L2, projectId: P, name: 'سباكة', color: '#00897B' },
    ],
    taskLabels: [{ taskId: A, labelId: L1 }],
    ...over,
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const service = new TasksService(fake.db as never, store, audit, fake.notifications as never);
  const projects = new ProjectsService(fake.db as never, store, audit, {} as never);
  return { fake, service, projects, store };
}

describe('A9 budget — roll-up and variance', () => {
  it('a leaf cost change rolls up to its group (version + 1) and the project totals; previous holds the before-values', async () => {
    const { fake, service, projects } = setup();
    const res = await service.update(A, { version: 3, plannedCost: 120 }, ADMIN, ctx);
    expect(fake.t(A)).toMatchObject({ plannedCost: 120, version: 4 });
    expect(fake.t(G)).toMatchObject({ plannedCost: 170.25, actualCost: 110.5, version: 3 });
    expect(res.affected.map((t) => t.id)).toEqual([G]);
    expect(res.previous).toEqual({ [A]: { plannedCost: 100 }, [G]: { plannedCost: 150.25 } });
    expect(res.task).toMatchObject({ plannedCost: 120, actualCost: 30.5, overBudget: false });
    expect(res.affected[0]).toMatchObject({ plannedCost: 170.25, actualCost: 110.5 });

    const p = await projects.get(P, ADMIN);
    expect(p).toMatchObject({ budget: 100, currency: 'SAR', plannedCost: 170.25, actualCost: 110.5, costVariance: 59.75, budgetVariance: -10.5, budgetUsedPct: 110.5 });
  });

  it('a cost sent for a group is ignored: the group always holds the sum of its children', async () => {
    const { fake, service } = setup();
    const res = await service.update(G, { version: 2, plannedCost: 5, actualCost: 1 }, ADMIN, ctx);
    expect(fake.t(G)).toMatchObject({ plannedCost: 150.25, actualCost: 110.5, version: 2 });
    expect(res.previous).toEqual({});
  });

  it('over budget per task: actual > planned', async () => {
    const { service } = setup();
    expect((await service.get(B, ADMIN)).overBudget).toBe(true);
    expect((await service.get(A, ADMIN)).overBudget).toBe(false);
  });
});

describe('A9 deadline and bar colour', () => {
  it('a passed deadline on an open task is flagged; DONE is not; changing the deadline clears the reminder mark', async () => {
    const { fake, service } = setup();
    fake.data.tasks.find((t) => t.id === C)!.deadlineNotifiedAt = new Date();
    await service.update(C, { version: 0, deadline: '2026-10-01', barColor: '#E53935' }, ADMIN, ctx);
    expect(fake.data.tasks.find((t) => t.id === C)).toMatchObject({ deadlineNotifiedAt: null, barColor: '#E53935' });
    expect(await service.get(C, ADMIN)).toMatchObject({ deadline: '2026-10-01', deadlinePassed: true, barColor: '#E53935' });
    await service.update(C, { version: 1, status: 'DONE' }, ADMIN, ctx);
    expect((await service.get(C, ADMIN)).deadlinePassed).toBe(false);
    await service.update(C, { version: 2, deadline: null }, ADMIN, ctx);
    expect(await service.get(C, ADMIN)).toMatchObject({ deadline: null, deadlinePassed: false });
  });
});

describe('A9 duplicate', () => {
  it('copies the subtree after the original, remaps inner dependencies, copies labels, checklist and custom values (not comments)', async () => {
    const { fake, service } = setup({
      checklist: [{ id: 'i1', taskId: A, text: 'فحص', done: true, sort: 1, doneById: 'admin', doneAt: new Date() }],
      customValues: [{ taskId: B, fieldId: 'f1', value: 7 }],
      comments: [{ id: 'cm1', taskId: A, authorId: 'admin', body: 'تعليق', mentions: [], createdAt: new Date() }],
    });
    const res = await service.duplicate(G, { withSubtasks: true }, ADMIN, ctx);
    const g2 = res.idMap[G]!;
    const a2 = res.idMap[A]!;
    const b2 = res.idMap[B]!;
    expect(res.tasks.map((t) => t.id)).toEqual([g2, a2, b2]);
    expect(res.tasks.map((t) => t.name)).toEqual([`${G}${COPY_SUFFIX}`, `${A}${COPY_SUFFIX}`, `${B}${COPY_SUFFIX}`]);
    expect(fake.t(g2)).toMatchObject({ parentId: null, sortOrder: 1.5, wbsCache: '2', type: 'GROUP', plannedCost: 150.25 });
    expect(fake.t(a2)).toMatchObject({ parentId: g2, wbsCache: '2.1' });
    // C moved from WBS 2 to 3 (renumbered only).
    expect(fake.t(C)).toMatchObject({ wbsCache: '3', version: 0 });
    // Only the dependency inside the copied subtree is copied, remapped.
    expect(res.dependencies).toEqual([expect.objectContaining({ predecessorId: a2, successorId: b2, type: 'FS', lagDays: 0 })]);
    expect(fake.data.deps.filter((x) => x.predecessorId === b2)).toHaveLength(0);
    expect(fake.labelsOf(a2)).toEqual([L1]);
    expect(fake.data.checklist.filter((i) => i.taskId === a2)).toEqual([expect.objectContaining({ text: 'فحص', done: true })]);
    expect(fake.data.customValues.filter((v) => v.taskId === b2)).toEqual([expect.objectContaining({ fieldId: 'f1', value: 7 })]);
    expect(fake.data.comments.filter((c) => c.taskId === a2)).toHaveLength(0);
    expect(fake.data.audit.filter((a) => a.action === 'task.created')).toHaveLength(3);
    expect(fake.data.audit.find((a) => a.action === 'task.duplicated')).toMatchObject({ entityId: g2 });
  });

  it('without subtasks a group is copied alone as a plain task', async () => {
    const { fake, service } = setup();
    const res = await service.duplicate(G, { withSubtasks: false }, ADMIN, ctx);
    expect(res.tasks).toHaveLength(1);
    expect(fake.t(res.idMap[G]!)).toMatchObject({ type: 'TASK', parentId: null });
  });
});

describe('A9 bulk edit', () => {
  it('a stale version anywhere → 409 and nothing is written (labels included)', async () => {
    const { fake, service } = setup();
    const before = JSON.stringify(fake.data.tasks);
    const err = await expectCode(
      service.bulk(P, { ids: [A, B], versions: { [A]: 3, [B]: 0 }, patch: { status: 'DONE', labelIdsAdd: [L2] } }, ADMIN, ctx),
      'CONFLICT_VERSION',
    );
    expect((err.details as { conflicts: unknown[] }).conflicts).toEqual([{ id: B, currentVersion: 1 }]);
    expect(JSON.stringify(fake.data.tasks)).toBe(before);
    expect(fake.data.taskLabels).toEqual([{ taskId: A, labelId: L1 }]);
    expect(fake.calls.taskUpdates).toBe(0);
    expect(fake.data.audit).toHaveLength(0);
  });

  it('every id needs a version; labels must belong to the project', async () => {
    const { service } = setup();
    await expectCode(service.bulk(P, { ids: [A, B], versions: { [A]: 3 }, patch: { status: 'DONE' } }, ADMIN, ctx), 'VALIDATION_FAILED');
    await expectCode(service.bulk(P, { ids: [A], versions: { [A]: 3 }, patch: { labelIdsAdd: [LX] } }, ADMIN, ctx), 'LABEL_NOT_IN_PROJECT');
  });

  it('status, priority, labels and a working-day shift in one transaction; successors re-scheduled; previous for undo', async () => {
    const { fake, service } = setup();
    const res = await service.bulk(
      P,
      { ids: [A, C], versions: { [A]: 3, [C]: 0 }, patch: { priority: 'HIGH', labelIdsAdd: [L2], labelIdsRemove: [L1], shiftWorkingDays: 1 } },
      ADMIN,
      ctx,
    );
    // A (Sun 11–Mon 12) moves one working day: Mon 12–Tue 13.
    expect(fake.t(A)).toMatchObject({ startDate: '2026-10-12', endDate: '2026-10-13', priority: 'HIGH', version: 4 });
    // B is pushed by A (FS): Wed 14–Thu 15; C is shifted itself and pushed by B: Sun 18 or later.
    expect(fake.t(B)).toMatchObject({ startDate: '2026-10-14', endDate: '2026-10-15' });
    expect(fake.t(C).startDate >= '2026-10-18').toBe(true);
    expect(fake.labelsOf(A)).toEqual([L2]);
    expect(fake.labelsOf(C)).toEqual([L2]);
    expect(res.previous[A]).toMatchObject({ startDate: '2026-10-11', endDate: '2026-10-12', priority: 'MEDIUM', labelIds: [L1] });
    expect(res.previous[B]).toEqual({ startDate: '2026-10-13', endDate: '2026-10-14' });
    expect(res.previous[C]).toMatchObject({ labelIds: [], priority: 'MEDIUM', startDate: '2026-10-15' });
    expect(res.tasks.map((t) => t.id).sort()).toEqual([A, B, C, G].sort());
  });
});

describe('A9 undo contract (ADR-095)', () => {
  it('sending previous back through the batch endpoint restores every field the write changed', async () => {
    const { fake, service } = setup();
    const snapshot = Object.fromEntries([A, B, C, G].map((id) => [id, fake.t(id)]));
    const res = await service.batch(P, { changes: [{ id: A, version: 3, startDate: '2026-10-14', priority: 'URGENT', labelIds: [L1, L2], barColor: '#123456' }] }, ADMIN, ctx);
    expect(Object.keys(res.previous!).sort()).toEqual([A, B, C, G].sort());
    const versions = new Map(res.tasks.map((t) => [t.id, t.version]));
    const inverse = Object.entries(res.previous!).map(([id, prev]) => ({ id, version: versions.get(id)!, ...prev }));
    await service.batch(P, { changes: inverse }, ADMIN, ctx);
    for (const id of [A, B, C, G]) {
      const now = fake.t(id);
      const was = snapshot[id]!;
      for (const k of ['startDate', 'endDate', 'durationDays', 'priority', 'barColor', 'plannedCost', 'actualCost'] as const) expect(now[k]).toEqual(was[k]);
    }
    expect(fake.labelsOf(A)).toEqual([L1]);
  });

  it('archive returns the removed links and previous; restore brings the subtree back', async () => {
    const { fake, service } = setup();
    const res = await service.archive(B, ADMIN, ctx);
    expect(res.deletedDependencies!.map((x) => x.id).sort()).toEqual(['d1', 'd2']);
    expect(res.previous![G]).toEqual({ endDate: '2026-10-14', durationDays: 4, plannedCost: 150.25, actualCost: 110.5 });
    const back = await service.restore(P, { ids: [B] }, ADMIN, ctx);
    expect(back.restored.map((t) => t.id)).toEqual([B]);
    expect(fake.data.tasks.find((t) => t.id === B)?.archivedAt).toBeNull();
    expect(fake.t(G)).toMatchObject({ plannedCost: 150.25, actualCost: 110.5 });
    expect(fake.data.audit.some((a) => a.action === 'task.restored')).toBe(true);
    await expectCode(service.restore(P, { ids: [B] }, ADMIN, ctx), 'NOT_FOUND');
  });

  it('bulk archive checks every version first', async () => {
    const { fake, service } = setup();
    await expectCode(service.bulkArchive(P, { ids: [A, C], versions: { [A]: 3, [C]: 9 } }, ADMIN, ctx), 'CONFLICT_VERSION');
    expect(fake.data.tasks.every((t) => t.archivedAt === null)).toBe(true);
    const ok = await service.bulkArchive(P, { ids: [A, C], versions: { [A]: 3, [C]: 0 } }, ADMIN, ctx);
    expect(ok.archivedIds.sort()).toEqual([A, C].sort());
    expect(fake.data.deps).toHaveLength(0);
  });
});
