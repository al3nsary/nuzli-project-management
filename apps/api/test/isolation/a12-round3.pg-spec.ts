/**
 * A12 round 3 — the truthful display role, the participant picker for assistants
 * (`GET /projects/:id/participant-candidates`) and the «صلاحية مزدوجة» flag on embedded person refs,
 * on the real stack (AppModule + PGlite, RLS on as nuzli_app), with workspace B alongside.
 */
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { CryptoService } from '../../src/crypto/crypto.service';
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { bearer, cookiesFrom, login, ownerSession, startPgApp, validNationalId, type PgApp, type Session } from '../support/pglite-app';
import { asAppRole, asSuperuser } from '../support/pglite';
import { insertUsers, insertWorkspace, insertWorkspaceRows, type WorkspaceFixture } from '../support/workspace-fixture';

jest.setTimeout(240_000);

const PASSWORD = 'Round3-Pass-1';
let ctx: PgApp;
let wsA: string;
let wsB: string;
let A: WorkspaceFixture;
let B: WorkspaceFixture;
let owner: Session;
let admin: Session;
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

async function mkUser(
  tag: string,
  memberships: Array<{ ws: string; role: string; permissions?: Record<string, string>; scope?: Record<string, string[]> }>,
): Promise<{ id: string; username: string; fullName: string }> {
  const id = randomUUID();
  const n = ++seq;
  const username = `${tag}${n}`.toLowerCase();
  const fullName = `مستخدم ${tag} ${n}`;
  await sql(
    `INSERT INTO users (id, full_name, email, mobile, national_id_enc, national_id_hash, national_id_last2, national_id_first, password_hash, status, username, updated_at)
     VALUES ($1, $2, $3, $4, decode($8, 'hex'), $5, '23', '1', $6, 'ACTIVE', $7, now())`,
    [
      id,
      fullName,
      `${username}@nuzli.test`,
      `+96658${String(1000000 + n).slice(-7)}`,
      `hash-${username}`,
      hash,
      username,
      Buffer.from(ctx.app.get(CryptoService).encrypt(validNationalId(`1${String(20000000 + n).slice(-8)}`))).toString('hex'),
    ],
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
  return { id, username, fullName };
}

const usernameOf = async (id: string) => (await sql<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [id]))[0]!;
const as = (u: { username: string }): Promise<Session> => login(ctx, u.username, PASSWORD);
/** The session's user (login/switch answers). */
const me = (s: Session) => (s.body as { user: { role: string | null; workspaceRoles: string[]; dualRole?: boolean } }).user;

const http = (s: Session) => ({
  get: (p: string) => ctx.http().get(`/api/v1${p}`).set(bearer(s)),
  post: (p: string, body: object = {}) => ctx.http().post(`/api/v1${p}`).set(bearer(s)).send(body),
});

