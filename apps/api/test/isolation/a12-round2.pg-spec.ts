/**
 * A12 round 2 — owners, workspaces, user management, assistants, project participants,
 * supervisors' team scope, workers' add/remove requests, dual roles, registration by workspace,
 * project covers and card printing — on the real stack (AppModule + PGlite, RLS on as nuzli_app).
 *
 * The route-by-route isolation suite (isolation-suite.ts) skips the OWNER for the owner-admin
 * routes, because owners act on every workspace by design; this file proves what an owner may do
 * there, and that a non-owner may not.
 */
import argon2 from 'argon2';
import { ASSISTANT_MODULES, VIEW_ONLY_MODULES } from '@nuzli/shared';
import { randomUUID } from 'node:crypto';
import { CryptoService } from '../../src/crypto/crypto.service';
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { bearer, cookiesFrom, login, ownerSession, startPgApp, validNationalId, type PgApp, type Session } from '../support/pglite-app';
import { asAppRole, asSuperuser } from '../support/pglite';
import { insertUsers, insertWorkspace, insertWorkspaceRows, type WorkspaceFixture } from '../support/workspace-fixture';

jest.setTimeout(240_000);

const PASSWORD = 'Round2-Pass-1';
let ctx: PgApp;
let wsA: string;
let wsB: string;
let A: WorkspaceFixture;
let B: WorkspaceFixture;
let owner: Session;
let admin: Session;
let hash: string;
let seq = 700;

async function su<T>(fn: () => Promise<T>): Promise<T> {
  await asSuperuser(ctx.db);
  try {
    return await fn();
  } finally {
    await asAppRole(ctx.db);
  }
}

const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => su(async () => (await ctx.db.query<T>(text, params)).rows);

/** An ACTIVE account with memberships, inserted directly; returns its id and username. */
async function mkUser(
  tag: string,
  memberships: Array<{ ws: string; role: string; permissions?: Record<string, string>; scope?: Record<string, string[]> }>,
): Promise<{ id: string; username: string }> {
  const id = randomUUID();
  const n = ++seq;
  const username = `${tag}${n}`.toLowerCase();
  await sql(
    `INSERT INTO users (id, full_name, email, mobile, national_id_enc, national_id_hash, national_id_last2, national_id_first, password_hash, status, username, updated_at)
     VALUES ($1, $2, $3, $4, decode($8, 'hex'), $5, '23', '1', $6, 'ACTIVE', $7, now())`,
    [id, `مستخدم ${tag}`, `${username}@nuzli.test`, `+96657${String(1000000 + n).slice(-7)}`, `hash-${username}`, hash, username, Buffer.from(ctx.app.get(CryptoService).encrypt(validNationalId(`1${String(10000000 + n).slice(-8)}`))).toString('hex')],
  );
  for (const m of memberships) {
    await sql(`INSERT INTO workspace_memberships (workspace_id, user_id, role, permissions, scope) VALUES ($1, $2, $3, $4, $5)`, [
      m.ws,
      id,
      m.role,
      JSON.stringify(m.permissions ?? {}),
      JSON.stringify(m.scope ?? {}),
    ]);
  }
  return { id, username };
}

/** Notifications are sent after the response: wait for them (bounded). */
async function eventually(check: () => Promise<void>, tries = 40): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await check();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function as(u: { username: string }, workspaceId?: string): Promise<Session> {
  const s = await login(ctx, u.username, PASSWORD);
  if (!workspaceId) return s;
  const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(s)).set('Cookie', s.cookie).send({ workspaceId });
  if (sw.status !== 200) throw new Error(`switch ${sw.status} ${JSON.stringify(sw.body)}`);
  return { accessToken: sw.body.accessToken, ...cookiesFrom(sw), body: sw.body };
}

const http = (s: Session) => ({
  get: (p: string) => ctx.http().get(`/api/v1${p}`).set(bearer(s)),
  post: (p: string, body: object = {}) => ctx.http().post(`/api/v1${p}`).set(bearer(s)).send(body),
  patch: (p: string, body: object = {}) => ctx.http().patch(`/api/v1${p}`).set(bearer(s)).send(body),
  put: (p: string, body: object = {}) => ctx.http().put(`/api/v1${p}`).set(bearer(s)).send(body),
  del: (p: string) => ctx.http().delete(`/api/v1${p}`).set(bearer(s)),
});

