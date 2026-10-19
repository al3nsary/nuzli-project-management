/**
 * DemoApi A9 parity (docs/API.md "A9 — projects", ADR-092..097, ADR-105): every new endpoint the
 * web uses, with the server's rules — scope, versions, the undo contract, labels, custom fields,
 * checklists, duplicate, bulk, restore, templates, portfolios, time log, view preferences,
 * reports, workload, the hub, the chat and HOUR projects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';

let n = 0;
let api: DemoApi;
afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-a9-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const SUP2 = 'supervisor2@demo.nuzli.example';
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const SUP2_ID = '00000000-0000-4000-8000-000000000004';
const PARK = '00000000-0000-4000-8000-f00000000001';
const CLEAN = '00000000-0000-4000-8000-f00000000002';
const HOURS = '00000000-0000-4000-8000-f00000000004';
const TEMPLATE = '00000000-0000-4000-8000-f00000000005';

async function loginAs(identifier: string) {
  const s = await api.auth.login({ identifier, password: DEMO_PASSWORD });
  api.setAccessToken(s.accessToken);
  return s.user;
}

async function codeOf(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/** A → B (FS) in a fresh project on the default calendar (Fri/Sat weekend). */
async function smallProject() {
  await loginAs(ADMIN);
  const project = await api.projects.create({ name: 'مشروع A9', startDate: '2026-11-01', budget: 10000 });
  const g = await api.tasks.create(project.id, { name: 'مجموعة', type: 'GROUP', startDate: '2026-11-01' });
  const a = await api.tasks.create(project.id, { name: 'أ', parentId: g.id, startDate: '2026-11-01', durationDays: 2, assigneeId: SUP1_ID, plannedCost: 1000 });
  const b = await api.tasks.create(project.id, { name: 'ب', parentId: g.id, startDate: '2026-11-03', durationDays: 3, plannedCost: 2500.5 });
  await api.dependencies.create(project.id, { predecessorId: a.id, successorId: b.id });
  const gantt = await api.projects.gantt(project.id);
  const byName = (name: string) => gantt.tasks.find((t) => t.name === name)!;
  return { project, g: byName('مجموعة'), a: byName('أ'), b: byName('ب') };
}

describe('seed (seed/demo/a9.json)', () => {
  it('enriches the 60-task project and adds an HOUR job, a template and a portfolio', async () => {
    await loginAs(ADMIN);
    const park = await api.projects.gantt(PARK);
    expect(park.project.budget).toBe(520000);
    expect(park.project.budgetUsedPct).toBeGreaterThan(0);
    expect(park.labels!.length).toBeGreaterThanOrEqual(5);
    expect(park.customFields!.map((f) => f.type)).toEqual(['DROPDOWN', 'NUMBER']);
    expect(park.tasks.some((t) => t.deadlinePassed)).toBe(true);
    expect(park.tasks.some((t) => t.barColor)).toBe(true);
    expect(park.tasks.some((t) => (t.checklist?.total ?? 0) > 0)).toBe(true);
    expect(park.tasks.some((t) => t.overBudget)).toBe(true);
    // Groups carry the sum of their children; the project the sum of its roots.
    const roots = park.tasks.filter((t) => !t.parentId);
    const sum = roots.reduce((s, t) => s + Math.round((t.plannedCost ?? 0) * 100), 0) / 100;
    expect(park.project.plannedCost).toBe(sum);
    const hours = await api.projects.gantt(HOURS);
    expect(hours.project.durationUnit).toBe('HOUR');
    const leaf = hours.tasks.find((t) => t.type === 'TASK')!;
    expect(leaf.startDate).toMatch(/T\d{2}:\d{2}$/);
    const days = new Set(hours.tasks.filter((t) => t.type === 'TASK').map((t) => t.startDate.slice(0, 10)));
    expect(days.size).toBe(2);
    expect((await api.portfolios.list())[0]!.projectIds).toEqual([PARK, CLEAN]);
    expect((await api.projects.templates()).map((p) => p.id)).toEqual([TEMPLATE]);
    const comments = await api.tasks.comments(park.tasks.find((t) => t.name === 'تسوية الأرض')!.id);
    expect(comments.length).toBeGreaterThanOrEqual(4);
    expect(comments.some((c) => c.replyTo)).toBe(true);
  });
});

