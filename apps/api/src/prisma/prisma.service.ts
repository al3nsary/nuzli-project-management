import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { readsRelations, scopeArgs, SCOPED_MODELS } from './scoping';
import { newStore, runInStore, workspaceStorage, WorkspaceScopeError, type WorkspaceStore } from './workspace-context';

/** A Prisma client or the transaction client handed to `$transaction(fn)`. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Optional PrismaClient options (tests pass a PGlite driver adapter). */
export const PRISMA_CLIENT_OPTIONS = Symbol('PRISMA_CLIENT_OPTIONS');

export const OWNER_CROSS_WORKSPACE_ACTION = 'owner.cross_workspace_access';

/** The SQL that binds a transaction to the store's workspace (SET LOCAL semantics). */
export function workspaceGucSql(store: WorkspaceStore | undefined): Prisma.Sql {
  const ws = store?.workspaceId ?? '';
  const bypass = store?.bypass ? 'on' : 'off';
  return Prisma.sql`SELECT set_config('app.workspace_id', ${ws}, true), set_config('app.bypass_rls', ${bypass}, true)`;
}

type QueryParams = {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Prisma.PrismaPromise<unknown>;
  __internalParams?: { transaction?: unknown };
};

/**
 * A12 (ADR-143): wraps a PrismaClient so that
 *  1. every operation on a workspace-scoped model is rewritten by `scopeArgs` (workspace filter on
 *     reads/updates/deletes, workspace id on creates) and fails closed without a workspace context;
 *  2. every statement that may touch a scoped table runs in a transaction whose first statement is
 *     `set_config('app.workspace_id', …, true)` — the value PostgreSQL Row Level Security checks.
 *     Stand-alone operations become a two-statement batch transaction; interactive and batch
 *     `$transaction`s set it once at their start.
 */
