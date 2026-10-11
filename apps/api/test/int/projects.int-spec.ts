/**
 * Phase 4 acceptance (brief §16): "Delaying a task shifts its FS successors over working days,
 * skipping Friday and Saturday and holidays." Plus optimistic concurrency (ADR-017), the DB
 * trigger for assignees, and the size of a 2,000-task Gantt payload (measured and logged).
 */
import type { TaskDto } from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import {
  bearer,
  bootstrapAdminSession,
  describeInt,
  startApp,
  validNationalId,
  type IntApp,
  type Session,
} from './helpers';

describeInt('projects, tasks and the server-side scheduler', () => {
  let ctx: IntApp;
  let admin: Session;
  let calendarId: string;
  let supervisorId: string;
  const api = (path: string) => `/api/v1${path}`;

  beforeAll(async () => {
    ctx = await startApp();
    admin = await bootstrapAdminSession(ctx);
    const cal = await ctx.http().post(api('/calendars')).set(bearer(admin)).send({ name: 'تقويم الاختبار' }).expect(201);
    calendarId = cal.body.id;
    expect(cal.body.weekendDays).toEqual([5, 6]);
    // Clearly a test holiday (no real holiday data is invented).
    await ctx
      .http()
      .post(api(`/calendars/${calendarId}/exceptions`))
      .set(bearer(admin))
      .send({ date: '2026-10-20', isWorking: false, name: 'عطلة اختبار' })
      .expect(201);
    const sup = await ctx
      .http()
      .post(api('/users'))
      .set(bearer(admin))
      .send({
        fullName: 'مشرف المشروع',
        email: 'sup-projects@nuzli.test',
        mobile: '+966550009001',
        nationalId: validNationalId('100009001'),
        role: 'SUPERVISOR',
      })
      .expect(201);
    supervisorId = sup.body.id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const createProject = async (name: string): Promise<string> =>
    (await ctx.http().post(api('/projects')).set(bearer(admin)).send({ name, startDate: '2026-10-11', calendarId }).expect(201)).body.id;

  const createTask = async (projectId: string, body: Record<string, unknown>): Promise<TaskDto> =>
    (await ctx.http().post(api(`/projects/${projectId}/tasks`)).set(bearer(admin)).send(body).expect(201)).body;

  it('delaying the first of 3 FS tasks shifts the successors, skipping Fri/Sat and the holiday', async () => {
    const projectId = await createProject('مشروع القبول');
    const a = await createTask(projectId, { name: 'أ', startDate: '2026-10-11', durationDays: 2 });
    const b = await createTask(projectId, { name: 'ب', startDate: '2026-10-13', durationDays: 2 });
    const c = await createTask(projectId, { name: 'ج', startDate: '2026-10-15', durationDays: 2 });
    expect(c).toMatchObject({ startDate: '2026-10-15', endDate: '2026-10-18', wbs: '3' });
    for (const [p, s] of [
      [a, b],
      [b, c],
    ] as const) {
      await ctx.http().post(api(`/projects/${projectId}/dependencies`)).set(bearer(admin)).send({ predecessorId: p.id, successorId: s.id }).expect(201);
    }

    const res = await ctx
      .http()
      .post(api(`/projects/${projectId}/tasks/batch`))
      .set(bearer(admin))
      .send({ changes: [{ id: a.id, version: a.version, startDate: '2026-10-14' }] })
      .expect(200);
    const byId = new Map((res.body.tasks as TaskDto[]).map((t) => [t.id, t]));
    expect(byId.get(a.id)).toMatchObject({ startDate: '2026-10-14', endDate: '2026-10-15' });
    expect(byId.get(b.id)).toMatchObject({ startDate: '2026-10-18', endDate: '2026-10-19', version: b.version + 1 });
    expect(byId.get(c.id)).toMatchObject({ startDate: '2026-10-21', endDate: '2026-10-22', version: c.version + 1 });

    const gantt = await ctx.http().get(api(`/projects/${projectId}/gantt`)).set(bearer(admin)).expect(200);
    expect(gantt.body.tasks.map((t: TaskDto) => t.wbs)).toEqual(['1', '2', '3']);
    expect(gantt.body.dependencies).toHaveLength(2);
    expect(gantt.body.calendar.exceptions).toEqual([expect.objectContaining({ date: '2026-10-20', isWorking: false })]);
    expect(gantt.body.project.endDate).toBe('2026-10-22');

    // A cycle is refused with its path.
    const cycle = await ctx.http().post(api(`/projects/${projectId}/dependencies`)).set(bearer(admin)).send({ predecessorId: c.id, successorId: a.id }).expect(409);
    expect(cycle.body.code).toBe('DEPENDENCY_CYCLE');
    expect(cycle.body.details.path[0]).toBe(cycle.body.details.path.at(-1));
  });

  it('a concurrent batch with a stale version → 409 CONFLICT_VERSION and nothing written', async () => {
    const projectId = await createProject('مشروع التزامن');
    const a = await createTask(projectId, { name: 'أ', startDate: '2026-10-11', durationDays: 1 });
    const b = await createTask(projectId, { name: 'ب', startDate: '2026-10-12', durationDays: 1 });

    const first = ctx.http().post(api(`/projects/${projectId}/tasks/batch`)).set(bearer(admin)).send({ changes: [{ id: a.id, version: a.version, startDate: '2026-10-13' }] });
    const second = ctx
      .http()
      .post(api(`/projects/${projectId}/tasks/batch`))
      .set(bearer(admin))
      .send({ changes: [{ id: b.id, version: b.version, progress: 30 }, { id: a.id, version: a.version, startDate: '2026-10-14' }] });
    const [r1, r2] = await Promise.all([first, second]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.code).toBe('CONFLICT_VERSION');
    expect(loser.body.details.conflicts).toEqual([{ id: a.id, currentVersion: a.version + 1 }]);

    const rows = await ctx.prisma.task.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
    // B untouched when the second batch lost; A has exactly one write.
    expect(rows.find((r) => r.id === a.id)?.version).toBe(a.version + 1);
    if (loser === r2) expect(Number(rows.find((r) => r.id === b.id)?.progress)).toBe(0);
  });

  it('assignees must be active supervisors — in the service and in the database trigger', async () => {
    const projectId = await createProject('مشروع الإسناد');
    const t = await createTask(projectId, { name: 'مهمة', startDate: '2026-10-11', durationDays: 1, assigneeId: supervisorId });
    expect(t.assignee).toMatchObject({ id: supervisorId, fullName: 'مشرف المشروع' });
    const adminId = (await ctx.prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id;
    const bad = await ctx.http().patch(api(`/tasks/${t.id}`)).set(bearer(admin)).send({ version: t.version, assigneeId: adminId }).expect(400);
    expect(bad.body.code).toBe('ASSIGNEE_NOT_SUPERVISOR');
    await expect(ctx.prisma.task.update({ where: { id: t.id }, data: { assigneeId: adminId } })).rejects.toThrow(/ASSIGNEE_NOT_SUPERVISOR/);
  });

  it('a 2,000-task project: the Gantt endpoint returns everything in one response (timed)', async () => {
    const projectId = await createProject('مشروع كبير');
    const groups = 200;
    const perGroup = 9;
    const rows: Array<Record<string, unknown>> = [];
    const deps: Array<Record<string, unknown>> = [];
    let prevLeaf: string | null = null;
    for (let g = 0; g < groups; g++) {
      const gid = randomUUID();
      rows.push({ id: gid, projectId, parentId: null, sortOrder: g + 1, name: `مجموعة ${g + 1}`, type: 'GROUP', startDate: new Date('2026-10-11'), endDate: new Date('2026-10-11'), durationDays: 1 });
      for (let k = 0; k < perGroup; k++) {
        const id = randomUUID();
        rows.push({ id, projectId, parentId: gid, sortOrder: k + 1, name: `مهمة ${g + 1}.${k + 1}`, type: 'TASK', startDate: new Date('2026-10-11'), endDate: new Date('2026-10-11'), durationDays: 1 });
        if (prevLeaf) deps.push({ projectId, predecessorId: prevLeaf, successorId: id });
        prevLeaf = id;
      }
    }
    await ctx.prisma.task.createMany({ data: rows as never });
    await ctx.prisma.taskDependency.createMany({ data: deps as never });

    // Let the server derive the whole schedule once (calendar re-apply), then read the chart.
    let t0 = Date.now();
    await ctx.http().patch(api(`/projects/${projectId}`)).set(bearer(admin)).send({ autoSchedule: false }).expect(200);
    await ctx.http().patch(api(`/projects/${projectId}`)).set(bearer(admin)).send({ autoSchedule: true }).expect(200);
    const scheduleMs = Date.now() - t0;

    t0 = Date.now();
    const res = await ctx.http().get(api(`/projects/${projectId}/gantt`)).set(bearer(admin)).expect(200);
    const ganttMs = Date.now() - t0;
    expect(res.body.tasks).toHaveLength(2000);
    expect(res.body.dependencies).toHaveLength(1799);
    expect(res.body.tasks[1].wbs).toBe('1.1');
    console.log(`[int] 2,000 tasks: full reschedule ${scheduleMs} ms, GET /gantt ${ganttMs} ms, ${JSON.stringify(res.body).length} bytes`);
    expect(ganttMs).toBeLessThan(10_000);
  });
});
