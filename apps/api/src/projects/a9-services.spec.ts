import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request';
import { createFakeDb, d, task, type FakeData } from '../../test/unit/fake-project-db';
import { HubService } from './hub.service';
import { ProjectReportsService } from './project-reports.service';
import { ProjectStore } from './project-store';
import { ProjectsService } from './projects.service';
import { TemplatesService } from './templates.service';
import { TasksService } from './tasks.service';
import { TimeEntriesService } from './time-entries.service';
import { ViewPrefsService } from './view-prefs.service';

const ctx: RequestContext = { actorId: 'admin', ip: null, requestId: 'r', userAgent: null };
const supCtx: RequestContext = { ...ctx, actorId: 'sup1' };
const ADMIN = { id: 'admin', role: 'ADMIN' as const, status: 'ACTIVE' as const, fullName: 'المدير' };
const SUP = { id: 'sup1', role: 'SUPERVISOR' as const, status: 'ACTIVE' as const, fullName: 'مشرف ١' };
const SUP2 = { id: 'sup2', role: 'SUPERVISOR' as const, status: 'ACTIVE' as const, fullName: 'مشرف ٢' };
const P = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const G = 'f0000000-0000-4000-8000-00000000000f';

async function code(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
}

function setup(over: Partial<FakeData> = {}) {
  const fake = createFakeDb({
    users: [
      { id: 'admin', fullName: 'المدير', role: 'ADMIN', status: 'ACTIVE' },
      { id: 'sup1', fullName: 'مشرف ١', role: 'SUPERVISOR', status: 'ACTIVE' },
      { id: 'sup2', fullName: 'مشرف ٢', role: 'SUPERVISOR', status: 'ACTIVE' },
    ],
    calendars: [{ id: 'cal', name: 'افتراضي', weekendDays: [5, 6], exceptions: [{ id: 'h', date: d('2026-10-20'), isWorking: false, name: 'عطلة اختبار' }] }],
    projects: [
      { id: P, name: 'مشروع البرج', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', startDate: d('2026-10-11'), budget: 500 },
      { id: P2, name: 'مشروع الجسر', archivedAt: null, autoSchedule: true, calendarId: 'cal', ownerId: 'admin', startDate: d('2026-10-11') },
    ],
    tasks: [
      task({ id: G, projectId: P, type: 'GROUP', name: 'الأعمال', sortOrder: 1, wbsCache: '1', startDate: d('2026-10-11'), endDate: d('2026-10-14'), durationDays: 4, plannedCost: 300 }),
      task({ id: A, projectId: P, parentId: G, name: 'الحفر', sortOrder: 1, wbsCache: '1.1', assigneeId: 'sup1', startDate: d('2026-10-11'), endDate: d('2026-10-12'), durationDays: 2, plannedCost: 200, createdById: 'admin' }),
      task({ id: B, projectId: P, parentId: G, name: 'الصب', sortOrder: 2, wbsCache: '1.2', assigneeId: 'sup2', startDate: d('2026-10-13'), endDate: d('2026-10-14'), durationDays: 2, plannedCost: 100 }),
      task({ id: C, projectId: P2, name: 'التصميم', sortOrder: 1, wbsCache: '1', assigneeId: 'sup1', startDate: d('2026-10-11'), endDate: d('2026-10-11') }),
    ],
    deps: [{ id: 'd1', projectId: P, predecessorId: A, successorId: B, type: 'FS', lagDays: 0 }],
    ...over,
  });
  const audit = new AuditService(fake.db as never);
  const store = new ProjectStore(fake.db as never, audit);
  const tasks = new TasksService(fake.db as never, store, audit, fake.notifications as never);
  const reports = new ProjectReportsService(fake.db as never, store);
  const templates = new TemplatesService(fake.db as never, store, audit, tasks, reports);
  const projects = new ProjectsService(fake.db as never, store, audit, templates);
  return {
    fake,
    store,
    tasks,
    reports,
    templates,
    projects,
    prefs: new ViewPrefsService(fake.db as never, store),
    time: new TimeEntriesService(fake.db as never, store, audit),
    hub: new HubService(fake.db as never),
  };
}

describe('A9 supervisors do not see projects (ADR-092)', () => {
  it('project list is empty and project reads are 404 for a supervisor; their own task is readable', async () => {
    const { projects, reports, tasks } = setup();
    expect(await projects.list({}, SUP)).toEqual([]);
    expect(await code(projects.get(P, SUP))).toBe('NOT_FOUND');
    expect(await code(projects.gantt(P, SUP))).toBe('NOT_FOUND');
    expect(await code(reports.budget(P, SUP))).toBe('NOT_FOUND');
    expect((await tasks.get(A, SUP)).id).toBe(A);
    expect(await code(tasks.get(B, SUP))).toBe('NOT_FOUND');
    expect((await tasks.mine(SUP)).map((t) => t.id).sort()).toEqual([A, C].sort());
  });

  it('a project_access grant no longer opens the project', async () => {
    const { projects } = setup({ access: [{ projectId: P, userId: 'sup1' }] });
    expect(await projects.list({}, SUP)).toEqual([]);
    expect(await code(projects.get(P, SUP))).toBe('NOT_FOUND');
  });

  it('the Gantt payload carries labels, custom fields and per-task A9 extras for admins', async () => {
    const { projects } = setup({
      labels: [{ id: 'L1', projectId: P, name: 'كهرباء', color: '#303F9F' }],
      taskLabels: [{ taskId: A, labelId: 'L1' }],
      customFields: [{ id: 'F1', projectId: P, name: 'الكمية', type: 'NUMBER', options: [], sort: 1 }],
      customValues: [{ taskId: A, fieldId: 'F1', value: 3 }],
      checklist: [
        { id: 'i1', taskId: A, text: 'x', done: true, sort: 1 },
        { id: 'i2', taskId: A, text: 'y', done: false, sort: 2 },
      ],
    });
    const g = await projects.gantt(P, ADMIN);
    expect(g.labels).toEqual([{ id: 'L1', projectId: P, name: 'كهرباء', color: '#303F9F' }]);
    expect(g.customFields).toEqual([{ id: 'F1', projectId: P, name: 'الكمية', type: 'NUMBER', options: [], sort: 1 }]);
    expect(g.tasks.find((t) => t.id === A)).toMatchObject({ labelIds: ['L1'], customValues: { F1: 3 }, checklist: { total: 2, done: 1 }, plannedCost: 200 });
    expect(g.project).toMatchObject({ budget: 500, plannedCost: 300, budgetUsedPct: 0 });
  });
});

describe('A9 view preferences', () => {
  it('global and per-project values; upsert; 32 KB cap; a project must be visible', async () => {
    const { prefs, fake } = setup();
    await prefs.put(ADMIN, { key: 'gantt.columns', value: [{ id: 'name', width: 240 }] });
    await prefs.put(ADMIN, { key: 'gantt.columns', value: [{ id: 'name', width: 300 }] });
    await prefs.put(ADMIN, { projectId: P, key: 'gantt.columns', value: [{ id: 'cost' }] });
    expect(fake.data.viewPrefs).toHaveLength(2);
    expect((await prefs.list(ADMIN, {})).map((p) => p.value)).toEqual([[{ id: 'name', width: 300 }]]);
    expect((await prefs.list(ADMIN, { projectId: P, key: 'gantt.columns' }))[0]).toMatchObject({ projectId: P, value: [{ id: 'cost' }] });

    const big = 'x'.repeat(32 * 1024);
    const err = await prefs.put(ADMIN, { key: 'list.columns', value: big }).catch((e: unknown) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VIEW_PREF_TOO_LARGE');
    expect((err as AppError).status).toBe(413);
    expect(await code(prefs.put(SUP, { projectId: P, key: 'gantt.views', value: [] }))).toBe('NOT_FOUND');
    await prefs.remove(ADMIN, { projectId: P, key: 'gantt.columns' });
    expect(fake.data.viewPrefs).toHaveLength(1);
  });
});

describe('A9 time log', () => {
  it('a supervisor logs on their own task only, and edits only their own entries; admins may log for others', async () => {
    const { time, fake } = setup();
    const mine = await time.create(A, { date: '2026-10-12', minutes: 90, note: 'حفر' }, SUP, supCtx);
    expect(mine).toMatchObject({ minutes: 90, user: { id: 'sup1' }, task: { id: A, projectId: P, projectName: 'مشروع البرج' } });
    // B is not theirs → invisible.
    expect(await code(time.create(B, { date: '2026-10-12', minutes: 30 }, SUP, supCtx))).toBe('NOT_FOUND');
    expect(await code(time.create(A, { date: '2026-10-12', minutes: 30, userId: 'sup2' }, SUP, supCtx))).toBe('FORBIDDEN');
    const forOther = await time.create(B, { date: '2026-10-13', minutes: 60, userId: 'sup2' }, ADMIN, ctx);
    expect(forOther.user.id).toBe('sup2');
    // sup1 cannot see or change sup2's entry.
    expect(await code(time.update(forOther.id, { minutes: 10 }, SUP, supCtx))).toBe('NOT_FOUND');
    expect(await code(time.remove(forOther.id, SUP, supCtx))).toBe('NOT_FOUND');
    expect((await time.update(mine.id, { minutes: 120 }, SUP, supCtx)).minutes).toBe(120);
    expect((await time.update(forOther.id, { minutes: 45 }, ADMIN, ctx)).minutes).toBe(45);

    const range = await time.mine(SUP, { from: '2026-10-01', to: '2026-10-31' });
    expect(range.map((e) => e.id)).toEqual([mine.id]);
    expect(await code(time.mine(SUP, { from: '2026-10-31', to: '2026-10-01' }))).toBe('VALIDATION_FAILED');
    await time.remove(mine.id, SUP, supCtx);
    expect(fake.data.timeEntries).toHaveLength(1);
    expect(fake.data.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['time_entry.created', 'time_entry.updated', 'time_entry.deleted']));
  });

  it('logged minutes feed the budget report and the workload', async () => {
    const { time, reports } = setup();
    await time.create(A, { date: '2026-10-12', minutes: 90 }, SUP, supCtx);
    const budget = await reports.budget(P, ADMIN);
    expect(budget.loggedMinutes).toBe(90);
    expect(budget.byAssignee.find((r) => r.assignee?.id === 'sup1')?.loggedMinutes).toBe(90);
    const w = await reports.workload({ from: '2026-10-11', to: '2026-10-14' });
    const sup1 = w.people.find((p) => p.user.id === 'sup1')!;
    // A (Sun 11–Mon 12) and C (Sun 11): 8 + 8 on Sun, 8 on Mon.
    expect(sup1.days.map((x) => x.assignedMinutes / 60)).toEqual([16, 8, 0, 0]);
    expect(sup1.days[1]!.loggedMinutes).toBe(90);
    expect(await code(reports.workload({ from: '2026-01-01', to: '2026-12-31' }))).toBe('VALIDATION_FAILED');
  });
});

describe('A9 communication hub', () => {
  const at = (h: number) => new Date(`2026-10-18T${String(h).padStart(2, '0')}:00:00Z`);
  const hubData = (): Partial<FakeData> => ({
    comments: [
      { id: 'c1', taskId: A, authorId: 'admin', body: 'ابدأ الحفر', mentions: [], createdAt: at(8) },
      { id: 'c2', taskId: A, authorId: 'sup1', body: 'بدأنا', mentions: ['admin'], createdAt: at(9) },
      { id: 'c3', taskId: A, authorId: 'admin', body: 'ممتاز', mentions: ['sup1'], createdAt: at(10) },
      { id: 'c4', taskId: B, authorId: 'sup2', body: 'الخرسانة متأخرة', mentions: [], createdAt: at(11) },
      { id: 'c5', taskId: C, authorId: 'admin', body: 'راجع المخطط', mentions: [], createdAt: at(7) },
    ],
    commentReads: [{ userId: 'sup1', taskId: A, lastReadAt: at(9) }],
  });

  it('a supervisor sees only their tasks, with unread counts, the last comment and the parent path', async () => {
    const { hub } = setup(hubData());
    const page = await hub.hub(SUP, { filter: 'all', page: 1, pageSize: 25 });
    expect(page.items.map((i) => i.task.id)).toEqual([A, C]);
    const a = page.items[0]!;
    expect(a).toMatchObject({ commentCount: 3, unreadCount: 1, path: ['الأعمال'], project: { id: P, name: 'مشروع البرج' } });
    expect(a.lastComment).toMatchObject({ id: 'c3', bodyPreview: 'ممتاز', author: { id: 'admin' } });
    expect(page.items[1]).toMatchObject({ unreadCount: 1, path: [] });
    expect(page.counts).toEqual({ all: 2, new: 2, mentioned: 1, assigned: 2, created: 0 });
    expect(page.unreadTotal).toBe(2);
  });

  it('filters (new, mentioned, assigned, created), project filter and search; admins see every task', async () => {
    const { hub } = setup(hubData());
    const ids = async (q: Partial<Parameters<HubService['hub']>[1]>, viewer: typeof ADMIN | typeof SUP = ADMIN) =>
      (await hub.hub(viewer, { filter: 'all', page: 1, pageSize: 25, ...q })).items.map((i) => i.task.id);
    expect(await ids({})).toEqual([B, A, C]);
    expect(await ids({ filter: 'mentioned' })).toEqual([A]);
    expect(await ids({ filter: 'created' })).toEqual([A]);
    // C carries only the admin's own comment, so it is not new for the admin.
    expect(await ids({ filter: 'new' })).toEqual([B, A]);
    expect(await ids({ projectId: P2 })).toEqual([C]);
    expect(await ids({ q: 'الخرسانة' })).toEqual([B]);
    expect(await ids({ q: 'الحفر' })).toEqual([A]);
    expect(await ids({ filter: 'mentioned' }, SUP)).toEqual([A]);
    expect(await ids({}, SUP2)).toEqual([B]);
    // Own comments are never unread; after reading, nothing is new.
    expect(await ids({ filter: 'new' }, SUP2)).toEqual([]);
  });

  it('pagination keeps the counts of the whole result', async () => {
    const { hub } = setup(hubData());
    const page = await hub.hub(ADMIN, { filter: 'all', page: 2, pageSize: 2 });
    expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.items.map((i) => i.task.id)).toEqual([C]);
  });
});

