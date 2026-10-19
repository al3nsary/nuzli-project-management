/**
 * Phase 4 demo seed (seed/demo/projects.json + calendars.json). Dates are relative to the day
 * the demo is opened (Riyadh), so overdue, due-soon and the sample holidays always show.
 * Every project is run through the same engine as the API (`recompute`), so the stored dates
 * already satisfy the FS dependencies.
 */
import { WorkCalendar, addCalendarDays } from '@nuzli/scheduling';
import type { DependencyType, Priority, ProjectStatus, TaskStatus, TaskType } from '@nuzli/shared';
import projectsSeed from '../../../../../seed/demo/projects.json';
import calendarsSeed from '../../../../../seed/demo/calendars.json';
import { recompute, riyadhToday, workCalendarOf } from '../../features/projects/engine';
import type {
  DemoCalendar,
  DemoDependency,
  DemoProject,
  DemoProjectAccess,
  DemoTask,
} from './db';

interface SeedTask {
  k: string;
  n: string;
  t?: 'G' | 'M';
  p?: string;
  o?: number;
  d?: number;
  deps?: string[];
  a?: number;
  pr?: number;
  s?: string;
  pri?: string;
}

interface SeedProject {
  id: string;
  name: string;
  description: string;
  status: string;
  calendarId: string;
  autoSchedule: boolean;
  startOffsetDays: number;
  access: string[];
  tasks?: SeedTask[];
  generate?: { groups: number; leavesPerGroup: number };
}

export interface ProjectSeed {
  calendars: DemoCalendar[];
  projects: DemoProject[];
  tasks: DemoTask[];
  dependencies: DemoDependency[];
  access: DemoProjectAccess[];
}

export const ADMIN_OWNER_ID = '00000000-0000-4000-8000-000000000001';
export const LARGE_PROJECT_ID = '00000000-0000-4000-8000-f00000000003';

/** Deterministic ids: `…-8000-d<project><index>` (12 hex digits). */
const taskId = (project: number, i: number) =>
  `00000000-0000-4000-8000-d${String(project)}${String(i).padStart(10, '0')}`;
const depId = (project: number, i: number) =>
  `00000000-0000-4000-8000-9${String(project)}${String(i).padStart(10, '0')}`;

const TYPE: Record<string, TaskType> = { G: 'GROUP', M: 'MILESTONE' };

function seedCalendars(today: string): DemoCalendar[] {
  return calendarsSeed.calendars.map((c) => {
    const base = new WorkCalendar({ weekendDays: c.weekendDays });
    return {
      id: c.id,
      name: c.name,
      weekendDays: [...c.weekendDays],
      isDefault: c.isDefault,
      createdAt: c.createdAt,
      exceptions: c.exceptions.map((e) => ({
        id: e.id,
        // A sample holiday on a weekend would change nothing: move it to the next working day.
        date: base.addWorkingDays(addCalendarDays(today, e.offsetDays), 0),
        isWorking: e.isWorking,
        name: e.name,
      })),
    };
  });
}

function baseTask(projectId: string, id: string, createdAt: string): Omit<DemoTask, 'name' | 'type' | 'parentId' | 'sortOrder'> {
  return {
    id,
    projectId,
    wbsCache: '',
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
    createdById: ADMIN_OWNER_ID,
    archivedAt: null,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    createdAt,
  };
}