beforeAll(async () => {
  unitWorkspaceFallback.enabled = false;
  ctx = await startPgApp({ rls: true });
  hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await su(async () => {
    wsA = (await ctx.db.query<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`)).rows[0]!.id;
    wsB = await insertWorkspace(ctx.db, 'beta', 'قسم ب');
    const crypto = ctx.app.get(CryptoService);
    const encrypt = (plain: string) => Buffer.from(crypto.encrypt(plain));
    const ua = await insertUsers(ctx.db, { workspaceId: wsA, tag: 'R2A', passwordHash: hash, encrypt });
    const ub = await insertUsers(ctx.db, { workspaceId: wsB, tag: 'R2B', passwordHash: hash, encrypt });
    A = await insertWorkspaceRows(ctx.db, { workspaceId: wsA, tag: 'R2A', users: ua, encrypt });
    B = await insertWorkspaceRows(ctx.db, { workspaceId: wsB, tag: 'R2B', users: ub, encrypt });
  });
  const o = await ownerSession(ctx);
  const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(o)).set('Cookie', o.cookie).send({ workspaceId: wsA });
  owner = { accessToken: sw.body.accessToken, ...cookiesFrom(sw), body: sw.body };
  const adminName = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [A.users.admin]))[0]!.username;
  admin = await login(ctx, adminName, PASSWORD);
});

afterAll(async () => {
  await ctx?.close();
});

// ───────────────────────────────────────────────────────────── owners

describe('owners', () => {
  it('only owners list and add owners; a new owner account must change its password', async () => {
    expect((await http(admin).get('/owners')).status).toBe(403);
    expect((await http(admin).post('/owners', { userId: A.users.supervisor })).status).toBe(403);
    const list = await http(owner).get('/owners').expect(200);
    expect(list.body.map((x: { username: string }) => x.username)).toEqual(['mmansary']);
    const created = await http(owner)
      .post('/owners', { username: 'second.owner', fullName: 'مالك ثانٍ', email: 'owner2@nuzli.test', mobile: '0551999001', nationalId: validNationalId('100000777'), password: 'Owner2-Pass-99' })
      .expect(201);
    expect(created.body.username).toBe('second.owner');
    const u = await sql<{ account_role: string; must_change_password: boolean }>(`SELECT account_role, must_change_password FROM users WHERE username = 'second.owner'`);
    expect(u[0]).toEqual({ account_role: 'OWNER', must_change_password: true });
    // account-level audit (workspace NULL), never the password
    const audit = await sql<{ workspace_id: string | null; after: unknown }>(`SELECT workspace_id, after FROM audit_log WHERE action = 'owner.added'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.workspace_id).toBeNull();
    expect(JSON.stringify(audit[0]!.after)).not.toContain('Owner2-Pass-99');
  });

  it('never zero owners: the last active owner cannot be removed (LAST_OWNER)', async () => {
    const second = (await sql<{ id: string }>(`SELECT id FROM users WHERE username = 'second.owner'`))[0]!.id;
    const ownerId = (await sql<{ id: string }>(`SELECT id FROM users WHERE username = 'mmansary'`))[0]!.id;
    await http(owner).del(`/owners/${second}`).expect(204);
    const r = await http(owner).del(`/owners/${ownerId}`);
    expect([r.status, r.body.code]).toEqual([409, 'LAST_OWNER']);
  });
});

// ───────────────────────────────────────────────────────────── workspaces

describe('workspaces (owners)', () => {
  let wsC: string;

  it('creates an EMPTY workspace with its neutral defaults only', async () => {
    expect((await http(admin).post('/workspaces', { name: 'قسم ج' })).status).toBe(403);
    const r = await http(owner).post('/workspaces', { name: 'قسم ج', code: 'gamma' }).expect(201);
    wsC = r.body.id;
    expect(r.body).toMatchObject({ name: 'قسم ج', code: 'gamma', status: 'ACTIVE', adminCount: 0, memberCount: 0 });
    const counts = await sql<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM team_colors WHERE workspace_id = $1) AS colors,
              (SELECT count(*)::int FROM card_sizes WHERE workspace_id = $1) AS sizes,
              (SELECT count(*)::int FROM card_templates WHERE workspace_id = $1) AS templates,
              (SELECT count(*)::int FROM calendars WHERE workspace_id = $1 AND is_default) AS calendars,
              (SELECT count(*)::int FROM settings WHERE workspace_id = $1) AS settings,
              (SELECT count(*)::int FROM projects WHERE workspace_id = $1) AS projects,
              (SELECT count(*)::int FROM teams WHERE workspace_id = $1) AS teams,
              (SELECT count(*)::int FROM team_members WHERE workspace_id = $1) AS members`,
      [wsC],
    );
    expect(counts[0]).toMatchObject({ colors: 24, sizes: 6, templates: 3, calendars: 1, projects: 0, teams: 0, members: 0 });
    expect(counts[0]!.settings).toBeGreaterThan(0);
    const cal = await sql<{ weekend_days: number[] }>(`SELECT weekend_days FROM calendars WHERE workspace_id = $1`, [wsC]);
    expect([...cal[0]!.weekend_days].sort()).toEqual([5, 6]);
    // Security review A12 M1: workspace lifecycle is an account-level entry (workspace NULL, owners only).
    expect(await sql(`SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.created'`, [wsC])).toHaveLength(0);
    expect(await sql(`SELECT 1 FROM audit_log WHERE workspace_id IS NULL AND action = 'workspace.created' AND entity_id = $1`, [wsC])).toHaveLength(1);
  });

  it('rename, summary (counts only), archive (soft; sessions end; never the last active), restore', async () => {
    await http(owner).patch(`/workspaces/${wsC}`, { name: 'قسم جيم' }).expect(200);
    const sum = await http(owner).get(`/workspaces/${wsB}/summary`).expect(200);
    expect(sum.body).toMatchObject({ workspace: { id: wsB, code: 'beta' }, projects: 1, teams: 1, members: 1, violations: 1, pendingMemberRequests: 2 });
    expect(sum.body.users.pendingRegistrations).toBe(1);
    expect(JSON.stringify(sum.body)).not.toContain('R2B');
    expect((await http(admin).get(`/workspaces/${wsB}/summary`)).status).toBe(403);

    const before = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1`, [wsC]);
    await http(owner).post(`/workspaces/${wsC}/archive`).expect(200);
    expect((await sql<{ status: string }>(`SELECT status::text AS status FROM workspaces WHERE id = $1`, [wsC]))[0]!.status).toBe('ARCHIVED');
    expect(await sql<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1`, [wsC])).toEqual(before);
    await http(owner).post(`/workspaces/${wsC}/restore`).expect(200);
    const list = await http(owner).get('/workspaces?status=ALL').expect(200);
    expect(list.body.map((w: { code: string }) => w.code).sort()).toEqual(['beta', 'gamma', 'projects']);
  });

  it('assigns and removes a workspace admin; a second role needs confirmDualRole (409 DUAL_ROLE_CONFIRM_REQUIRED)', async () => {
    const first = await http(owner).post(`/workspaces/${wsC}/admins`, { userId: A.users.supervisor });
    expect([first.status, first.body.code]).toEqual([409, 'DUAL_ROLE_CONFIRM_REQUIRED']);
    expect(first.body.details.roles).toEqual([expect.objectContaining({ role: 'SUPERVISOR', workspaceId: wsA })]);
    const ok = await http(owner).post(`/workspaces/${wsC}/admins`, { userId: A.users.supervisor, confirmDualRole: true }).expect(201);
    expect(ok.body).toMatchObject({ role: 'ADMIN', workspaceId: wsC, dualRole: true });
    const admins = await http(owner).get(`/workspaces/${wsC}/admins`).expect(200);
    expect(admins.body.map((m: { user: { id: string } }) => m.user.id)).toEqual([A.users.supervisor]);
    // the dual-role badge everywhere; the admin of A does not learn the other workspace's name
    const seenByAdmin = await http(admin).get(`/users/${A.users.supervisor}`).expect(200);
    expect(seenByAdmin.body.dualRole).toBe(true);
    expect(seenByAdmin.body.allRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'SUPERVISOR', workspaceId: wsA }),
        expect.objectContaining({ role: 'ADMIN', workspaceId: null, workspaceName: null }),
      ]),
    );
    await http(owner).del(`/workspaces/${wsC}/admins/${A.users.supervisor}`).expect(204);
    const after = await http(admin).get(`/users/${A.users.supervisor}`).expect(200);
    expect(after.body.dualRole).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────── memberships and accounts

