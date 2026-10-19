/**
 * Owner request A9 demo seed (seed/demo/a9.json, clearly marked «(تجريبي)»): runs once on top of
 * the Phase 4 seed (also on demo databases created before A9). It enriches the 60-task project
 * with a budget, labels, custom fields, planned/actual costs, deadlines (some passed), bar
 * colours, checklists, a chat between the admin and the supervisors and time entries; adds a
 * small HOUR-mode installation job over two days, one template and one portfolio. Every
 * project goes through the same engine as the API (`recompute`, costs rolled up).
 */
import { WorkCalendar, addCalendarDays } from '@nuzli/scheduling';
import type { Priority, TaskStatus, TaskType } from '@nuzli/shared';
import a9 from '../../../../../seed/demo/a9.json';
import projectsSeed from '../../../../../seed/demo/projects.json';
import { recompute, riyadhToday, rollUpCosts, rollUpStatus, withA9, workCalendarOf } from '../../features/projects/engine';
import type { DemoCalendar, DemoDb, DemoDependency, DemoProject, DemoTask } from './db';
import { ADMIN_OWNER_ID } from './seedProjects';

const SUPERVISORS = projectsSeed.supervisors as Record<string, string>;
const TYPE: Record<string, TaskType> = { G: 'GROUP', M: 'MILESTONE' };

/** Same deterministic ids as seedProjects.ts (`…-8000-d<project><index>`). */
const taskId = (project: number, i: number) => `00000000-0000-4000-8000-d${String(project)}${String(i).padStart(10, '0')}`;
const depId = (project: number, i: number) => `00000000-0000-4000-8000-9${String(project)}${String(i).padStart(10, '0')}`;
const itemId = (n: number) => `00000000-0000-4000-8000-b1${String(n).padStart(10, '0')}`;
const commentId = (n: number) => `00000000-0000-4000-8000-b2${String(n).padStart(10, '0')}`;
const entryId = (n: number) => `00000000-0000-4000-8000-b3${String(n).padStart(10, '0')}`;

interface SeedA9Task {
  c?: number;
  ac?: number;
  dl?: number;
  col?: string;
  lb?: string[];
  cf?: Record<string, string | number>;
  cl?: string[][];
}

interface MiniTask {
  k: string;
  n: string;
  t?: string;
  p?: string;
  o?: number;
  d?: number;
  h?: number;
  deps?: string[];
  a?: number;
  pr?: number;
  s?: string;
  c?: number;
  ac?: number;
  cl?: string[];
}

const who = (by: string | number) => (by === 'admin' ? ADMIN_OWNER_ID : SUPERVISORS[String(by)]!);

function blankTask(projectId: string, id: string, createdAt: string): DemoTask {
  return {
    id,
    projectId,
    parentId: null,
    sortOrder: 1,
    wbsCache: '',
    name: '',
    type: 'TASK',
    startDate: '',
    endDate: '',
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeId: null,
    description: null,
    version: 0,
    plannedCost: 0,
    actualCost: 0,
    deadline: null,
    barColor: null,
    labelIds: [],
    archivedAt: null,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    createdAt,
    createdById: ADMIN_OWNER_ID,
  };
}

