import { Prisma } from '@prisma/client';
import { WorkspaceScopeError, type WorkspaceStore } from './workspace-context';

/**
 * A12 (ADR-143): the application-level workspace filter. `scopeArgs` rewrites the arguments of
 * every Prisma operation on a workspace-scoped model so it can only see and write rows of the
 * active workspace. It is pure (unit-tested on its own) and FAILS CLOSED: a scoped model without
 * a workspace context, an unknown operation, or an attempt to write another workspace's id throws.
 *
 * Row Level Security (ADR-143) repeats the same rule in PostgreSQL as a second line of defence.
 */

/** Every business model (47 since A12 round 2). Identity/session models stay global: User, RefreshToken, ActionToken, Workspace, WorkspaceMembership. */
export const SCOPED_MODELS: ReadonlySet<string> = new Set([
  'TeamColor', 'Team', 'TeamSupervisor', 'TeamSupervisorHistory', 'TeamMember', 'TeamMembership',
  'Department', 'JobTitle', 'OrgUnit', 'OrgPosition', 'Calendar', 'CalendarException', 'Project',
  'ProjectAccess', 'Task', 'TaskDependency', 'TaskComment', 'ProjectLabel', 'TaskLabel', 'CustomField',
  'TaskCustomValue', 'TaskChecklistItem', 'UserViewPref', 'Portfolio', 'PortfolioProject', 'TimeEntry',
  'TaskCommentRead', 'Baseline', 'BaselineTask', 'ViolationType', 'Violation', 'ViolationOcr',
  'ViolationFile', 'ViolationResponse', 'ViolationVisibility', 'ImportPreview', 'File', 'Logo',
  'CardSize', 'CardTemplate', 'CardPrintBatch', 'CardPrintItem', 'Notification', 'Setting', 'AuditLog',
  // A12 round 2
  'ProjectParticipant', 'MemberRequest',
]);

export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  'User', 'RefreshToken', 'ActionToken', 'Workspace', 'WorkspaceMembership',
]);

/** Account-level audit entries (login lock, refresh reuse…) are written with workspace_id NULL. */
const NULL_WORKSPACE_WRITES = new Set(['AuditLog']);

const WHERE_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_DATA_OPS = new Set(['update', 'updateMany']);

type Args = Record<string, unknown>;

let relationFieldsCache: Map<string, Set<string>> | null = null;

/** Relation field names per model (from the generated DMMF), to tell checked from unchecked inputs. */
export function relationFields(model: string): Set<string> {
  if (!relationFieldsCache) {
    relationFieldsCache = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.filter((f) => f.kind === 'object').map((f) => f.name))]),
    );
  }
  return relationFieldsCache.get(model) ?? new Set();
}