describe('budget, undo contract (ADR-093, ADR-095)', () => {
  it('rolls costs up and answers previous; the inverse batch restores; a stale inverse is 409', async () => {
    const { project, g, a } = await smallProject();
    expect(g.plannedCost).toBe(3500.5);
    expect(project.budget).toBe(10000);
    const up = await api.tasks.update(a.id, { version: a.version, actualCost: 1500, deadline: '2026-11-02', barColor: '#2e7d32', name: 'أ معدّلة' });
    expect(up.task).toMatchObject({ actualCost: 1500, overBudget: true, deadline: '2026-11-02', barColor: '#2E7D32' });
    expect(up.previous![a.id]).toEqual({ name: 'أ', actualCost: 0, deadline: null, barColor: null });
    expect(up.previous![g.id]).toEqual({ actualCost: 0 });
    // Inverse = the same batch endpoint with the versions of the answer.
    const versions = new Map([up.task, ...up.affected].map((t) => [t.id, t.version]));
    const inv = await api.tasks.batch(project.id, {
      changes: Object.entries(up.previous!).map(([id, p]) => ({ id, version: versions.get(id)!, ...p })),
    });
    const back = inv.tasks.find((t) => t.id === a.id)!;
    expect(back).toMatchObject({ name: 'أ', actualCost: 0, deadline: null, barColor: null });
    // Redo after someone else changed the task → 409 (ends the redo chain in the UI).
    const redo = await codeOf(api.tasks.batch(project.id, { changes: [{ id: a.id, version: back.version - 1, name: 'أ معدّلة' }] }));
    expect(redo.code).toBe('CONFLICT_VERSION');
    const dash = await api.projects.budget(project.id);
    expect(dash).toMatchObject({ plannedCost: 3500.5, budget: 10000, byGroup: [{ name: 'مجموعة', plannedCost: 3500.5 }] });
  });
});

describe('labels and custom fields (ADR-093)', () => {
  it('labels through the versioned path; deleting one takes it off its tasks with previous', async () => {
    const { project, a, b } = await smallProject();
    const l = await api.labels.create(project.id, { name: 'كهرباء', color: '#f9a825' });
    expect(l.color).toBe('#F9A825');
    expect((await codeOf(api.labels.create(project.id, { name: 'كهرباء', color: '#000000' }))).code).toBe('NAME_TAKEN');
    const r = await api.tasks.addLabel(a.id, l.id);
    expect(r.task.labelIds).toEqual([l.id]);
    expect(r.task.version).toBe(a.version + 1);
    const other = await api.projects.create({ name: 'مشروع آخر', startDate: '2026-11-01' });
    const foreign = await api.labels.create(other.id, { name: 'خارجي', color: '#123456' });
    expect((await codeOf(api.tasks.batch(project.id, { changes: [{ id: b.id, version: b.version, labelIds: [foreign.id] }] }))).code).toBe(
      'LABEL_NOT_IN_PROJECT',
    );
    const del = await api.labels.remove(l.id);
    expect(del.previous[a.id]).toEqual({ labelIds: [l.id] });
    expect((await api.tasks.labels(a.id)).length).toBe(0);
  });

  it('custom fields validate options and values; deleting a field drops the values', async () => {
    const { project, a } = await smallProject();
    expect((await codeOf(api.customFields.create(project.id, { name: 'قائمة', type: 'DROPDOWN', options: [] }))).code).toBe(
      'CUSTOM_FIELD_OPTIONS_REQUIRED',
    );
    const f = await api.customFields.create(project.id, { name: 'المقاول', type: 'DROPDOWN', options: ['أ', 'ب', 'أ'] });
    expect(f.options).toEqual(['أ', 'ب']);
    expect((await codeOf(api.tasks.setCustomValue(a.id, f.id, 'ج'))).code).toBe('CUSTOM_FIELD_VALUE_INVALID');
    await api.tasks.setCustomValue(a.id, f.id, 'ب');
    expect((await api.tasks.get(a.id)).customValues).toEqual({ [f.id]: 'ب' });
    expect((await api.tasks.customFields(a.id))[0]!.value).toBe('ب');
    await api.customFields.remove(f.id);
    expect((await api.tasks.get(a.id)).customValues).toEqual({});
    expect((await api.audit.list({ action: 'custom_field.deleted' })).total).toBe(1);
  });
});

