/**
 * A small in-memory stand-in for the Prisma calls made by the Phase 4 services, so the unit
 * tests exercise the real service code (locks, version checks, recompute, persist, audit)
 * without Docker. `$transaction` snapshots the data and restores it when the callback throws,
 * which is how a failed batch is shown to write nothing.
 */
import { randomUUID } from 'node:crypto';

export interface FakeTask {
  id: string;
  projectId: string;
  parentId: string | null;
  sortOrder: number;
  wbsCache: string;
  name: string;
  type: 'TASK' | 'GROUP' | 'MILESTONE';
  startDate: Date;
  endDate: Date;
  durationDays: number;
  progress: number;
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'ON_HOLD';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  assigneeId: string | null;
  description: string | null;
  version: number;
  archivedAt: Date | null;
  dueSoonNotifiedAt: Date | null;
  overdueNotifiedAt: Date | null;
}

export interface FakeUser {
  id: string;
  fullName: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'MONITOR';
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
}

export interface FakeData {
  users: FakeUser[];
  projects: Array<{ id: string; name: string; archivedAt: Date | null; autoSchedule: boolean; calendarId: string; ownerId: string }>;
  calendars: Array<{ id: string; name: string; weekendDays: number[]; exceptions: Array<{ id: string; date: Date; isWorking: boolean; name: string }> }>;
  access: Array<{ projectId: string; userId: string }>;
  tasks: FakeTask[];
  deps: Array<{ id: string; projectId: string; predecessorId: string; successorId: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lagDays: number }>;
  audit: Array<Record<string, unknown>>;
  notifications: Array<{ userId: string; type: string; payload: unknown }>;
}

export const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const iso = (x: Date): string => x.toISOString().slice(0, 10);

export function task(over: Partial<FakeTask> & { id: string; projectId: string }): FakeTask {
  return {
    parentId: null,
    sortOrder: 1,
    wbsCache: '',
    name: over.id,
    type: 'TASK',
    startDate: d('2026-10-11'),
    endDate: d('2026-10-11'),
    durationDays: 1,
    progress: 0,
    status: 'NOT_STARTED',
    priority: 'MEDIUM',
    assigneeId: null,
    description: null,
    version: 0,
    archivedAt: null,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    ...over,
  };
}

function clone(data: FakeData): FakeData {
  return {
    ...data,
    projects: data.projects.map((p) => ({ ...p })),
    calendars: data.calendars.map((c) => ({ ...c, exceptions: c.exceptions.map((e) => ({ ...e })) })),
    access: data.access.map((a) => ({ ...a })),
    tasks: data.tasks.map((t) => ({ ...t })),
    deps: data.deps.map((x) => ({ ...x })),
    audit: [...data.audit],
    notifications: [...data.notifications],
  };
}

type Where = Record<string, unknown>;

/** Matches the handful of where shapes the services use. */
function matchTask(t: FakeTask, w: Where, data: FakeData): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === 'project') {
      const p = data.projects.find((x) => x.id === t.projectId)!;
      if (!matchProject(p, v as Where, data)) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(v as Where[]).every((x) => matchTask(t, x, data))) return false;
      continue;
    }
    const cur = (t as unknown as Record<string, unknown>)[k];
    if (v === null) {
      if (cur !== null) return false;
    } else if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
      if ('not' in o) {
        if (o.not === null ? cur === null : cur === o.not) return false;
      }
      const cmp = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('lt' in o && !(cmp(cur) < cmp(o.lt))) return false;
      if ('lte' in o && !(cmp(cur) <= cmp(o.lte))) return false;
      if ('gte' in o && !(cmp(cur) >= cmp(o.gte))) return false;
    } else if (cur instanceof Date && v instanceof Date) {
      if (cur.getTime() !== v.getTime()) return false;
    } else if (cur !== v) return false;
  }
  return true;
}

function matchProject(p: FakeData['projects'][number], w: Where, data: FakeData): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === 'AND') {
      if (!(v as Where[]).every((x) => matchProject(p, x, data))) return false;
    } else if (k === 'OR') {
      const ok = (v as Where[]).some((alt) => {
        if ('access' in alt) {
          const userId = ((alt.access as Where).some as Where).userId;
          return data.access.some((a) => a.projectId === p.id && a.userId === userId);
        }
        if ('tasks' in alt) {
          const userId = ((alt.tasks as Where).some as Where).assigneeId;
          return data.tasks.some((t) => t.projectId === p.id && t.assigneeId === userId && !t.archivedAt);
        }
        return false;
      });
      if (!ok) return false;
    } else if (k === 'id') {
      if (typeof v === 'object' && v && 'in' in (v as Where)) {
        if (!((v as Where).in as string[]).includes(p.id)) return false;
      } else if (p.id !== v) return false;
    } else if (k === 'archivedAt') {
      if (v === null && p.archivedAt !== null) return false;
    }
  }
  return true;
}

