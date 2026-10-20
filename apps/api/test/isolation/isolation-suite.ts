/**
 * A12 — the route-by-route isolation suite (the core deliverable of A12 round 1).
 *
 * Every route of the running API (read from Nest's metadata) is called by the users of workspace A
 * — admin, supervisor, monitor (also a project participant since A12 round 2), an assistant with
 * every module at "edit", and an owner working in A — with workspace B's ids in the path, the
 * query and the body. It runs twice:
 *   - `rls: true`  — as the application role: the scoping layer AND PostgreSQL RLS;
 *   - `rls: false` — as a superuser (RLS bypassed): the application scoping layer ALONE must hold.
 *
 * Security review A12 M5 (ADR-166) made the suite a gate that fails when the app-layer filter of
 * ANY one of the 47 scoped models is removed (`npm run test:isolation:mutation` proves it, 47/47):
 *   - a sixth identity, a person with roles in BOTH workspaces (SUPERVISOR in A, ADMIN in B) with
 *     B rows keyed by their id, probes every route from A;
 *   - parameterised routes are probed with every value (`/reference/:kind` for every kind);
 *   - B's settings use real keys the API reads, and A must read its own values;
 *   - every scoped model is read directly through the API's own Prisma client in A's context: a
 *     model whose filter is gone returns B's rows (this reaches the child models that HTTP only
 *     loads through an already-scoped parent id).
 */
import argon2 from 'argon2';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_MODULES, VIEW_ONLY_MODULES } from '@nuzli/shared';
import { CryptoService } from '../../src/crypto/crypto.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SCOPED_MODELS } from '../../src/prisma/scoping';
import { runInWorkspace } from '../../src/prisma/workspace-context';
import { REFERENCE_KINDS } from '../../src/reference/reference.service';
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { bearer, login, ownerSession, startPgApp, type PgApp, type Session } from '../support/pglite-app';
import { asAppRole, asSuperuser, scopedTables } from '../support/pglite';
import { listRoutes, type RouteInfo } from '../support/routes';
import { insertDualMember, insertProbeSettings, insertUsers, insertWorkspace, insertWorkspaceRows, SETTING_PROBE, type WorkspaceFixture } from '../support/workspace-fixture';
import { CASES, paramId, type Case, type Fx } from './cases';

const PASSWORD = 'Isolation-Pass-1';

interface Probe {
  role: string;
  route: string;
  label: string;
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  targetsB: boolean;
  allow2xx?: string;
}

interface Outcome {
  status: number;
  code?: string;
  text: string;
}

/** Lists that must show A's own data to the admin of A (positive controls: the probes are not vacuous). */
const MUST_SHOW_A = [
  'GET /teams', 'GET /members', 'GET /projects', 'GET /users', 'GET /violations', 'GET /audit', 'GET /notifications',
  'GET /org', 'GET /calendars', 'GET /portfolios', 'GET /colors', 'GET /logos', 'GET /cards/templates', 'GET /cards/sizes',
  'GET /violation-types', 'GET /hub', 'GET /registrations',
  // A12 round 2
  'GET /member-requests',
];

/**
 * The identities of A that probe B (A12 round 2 adds the assistant; security review M5 the person
 * with roles in both workspaces, working in A).
 */
const ROLES = ['admin', 'supervisor', 'monitor', 'assistant', 'owner', 'dual'] as const;

/** M5: every value of `/reference/:kind` → the fixture id of an item of that kind. */
const REFERENCE_KIND_IDS: Record<string, string> = { departments: 'department', 'job-titles': 'jobTitle' };

/** Prisma delegate name of a model (`TeamColor` → `teamColor`). */
const delegateOf = (model: string) => model[0]!.toLowerCase() + model.slice(1);

function idsOf(f: WorkspaceFixture): string[] {
  return [...Object.values(f.ids), ...Object.values(f.users)];
}

function fill(route: RouteInfo, f: (param: string) => string): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_, p: string) => f(p));
}

async function responseText(res: { headers: Record<string, string>; body: unknown }): Promise<string> {
  const type = String(res.headers['content-type'] ?? '');
  const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(JSON.stringify(res.body ?? ''));
  if (type.includes('spreadsheetml')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.text ?? '')))));
    return cells.join('\n');
  }
  return buf.toString('utf8');
}

