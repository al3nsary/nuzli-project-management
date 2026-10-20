/**
 * A12: a real PostgreSQL for the isolation, RLS and migration tests, without Docker — PGlite
 * (PostgreSQL compiled to WebAssembly, in-process). The FULL migration chain of
 * prisma/migrations is applied, exactly as `prisma migrate deploy` would.
 *
 * - pgcrypto and btree_gist come from PGlite's contrib bundle (the constraints migration needs them).
 * - PGlite runs as the superuser `postgres`, which BYPASSES Row Level Security. RLS tests switch
 *   the session to the migration's application role with `SET ROLE nuzli_app` (no BYPASSRLS),
 *   the same role the API connects as in production.
 * - Prisma talks to PGlite through the `pglite-prisma-adapter` driver adapter (single connection).
 * - PGlite and the adapter are loaded with Node's own require (see pglite-env.js).
 */
import type { Extension, PGlite as PGliteType } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type PGlite = PGliteType;

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');
export const A12_MIGRATION = '20261023000000_a12_workspaces';
export const APP_ROLE = 'nuzli_app';

function nativeRequire<T>(id: string): T {
  const req = (globalThis as { __nativeRequire?: NodeRequire }).__nativeRequire;
  if (!req) throw new Error('PGlite suites need testEnvironment test/support/pglite-env.js');
  return req(id) as T;
}

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => e.name)
    .sort();
}

export function migrationSql(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

export async function newPglite(): Promise<PGlite> {
  const { PGlite } = nativeRequire<typeof import('@electric-sql/pglite')>('@electric-sql/pglite');
  const { pgcrypto } = nativeRequire<{ pgcrypto: Extension }>('@electric-sql/pglite/contrib/pgcrypto');
  const { btree_gist } = nativeRequire<{ btree_gist: Extension }>('@electric-sql/pglite/contrib/btree_gist');
  return PGlite.create({ extensions: { pgcrypto, btree_gist } });
}

/** Applies the migrations in order: all, those strictly before a name, or only one. */
export async function migrate(db: PGlite, opts: { before?: string; only?: string } = {}): Promise<string[]> {
  const applied: string[] = [];
  for (const name of migrationNames()) {
    if (opts.before && name >= opts.before) break;
    if (opts.only && name !== opts.only) continue;
    await db.exec(migrationSql(name));
    applied.push(name);
  }
  return applied;
}

/** A fresh database with the whole migration chain applied. */
export async function migratedDb(): Promise<PGlite> {
  const db = await newPglite();
  await migrate(db);
  return db;
}

const UUID_ARRAY_OID = 2951;
const TEXT_ARRAY_OID = 1009;

/**
 * pglite-prisma-adapter 0.3 does not know `uuid[]` (OID 2951; used by task_comments.mentions and
 * violations.supervisor_ids_snapshot). The test harness parses it like `text[]` and reports it as
 * such to the adapter — the values are the same strings Prisma gets from the real driver.
 */
/** `{a,b}` → [a, b] (uuids never need quoting in the array text format). */
function parseUuidArray(s: string): string[] {
  const inner = s.slice(1, -1).trim();
  return inner ? inner.split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
}

function withUuidArrays<T extends object>(q: T): T {
  return new Proxy(q, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'query' && typeof value === 'function') {
        return async (sql: string, params?: unknown[], options?: { parsers?: Record<number, unknown> }) => {
          const parsers = { ...(options?.parsers ?? {}), [UUID_ARRAY_OID]: parseUuidArray };
          const res = (await (value as (...a: unknown[]) => Promise<{ fields?: Array<{ dataTypeID: number }> }>).call(target, sql, params, {
            ...(options ?? {}),
            parsers,
          })) as { fields?: Array<{ dataTypeID: number }> };
          for (const f of res.fields ?? []) if (f.dataTypeID === UUID_ARRAY_OID) f.dataTypeID = TEXT_ARRAY_OID;
          return res;
        };
      }
      if (prop === 'transaction' && typeof value === 'function') {
        return (fn: (tx: object) => Promise<unknown>) => (value as (f: (tx: object) => Promise<unknown>) => Promise<unknown>).call(target, (tx) => fn(withUuidArrays(tx)));
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The Prisma driver adapter for a PGlite database. */
export function pgliteAdapter(db: PGlite): unknown {
  const { PrismaPGlite } = nativeRequire<{ PrismaPGlite: new (db: PGlite) => unknown }>('pglite-prisma-adapter');
  return new PrismaPGlite(withUuidArrays(db));
}

/** A PrismaClient on the PGlite database (the caller wraps it with the workspace scoping). */
export function prismaOn(db: PGlite): PrismaClient {
  return new PrismaClient({ adapter: pgliteAdapter(db) as never });
}

/** Switches the (single) PGlite session to the application role: RLS applies from now on. */
export async function asAppRole(db: PGlite): Promise<void> {
  await db.exec(`SET ROLE ${APP_ROLE}`);
}

/** Back to the superuser (fixtures, assertions on raw data). */
export async function asSuperuser(db: PGlite): Promise<void> {
  await db.exec('RESET ROLE');
}

/** Every workspace-scoped table (the 45 the A12 migration gives workspace_id + RLS). */
export async function scopedTables(db: PGlite): Promise<string[]> {
  const r = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'workspace_id'
        AND table_name NOT IN ('workspace_memberships', 'refresh_tokens')
      ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}
