/**
 * Calculations audit 2026-10 through the DemoApi (the API's calc-audit.spec "write path" cases):
 * group status derived, status ↔ progress sync, empty groups zeroed, undo with both fields,
 * reminders re-armed by the due DAY, the edit-window boundary, per-day workload capacity, the week
 * KPI span, lag rounding and a seed where no group reads «لم تبدأ» at 100 %.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveGroupStatus } from '@nuzli/scheduling';
import type { TaskDto } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { uuidv4 } from '../../lib/uuid';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-audit-${Date.now()}-${n++}` });
});
afterEach(() => {
  vi.useRealTimers();
});

const ADMIN = 'admin1@demo.nuzli.example';
const MONITOR = 'monitor1@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return (err as ApiError).code;
}

/** g { a (30 %, IN_PROGRESS, 2 d), b (2 d) } — the API spec's fixture. */
async function groupProject() {
  await loginAs(ADMIN);
  const project = await api.projects.create({ name: 'مراجعة الحسابات', startDate: '2027-03-07' });
  const g = await api.tasks.create(project.id, { name: 'المرحلة', startDate: '2027-03-07', durationDays: 1 });
  await api.tasks.create(project.id, { name: 'أ', startDate: '2027-03-07', durationDays: 2, parentId: g.id, plannedCost: 100, actualCost: 150, progress: 30, status: 'IN_PROGRESS' });
  await api.tasks.create(project.id, { name: 'ب', startDate: '2027-03-09', durationDays: 2, parentId: g.id, plannedCost: 200 });
  return { project, ids: await ids(project.id) };
}
async function ids(projectId: string) {
  const gantt = await api.projects.gantt(projectId);
  const by = (name: string) => gantt.tasks.find((t) => t.name === name)!;
  return { g: by('المرحلة'), a: by('أ'), b: by('ب') };
}
const row = async (projectId: string, id: string): Promise<TaskDto> => (await api.projects.gantt(projectId)).tasks.find((t) => t.id === id)!;

describe('H1 — group status derived, status ↔ progress on leaves (DemoApi = API)', () => {
  it('a board move to DONE sets progress 100; the group follows to DONE', async () => {
    const { project, ids: t } = await groupProject();
    expect(t.g).toMatchObject({ type: 'GROUP', status: 'IN_PROGRESS' });
    const res = await api.tasks.update(t.a.id, { version: t.a.version, status: 'DONE' });
    expect(res.task).toMatchObject({ status: 'DONE', progress: 100 });
    expect(await row(project.id, t.g.id)).toMatchObject({ status: 'IN_PROGRESS', progress: 50 });
    await api.tasks.update(t.b.id, { version: t.b.version, progress: 100 });
    expect(await row(project.id, t.b.id)).toMatchObject({ status: 'DONE', progress: 100 });
    expect(await row(project.id, t.g.id)).toMatchObject({ status: 'DONE', progress: 100 });
  });

  it('moving a card back to «لم تبدأ» resets progress to 0; lowering progress on DONE reopens it', async () => {
    const { project, ids: t } = await groupProject();
    const done = await api.tasks.update(t.a.id, { version: t.a.version, progress: 100 });
    expect(done.task.status).toBe('DONE');
    const back = await api.tasks.batch(project.id, { changes: [{ id: t.a.id, version: done.task.version, progress: 60 }] });
    expect(back.tasks.find((x) => x.id === t.a.id)).toMatchObject({ status: 'IN_PROGRESS', progress: 60 });
    const a = await row(project.id, t.a.id);
    const reset = await api.tasks.update(t.a.id, { version: a.version, status: 'NOT_STARTED' });
    expect(reset.task).toMatchObject({ status: 'NOT_STARTED', progress: 0 });
  });

  it("a group's status cannot be edited (TASK_GROUP_STATUS_DERIVED, Arabic message); re-sending it unchanged is fine", async () => {
    const { ids: t } = await groupProject();
    const err = await api.tasks.update(t.g.id, { version: t.g.version, status: 'DONE' }).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.code).toBe('TASK_GROUP_STATUS_DERIVED');
    expect(err?.message_ar).toContain('حالة المجموعة');
    await expect(api.tasks.update(t.g.id, { version: t.g.version, status: t.g.status, name: 'مرحلة أولى' })).resolves.toBeDefined();
  });

  it('bulk status on a selection skips groups and syncs leaves', async () => {
    const { project, ids: t } = await groupProject();
    await api.tasks.bulk(project.id, { ids: [t.g.id, t.a.id], versions: { [t.g.id]: t.g.version, [t.a.id]: t.a.version }, patch: { status: 'DONE' } });
    expect(await row(project.id, t.a.id)).toMatchObject({ status: 'DONE', progress: 100 });
    expect((await row(project.id, t.g.id)).status).toBe('IN_PROGRESS');
  });

  it('undo after a status move sends both fields and restores both (ADR-095 contract)', async () => {
    const { project, ids: t } = await groupProject();
    const res = await api.tasks.update(t.a.id, { version: t.a.version, status: 'DONE' });
    expect(res.previous![t.a.id]).toMatchObject({ status: 'IN_PROGRESS', progress: 30 });
    const undo = await api.tasks.batch(project.id, { changes: [{ id: t.a.id, version: res.task.version, ...res.previous![t.a.id] } as never] });
    expect(undo.tasks.find((x) => x.id === t.a.id)).toMatchObject({ status: 'IN_PROGRESS', progress: 30 });
    expect(await row(project.id, t.g.id)).toMatchObject({ status: 'IN_PROGRESS' });
  });
});

