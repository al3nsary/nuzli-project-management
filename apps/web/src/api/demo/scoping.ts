import Dexie, { type DBCore, type DBCoreCursor, type DBCoreTable, type DBCoreTransaction, type Middleware } from 'dexie';
import { effectiveRole, type Role, type UserStatus, type WorkspaceRole } from '@nuzli/shared';
import { ApiError } from '../errors';

/**
 * A12 (owner: «العزل أولًا») — the demo's workspace isolation, built like the server's scoping layer
 * (docs/a12-isolation-design.md §2, ADR-153): every business row carries `wid` (its workspace), and
 * ONE Dexie DBCore middleware adds the workspace to every read and write of every scoped table.
 *
 *  - reads (get, getMany, query, count, cursors) return only rows of the active workspace;
 *  - writes stamp `wid`; a write that names another workspace, or would overwrite or delete a row
 *    of another workspace, throws;
 *  - no active workspace → **throws WORKSPACE_REQUIRED** (fail closed), never "all rows";
 *  - every table must be classified here (a unit test fails on an unclassified one).
 *
 * The `users` table is global (identity), but inside a workspace it is a VIEW of that workspace:
 * only its members (and registrations addressed to it, and owners) are visible, and `role` /
 * `status` are those of the membership there — so every older rule («an ACTIVE SUPERVISOR»)
 * answers per workspace without being rewritten.
 */

/** Business tables: one workspace each (`wid`). */
export const SCOPED_TABLES = [
  'notifications',
  'audit',
  'colors',
  'teams',
  'members',
  'memberships',
  'supervisorHistory',
  'reference',
  'cardSizes',
  'cardTemplates',
  'logos',
  'batches',
  'violationTypes',
  'violations',
  'files',
  'projects',
  'tasks',
  'dependencies',
  'calendars',
  'projectAccess',
  'taskComments',
  'labels',
  'customFields',
  'checklist',
  'viewPrefs',
  'portfolios',
  'timeEntries',
  'commentReads',
  'teamSupervisors',
  'orgUnits',
  'orgPositions',
  'violationOcr',
  // A12 round 2
  'participants',
  'memberRequests',
] as const;

/**
 * Global tables: identity and the fake object store. `objects` is the bucket (the server's bucket
 * is not a database table either): its keys are random file ids reached only through a `files`
 * row, which IS scoped.
 */
export const GLOBAL_TABLES = ['users', 'sessions', 'kv', 'objects', 'workspaces', 'wsMemberships'] as const;

const SCOPED = new Set<string>(SCOPED_TABLES);
const GLOBAL = new Set<string>(GLOBAL_TABLES);

/** A workspace membership as the demo stores it (global table `wsMemberships`). */
export interface ScopeMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: 'ACTIVE' | 'SUSPENDED';
  archivedAt: string | null;
}

export interface ScopeContext {
  /** The active workspace; null = none chosen (scoped tables then throw). */
  wid: string | null;
  /** Identity/maintenance code (seeding, reset, owner summaries): no filter, writes keep their own `wid`. */
  bypass?: boolean;
}

/**
 * The scope state of one DemoApi: the workspace of the current session, and a synchronous copy
 * of the memberships (the users view needs them inside the middleware, which cannot await).
 */
export class ScopeHolder {
  current: ScopeContext = { wid: null };
  memberships = new Map<string, ScopeMembership>();
  /** Account roles by user id (owners see every workspace). */
  owners = new Set<string>();

  setMemberships(rows: ScopeMembership[]) {
    this.memberships = new Map(rows.map((m) => [m.id, m]));
  }

  /** Live memberships of a user in a workspace. */
  liveIn(userId: string, wid: string): ScopeMembership[] {
    const out: ScopeMembership[] = [];
    for (const m of this.memberships.values()) {
      if (m.userId === userId && m.workspaceId === wid && !m.archivedAt) out.push(m);
    }
    return out;
  }

  /** Any membership row (also archived) — names of former members stay readable in history. */
  everIn(userId: string, wid: string): boolean {
    for (const m of this.memberships.values()) if (m.userId === userId && m.workspaceId === wid) return true;
    return false;
  }
}