beforeAll(async () => {
  unitWorkspaceFallback.enabled = false;
  ctx = await startPgApp({ rls: true });
  hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await su(async () => {
    wsA = (await ctx.db.query<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`)).rows[0]!.id;
    wsB = await insertWorkspace(ctx.db, 'gamma', 'قسم ج');
    const crypto = ctx.app.get(CryptoService);
    const encrypt = (plain: string) => Buffer.from(crypto.encrypt(plain));
    const ua = await insertUsers(ctx.db, { workspaceId: wsA, tag: 'R3A', passwordHash: hash, encrypt });
    const ub = await insertUsers(ctx.db, { workspaceId: wsB, tag: 'R3B', passwordHash: hash, encrypt });
    A = await insertWorkspaceRows(ctx.db, { workspaceId: wsA, tag: 'R3A', users: ua, encrypt });
    B = await insertWorkspaceRows(ctx.db, { workspaceId: wsB, tag: 'R3B', users: ub, encrypt });
  });
  const o = await ownerSession(ctx);
  const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(o)).set('Cookie', o.cookie).send({ workspaceId: wsA });
  owner = { accessToken: sw.body.accessToken, ...cookiesFrom(sw), body: sw.body };
  admin = await as(await usernameOf(A.users.admin));
});

afterAll(async () => {
  await ctx?.close();
});

// ───────────────────────────────────────────────────────────── 1. display role

describe('the display role is truthful (no MONITOR fallback)', () => {
  it('an assistant is ASSISTANT, a member MEMBER, an owner OWNER — on their own session and in lists', async () => {
    const assistant = await mkUser('dra', [{ ws: wsA, role: 'ASSISTANT', permissions: { users: 'view' } }]);
    const member = await mkUser('drm', [{ ws: wsA, role: 'MEMBER' }]);
    const sa = await as(assistant);
    expect(me(sa).role).toBe('ASSISTANT');
    expect(me(sa).workspaceRoles).toEqual(['ASSISTANT']);
    expect((await http(sa).get('/auth/me').expect(200)).body.role).toBe('ASSISTANT');
    const sm = await as(member);
    expect(me(sm).role).toBe('MEMBER');
    expect((await http(sm).get('/auth/me').expect(200)).body.role).toBe('MEMBER');
    expect(me(owner).role).toBe('OWNER');
    expect((await http(owner).get('/auth/me').expect(200)).body.role).toBe('OWNER');

    const list = await http(admin).get('/users?pageSize=100').expect(200);
    const byId = new Map((list.body.items as Array<{ id: string; role: string | null }>).map((u) => [u.id, u.role]));
    expect(byId.get(assistant.id)).toBe('ASSISTANT');
    expect(byId.get(member.id)).toBe('MEMBER');
    expect(byId.get(A.users.supervisor)).toBe('SUPERVISOR');
    expect(byId.get(A.users.monitor)).toBe('MONITOR');
    expect([...byId.values()]).not.toContain(null);
  });

  it('rights still come from the roles: an assistant with only users:view gets no monitor right', async () => {
    const assistant = await mkUser('drx', [{ ws: wsA, role: 'ASSISTANT', permissions: { users: 'view' } }]);
    const s = await as(assistant);
    expect((await http(s).get('/users')).status).toBe(200);
    expect((await http(s).get('/projects')).status).toBe(403);
    expect((await http(s).post('/violations', {})).status).toBe(403);
  });

  it('a dual role (supervisor + assistant) shows the matrix role and lists both', async () => {
    const dual = await mkUser('drd', [
      { ws: wsA, role: 'SUPERVISOR' },
      { ws: wsA, role: 'ASSISTANT', permissions: { users: 'view' } },
    ]);
    const s = await as(dual);
    expect(me(s).role).toBe('SUPERVISOR');
    expect([...me(s).workspaceRoles].sort()).toEqual(['ASSISTANT', 'SUPERVISOR']);
    expect(me(s).dualRole).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────── 2. participant candidates

describe('GET /projects/:id/participant-candidates — the picker for whoever manages participants', () => {
  const path = () => `/projects/${A.ids.project}/participant-candidates`;
  const KEYS = ['fullName', 'hasPhoto', 'id', 'role', 'username'];

  it('admins: live members of THIS workspace only, not yet participants, minimal fields', async () => {
    const res = await http(admin).get(path()).expect(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([A.users.admin, A.users.supervisor]));
    // the monitor of A is already a participant (fixture) → not offered again
    expect(ids).not.toContain(A.users.monitor);
    // nothing of workspace B, nor A's pending registration
    for (const id of Object.values(B.users)) expect(ids).not.toContain(id);
    expect(ids).not.toContain(A.users.pending);
    for (const c of res.body as Array<Record<string, unknown>>) {
      expect(Object.keys(c).filter((k) => k !== 'dualRole').sort()).toEqual(KEYS);
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/@nuzli\.test|\+9665|nationalId|email|mobile/);
    expect(text).not.toContain(wsB);
    expect(res.body.find((c: { id: string }) => c.id === A.users.supervisor).role).toBe('SUPERVISOR');
  });

  it('q searches the name and the username — and never reaches workspace B', async () => {
    const bName = (await sql<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [B.users.supervisor]))[0]!.full_name;
    expect((await http(admin).get(`${path()}?q=${encodeURIComponent(bName)}`).expect(200)).body).toEqual([]);
    const a = (await sql<{ full_name: string; username: string }>(`SELECT full_name, username FROM users WHERE id = $1`, [A.users.supervisor]))[0]!;
    const byName = await http(admin).get(`${path()}?q=${encodeURIComponent(a.full_name)}`).expect(200);
    expect(byName.body.map((c: { id: string }) => c.id)).toEqual([A.users.supervisor]);
    const byUser = await http(admin).get(`${path()}?q=${encodeURIComponent(a.username.toUpperCase())}`).expect(200);
    expect(byUser.body.map((c: { id: string }) => c.id)).toContain(A.users.supervisor);
    expect((await http(admin).get(`${path()}?q=${'x'.repeat(81)}`)).status).toBe(400);
  });

  it('assistants with projects:edit use it WITHOUT the users module; view-only or out of scope may not', async () => {
    const editor = await mkUser('pca', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'edit' } }]);
    const viewer = await mkUser('pcv', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'view' } }]);
    const scoped = await mkUser('pcs', [{ ws: wsA, role: 'ASSISTANT', permissions: { projects: 'edit' }, scope: { projectIds: [] } }]);
    const se = await as(editor);
    // the users module is not granted: the workspace member list stays closed…
    expect((await http(se).get(`/workspaces/${wsA}/members`)).status).toBe(403);
    // …but the picker answers, and adding works end to end
    const res = await http(se).get(path()).expect(200);
    expect(res.body.map((c: { id: string }) => c.id)).toContain(A.users.supervisor);
    await http(se).post(`/projects/${A.ids.project}/participants`, { userId: A.users.supervisor, title: 'منسّق', level: 'VIEWER' }).expect(201);
    expect((await http(se).get(path()).expect(200)).body.map((c: { id: string }) => c.id)).not.toContain(A.users.supervisor);
    expect((await http(await as(viewer)).get(path())).status).toBe(403);
    expect((await http(await as(scoped)).get(path())).status).toBe(404);
  });

  it("supervisors, monitors and project participants (even editors) may not; B's project answers 404", async () => {
    expect((await http(await as(await usernameOf(A.users.supervisor))).get(path())).status).toBe(403);
    expect((await http(await as(await usernameOf(A.users.monitor))).get(path())).status).toBe(403);
    const editor = await mkUser('pce', [{ ws: wsA, role: 'MEMBER' }]);
    await http(admin).post(`/projects/${A.ids.project}/participants`, { userId: editor.id, title: 'محرّر', level: 'EDITOR' }).expect(201);
    expect((await http(await as(editor)).get(path())).status).toBe(403);
    expect((await http(admin).get(`/projects/${B.ids.project}/participant-candidates`)).status).toBe(404);
    expect((await http(owner).get(`/projects/${B.ids.project}/participant-candidates`)).status).toBe(404);
  });

  it('a dual-role candidate carries the flag (and nothing about the other workspace)', async () => {
    const dual = await mkUser('pcd', [{ ws: wsA, role: 'MEMBER' }, { ws: wsB, role: 'MONITOR' }]);
    const res = await http(admin).get(`${path()}?q=${dual.username}`).expect(200);
    expect(res.body).toEqual([{ id: dual.id, fullName: dual.fullName, username: dual.username, hasPhoto: false, role: 'MEMBER', dualRole: true }]);
  });
});

// ───────────────────────────────────────────────────────────── 4. dual role on embedded person refs

describe('«صلاحية مزدوجة» on every embedded person ref', () => {
  let supSession: Session;

  beforeAll(async () => {
    // A's supervisor also becomes a monitor in workspace B → a dual role.
    await sql(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'MONITOR')`, [wsB, A.users.supervisor]);
    // two workspaces now: the login picks none, so switch to A
    const first = await as(await usernameOf(A.users.supervisor));
    const sw = await ctx.http().post('/api/v1/auth/switch-workspace').set(bearer(first)).set('Cookie', first.cookie).send({ workspaceId: wsA }).expect(200);
    supSession = { accessToken: sw.body.accessToken, ...cookiesFrom(sw), body: sw.body };
    await http(supSession).post(`/tasks/${A.ids.task}/comments`, { body: 'تعليق المشرف المزدوج' }).expect(201);
  });

  const noB = (body: unknown) => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(wsB);
    expect(text).not.toContain('قسم ج');
  };

  it('task assignees (gantt, task, my tasks) — the dual one flagged, the others without the field', async () => {
    const g = await http(admin).get(`/projects/${A.ids.project}/gantt`).expect(200);
    const assigned = (g.body.tasks as Array<{ assignee: { id: string; dualRole?: boolean } | null }>).filter((t) => t.assignee);
    expect(assigned.length).toBeGreaterThan(0);
    for (const t of assigned) expect(t.assignee!.dualRole).toBe(t.assignee!.id === A.users.supervisor ? true : undefined);
    noB(g.body);
    const t = await http(admin).get(`/tasks/${A.ids.task}`).expect(200);
    expect(t.body.assignee).toMatchObject({ id: A.users.supervisor, dualRole: true });
    const mine = await http(supSession).get('/tasks/mine').expect(200);
    const items = Array.isArray(mine.body) ? mine.body : mine.body.items;
    expect(items.find((x: { id: string }) => x.id === A.ids.task).assignee.dualRole).toBe(true);
  });

  it('comment authors and hub rows', async () => {
    const c = await http(admin).get(`/tasks/${A.ids.task}/comments`).expect(200);
    const list = (Array.isArray(c.body) ? c.body : c.body.items) as Array<{ author: { id: string; dualRole?: boolean } }>;
    expect(list.find((x) => x.author.id === A.users.supervisor)!.author.dualRole).toBe(true);
    expect('dualRole' in list.find((x) => x.author.id === A.users.admin)!.author).toBe(false);
    const hub = await http(admin).get('/hub').expect(200);
    const row = hub.body.items.find((i: { task: { id: string } }) => i.task.id === A.ids.task);
    expect(row.task.assignee.dualRole).toBe(true);
    const author = row.lastComment.author as { id: string; dualRole?: boolean };
    expect(author.dualRole).toBe(author.id === A.users.supervisor ? true : undefined);
    noB(hub.body);
  });

  it('team supervisors, participants and approvals', async () => {
    const team = await http(admin).get(`/teams/${A.ids.team}`).expect(200);
    expect(team.body.supervisor).toMatchObject({ id: A.users.supervisor, dualRole: true });
    expect(team.body.supervisors[0]).toMatchObject({ id: A.users.supervisor, dualRole: true });
    const teams = await http(admin).get('/teams').expect(200);
    const listed = (Array.isArray(teams.body) ? teams.body : teams.body.items).find((x: { id: string }) => x.id === A.ids.team);
    expect(listed.supervisors[0].dualRole).toBe(true);
    const parts = await http(admin).get(`/projects/${A.ids.project}/participants`).expect(200);
    expect(parts.body.find((p: { user: { id: string } }) => p.user.id === A.users.supervisor).user.dualRole).toBe(true);
    expect('dualRole' in parts.body.find((p: { user: { id: string } }) => p.user.id === A.users.monitor).user).toBe(false);
    const reqs = await http(admin).get('/member-requests?status=ALL').expect(200);
    expect(reqs.body.items.length).toBeGreaterThan(0);
    for (const r of reqs.body.items) expect(r.requestedBy).toMatchObject({ id: A.users.supervisor, dualRole: true });
    noB(reqs.body);
  });
});
