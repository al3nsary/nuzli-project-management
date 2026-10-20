/**
 * A12 — the route-by-route isolation suite (the core deliverable of A12 round 1).
 *
 * Every route of the running API (read from Nest's metadata) is called by the users of workspace A
 * — admin, supervisor, monitor, and an owner working in A — with workspace B's ids in the path,
 * the query and the body. It runs twice:
 *   - `rls: true`  — as the application role: the scoping layer AND PostgreSQL RLS;
 *   - `rls: false` — as a superuser (RLS bypassed): the application scoping layer ALONE must hold.
 */
import argon2 from 'argon2';
import ExcelJS from 'exceljs';
import { CryptoService } from '../../src/crypto/crypto.service';
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { bearer, login, ownerSession, startPgApp, type PgApp, type Session } from '../support/pglite-app';
import { asAppRole, asSuperuser, scopedTables } from '../support/pglite';
import { listRoutes, type RouteInfo } from '../support/routes';
import { insertUsers, insertWorkspace, insertWorkspaceRows, type WorkspaceFixture } from '../support/workspace-fixture';
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
];

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

export function defineIsolationSuite(opts: { rls: boolean }): void {
  const mode = opts.rls ? 'application scoping + PostgreSQL RLS (nuzli_app)' : 'application scoping alone (RLS bypassed)';

  describe(`A12 isolation — every route, workspace A against workspace B — ${mode}`, () => {
    let ctx: PgApp;
    let A: WorkspaceFixture;
    let B: WorkspaceFixture;
    let routes: RouteInfo[];
    const sessions: Record<string, Session> = {};
    let snapshotBefore: Record<string, string>;
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
          `SELECT md5(string_agg(x::text, '|' ORDER BY x.id)) AS h FROM (SELECT id, status, account_role, full_name, email, username, password_hash, failed_login_count, locked_until FROM users WHERE id = ANY($1)) x`,
          [Object.values(B.users)],
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
      });
      const usernames = await asSuper(async () => {
        const r = await ctx.db.query<{ id: string; username: string }>(`SELECT id, username FROM users`);
        return new Map(r.rows.map((x) => [x.id, x.username]));
      });
      for (const role of ['admin', 'supervisor', 'monitor'] as const) {
        sessions[role] = await login(ctx, usernames.get(A.users[role])!, PASSWORD);
        expect((sessions[role]!.body.activeWorkspace as { id: string }).id).toBe(A.workspaceId);
      }
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

    it('the fixture put data of both workspaces in all 45 business tables', async () => {
      expect(Object.keys(A.counts)).toHaveLength(45);
      expect(Object.keys(B.counts)).toHaveLength(45);
    });

    it('positive controls: the admin of A sees A’s own data (the probes below are not vacuous)', async () => {
      const missingA: string[] = [];
      for (const key of MUST_SHOW_A) {
        const r = routes.find((x) => x.key === key)!;
        const out = await call(sessions.admin!, r.method, r.path);
        if (out.status >= 400 || !out.text.includes(A.tag)) missingA.push(`${key} → ${out.status} ${out.code ?? ''}`);
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
        if (params.length === 0) variants.push({ label: 'no path ids', path: r.path, targetsB: false });
        else {
          variants.push({ label: 'B ids', path: fill(r, (p) => paramId(r.path, p, B)), targetsB: !r.path.startsWith('/reference/:kind') || params.length > 1 });
          if (params.length > 1) {
            const first = params[0]!;
            variants.push({ label: 'A parent, B child', path: fill(r, (p) => (p === first ? paramId(r.path, p, A) : paramId(r.path, p, B))), targetsB: true });
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
            for (const role of ['admin', 'supervisor', 'monitor', 'owner']) {
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
                targetsB: v.targetsB || (refsB && r.method !== 'GET'),
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
      expect(stats.probes).toBeGreaterThan(800);
    });

    it('NOTHING CHANGED IN B: every B row (45 tables), B accounts and memberships are byte-for-byte identical after all probes', async () => {
      expect(await snapshotB()).toEqual(snapshotBefore);
    });
  });
}