describe('A9 attachments browser', () => {
  const files = (): Partial<FakeData> => ({
    files: [
      { id: 'f1', entityType: 'task', entityId: A, mimeType: 'image/jpeg', sizeBytes: 10, uploadedById: 'sup1', status: 'READY', deletedAt: null, createdAt: new Date('2026-10-12T08:00:00Z') },
      { id: 'f2', entityType: 'task', entityId: B, mimeType: 'application/pdf', sizeBytes: 20, uploadedById: 'admin', status: 'READY', deletedAt: null, createdAt: new Date('2026-10-13T08:00:00Z') },
      { id: 'f3', entityType: 'task', entityId: C, mimeType: 'application/pdf', sizeBytes: 30, uploadedById: 'admin', status: 'READY', deletedAt: null, createdAt: new Date('2026-10-14T08:00:00Z') },
      { id: 'f4', entityType: 'task', entityId: A, mimeType: 'image/png', sizeBytes: 5, uploadedById: 'sup1', status: 'PENDING', deletedAt: null, createdAt: new Date('2026-10-14T09:00:00Z') },
      { id: 'f5', entityType: 'violation', entityId: A, mimeType: 'image/png', sizeBytes: 5, uploadedById: 'admin', status: 'READY', deletedAt: null, createdAt: new Date('2026-10-14T09:00:00Z') },
    ],
  });

  it('admins see every READY task file with task, project and uploader; supervisors only files of their tasks', async () => {
    const { hub } = setup(files());
    const all = await hub.attachments(ADMIN, { page: 1, pageSize: 25 });
    expect(all.items.map((f) => f.id)).toEqual(['f3', 'f2', 'f1']);
    expect(all.items[2]).toMatchObject({ type: 'image', task: { id: A, name: 'الحفر', wbs: '1.1' }, project: { id: P }, uploadedBy: { id: 'sup1', fullName: 'مشرف ١' } });
    const sup = await hub.attachments(SUP, { page: 1, pageSize: 25 });
    expect(sup.items.map((f) => f.id)).toEqual(['f3', 'f1']);
    expect((await hub.attachments(SUP2, { page: 1, pageSize: 25 })).items.map((f) => f.id)).toEqual(['f2']);
  });

  it('filters: project, type, uploader, date range (Riyadh days) and search by task or project name', async () => {
    const { hub } = setup(files());
    const ids = async (q: Record<string, unknown>) => (await hub.attachments(ADMIN, { page: 1, pageSize: 25, ...q })).items.map((f) => f.id);
    expect(await ids({ projectId: P })).toEqual(['f2', 'f1']);
    expect(await ids({ type: 'pdf' })).toEqual(['f3', 'f2']);
    expect(await ids({ type: 'image' })).toEqual(['f1']);
    expect(await ids({ type: 'other' })).toEqual([]);
    expect(await ids({ uploadedBy: 'admin' })).toEqual(['f3', 'f2']);
    expect(await ids({ from: '2026-10-13', to: '2026-10-13' })).toEqual(['f2']);
    expect(await ids({ q: 'الجسر' })).toEqual(['f3']);
    expect(await ids({ q: 'الصب' })).toEqual(['f2']);
  });
});