describe('checklist (ADR-093)', () => {
  it('admins edit and reorder; the assignee only ticks', async () => {
    const { a } = await smallProject();
    const i1 = await api.tasks.addChecklistItem(a.id, { text: 'أول' });
    const i2 = await api.tasks.addChecklistItem(a.id, { text: 'ثانٍ' });
    const i0 = await api.tasks.addChecklistItem(a.id, { text: 'بينهما', afterId: i1.id });
    expect((await api.tasks.checklist(a.id)).map((i) => i.text)).toEqual(['أول', 'بينهما', 'ثانٍ']);
    expect((await codeOf(api.tasks.reorderChecklist(a.id, { ids: [i2.id, i1.id] }))).code).toBe('VALIDATION_FAILED');
    await api.tasks.reorderChecklist(a.id, { ids: [i2.id, i1.id, i0.id] });
    await loginAs(SUP1);
    const ticked = await api.tasks.updateChecklistItem(a.id, i2.id, { done: true });
    expect(ticked).toMatchObject({ done: true, doneBy: { id: SUP1_ID } });
    expect((await codeOf(api.tasks.updateChecklistItem(a.id, i2.id, { text: 'x' }))).code).toBe('FORBIDDEN');
    expect((await codeOf(api.tasks.addChecklistItem(a.id, { text: 'x' }))).code).toBe('FORBIDDEN');
    expect((await api.tasks.get(a.id)).checklist).toEqual({ total: 3, done: 1 });
  });
});

describe('duplicate, bulk, archive and restore (ADR-094)', () => {
  it('duplicates a group with its subtree right after it, remapping inner links', async () => {
    const { project, g, a } = await smallProject();
    await api.tasks.addChecklistItem(a.id, { text: 'بند' });
    const d = await api.tasks.duplicate(g.id);
    expect(d.tasks.map((t) => t.name)).toEqual(['مجموعة (نسخة)', 'أ (نسخة)', 'ب (نسخة)']);
    expect(d.dependencies).toHaveLength(1);
    expect(d.dependencies[0]!.predecessorId).toBe(d.idMap[a.id]);
    const gantt = await api.projects.gantt(project.id);
    expect(gantt.tasks.map((t) => t.wbs)).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.2']);
    expect((await api.tasks.checklist(d.idMap[a.id]!))[0]!.text).toBe('بند');
    expect((await api.audit.list({ action: 'task.duplicated' })).total).toBe(1);
  });

  it('bulk edits with one version per id; a stale one writes nothing', async () => {
    const { project, a, b } = await smallProject();
    const l = await api.labels.create(project.id, { name: 'وسم', color: '#123456' });
    const res = await api.tasks.bulk(project.id, {
      ids: [a.id, b.id],
      versions: { [a.id]: a.version, [b.id]: b.version },
      patch: { status: 'IN_PROGRESS', priority: 'HIGH', assigneeId: SUP2_ID, labelIdsAdd: [l.id], shiftWorkingDays: 1 },
    });
    const after = new Map(res.tasks.map((t) => [t.id, t]));
    expect(after.get(a.id)).toMatchObject({ status: 'IN_PROGRESS', priority: 'HIGH', labelIds: [l.id], startDate: '2026-11-02' });
    expect(after.get(b.id)!.assignee?.id).toBe(SUP2_ID);
    expect(res.previous[a.id]).toMatchObject({ status: 'NOT_STARTED', priority: 'MEDIUM', startDate: '2026-11-01' });
    const stale = await codeOf(api.tasks.bulk(project.id, { ids: [a.id], versions: { [a.id]: a.version }, patch: { status: 'DONE' } }));
    expect(stale.code).toBe('CONFLICT_VERSION');
    expect((await api.tasks.get(a.id)).status).toBe('IN_PROGRESS');
    await loginAs(SUP2);
    expect((await api.notifications.list()).items.some((x) => x.type === 'TASK_ASSIGNED' && x.payload.taskId === b.id)).toBe(true);
  });

  it('bulk archive returns deleted links; restore brings tasks back and the links can be re-created', async () => {
    const { project, a, b } = await smallProject();
    const arch = await api.tasks.bulkArchive(project.id, { ids: [b.id], versions: { [b.id]: b.version } });
    expect(arch.archivedIds).toEqual([b.id]);
    expect(arch.deletedDependencies).toHaveLength(1);
    const res = await api.tasks.restore(project.id, [b.id]);
    expect(res.restored[0]!.id).toBe(b.id);
    const dep = arch.deletedDependencies[0]!;
    await api.dependencies.create(project.id, { predecessorId: dep.predecessorId, successorId: dep.successorId, lagDays: dep.lagDays });
    expect((await api.projects.gantt(project.id)).dependencies).toHaveLength(1);
    expect((await api.audit.list({ action: 'task.restored' })).total).toBe(1);
    void a;
  });
});