describe('H2 — archiving every child zeroes the group, dates kept', () => {
  it('cost, progress and status go to 0 / 0 / NOT_STARTED; the budget and the project agree', async () => {
    const { project, ids: t } = await groupProject();
    expect(t.g).toMatchObject({ plannedCost: 300, actualCost: 150 });
    await api.tasks.bulkArchive(project.id, { ids: [t.a.id, t.b.id], versions: { [t.a.id]: t.a.version, [t.b.id]: t.b.version } });
    const g = await row(project.id, t.g.id);
    expect(g).toMatchObject({ type: 'GROUP', plannedCost: 0, actualCost: 0, progress: 0, status: 'NOT_STARTED', startDate: t.g.startDate });
    const budget = await api.projects.budget(project.id);
    expect([budget.plannedCost, budget.actualCost]).toEqual([0, 0]);
    expect((await api.projects.gantt(project.id)).project.progress).toBe(0);
  });
});

describe('M1 — an HOUR project weighs progress by working minutes', () => {
  it('1 h done + 7 h not started → 12.5 %', async () => {
    await loginAs(ADMIN);
    const p = await api.projects.create({ name: 'ساعات', startDate: '2027-03-07', durationUnit: 'HOUR' });
    await api.tasks.create(p.id, { name: 'قصيرة', startDate: '2027-03-07T09:00', durationHours: 1, status: 'DONE', progress: 100 });
    await api.tasks.create(p.id, { name: 'طويلة', startDate: '2027-03-07T10:00', durationHours: 7 });
    expect((await api.projects.gantt(p.id)).project.progress).toBe(12.5);
  });
});

describe('M2/M3/L7 — HOUR edits and lags as the API', () => {
  it('a bare end date is the end of that day; durationDays wins over endDate; −4 h lag is −1 d', async () => {
    await loginAs(ADMIN);
    const p = await api.projects.create({ name: 'تعديل الساعات', startDate: '2026-10-18', durationUnit: 'HOUR' });
    const h = await api.tasks.create(p.id, { name: 'س', startDate: '2026-10-18T09:00', durationHours: 4 });
    const e1 = await api.tasks.batch(p.id, { changes: [{ id: h.id, version: h.version, endDate: '2026-10-20' }] });
    expect(e1.tasks.find((x) => x.id === h.id)).toMatchObject({ endDate: '2026-10-20T18:00', durationHours: 24 });
    const cur = await row(p.id, h.id);
    const e2 = await api.tasks.batch(p.id, { changes: [{ id: h.id, version: cur.version, endDate: '2026-10-20', durationDays: 1 }] });
    expect(e2.tasks.find((x) => x.id === h.id)).toMatchObject({ endDate: '2026-10-18T18:00', durationHours: 8 });
    const k = await api.tasks.create(p.id, { name: 'ك', startDate: '2026-10-21T09:00', durationHours: 2 });
    const dep = await api.dependencies.create(p.id, { predecessorId: h.id, successorId: k.id, lagHours: -4 });
    expect(dep.lagDays).toBe(-1);
  });
});

