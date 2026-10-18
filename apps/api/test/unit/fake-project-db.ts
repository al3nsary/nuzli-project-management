/**
 * A small in-memory stand-in for the Prisma client used by the Phase 4 / A9 services, so the
 * unit tests exercise the real service code (locks, version checks, recompute, persist, audit)
 * without Docker. `$transaction` snapshots the data and restores it when the callback throws,
 * which is how a failed batch is shown to write nothing.
 *
 * It understands the query shapes the services use: equality, `in`/`notIn`/`not`, comparisons,
 * `contains` (also case-insensitive), `startsWith`, `has`, `AND`/`OR`/`NOT`, relation filters
 * (`some`/`none`/`every` on lists, nested filters on single relations), compound unique keys,
 * `orderBy`, `skip`/`take`, `distinct`, `groupBy` with `_count`/`_sum`/`_max`, `upsert`,
 * `increment` and `skipDuplicates`. `select` is ignored: rows come back whole, with relations as
 * lazy, non-enumerable getters (so spreading a row never walks the graph).
 */
import { Prisma } from '@prisma/client';
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
  plannedCost: number;
  actualCost: number;
  deadline: Date | null;
  deadlineNotifiedAt: Date | null;
  barColor: string | null;
  createdById: string | null;
}

export interface FakeUser {
  id: string;
  fullName: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'MONITOR';
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
}

export interface FakeProject {
  id: string;
  name: string;
  archivedAt: Date | null;
  autoSchedule: boolean;
  calendarId: string;
  ownerId: string;
  isTemplate?: boolean;
  budget?: number | null;
  currency?: string;
  startDate?: Date;
  status?: string;
  description?: string | null;
}

type Row = Record<string, unknown>;

export interface FakeData {
  users: FakeUser[];
  projects: FakeProject[];
  calendars: Array<{ id: string; name: string; weekendDays: number[]; exceptions: Array<{ id: string; date: Date; isWorking: boolean; name: string }> }>;
  access: Array<{ projectId: string; userId: string }>;
  tasks: FakeTask[];
  deps: Array<{ id: string; projectId: string; predecessorId: string; successorId: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lagDays: number }>;
  audit: Array<Record<string, unknown>>;
  notifications: Array<{ userId: string; type: string; payload: unknown }>;
  // A9 tables (loosely typed rows).
  labels: Row[];
  taskLabels: Row[];
  customFields: Row[];
  customValues: Row[];
  checklist: Row[];
  comments: Row[];
  commentReads: Row[];
  timeEntries: Row[];
  viewPrefs: Row[];
  portfolios: Row[];
  portfolioProjects: Row[];
  files: Row[];
}

type Table = keyof FakeData;

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
    plannedCost: 0,
    actualCost: 0,
    deadline: null,
    deadlineNotifiedAt: null,
    barColor: null,
    createdById: null,
    ...over,
  };
}

// ───────────────────────────── model registry

type Rel = { kind: 'one'; model: string; from: string; to?: string } | { kind: 'many'; model: string; to: string; from?: string };

interface ModelDef {
  table: Table;
  pk?: string[];
  unique?: string[][];
  rel?: Record<string, Rel>;
  defaults?: (r: Row) => Row;
  extra?: Record<string, (r: Row) => unknown>;
}

const now = () => new Date();

