/**
 * Owner request A9 against PostgreSQL: budget roll-up and variance, duplicate with remapped
 * dependencies and copied details, the communication hub with unread counts, and the
 * supervisor scope (no projects, only their tasks). Skipped without Docker (describeInt).
 */
import type { BudgetReportDto, DuplicateTaskResult, HubPageDto, ProjectDto, TaskDto } from '@nuzli/shared';
import { bearer, bootstrapAdminSession, describeInt, login, startApp, validNationalId, type IntApp, type Session } from './helpers';

describeInt('A9 — budget, duplicate, hub and supervisor scope', () => {
  let ctx: IntApp;
  let admin: Session;
  let sup: Session;
  let supId: string;
  const api = (path: string) => `/api/v1${path}`;

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
    const created = await ctx
      .http()
      .post(api('/users'))
      .set(bearer(admin))
      .send({ fullName: 'مشرف الميزانية', email: 'sup-a9@nuzli.test', mobile: '+966550009101', nationalId: validNationalId('100009101'), role: 'SUPERVISOR' })
      .expect(201);
    supId = created.body.id;
    // The admin-created account must set its password; use the DB to set a known one for the test.
    const { PasswordService } = await import('../../src/auth/password.service');
    const hash = await ctx.app.get(PasswordService).hash('SupPass12345');
    await ctx.prisma.user.update({ where: { id: supId }, data: { passwordHash: hash, mustChangePassword: false, status: 'ACTIVE' } });
    sup = await login(ctx, 'sup-a9@nuzli.test', 'SupPass12345');
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const task = async (projectId: string, body: Record<string, unknown>): Promise<TaskDto> =>
    (await ctx.http().post(api(`/projects/${projectId}/tasks`)).set(bearer(admin)).send(body).expect(201)).body;

  it('budget roll-up, project variance and the budget report', async () => {
    const p: ProjectDto = (await ctx.http().post(api('/projects')).set(bearer(admin)).send({ name: 'مشروع الميزانية', startDate: '2026-10-11', budget: 1000 }).expect(201)).body;
    expect(p).toMatchObject({ budget: 1000, currency: 'SAR', plannedCost: 0 });
    const g = await task(p.id, { name: 'المرحلة الأولى', startDate: '2026-10-11', type: 'GROUP' });
    const a = await task(p.id, { name: 'أ', startDate: '2026-10-11', durationDays: 2, parentId: g.id, plannedCost: 600, actualCost: 650.5, assigneeId: supId });
    await task(p.id, { name: 'ب', startDate: '2026-10-13', durationDays: 2, parentId: g.id, plannedCost: 250.25, actualCost: 100 });

    const gantt = (await ctx.http().get(api(`/projects/${p.id}/gantt`)).set(bearer(admin)).expect(200)).body;
    expect(gantt.tasks.find((t: TaskDto) => t.id === g.id)).toMatchObject({ plannedCost: 850.25, actualCost: 750.5 });
    expect(gantt.project).toMatchObject({ plannedCost: 850.25, actualCost: 750.5, costVariance: 99.75, budgetVariance: 249.5, budgetUsedPct: 75.05 });

    const r: BudgetReportDto = (await ctx.http().get(api(`/projects/${p.id}/budget`)).set(bearer(admin)).expect(200)).body;
    expect(r.overBudgetTasks).toEqual([expect.objectContaining({ taskId: a.id, overBy: 50.5 })]);
    expect(r.byAssignee.find((x) => x.assignee?.id === supId)).toMatchObject({ plannedCost: 600, actualCost: 650.5 });

    // A CHECK constraint backs the API validation.
    await expect(ctx.prisma.task.update({ where: { id: a.id }, data: { actualCost: -1 } })).rejects.toThrow();
  });

  it('duplicate copies the subtree with remapped dependencies, labels and checklist', async () => {
    const p: ProjectDto = (await ctx.http().post(api('/projects')).set(bearer(admin)).send({ name: 'مشروع التكرار', startDate: '2026-10-11' }).expect(201)).body;
    const g = await task(p.id, { name: 'مجموعة', startDate: '2026-10-11', type: 'GROUP' });
    const a = await task(p.id, { name: 'أ', startDate: '2026-10-11', durationDays: 1, parentId: g.id });
    const b = await task(p.id, { name: 'ب', startDate: '2026-10-12', durationDays: 1, parentId: g.id });
    await ctx.http().post(api(`/projects/${p.id}/dependencies`)).set(bearer(admin)).send({ predecessorId: a.id, successorId: b.id }).expect(201);
    const label = (await ctx.http().post(api(`/projects/${p.id}/labels`)).set(bearer(admin)).send({ name: 'عاجل', color: '#E53935' }).expect(201)).body;
    await ctx.http().post(api(`/tasks/${a.id}/labels`)).set(bearer(admin)).send({ labelId: label.id }).expect(200);
    await ctx.http().post(api(`/tasks/${a.id}/checklist`)).set(bearer(admin)).send({ text: 'فحص' }).expect(201);

    const dup: DuplicateTaskResult = (await ctx.http().post(api(`/tasks/${g.id}/duplicate`)).set(bearer(admin)).send({}).expect(201)).body;
    expect(dup.tasks.map((t) => t.name)).toEqual(['مجموعة (نسخة)', 'أ (نسخة)', 'ب (نسخة)']);
    expect(dup.tasks[0]!.wbs).toBe('2');
    expect(dup.dependencies).toEqual([expect.objectContaining({ predecessorId: dup.idMap[a.id], successorId: dup.idMap[b.id] })]);
    expect(dup.tasks[1]).toMatchObject({ labelIds: [label.id], checklist: { total: 1, done: 0 } });
  });

  it('supervisor: no projects; their task, its chat and the hub with unread counts', async () => {
    const p: ProjectDto = (await ctx.http().post(api('/projects')).set(bearer(admin)).send({ name: 'مشروع التواصل', startDate: '2026-10-11' }).expect(201)).body;
    const mine = await task(p.id, { name: 'مهمتي', startDate: '2026-10-11', assigneeId: supId });
    const other = await task(p.id, { name: 'ليست لي', startDate: '2026-10-11' });

    await ctx.http().get(api('/projects')).set(bearer(sup)).expect(403);
    await ctx.http().get(api(`/projects/${p.id}/gantt`)).set(bearer(sup)).expect(403);
    await ctx.http().get(api(`/tasks/${mine.id}`)).set(bearer(sup)).expect(200);
    await ctx.http().get(api(`/tasks/${other.id}`)).set(bearer(sup)).expect(404);

    await ctx.http().post(api(`/tasks/${mine.id}/comments`)).set(bearer(admin)).send({ body: 'ابدأ اليوم' }).expect(201);
    await ctx.http().post(api(`/tasks/${other.id}/comments`)).set(bearer(admin)).send({ body: 'لا يراه المشرف' }).expect(201);
    let hub: HubPageDto = (await ctx.http().get(api('/hub')).set(bearer(sup)).expect(200)).body;
    expect(hub.items.map((i) => i.task.id)).toEqual([mine.id]);
    expect(hub.items[0]).toMatchObject({ unreadCount: 1, commentCount: 1 });

    const reply = await ctx.http().post(api(`/tasks/${mine.id}/comments`)).set(bearer(sup)).send({ body: 'تمام' }).expect(201);
    expect(reply.body.author.id).toBe(supId);
    hub = (await ctx.http().get(api('/hub?filter=new')).set(bearer(sup)).expect(200)).body;
    expect(hub.items).toHaveLength(0);

    const adminHub: HubPageDto = (await ctx.http().get(api(`/hub?projectId=${p.id}`)).set(bearer(admin)).expect(200)).body;
    expect(adminHub.counts.all).toBe(2);
    expect(adminHub.items.find((i) => i.task.id === mine.id)?.unreadCount).toBe(1);
    await ctx.http().post(api(`/tasks/${mine.id}/comments/read`)).set(bearer(admin)).expect(200);
    const after: HubPageDto = (await ctx.http().get(api(`/hub?projectId=${p.id}&filter=new`)).set(bearer(admin)).expect(200)).body;
    expect(after.items).toHaveLength(0);

    const notes = await ctx.prisma.notification.findMany({ where: { type: 'TASK_COMMENTED' } });
    expect(notes.map((n) => n.userId).sort()).toEqual(expect.arrayContaining([supId]));
  });
});
