/**
 * Security review A12 (docs/security-review-2026-10-A12.md) — regression tests for every finding,
 * ported from the reviewer's reproductions (R1…R7, owner-env) on the real stack: AppModule + PGlite
 * with RLS on (nuzli_app). Each test reproduces the reviewer's scenario and asserts the FIXED
 * behaviour.
 */
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { CryptoService } from '../../src/crypto/crypto.service';
import { TaskDueService } from '../../src/projects/task-due.service';
import { ViolationFilesService } from '../../src/violations/violation-files.service';
import { runInWorkspace } from '../../src/prisma/workspace-context';
import { runSeed } from '../../src/seed/seed';
import { OWNER_RECOVERED, recoverOwner } from '../../src/scripts/recover-owner';
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { bearer, cookiesFrom, login, OWNER, ownerSession, startPgApp, validNationalId, type PgApp, type Session } from '../support/pglite-app';
import { asAppRole, asSuperuser } from '../support/pglite';
import { insertUsers, insertWorkspace, insertWorkspaceRows, type WorkspaceFixture } from '../support/workspace-fixture';

jest.setTimeout(240_000);

const PASSWORD = 'Review-Pass-1';
let ctx: PgApp;
let wsA: string;
let wsB: string;
let A: WorkspaceFixture;
let B: WorkspaceFixture;
let owner: Session;
let adminA: Session;
let hash: string;
let seq = 900;

async function su<T>(fn: () => Promise<T>): Promise<T> {
  await asSuperuser(ctx.db);
  try {
    return await fn();
  } finally {
    await asAppRole(ctx.db);
  }
}
const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => su(async () => (await ctx.db.query<T>(text, params)).rows);

async function mkUser(tag: string, memberships: Array<{ ws: string; role: string }>): Promise<{ id: string; username: string }> {
  const id = randomUUID();
  const n = ++seq;
  const username = `${tag}${n}`.toLowerCase();
  await sql(
    `INSERT INTO users (id, full_name, email, mobile, national_id_enc, national_id_hash, national_id_last2, national_id_first, password_hash, status, username, updated_at)
     VALUES ($1, $2, $3, $4, decode($8, 'hex'), $5, '23', '1', $6, 'ACTIVE', $7, now())`,
    [id, `مستخدم ${tag}`, `${username}@nuzli.test`, `+96657${String(1000000 + n).slice(-7)}`, `hash-${username}`, hash, username, Buffer.from(ctx.app.get(CryptoService).encrypt(validNationalId(`1${String(10000000 + n).slice(-8)}`))).toString('hex')],
  );
  for (const m of memberships) await sql(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [m.ws, id, m.role]);
  return { id, username };
}

async function as(u: { username: string }, workspaceId?: string, password = PASSWORD): Promise<Session> {
  const s = await login(ctx, u.username, password);
  if (!workspaceId) return s;
  const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(s)).set('Cookie', s.cookie).send({ workspaceId });
  if (sw.status !== 200) throw new Error(`switch ${sw.status} ${JSON.stringify(sw.body)}`);
  return { accessToken: sw.body.accessToken, ...cookiesFrom(sw), body: sw.body };
}

const http = (s: Session) => ({
  get: (p: string) => ctx.http().get(`/api/v1${p}`).set(bearer(s)),
  post: (p: string, body: object = {}) => ctx.http().post(`/api/v1${p}`).set(bearer(s)).send(body),
  patch: (p: string, body: object = {}) => ctx.http().patch(`/api/v1${p}`).set(bearer(s)).send(body),
  del: (p: string) => ctx.http().delete(`/api/v1${p}`).set(bearer(s)),
});

const statusOf = async (id: string) => (await sql<{ status: string; suspended_globally: boolean }>(`SELECT status, suspended_globally FROM users WHERE id = $1`, [id]))[0]!;

