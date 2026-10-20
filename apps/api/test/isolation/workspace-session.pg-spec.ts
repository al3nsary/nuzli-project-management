/**
 * A12 — sessions and workspaces on the real stack (PGlite, RLS on): single-workspace mode,
 * login/refresh/switch with the `wid` claim, membership checks, archived workspaces, registration
 * by workspace, the audited owner escape hatch, fail-closed scoping and per-workspace jobs.
 */
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { CryptoService } from '../../src/crypto/crypto.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { newStore, runInWorkspace, workspaceStorage, WorkspaceScopeError } from '../../src/prisma/workspace-context';
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { bearer, cookiesFrom, login, ownerSession, startPgApp, validNationalId, type PgApp, type Session } from '../support/pglite-app';
import { asAppRole, asSuperuser } from '../support/pglite';
import { insertUsers, insertWorkspace, insertWorkspaceRows, type FixtureUsers, type WorkspaceFixture } from '../support/workspace-fixture';

jest.setTimeout(180_000);

const PASSWORD = 'Session-Pass-1';
const wid = (s: { accessToken: string } | string) => (jwt.decode(typeof s === 'string' ? s : s.accessToken) as { wid: string | null }).wid;

let ctx: PgApp;
let wsA: string;
let owner: Session;

async function superuser<T>(fn: () => Promise<T>): Promise<T> {
  await asSuperuser(ctx.db);
  try {
    return await fn();
  } finally {
    await asAppRole(ctx.db);
  }
}