describe('L10 — reminders re-armed only when the due DAY moves (HOUR)', () => {
  it('a same-day time change keeps the flag; a new day clears it', async () => {
    await loginAs(ADMIN);
    const p = await api.projects.create({ name: 'تذكيرات', startDate: '2026-10-18', durationUnit: 'HOUR' });
    const a = await api.tasks.create(p.id, { name: 'أ', startDate: '2026-10-18T09:00', durationHours: 4, assigneeId: SUP1_ID });
    await api.db.tasks.update(a.id, { dueSoonNotifiedAt: '2026-10-18T04:00:00.000Z' });
    const r1 = await api.tasks.update(a.id, { version: a.version, durationHours: 6 });
    expect(r1.task.endDate).toBe('2026-10-18T16:00');
    expect((await api.db.tasks.get(a.id))!.dueSoonNotifiedAt).not.toBeNull();
    await api.tasks.update(a.id, { version: r1.task.version, durationHours: 16 });
    expect((await api.db.tasks.get(a.id))!.dueSoonNotifiedAt).toBeNull();
  });
});

describe('L13 — the edit window is closed at exactly editableUntil', () => {
  it('the recorder can edit one millisecond before, not at the boundary', async () => {
    await loginAs(MONITOR);
    const { violation } = await api.violations.create({
      clientUuid: uuidv4(),
      memberId: '00000000-0000-4000-8000-b00000000001',
      typeId: '00000000-0000-4000-8000-d10000000001',
      description: 'حدّ نافذة التعديل',
      latitude: 24.7,
      longitude: 46.7,
      accuracyM: 9,
      capturedAt: new Date().toISOString(),
      deviceInfo: { userAgent: 'vitest', platform: 'test', online: true, appVersion: 'test' },
      expectedIdPhotos: 1,
      expectedEvidencePhotos: 1,
    });
    const until = Date.parse(violation.editableUntil!);
    vi.useFakeTimers({ toFake: ['Date'], now: until - 1 });
    await expect(api.violations.update(violation.id, { description: 'قبل الحد' })).resolves.toBeDefined();
    vi.setSystemTime(until);
    expect(await codeOf(api.violations.update(violation.id, { description: 'عند الحد' }))).toBe('EDIT_WINDOW_CLOSED');
  });
});

describe('M4 — workload capacity per day in the demo', () => {
  it('a holiday on the default calendar has capacity 0 and a short day its own minutes', async () => {
    await loginAs(ADMIN);
    const def = (await api.calendars.list()).find((c) => c.isDefault)!;
    await api.calendars.addException(def.id, { date: '2027-06-07', isWorking: false, name: 'عطلة (تجريبي)' });
    await api.calendars.addException(def.id, { date: '2027-06-08', isWorking: true, name: 'يوم قصير (تجريبي)', workingHours: [{ start: '09:00', end: '12:00' }] });
    const w = await api.workload({ from: '2027-06-06', to: '2027-06-12', userIds: [SUP1_ID] });
    const p = w.people[0]!;
    expect(p.days.map((d) => d.capacityMinutes)).toEqual([480, 0, 180, 480, 480, 0, 0]);
    expect(p.totalCapacityMinutes).toBe(480 * 3 + 180);
  });
});

describe('week KPI and per-member rate (design decisions)', () => {
  it('the stats carry previousWeekToDate and a perMemberRate per team', async () => {
    await loginAs(ADMIN);
    const s = await api.violations.stats({});
    expect(typeof s.previousWeekToDate).toBe('number');
    expect(s.previousWeekToDate!).toBeLessThanOrEqual(s.previousWeek);
    for (const t of s.byTeam) expect(t.perMemberRate === null || t.perMemberRate === t.perMember).toBe(true);
  });
});

describe('seed — no group reads «لم تبدأ» at 100 %', () => {
  it('every seeded group carries the status derived from its children', async () => {
    await loginAs(ADMIN);
    const projects = await api.projects.list();
    let groups = 0;
    for (const p of projects) {
      const g = await api.projects.gantt(p.id);
      for (const t of g.tasks) {
        const kids = g.tasks.filter((x) => x.parentId === t.id);
        if (!kids.length) {
          if (t.type !== 'GROUP') expect(t.status === 'DONE').toBe(t.progress >= 100);
          continue;
        }
        groups++;
        expect(t.status, `${p.name} › ${t.name}`).toBe(deriveGroupStatus(kids, t.progress));
        if (t.progress >= 100) expect(t.status).toBe('DONE');
      }
    }
    expect(groups).toBeGreaterThan(10);
  });
});
