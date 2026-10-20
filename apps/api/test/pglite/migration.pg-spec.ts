/**
 * A12 — the data migration on a real PostgreSQL (PGlite): the chain up to the last pre-A12
 * migration, a populated system (every business table, every kind of account), then the A12
 * migration. Nothing may be lost and everything must land in «إدارة المشاريع».
 */
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { A12_MIGRATION, migrate, migrationSql, newPglite, type PGlite } from '../support/pglite';
import { insertUsers, insertWorkspaceRows, type WorkspaceFixture } from '../support/workspace-fixture';

jest.setTimeout(120_000);

let db: PGlite;
let one: WorkspaceFixture;
let two: WorkspaceFixture;
const before: Record<string, number> = {};
let notices: string[] = [];

const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const count = async (table: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))[0]!.n;

beforeAll(async () => {
  unitWorkspaceFallback.enabled = false;
  db = await newPglite();
  const applied = await migrate(db, { before: A12_MIGRATION });
  expect(applied.at(-1)).toBe('20261022000000_calc_audit_fixes');

  // Two "teams of people" worth of data in the legacy schema (no workspaces yet).
  const u1 = await insertUsers(db, { workspaceId: null, tag: 'LEGACY-ONE', legacy: true, passwordHash: 'x' });
  const u2 = await insertUsers(db, { workspaceId: null, tag: 'LEGACY-TWO', legacy: true, passwordHash: 'x' });
  one = await insertWorkspaceRows(db, { workspaceId: null, tag: 'LEGACY-ONE', users: u1, legacy: true });
  two = await insertWorkspaceRows(db, { workspaceId: null, tag: 'LEGACY-TWO', users: u2, legacy: true });
  // The seed's bootstrap admin is identified by its audit entry.
  await db.query(`INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('user.bootstrap_admin_created', 'user', $1)`, [u1.admin]);
  // A suspended account, a rejected registration, a user profile photo, two e-mails with the same local part.
  await db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [u2.monitor]);
  await db.query(
    `INSERT INTO users (id, full_name, email, mobile, national_id_enc, national_id_hash, national_id_last2, national_id_first, role, status, updated_at)
     VALUES (gen_random_uuid(), 'مرفوض', 'admin.legacyone.1@other.test', '+966511111111', '\\x01', 'rej-hash', '23', '1', 'MONITOR', 'REJECTED', now()),
            (gen_random_uuid(), 'رقمي', '123@digits.test', '+966511111112', '\\x01', 'dig-hash', '23', '1', 'MONITOR', 'ACTIVE', now())`,
  );
  await db.query(
    `INSERT INTO files (id, storage_key, bucket, mime_type, size_bytes, status, entity_type, entity_id, kind, updated_at)
     VALUES (gen_random_uuid(), 'user-photos/x.png', 'b', 'image/png', 10, 'READY', 'user_photo', $1, 'PHOTO', now())`,
    [u1.supervisor],
  );
  await db.query(`UPDATE users SET photo_file_id = (SELECT id FROM files WHERE entity_type = 'user_photo') WHERE id = $1`, [u1.supervisor]);
  await db.query(`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, gen_random_uuid(), 'rt-hash', now() + interval '1 day')`, [u1.admin]);

  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  for (const t of tables) before[t.table_name] = await count(t.table_name);

  // Backup reminder lives in the docs; here: apply the A12 migration exactly as migrate deploy would.
  notices = [];
  await db.exec(migrationSql(A12_MIGRATION), { onNotice: (n) => notices.push(String(n.message)) });
});

afterAll(async () => {
  await db?.close();
});