beforeAll(async () => {
  unitWorkspaceFallback.enabled = false;
  ctx = await startPgApp({ rls: true });
  wsA = (await superuser(() => ctx.db.query<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`))).rows[0]!.id;
});

afterAll(async () => {
  await ctx?.close();
});

describe('single-workspace mode (only «إدارة المشاريع» exists)', () => {
  it('the owner logs in by USERNAME; the only workspace is selected automatically and bound to the token', async () => {
    owner = await ownerSession(ctx);
    expect(owner.body.singleWorkspace).toBe(true);
    expect((owner.body.activeWorkspace as { id: string; name: string }).name).toBe('إدارة المشاريع');
    expect(wid(owner)).toBe(wsA);
    expect((owner.body.user as { username: string; accountRole: string }).username).toBe('mmansary');
    expect((owner.body.user as { accountRole: string }).accountRole).toBe('OWNER');
  });

  it('GET /system/info says single workspace; GET /public/workspaces lists names only', async () => {
    const info = await ctx.http().get('/api/v1/system/info').set(bearer(owner)).expect(200);
    expect(info.body).toEqual({ workspaceCount: 1, singleWorkspace: true, workspaces: [{ id: wsA, name: 'إدارة المشاريع', code: 'projects' }] });
    const pub = await ctx.http().get('/api/v1/public/workspaces').expect(200);
    expect(pub.body).toEqual([{ id: wsA, name: 'إدارة المشاريع' }]);
  });

  it('registration needs no workspace choice and lands in «إدارة المشاريع»', async () => {
    await ctx.http().post('/api/v1/auth/register').send({
      accountType: 'MONITOR', fullName: 'متقدم واحد', email: 'one@nuzli.test', mobile: '0551000001', nationalId: validNationalId('100000010'), password: 'Applicant-Pass-1',
    }).expect(201);
    const r = await superuser(() => ctx.db.query<{ requested_workspace_id: string; username: string }>(`SELECT requested_workspace_id, username FROM users WHERE email = 'one@nuzli.test'`));
    expect(r.rows[0]).toEqual({ requested_workspace_id: wsA, username: 'one' });
    const regs = await ctx.http().get('/api/v1/registrations').set(bearer(owner)).expect(200);
    expect(JSON.stringify(regs.body)).toContain('one@nuzli.test');
  });
});

describe('several workspaces', () => {
  let wsB: string;
  let A: WorkspaceFixture;
  let B: WorkspaceFixture;
  let ua: FixtureUsers;
  let ub: FixtureUsers;
  const username = new Map<string, string>();

  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const crypto = ctx.app.get(CryptoService);
    const encrypt = (plain: string) => Buffer.from(crypto.encrypt(plain));
    await superuser(async () => {
      wsB = await insertWorkspace(ctx.db, 'beta', 'قسم ب');
      ua = await insertUsers(ctx.db, { workspaceId: wsA, tag: 'WSA-SECRET', passwordHash: hash, encrypt });
      ub = await insertUsers(ctx.db, { workspaceId: wsB, tag: 'WSB-SECRET', passwordHash: hash, encrypt });
      A = await insertWorkspaceRows(ctx.db, { workspaceId: wsA, tag: 'WSA-SECRET', users: ua, encrypt });
      B = await insertWorkspaceRows(ctx.db, { workspaceId: wsB, tag: 'WSB-SECRET', users: ub, encrypt });
      for (const r of (await ctx.db.query<{ id: string; username: string }>(`SELECT id, username FROM users`)).rows) username.set(r.id, r.username);
    });
  });

  it('GET /system/info: two workspaces, no list for non-owners; the public list shows names only', async () => {
    const admin = await login(ctx, username.get(ua.admin)!, PASSWORD);
    const info = await ctx.http().get('/api/v1/system/info').set(bearer(admin)).expect(200);
    expect(info.body).toEqual({ workspaceCount: 2, singleWorkspace: false });
    const pub = await ctx.http().get('/api/v1/public/workspaces').expect(200);
    expect(pub.body.map((w: { name: string }) => w.name)).toEqual(['إدارة المشاريع', 'قسم ب']);
    expect(Object.keys(pub.body[0]).sort()).toEqual(['id', 'name']);
  });

  it('a user of one workspace gets it automatically and can NOT switch to another (403, audited nowhere)', async () => {
    const admin = await login(ctx, username.get(ua.admin)!, PASSWORD);
    expect(wid(admin)).toBe(wsA);
    expect(admin.body.workspaces).toEqual([{ id: wsA, name: 'إدارة المشاريع', code: 'projects', roles: ['ADMIN'] }]);
    const res = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(admin)).set('Cookie', admin.cookie).send({ workspaceId: wsB });
    expect([res.status, res.body.code]).toEqual([403, 'WORKSPACE_FORBIDDEN']);
    const unknown = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(admin)).send({ workspaceId: '00000000-0000-4000-8000-000000000000' });
    expect([unknown.status, unknown.body.code]).toEqual([403, 'WORKSPACE_FORBIDDEN']);
  });

  it('a forged token naming another workspace is refused on every request', async () => {
    const admin = await login(ctx, username.get(ua.admin)!, PASSWORD);
    const forged = jwt.sign({ wid: wsB }, process.env.JWT_ACCESS_SECRET!, { algorithm: 'HS256', subject: ua.admin, issuer: 'nuzli-api', audience: 'nuzli-web', expiresIn: 600 });
    const res = await ctx.http().get('/api/v1/teams').set('Authorization', `Bearer ${forged}`);
    expect([res.status, res.body.code]).toEqual([403, 'WORKSPACE_FORBIDDEN']);
    expect((await ctx.http().get('/api/v1/teams').set(bearer(admin))).status).toBe(200);
  });

  it('a token without a workspace (pre-A12) binds to the user’s ONLY workspace — never a guess between several', async () => {
    const legacy = jwt.sign({ role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET!, { algorithm: 'HS256', subject: ua.admin, issuer: 'nuzli-api', audience: 'nuzli-web', expiresIn: 600 });
    const res = await ctx.http().get('/api/v1/teams').set('Authorization', `Bearer ${legacy}`).expect(200);
    expect(JSON.stringify(res.body)).toContain(A.tag);
    expect(JSON.stringify(res.body)).not.toContain(B.tag);
    const ownerId = (await superuser(() => ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE username = 'mmansary'`))).rows[0]!.id;
    const ownerLegacy = jwt.sign({ role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET!, { algorithm: 'HS256', subject: ownerId, issuer: 'nuzli-api', audience: 'nuzli-web', expiresIn: 600 });
    const denied = await ctx.http().get('/api/v1/teams').set('Authorization', `Bearer ${ownerLegacy}`);
    expect([denied.status, denied.body.code]).toEqual([403, 'WORKSPACE_REQUIRED']);
  });

  it('the owner (two workspaces) chooses after login; without a choice only session routes answer', async () => {
    const s = await login(ctx, 'mmansary', 'OwnerPass456');
    expect(s.body.activeWorkspace).toBeNull();
    expect(wid(s)).toBeNull();
    expect((s.body.workspaces as unknown[]).length).toBe(2);
    const teams = await ctx.http().get('/api/v1/teams').set(bearer(s));
    expect([teams.status, teams.body.code]).toEqual([403, 'WORKSPACE_REQUIRED']);
    await ctx.http().get('/api/v1/auth/me').set(bearer(s)).expect(200);
    await ctx.http().get('/api/v1/auth/workspaces').set(bearer(s)).expect(200);
  });

  it('switch-workspace re-issues the session for B: B data only, refresh keeps B, the old refresh cookie is dead, audited in B', async () => {
    const s = await login(ctx, 'mmansary', 'OwnerPass456');
    const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(s)).set('Cookie', s.cookie).send({ workspaceId: wsB }).expect(200);
    expect(wid(sw.body.accessToken)).toBe(wsB);
    expect(sw.body.activeWorkspace.id).toBe(wsB);
    const inB = await ctx.http().get('/api/v1/teams').set('Authorization', `Bearer ${sw.body.accessToken}`).expect(200);
    expect(JSON.stringify(inB.body)).toContain(B.tag);
    expect(JSON.stringify(inB.body)).not.toContain(A.tag);
    // refresh keeps the workspace
    const c = cookiesFrom(sw);
    const ref = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', c.cookie).set('X-CSRF-Token', c.csrf).expect(200);
    expect(wid(ref.body.accessToken)).toBe(wsB);
    // the pre-switch refresh token was revoked with its family
    const old = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
    expect(old.status).toBe(401);
    const audit = await superuser(() =>
      ctx.db.query<{ workspace_id: string }>(`SELECT workspace_id FROM audit_log WHERE action = 'auth.workspace_switched' AND entity_id = $1`, [wsB]),
    );
    expect(audit.rows.map((r) => r.workspace_id)).toEqual([wsB]);
  });

  it('a person in two workspaces holds a different role in each (ADMIN in A, MONITOR in B)', async () => {
    await superuser(() => ctx.db.query(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'MONITOR')`, [wsB, ua.admin]));
    const s = await login(ctx, username.get(ua.admin)!, PASSWORD);
    expect(s.body.activeWorkspace).toBeNull();
    const toB = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(s)).set('Cookie', s.cookie).send({ workspaceId: wsB }).expect(200);
    expect(toB.body.user.role).toBe('MONITOR');
    const teamsB = await ctx.http().get('/api/v1/teams').set('Authorization', `Bearer ${toB.body.accessToken}`);
    expect([teamsB.status, teamsB.body.code]).toEqual([403, 'FORBIDDEN']);
    const toA = await ctx.http().post('/api/v1/auth/switch-workspace').set('Authorization', `Bearer ${toB.body.accessToken}`).send({ workspaceId: wsA }).expect(200);
    expect(toA.body.user.role).toBe('ADMIN');
    const teamsA = await ctx.http().get('/api/v1/teams').set('Authorization', `Bearer ${toA.body.accessToken}`).expect(200);
    expect(JSON.stringify(teamsA.body)).not.toContain(B.tag);
    await superuser(() => ctx.db.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`, [wsB, ua.admin]));
  });

  it('losing the membership, or an archived workspace, ends access at the next request', async () => {
    const mon = await login(ctx, username.get(ub.monitor)!, PASSWORD);
    await ctx.http().get('/api/v1/violations/mine').set(bearer(mon)).expect(200);
    await superuser(() => ctx.db.query(`UPDATE workspace_memberships SET archived_at = now() WHERE user_id = $1`, [ub.monitor]));
    const gone = await ctx.http().get('/api/v1/violations/mine').set(bearer(mon));
    expect([gone.status, gone.body.code]).toEqual([403, 'WORKSPACE_FORBIDDEN']);

    const sup = await login(ctx, username.get(ub.supervisor)!, PASSWORD);
    await ctx.http().get('/api/v1/tasks/mine').set(bearer(sup)).expect(200);
    await superuser(() => ctx.db.query(`UPDATE workspaces SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`, [wsB]));
    const archived = await ctx.http().get('/api/v1/tasks/mine').set(bearer(sup));
    expect([archived.status, archived.body.code]).toEqual([403, 'WORKSPACE_ARCHIVED']);
    await superuser(() => ctx.db.query(`UPDATE workspaces SET status = 'ACTIVE', archived_at = NULL WHERE id = $1`, [wsB]));
  });

  it('registration with several workspaces: the applicant must choose; the request reaches only that workspace', async () => {
    const body = { accountType: 'SUPERVISOR', fullName: 'متقدم ثان', email: 'two@nuzli.test', mobile: '0551000002', nationalId: validNationalId('100000020'), password: 'Applicant-Pass-1' };
    const none = await ctx.http().post('/api/v1/auth/register').send(body);
    expect([none.status, none.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    await ctx.http().post('/api/v1/auth/register').send({ ...body, workspaceId: wsB }).expect(201);
    const adminA = await login(ctx, username.get(ua.admin)!, PASSWORD);
    const regsA = await ctx.http().get('/api/v1/registrations').set(bearer(adminA)).expect(200);
    expect(JSON.stringify(regsA.body)).not.toContain('two@nuzli.test');
    const adminB = await login(ctx, username.get(ub.admin)!, PASSWORD);
    const regsB = await ctx.http().get('/api/v1/registrations').set(bearer(adminB)).expect(200);
    expect(JSON.stringify(regsB.body)).toContain('two@nuzli.test');
    // the admins of B (and the owners) were notified, in B
    const n = await superuser(() =>
      ctx.db.query<{ workspace_id: string }>(`SELECT DISTINCT workspace_id FROM notifications WHERE type = 'REGISTRATION_REQUESTED' AND payload->>'fullName' = 'متقدم ثان'`),
    );
    expect(n.rows.map((r) => r.workspace_id)).toEqual([wsB]);
  });

  it('FAIL CLOSED: a business query without a workspace context throws; raw SQL sees nothing under RLS', async () => {
    const prisma = ctx.app.get(PrismaService);
    await workspaceStorage.run(newStore(), async () => {
      await expect((async () => prisma.team.findMany())()).rejects.toBeInstanceOf(WorkspaceScopeError);
      await expect((async () => prisma.auditLog.findMany())()).rejects.toBeInstanceOf(WorkspaceScopeError);
      const raw = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM teams`;
      expect(raw[0]!.n).toBe(0);
    });
    const inB = await runInWorkspace(wsB, () => prisma.team.findMany({ select: { name: true } }));
    expect(inB.map((t) => t.name)).toContain('WSB-SECRET فريق');
    expect(JSON.stringify(inB)).not.toContain(A.tag);
  });

  it('the owner escape hatch: owners only, a reason, an audit entry first — and (security review L2) never past RLS on the API role', async () => {
    const prisma = ctx.app.get(PrismaService);
    const ownerId = (await superuser(() => ctx.db.query<{ id: string }>(`SELECT id FROM users WHERE username = 'mmansary'`))).rows[0]!.id;
    await expect(prisma.crossWorkspace({ id: ua.admin, accountRole: 'USER' }, 'test', async () => 1)).rejects.toBeInstanceOf(WorkspaceScopeError);
    await expect(prisma.crossWorkspace({ id: ownerId, accountRole: 'OWNER' }, '  ', async () => 1)).rejects.toBeInstanceOf(WorkspaceScopeError);
    const names = await runInWorkspace(wsA, () =>
      prisma.crossWorkspace({ id: ownerId, accountRole: 'OWNER' }, 'تقرير المالك الشامل', () => prisma.team.findMany({ select: { name: true } })),
    );
    // The app-layer filter is off inside the hatch, but the API connects as nuzli_app, which can no
    // longer bypass RLS (ADR-165): B stays invisible. Spanning workspaces needs the operator's
    // maintenance connection (the migrator role), e.g. the key-rotation CLI.
    expect(names.map((t) => t.name)).toContain('WSA-SECRET فريق');
    expect(JSON.stringify(names)).not.toContain(B.tag);
    const audit = await superuser(() =>
      ctx.db.query<{ workspace_id: string | null; actor_id: string }>(`SELECT workspace_id, actor_id FROM audit_log WHERE action = 'owner.cross_workspace_access'`),
    );
    expect(audit.rows).toEqual([{ workspace_id: null, actor_id: ownerId }]);
    // …and the bypass does not outlive the call
    const after = await runInWorkspace(wsA, () => prisma.team.findMany({ select: { name: true } }));
    expect(JSON.stringify(after)).not.toContain(B.tag);
  });

  it('background jobs visit every active workspace, each in its own context', async () => {
    const prisma = ctx.app.get(PrismaService);
    const seen: Array<[string, number]> = [];
    await prisma.forEachWorkspace('test-job', async (ws) => {
      const teams = await prisma.team.findMany({ select: { workspaceId: true } });
      expect(teams.every((t) => t.workspaceId === ws.id)).toBe(true);
      seen.push([ws.id, teams.length]);
    });
    expect(seen.map((s) => s[0]).sort()).toEqual([wsA, wsB].sort());
  });
});