/** Marks the current Dexie transaction (inside `db.transaction(…, () => …)`) with a scope. */
export function tagTransaction(ctx: ScopeContext) {
  const trans = Dexie.currentTransaction as unknown as { idbtrans?: Record<string, unknown> } | null;
  if (!trans?.idbtrans) throw new Error('tagTransaction outside a transaction');
  trans.idbtrans.__nzScope = ctx;
}

function scopeOf(holder: ScopeHolder, trans: DBCoreTransaction): ScopeContext {
  // Schema upgrades (and the wipe they do) are maintenance, not a workspace's request.
  if ((trans as unknown as { mode?: string }).mode === 'versionchange') return { wid: null, bypass: true };
  const tagged = (trans as unknown as { __nzScope?: ScopeContext }).__nzScope;
  return tagged ?? holder.current;
}

export function workspaceRequired(): never {
  throw ApiError.of('WORKSPACE_REQUIRED', 403);
}

class CrossWorkspaceWrite extends Error {
  constructor(table: string) {
    super(`cross-workspace write refused on ${table}`);
    this.name = 'CrossWorkspaceWrite';
  }
}

/** Rows of `files` that belong to an account, not a workspace (profile photos — like the server). */
function isAccountFile(table: string, row: Record<string, unknown>): boolean {
  return table === 'files' && row.entityType === 'user_photo';
}

/** `audit` rows written outside any workspace are account-level (login lock…): `wid` null. */
function allowsNullWorkspaceWrite(table: string, row: Record<string, unknown>): boolean {
  return table === 'audit' || isAccountFile(table, row);
}

/** The users view of one workspace (see the header). Returns undefined when the user is not visible. */
export function projectUser(holder: ScopeHolder, row: Record<string, unknown> | undefined, wid: string) {
  if (!row) return row;
  const id = row.id as string;
  const isOwner = row.accountRole === 'OWNER';
  const live = holder.liveIn(id, wid);
  const registration =
    (row.status === 'PENDING' || row.status === 'REJECTED') && row.requestedWorkspaceId === wid;
  if (!live.length && !isOwner && !registration && !holder.everIn(id, wid)) return undefined;
  const activeRoles = live.filter((m) => m.status === 'ACTIVE').map((m) => m.role);
  let role: Role | null;
  if (registration) role = (row.requestedRole as Role | null) ?? (row.role as Role);
  else if (isOwner) role = effectiveRole(activeRoles) ?? 'ADMIN';
  else role = effectiveRole(activeRoles);
  let status = row.status as UserStatus;
  if (status === 'ACTIVE' && !isOwner) {
    if (!live.length) status = 'SUSPENDED'; // a former member: shown, never acting
    else if (live.every((m) => m.status === 'SUSPENDED')) status = 'SUSPENDED';
  }
  return {
    ...row,
    role,
    status,
    roles: activeRoles,
    _acct: { role: row.role, status: row.status },
    _view: { role, status },
  };
}

/** Undo the users view before a write: a field the caller did not change keeps its stored value. */
function unprojectUser(value: Record<string, unknown>) {
  const acct = value._acct as { role: unknown; status: unknown } | undefined;
  const view = value._view as { role: unknown; status: unknown } | undefined;
  const out = { ...value };
  if (acct && view) {
    if (out.role === view.role) out.role = acct.role;
    if (out.status === view.status) out.status = acct.status;
  }
  // Request-only fields (`roles`, `grants`, `_…`) never reach storage.
  for (const k of Object.keys(out)) if (k.startsWith('_') || k === 'roles' || k === 'grants') delete out[k];
  return out;
}