describe('view preferences (ADR-097)', () => {
  it('per user and project; 32 KB cap', async () => {
    const { project } = await smallProject();
    await api.viewPrefs.put({ projectId: project.id, key: 'gantt.columns', value: [{ id: 'name', w: 260 }] });
    await api.viewPrefs.put({ key: 'projects.favourites', value: [project.id] });
    expect((await api.viewPrefs.list({ projectId: project.id })).map((p) => p.key)).toEqual(['gantt.columns']);
    expect((await api.viewPrefs.list()).map((p) => p.key)).toEqual(['projects.favourites']);
    const big = await codeOf(api.viewPrefs.put({ key: 'gantt.views', value: 'x'.repeat(33 * 1024) }));
    expect([big.code, big.status]).toEqual(['VIEW_PREF_TOO_LARGE', 413]);
    await loginAs(SUP1);
    expect(await api.viewPrefs.list()).toEqual([]);
    expect((await codeOf(api.viewPrefs.put({ projectId: project.id, key: 'gantt.columns', value: [] }))).code).toBe('NOT_FOUND');
    await loginAs(ADMIN);
    await api.viewPrefs.remove({ projectId: project.id, key: 'gantt.columns' });
    expect(await api.viewPrefs.list({ projectId: project.id })).toEqual([]);
  });
});

describe('templates and portfolios (ADR-094)', () => {
  it('saves a project as a template and creates a project from it with re-based dates', async () => {
    const { project } = await smallProject();
    const tpl = await api.projects.saveAsTemplate(project.id, {});
    expect(tpl).toMatchObject({ isTemplate: true, name: 'مشروع A9 (قالب)' });
    expect((await api.projects.list()).some((p) => p.id === tpl.id)).toBe(false);
    expect((await codeOf(api.projects.create({ name: 'خطأ', startDate: '2026-12-01', fromTemplateId: project.id }))).code).toBe('NOT_A_TEMPLATE');
    const p2 = await api.projects.create({ name: 'من القالب', startDate: '2026-12-06', fromTemplateId: tpl.id });
    const g2 = await api.projects.gantt(p2.id);
    expect(g2.tasks.map((t) => t.name)).toEqual(['مجموعة', 'أ', 'ب']);
    expect(g2.tasks[1]).toMatchObject({ startDate: '2026-12-06', assignee: null, progress: 0 });
    expect(g2.dependencies).toHaveLength(1);
    expect(p2.budget).toBe(10000);
  });

  it('portfolios: CRUD and a weighted summary', async () => {
    await loginAs(ADMIN);
    const pf = await api.portfolios.create({ name: 'محفظة اختبار', projectIds: [PARK] });
    await api.portfolios.addProject(pf.id, CLEAN);
    const sum = await api.portfolios.get(pf.id);
    expect(sum.projects).toHaveLength(2);
    expect(sum.totals.projectCount).toBe(2);
    expect(sum.totals.budget).toBe(520000);
    expect((await codeOf(api.portfolios.create({ name: 'محفظة اختبار' }))).code).toBe('NAME_TAKEN');
    expect((await codeOf(api.portfolios.addProject(pf.id, TEMPLATE))).code).toBe('NOT_FOUND');
    await api.portfolios.removeProject(pf.id, PARK);
    expect((await api.portfolios.get(pf.id)).projects.map((p) => p.project.id)).toEqual([CLEAN]);
    await api.portfolios.remove(pf.id);
    await loginAs(SUP1);
    expect((await codeOf(api.portfolios.list())).code).toBe('FORBIDDEN');
  });
});