export function createScopedClient<T extends PrismaClient>(base: T): T {
  const runWithGuc = (store: WorkspaceStore | undefined, run: () => Prisma.PrismaPromise<unknown>) =>
    base.$transaction([base.$executeRaw(workspaceGucSql(store)), run()]).then((r) => r[1]);

  const ext = base.$extends({
    name: 'nuzli-workspace-scope',
    query: {
      $allOperations(params) {
        const { model, operation, args, query, __internalParams } = params as unknown as QueryParams;
        const store = workspaceStorage.getStore();
        const inTx = !!__internalParams?.transaction;
        if (model) {
          if (!SCOPED_MODELS.has(model)) {
            const scoped = scopeArgs(model, operation, args, store);
            if (inTx || !readsRelations(args) || (!store?.workspaceId && !store?.bypass)) return query(scoped);
            return runWithGuc(store, () => query(scoped));
          }
          const scoped = scopeArgs(model, operation, args, store);
          if (inTx) return query(scoped);
          return runWithGuc(store, () => query(scoped));
        }
        // $queryRaw / $executeRaw (+Unsafe): the SQL must filter by workspace itself (ADR-143 lists
        // every site); RLS sees the session workspace through the GUC.
        if (inTx) return query(args);
        return runWithGuc(store, () => query(args));
      },
    },
  });

  const transaction = (arg: unknown, options?: unknown): Promise<unknown> => {
    const store = workspaceStorage.getStore();
    if (typeof arg === 'function') {
      return (ext.$transaction as (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)(
        async (tx) => {
          await (tx as Prisma.TransactionClient).$executeRaw(workspaceGucSql(store));
          return (arg as (tx: unknown) => Promise<unknown>)(tx);
        },
        options,
      );
    }
    if (!Array.isArray(arg)) throw new TypeError('$transaction expects a function or an array');
    return (ext.$transaction as (ops: unknown[], o?: unknown) => Promise<unknown[]>)(
      [ext.$executeRaw(workspaceGucSql(store)), ...arg],
      options,
    ).then((r) => r.slice(1));
  };

  const ownProto = Object.getPrototypeOf(base) as object;
  const customProto = ownProto !== PrismaClient.prototype ? ownProto : null;
  const proxy: T = new Proxy(ext as unknown as T, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return transaction;
      if (prop === '$base') return base;
      // Methods declared by a PrismaClient subclass (PrismaService): run them with the proxy as `this`.
      if (customProto && typeof prop === 'string' && prop !== 'constructor' && Object.prototype.hasOwnProperty.call(customProto, prop)) {
        const value = (customProto as Record<string, unknown>)[prop];
        if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(proxy);
      }
      const value = Reflect.get(target as object, prop, receiver);
      // Instance fields of the subclass (e.g. a logger) live on the base object.
      if (value === undefined && typeof prop === 'string' && Object.prototype.hasOwnProperty.call(base, prop)) {
        return (base as unknown as Record<string, unknown>)[prop];
      }
      return value;
    },
    getPrototypeOf() {
      return ownProto;
    },
  });
  return proxy;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly scopeLogger = new Logger('WorkspaceScope');

  constructor(@Optional() @Inject(PRISMA_CLIENT_OPTIONS) options?: Prisma.PrismaClientOptions) {
    super(options);
    // Nest (and every service) receives the scoped proxy, never the raw client.
    return createScopedClient(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.warnIfRlsBypassed();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Used by /ready. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * RLS is a second line of defence only when the API connects as a role that does not bypass
   * it (nuzli_app, ADR-143). Logged at start-up; `DB_REQUIRE_RLS=true` turns it into a refusal.
   */
  async warnIfRlsBypassed(): Promise<void> {
    try {
      const rows = await this.$queryRaw<Array<{ bypass: boolean; role: string }>>`
        SELECT (rolsuper OR rolbypassrls) AS bypass, rolname::text AS role FROM pg_roles WHERE rolname = current_user`;
      const row = rows[0];
      if (!row?.bypass) return;
      const msg = `Database role "${row.role}" bypasses Row Level Security; connect the API as nuzli_app (docs/a12-isolation-design.md).`;
      if (process.env.DB_REQUIRE_RLS === 'true') throw new Error(msg);
      if (process.env.NODE_ENV !== 'test') this.scopeLogger.warn(msg);
    } catch (err) {
      if (process.env.DB_REQUIRE_RLS === 'true') throw err;
    }
  }

  /**
   * ADR-145 — the ONLY way to read or write across workspaces: an OWNER, a stated reason, and an
   * audit entry (workspace NULL, action `owner.cross_workspace_access`) written before `fn` runs.
   * Inside `fn` the workspace filter is off and RLS is bypassed for this context only.
   */
  async crossWorkspace<R>(
    actor: { id: string; accountRole?: string | null },
    reason: string,
    fn: () => Promise<R>,
    meta: { ip?: string | null; requestId?: string | null } = {},
  ): Promise<R> {
    if (actor.accountRole !== 'OWNER') throw new WorkspaceScopeError('cross-workspace access is for owners only');
    if (!reason?.trim()) throw new WorkspaceScopeError('cross-workspace access needs a reason');
    const outer = workspaceStorage.getStore();
    await runInStore(newStore({ userId: actor.id, accountRole: 'OWNER', label: 'owner-audit' }), () =>
      this.auditLog.create({
        data: {
          actorId: actor.id,
          action: OWNER_CROSS_WORKSPACE_ACTION,
          entityType: 'workspace',
          entityId: outer?.workspaceId ?? null,
          after: { reason: reason.slice(0, 300) },
          ip: meta.ip ?? null,
          requestId: meta.requestId ?? null,
        },
      }),
    );
    return runInStore(
      newStore({ ...(outer ?? {}), userId: actor.id, accountRole: 'OWNER', bypass: true, label: `owner:${reason.slice(0, 40)}` }),
      fn,
    );
  }

  /**
   * Runs `fn` once per workspace (background jobs). Errors of one workspace do not stop the others.
   * Active workspaces only by default (reminders, OCR); security review A12 M4: retention and
   * cleanup jobs pass `includeArchived` — archiving a workspace closes it, it never exempts its
   * ID-card photos, OCR results or pending uploads from deletion (PDPL).
   */
  async forEachWorkspace(
    label: string,
    fn: (workspace: { id: string; name: string }) => Promise<void>,
    opts: { includeArchived?: boolean } = {},
  ): Promise<void> {
    const workspaces = await this.workspace.findMany({
      where: opts.includeArchived ? {} : { status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const ws of workspaces) {
      try {
        await runInStore(newStore({ workspaceId: ws.id, label }), () => fn(ws));
      } catch (err) {
        this.scopeLogger.warn(`${label} failed for workspace ${ws.id}: ${(err as Error).message}`);
      }
    }
  }
}
