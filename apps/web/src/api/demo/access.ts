import { applyDualRole, personRefIds, type ParticipantLevel } from '@nuzli/shared';
import type { DemoUser } from './db';

/**
 * A12 (ADR-150/151/153): what the demo knows about the signed-in user for ONE request — the
 * same facts the API guard loads (docs/a12-roles.md §6). `actor()` returns a DemoUser carrying
 * these request-only fields (they never reach storage: the scoping layer strips `_…`, `roles`
 * and `grants` on write).
 */
export interface ActorFacts {
  /** The active workspace of the session. */
  _wid?: string | null;
  /** Live roles in that workspace (dual role = several). */
  roles?: string[];
  /** Assistant module grants + (for one project) the participant level's grants. */
  grants?: string[];
  /** Assistant scope; null lists = no limit. Absent for admins and owners. */
  _limits?: { projectIds: string[] | null; teamIds: string[] | null } | null;
  /** Project participations in the workspace: projectId → level. */
  _parts?: Record<string, ParticipantLevel>;
  /** The project this request is bound to (participant grants apply to it only). */
  _project?: string | null;
}

export type Actor = DemoUser & ActorFacts;

/** An assistant limited to some projects sees only those (admins/owners: no limit). */
export function projectInScope(viewer: DemoUser, projectId: string): boolean {
  const limits = (viewer as Actor)._limits;
  return !limits?.projectIds || limits.projectIds.includes(projectId);
}

/** An assistant limited to some teams sees only those and workers without a team. */
export function teamInScope(viewer: DemoUser, teamId: string | null | undefined): boolean {
  const limits = (viewer as Actor)._limits;
  if (!limits?.teamIds) return true;
  return !teamId || limits.teamIds.includes(teamId);
}

/**
 * A12 round 3 — violations under an assistant's team scope (apps/api violationScopeWhere and the
 * statistics SQL: `team_id_snapshot IN (scope)`): no scope = every violation; with a scope only
 * those teams' violations — an unassigned one (no team) is outside it, unlike workers.
 */
export function violationTeamInScope(viewer: DemoUser, teamId: string | null | undefined): boolean {
  const limits = (viewer as Actor)._limits;
  if (!limits?.teamIds) return true;
  return !!teamId && limits.teamIds.includes(teamId);
}

/** The participant level of the viewer on a project, if any. */
export function participationOf(viewer: DemoUser, projectId: string): ParticipantLevel | undefined {
  return (viewer as Actor)._parts?.[projectId];
}

/** True when the viewer may read the project as a participant. */
export function isParticipant(viewer: DemoUser, projectId: string): boolean {
  return Boolean(participationOf(viewer, projectId));
}

/** Money fields removed for callers without `budget.read` (docs/API.md «Budget (owner rule)»). */
export const MONEY_FIELDS = [
  'budget',
  'plannedCost',
  'actualCost',
  'costVariance',
  'budgetVariance',
  'budgetUsedPct',
  'overBudget',
  'overBudgetTasks',
  'budgetShare',
  'budgetBurn',
] as const;

/** Deep copy without the money fields (the API's BudgetInterceptor). */
export function stripMoney<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripMoney(v)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Blob) && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((MONEY_FIELDS as readonly string[]).includes(k)) continue;
      out[k] = stripMoney(v);
    }
    return out as T;
  }
  return value;
}

/** True when a write body tries to set money (403 FORBIDDEN details.field = 'budget' without budget.manage). */
export function touchesMoney(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  if (Array.isArray(input)) return input.some(touchesMoney);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if ((k === 'budget' || k === 'plannedCost' || k === 'actualCost') && v !== undefined) return true;
    if (v && typeof v === 'object' && touchesMoney(v)) return true;
  }
  return false;
}

/** A12: the project a request is about (the API's ProjectGrantGuard reads it from the route). */
export type ProjectCtx =
  | { projectId: string }
  | { taskId: string }
  | { labelId: string }
  | { fieldId: string }
  | { dependencyId: string }
  | { timeEntryId: string };

export interface ActorOptions {
  /** `@WorkspaceOptional` routes: auth/me, switch, workspaces, change-password, PATCH /me, owners… */
  optionalWorkspace?: boolean;
  /** Bind a project participant's level to this request. */
  project?: ProjectCtx;
}

/**
 * A12 round 3: every ApiClient namespace whose answers may name people — all of them, like the
 * API's DualRoleInterceptor, which runs on every JSON answer inside a workspace.
 */
export const DUAL_ROLE_NAMESPACES = [
  'auth', 'system', 'me', 'owners', 'workspaces', 'users', 'registrations', 'audit', 'notifications', 'settings',
  'colors', 'teams', 'org', 'members', 'memberRequests', 'participants', 'reference', 'cards', 'files', 'photos',
  'violationTypes', 'violations', 'logos', 'projects', 'tasks', 'dependencies', 'calendars', 'labels',
  'customFields', 'timeEntries', 'viewPrefs', 'portfolios', 'imports', 'hub',
] as const;

/**
 * A12 round 3 — the demo's DualRoleInterceptor: wraps each method of the namespaces so that every
 * answer inside a workspace gets `dualRole: true` on its person refs (@nuzli/shared
 * `personRefIds` / `applyDualRole`, the same walker as the API), with one lookup per answer.
 * Synchronous methods stay synchronous; files (Blob) pass untouched.
 */
export function decorateDualRole(
  api: Record<string, unknown>,
  namespaces: readonly string[],
  dualOf: (ids: string[]) => Set<string>,
  activeWorkspace: () => string | null,
): void {
  const decorate = (out: unknown) => {
    if (!activeWorkspace() || out === null || typeof out !== 'object' || (typeof Blob !== 'undefined' && out instanceof Blob)) return out;
    const ids = personRefIds(out);
    return ids.length ? applyDualRole(out, dualOf(ids)) : out;
  };
  const wrap = (target: Record<string, unknown>, depth: number) => {
    for (const key of Object.keys(target)) {
      const fn = target[key];
      if (fn && typeof fn === 'object' && !Array.isArray(fn) && depth < 2) {
        wrap(fn as Record<string, unknown>, depth + 1);
        continue;
      }
      if (typeof fn !== 'function') continue;
      target[key] = (...args: unknown[]) => {
        const r = (fn as (...a: unknown[]) => unknown).apply(target, args);
        return r && typeof (r as Promise<unknown>).then === 'function' ? (r as Promise<unknown>).then(decorate) : r;
      };
    }
  };
  for (const ns of namespaces) {
    const target = api[ns];
    if (target && typeof target === 'object') wrap(target as Record<string, unknown>, 0);
  }
}
