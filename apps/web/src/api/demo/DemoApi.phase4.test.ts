/**
 * DemoApi Phase 4 follows the as-built API (ADR-056..060): server-side scheduling on every
 * write, versions, supervisor rights, cycles, collaboration, reminders, calendars and Excel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskDto } from '@nuzli/shared';
import { DemoApi } from './DemoApi';
import { DEMO_PASSWORD } from './constants';
import { ApiError } from '../errors';
import { LARGE_PROJECT_ID } from './seedProjects';
import { blobToArrayBuffer } from '../../lib/bytes';

let n = 0;
let api: DemoApi;
beforeEach(() => {
  api = new DemoApi({ dbName: `nuzli-demo-p4-${Date.now()}-${n++}` });
});

const ADMIN = 'admin1@demo.nuzli.example';
const SUP1 = 'supervisor1@demo.nuzli.example';
const SUP1_ID = '00000000-0000-4000-8000-000000000003';
const SUP2_ID = '00000000-0000-4000-8000-000000000004';
const PARK = '00000000-0000-4000-8000-f00000000001';

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

/** Project + calendar with a known holiday (Monday 2026-11-09) and A → B → C (FS). */
async function chainProject() {
  await loginAs(ADMIN);
  const cal = await api.calendars.create({ name: 'تقويم اختبار', weekendDays: [5, 6] });
  await api.calendars.addException(cal.id, { date: '2026-11-09', isWorking: false, name: 'عطلة تجريبية' });
  const project = await api.projects.create({ name: 'مشروع القبول', startDate: '2026-11-01', calendarId: cal.id });
  const a = await api.tasks.create(project.id, { name: 'أ', startDate: '2026-11-01', durationDays: 3, assigneeId: SUP1_ID });
  const b = await api.tasks.create(project.id, { name: 'ب', startDate: '2026-11-04', durationDays: 2 });
  const c = await api.tasks.create(project.id, { name: 'ج', startDate: '2026-11-08', durationDays: 1 });
  await api.dependencies.create(project.id, { predecessorId: a.id, successorId: b.id });
  await api.dependencies.create(project.id, { predecessorId: b.id, successorId: c.id });
  const g = await api.projects.gantt(project.id);
  const byName = (name: string) => g.tasks.find((t) => t.name === name)!;
  return { project, cal, a: byName('أ'), b: byName('ب'), c: byName('ج') };
}

describe('seed (seed/demo/projects.json + calendars.json)', () => {
  it('has three projects, a 2,000-task one, FS dependencies and sample holidays marked (تجريبي)', async () => {
    await loginAs(ADMIN);
    const list = await api.projects.list();
    expect(list).toHaveLength(3);
    const large = await api.projects.gantt(LARGE_PROJECT_ID);
    expect(large.tasks).toHaveLength(2000);
    expect(large.dependencies.length).toBeGreaterThan(1500);
    const park = await api.projects.gantt(PARK);
    expect(park.tasks.length).toBeGreaterThanOrEqual(55);
    expect(park.tasks.some((t) => t.type === 'MILESTONE')).toBe(true);
    expect(park.tasks.some((t) => t.assignee?.teamColor && t.assignee.teamName)).toBe(true);
    const holidays = park.calendar.exceptions.filter((e) => !e.isWorking);
    expect(holidays.length).toBeGreaterThan(0);
    for (const h of holidays) expect(h.name).toContain('(تجريبي)');
    // The seed already satisfies every FS link.
    const tasks = new Map(park.tasks.map((t) => [t.id, t]));
    for (const d of park.dependencies) expect(tasks.get(d.successorId)!.startDate > tasks.get(d.predecessorId)!.endDate).toBe(true);
  });
});