export function defineIsolationSuite(opts: { rls: boolean; skipModelProbe?: boolean }): void {
  const mode = opts.rls ? 'application scoping + PostgreSQL RLS (nuzli_app)' : 'application scoping alone (RLS bypassed)';

  describe(`A12 isolation — every route, workspace A against workspace B — ${mode}`, () => {
    let ctx: PgApp;
    let A: WorkspaceFixture;
    let B: WorkspaceFixture;
    let routes: RouteInfo[];
    const sessions: Record<string, Session> = {};
    let snapshotBefore: Record<string, string>;
    let dual: { id: string; username: string };
    const failures: string[] = [];
    const stats = { probes: 0, byRole: {} as Record<string, number>, byStatus: {} as Record<string, number>, validation400: [] as string[] };

    const asSuper = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (opts.rls) await asSuperuser(ctx.db);
      try {
        return await fn();
      } finally {
        if (opts.rls) await asAppRole(ctx.db);
      }
    };

    /** Every B row, hashed table by table (+ B's accounts and memberships). */
    const snapshotB = () =>
      asSuper(async () => {
        const out: Record<string, string> = {};
        for (const t of await scopedTables(ctx.db)) {
          const r = await ctx.db.query<{ n: number; h: string }>(
            `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x WHERE workspace_id = $1`,
            [B.workspaceId],
          );
          out[t] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
        }
        const users = await ctx.db.query<{ h: string }>(
          `SELECT md5(string_agg(x::text, '|' ORDER BY x.id)) AS h FROM (SELECT id, status, account_role, full_name, email, mobile, username, password_hash, failed_login_count, locked_until, photo_file_id, suspended_globally FROM users WHERE id = ANY($1)) x`,
          // M5: the dual member is a B account too (account-level side effects are caught).
          [[...Object.values(B.users), dual.id]],
        );
        out.users = users.rows[0]!.h;
        const m = await ctx.db.query<{ h: string }>(
          `SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM workspace_memberships x WHERE workspace_id = $1`,
          [B.workspaceId],
        );
        out.workspace_memberships = m.rows[0]!.h;
        return out;
      });

    async function call(s: Session, method: string, path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<Outcome> {
      const m = method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      let req = ctx.http()[m](`/api/v1${path}`).set(bearer(s)).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
      if (query) req = req.query(query);
      if (body !== undefined) req = req.send(body as object);
      const res = await req.buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      const text = await responseText(res as unknown as { headers: Record<string, string>; body: unknown });
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { code?: string }).code;
      } catch {
        code = undefined;
      }
      return { status: res.status, code, text };
    }

    beforeAll(async () => {
      unitWorkspaceFallback.enabled = false;
      ctx = await startPgApp({ rls: opts.rls });
      const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
      await asSuper(async () => {
        const wsA = (await ctx.db.query<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`)).rows[0]!.id;
        const wsB = await insertWorkspace(ctx.db, 'beta', 'قسم ب');
        const crypto = ctx.app.get(CryptoService);
        const encrypt = (plain: string) => Buffer.from(crypto.encrypt(plain));
        const ua = await insertUsers(ctx.db, { workspaceId: wsA, tag: 'WSA-SECRET', passwordHash: hash, encrypt });
        const ub = await insertUsers(ctx.db, { workspaceId: wsB, tag: 'WSB-SECRET', passwordHash: hash, encrypt });
        A = await insertWorkspaceRows(ctx.db, { workspaceId: wsA, tag: 'WSA-SECRET', users: ua, encrypt });
        B = await insertWorkspaceRows(ctx.db, { workspaceId: wsB, tag: 'WSB-SECRET', users: ub, encrypt });
        // A12 round 2: the membership routes take a membership id (the supervisor's in each workspace).
        for (const F of [A, B]) {
          const m = await ctx.db.query<{ id: string }>(`SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`, [F.workspaceId, F.users.supervisor]);
          F.ids.membership = m.rows[0]!.id;
        }
        // A12 round 2: an assistant of A with EVERY module at its highest level (no scope limit).
        const assistantId = randomUUID();
        await ctx.db.query(
          `INSERT INTO users (id, full_name, email, mobile, national_id_enc, national_id_hash, national_id_last2, national_id_first, password_hash, status, username, updated_at)
           VALUES ($1, 'WSA-SECRET assistant', 'assistant.wsa@nuzli.test', '+966588888801', decode('0102', 'hex'), 'hash-wsa-assistant', '23', '1', $2, 'ACTIVE', 'assistant.wsa', now())`,
          [assistantId, hash],
        );
        const perms = Object.fromEntries(ASSISTANT_MODULES.map((m) => [m, VIEW_ONLY_MODULES.has(m) ? 'view' : 'edit']));
        await ctx.db.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role, permissions) VALUES ($1, $2, 'ASSISTANT', $3)`, [wsA, assistantId, JSON.stringify(perms)]);
        // Security review M5: the person with roles in both workspaces, and real setting keys.
        dual = await insertDualMember(ctx.db, { A, B, passwordHash: hash, encrypt });
        await insertProbeSettings(ctx.db, A, B);
      });
      const usernames = await asSuper(async () => {
        const r = await ctx.db.query<{ id: string; username: string }>(`SELECT id, username FROM users`);
        return new Map(r.rows.map((x) => [x.id, x.username]));
      });
      for (const role of ['admin', 'supervisor', 'monitor'] as const) {
        sessions[role] = await login(ctx, usernames.get(A.users[role])!, PASSWORD);
        expect((sessions[role]!.body.activeWorkspace as { id: string }).id).toBe(A.workspaceId);
      }
      sessions.assistant = await login(ctx, 'assistant.wsa', PASSWORD);
      expect((sessions.assistant!.body.activeWorkspace as { id: string }).id).toBe(A.workspaceId);
      // The dual member has two workspaces (no automatic choice) and works in A.
      const d = await login(ctx, dual.username, PASSWORD);
      expect(d.body.activeWorkspace).toBeNull();
      const dsw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(d)).set('Cookie', d.cookie).send({ workspaceId: A.workspaceId });
      expect(dsw.status).toBe(200);
      sessions.dual = { accessToken: dsw.body.accessToken, cookie: d.cookie, csrf: d.csrf, body: dsw.body };
      // The owner sees two workspaces (no automatic choice) and works in A.
      const owner = await ownerSession(ctx);
      expect(owner.body.activeWorkspace).toBeNull();
      const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(owner)).set('Cookie', owner.cookie).send({ workspaceId: A.workspaceId });
      expect(sw.status).toBe(200);
      sessions.owner = { accessToken: sw.body.accessToken, cookie: owner.cookie, csrf: owner.csrf, body: sw.body };
      routes = listRoutes(ctx.app);
      snapshotBefore = await snapshotB();
    });

    afterAll(async () => {
      await ctx?.close();
    });

    it('COVERAGE: every route of the API has an isolation case (a new route fails here until it gets one)', () => {
      const missing = routes.filter((r) => !CASES[r.key]).map((r) => r.key);
      const stale = Object.keys(CASES).filter((k) => !routes.some((r) => r.key === k));
      expect({ missing, stale }).toEqual({ missing: [], stale: [] });
      expect(routes.length).toBeGreaterThanOrEqual(199);
    });

    it('the fixture put data of both workspaces in all 47 business tables', async () => {
      expect(Object.keys(A.counts)).toHaveLength(47);
      expect(Object.keys(B.counts)).toHaveLength(47);
    });

    it('positive controls: the admin of A sees A’s own data (the probes below are not vacuous)', async () => {
      const missingA: string[] = [];
      for (const key of MUST_SHOW_A) {
        const r = routes.find((x) => x.key === key)!;
        const out = await call(sessions.admin!, r.method, r.path);
        if (out.status >= 400 || !out.text.includes(A.tag)) missingA.push(`${key} → ${out.status} ${out.code ?? ''}`);
      }
      // M5: every kind of /reference/:kind lists A's own items.
      for (const kind of Object.keys(REFERENCE_KINDS)) {
        const out = await call(sessions.admin!, 'GET', `/reference/${kind}`);
        if (out.status >= 400 || !out.text.includes(A.tag)) missingA.push(`GET /reference/${kind} → ${out.status} ${out.code ?? ''}`);
      }
      // Every GET with ids, aimed at A's own rows, answers (no 4xx/5xx) unless documented.
      for (const r of routes.filter((x) => x.method === 'GET' && x.path.includes(':'))) {
        const c = CASES[r.key]!;
        if (c.skip || c.positive === false || (c.positive && 'reason' in c.positive)) continue;
        const fx: Fx = { t: A, A, B };
        const out = await call(sessions.admin!, r.method, fill(r, (p) => paramId(r.path, p, A)), c.query?.(fx));
        if (out.status >= 400 && !['PDF_NOT_CONFIGURED'].includes(out.code ?? '')) missingA.push(`${r.key} (A ids) → ${out.status} ${out.code ?? ''}`);
      }
      expect(missingA).toEqual([]);
    });

    it('NO LEAK: every route × every role of A, aimed at B (path ids, query ids, body ids) → refused, nothing of B in any response', async () => {
      const fx: Fx = { t: B, A, B };
      const fingerprints = [B.tag, ...idsOf(B)];
      const probes: Probe[] = [];
      for (const r of routes) {
        const c: Case = CASES[r.key]!;
        if (!c || c.skip) continue;
        const variants: Array<{ label: string; path: string; targetsB: boolean }> = [];
        const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
        // M5: a route parameter that is an enumeration is probed with EVERY value.
        const kinds = params.includes('kind') ? Object.keys(REFERENCE_KINDS) : [null];
        for (const kind of kinds) {
          if (kind && !REFERENCE_KIND_IDS[kind]) throw new Error(`no fixture row for /reference/${kind} — add it to REFERENCE_KIND_IDS`);
          const idOf = (F: WorkspaceFixture) => (p: string) =>
            p === 'kind' && kind ? kind : p === 'id' && kind ? F.ids[REFERENCE_KIND_IDS[kind]!]! : paramId(r.path, p, F);
          const tagKind = kind ? ` ${kind}` : '';
          if (params.length === 0) variants.push({ label: 'no path ids', path: r.path, targetsB: false });
          else {
            variants.push({ label: `B ids${tagKind}`, path: fill(r, idOf(B)), targetsB: !r.path.startsWith('/reference/:kind') || params.length > 1 });
            if (params.length > 1) {
              const first = params[0]!;
              variants.push({ label: `A parent, B child${tagKind}`, path: fill(r, (p) => (p === first ? idOf(A)(p) : idOf(B)(p))), targetsB: true });
            }
          }
        }
        const bodies: Array<{ label: string; body?: Case['body']; query?: Case['query']; allow2xx?: string }> = [
          { label: '', body: c.body, query: c.query },
          ...(c.extra ?? []),
        ];
        for (const v of variants) {
          for (const b of bodies) {
            const body = b.body?.(fx);
            const query = b.query?.(fx);
            const sent = JSON.stringify({ body, query });
            const refsB = idsOf(B).some((id) => sent.includes(id));
            for (const role of ROLES) {
              // Owners act on every workspace by design (round 2 admin routes): covered elsewhere.
              if (role === 'owner' && c.ownerSkip) continue;
              probes.push({
                role,
                route: r.key,
                label: [v.label, b.label].filter(Boolean).join(' / '),
                method: r.method,
                path: v.path,
                query,
                body,
                // A list/search filtered by a foreign id may answer 200 (with nothing of B) — the
                // leak check decides; ids in the path or in a write body must be refused.
                targetsB: v.targetsB || (refsB && r.method !== 'GET') || (!!c.ownerOnly && role !== 'owner'),
                allow2xx: b.allow2xx ?? c.allow2xx,
              });
            }
          }
        }
      }
      for (const p of probes) {
        const out = await call(sessions[p.role]!, p.method, p.path, p.query, p.body);
        stats.probes++;
        stats.byRole[p.role] = (stats.byRole[p.role] ?? 0) + 1;
        stats.byStatus[out.status] = (stats.byStatus[out.status] ?? 0) + 1;
        const where = `${p.role} ${p.route}${p.label ? ` [${p.label}]` : ''} → ${out.status} ${out.code ?? ''}`;
        // An error may echo an id the CALLER sent (e.g. "these project ids were not found"): that
        // is the caller's own input, not B data. Every other B id, and any B text, is a leak.
        const sent = `${p.path} ${JSON.stringify(p.query ?? {})} ${JSON.stringify(p.body ?? {})}`;
        const leaked = fingerprints.filter((fp) => out.text.includes(fp) && (fp === B.tag || !sent.includes(fp)));
        if (leaked.length) failures.push(`LEAK ${where}: ${leaked.map((x) => (x === B.tag ? 'B text' : `B id ${x.slice(0, 8)}`)).join(', ')}`);
        if (out.status >= 500 && out.status !== 501) failures.push(`5xx ${where}`);
        if (p.targetsB && out.status < 400 && !p.allow2xx) failures.push(`ACCEPTED ${where}`);
        if (p.role === 'admin' && p.targetsB && out.status === 400 && out.code === 'VALIDATION_FAILED') stats.validation400.push(`${where} ${out.text.slice(0, 160)}`);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[isolation ${opts.rls ? 'rls' : 'app-layer'}] ${routes.length} routes, ${stats.probes} probes`,
        JSON.stringify({ byRole: stats.byRole, byStatus: stats.byStatus }),
        stats.validation400.length ? `\n  admin probes stopped by body validation (${stats.validation400.length}):\n  ${stats.validation400.join('\n  ')}` : '',
      );
      expect(failures).toEqual([]);
      expect(stats.probes).toBeGreaterThan(1000);
      expect(Object.keys(stats.byRole).sort()).toEqual([...ROLES].sort());
    });

    it('M5: A reads its OWN settings — B’s value of a real key never overrides A’s', async () => {
      for (const role of ['admin', 'dual'] as const) {
        const out = await call(sessions[role]!, 'GET', '/settings');
        expect(out.status).toBe(200);
        expect((JSON.parse(out.text) as Record<string, unknown>)[SETTING_PROBE.key]).toBe(SETTING_PROBE.defaultValue);
      }
    });

    it('M5: the dual member, working in A, sees A’s side of their account only (notifications, participations, my teams, my time)', async () => {
      const leaks: string[] = [];
      for (const path of ['/notifications', '/notifications/unread-count', '/me/participations', '/teams', '/tasks/mine', '/hub', '/me/view-prefs', '/me/time-entries?from=2026-09-01&to=2026-11-30', '/org']) {
        const [p, qs] = path.split('?');
        const query = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined;
        const out = await call(sessions.dual!, 'GET', p!, query);
        if (out.text.includes(B.tag)) leaks.push(`${path} → ${out.status}`);
      }
      const n = await call(sessions.dual!, 'GET', '/notifications/unread-count');
      expect(JSON.parse(n.text)).toEqual({ count: 0 });
      expect(leaks).toEqual([]);
    });

    (opts.skipModelProbe ? it.skip : it)('M5: APP LAYER, model by model — every one of the 47 scoped models read in A’s context returns no row of B', async () => {
      const prisma = ctx.app.get(PrismaService) as unknown as Record<string, { findMany(a?: unknown): Promise<Array<{ workspaceId?: string | null }>>; count(a?: unknown): Promise<number>; findFirst(a?: unknown): Promise<unknown> }>;
      const leaks: string[] = [];
      expect(SCOPED_MODELS.size).toBe(47);
      for (const model of SCOPED_MODELS) {
        const d = prisma[delegateOf(model)];
        if (!d) throw new Error(`no Prisma delegate for ${model}`);
        const rows = await runInWorkspace(A.workspaceId!, () => d.findMany({}), 'isolation-probe');
        const foreign = rows.filter((r) => r.workspaceId !== A.workspaceId && !(model === 'File' && r.workspaceId === null));
        if (foreign.length) leaks.push(`${model}.findMany → ${foreign.length} row(s) of another workspace`);
        const inB = await runInWorkspace(A.workspaceId!, () => d.count({ where: { workspaceId: B.workspaceId } }), 'isolation-probe');
        if (inB) leaks.push(`${model}.count(workspaceId = B) → ${inB}`);
        const first = await runInWorkspace(A.workspaceId!, () => d.findFirst({ where: { workspaceId: B.workspaceId } }), 'isolation-probe');
        if (first) leaks.push(`${model}.findFirst(workspaceId = B) → a row`);
      }
      expect(leaks).toEqual([]);
    });

    it('NOTHING CHANGED IN B: every B row (47 tables), B accounts and memberships are byte-for-byte identical after all probes', async () => {
      expect(await snapshotB()).toEqual(snapshotBefore);
    });
  });
}