describe('time log (ADR-096)', () => {
  it('supervisors log on their own tasks; others are hidden; admins log for anyone', async () => {
    const { a, b } = await smallProject();
    // Entry dates are bounded to today − 366 … today + 7 days (security review A9 L3).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-02T08:00:00Z') });
    await loginAs(SUP1);
    const e = await api.tasks.addTimeEntry(a.id, { date: '2026-11-01', minutes: 90, note: 'تجهيز' });
    expect(e).toMatchObject({ minutes: 90, user: { id: SUP1_ID }, task: { name: 'أ' } });
    expect((await codeOf(api.tasks.addTimeEntry(b.id, { date: '2026-11-01', minutes: 30 }))).code).toBe('NOT_FOUND');
    expect((await codeOf(api.tasks.addTimeEntry(a.id, { date: '2026-11-01', minutes: 30, userId: SUP2_ID }))).code).toBe('FORBIDDEN');
    expect((await api.timeEntries.mine({ from: '2026-10-25', to: '2026-11-05' })).map((x) => x.id)).toEqual([e.id]);
    await api.timeEntries.update(e.id, { minutes: 120 });
    await loginAs(ADMIN);
    const forSup = await api.tasks.addTimeEntry(b.id, { date: '2026-11-03', minutes: 60, userId: SUP2_ID });
    await loginAs(SUP1);
    expect((await codeOf(api.timeEntries.remove(forSup.id))).code).toBe('NOT_FOUND');
    await api.timeEntries.remove(e.id);
    expect(await api.timeEntries.mine({ from: '2026-10-25', to: '2026-11-05' })).toEqual([]);
  });
});

describe('read models (ADR-096)', () => {
  it('people, dashboard, calendar and the projects report; supervisors get 403', async () => {
    const { project, a } = await smallProject();
    const people = await api.projects.people(project.id);
    expect(people.find((p) => p.assignee?.id === SUP1_ID)).toMatchObject({ taskCount: 1, plannedCost: 1000 });
    const dash = await api.projects.dashboard(project.id);
    expect(dash.kpis.leafCount).toBe(2);
    expect(dash.budgetBurn.plannedByWeek.at(-1)!.cumulative).toBe(3500.5);
    const cal = await api.projects.calendar(project.id, { from: '2026-11-01', to: '2026-11-30' });
    expect(cal.items.map((i) => i.name)).toEqual(['مجموعة', 'أ', 'ب']);
    const rows = await api.projects.report();
    expect(rows.find((r) => r.project.id === project.id)).toMatchObject({ leafCount: 2, milestoneCount: 0 });
    await loginAs(SUP1);
    for (const p of [api.projects.budget(project.id), api.projects.dashboard(project.id), api.projects.report(), api.workload({ from: '2026-11-01', to: '2026-11-07' })]) {
      expect((await codeOf(p)).code).toBe('FORBIDDEN');
    }
    void a;
  });

  it('workload: a DAY task takes the working day (480), overlaps add up, logged minutes beside', async () => {
    // Far from the seeded projects so only these tasks count.
    await loginAs(ADMIN);
    const project = await api.projects.create({ name: 'عبء', startDate: '2027-06-06' });
    const a = await api.tasks.create(project.id, { name: 'أ', startDate: '2027-06-06', durationDays: 2, assigneeId: SUP1_ID });
    await api.tasks.create(project.id, { name: 'متزامنة', startDate: '2027-06-06', durationDays: 1, assigneeId: SUP1_ID });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-06-07T08:00:00Z') });
    await api.tasks.addTimeEntry(a.id, { date: '2027-06-06', minutes: 45, userId: SUP1_ID });
    vi.useRealTimers();
    const w = await api.workload({ from: '2027-06-06', to: '2027-06-08', userIds: [SUP1_ID] });
    expect(w.capacityMinutesPerDay).toBe(480);
    const row = w.people[0]!;
    expect(row.days.map((d) => d.assignedMinutes)).toEqual([960, 480, 0]);
    expect(row.days[0]!.loggedMinutes).toBe(45);
  });
});