/** Builds a small project from compact rows (o/d working days, or h hours in an HOUR project). */
function buildMini(
  pn: number,
  projectId: string,
  rows: MiniTask[],
  cal: WorkCalendar,
  start: string,
  createdAt: string,
  unit: 'DAY' | 'HOUR',
): { tasks: DemoTask[]; deps: DemoDependency[]; ids: Map<string, string> } {
  const ids = new Map(rows.map((t, i) => [t.k, taskId(pn, i + 1)]));
  const order = new Map<string, number>();
  const deps: DemoDependency[] = [];
  const tasks = rows.map((t) => {
    const type = t.t ? TYPE[t.t]! : 'TASK';
    const parentKey = t.p ?? '';
    const sortOrder = (order.get(parentKey) ?? 0) + 1;
    order.set(parentKey, sortOrder);
    const base = blankTask(projectId, ids.get(t.k)!, createdAt);
    let dates: Pick<DemoTask, 'startDate' | 'endDate' | 'durationDays'> & { durationHours?: number };
    if (unit === 'HOUR') {
      const minutes = type === 'MILESTONE' ? 0 : Math.round((t.h ?? 1) * 60);
      dates = { startDate: start, endDate: type === 'MILESTONE' ? start : cal.endFromDurationMinutes(start, minutes), durationDays: 1, durationHours: minutes / 60 };
    } else {
      const s = cal.addWorkingDays(start, t.o ?? 0);
      const d = type === 'MILESTONE' ? 0 : (t.d ?? 1);
      dates = { startDate: s, endDate: cal.endFromDuration(s, d), durationDays: d };
    }
    for (const k of t.deps ?? []) {
      deps.push({ id: depId(pn, deps.length + 1), projectId, predecessorId: ids.get(k)!, successorId: ids.get(t.k)!, type: 'FS', lagDays: 0, createdAt });
    }
    return {
      ...base,
      ...dates,
      name: t.n,
      type,
      parentId: t.p ? ids.get(t.p)! : null,
      sortOrder,
      progress: t.pr ?? 0,
      status: (t.s as TaskStatus) ?? ((t.pr ?? 0) > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'),
      priority: 'MEDIUM' as Priority,
      assigneeId: t.a ? SUPERVISORS[String(t.a)]! : null,
      plannedCost: t.c ?? 0,
      actualCost: t.ac ?? 0,
    };
  });
  return { tasks, deps, ids };
}

export async function seedA9(db: DemoDb, now: Date = new Date()): Promise<void> {
  if (await db.kv.get('seededA9')) return;
  const today = riyadhToday(now);
  const createdAt = now.toISOString();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

  await db.transaction('rw', db.tables, async () => {
    // ------------------------------------------------ the 60-task project
    const park = a9.park;
    const project = await db.projects.get(park.projectId);
    if (project) {
      await db.projects.put({ ...project, budget: park.budget, currency: 'SAR', isTemplate: false, durationUnit: 'DAY' });
      const labelIds = new Map(park.labels.map((l) => [l.k, l.id]));
      const fieldIds = new Map(park.fields.map((f) => [f.k, f.id]));
      await db.labels.bulkPut(park.labels.map((l) => ({ id: l.id, projectId: park.projectId, name: l.name, color: l.color, createdAt })));
      await db.customFields.bulkPut(
        park.fields.map((f, i) => ({ id: f.id, projectId: park.projectId, name: f.name, type: f.type as 'DROPDOWN' | 'NUMBER', options: f.options, sort: i + 1, createdAt })),
      );
      const keys = new Map((projectsSeed.projects[0]!.tasks ?? []).map((t, i) => [t.k, taskId(1, i + 1)]));
      const rows = (await db.tasks.where('projectId').equals(park.projectId).toArray()).map(withA9);
      const byId = new Map(rows.map((r) => [r.id, r]));
      let item = 0;
      for (const [k, spec] of Object.entries(park.tasks as Record<string, SeedA9Task>)) {
        const id = keys.get(k);
        const row = id ? byId.get(id) : undefined;
        if (!row) continue;
        row.plannedCost = spec.c ?? 0;
        row.actualCost = spec.ac ?? 0;
        row.deadline = spec.dl !== undefined ? addCalendarDays(today, spec.dl) : null;
        row.barColor = spec.col ?? null;
        row.labelIds = (spec.lb ?? []).map((l) => labelIds.get(l)!).filter(Boolean).sort();
        row.customValues = Object.fromEntries(Object.entries(spec.cf ?? {}).map(([f, v]) => [fieldIds.get(f)!, v]));
        for (const [i, [text, done]] of (spec.cl ?? []).entries()) {
          await db.checklist.put({
            id: itemId(++item),
            taskId: row.id,
            text: text!,
            done: done === 'x',
            sort: i + 1,
            doneById: done === 'x' ? row.assigneeId : null,
            doneAt: done === 'x' ? minutesAgo(600 + i * 60) : null,
            createdAt,
          });
        }
      }
      await db.tasks.bulkPut(rollUpStatus(rollUpCosts([...byId.values()])));

      // Chat between the admin and the supervisors (flat threads with quotes).
      const threadIds = new Map<string, string[]>();
      park.comments.forEach((c, i) => {
        const list = threadIds.get(c.t) ?? [];
        list.push(commentId(i + 1));
        threadIds.set(c.t, list);
      });
      const seen = new Map<string, number>();
      for (const [i, c] of park.comments.entries()) {
        const tid = keys.get(c.t)!;
        const n = seen.get(c.t) ?? 0;
        seen.set(c.t, n + 1);
        const re = (c as { re?: number }).re;
        await db.taskComments.put({
          id: commentId(i + 1),
          taskId: tid,
          authorId: who(c.by),
          body: c.b,
          mentions: [],
          createdAt: minutesAgo(c.m),
          replyToId: re !== undefined ? threadIds.get(c.t)![re]! : null,
        });
        void n;
      }
      // The admin read every thread up to two hours ago (newer supervisor replies stay unread).
      for (const t of threadIds.keys()) {
        await db.commentReads.put({ id: `${ADMIN_OWNER_ID}|${keys.get(t)}`, userId: ADMIN_OWNER_ID, taskId: keys.get(t)!, lastReadAt: minutesAgo(120) });
      }
      for (const [i, e] of park.time.entries()) {
        await db.timeEntries.put({
          id: entryId(i + 1),
          taskId: keys.get(e.t)!,
          userId: SUPERVISORS[String(e.u)]!,
          date: addCalendarDays(today, e.d),
          minutes: e.min,
          note: (e as { n?: string }).n ?? null,
          createdAt,
        });
      }
    }

    // ------------------------------------------------ the HOUR-mode installation job (2 days)
    const defaultCal = (await db.calendars.toArray()).find((c) => c.isDefault) as DemoCalendar | undefined;
    if (defaultCal) {
      const hp = a9.hourProject;
      const cal = workCalendarOf(defaultCal);
      const startDay = cal.addWorkingDays(today, 0);
      const start = cal.nextWorkingMinute(`${startDay}T09:00`);
      const p: DemoProject = {
        id: hp.id,
        name: hp.name,
        description: hp.description,
        startDate: startDay,
        status: 'ACTIVE',
        calendarId: defaultCal.id,
        autoSchedule: true,
        ownerId: ADMIN_OWNER_ID,
        createdAt,
        archivedAt: null,
        budget: hp.budget,
        currency: 'SAR',
        isTemplate: false,
        durationUnit: 'HOUR',
      };
      const mini = buildMini(4, p.id, hp.tasks, cal, start, createdAt, 'HOUR');
      const finals = recompute({ tasks: mini.tasks, dependencies: mini.deps, calendar: cal, autoSchedule: true, durationUnit: 'HOUR' });
      await db.projects.put(p);
      await db.tasks.bulkPut(finals);
      await db.dependencies.bulkPut(mini.deps);

      // ------------------------------------------------ one template (DAY)
      const tp = a9.template;
      const tStart = cal.addWorkingDays(addCalendarDays(today, 7), 0);
      const tpl: DemoProject = {
        id: tp.id,
        name: tp.name,
        description: tp.description,
        startDate: tStart,
        status: 'PLANNING',
        calendarId: defaultCal.id,
        autoSchedule: true,
        ownerId: ADMIN_OWNER_ID,
        createdAt,
        archivedAt: null,
        budget: null,
        currency: 'SAR',
        isTemplate: true,
        durationUnit: 'DAY',
      };
      const tmini = buildMini(5, tpl.id, tp.tasks, cal, tStart, createdAt, 'DAY');
      await db.projects.put(tpl);
      await db.tasks.bulkPut(recompute({ tasks: tmini.tasks, dependencies: tmini.deps, calendar: cal, autoSchedule: true }));
      await db.dependencies.bulkPut(tmini.deps);
      let n = 900;
      for (const row of tp.tasks) {
        for (const [i, text] of (row.cl ?? []).entries()) {
          await db.checklist.put({ id: itemId(++n), taskId: tmini.ids.get(row.k)!, text, done: false, sort: i + 1, doneById: null, doneAt: null, createdAt });
        }
      }
    }

    // ------------------------------------------------ one portfolio with two projects
    const pf = a9.portfolio;
    await db.portfolios.put({ id: pf.id, name: pf.name, description: pf.description, projectIds: pf.projectIds, createdAt });

    await db.kv.put({ key: 'seededA9', value: createdAt });
  });
}