describe('A9 templates and portfolios', () => {
  it('save as template, then create a project from it: structure, deps, labels, fields and checklists copied; dates re-based; work reset', async () => {
    const { templates, projects, fake } = setup({
      labels: [{ id: 'L1', projectId: P, name: 'كهرباء', color: '#303F9F' }],
      taskLabels: [{ taskId: A, labelId: 'L1' }],
      customFields: [{ id: 'F1', projectId: P, name: 'الكمية', type: 'NUMBER', options: [], sort: 1 }],
      customValues: [{ taskId: A, fieldId: 'F1', value: 3 }],
      checklist: [{ id: 'i1', taskId: A, text: 'فحص', done: true, sort: 1, doneById: 'admin', doneAt: new Date() }],
    });
    fake.data.tasks.find((t) => t.id === A)!.progress = 60;
    const tpl = await templates.saveAsTemplate(P, {}, ADMIN, ctx);
    expect(tpl).toMatchObject({ name: 'مشروع البرج (قالب)', isTemplate: true, taskCount: 3, budget: 500 });
    expect((await templates.listTemplates(ADMIN)).map((x) => x.id)).toEqual([tpl.id]);
    // Templates are not in the project list.
    expect((await projects.list({}, ADMIN)).map((x) => x.id)).not.toContain(tpl.id);

    const created = await projects.create(
      { name: 'برج ٢', startDate: '2026-11-01', autoSchedule: true, status: 'PLANNING', fromTemplateId: tpl.id },
      ADMIN,
      ctx,
    );
    const tasks = fake.data.tasks.filter((t) => t.projectId === created.id);
    const byName = (n: string) => tasks.find((t) => t.name === n)!;
    expect(tasks).toHaveLength(3);
    expect(byName('الحفر')).toMatchObject({ startDate: d('2026-11-01'), endDate: d('2026-11-02'), progress: 0, assigneeId: null, plannedCost: 200, status: 'NOT_STARTED' });
    expect(byName('الصب')).toMatchObject({ startDate: d('2026-11-03'), endDate: d('2026-11-04') });
    expect(byName('الأعمال')).toMatchObject({ type: 'GROUP', plannedCost: 300, startDate: d('2026-11-01'), endDate: d('2026-11-04') });
    expect(byName('الحفر').parentId).toBe(byName('الأعمال').id);
    expect(fake.data.deps.filter((x) => x.projectId === created.id)).toEqual([
      expect.objectContaining({ predecessorId: byName('الحفر').id, successorId: byName('الصب').id }),
    ]);
    const newLabel = fake.data.labels.find((l) => l.projectId === created.id)!;
    expect(fake.labelsOf(byName('الحفر').id)).toEqual([newLabel.id]);
    expect(fake.data.customFields.filter((f) => f.projectId === created.id)).toHaveLength(1);
    expect(fake.data.customValues.filter((v) => v.taskId === byName('الحفر').id)).toHaveLength(0);
    expect(fake.data.checklist.filter((i) => i.taskId === byName('الحفر').id)).toEqual([expect.objectContaining({ text: 'فحص', done: false })]);
    expect(created).toMatchObject({ budget: 500, plannedCost: 300, startDate: '2026-11-01' });
    expect(fake.data.audit.find((a) => a.action === 'project.created' && a.entityId === created.id)?.after).toMatchObject({ fromTemplateId: tpl.id, tasks: 3 });

    expect(await code(projects.create({ name: 'x', startDate: '2026-11-01', autoSchedule: true, status: 'PLANNING', fromTemplateId: P }, ADMIN, ctx))).toBe('NOT_A_TEMPLATE');
  });

  it('portfolio CRUD and summary', async () => {
    const { templates } = setup();
    const pf = await templates.createPortfolio({ name: 'محفظة الرياض', projectIds: [P] }, ctx);
    expect(pf.projectIds).toEqual([P]);
    expect(await code(templates.createPortfolio({ name: 'محفظة الرياض' }, ctx))).toBe('NAME_TAKEN');
    await templates.setPortfolioProject(pf.id, P2, true, ctx);
    const summary = await templates.portfolioSummary(pf.id, ADMIN, new Date('2026-10-19T06:00:00Z'));
    expect(summary.projects.map((p) => p.project.id).sort()).toEqual([P, P2].sort());
    expect(summary.totals).toMatchObject({ projectCount: 2, budget: 500, plannedCost: 300, actualCost: 0, startDate: '2026-10-11', overdueCount: 3 });
    const removed = await templates.setPortfolioProject(pf.id, P2, false, ctx);
    expect(removed.projectIds).toEqual([P]);
    await templates.deletePortfolio(pf.id, ctx);
    expect(await templates.listPortfolios()).toEqual([]);
  });
});