beforeAll(async () => {
  unitWorkspaceFallback.enabled = false;
  ctx = await startPgApp({ rls: true });
  hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await su(async () => {
    wsA = (await ctx.db.query<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`)).rows[0]!.id;
    wsB = await insertWorkspace(ctx.db, 'beta', 'قسم ب');
    const crypto = ctx.app.get(CryptoService);
    const encrypt = (plain: string) => Buffer.from(crypto.encrypt(plain));
    const ua = await insertUsers(ctx.db, { workspaceId: wsA, tag: 'RVA', passwordHash: hash, encrypt });
    const ub = await insertUsers(ctx.db, { workspaceId: wsB, tag: 'RVB', passwordHash: hash, encrypt });
    A = await insertWorkspaceRows(ctx.db, { workspaceId: wsA, tag: 'RVA', users: ua, encrypt });
    B = await insertWorkspaceRows(ctx.db, { workspaceId: wsB, tag: 'RVB', users: ub, encrypt });
  });
  const o = await ownerSession(ctx);
  const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(o)).set('Cookie', o.cookie).send({ workspaceId: wsA });
  owner = { accessToken: sw.body.accessToken, ...cookiesFrom(sw), body: sw.body };
  const adminName = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [A.users.admin]))[0]!.username;
  adminA = await login(ctx, adminName, PASSWORD);
});

afterAll(async () => {
  await ctx?.close();
});

describe('H2 — only an owner lifts an owner’s GLOBAL suspension', () => {
  it('R1: owner suspends X everywhere → admin of A reactivate → 403 SUSPENDED_BY_OWNER; X stays out of B', async () => {
    const x = await mkUser('rvx', [{ ws: wsA, role: 'MONITOR' }, { ws: wsB, role: 'ADMIN' }]);
    await mkUser('rvbadmin', [{ ws: wsB, role: 'ADMIN' }]); // B keeps an admin (last-admin guard)
    expect((await http(owner).post(`/users/${x.id}/suspend`, { scope: 'global', reason: 'تحقيق أمني' })).status).toBe(200);
    expect(await statusOf(x.id)).toEqual({ status: 'SUSPENDED', suspended_globally: true });
    const r = await http(adminA).post(`/users/${x.id}/reactivate`, {});
    expect([r.status, r.body.code]).toEqual([403, 'SUSPENDED_BY_OWNER']);
    expect(await statusOf(x.id)).toEqual({ status: 'SUSPENDED', suspended_globally: true });
    // the membership in A was not touched either, and X cannot sign in / enter B
    const m = await sql<{ status: string }>(`SELECT status FROM workspace_memberships WHERE user_id = $1 AND workspace_id = $2`, [x.id, wsA]);
    expect(m[0]!.status).toBe('ACTIVE');
    expect((await ctx.http().post('/api/v1/auth/login').send({ identifier: x.username, password: PASSWORD })).status).toBeGreaterThanOrEqual(400);
    // the owner lifts it (everywhere)
    expect((await http(owner).post(`/users/${x.id}/reactivate`, { scope: 'global' })).status).toBe(200);
    expect(await statusOf(x.id)).toEqual({ status: 'ACTIVE', suspended_globally: false });
    await as(x, wsB);
  });

  it('a suspension that only CASCADED from the workspace (its last membership) is still lifted by that workspace’s admin', async () => {
    const y = await mkUser('rvcasc', [{ ws: wsA, role: 'MONITOR' }]);
    expect((await http(adminA).post(`/users/${y.id}/suspend`, { reason: 'إيقاف مؤقت' })).status).toBe(200);
    expect(await statusOf(y.id)).toEqual({ status: 'SUSPENDED', suspended_globally: false });
    expect((await http(adminA).post(`/users/${y.id}/reactivate`, {})).status).toBe(200);
    expect(await statusOf(y.id)).toEqual({ status: 'ACTIVE', suspended_globally: false });
  });

  it('an owner turning a cascaded suspension into a global one locks the admin out of lifting it', async () => {
    const z = await mkUser('rvglob', [{ ws: wsA, role: 'MONITOR' }]);
    expect((await http(adminA).post(`/users/${z.id}/suspend`, {})).status).toBe(200);
    expect((await http(owner).post(`/users/${z.id}/suspend`, { scope: 'global' })).status).toBe(200);
    expect(await statusOf(z.id)).toEqual({ status: 'SUSPENDED', suspended_globally: true });
    expect((await http(adminA).post(`/users/${z.id}/reactivate`, {})).body.code).toBe('SUSPENDED_BY_OWNER');
  });
});

describe('M2 — the global profile photo follows the account rule', () => {
  it('R2: admin of A cannot replace or remove the photo of a person who is ADMIN of B (nor an owner’s); an A-only person’s still works', async () => {
    const x = await mkUser('rvp', [{ ws: wsA, role: 'SUPERVISOR' }, { ws: wsB, role: 'ADMIN' }]);
    const fileId = randomUUID();
    await sql(
      `INSERT INTO files (id, storage_key, bucket, mime_type, size_bytes, status, uploaded_by, entity_type, entity_id, kind, workspace_id, updated_at)
       VALUES ($1, $2, 'nuzli-test', 'image/png', 10, 'READY', $3, 'user_photo', $3, 'PHOTO', NULL, now())`,
      [fileId, `user-photos/${fileId}.png`, x.id],
    );
    await sql(`UPDATE users SET photo_file_id = $1 WHERE id = $2`, [fileId, x.id]);
    expect((await http(adminA).patch(`/users/${x.id}`, { fullName: 'اسم جديد' })).body.code).toBe('USER_IN_OTHER_WORKSPACES');
    const presign = await http(adminA).post('/files/presign', { entityType: 'user_photo', entityId: x.id, contentType: 'image/png', sizeBytes: 1000 });
    expect([presign.status, presign.body.code]).toEqual([403, 'USER_IN_OTHER_WORKSPACES']);
    const del = await http(adminA).del(`/users/${x.id}/photo`);
    expect([del.status, del.body.code]).toEqual([403, 'USER_IN_OTHER_WORKSPACES']);
    expect((await sql<{ photo_file_id: string | null }>(`SELECT photo_file_id FROM users WHERE id = $1`, [x.id]))[0]!.photo_file_id).toBe(fileId);
    // the owner may; the person may
    expect((await http(owner).post('/files/presign', { entityType: 'user_photo', entityId: x.id, contentType: 'image/png', sizeBytes: 1000 })).status).toBe(201);
    // an A-only person: the admin of A still manages the photo
    const solo = await mkUser('rvsolo', [{ ws: wsA, role: 'MONITOR' }]);
    expect((await http(adminA).post('/files/presign', { entityType: 'user_photo', entityId: solo.id, contentType: 'image/png', sizeBytes: 1000 })).status).toBe(201);
  });
});

describe('M1 — owner account changes are ACCOUNT-LEVEL audit entries', () => {
  it('R3: owner (bound to A) edits / creates a B-only account → nothing of it in A’s (or B’s) audit; owners read it with scope=account', async () => {
    const y = await mkUser('rvy', [{ ws: wsB, role: 'MONITOR' }]);
    const changed = `changed.${y.username}@nuzli.test`;
    expect((await http(owner).patch(`/users/${y.id}`, { email: changed, mobile: '0551239876' })).status).toBe(200);
    const created = await http(owner).post('/users', {
      fullName: 'موظف قسم ب الجديد',
      email: `newb.${Date.now()}@nuzli.test`,
      mobile: '0559871234',
      nationalId: validNationalId('109876543'),
      password: 'Strong-Pass-123',
      mustChangePassword: false,
      memberships: [{ workspaceId: wsB, role: 'MONITOR' }],
    });
    expect(created.status).toBe(201);
    expect((await http(owner).post(`/users/${y.id}/password`, { password: 'Another-Pass-77', mustChangePassword: true })).status).toBe(200);
    const auditA = JSON.stringify((await http(adminA).get('/audit?entityType=user&pageSize=100')).body);
    expect(auditA).not.toContain(changed);
    expect(auditA).not.toContain('موظف قسم ب الجديد');
    const rows = await sql<{ workspace_id: string | null; action: string }>(`SELECT workspace_id, action FROM audit_log WHERE entity_id = ANY($1) ORDER BY at`, [[y.id, created.body.id]]);
    const accountLevel = rows.filter((r) => ['user.updated', 'user.created', 'user.password_set'].includes(r.action));
    expect(accountLevel.length).toBe(3);
    expect(accountLevel.every((r) => r.workspace_id === null)).toBe(true);
    // the new account's B membership is audited IN B (membership changes stay with the workspace)
    expect(rows.find((r) => r.action === 'membership.added')?.workspace_id).toBe(wsB);
    // owners read the account-level log; admins may not
    const acct = await http(owner).get('/audit?scope=account&entityType=user&pageSize=100');
    expect(acct.status).toBe(200);
    expect(JSON.stringify(acct.body)).toContain(changed);
    expect(JSON.stringify(acct.body)).not.toContain(A.tag);
    expect((await http(adminA).get('/audit?scope=account')).status).toBe(403);
  });

  it('workspace lifecycle (create, rename, archive) is account-level too', async () => {
    const c = await http(owner).post('/workspaces', { name: 'قسم مؤقت للتدقيق', code: 'audit-tmp' });
    expect(c.status).toBe(201);
    expect((await http(owner).patch(`/workspaces/${c.body.id}`, { name: 'قسم مؤقت ٢' })).status).toBe(200);
    const rows = await sql<{ workspace_id: string | null; action: string }>(`SELECT workspace_id, action FROM audit_log WHERE entity_id = $1`, [c.body.id]);
    expect(rows.map((r) => r.action).sort()).toEqual(['workspace.created', 'workspace.renamed']);
    expect(rows.every((r) => r.workspace_id === null)).toBe(true);
  });
});

describe('M3 — notifications only reach live members of the workspace', () => {
  it('R4: a supervisor removed from A gets no reminder of A’s task; a current member does', async () => {
    const x = await mkUser('rvr', [{ ws: wsA, role: 'SUPERVISOR' }, { ws: wsB, role: 'SUPERVISOR' }]);
    const stay = await mkUser('rvstay', [{ ws: wsA, role: 'SUPERVISOR' }]);
    for (const [user, name] of [[x.id, 'RVA مهمة سرية'], [stay.id, 'RVA مهمة باقية']] as const) {
      await sql(
        `INSERT INTO tasks (id, workspace_id, project_id, name, start_date, end_date, duration_days, assignee_id, updated_at)
         VALUES ($1, $2, $3, $4, '2026-01-01', '2026-01-02', 2, $5, now())`,
        [randomUUID(), wsA, A.ids.project, name, user],
      );
    }
    const m = (await sql<{ id: string }>(`SELECT id FROM workspace_memberships WHERE user_id = $1 AND workspace_id = $2`, [x.id, wsA]))[0]!;
    expect((await http(adminA).del(`/workspaces/${wsA}/members/${m.id}`)).status).toBe(204);
    await runInWorkspace(wsA, () => ctx.app.get(TaskDueService).run(new Date('2026-10-20T08:00:00Z')));
    const gone = await sql(`SELECT type FROM notifications WHERE user_id = $1`, [x.id]);
    expect(gone).toEqual([]);
    const kept = await sql<{ type: string }>(`SELECT type FROM notifications WHERE user_id = $1 AND workspace_id = $2`, [stay.id, wsA]);
    expect(kept.map((k) => k.type)).toContain('TASK_OVERDUE');
  });
});

describe('M4 — retention also runs on ARCHIVED workspaces', () => {
  it('R6: an old ID-card photo of an archived workspace is purged like an active one’s', async () => {
    const wsC = await su(() => insertWorkspace(ctx.db, 'gamma', 'قسم ج'));
    const crypto = ctx.app.get(CryptoService);
    const encrypt = (plain: string) => Buffer.from(crypto.encrypt(plain));
    const C = await su(async () => {
      const uc = await insertUsers(ctx.db, { workspaceId: wsC, tag: 'RVC', passwordHash: hash, encrypt });
      return insertWorkspaceRows(ctx.db, { workspaceId: wsC, tag: 'RVC', users: uc, encrypt });
    });
    for (const v of [C.ids.violation, A.ids.violation]) await sql(`UPDATE violations SET captured_at = now() - interval '4000 days' WHERE id = $1`, [v]);
    for (const w of [wsA, wsC]) {
      await sql(`INSERT INTO settings (workspace_id, key, value, updated_at) VALUES ($1, 'VIOLATION_PHOTO_RETENTION_DAYS', '30', now()) ON CONFLICT (workspace_id, key) DO UPDATE SET value = '30'`, [w]);
    }
    expect((await ctx.http().post(`/api/v1/workspaces/${wsC}/archive`).set(bearer(owner)).send({})).status).toBe(200);
    await ctx.app.get(ViolationFilesService).purgeExpiredPhotosAllWorkspaces();
    const left = await sql<{ id: string; deleted_at: Date | null }>(`SELECT id, deleted_at FROM files WHERE id IN ($1, $2)`, [C.ids.idCardFile, A.ids.idCardFile]);
    expect(left.find((f) => f.id === A.ids.idCardFile)?.deleted_at).not.toBeNull();
    expect(left.find((f) => f.id === C.ids.idCardFile)?.deleted_at).not.toBeNull();
  });
});

describe('L1 — account lookup and registration reveal nothing', () => {
  it('R5: admin of A probing B’s admin learns only that another role exists; a suspended account looks like an unknown one', async () => {
    const bAdmin = (await sql<{ username: string; email: string }>(`SELECT username, email FROM users WHERE id = $1`, [B.users.admin]))[0]!;
    const unknown = await http(adminA).post(`/workspaces/${wsA}/members`, { identifier: 'nobody.at.all', role: 'MEMBER' });
    expect([unknown.status, unknown.body.code]).toEqual([404, 'NOT_FOUND']);
    const probe = await http(adminA).post(`/workspaces/${wsA}/members`, { identifier: bAdmin.username, role: 'MEMBER' });
    expect([probe.status, probe.body.code]).toEqual([409, 'DUAL_ROLE_CONFIRM_REQUIRED']);
    expect(probe.body.details).toEqual({ roles: [], otherWorkspaces: true });
    expect(JSON.stringify(probe.body)).not.toMatch(/ADMIN|قسم ب|RVB/);
    // a suspended account: the same 404 as an unknown one (no status)
    const sus = await mkUser('rvsus', [{ ws: wsB, role: 'MONITOR' }]);
    await sql(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [sus.id]);
    const s = await http(adminA).post(`/workspaces/${wsA}/members`, { identifier: sus.username, role: 'MEMBER' });
    expect([s.status, s.body.code, s.body.details]).toEqual([404, 'NOT_FOUND', unknown.body.details]);
    // the e-mail only after a successful, confirmed add (the admin now administers that person)
    const add = await http(adminA).post(`/workspaces/${wsA}/members`, { identifier: bAdmin.username, role: 'MEMBER', confirmDualRole: true });
    expect(add.status).toBe(201);
    expect(add.body.user.email).toBe(bAdmin.email);
  });

  it('registration never says that a username is taken (same answer; the applicant gets a free variant)', async () => {
    const taken = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [B.users.admin]))[0]!.username;
    const body = (u: string, n: string) => ({
      workspaceId: wsA,
      accountType: 'MONITOR',
      fullName: 'متقدّم للمراجعة',
      email: `applicant.${n}@nuzli.test`,
      mobile: `055871${n}`,
      nationalId: validNationalId(`10988${n}`),
      password: 'Applicant-Pass-1',
      username: u,
    });
    const a = await ctx.http().post('/api/v1/auth/register').send(body(taken, '1234'));
    const b = await ctx.http().post('/api/v1/auth/register').send(body('fresh.applicant', '4321'));
    expect([a.status, a.body]).toEqual([b.status, b.body]);
    expect(a.body).toEqual({ status: 'PENDING' });
    const row = await sql<{ username: string }>(`SELECT username FROM users WHERE email = 'applicant.1234@nuzli.test'`);
    expect(row[0]!.username).not.toBe(taken);
    expect(row[0]!.username.startsWith(taken.slice(0, 20))).toBe(true);
  });
});

describe('H1 — BOOTSTRAP_OWNER_* is a first-boot bootstrap only; owners are recovered by the operator CLI', () => {
  const role = async (username: string) => (await sql<{ account_role: string; id: string }>(`SELECT id, account_role FROM users WHERE username = $1`, [username]))[0];

  it('a removed owner listed in BOOTSTRAP_OWNER_USERNAME stays removed after the next start', async () => {
    const add = await http(owner).post('/owners', { username: 'owner2', fullName: 'مالك ثان', email: 'owner2@nuzli.test', mobile: '0551112223', nationalId: validNationalId('100000777'), password: 'Owner2-Pass-1', mustChangePassword: false });
    expect(add.status).toBe(201);
    const o2 = await login(ctx, 'owner2', 'Owner2-Pass-1');
    const self = (await role(OWNER.username))!;
    expect((await ctx.http().delete(`/api/v1/owners/${self.id}`).set(bearer(o2))).status).toBe(204);
    const lines: string[] = [];
    await runSeed(ctx.prisma, process.env as never, (l) => lines.push(l)); // = the next container start
    expect((await role(OWNER.username))!.account_role).toBe('USER');
    expect(lines.join('\n')).toMatch(/do not match an owner/);
    // the operator restores the owner from the server (audited, account-level)
    const logs: string[] = [];
    const r = await recoverOwner(ctx.prisma, { username: OWNER.username }, (l) => logs.push(l));
    expect(r).toMatchObject({ promoted: true, reactivated: false });
    expect((await role(OWNER.username))!.account_role).toBe('OWNER');
    const audit = await sql<{ workspace_id: string | null }>(`SELECT workspace_id FROM audit_log WHERE action = $1 AND entity_id = $2`, [OWNER_RECOVERED, self.id]);
    expect(audit).toEqual([{ workspace_id: null }]);
  });

  it('a workspace ADMIN taking a freed owner username is NOT promoted at the next start', async () => {
    const me = (await role(OWNER.username))!;
    await sql(`UPDATE users SET username = 'mansary.renamed' WHERE id = $1`, [me.id]);
    const adm = await http(owner).post('/users', { username: 'wsadmin', fullName: 'مدير قسم', email: 'wsadmin@nuzli.test', mobile: '0553334445', nationalId: validNationalId('100000888'), role: 'ADMIN', password: 'Admin-Pass-123', mustChangePassword: false });
    expect(adm.status).toBe(201);
    const a = await login(ctx, 'wsadmin', 'Admin-Pass-123');
    const sock = await http(a).post('/users', { username: OWNER.username, fullName: 'حساب جانبي', email: 'sock@nuzli.test', mobile: '0556667778', nationalId: validNationalId('100000999'), role: 'MONITOR', password: 'Sock-Pass-1234', mustChangePassword: false });
    expect(sock.status).toBe(201);
    await runSeed(ctx.prisma, process.env as never, () => undefined);
    expect((await role(OWNER.username))?.account_role).toBe('USER');
    await sql(`UPDATE users SET username = $2 WHERE id = $1`, [me.id, 'mmansary.owner']);
  });

  it('owner:recover --reset-password: a one-time password (must change), every session ends; a PENDING account is refused', async () => {
    const x = await mkUser('rvrecover', [{ ws: wsA, role: 'MONITOR' }]);
    const before = await as(x);
    const r = await recoverOwner(ctx.prisma, { username: x.username, resetPassword: true });
    expect(r.temporaryPassword).toMatch(/^Nz/);
    expect((await role(x.username))!.account_role).toBe('OWNER');
    const refresh = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', before.cookie).set('X-CSRF-Token', before.csrf);
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    const s = await login(ctx, x.username, r.temporaryPassword!);
    expect((s.body.user as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
    const dry = await recoverOwner(ctx.prisma, { username: x.username, dryRun: true });
    expect(dry.promoted).toBe(false);
    await sql(`UPDATE users SET status = 'PENDING' WHERE id = $1`, [B.users.monitor]);
    const pendingName = (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [B.users.monitor]))[0]!.username;
    await expect(recoverOwner(ctx.prisma, { username: pendingName })).rejects.toThrow(/PENDING/);
    await sql(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [B.users.monitor]);
  });
});

describe('R7 — controls (expected to hold before and after)', () => {
  it('removed membership → the still-valid access token is refused at once; switch to a non-member workspace → 403', async () => {
    const x = await mkUser('rvc', [{ ws: wsA, role: 'MONITOR' }]);
    const s = await as(x);
    expect((await http(s).get('/violations')).status).toBe(200);
    await sql(`UPDATE workspace_memberships SET archived_at = now() WHERE user_id = $1`, [x.id]);
    expect((await http(s).get('/violations')).status).toBe(403);
    const y = await mkUser('rvs', [{ ws: wsA, role: 'MONITOR' }]);
    const sy = await login(ctx, y.username, PASSWORD);
    expect((await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(sy)).set('Cookie', sy.cookie).send({ workspaceId: wsB })).status).toBe(403);
  });
});