describe('acceptance (brief §16 Phase 4)', () => {
  it('delaying a task shifts its FS successors over working days, skipping Fri/Sat and a sample holiday', async () => {
    const { project, a, b, c } = await chainProject();
    expect([a.startDate, a.endDate]).toEqual(['2026-11-01', '2026-11-03']);
    expect([b.startDate, b.endDate]).toEqual(['2026-11-04', '2026-11-05']);
    expect(c.startDate).toBe('2026-11-08');

    // One drag-end: A moves to Wednesday 2026-11-04 (3 working days → ends Sunday 11-08).
    const res = await api.tasks.batch(project.id, {
      changes: [{ id: a.id, version: a.version, startDate: '2026-11-04', durationDays: 3 }],
    });
    const after = new Map(res.tasks.map((t) => [t.name, t]));
    expect(after.get('أ')).toMatchObject({ startDate: '2026-11-04', endDate: '2026-11-08' });
    // Monday 11-09 is the holiday → B starts Tuesday.
    expect(after.get('ب')).toMatchObject({ startDate: '2026-11-10', endDate: '2026-11-11', durationDays: 2 });
    expect(after.get('ج')).toMatchObject({ startDate: '2026-11-12', endDate: '2026-11-12' });
    for (const t of res.tasks) expect(t.version).toBeGreaterThan(0);
  });

  it('the server recomputes successors instead of trusting client dates', async () => {
    const { project, a, b } = await chainProject();
    const res = await api.tasks.batch(project.id, {
      changes: [
        { id: a.id, version: a.version, startDate: '2026-11-04', durationDays: 3 },
        // A wrong client preview for B (too early) is corrected by the forward pass.
        { id: b.id, version: b.version, startDate: '2026-11-05', durationDays: 2 },
      ],
    });
    expect(res.tasks.find((t) => t.id === b.id)!.startDate).toBe('2026-11-10');
  });
});

describe('optimistic concurrency (ADR-017)', () => {
  it('a stale version → 409 CONFLICT_VERSION with details, and nothing is written', async () => {
    const { project, a, b } = await chainProject();
    await api.tasks.update(b.id, { version: b.version, name: 'ب معدّلة' });
    const err = await codeOf(
      api.tasks.batch(project.id, {
        changes: [
          { id: a.id, version: a.version, startDate: '2026-11-05', durationDays: 3 },
          { id: b.id, version: b.version, startDate: '2026-11-10', durationDays: 2 },
        ],
      }),
    );
    expect(err.code).toBe('CONFLICT_VERSION');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ refresh: 'tasks', conflicts: [{ id: b.id, currentVersion: b.version + 1 }] });
    const g = await api.projects.gantt(project.id);
    expect(g.tasks.find((t) => t.id === a.id)!.startDate).toBe('2026-11-01');
  });
});

describe('supervisor rights (ADR-007, ADR-058)', () => {
  it('may change progress/status of own tasks only; never dates; sees the project read-only', async () => {
    const { project, a, b } = await chainProject();
    await loginAs(SUP1);
    const visible = await api.projects.list();
    expect(visible.map((p) => p.id)).toContain(project.id);
    const dateErr = await codeOf(api.tasks.update(a.id, { version: a.version, startDate: '2026-11-08' }));
    expect(dateErr.code).toBe('FORBIDDEN');
    expect((dateErr.details as { fields: string[] }).fields).toEqual(['startDate']);
    const ok = await api.tasks.update(a.id, { version: a.version, progress: 40, status: 'IN_PROGRESS' });
    expect(ok.task).toMatchObject({ progress: 40, status: 'IN_PROGRESS', startDate: a.startDate });
    expect((await codeOf(api.tasks.update(b.id, { version: b.version, progress: 10 }))).code).toBe('FORBIDDEN');
    expect((await codeOf(api.tasks.batch(project.id, { changes: [{ id: a.id, version: 1, startDate: '2026-11-08' }] }))).code).toBe(
      'FORBIDDEN',
    );
    expect((await codeOf(api.tasks.create(project.id, { name: 'x', startDate: '2026-11-01' }))).code).toBe('FORBIDDEN');
  });

  it('a supervisor without a grant or task sees nothing (404)', async () => {
    const { project } = await chainProject();
    await loginAs('supervisor3@demo.nuzli.example');
    expect((await codeOf(api.projects.gantt(project.id))).code).toBe('NOT_FOUND');
  });

  it('assignees are active supervisors only', async () => {
    const { project } = await chainProject();
    const err = await codeOf(
      api.tasks.create(project.id, { name: 'x', startDate: '2026-11-01', assigneeId: '00000000-0000-4000-8000-000000000002' }),
    );
    expect(err.code).toBe('ASSIGNEE_NOT_SUPERVISOR');
  });
});