const MODELS: Record<string, ModelDef> = {
  user: {
    table: 'users',
    rel: { assignedTasks: { kind: 'many', model: 'task', to: 'assigneeId' }, projectAccess: { kind: 'many', model: 'projectAccess', to: 'userId' } },
    extra: { ledTeams: () => [], teamSupervisions: () => [] },
  },
  project: {
    table: 'projects',
    unique: [],
    rel: {
      calendar: { kind: 'one', model: 'calendar', from: 'calendarId' },
      owner: { kind: 'one', model: 'user', from: 'ownerId' },
      access: { kind: 'many', model: 'projectAccess', to: 'projectId' },
      tasks: { kind: 'many', model: 'task', to: 'projectId' },
      labels: { kind: 'many', model: 'projectLabel', to: 'projectId' },
      portfolios: { kind: 'many', model: 'portfolioProject', to: 'projectId' },
    },
    defaults: (r) => ({
      id: randomUUID(),
      description: null,
      startDate: d('2026-10-01'),
      status: 'ACTIVE',
      isTemplate: false,
      budget: null,
      currency: 'SAR',
      templateOfId: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      archivedAt: null,
      autoSchedule: true,
      ...r,
    }),
  },
  projectAccess: { table: 'access', pk: ['projectId', 'userId'] },
  calendar: { table: 'calendars', defaults: (r) => ({ exceptions: [], weekendDays: [5, 6], ...r }) },
  task: {
    table: 'tasks',
    rel: {
      project: { kind: 'one', model: 'project', from: 'projectId' },
      assignee: { kind: 'one', model: 'user', from: 'assigneeId' },
      parent: { kind: 'one', model: 'task', from: 'parentId' },
      children: { kind: 'many', model: 'task', to: 'parentId' },
      labels: { kind: 'many', model: 'taskLabel', to: 'taskId' },
      comments: { kind: 'many', model: 'taskComment', to: 'taskId' },
      checklist: { kind: 'many', model: 'taskChecklistItem', to: 'taskId' },
      timeEntries: { kind: 'many', model: 'timeEntry', to: 'taskId' },
      customValues: { kind: 'many', model: 'taskCustomValue', to: 'taskId' },
    },
    defaults: (r) => ({ ...task({ id: randomUUID(), projectId: '' }), createdAt: now(), ...r, version: (r.version as number | undefined) ?? 0 }),
  },
  taskDependency: { table: 'deps', defaults: (r) => ({ id: randomUUID(), type: 'FS', lagDays: 0, createdAt: now(), ...r }) },
  taskComment: {
    table: 'comments',
    rel: {
      author: { kind: 'one', model: 'user', from: 'authorId' },
      replyTo: { kind: 'one', model: 'taskComment', from: 'replyToId' },
      task: { kind: 'one', model: 'task', from: 'taskId' },
    },
    defaults: (r) => ({ id: randomUUID(), mentions: [], replyToId: null, createdAt: now(), ...r }),
  },
  taskCommentRead: { table: 'commentReads', pk: ['userId', 'taskId'] },
  projectLabel: {
    table: 'labels',
    unique: [['projectId', 'name']],
    rel: { project: { kind: 'one', model: 'project', from: 'projectId' }, tasks: { kind: 'many', model: 'taskLabel', to: 'labelId' } },
    defaults: (r) => ({ id: randomUUID(), createdAt: now(), ...r }),
  },
  taskLabel: {
    table: 'taskLabels',
    pk: ['taskId', 'labelId'],
    rel: { label: { kind: 'one', model: 'projectLabel', from: 'labelId' }, task: { kind: 'one', model: 'task', from: 'taskId' } },
  },
  customField: {
    table: 'customFields',
    unique: [['projectId', 'name']],
    rel: { project: { kind: 'one', model: 'project', from: 'projectId' } },
    defaults: (r) => ({ id: randomUUID(), options: [], sort: 0, createdAt: now(), ...r }),
  },
  taskCustomValue: { table: 'customValues', pk: ['taskId', 'fieldId'], rel: { task: { kind: 'one', model: 'task', from: 'taskId' } } },
  taskChecklistItem: {
    table: 'checklist',
    rel: { doneBy: { kind: 'one', model: 'user', from: 'doneById' }, task: { kind: 'one', model: 'task', from: 'taskId' } },
    defaults: (r) => ({ id: randomUUID(), done: false, sort: 0, doneById: null, doneAt: null, createdAt: now(), ...r }),
  },
  userViewPref: { table: 'viewPrefs', defaults: (r) => ({ id: randomUUID(), projectId: null, ...r }) },
  portfolio: {
    table: 'portfolios',
    unique: [['name']],
    rel: { projects: { kind: 'many', model: 'portfolioProject', to: 'portfolioId' } },
    defaults: (r) => ({ id: randomUUID(), description: null, createdAt: now(), ...r }),
  },
  portfolioProject: { table: 'portfolioProjects', pk: ['portfolioId', 'projectId'], defaults: (r) => ({ createdAt: now(), ...r }) },
  timeEntry: {
    table: 'timeEntries',
    rel: { task: { kind: 'one', model: 'task', from: 'taskId' }, user: { kind: 'one', model: 'user', from: 'userId' } },
    defaults: (r) => ({ id: randomUUID(), note: null, createdAt: now(), ...r }),
  },
  file: { table: 'files', defaults: (r) => ({ id: randomUUID(), status: 'READY', deletedAt: null, createdAt: now(), ...r }) },
  auditLog: { table: 'audit' },
};