describe('A12 migration — nothing lost, everything in «إدارة المشاريع»', () => {
  it('creates exactly one workspace «إدارة المشاريع» (code projects)', async () => {
    expect(await q(`SELECT name, code, status FROM workspaces`)).toEqual([{ name: 'إدارة المشاريع', code: 'projects', status: 'ACTIVE' }]);
  });

  it('every table keeps every row (counts before = after)', async () => {
    for (const [t, n] of Object.entries(before)) expect([t, await count(t)]).toEqual([t, n]);
    // and the fixture really filled every business table (twice)
    for (const t of Object.keys(one.counts)) expect(before[t]).toBeGreaterThanOrEqual(one.counts[t]! + two.counts[t]!);
  });

  it('every business row of the 45 tables belongs to «إدارة المشاريع»; user photos stay global', async () => {
    const ws = (await q<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`))[0]!.id;
    const tables = Object.keys(one.counts);
    expect(tables).toHaveLength(45);
    for (const t of tables) {
      const rows = await q<{ outside: number }>(
        t === 'files'
          ? `SELECT count(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1 AND entity_type <> 'user_photo')::int AS outside FROM files`
          : `SELECT count(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1)::int AS outside FROM "${t}"`,
        [ws],
      );
      expect([t, rows[0]!.outside]).toEqual([t, 0]);
    }
    expect(await q(`SELECT workspace_id FROM files WHERE entity_type = 'user_photo'`)).toEqual([{ workspace_id: null }]);
    // NOT NULL from now on (except the two documented exceptions)
    const nullable = await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE column_name = 'workspace_id' AND is_nullable = 'YES' AND table_schema = 'public' ORDER BY 1`,
    );
    expect(nullable.map((r) => r.table_name)).toEqual(['audit_log', 'files', 'refresh_tokens']);
  });

  it('accounts: one membership per approved role, the bootstrap admin is the OWNER, registrations point to the workspace', async () => {
    const ws = (await q<{ id: string }>(`SELECT id FROM workspaces WHERE code = 'projects'`))[0]!.id;
    const users = await q<{ id: string; role: string | null; status: string; account_role: string; requested_workspace_id: string | null }>(
      `SELECT id, role::text AS role, status::text AS status, account_role::text AS account_role, requested_workspace_id FROM users`,
    );
    for (const u of users) {
      const m = await q<{ role: string; workspace_id: string }>(`SELECT role::text AS role, workspace_id FROM workspace_memberships WHERE user_id = $1`, [u.id]);
      if (u.status === 'ACTIVE' || u.status === 'SUSPENDED') expect([u.id, m]).toEqual([u.id, [{ role: u.role, workspace_id: ws }]]);
      else {
        expect([u.id, m]).toEqual([u.id, []]);
        expect(u.requested_workspace_id).toBe(ws);
      }
    }
    const owners = users.filter((u) => u.account_role === 'OWNER').map((u) => u.id);
    expect(owners).toEqual([one.users.admin]);
  });

  it('usernames: generated from the e-mail, valid, unique, de-duplicated', async () => {
    const rows = await q<{ email: string; username: string }>(`SELECT email, username FROM users ORDER BY created_at, id`);
    const names = rows.map((r) => r.username);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9._-]{2,31}$/);
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.username]));
    expect(byEmail['123@digits.test']).toBe('u123');
    const dup = rows.filter((r) => r.email.startsWith('admin.legacyone.1@'));
    expect(dup.map((r) => r.username).sort()).toEqual(['admin.legacyone.1', 'admin.legacyone.12']);
  });

  it('live sessions keep working: refresh tokens are bound to the workspace', async () => {
    expect(await q(`SELECT (workspace_id IS NOT NULL) AS bound FROM refresh_tokens`)).toEqual([{ bound: true }]);
  });

  it('the migration reports its own verification (per-table counts) and RLS is on', async () => {
    expect(notices.some((n) => /A12: teams — \d+ rows \(before\) = \d+ rows \(after\)/.test(n))).toBe(true);
    expect(notices.some((n) => /business rows moved into «إدارة المشاريع»/.test(n))).toBe(true);
    const forced = await q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relforcerowsecurity`);
    expect(forced[0]!.n).toBe(45);
  });

  it('the guards are active after the migration (a cross-workspace reference is refused)', async () => {
    const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, code, updated_at) VALUES ('قسم آخر', 'other', now()) RETURNING id`))[0]!.id;
    await db.query(`INSERT INTO departments (name, workspace_id, updated_at) VALUES ('إدارة أخرى', $1, now())`, [other]);
    const dept = (await q<{ id: string }>(`SELECT id FROM departments WHERE workspace_id = $1`, [other]))[0]!.id;
    await expect(db.query(`UPDATE team_members SET department_id = $1 WHERE id = $2`, [dept, one.ids.member])).rejects.toThrow(/NZ_CROSS_WORKSPACE/);
  });
});