describe('dependencies', () => {
  it('rejects a cycle with its path, a self link and a duplicate', async () => {
    const { project, a, c } = await chainProject();
    const cycle = await codeOf(api.dependencies.create(project.id, { predecessorId: c.id, successorId: a.id }));
    expect(cycle.code).toBe('DEPENDENCY_CYCLE');
    const path = (cycle.details as { path: string[] }).path;
    expect(path[0]).toBe(path.at(-1));
    expect(path).toContain(a.id);
    expect(path).toContain(c.id);
    expect((await codeOf(api.dependencies.create(project.id, { predecessorId: a.id, successorId: a.id }))).code).toBe(
      'DEPENDENCY_SELF',
    );
    const g = await api.projects.gantt(project.id);
    const ab = g.dependencies[0]!;
    expect(
      (await codeOf(api.dependencies.create(project.id, { predecessorId: ab.predecessorId, successorId: ab.successorId }))).code,
    ).toBe('DEPENDENCY_EXISTS');
    expect((await codeOf(api.dependencies.create(project.id, { predecessorId: a.id, successorId: c.id, type: 'SS' }))).code).toBe(
      'DEPENDENCY_TYPE_DISABLED',
    );
  });

  it('a new FS link shifts the successor and reports it in `affected`', async () => {
    const { project, c } = await chainProject();
    const d = await api.tasks.create(project.id, { name: 'د', startDate: '2026-11-01', durationDays: 1 });
    const dep = await api.dependencies.create(project.id, { predecessorId: c.id, successorId: d.id });
    expect(dep.affected.find((t) => t.id === d.id)!.startDate).toBe('2026-11-10');
  });
});

describe('hierarchy (ADR-057)', () => {
  it('a task that receives a child becomes a GROUP and rolls up; WBS follows', async () => {
    const { project, a } = await chainProject();
    const child = await api.tasks.create(project.id, { name: 'فرعية', parentId: a.id, startDate: '2026-11-15', durationDays: 2 });
    expect(child.wbs).toBe('1.1');
    const parent = child.affected.find((t) => t.id === a.id)!;
    expect(parent.type).toBe('GROUP');
    expect(parent.endDate).toBe(child.endDate);
    const ms = await api.tasks.create(project.id, { name: 'معلَم', type: 'MILESTONE', startDate: '2026-11-07', durationDays: 5 });
    expect(ms).toMatchObject({ durationDays: 0, startDate: '2026-11-08', endDate: '2026-11-08' });
    expect((await codeOf(api.tasks.create(project.id, { name: 'x', parentId: ms.id, startDate: '2026-11-01' }))).code).toBe(
      'TASK_PARENT_INVALID',
    );
  });

  it('archive removes the subtree and its links', async () => {
    const { project, b } = await chainProject();
    const res = await api.tasks.archive(b.id);
    expect(res.archivedIds).toEqual([b.id]);
    const g = await api.projects.gantt(project.id);
    expect(g.tasks.map((t) => t.name)).toEqual(['أ', 'ج']);
    expect(g.dependencies).toHaveLength(0);
  });
});