export function buildProjectSeed(now: Date = new Date()): ProjectSeed {
  const today = riyadhToday(now);
  const createdAt = now.toISOString();
  const calendars = seedCalendars(today);
  const supervisors = projectsSeed.supervisors as Record<string, string>;
  const out: ProjectSeed = { calendars, projects: [], tasks: [], dependencies: [], access: [] };

  (projectsSeed.projects as SeedProject[]).forEach((p, pi) => {
    const pn = pi + 1;
    const calRow = calendars.find((c) => c.id === p.calendarId) ?? calendars[0]!;
    const cal = workCalendarOf(calRow);
    const start = cal.addWorkingDays(addCalendarDays(today, p.startOffsetDays), 0);
    out.projects.push({
      id: p.id,
      name: p.name,
      description: p.description,
      startDate: start,
      status: p.status as ProjectStatus,
      calendarId: calRow.id,
      autoSchedule: p.autoSchedule,
      ownerId: ADMIN_OWNER_ID,
      createdAt,
      archivedAt: null,
    });
    for (const a of p.access) {
      out.access.push({
        id: `${p.id.slice(0, -2)}a${a}`,
        projectId: p.id,
        userId: supervisors[a]!,
        level: 'VIEW',
        createdAt,
      });
    }

    const tasks: DemoTask[] = [];
    const deps: DemoDependency[] = [];
    const leaf = (o: number, d: number, type: TaskType) => {
      const s = cal.addWorkingDays(start, o);
      return { startDate: s, endDate: cal.endFromDuration(s, type === 'MILESTONE' ? 0 : d), durationDays: type === 'MILESTONE' ? 0 : d };
    };
    const addDep = (pred: string, succ: string) =>
      deps.push({
        id: depId(pn, deps.length + 1),
        projectId: p.id,
        predecessorId: pred,
        successorId: succ,
        type: 'FS' as DependencyType,
        lagDays: 0,
        createdAt,
      });

    if (p.tasks) {
      const ids = new Map(p.tasks.map((t, i) => [t.k, taskId(pn, i + 1)]));
      const order = new Map<string, number>();
      p.tasks.forEach((t) => {
        const type = t.t ? TYPE[t.t]! : 'TASK';
        const parentKey = t.p ?? '';
        const sortOrder = (order.get(parentKey) ?? 0) + 1;
        order.set(parentKey, sortOrder);
        tasks.push({
          ...baseTask(p.id, ids.get(t.k)!, createdAt),
          ...leaf(t.o ?? 0, t.d ?? 1, type),
          name: t.n,
          type,
          parentId: t.p ? ids.get(t.p)! : null,
          sortOrder,
          progress: t.pr ?? 0,
          status: (t.s as TaskStatus) ?? ((t.pr ?? 0) > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'),
          priority: (t.pri as Priority) ?? 'MEDIUM',
          assigneeId: t.a ? supervisors[String(t.a)]! : null,
        });
        for (const k of t.deps ?? []) addDep(ids.get(k)!, ids.get(t.k)!);
      });
    } else if (p.generate) {
      // 200 groups × 9 chained leaves, staggered so the chart spans a few months.
      let i = 0;
      for (let g = 0; g < p.generate.groups; g++) {
        const gid = taskId(pn, ++i);
        tasks.push({
          ...baseTask(p.id, gid, createdAt),
          ...leaf(0, 1, 'GROUP'),
          name: `المجموعة ${g + 1}`,
          type: 'GROUP',
          parentId: null,
          sortOrder: g + 1,
        });
        let o = (g * 7) % 120;
        let prev: string | null = null;
        for (let l = 0; l < p.generate.leavesPerGroup; l++) {
          const id = taskId(pn, ++i);
          const d = 1 + ((g + l) % 3);
          tasks.push({
            ...baseTask(p.id, id, createdAt),
            ...leaf(o, d, 'TASK'),
            name: `مهمة ${g + 1}.${l + 1}`,
            type: 'TASK',
            parentId: gid,
            sortOrder: l + 1,
            // Unassigned: the performance project must not flood «مهامي» with hundreds of tasks.
            assigneeId: null,
          });
          if (prev) addDep(prev, id);
          prev = id;
          o += d;
        }
      }
    }
    const finals = recompute({ tasks, dependencies: deps, calendar: cal, autoSchedule: p.autoSchedule });
    out.tasks.push(...finals);
    out.dependencies.push(...deps);
  });
  return out;
}