export function createFakeDb(initial: Partial<FakeData>) {
  let data: FakeData = {
    users: [],
    projects: [],
    calendars: [],
    access: [],
    tasks: [],
    deps: [],
    audit: [],
    notifications: [],
    ...initial,
  };
  const calls = { taskUpdates: 0, taskCreates: 0 };

  const projectOut = (p: FakeData['projects'][number]) => {
    const cal = data.calendars.find((c) => c.id === p.calendarId)!;
    const owner = data.users.find((u) => u.id === p.ownerId) ?? { id: p.ownerId, fullName: 'owner' };
    return {
      ...p,
      description: null,
      startDate: d('2026-10-01'),
      status: 'ACTIVE',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      owner: { id: owner.id, fullName: owner.fullName },
      calendar: { weekendDays: cal.weekendDays, exceptions: cal.exceptions },
    };
  };

  const taskOut = (t: FakeTask) => {
    const u = t.assigneeId ? data.users.find((x) => x.id === t.assigneeId) : undefined;
    const p = data.projects.find((x) => x.id === t.projectId)!;
    return {
      ...t,
      assignee: u ? { id: u.id, fullName: u.fullName, ledTeams: [] } : null,
      _count: { comments: 0 },
      project: { id: p.id, name: p.name, archivedAt: p.archivedAt, calendarId: p.calendarId },
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    $queryRaw: jest.fn(() => Promise.resolve([])),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const snapshot = clone(data);
      try {
        return await fn(db);
      } catch (err) {
        data = snapshot;
        throw err;
      }
    }),
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(data.users.find((u) => u.id === where.id) ?? null)),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(data.users.filter((u) => where.id.in.includes(u.id))),
      ),
    },
    project: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const p = data.projects.find((x) => x.id === where.id);
        return Promise.resolve(p ? projectOut(p) : null);
      }),
      findFirst: jest.fn(({ where }: { where: Where }) => {
        const p = data.projects.find((x) => matchProject(x, where, data));
        return Promise.resolve(p ? projectOut(p) : null);
      }),
    },
    calendar: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(data.calendars.filter((c) => where.id.in.includes(c.id))),
      ),
    },
    task: {
      findFirst: jest.fn(({ where }: { where: Where }) => {
        const t = data.tasks.find((x) => matchTask(x, where, data));
        return Promise.resolve(t ? taskOut(t) : null);
      }),
      findMany: jest.fn(({ where, orderBy }: { where: Where; orderBy?: unknown }) => {
        const rows = data.tasks.filter((x) => matchTask(x, where, data)).map(taskOut);
        if (orderBy) rows.sort((a, b) => a.endDate.getTime() - b.endDate.getTime() || a.name.localeCompare(b.name));
        return Promise.resolve(rows);
      }),
      create: jest.fn(({ data: row }: { data: Partial<FakeTask> & { id: string; projectId: string } }) => {
        calls.taskCreates++;
        const t = task({ ...row, version: 0 } as FakeTask);
        data.tasks.push(t);
        return Promise.resolve(t);
      }),
      updateMany: jest.fn(({ where, data: patch }: { where: Where; data: Record<string, unknown> }) => {
        let count = 0;
        for (const t of data.tasks) {
          if (!matchTask(t, where, data)) continue;
          for (const [k, v] of Object.entries(patch)) {
            if (k === 'version' && typeof v === 'object' && v) t.version += (v as { increment: number }).increment;
            else (t as unknown as Record<string, unknown>)[k] = v;
          }
          count++;
        }
        calls.taskUpdates += count;
        return Promise.resolve({ count });
      }),
    },
    taskDependency: {
      findMany: jest.fn(({ where }: { where: { projectId: string } }) =>
        Promise.resolve(data.deps.filter((x) => x.projectId === where.projectId)),
      ),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(data.deps.find((x) => x.id === where.id) ?? null)),
      create: jest.fn(({ data: row }: { data: FakeData['deps'][number] }) => {
        data.deps.push({ ...row, id: row.id ?? randomUUID() });
        return Promise.resolve(row);
      }),
      deleteMany: jest.fn(({ where }: { where: { id: string | { in: string[] } } }) => {
        const ids = typeof where.id === 'string' ? [where.id] : where.id.in;
        const before = data.deps.length;
        data.deps = data.deps.filter((x) => !ids.includes(x.id));
        return Promise.resolve({ count: before - data.deps.length });
      }),
    },
    file: { groupBy: jest.fn(() => Promise.resolve([])) },
    auditLog: {
      create: jest.fn(({ data: row }: { data: Record<string, unknown> }) => {
        data.audit.push(row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn(({ data: rows }: { data: Array<Record<string, unknown>> }) => {
        data.audit.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
    },
  };

  const notifications = {
    notify: jest.fn((userIds: string[], type: string, payload: unknown) => {
      for (const userId of userIds) data.notifications.push({ userId, type, payload });
      return Promise.resolve();
    }),
    safe: jest.fn((p: Promise<unknown>) => void p),
  };

  return {
    db,
    notifications,
    calls,
    get data() {
      return data;
    },
    /** A stored task with ISO dates, for assertions. */
    t(id: string) {
      const x = data.tasks.find((y) => y.id === id)!;
      return { ...x, startDate: iso(x.startDate), endDate: iso(x.endDate) };
    },
  };
}