function isObject(v: unknown): v is Args {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function workspaceFilter(model: string, workspaceId: string): Args {
  // A user's profile photo is a global file (workspace_id NULL) — readable from any workspace;
  // who may see it is decided by the photo policy (ADR-083 + A12).
  if (model === 'File') {
    return { OR: [{ workspaceId }, { workspaceId: null, entityType: 'user_photo' }] };
  }
  return { workspaceId };
}

export function withWorkspaceWhere(model: string, where: unknown, workspaceId: string): Args {
  const base = isObject(where) ? { ...where } : {};
  const and = base.AND === undefined ? [] : Array.isArray(base.AND) ? [...base.AND] : [base.AND];
  return { ...base, AND: [...and, workspaceFilter(model, workspaceId)] };
}

function assertNoForeignWorkspace(model: string, data: Args, workspaceId: string | null): void {
  if ('workspaceId' in data && data.workspaceId !== undefined && data.workspaceId !== workspaceId) {
    throw new WorkspaceScopeError(`${model}: workspaceId may not be set to another workspace`);
  }
  if ('workspace' in data && data.workspace !== undefined) {
    const ws = data.workspace as Args;
    const connectId = isObject(ws) && isObject(ws.connect) ? ws.connect.id : undefined;
    if (connectId !== workspaceId) throw new WorkspaceScopeError(`${model}: workspace relation may not be set`);
  }
}

/** Sets the workspace on one create payload (checked or unchecked Prisma input). */
export function withWorkspaceData(model: string, data: unknown, workspaceId: string | null): Args {
  if (!isObject(data)) throw new WorkspaceScopeError(`${model}: create without data`);
  assertNoForeignWorkspace(model, data, workspaceId);
  const out: Args = { ...data };
  // User photos are global files.
  if (model === 'File' && out.entityType === 'user_photo') {
    if (Object.keys(out).some((k) => relationFields(model).has(k))) {
      throw new WorkspaceScopeError('File: a user photo must be created with scalar (unchecked) data');
    }
    out.workspaceId = null;
    return out;
  }
  const rel = relationFields(model);
  const checked = Object.keys(out).some((k) => rel.has(k) && k !== 'workspace');
  if (workspaceId === null) {
    // Only reachable for NULL_WORKSPACE_WRITES (checked by the caller).
    delete out.workspace;
    if (!checked) out.workspaceId = null;
    return out;
  }
  if (checked) {
    delete out.workspaceId;
    out.workspace = { connect: { id: workspaceId } };
  } else {
    delete out.workspace;
    out.workspaceId = workspaceId;
  }
  return out;
}

function assertUpdateData(model: string, data: unknown, workspaceId: string | null): void {
  if (isObject(data)) assertNoForeignWorkspace(model, data, workspaceId);
}

/**
 * Returns the arguments of `operation` on `model`, restricted to the store's workspace.
 * Global models pass through unchanged. Throws WorkspaceScopeError when the call cannot be scoped.
 */
export function scopeArgs(model: string, operation: string, args: unknown, store: WorkspaceStore | undefined): Args {
  const a: Args = isObject(args) ? { ...args } : {};
  if (!SCOPED_MODELS.has(model)) {
    if (GLOBAL_MODELS.has(model)) return a;
    throw new WorkspaceScopeError(`unknown model ${model}: add it to SCOPED_MODELS or GLOBAL_MODELS`);
  }
  if (store?.bypass) return a;
  const workspaceId = store?.workspaceId ?? null;

  if (!workspaceId) {
    if (NULL_WORKSPACE_WRITES.has(model) && CREATE_OPS.has(operation)) {
      if (Array.isArray(a.data)) a.data = a.data.map((d) => withWorkspaceData(model, d, null));
      else a.data = withWorkspaceData(model, a.data, null);
      return a;
    }
    throw new WorkspaceScopeError(`${model}.${operation} outside a workspace context`);
  }

  if (WHERE_OPS.has(operation)) {
    a.where = withWorkspaceWhere(model, a.where, workspaceId);
    if (UPDATE_DATA_OPS.has(operation)) assertUpdateData(model, a.data, workspaceId);
    return a;
  }
  if (CREATE_OPS.has(operation)) {
    if (Array.isArray(a.data)) a.data = a.data.map((d) => withWorkspaceData(model, d, workspaceId));
    else a.data = withWorkspaceData(model, a.data, workspaceId);
    return a;
  }
  if (operation === 'upsert') {
    a.where = withWorkspaceWhere(model, a.where, workspaceId);
    a.create = withWorkspaceData(model, a.create, workspaceId);
    assertUpdateData(model, a.update, workspaceId);
    return a;
  }
  throw new WorkspaceScopeError(`${model}.${operation} is not a scoped operation`);
}

/** True when a global-model query reads relations (they may be scoped tables under RLS). */
export function readsRelations(args: unknown): boolean {
  if (!isObject(args)) return false;
  if (args.include !== undefined) return true;
  const select = args.select;
  return isObject(select) && Object.values(select).some((v) => isObject(v));
}