function filterCursor(cursor: DBCoreCursor, ok: (value: unknown) => boolean, map?: (value: unknown) => unknown): DBCoreCursor {
  let skip = 0;
  const wrapped = Object.create(cursor, {
    key: { get: () => cursor.key },
    primaryKey: { get: () => cursor.primaryKey },
    value: { get: () => (map ? map(cursor.value) : cursor.value) },
    start: {
      value(onNext: () => void) {
        return cursor.start(() => {
          if (!ok(cursor.value)) {
            cursor.continue();
            return;
          }
          if (skip > 0) {
            skip -= 1;
            cursor.continue();
            return;
          }
          onNext();
        });
      },
    },
    advance: {
      value(count: number) {
        // Skip `count` VISIBLE rows (the native advance would count hidden ones too).
        skip = count - 1;
        cursor.continue();
      },
    },
  });
  return wrapped as DBCoreCursor;
}

/**
 * The middleware. `holder.current` is the session's workspace; a transaction tagged with
 * `tagTransaction` overrides it (owner summaries of another workspace, seeding).
 */
export function scopingMiddleware(holder: ScopeHolder): Middleware<DBCore> {
  return {
    stack: 'dbcore',
    name: 'NuzliWorkspaceScoping',
    create(down: DBCore): DBCore {
      return {
        ...down,
        table(name: string): DBCoreTable {
          const table = down.table(name);
          if (!SCOPED.has(name) && !GLOBAL.has(name)) {
            throw new Error(`table "${name}" is not classified as scoped or global (scoping.ts)`);
          }
          if (name === 'wsMemberships') return membershipsTable(table, holder);
          if (name === 'users') return usersTable(table, holder);
          if (GLOBAL.has(name)) return table;
          return scopedTable(table, holder);
        },
      };
    },
  };
}

function scopedTable(table: DBCoreTable, holder: ScopeHolder): DBCoreTable {
  const name = table.name;
  const pk = table.schema.primaryKey;
  const keyOf = (v: unknown) => pk.extractKey!(v);

  const ctx = (trans: DBCoreTransaction) => {
    const c = scopeOf(holder, trans);
    if (!c.bypass && !c.wid) workspaceRequired();
    return c;
  };
  const visible = (c: ScopeContext) => (v: unknown) => {
    if (c.bypass) return true;
    const row = v as Record<string, unknown> | undefined;
    if (!row) return false;
    if (row.wid === c.wid) return true;
    return row.wid == null && isAccountFile(name, row);
  };

  // Only Dexie promise chains (never native async/await): a native hop inside a transaction can
  // lose Dexie's zone and commit the transaction early (PrematureCommitError).
  return {
    ...table,
    get(req) {
      return guard(() => {
        const c = ctx(req.trans);
        return table.get(req).then((v) => (visible(c)(v) ? v : undefined));
      });
    },
    getMany(req) {
      return guard(() => {
        const ok = visible(ctx(req.trans));
        return table.getMany(req).then((rows) => rows.map((v) => (ok(v) ? v : undefined)));
      });
    },
    query(req) {
      return guard(() => {
        const c = ctx(req.trans);
        if (c.bypass) return table.query(req);
        return table.query({ ...req, values: true, limit: undefined }).then((res) => {
          let rows = res.result.filter(visible(c));
          if (req.limit !== undefined && req.limit !== Infinity) rows = rows.slice(0, req.limit);
          return { result: req.values ? rows : rows.map(keyOf) };
        });
      });
    },
    count(req) {
      return guard(() => {
        const c = ctx(req.trans);
        if (c.bypass) return table.count(req);
        return table
          .query({ trans: req.trans, query: req.query, values: true })
          .then((res) => res.result.filter(visible(c)).length);
      });
    },
    openCursor(req) {
      return guard(() => {
        const c = ctx(req.trans);
        if (c.bypass) return table.openCursor(req);
        return table.openCursor({ ...req, values: true }).then((cursor) => cursor && filterCursor(cursor, visible(c)));
      });
    },
    mutate(req) {
      return guard(() => {
        const c = ctx(req.trans);
        if (c.bypass) return table.mutate(req);
        if (req.type === 'add' || req.type === 'put') {
          const values = req.values.map((v) => {
            const row = v as Record<string, unknown>;
            if (row.wid !== undefined && row.wid !== null && row.wid !== c.wid) throw new CrossWorkspaceWrite(name);
            if (row.wid === null && allowsNullWorkspaceWrite(name, row)) return row;
            if (isAccountFile(name, row)) return { ...row, wid: null };
            return { ...row, wid: c.wid };
          });
          // Never overwrite a row of another workspace (ids are random, so this is a forged id).
          const keys = req.keys ?? values.map(keyOf);
          return table.getMany({ trans: req.trans, keys }).then((existing) => {
            existing.forEach((e) => {
              if (e && !visible(c)(e)) throw new CrossWorkspaceWrite(name);
            });
            return table.mutate({ ...req, values });
          });
        }
        if (req.type === 'delete') {
          const ok = visible(c);
          return table.getMany({ trans: req.trans, keys: req.keys }).then((existing) => {
            const keys = req.keys.filter((_, i) => !existing[i] || ok(existing[i]));
            return table.mutate({ ...req, keys });
          });
        }
        // deleteRange (Table.clear, primary-key ranges): only this workspace's rows of the range.
        return table
          .query({ trans: req.trans, values: true, query: { index: pk, range: req.range } })
          .then((inRange) => {
            const keys = inRange.result.filter(visible(c)).map(keyOf);
            return table.mutate({ type: 'delete', trans: req.trans, keys });
          });
      });
    },
  };
}

