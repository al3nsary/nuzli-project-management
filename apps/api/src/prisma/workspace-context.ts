import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A12 (ADR-143): the workspace context of the current request or background job, carried by
 * AsyncLocalStorage so every Prisma call made while serving it — however deep in a service —
 * is scoped to it without passing an argument around.
 *
 * - The HTTP middleware opens an EMPTY store for each request; JwtAuthGuard fills it after it
 *   has checked the token's workspace (`wid`) against the user's memberships.
 * - Background jobs run each workspace explicitly through `runInWorkspace`.
 * - `bypass` is set only by the audited owner escape hatch (PrismaService.crossWorkspace).
 */
export interface WorkspaceStore {
  workspaceId: string | null;
  userId: string | null;
  accountRole: 'OWNER' | 'USER' | null;
  /** Owner cross-workspace access (ADR-145): no workspace filter, RLS bypass on. */
  bypass: boolean;
  /** What opened the context (request, job name) — for error messages only. */
  label: string;
}

export const workspaceStorage = new AsyncLocalStorage<WorkspaceStore>();

/** Raised when a workspace-scoped query runs without a workspace context (fail closed). */
export class WorkspaceScopeError extends Error {
  constructor(message: string) {
    super(`[workspace-scope] ${message}`);
    this.name = 'WorkspaceScopeError';
  }
}

export function newStore(partial: Partial<WorkspaceStore> = {}): WorkspaceStore {
  return { workspaceId: null, userId: null, accountRole: null, bypass: false, label: 'request', ...partial };
}

export function currentStore(): WorkspaceStore | undefined {
  return workspaceStorage.getStore();
}

/** The active workspace, or null outside any workspace (login, registration, global jobs). */
export function activeWorkspaceIdOrNull(): string | null {
  return workspaceStorage.getStore()?.workspaceId ?? null;
}

/** The active workspace; throws (fail closed) when there is none. */
export function activeWorkspaceId(): string {
  const id = activeWorkspaceIdOrNull();
  if (!id) throw new WorkspaceScopeError('no active workspace');
  return id;
}

/**
 * Runs `fn` inside `store`. Prisma queries are LAZY (they start when awaited): a query returned
 * unawaited from `fn` would otherwise run in the caller's context. A thenable result is therefore
 * started (`.then`) while the store is still active.
 */
export function runInStore<T>(store: WorkspaceStore, fn: () => T): T {
  return workspaceStorage.run(store, () => {
    const result = fn();
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
      return (result as unknown as PromiseLike<unknown>).then((v) => v) as unknown as T;
    }
    return result;
  });
}

/** Runs `fn` inside one workspace (background jobs, seeds, tests). Never nests a bypass. */
export function runInWorkspace<T>(workspaceId: string, fn: () => T, label = 'system'): T {
  if (!workspaceId) throw new WorkspaceScopeError('runInWorkspace needs a workspace id');
  return runInStore(newStore({ workspaceId, label }), fn);
}

/** Runs `fn` outside any workspace: only global tables are reachable (login, registration). */
export function runWithoutWorkspace<T>(fn: () => T, label = 'global'): T {
  return runInStore(newStore({ label }), fn);
}
