/**
 * A12 final step (ADR-170) — a FRESH PRODUCTION INSTALL, simulated without Docker.
 *
 *   npm run verify:fresh-install        (apps/api)
 *
 * What the containers do on the first `docker compose up`, step by step, on an EMPTY database:
 *   1. the migrator (POSTGRES_USER, a superuser in the postgres image) applies the whole migration
 *      chain — here the same SQL files, in order, on PGlite (PostgreSQL 16 in WebAssembly);
 *   2. the production seed (`node dist/seed/seed.js` = runSeed) with NODE_ENV=production, only
 *      BOOTSTRAP_OWNER_USERNAME=mmansary and NO password → a one-time password printed once;
 *      it also gives the role `nuzli_app` LOGIN with the password of APP_DATABASE_URL;
 *   3. the API runs as `nuzli_app` with DB_REQUIRE_RLS=true (and refuses to start as the migrator);
 *   4. a smoke run over real HTTP: health, ready, first login, forced password change, /auth/me,
 *      a second workspace, archive it, back to single-workspace mode;
 *   5. the database holds no business rows — only the neutral defaults — and RLS is effective.
 *
 * Only the edges differ from production: PGlite instead of a TCP PostgreSQL (one session, so the
 * role switch is `SET ROLE nuzli_app`), an in-memory bucket instead of OCI, and mail off.
 */
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MemoryStorage } from '../support/pglite-app';
import { APP_ROLE, asAppRole, asSuperuser, migrationNames, migrationSql, newPglite, pgliteAdapter, prismaOn, scopedTables, type PGlite } from '../support/pglite';

jest.setTimeout(300_000);

/** Business tables that must stay EMPTY on a fresh install (no demo, no invented data). */
const MUST_BE_EMPTY = [
  'teams', 'team_members', 'team_memberships', 'team_supervisors', 'team_supervisor_history',
  'departments', 'job_titles', 'org_units', 'org_positions', 'calendar_exceptions',
  'projects', 'tasks', 'task_dependencies', 'task_comments', 'project_participants', 'project_access',
  'violation_types', 'violations', 'violation_files', 'violation_ocr', 'violation_responses',
  'logos', 'files', 'card_print_batches', 'card_print_items', 'notifications', 'member_requests',
  'portfolios', 'time_entries', 'baselines', 'import_previews',
];

/** The only tables allowed to hold rows after the first boot (+ the smoke run). */
const ALLOWED_NON_EMPTY = new Set([
  'workspaces', 'users', 'workspace_memberships', 'settings', 'team_colors', 'card_sizes', 'card_templates',
  'calendars', 'audit_log', 'refresh_tokens',
]);

const b64 = (n: number) => randomBytes(n).toString('base64');
const urlSafe = () => randomBytes(24).toString('base64url').replace(/[-_]/g, 'x');
const MIGRATOR_PW = urlSafe();
const APP_PW = urlSafe();

/** The production environment of env/api.env + docker-compose.prod.yml (generated secrets). */
function productionEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('BOOTSTRAP_')) delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    PORT: '3000',
    TRUST_PROXY: '1',
    DATABASE_URL: `postgresql://nuzli:${MIGRATOR_PW}@db:5432/nuzli?schema=public`,
    APP_DATABASE_URL: `postgresql://nuzli_app:${APP_PW}@db:5432/nuzli?schema=public`,
    DB_REQUIRE_RLS: 'true',
    PUBLIC_WEB_URL: 'https://nuzli.example.sa',
    JWT_ACCESS_SECRET: b64(48),
    NATIONAL_ID_ENC_KEY: `v1:${b64(32)}`,
    NATIONAL_ID_HMAC_KEY: b64(32),
    S3_ENDPOINT: 'https://examplens.compat.objectstorage.me-jeddah-1.oraclecloud.com',
    S3_REGION: 'me-jeddah-1',
    S3_BUCKET: 'nuzli-files',
    S3_ACCESS_KEY: randomBytes(20).toString('hex'),
    S3_SECRET_KEY: b64(32),
    S3_FORCE_PATH_STYLE: 'true',
    MAIL_TRANSPORT: 'noop',
    SWAGGER_ENABLED: 'false',
    OCR_ENABLED: 'false',
    BOOTSTRAP_OWNER_USERNAME: 'mmansary',
  });
  delete process.env.CONVERTER_URL;
  delete process.env.PDF_SERVICE_URL;
  delete process.env.COOKIE_SECURE;
}