describe('user management', () => {
  it('an admin adds an EXISTING account (registered elsewhere) to their workspace — no EMAIL_TAKEN gap; never to another workspace', async () => {
    const outsider = await mkUser('outsider', [{ ws: wsB, role: 'MONITOR' }]);
    const forbidden = await http(admin).post(`/workspaces/${wsB}/members`, { userId: outsider.id, role: 'MONITOR', confirmDualRole: true });
    expect([forbidden.status, forbidden.body.code]).toEqual([403, 'WORKSPACE_FORBIDDEN']);
    const needs = await http(admin).post(`/workspaces/${wsA}/members`, { identifier: `${outsider.username}@nuzli.test`, role: 'SUPERVISOR', title: 'مشرف موقع' });
    expect([needs.status, needs.body.code]).toEqual([409, 'DUAL_ROLE_CONFIRM_REQUIRED']);
    // the admin of A sees THAT another role exists — not where, which role or its status (security review L1)
    expect(needs.body.details).toEqual({ roles: [], otherWorkspaces: true });
    const added = await http(admin).post(`/workspaces/${wsA}/members`, { identifier: outsider.username, role: 'SUPERVISOR', title: 'مشرف موقع', confirmDualRole: true }).expect(201);
    expect(added.body).toMatchObject({ role: 'SUPERVISOR', title: 'مشرف موقع', dualRole: true });
    const again = await http(admin).post(`/workspaces/${wsA}/members`, { userId: outsider.id, role: 'SUPERVISOR', confirmDualRole: true });
    expect([again.status, again.body.code]).toEqual([409, 'MEMBERSHIP_EXISTS']);
    const members = await http(admin).get(`/workspaces/${wsA}/members`).expect(200);
    expect(members.body.some((m: { user: { id: string } }) => m.user.id === outsider.id)).toBe(true);
    // an admin cannot edit the data of someone who also belongs to another workspace
    const edit = await http(admin).patch(`/users/${outsider.id}`, { fullName: 'اسم آخر' });
    expect([edit.status, edit.body.code]).toEqual([403, 'USER_IN_OTHER_WORKSPACES']);
    // the owner can
    await http(owner).patch(`/users/${outsider.id}`, { fullName: 'اسم يغيّره المالك' }).expect(200);
    // removing the role (archived), then the user is no longer in A
    await http(admin).del(`/workspaces/${wsA}/members/${added.body.id}`).expect(204);
    expect((await http(admin).get(`/users/${outsider.id}`)).status).toBe(404);
  });

  it('POST /users: username, first password with must-change, memberships; dual roles need confirmation', async () => {
    const base = { fullName: 'مستخدم جديد', email: 'new.user@nuzli.test', mobile: '0551999002', nationalId: validNationalId('100000778'), username: 'new.user', password: 'NewUser-Pass-1' };
    const dual = await http(admin).post('/users', { ...base, memberships: [{ role: 'SUPERVISOR' }, { role: 'MONITOR' }] });
    expect([dual.status, dual.body.code]).toEqual([409, 'DUAL_ROLE_CONFIRM_REQUIRED']);
    const elsewhere = await http(admin).post('/users', { ...base, memberships: [{ workspaceId: wsB, role: 'MONITOR' }] });
    expect([elsewhere.status, elsewhere.body.code]).toEqual([403, 'WORKSPACE_FORBIDDEN']);
    const r = await http(admin).post('/users', { ...base, memberships: [{ role: 'ASSISTANT', title: 'مساعد', permissions: { projects: 'view' } }] }).expect(201);
    expect(r.body).toMatchObject({ username: 'new.user', mustChangePassword: true, allRoles: [expect.objectContaining({ role: 'ASSISTANT', title: 'مساعد' })] });
    const first = await login(ctx, 'new.user', 'NewUser-Pass-1');
    expect((await http(first).get('/projects')).body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    // the owner may create in any workspace
    const o = await http(owner)
      .post('/users', { fullName: 'مستخدم ب', email: 'b.user@nuzli.test', mobile: '0551999003', nationalId: validNationalId('100000779'), memberships: [{ workspaceId: wsB, role: 'MONITOR' }] })
      .expect(201);
    const m = await sql(`SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`, [wsB, o.body.id]);
    expect(m).toHaveLength(1);
  });

  it('usernames change at any time (unique, case-insensitive); passwords are set, never read; sessions end; audited without the value', async () => {
    const target = await mkUser('editme', [{ ws: wsA, role: 'MONITOR' }]);
    const s = await login(ctx, target.username, PASSWORD);
    const taken = await http(admin).post(`/users/${target.id}/username`, { username: 'NEW.USER' });
    expect([taken.status, taken.body.code]).toEqual([409, 'USERNAME_TAKEN']);
    const bad = await http(admin).post(`/users/${target.id}/username`, { username: '1bad' });
    expect(bad.status).toBe(400);
    await http(admin).post(`/users/${target.id}/username`, { username: 'Renamed.User' }).expect(200);
    await http(admin).patch(`/users/${target.id}`, { email: 'renamed@nuzli.test', mobile: '0551999004', nationalId: validNationalId('100000780') }).expect(200);
    const pw = await http(admin).post(`/users/${target.id}/password`, { password: 'Brand-New-Pass-7', mustChangePassword: true }).expect(200);
    expect(pw.body.mustChangePassword).toBe(true);
    const refresh = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
    expect(refresh.status).toBe(401);
    const relog = await login(ctx, 'renamed.user', 'Brand-New-Pass-7');
    expect((relog.body.user as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    const audit = await sql<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM audit_log WHERE entity_id = $1 AND action IN ('user.username_changed', 'user.updated', 'user.password_set') ORDER BY at`,
      [target.id],
    );
    expect(audit.map((a) => a.action)).toEqual(['user.username_changed', 'user.updated', 'user.password_set']);
    const text = JSON.stringify(audit);
    expect(text).not.toContain('Brand-New-Pass-7');
    expect(text).not.toContain(validNationalId('100000780'));
    expect(text).toContain('•');
    // nobody but owners touches an owner
    const ownerId = (await sql<{ id: string }>(`SELECT id FROM users WHERE username = 'mmansary'`))[0]!.id;
    expect((await http(admin).post(`/users/${ownerId}/password`, { password: 'Hijack-Pass-11', mustChangePassword: false })).status).toBe(403);
  });

  it('owners see every account (GET /users/all) and suspend one globally; never the last owner', async () => {
    expect((await http(admin).get('/users/all')).status).toBe(403);
    const all = await http(owner).get('/users/all?pageSize=200').expect(200);
    const ids = all.body.items.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([A.users.admin, B.users.admin]));
    const target = await mkUser('globalsusp', [{ ws: wsA, role: 'MONITOR' }, { ws: wsB, role: 'MONITOR' }]);
    await http(owner).post(`/users/${target.id}/suspend`, { scope: 'global', reason: 'اختبار' }).expect(200);
    expect((await sql<{ status: string }>(`SELECT status::text AS status FROM users WHERE id = $1`, [target.id]))[0]!.status).toBe('SUSPENDED');
    expect((await http(admin).post(`/users/${target.id}/suspend`, { scope: 'global' })).status).toBe(403);
    await http(owner).post(`/users/${target.id}/reactivate`, { scope: 'global' }).expect(200);
  });
});

// ───────────────────────────────────────────────────────────── assistants

describe('assistants (مساعد): module levels and scope', () => {
  const all = () => Object.fromEntries(ASSISTANT_MODULES.map((m) => [m, VIEW_ONLY_MODULES.has(m) ? 'view' : 'edit']));

  it('none / view / edit per module, enforced by the guard', async () => {
    const viewer = await as(await mkUser('asview', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'view', teams: 'view' } }]));
    expect((await http(viewer).get('/projects')).status).toBe(200);
    expect((await http(viewer).post('/projects', { name: 'x', startDate: '2026-10-01' })).status).toBe(403);
    expect((await http(viewer).get('/teams')).status).toBe(200);
    expect((await http(viewer).get('/violations')).status).toBe(403);
    expect((await http(viewer).get('/users')).status).toBe(403);
    expect((await http(viewer).post('/cards/batches', {})).status).toBe(403);
    const nothing = await as(await mkUser('asnone', [{ ws: wsA, role: 'ASSISTANT', permissions: {} }]));
    expect((await http(nothing).get('/projects')).status).toBe(403);
    expect((await http(nothing).get('/notifications')).status).toBe(200);
    const editor = await as(await mkUser('asedit', [{ ws: wsA, role: 'ASSISTANT', permissions: all() }]));
    // the web reads the same grants from its own session (can(user, …) answers like the API)
    const me = await http(editor).get('/auth/me').expect(200);
    expect(me.body.grants).toEqual(expect.arrayContaining(['projects.manage', 'cards.print', 'users.read']));
    expect(me.body.grants).not.toContain('users.edit');
    expect((await http(editor).get('/violations')).status).toBe(200);
    expect((await http(editor).get('/users')).status).toBe(200);
    // users stay view-only for an assistant, and full national IDs stay with admins
    expect((await http(editor).patch(`/users/${A.users.monitor}`, { fullName: 'لا' })).status).toBe(403);
    const member = await http(editor).get(`/members/${A.ids.member}`).expect(200);
    expect(member.body.nationalId).toBeUndefined();
  });

  it('the budget is visible with budget:view only (participants and other assistants get no money field)', async () => {
    const noBudget = await as(await mkUser('asnobud', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'view' } }]));
    const p1 = await http(noBudget).get(`/projects/${A.ids.project}`).expect(200);
    expect('budget' in p1.body || 'plannedCost' in p1.body).toBe(false);
    expect((await http(noBudget).get(`/projects/${A.ids.project}/budget`)).status).toBe(403);
    const withBudget = await as(await mkUser('asbud', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'view', budget: 'view' } }]));
    const p2 = await http(withBudget).get(`/projects/${A.ids.project}`).expect(200);
    expect('plannedCost' in p2.body).toBe(true);
    await http(withBudget).get(`/projects/${A.ids.project}/budget`).expect(200);
    // editing tasks without budget:edit cannot change money
    const tasksOnly = await as(await mkUser('astasks', [{ ws: wsA, role: 'ASSISTANT', permissions: { tasks: 'edit' } }]));
    const r = await http(tasksOnly).patch(`/tasks/${A.ids.task2}`, { version: 0, plannedCost: 99 });
    expect([r.status, r.body.details?.field]).toEqual([403, 'budget']);
  });

  it('a scope limits lists and ids to the chosen projects / teams', async () => {
    const other = await sql<{ id: string }>(
      `INSERT INTO projects (name, start_date, status, calendar_id, owner_id, workspace_id, updated_at) VALUES ('R2A مشروع آخر', '2026-10-01', 'ACTIVE', $1, $2, $3, now()) RETURNING id`,
      [A.ids.calendar, A.users.admin, wsA],
    );
    const scoped = await as(
      await mkUser('asscope', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'edit', tasks: 'view', teams: 'view', violations: 'view' }, scope: { projectIds: [other[0]!.id], teamIds: [] } }]),
    );
    const list = await http(scoped).get('/projects').expect(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([other[0]!.id]);
    expect((await http(scoped).get(`/projects/${A.ids.project}`)).status).toBe(404);
    expect((await http(scoped).get(`/tasks/${A.ids.task}`)).status).toBe(404);
    expect((await http(scoped).get('/teams')).body).toEqual([]);
    expect((await http(scoped).get(`/teams/${A.ids.team}`)).status).toBe(404);
    expect((await http(scoped).get('/violations')).body.items).toEqual([]);
    // the admin's own scope check of the membership: ids of another workspace are refused
    const bad = await http(admin).post(`/workspaces/${wsA}/members`, {
      userId: (await mkUser('asbad', [])).id,
      role: 'ASSISTANT',
      permissions: { projects: 'view' },
      scope: { projectIds: [B.ids.project] },
    });
    expect(bad.status).toBe(400);
  });

  it('an assistant with registrations:edit decides registrations and is notified of new ones', async () => {
    const approver = await mkUser('asreg', [{ ws: wsA, role: 'ASSISTANT', permissions: { registrations: 'edit', users: 'view' } }]);
    await ctx.http().post('/api/v1/auth/register').send({
      accountType: 'MONITOR', workspaceId: wsA, fullName: 'متقدم للقسم أ', email: 'apply.a@nuzli.test', mobile: '0551999005', nationalId: validNationalId('100000781'), password: 'Applicant-Pass-1',
    }).expect(201);
    await eventually(async () => expect(await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'REGISTRATION_REQUESTED'`, [approver.id])).toHaveLength(1));
    const s = await as(approver);
    const regs = await http(s).get('/registrations').expect(200);
    const app = regs.body.items.find((u: { email: string }) => u.email === 'apply.a@nuzli.test');
    await http(s).post(`/registrations/${app.id}/approve`, {}).expect(200);
    const m = await sql(`SELECT role::text FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`, [wsA, app.id]);
    expect(m).toEqual([{ role: 'MONITOR' }]);
    // registration needs the workspace when several exist
    const missing = await ctx.http().post('/api/v1/auth/register').send({
      accountType: 'MONITOR', fullName: 'متقدم', email: 'apply.x@nuzli.test', mobile: '0551999006', nationalId: validNationalId('100000782'), password: 'Applicant-Pass-1',
    });
    expect(missing.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────── participants

describe('project participants (محرّر / مساهم / مطّلع)', () => {
  let viewer: { id: string; username: string };
  let contributor: { id: string; username: string };
  let editor: { id: string; username: string };

  beforeAll(async () => {
    viewer = await mkUser('pview', [{ ws: wsA, role: 'MEMBER' }]);
    contributor = await mkUser('pcontrib', [{ ws: wsA, role: 'MEMBER' }]);
    editor = await mkUser('pedit', [{ ws: wsA, role: 'MEMBER' }]);
    await http(admin).post(`/projects/${A.ids.project}/participants`, { userId: viewer.id, title: 'مطّلع الإدارة', level: 'VIEWER' }).expect(201);
    await http(admin).post(`/projects/${A.ids.project}/participants`, { userId: contributor.id, title: 'منسّق', level: 'CONTRIBUTOR' }).expect(201);
    await http(admin).post(`/projects/${A.ids.project}/participants`, { userId: editor.id, title: 'مهندس', level: 'EDITOR' }).expect(201);
  });

  it('admins manage participants; only members of the workspace; audited and notified', async () => {
    const r = await http(admin).post(`/projects/${A.ids.project}/participants`, { userId: B.users.monitor, title: 'غريب', level: 'VIEWER' });
    expect([r.status, r.body.code]).toEqual([409, 'PARTICIPANT_NOT_MEMBER']);
    const dup = await http(admin).post(`/projects/${A.ids.project}/participants`, { userId: viewer.id, title: 'مكرّر', level: 'VIEWER' });
    expect([dup.status, dup.body.code]).toEqual([409, 'PARTICIPANT_EXISTS']);
    const list = await http(admin).get(`/projects/${A.ids.project}/participants`).expect(200);
    expect(list.body.map((p: { level: string }) => p.level).sort()).toEqual(['CONTRIBUTOR', 'CONTRIBUTOR', 'EDITOR', 'VIEWER']);
    await eventually(async () => expect(await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'PROJECT_PARTICIPANT_ADDED'`, [editor.id])).toHaveLength(1));
    expect(await sql(`SELECT 1 FROM audit_log WHERE action = 'project.participant_added' AND entity_id = $1`, [A.ids.project])).toHaveLength(3);
  });

  it('a participant sees only their projects (list, gantt, hub, attachments, reports) — no money, no other project', async () => {
    const other = (await sql<{ id: string }>(`SELECT id FROM projects WHERE workspace_id = $1 AND id <> $2 AND NOT is_template LIMIT 1`, [wsA, A.ids.project]))[0]!.id;
    const s = await as(viewer);
    const list = await http(s).get('/projects').expect(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([A.ids.project]);
    expect('budget' in list.body[0]).toBe(false);
    const gantt = await http(s).get(`/projects/${A.ids.project}/gantt`).expect(200);
    expect(gantt.body.tasks.length).toBeGreaterThan(0);
    expect(JSON.stringify(gantt.body)).not.toContain('plannedCost');
    expect((await http(s).get(`/projects/${other}`)).status).toBe(404);
    expect((await http(s).get(`/projects/${A.ids.project}/budget`)).status).toBe(403);
    await http(s).get('/attachments').expect(200);
    const rep = await http(s).get('/reports/projects').expect(200);
    expect(rep.body.map((r: { project: { id: string } }) => r.project.id)).toEqual([A.ids.project]);
  });

  it('VIEWER: read only, no comment, no status', async () => {
    const s = await as(viewer);
    await http(s).get(`/tasks/${A.ids.task}`).expect(200);
    await http(s).get(`/tasks/${A.ids.task}/comments`).expect(200);
    expect((await http(s).post(`/tasks/${A.ids.task}/comments`, { body: 'تعليق' })).status).toBe(403);
    expect((await http(s).patch(`/tasks/${A.ids.task}`, { version: 0, status: 'IN_PROGRESS' })).status).toBe(403);
    expect((await http(s).get('/hub')).status).toBe(403);
  });

  it('CONTRIBUTOR: status/progress, comments, checklist, time log — not the task itself', async () => {
    const s = await as(contributor);
    const t = await http(s).get(`/tasks/${A.ids.task2}`).expect(200);
    await http(s).patch(`/tasks/${A.ids.task2}`, { version: t.body.version, progress: 50 }).expect(200);
    const named = await http(s).patch(`/tasks/${A.ids.task2}`, { version: t.body.version + 1, name: 'اسم' });
    expect(named.status).toBe(403);
    await http(s).post(`/tasks/${A.ids.task2}/comments`, { body: 'ملاحظة المساهم' }).expect(201);
    await http(s).patch(`/tasks/${A.ids.task}/checklist/${A.ids.checklistItem}`, { done: true }).expect(200);
    await http(s).post(`/tasks/${A.ids.task}/time-entries`, { date: '2026-10-15', minutes: 30 }).expect(201);
    const mine = await http(s).get('/me/participations').expect(200);
    expect(mine.body).toEqual([expect.objectContaining({ projectId: A.ids.project, level: 'CONTRIBUTOR', title: 'منسّق' })]);
    expect((await http(s).post(`/projects/${A.ids.project}/tasks`, { name: 'جديدة', startDate: '2026-10-05', durationDays: 1 })).status).toBe(403);
    await http(s).get('/hub').expect(200);
  });

  it('EDITOR: edits the project\'s tasks — not its settings, budget or participants', async () => {
    const s = await as(editor);
    const created = await http(s).post(`/projects/${A.ids.project}/tasks`, { name: 'مهمة المحرّر', startDate: '2026-10-05', durationDays: 1 }).expect(201);
    await http(s).patch(`/tasks/${created.body.id}`, { version: created.body.version, name: 'اسم جديد' }).expect(200);
    const money = await http(s).patch(`/tasks/${created.body.id}`, { version: created.body.version + 1, actualCost: 10 });
    expect([money.status, money.body.details?.field]).toEqual([403, 'budget']);
    expect((await http(s).patch(`/projects/${A.ids.project}`, { name: 'لا' })).status).toBe(403);
    expect((await http(s).post(`/projects/${A.ids.project}/participants`, { userId: viewer.id, title: 'x', level: 'EDITOR' })).status).toBe(403);
    // the editor right is bound to THIS project: no task write anywhere else
    const other = (await sql<{ id: string }>(`SELECT id FROM projects WHERE workspace_id = $1 AND id <> $2 AND NOT is_template LIMIT 1`, [wsA, A.ids.project]))[0]!.id;
    expect((await http(s).post(`/projects/${other}/tasks`, { name: 'خارج', startDate: '2026-10-05', durationDays: 1 })).status).toBe(403);
  });

  it('removing the participant ends the access', async () => {
    await http(admin).patch(`/projects/${A.ids.project}/participants/${viewer.id}`, { level: 'CONTRIBUTOR' }).expect(200);
    await http(admin).del(`/projects/${A.ids.project}/participants/${viewer.id}`).expect(204);
    const s = await as(viewer);
    expect((await http(s).get('/projects')).status).toBe(403);
    expect((await http(s).get(`/tasks/${A.ids.task}`)).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────── supervisors' team scope

describe('supervisors share their team\'s tasks (owner rule)', () => {
  it('«مهامي» lists own and co-supervisors\' tasks with assignedToMe; replies and status on them; checklist stays the assignee\'s', async () => {
    const co = await mkUser('cosup', [{ ws: wsA, role: 'SUPERVISOR' }]);
    const stranger = await mkUser('othersup', [{ ws: wsA, role: 'SUPERVISOR' }]);
    await sql(`INSERT INTO team_supervisors (team_id, user_id, is_primary, workspace_id) VALUES ($1, $2, false, $3)`, [A.ids.team, co.id, wsA]);
    const s = await as(co);
    const mine = await http(s).get('/tasks/mine').expect(200);
    const t = mine.body.find((x: { id: string }) => x.id === A.ids.task);
    expect(t).toMatchObject({ assignedToMe: false });
    await http(s).post(`/tasks/${A.ids.task}/comments`, { body: 'رد زميل الفريق' }).expect(201);
    const cur = await http(s).get(`/tasks/${A.ids.task}`).expect(200);
    await http(s).patch(`/tasks/${A.ids.task}`, { version: cur.body.version, status: 'IN_PROGRESS' }).expect(200);
    expect((await http(s).patch(`/tasks/${A.ids.task}/checklist/${A.ids.checklistItem}`, { done: false })).status).toBe(403);
    expect((await http(s).get('/hub')).body.items.some((h: { task: { id: string } }) => h.task.id === A.ids.task)).toBe(true);
    const o = await as(stranger);
    expect((await http(o).get(`/tasks/${A.ids.task}`)).status).toBe(404);
    expect((await http(o).get('/tasks/mine')).body).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────── workers' requests

describe('workers: a supervisor\'s add / remove is a request approved by an admin', () => {
  let sup: Session;
  beforeAll(async () => {
    const name = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [A.users.supervisor]))[0]!.username;
    sup = await login(ctx, name, PASSWORD);
  });

  it('ADD: 202 + a pending request (national ID encrypted, masked in the payload); approvers notified; approval creates the worker', async () => {
    const nid = validNationalId('100000790');
    const r = await http(sup).post(`/teams/${A.ids.team}/members`, { fullName: 'عامل مطلوب جديد', nationalId: nid }).expect(202);
    expect(r.body).toMatchObject({ status: 'PENDING_APPROVAL', request: { kind: 'ADD', status: 'PENDING', payload: { fullName: 'عامل مطلوب جديد' } } });
    const row = await sql<{ payload: unknown; national_id_enc: Buffer | null }>(`SELECT payload, national_id_enc FROM member_requests WHERE id = $1`, [r.body.request.id]);
    expect(JSON.stringify(row[0]!.payload)).not.toContain(nid);
    expect(row[0]!.national_id_enc).not.toBeNull();
    expect(await sql(`SELECT 1 FROM team_members WHERE full_name = 'عامل مطلوب جديد'`)).toHaveLength(0);
    await eventually(async () => expect(await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'MEMBER_REQUEST_CREATED'`, [A.users.admin])).not.toHaveLength(0));
    // the supervisor sees their request; cannot decide it
    const mine = await http(sup).get('/member-requests').expect(200);
    expect(mine.body.items.some((x: { id: string }) => x.id === r.body.request.id)).toBe(true);
    expect((await http(sup).post(`/member-requests/${r.body.request.id}/approve`)).status).toBe(403);
    const ok = await http(admin).post(`/member-requests/${r.body.request.id}/approve`).expect(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', member: { fullName: 'عامل مطلوب جديد' } });
    expect((await sql<{ national_id_enc: Buffer | null }>(`SELECT national_id_enc FROM member_requests WHERE id = $1`, [r.body.request.id]))[0]!.national_id_enc).toBeNull();
    expect(await sql(`SELECT 1 FROM team_memberships tm JOIN team_members m ON m.id = tm.member_id WHERE m.full_name = 'عامل مطلوب جديد' AND tm.team_id = $1 AND tm.valid_to IS NULL`, [A.ids.team])).toHaveLength(1);
    await eventually(async () => expect(await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'MEMBER_REQUEST_DECIDED'`, [A.users.supervisor])).toHaveLength(1));
    const twice = await http(admin).post(`/member-requests/${r.body.request.id}/approve`);
    expect([twice.status, twice.body.code]).toEqual([409, 'MEMBER_REQUEST_NOT_PENDING']);
  });

  it('REMOVE: 202, approval archives the worker (nothing deleted); a rejection keeps them; admins remove directly', async () => {
    const worker = (await sql<{ id: string }>(`SELECT id FROM team_members WHERE full_name = 'عامل مطلوب جديد'`))[0]!.id;
    const r = await http(sup).post(`/members/${worker}/archive`, { reason: 'انتهى عقده' }).expect(202);
    const again = await http(sup).post(`/members/${worker}/archive`, { reason: 'انتهى عقده' }).expect(202);
    expect(again.body.request.id).toBe(r.body.request.id);
    await http(admin).post(`/member-requests/${r.body.request.id}/reject`, { reason: 'ما زال مطلوبًا' }).expect(200);
    expect((await sql<{ archived_at: Date | null }>(`SELECT archived_at FROM team_members WHERE id = $1`, [worker]))[0]!.archived_at).toBeNull();
    const r2 = await http(sup).post(`/members/${worker}/archive`, { reason: 'انتهى عقده' }).expect(202);
    await http(admin).post(`/member-requests/${r2.body.request.id}/approve`).expect(200);
    const m = await sql<{ archived_at: Date | null; status: string }>(`SELECT archived_at, status::text AS status FROM team_members WHERE id = $1`, [worker]);
    expect(m[0]!.archived_at).not.toBeNull();
    expect(m[0]!.status).toBe('INACTIVE');
    // admin: direct, 200
    const direct = await http(admin).post(`/teams/${A.ids.team}/members`, { fullName: 'عامل يضيفه المدير', nationalId: validNationalId('100000791') }).expect(201);
    await http(admin).post(`/members/${direct.body.id}/archive`, { reason: 'خطأ إدخال' }).expect(200);
    // data edits by the supervisor stay direct
    await http(sup).patch(`/members/${A.ids.member}`, { fullName: 'R2A عامل معدّل' }).expect(200);
  });

  it('a supervisor\'s NEW team active at once: its inline workers become requests (none created directly)', async () => {
    await http(admin).patch('/settings', { REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: false }).expect(200);
    try {
      const s = await as(await mkUser('newteamsup', [{ ws: wsA, role: 'SUPERVISOR' }]));
      const colors = await http(s).get('/colors/available').expect(200);
      const free = (colors.body as Array<{ id: string; available?: boolean }>).find((c) => c.available !== false)!;
      const team = await http(s)
        .post('/teams', { name: 'فريق مشرف جديد', colorId: free.id, members: [{ fullName: 'عامل ينتظر الاعتماد', nationalId: validNationalId('100000792') }] })
        .expect(201);
      expect(team.body).toMatchObject({ status: 'ACTIVE', memberCount: 0 });
      expect(await sql(`SELECT 1 FROM team_members WHERE full_name = 'عامل ينتظر الاعتماد'`)).toHaveLength(0);
      const req = await sql<{ kind: string; status: string }>(`SELECT kind::text, status::text FROM member_requests WHERE team_id = $1`, [team.body.id]);
      expect(req).toEqual([{ kind: 'ADD', status: 'PENDING' }]);
    } finally {
      await http(admin).patch('/settings', { REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS: true }).expect(200);
    }
  });
});

// ───────────────────────────────────────────────────────────── covers and cards

describe('project cover and card printing', () => {
  const png = () => {
    const b = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]).copy(b);
    return b;
  };

  it('admins upload a cover (image, ≤ 3 MB); every viewer of the project gets a short URL; remove brings back the generated one', async () => {
    const big = await http(admin).post('/files/presign', { entityType: 'project_cover', entityId: A.ids.project, contentType: 'image/png', sizeBytes: 4 * 1024 * 1024 });
    expect(big.body.code).toBe('FILE_TOO_LARGE');
    const pdf = await http(admin).post('/files/presign', { entityType: 'project_cover', entityId: A.ids.project, contentType: 'application/pdf', sizeBytes: 100 });
    expect(pdf.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const supName = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [A.users.supervisor]))[0]!.username;
    const sup = await login(ctx, supName, PASSWORD);
    expect((await http(sup).post('/files/presign', { entityType: 'project_cover', entityId: A.ids.project, contentType: 'image/png', sizeBytes: 64 })).status).toBe(403);
    const p = await http(admin).post('/files/presign', { entityType: 'project_cover', entityId: A.ids.project, contentType: 'image/png', sizeBytes: 64 }).expect(201);
    const key = (await sql<{ storage_key: string }>(`SELECT storage_key FROM files WHERE id = $1`, [p.body.fileId]))[0]!.storage_key;
    ctx.storage.put(key, png());
    await http(admin).post(`/files/${p.body.fileId}/confirm`).expect(200);
    const project = await http(admin).get(`/projects/${A.ids.project}`).expect(200);
    expect(project.body).toMatchObject({ hasCover: true, color: expect.stringMatching(/^#[0-9A-F]{6}$/) });
    await http(admin).get(`/projects/${A.ids.project}/cover-url`).expect(200);
    await http(admin).del(`/projects/${A.ids.project}/cover`).expect(204);
    expect((await http(admin).get(`/projects/${A.ids.project}/cover-url`)).status).toBe(404);
  });

  it('card printing: owners, admins and assistants with cards:edit — never supervisors', async () => {
    const supName = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [A.users.supervisor]))[0]!.username;
    const sup = await login(ctx, supName, PASSWORD);
    const body = { idempotencyKey: randomUUID(), templateId: A.ids.cardTemplate, items: [{ memberId: A.ids.member, data: { fullName: 'x' } }] };
    expect((await http(sup).post('/cards/batches', body)).status).toBe(403);
    const viewOnly = await as(await mkUser('ascardv', [{ ws: wsA, role: 'ASSISTANT', permissions: { cards: 'view' } }]));
    expect((await http(viewOnly).post('/cards/batches', body)).status).toBe(403);
    await http(viewOnly).get('/cards/batches').expect(200);
    const printer = await as(await mkUser('ascardp', [{ ws: wsA, role: 'ASSISTANT', permissions: { cards: 'edit' } }]));
    expect((await http(printer).post('/cards/batches', body)).status).toBeLessThan(300);
  });
});