describe('chat, read marks and the hub (ADR-097)', () => {
  it('quotes, read marks, TASK_COMMENTED to the assignee, unread counts in the hub', async () => {
    const { a } = await smallProject();
    const c1 = await api.tasks.addComment(a.id, { body: 'كيف التقدّم؟', mentions: [] });
    await loginAs(SUP1);
    const notes = (await api.notifications.list()).items;
    expect(notes.find((x) => x.type === 'TASK_COMMENTED')?.payload).toMatchObject({ taskId: a.id, preview: 'كيف التقدّم؟' });
    let hub = await api.hub.list({ filter: 'new' });
    expect(hub.items.find((i) => i.task.id === a.id)?.unreadCount).toBe(1);
    const reply = await api.tasks.addComment(a.id, { body: 'نصف العمل منجز', mentions: [ADMIN_ID], replyToId: c1.id });
    expect(reply.replyTo).toMatchObject({ id: c1.id, bodyPreview: 'كيف التقدّم؟' });
    hub = await api.hub.list({ filter: 'new' });
    expect(hub.items.some((i) => i.task.id === a.id)).toBe(false);
    const thread = await api.tasks.comments(a.id);
    expect(thread.map((c) => c.body)).toEqual(['كيف التقدّم؟', 'نصف العمل منجز']);
    expect(thread[0]!.createdAt < thread[1]!.createdAt).toBe(true);
    await loginAs(ADMIN);
    hub = await api.hub.list({ filter: 'mentioned' });
    expect(hub.items[0]!.task.id).toBe(a.id);
    expect(hub.counts.new).toBeGreaterThanOrEqual(1);
    await api.tasks.markRead(a.id);
    expect((await api.hub.list({ filter: 'new' })).items.some((i) => i.task.id === a.id)).toBe(false);
    const other = await api.tasks.create(a.projectId, { name: 'أخرى', startDate: '2026-11-01' });
    expect((await codeOf(api.tasks.addComment(other.id, { body: 'x', replyToId: c1.id }))).code).toBe('COMMENT_REPLY_INVALID');
  });

  it('a passed deadline notifies the assignee and the owner once', async () => {
    await loginAs(ADMIN);
    const project = await api.projects.create({ name: 'مواعيد', startDate: '2026-09-01' });
    const t = await api.tasks.create(project.id, { name: 'فات موعدها', startDate: '2026-09-01', durationDays: 1, assigneeId: SUP1_ID, deadline: '2026-09-02' });
    expect(t.deadlinePassed).toBe(true);
    await api.phase4.sweepReminders();
    const sent = await api.phase4.sweepReminders();
    expect(sent).toBe(0);
    const mine = (await api.notifications.list({ pageSize: 100 })).items.filter((x) => x.type === 'TASK_DEADLINE_PASSED' && x.payload.taskId === t.id);
    expect(mine).toHaveLength(1);
    await loginAs(SUP1);
    expect((await api.notifications.list({ pageSize: 100 })).items.some((x) => x.type === 'TASK_DEADLINE_PASSED' && x.payload.taskId === t.id)).toBe(true);
  });
});

describe('HOUR projects (ADR-105)', () => {
  it('schedule in working minutes over the lunch break and across the weekend', async () => {
    await loginAs(ADMIN);
    const p = await api.projects.create({ name: 'تركيب', startDate: '2026-11-05', durationUnit: 'HOUR' });
    expect(p.durationUnit).toBe('HOUR');
    // Thursday 2026-11-05 11:00 + 6 working hours → 11–13 and 14–18 → ends Thursday 18:00.
    const a = await api.tasks.create(p.id, { name: 'أ', startDate: '2026-11-05T11:00', durationHours: 6 });
    expect(a).toMatchObject({ startDate: '2026-11-05T11:00', endDate: '2026-11-05T18:00', durationHours: 6, durationDays: 1 });
    // Its FS successor starts on Sunday 09:00 (Fri/Sat weekend).
    const b = await api.tasks.create(p.id, { name: 'ب', startDate: '2026-11-05T09:00', durationHours: 2.5 });
    const dep = await api.dependencies.create(p.id, { predecessorId: a.id, successorId: b.id });
    expect(dep.affected.find((t) => t.id === b.id)).toMatchObject({ startDate: '2026-11-08T09:00', endDate: '2026-11-08T11:30' });
    // A start inside the lunch break snaps to 14:00; the batch keeps the duration.
    const g = await api.projects.gantt(p.id);
    const aa = g.tasks.find((t) => t.id === a.id)!;
    const moved = await api.tasks.batch(p.id, { changes: [{ id: a.id, version: aa.version, startDate: '2026-11-05T13:15' }] });
    expect(moved.tasks.find((t) => t.id === a.id)).toMatchObject({ startDate: '2026-11-05T14:00', endDate: '2026-11-08T11:00', durationHours: 6 });
    expect(moved.tasks.find((t) => t.id === b.id)).toMatchObject({ startDate: '2026-11-08T11:00' });
    expect(moved.previous![a.id]).toMatchObject({ startDate: '2026-11-05T11:00' });
  });
});