describe('collaboration and notifications (ADR-058, ADR-060)', () => {
  it('assignment and @mentions notify; comments are audited without the text', async () => {
    const { project, a } = await chainProject();
    // Mentions are limited to people who can see the project.
    const denied = await codeOf(api.tasks.addComment(a.id, { body: 'x', mentions: [SUP2_ID] }));
    expect(denied.code).toBe('VALIDATION_FAILED');
    await api.projects.grantAccess(project.id, { userId: SUP2_ID });
    await api.tasks.addComment(a.id, { body: 'راجع الجدول @سارة', mentions: [SUP2_ID] });
    await loginAs('supervisor2@demo.nuzli.example');
    const notes = await api.notifications.list();
    expect(notes.items.find((x) => x.type === 'TASK_MENTIONED')?.payload).toMatchObject({ taskId: a.id, taskName: 'أ' });
    await loginAs(SUP1);
    const mine = await api.notifications.list();
    expect(mine.items.some((x) => x.type === 'TASK_ASSIGNED' && x.payload.taskId === a.id)).toBe(true);
    // A supervisor may comment on any task of a visible project.
    await api.tasks.addComment(a.id, { body: 'تم', mentions: [] });
    expect(await api.tasks.comments(a.id)).toHaveLength(2);
    await loginAs(ADMIN);
    const activity = await api.tasks.activity(a.id);
    expect(activity.some((x) => x.action === 'task.comment_added')).toBe(true);
    expect(JSON.stringify(activity)).not.toContain('راجع الجدول');
  });

  it('due-soon and overdue are flagged in «مهامي» and notified once each', async () => {
    await loginAs(ADMIN);
    const project = await api.projects.create({ name: 'تذكيرات', startDate: '2026-10-01' });
    const today = new Date().toISOString().slice(0, 10);
    const overdue = await api.tasks.create(project.id, { name: 'متأخرة', startDate: '2026-09-01', durationDays: 1, assigneeId: SUP1_ID });
    await api.tasks.create(project.id, { name: 'قريبة', startDate: today, durationDays: 1, assigneeId: SUP1_ID });
    expect(await api.phase4.sweepReminders()).toBeGreaterThanOrEqual(2);
    expect(await api.phase4.sweepReminders()).toBe(0);
    await loginAs(SUP1);
    const mine = await api.tasks.mine();
    expect(mine.find((t) => t.id === overdue.id)).toMatchObject({ overdue: true, dueSoon: false, project: { name: 'تذكيرات' } });
    const types = (await api.notifications.list({ pageSize: 100 })).items.map((x) => x.type);
    expect(types.filter((x) => x === 'TASK_OVERDUE').length).toBeGreaterThanOrEqual(1);
  });
});

describe('calendars (ADR-059)', () => {
  it('a new holiday re-derives projects on the calendar; a duplicate date → 409', async () => {
    const { cal, c } = await chainProject();
    await api.calendars.addException(cal.id, { date: '2026-11-08', isWorking: false, name: 'عطلة أخرى' });
    const g = await api.projects.gantt(c.projectId);
    expect(g.tasks.find((t) => t.id === c.id)!.startDate).toBe('2026-11-10');
    const dup = await codeOf(api.calendars.addException(cal.id, { date: '2026-11-08', isWorking: false, name: 'مكرر' }));
    expect(dup.code).toBe('CALENDAR_DATE_EXISTS');
    await loginAs(SUP1);
    expect((await codeOf(api.calendars.list())).code).toBe('FORBIDDEN');
  });
});

describe('Excel (ADR-019, brief §7.7)', () => {
  it('exports the tasks RTL with no freeze panes', async () => {
    const { project } = await chainProject();
    const blob = await api.projects.exportXlsx(project.id);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blobToArrayBuffer(blob));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['المهام', 'المشروع']);
    for (const ws of wb.worksheets) {
      expect(ws.views[0]?.rightToLeft).toBe(true);
      expect(ws.views.some((v) => v.state === 'frozen')).toBe(false);
    }
    const rows = wb.getWorksheet('المهام')!.getSheetValues().filter(Boolean) as unknown[][];
    expect(rows).toHaveLength(4);
    expect((await api.audit.list({ action: 'project.exported' })).total).toBe(1);
  });
});

describe('task attachments (ADR-058)', () => {
  it('admins and the assignee upload; others are refused', async () => {
    const { a, b } = await chainProject();
    const pdf = new Blob([new TextEncoder().encode('%PDF-1.4 demo')], { type: 'application/pdf' });
    const p = await api.files.presign({ entityType: 'task', entityId: a.id, kind: 'ATTACHMENT', contentType: 'application/pdf', sizeBytes: pdf.size });
    await api.files.upload(p, pdf);
    await api.files.confirm(p.fileId);
    const list: Awaited<ReturnType<typeof api.tasks.attachments>> = await api.tasks.attachments(a.id);
    expect(list.map((x) => x.id)).toEqual([p.fileId]);
    const t: TaskDto = await api.tasks.get(a.id);
    expect(t.attachmentCount).toBe(1);
    await loginAs(SUP1);
    const denied = await codeOf(
      api.files.presign({ entityType: 'task', entityId: b.id, kind: 'ATTACHMENT', contentType: 'application/pdf', sizeBytes: 10 }),
    );
    expect(denied.code).toBe('FORBIDDEN');
  });
});