/** Runs `fn`; a synchronous throw (fail closed) becomes a rejected Dexie promise. */
function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Dexie.Promise.reject(err) as unknown as Promise<T>;
  }
}

/** Keeps the synchronous membership copy in step with every write. */
function membershipsTable(table: DBCoreTable, holder: ScopeHolder): DBCoreTable {
  return {
    ...table,
    mutate(req) {
      return table.mutate(req).then((res) => {
        if (req.type === 'add' || req.type === 'put') {
          for (const v of req.values) {
            const m = v as ScopeMembership;
            holder.memberships.set(m.id, m);
          }
        } else if (req.type === 'delete') {
          for (const k of req.keys) holder.memberships.delete(k as string);
        } else {
          holder.memberships.clear();
        }
        return res;
      });
    },
  };
}

/** The users view (header). Without a workspace (sign-in, identity code) the table is read as is. */
function usersTable(table: DBCoreTable, holder: ScopeHolder): DBCoreTable {
  const pk = table.schema.primaryKey;
  const keyOf = (v: unknown) => pk.extractKey!(v);
  const view = (trans: DBCoreTransaction) => {
    const c = scopeOf(holder, trans);
    if (c.bypass || !c.wid) return null;
    const wid = c.wid;
    return (v: unknown) => projectUser(holder, v as Record<string, unknown> | undefined, wid);
  };
  return {
    ...table,
    get(req) {
      const f = view(req.trans);
      return table.get(req).then((v) => (f ? f(v) : v));
    },
    getMany(req) {
      const f = view(req.trans);
      return table.getMany(req).then((rows) => (f ? rows.map(f) : rows));
    },
    query(req) {
      const f = view(req.trans);
      if (!f) return table.query(req);
      return table.query({ ...req, values: true, limit: undefined }).then((res) => {
        let rows = res.result.map(f).filter((x): x is NonNullable<typeof x> => Boolean(x));
        if (req.limit !== undefined && req.limit !== Infinity) rows = rows.slice(0, req.limit);
        return { result: req.values ? rows : rows.map(keyOf) };
      });
    },
    count(req) {
      const f = view(req.trans);
      if (!f) return table.count(req);
      return table
        .query({ trans: req.trans, query: req.query, values: true })
        .then((res) => res.result.map(f).filter(Boolean).length);
    },
    openCursor(req) {
      const f = view(req.trans);
      if (!f) return table.openCursor(req);
      return table
        .openCursor({ ...req, values: true })
        .then((cursor) => cursor && filterCursor(cursor, (v) => Boolean(f(v)), f));
    },
    mutate(req) {
      if (req.type === 'add' || req.type === 'put') {
        return table.mutate({ ...req, values: req.values.map((v) => unprojectUser(v as Record<string, unknown>)) });
      }
      return table.mutate(req);
    },
  };
}