const OPERATORS = new Set(['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'has', 'hasSome', 'mode']);

const isPlain = (v: unknown): v is Row => typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
const isOperator = (v: unknown): v is Row => isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OPERATORS.has(k));
const val = (x: unknown): unknown => (x instanceof Date ? x.getTime() : x);

function compare(cur: unknown, v: unknown): boolean {
  if (v === null) return cur === null || cur === undefined;
  if (isOperator(v)) {
    const ci = v.mode === 'insensitive';
    const s = (x: unknown) => (ci ? String(x).toLowerCase() : String(x));
    if ('equals' in v && !compare(cur, v.equals)) return false;
    if ('in' in v && !(v.in as unknown[]).some((x) => val(x) === val(cur))) return false;
    if ('notIn' in v && (v.notIn as unknown[]).some((x) => val(x) === val(cur))) return false;
    if ('not' in v) {
      if (isOperator(v.not) ? compare(cur, v.not) : compare(cur, v.not)) return false;
    }
    if ('lt' in v && !(cur !== null && cur !== undefined && (val(cur) as number) < (val(v.lt) as number))) return false;
    if ('lte' in v && !(cur !== null && cur !== undefined && (val(cur) as number) <= (val(v.lte) as number))) return false;
    if ('gt' in v && !(cur !== null && cur !== undefined && (val(cur) as number) > (val(v.gt) as number))) return false;
    if ('gte' in v && !(cur !== null && cur !== undefined && (val(cur) as number) >= (val(v.gte) as number))) return false;
    if ('contains' in v && !(typeof cur === 'string' && s(cur).includes(s(v.contains)))) return false;
    if ('startsWith' in v && !(typeof cur === 'string' && s(cur).startsWith(s(v.startsWith)))) return false;
    if ('endsWith' in v && !(typeof cur === 'string' && s(cur).endsWith(s(v.endsWith)))) return false;
    if ('has' in v && !(Array.isArray(cur) && cur.includes(v.has))) return false;
    if ('hasSome' in v && !(Array.isArray(cur) && (v.hasSome as unknown[]).some((x) => cur.includes(x)))) return false;
    return true;
  }
  if (cur instanceof Date && v instanceof Date) return cur.getTime() === v.getTime();
  return cur === v;
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
    labels: [],
    taskLabels: [],
    customFields: [],
    customValues: [],
    checklist: [],
    comments: [],
    commentReads: [],
    timeEntries: [],
    viewPrefs: [],
    portfolios: [],
    portfolioProjects: [],
    files: [],
    ...initial,
  };
  data.projects = data.projects.map((p) => MODELS.project!.defaults!(p as unknown as Row) as unknown as FakeProject);
  data.tasks = data.tasks.map((t) => task(t));
  const calls = { taskUpdates: 0, taskCreates: 0 };

  const rows = (model: string): Row[] => data[MODELS[model]!.table] as unknown as Row[];
  const setRows = (model: string, next: Row[]) => {
    (data as unknown as Record<string, Row[]>)[MODELS[model]!.table] = next;
  };

  function related(model: string, row: Row, name: string): Row | Row[] | null | undefined {
    const rel = MODELS[model]!.rel?.[name];
    if (!rel) return undefined;
    if (rel.kind === 'one') {
      const key = row[rel.from];
      if (key === null || key === undefined) return null;
      return rows(rel.model).find((r) => r[rel.to ?? 'id'] === key) ?? null;
    }
    const key = row[rel.from ?? 'id'];
    return rows(rel.model).filter((r) => r[rel.to] === key);
  }

  function match(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'AND') {
        if (!(Array.isArray(v) ? v : [v]).every((w) => match(model, row, w as Row))) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(v as Row[]).some((w) => match(model, row, w))) return false;
        continue;
      }
      if (k === 'NOT') {
        if ((Array.isArray(v) ? v : [v]).some((w) => match(model, row, w as Row))) return false;
        continue;
      }
      const rel = MODELS[model]!.rel?.[k];
      if (rel) {
        const target = related(model, row, k);
        if (rel.kind === 'many') {
          const list = target as Row[];
          const w = v as Row;
          if (w.some !== undefined && !list.some((r) => match(rel.model, r, w.some as Row))) return false;
          if (w.none !== undefined && list.some((r) => match(rel.model, r, w.none as Row))) return false;
          if (w.every !== undefined && !list.every((r) => match(rel.model, r, w.every as Row))) return false;
        } else {
          if (v === null) {
            if (target) return false;
            continue;
          }
          const w = v as Row;
          if ('is' in w || 'isNot' in w) {
            if (w.is !== undefined && !(w.is === null ? !target : target && match(rel.model, target as Row, w.is as Row))) return false;
            if (w.isNot !== undefined && (w.isNot === null ? !target : target && match(rel.model, target as Row, w.isNot as Row))) return false;
          } else if (!target || !match(rel.model, target as Row, w)) return false;
        }
        continue;
      }
      if (!(k in row) && isPlain(v) && !isOperator(v)) {
        // Compound unique key such as `userId_taskId: { userId, taskId }`.
        if (!match(model, row, v)) return false;
        continue;
      }
      if (!compare(row[k], v)) return false;
    }
    return true;
  }

  function out(model: string, row: Row): Row {
    const o: Row = { ...row };
    const def = MODELS[model]!;
    for (const name of Object.keys(def.rel ?? {})) {
      Object.defineProperty(o, name, {
        enumerable: false,
        configurable: true,
        get: () => {
          const r = related(model, row, name);
          if (Array.isArray(r)) return r.map((x) => out(def.rel![name]!.model, x));
          return r ? out(def.rel![name]!.model, r) : null;
        },
      });
    }
    for (const [name, fn] of Object.entries(def.extra ?? {})) {
      Object.defineProperty(o, name, { enumerable: false, configurable: true, get: () => fn(row) });
    }
    Object.defineProperty(o, '_count', {
      enumerable: false,
      configurable: true,
      get: () => {
        const c: Row = {};
        for (const [name, rel] of Object.entries(def.rel ?? {})) if (rel.kind === 'many') c[name] = (related(model, row, name) as Row[]).length;
        return c;
      },
    });
    return o;
  }

  function sortRows(list: Row[], orderBy: unknown): Row[] {
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean) as Row[];
    const pairs = keys.flatMap((o) => Object.entries(o).filter(([, dir]) => dir === 'asc' || dir === 'desc')) as Array<[string, 'asc' | 'desc']>;
    if (!pairs.length) return list;
    return [...list].sort((a, b) => {
      for (const [k, dir] of pairs) {
        const x = val(a[k]);
        const y = val(b[k]);
        if (x === y) continue;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) < (y as number) ? -1 : 1;
        return dir === 'asc' ? c : -c;
      }
      return 0;
    });
  }

  function applyData(row: Row, patch: Row): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (isPlain(v) && 'increment' in v) row[k] = ((row[k] as number) ?? 0) + (v.increment as number);
      else if (isPlain(v) && 'decrement' in v) row[k] = ((row[k] as number) ?? 0) - (v.decrement as number);
      else if (isPlain(v) && 'set' in v) row[k] = v.set;
      else row[k] = v;
    }
    if (patch.updatedAt === undefined) row.updatedAt = now();
  }

  function uniqueViolation(model: string, row: Row, except?: Row): void {
    const def = MODELS[model]!;
    for (const keys of [...(def.unique ?? []), ...(def.pk ? [def.pk] : [])]) {
      if (rows(model).some((r) => r !== except && keys.every((k) => r[k] === row[k]))) {
        throw new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${keys.join(',')}`, {
          code: 'P2002',
          clientVersion: 'fake',
          meta: { target: keys },
        });
      }
    }
  }

  function notFound(): Error {
    return new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: 'fake' });
  }

  function model(name: string) {
    const def = MODELS[name]!;
    const build = (input: Row): Row => ({ updatedAt: now(), ...(def.defaults ? def.defaults(input) : input) });
    const findMany = (args: { where?: Row; orderBy?: unknown; skip?: number; take?: number; distinct?: string[] } = {}) => {
      let list = rows(name).filter((r) => match(name, r, args.where));
      list = sortRows(list, args.orderBy);
      if (args.distinct) {
        const seen = new Set<string>();
        list = list.filter((r) => {
          const key = JSON.stringify(args.distinct!.map((k) => r[k]));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (args.skip) list = list.slice(args.skip);
      if (args.take !== undefined) list = list.slice(0, args.take);
      return list;
    };
    const create = (args: { data: Row }): Row => {
      const row = build(args.data);
      uniqueViolation(name, row);
      rows(name).push(row);
      if (name === 'task') calls.taskCreates++;
      return row;
    };
    return {
      findMany: jest.fn((args?: Row) => Promise.resolve(findMany(args as never).map((r) => out(name, r)))),
      findFirst: jest.fn((args?: Row) => {
        const r = findMany(args as never)[0];
        return Promise.resolve(r ? out(name, r) : null);
      }),
      findUnique: jest.fn((args: { where: Row }) => {
        const r = rows(name).find((x) => match(name, x, args.where));
        return Promise.resolve(r ? out(name, r) : null);
      }),
      findFirstOrThrow: jest.fn((args?: Row) => {
        const r = findMany(args as never)[0];
        return r ? Promise.resolve(out(name, r)) : Promise.reject(notFound());
      }),
      findUniqueOrThrow: jest.fn((args: { where: Row }) => {
        const r = rows(name).find((x) => match(name, x, args.where));
        return r ? Promise.resolve(out(name, r)) : Promise.reject(notFound());
      }),
      count: jest.fn((args?: { where?: Row }) => Promise.resolve(rows(name).filter((r) => match(name, r, args?.where)).length)),
      create: jest.fn((args: { data: Row }) => {
        try {
          return Promise.resolve(out(name, create(args)));
        } catch (err) {
          return Promise.reject(err);
        }
      }),
      createMany: jest.fn((args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        try {
          for (const item of args.data) {
            const row = build(item);
            if (args.skipDuplicates && def.pk && rows(name).some((r) => def.pk!.every((k) => r[k] === row[k]))) continue;
            uniqueViolation(name, row);
            rows(name).push(row);
            count++;
          }
        } catch (err) {
          return Promise.reject(err);
        }
        return Promise.resolve({ count });
      }),
      update: jest.fn((args: { where: Row; data: Row }) => {
        const r = rows(name).find((x) => match(name, x, args.where));
        if (!r) return Promise.reject(notFound());
        const next = { ...r };
        applyData(next, args.data);
        try {
          uniqueViolation(name, next, r);
        } catch (err) {
          return Promise.reject(err);
        }
        Object.assign(r, next);
        return Promise.resolve(out(name, r));
      }),
      updateMany: jest.fn((args: { where: Row; data: Row }) => {
        let count = 0;
        for (const r of rows(name)) {
          if (!match(name, r, args.where)) continue;
          applyData(r, args.data);
          count++;
        }
        if (name === 'task') calls.taskUpdates += count;
        return Promise.resolve({ count });
      }),
      upsert: jest.fn((args: { where: Row; create: Row; update: Row }) => {
        const r = rows(name).find((x) => match(name, x, args.where));
        if (r) {
          applyData(r, args.update);
          return Promise.resolve(out(name, r));
        }
        try {
          return Promise.resolve(out(name, create({ data: args.create })));
        } catch (err) {
          return Promise.reject(err);
        }
      }),
      delete: jest.fn((args: { where: Row }) => {
        const list = rows(name);
        const r = list.find((x) => match(name, x, args.where));
        if (!r) return Promise.reject(notFound());
        setRows(name, list.filter((x) => x !== r));
        cascade(name, r);
        return Promise.resolve(out(name, r));
      }),
      deleteMany: jest.fn((args?: { where?: Row }) => {
        const list = rows(name);
        const gone = list.filter((x) => match(name, x, args?.where));
        setRows(name, list.filter((x) => !gone.includes(x)));
        for (const g of gone) cascade(name, g);
        return Promise.resolve({ count: gone.length });
      }),
      groupBy: jest.fn((args: { by: string[]; where?: Row; _count?: Row; _sum?: Row; _max?: Row }) => {
        const groups = new Map<string, Row[]>();
        for (const r of rows(name).filter((x) => match(name, x, args.where))) {
          const key = JSON.stringify(args.by.map((k) => r[k]));
          const list = groups.get(key);
          if (list) list.push(r);
          else groups.set(key, [r]);
        }
        return Promise.resolve(
          [...groups.values()].map((list) => {
            const g: Row = {};
            for (const k of args.by) g[k] = list[0]![k];
            if (args._count) g._count = { _all: list.length };
            if (args._sum) g._sum = Object.fromEntries(Object.keys(args._sum).map((k) => [k, list.reduce((s, r) => s + Number(r[k] ?? 0), 0)]));
            if (args._max) {
              g._max = Object.fromEntries(
                Object.keys(args._max).map((k) => [k, list.reduce<unknown>((m, r) => (m === null || (val(r[k]) as number) > (val(m) as number) ? r[k] : m), null)]),
              );
            }
            return g;
          }),
        );
      }),
    };
  }

  /** ON DELETE CASCADE for the A9 child tables. */
  function cascade(name: string, row: Row): void {
    const drop = (child: string, key: string) => setRows(child, rows(child).filter((r) => r[key] !== row.id));
    if (name === 'projectLabel') drop('taskLabel', 'labelId');
    if (name === 'customField') drop('taskCustomValue', 'fieldId');
    if (name === 'portfolio') drop('portfolioProject', 'portfolioId');
  }

  function clone(src: FakeData): FakeData {
    const outData = {} as Record<string, unknown>;
    for (const [k, v] of Object.entries(src)) {
      outData[k] = (v as Row[]).map((r) => {
        const c: Row = { ...r };
        if (Array.isArray(r.exceptions)) c.exceptions = (r.exceptions as Row[]).map((e) => ({ ...e }));
        return c;
      });
    }
    return outData as unknown as FakeData;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    $queryRaw: jest.fn(() => Promise.resolve([])),
    $transaction: jest.fn(async (arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>): Promise<unknown> => {
      if (Array.isArray(arg)) return Promise.all(arg);
      const snapshot = clone(data);
      try {
        return await arg(db);
      } catch (err) {
        data = snapshot;
        throw err;
      }
    }),
  };
  for (const name of Object.keys(MODELS)) db[name] = model(name);

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
      return { ...x, startDate: iso(x.startDate), endDate: iso(x.endDate), deadline: x.deadline ? iso(x.deadline) : null };
    },
    /** Label ids of a task, sorted. */
    labelsOf(id: string): string[] {
      return data.taskLabels
        .filter((l) => l.taskId === id)
        .map((l) => l.labelId as string)
        .sort();
    },
  };
}