let db: PGlite;
let app: INestApplication | null = null;
let base = '';
let oneTimePassword = '';
const seedLog: string[] = [];
const report: Record<string, unknown> = {};

const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await q<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
  );
  const out: Record<string, number> = {};
  for (const { t } of tables) out[t] = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`))[0]!.n;
  return out;
}
const nonEmpty = (c: Record<string, number>) => Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0));

async function bootApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/main');
  const { AppConfig } = await import('../../src/config/app-config');
  const { PRISMA_CLIENT_OPTIONS } = await import('../../src/prisma/prisma.service');
  const { StorageService } = await import('../../src/storage/storage.service');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PRISMA_CLIENT_OPTIONS)
    .useValue({ adapter: pgliteAdapter(db) })
    .overrideProvider(StorageService)
    .useValue(new MemoryStorage())
    .compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ logger: process.env.NUZLI_TEST_LOG ? ['error', 'warn'] : false });
  configureApp(nest, nest.get(AppConfig));
  await nest.init();
  return nest;
}

interface Res {
  status: number;
  body: Record<string, unknown> & { [k: string]: unknown };
}
async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  productionEnv();
  db = await newPglite();
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  const lines = ['', '════════ verify:fresh-install — report ════════', JSON.stringify(report, null, 2), ''];
  process.stdout.write(lines.join('\n'));
});

describe('fresh production install (empty PostgreSQL → migrations → seed → API as nuzli_app)', () => {
  it('1. the whole migration chain applies to an EMPTY database as the migrator; the A12 data migration creates «إدارة المشاريع» and its count check passes with zero rows', async () => {
    const before = await tableCounts();
    expect(Object.keys(before)).toHaveLength(0);
    const notices: string[] = [];
    const applied: string[] = [];
    // The same files, in the same order, as `prisma migrate deploy` (prisma/migrations).
    for (const name of migrationNames()) {
      await db.exec(migrationSql(name), { onNotice: (n) => void notices.push(String(n.message)) });
      applied.push(name);
    }
    expect(applied.length).toBeGreaterThanOrEqual(16);
    expect(applied.at(-1)).toBe('20261025000000_a12_security_review');
    const counts = await tableCounts();
    expect(nonEmpty(counts)).toEqual({ workspaces: 1 });
    expect(await q(`SELECT name, code, status FROM workspaces`)).toEqual([{ name: 'إدارة المشاريع', code: 'projects', status: 'ACTIVE' }]);
    const role = await q<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    );
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
    // The A12 data migration verifies itself (counts before = after) and raises on any mismatch.
    expect(notices.some((n) => /^A12: 0 business rows moved/.test(n))).toBe(true);
    report.migrations = { applied: applied.length, last: applied.at(-1), tables: Object.keys(counts).length, a12Summary: notices.filter((n) => /business rows moved/.test(n)) };
  });

  it('2. the production seed creates ONLY the owner bootstrap and the neutral defaults; a second start changes nothing', async () => {
    const { runSeed } = await import('../../src/seed/seed');
    const migrator: PrismaClient = prismaOn(db);
    const first = await runSeed(migrator, process.env as never, (m) => seedLog.push(m));
    const line = seedLog.find((l) => l.includes('Temporary password'));
    expect(line).toBeDefined();
    oneTimePassword = /: (\S+)$/.exec(line!)![1]!;
    expect(oneTimePassword.length).toBeGreaterThanOrEqual(10);
    expect(seedLog.some((l) => l.includes('nuzli_app can log in'))).toBe(true);

    const counts = await tableCounts();
    report.afterFirstBoot = nonEmpty(counts);
    expect(nonEmpty(counts)).toEqual({
      workspaces: 1,
      users: 1,
      workspace_memberships: 1,
      settings: first.settingsCreated,
      team_colors: 24,
      card_sizes: 6,
      card_templates: 3,
      calendars: 1,
      audit_log: 1,
    });
    for (const t of MUST_BE_EMPTY) expect([t, counts[t]]).toEqual([t, 0]);

    const owner = await q<Record<string, unknown>>(
      `SELECT username, account_role, status, must_change_password, full_name, email, (password_hash LIKE '$argon2id$%') AS argon2id FROM users`,
    );
    expect(owner).toEqual([
      { username: 'mmansary', account_role: 'OWNER', status: 'ACTIVE', must_change_password: true, full_name: 'المالك', email: 'mmansary@owner.nuzli.invalid', argon2id: true },
    ]);
    expect(await q(`SELECT role, status FROM workspace_memberships`)).toEqual([{ role: 'ADMIN', status: 'ACTIVE' }]);
    expect(await q(`SELECT name, weekend_days FROM calendars`)).toEqual([{ name: 'التقويم الافتراضي', weekend_days: [5, 6] }]);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE password_hash LIKE '%' || $1 || '%'`, [oneTimePassword]))[0]!.n).toBe(0);
    expect(await q(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).toEqual([{ rolcanlogin: true }]);
    report.owner = { username: 'mmansary', accountRole: 'OWNER', mustChangePassword: true, passwordStored: 'argon2id hash only' };
    report.settingsKeys = (await q<{ key: string }>(`SELECT key FROM settings ORDER BY key`)).map((r) => r.key);

    // Second container start: idempotent, no second password, no new rows.
    const again: string[] = [];
    await runSeed(migrator, process.env as never, (m) => again.push(m));
    expect(again.some((l) => l.includes('Temporary password'))).toBe(false);
    expect(await tableCounts()).toEqual(counts);
  });

  it('3. DB_REQUIRE_RLS=true: the API refuses to start as the migrator (a role that bypasses RLS)', async () => {
    await asSuperuser(db);
    await expect(bootApp()).rejects.toThrow(/bypasses Row Level Security/);
  });

  it('4. the API starts as nuzli_app with DB_REQUIRE_RLS=true and NODE_ENV=production, on a real port', async () => {
    await asAppRole(db);
    expect(await q(`SELECT current_user AS u`)).toEqual([{ u: APP_ROLE }]);
    app = await bootApp();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  it('5. smoke: health, ready, first login with the one-time password, forced change, owner + one workspace, a second workspace, archive, back to single', async () => {
    const steps: string[] = [];
    const health = await call('GET', '/health');
    expect([health.status, health.body.status]).toEqual([200, 'ok']);
    const ready = await call('GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', checks: { db: true, storage: true } });
    steps.push('GET /health 200 ok', 'GET /ready 200 ready (db, storage)');

    const wrong = await call('POST', '/auth/login', undefined, { identifier: 'mmansary', password: 'NotThePassword1' });
    expect(wrong.status).toBe(401);
    const login = await call('POST', '/auth/login', undefined, { identifier: 'mmansary', password: oneTimePassword });
    expect(login.status).toBe(200);
    const t1 = login.body.accessToken as string;
    expect((login.body.user as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    steps.push('POST /auth/login mmansary + one-time password 200 (mustChangePassword: true)');

    const blocked = await call('GET', '/projects', t1);
    expect(blocked.status).toBe(403);
    steps.push(`GET /projects before the change ${blocked.status} ${String(blocked.body.code)}`);

    const changed = await call('POST', '/auth/change-password', t1, { currentPassword: oneTimePassword, newPassword: 'OwnerChosen2026x' });
    expect(changed.status).toBe(200);
    const token = changed.body.accessToken as string;
    steps.push('POST /auth/change-password 200');
    expect((await call('POST', '/auth/login', undefined, { identifier: 'mmansary', password: oneTimePassword })).status).toBe(401);
    steps.push('the one-time password no longer works (401)');

    const me = await call('GET', '/auth/me', token);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: 'mmansary', accountRole: 'OWNER', role: 'OWNER', mustChangePassword: false });
    const mine = await call('GET', '/auth/workspaces', token);
    expect(mine.status).toBe(200);
    expect((mine.body as unknown as Array<{ name: string }>).map((w) => w.name)).toEqual(['إدارة المشاريع']);
    const info1 = await call('GET', '/system/info', token);
    expect(info1.body).toMatchObject({ workspaceCount: 1, singleWorkspace: true });
    steps.push('GET /auth/me → OWNER, mustChangePassword false; GET /auth/workspaces → [إدارة المشاريع]; /system/info → 1, single');

    const projects = await call('GET', '/projects', token);
    expect(projects.status).toBe(200);
    steps.push(`GET /projects after the change ${projects.status} (empty: ${JSON.stringify(projects.body).length < 200})`);

    const created = await call('POST', '/workspaces', token, { name: 'قسم التحقق' });
    expect(created.status).toBe(201);
    const wsId = created.body.id as string;
    const info2 = await call('GET', '/system/info', token);
    expect(info2.body).toMatchObject({ workspaceCount: 2, singleWorkspace: false });
    steps.push('POST /workspaces «قسم التحقق» 201; /system/info → 2, not single');

    const archived = await call('POST', `/workspaces/${wsId}/archive`, token, {});
    expect(archived.status).toBe(200);
    const info3 = await call('GET', '/system/info', token);
    expect(info3.body).toMatchObject({ workspaceCount: 1, singleWorkspace: true });
    const pub = await call('GET', '/public/workspaces');
    expect((pub.body as unknown as Array<{ name: string }>).map((w) => w.name)).toEqual(['إدارة المشاريع']);
    steps.push('POST /workspaces/:id/archive 200; /system/info → 1, single again; /public/workspaces → [إدارة المشاريع]');
    report.smoke = steps;
    report.archivedWorkspaceId = wsId;
  });

  it('6. RLS is effective for nuzli_app: nothing without a workspace, only the bound workspace, no cross writes, no bypass', async () => {
    await app!.close();
    app = null;
    const tables = await scopedTables(db);
    expect(tables).toHaveLength(47);
    await asSuperuser(db);
    const flags = await q<{ relname: string; rls: boolean; force: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [tables],
    );
    expect(flags.filter((f) => !f.rls || !f.force)).toEqual([]);
    const [ws1, ws2] = (await q<{ id: string }>(`SELECT id FROM workspaces ORDER BY created_at`)).map((r) => r.id);
    const allSettings = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM settings`))[0]!.n;

    const asApp = async <T>(ws: string | null, bypass: boolean, fn: () => Promise<T>): Promise<T> => {
      await asAppRole(db);
      await db.exec('BEGIN');
      try {
        await db.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.bypass_rls', $2, true)`, [ws ?? '', bypass ? 'on' : 'off']);
        return await fn();
      } finally {
        await db.exec('ROLLBACK');
        await asSuperuser(db);
      }
    };
    const n = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0]!.n;

    const noContext = await asApp(null, false, () => n(`SELECT count(*)::int AS n FROM settings`));
    const inWs1 = await asApp(ws1!, false, () => n(`SELECT count(*)::int AS n FROM settings`));
    const crossRead = await asApp(ws1!, false, () => n(`SELECT count(*)::int AS n FROM settings WHERE workspace_id = $1`, [ws2]));
    const bypassTry = await asApp(ws1!, true, () => n(`SELECT count(*)::int AS n FROM settings WHERE workspace_id = $1`, [ws2]));
    const crossWrite = await asApp(ws1!, false, async () => {
      try {
        await db.query(`INSERT INTO team_colors (workspace_id, name, hex, sort_order) VALUES ($1, 'x', '#123456', 99)`, [ws2]);
        return 'inserted';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(allSettings).toBeGreaterThan(0);
    expect(noContext).toBe(0);
    expect(inWs1).toBe(allSettings / 2);
    expect(crossRead).toBe(0);
    expect(bypassTry).toBe(0);
    expect(crossWrite).toMatch(/row-level security/i);
    report.rls = {
      scopedTables: tables.length,
      enabledAndForced: tables.length,
      settingsVisibleWithoutWorkspace: noContext,
      settingsVisibleInWorkspace1: `${inWs1} of ${allSettings}`,
      workspace2RowsVisibleFromWorkspace1: crossRead,
      withAppBypassGucSet: bypassTry,
      crossWorkspaceInsert: 'refused (row-level security)',
    };
  });

  it('7. after the smoke run the database still holds no business data — only accounts, workspaces and neutral defaults', async () => {
    await asSuperuser(db);
    const counts = await tableCounts();
    const extra = Object.keys(nonEmpty(counts)).filter((t) => !ALLOWED_NON_EMPTY.has(t));
    expect(extra).toEqual([]);
    for (const t of MUST_BE_EMPTY) expect([t, counts[t]]).toEqual([t, 0]);
    expect(counts.users).toBe(1);
    report.afterSmoke = nonEmpty(counts);
    // infra/backup/restore.sh refuses a restored copy without a top account. A fresh install has
    // one OWNER and NO legacy users.role (the pre-A12 check would refuse every fresh backup).
    const hasOwnerCol = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'account_role'`,
    );
    expect(hasOwnerCol[0]!.n).toBe(1);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "users" WHERE account_role = 'OWNER'`))[0]!.n).toBe(1);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "users" WHERE role = 'ADMIN'`))[0]!.n).toBe(0);
    report.restoreSanityCheck = 'owners: 1 (restore.sh A12 check passes; the legacy role check would have found 0)';
    report.auditActions = (await q<{ action: string }>(`SELECT action FROM audit_log ORDER BY at, action`)).map((r) => r.action);
  });
});
