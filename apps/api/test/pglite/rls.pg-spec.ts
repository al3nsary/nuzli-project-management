/**
 * A12 — PostgreSQL Row Level Security and the cross-workspace guards, on a real PostgreSQL (PGlite)
 * after the full migration chain. Two workspaces, A and B, each with a row in every one of the 45
 * business tables. RLS checks run as `nuzli_app` (the API's role: no superuser, no BYPASSRLS);
 * guard checks run as the superuser, so only the triggers stand in the way.
 */
import { unitWorkspaceFallback } from '../unit/workspace-setup';
import { APP_ROLE, asAppRole, asSuperuser, migratedDb, scopedTables, type PGlite } from '../support/pglite';
import { insertUsers, insertWorkspace, insertWorkspaceRows, type WorkspaceFixture } from '../support/workspace-fixture';

jest.setTimeout(120_000);

let db: PGlite;
let A: WorkspaceFixture;
let B: WorkspaceFixture;
let tables: string[];

async function count(table: string): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
  return r.rows[0]!.n;
}

/** Runs `fn` as nuzli_app inside a transaction bound to `ws` (what the API does per request). */
async function inWorkspace<T>(ws: string | null, fn: () => Promise<T>, bypass = false): Promise<T> {
  await asAppRole(db);
  await db.exec('BEGIN');
  try {
    await db.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.bypass_rls', $2, true)`, [ws ?? '', bypass ? 'on' : 'off']);
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
    await asSuperuser(db);
  }
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

beforeAll(async () => {
  unitWorkspaceFallback.enabled = false;
  db = await migratedDb();
  const wsA = await insertWorkspace(db, 'alpha', 'قسم أ');
  const wsB = await insertWorkspace(db, 'beta', 'قسم ب');
  const ua = await insertUsers(db, { workspaceId: wsA, tag: 'WSA-SECRET', passwordHash: null });
  const ub = await insertUsers(db, { workspaceId: wsB, tag: 'WSB-SECRET', passwordHash: null });
  A = await insertWorkspaceRows(db, { workspaceId: wsA, tag: 'WSA-SECRET', users: ua });
  B = await insertWorkspaceRows(db, { workspaceId: wsB, tag: 'WSB-SECRET', users: ub });
  tables = await scopedTables(db);
});

afterAll(async () => {
  await db?.close();
});

describe('RLS is on every business table', () => {
  it('45 workspace-scoped tables; the fixture filled every one of them in both workspaces', () => {
    expect(tables).toHaveLength(45);
    expect(Object.keys(A.counts).sort()).toEqual(tables);
    expect(Object.keys(B.counts).sort()).toEqual(tables);
  });

  it('ENABLE + FORCE row level security and one isolation policy per table', async () => {
    const r = await db.query<{ relname: string; rls: boolean; force: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [tables],
    );
    expect(r.rows).toHaveLength(45);
    for (const row of r.rows) expect([row.relname, row.rls, row.force, row.policies]).toEqual([row.relname, true, true, 1]);
  });

  it('the application role cannot bypass RLS', async () => {
    const r = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('RLS as nuzli_app', () => {
  it('FAIL CLOSED: without a workspace the application role sees no business row at all', async () => {
    await inWorkspace(null, async () => {
      for (const t of tables) expect([t, await count(t)]).toEqual([t, 0]);
    });
  });

  it('inside workspace A it sees exactly A’s rows — in all 45 tables — and nothing of B', async () => {
    await inWorkspace(A.workspaceId, async () => {
      for (const t of tables) {
        const r = await db.query<{ n: number; foreign: number }>(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1)::int AS foreign FROM "${t}"`,
          [A.workspaceId],
        );
        // A (seeded by the fixture) — the settings/colours seeded for A count too, so ">= fixture".
        expect([t, r.rows[0]!.foreign]).toEqual([t, 0]);
        expect(r.rows[0]!.n).toBeGreaterThanOrEqual(A.counts[t]!);
      }
      const leaked = await db.query(`SELECT id FROM teams WHERE id = $1`, [B.ids.team]);
      expect(leaked.rows).toHaveLength(0);
    });
  });

  it('cannot write into another workspace: insert refused, update/delete touch nothing', async () => {
    await inWorkspace(A.workspaceId, async () => {
      const insert = await errorOf(`INSERT INTO departments (name, workspace_id, updated_at) VALUES ('x', $1, now())`, [B.workspaceId]);
      expect(insert).toMatch(/row-level security/);
    });
    await inWorkspace(A.workspaceId, async () => {
      const upd = await db.query(`UPDATE teams SET name = 'hacked' WHERE id = $1`, [B.ids.team]);
      expect(upd.affectedRows ?? 0).toBe(0);
      const del = await db.query(`DELETE FROM task_comments WHERE id = $1`, [B.ids.comment]);
      expect(del.affectedRows ?? 0).toBe(0);
    });
    await inWorkspace(A.workspaceId, async () => {
      // Moving one of A's rows to B is refused too.
      const move = await errorOf(`UPDATE departments SET workspace_id = $1 WHERE id = $2`, [B.workspaceId, A.ids.department]);
      expect(move).toMatch(/row-level security|NZ_CROSS_WORKSPACE/);
    });
    const still = await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [B.ids.team]);
    expect(still.rows[0]!.name).toBe('WSB-SECRET فريق');
  });

  it('a new row takes the session workspace by default (workspace_id DEFAULT nz_current_workspace())', async () => {
    await inWorkspace(A.workspaceId, async () => {
      const r = await db.query<{ workspace_id: string }>(`INSERT INTO departments (name, updated_at) VALUES ('افتراضي', now()) RETURNING workspace_id`);
      expect(r.rows[0]!.workspace_id).toBe(A.workspaceId);
    });
    await inWorkspace(null, async () => {
      const err = await errorOf(`INSERT INTO departments (name, updated_at) VALUES ('بلا قسم', now())`);
      // Refused either by RLS (NULL is no workspace) or by NOT NULL — fail closed both ways.
      expect(err).toMatch(/row-level security|null value|not-null/);
    });
  });

  it('global audit entries (workspace NULL) are invisible inside any workspace', async () => {
    await db.query(`INSERT INTO audit_log (action, entity_type) VALUES ('auth.account_locked', 'user')`);
    await inWorkspace(A.workspaceId, async () => {
      const r = await db.query(`SELECT 1 FROM audit_log WHERE workspace_id IS NULL`);
      expect(r.rows).toHaveLength(0);
    });
    await inWorkspace(null, async () => {
      const r = await db.query(`SELECT 1 FROM audit_log WHERE workspace_id IS NULL`);
      expect(r.rows.length).toBeGreaterThan(0);
    });
  });

  it('the audited owner bypass sees every workspace', async () => {
    await inWorkspace(
      A.workspaceId,
      async () => {
        const r = await db.query<{ n: number }>(`SELECT count(DISTINCT workspace_id)::int AS n FROM teams`);
        expect(r.rows[0]!.n).toBe(2);
      },
      true,
    );
  });

  it('identity tables stay global (users, memberships, workspaces)', async () => {
    await inWorkspace(A.workspaceId, async () => {
      const r = await db.query(`SELECT 1 FROM users WHERE id = $1`, [B.users.admin]);
      expect(r.rows).toHaveLength(1);
    });
  });
});

describe('cross-workspace guards (constraint triggers) — even with RLS bypassed', () => {
  /** (table, column, referenced table) of every same-workspace guard, read from the triggers. */
  async function guardedReferences(): Promise<Array<[string, string, string]>> {
    const r = await db.query<{ table: string; args: string }>(
      `SELECT c.relname AS table, encode(t.tgargs, 'escape') AS args
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'nz_same_workspace_trg'`,
    );
    const out: Array<[string, string, string]> = [];
    for (const row of r.rows) {
      const parts = row.args.split('\\000').filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i += 2) out.push([row.table, parts[i]!, parts[i + 1]!]);
    }
    return out;
  }

  it('every business table carries the guard trigger', async () => {
    const r = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'nz_same_workspace_trg'`,
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual(tables);
  });

  it('EVERY reference column refuses a row of the other workspace', async () => {
    const refs = await guardedReferences();
    expect(refs.length).toBeGreaterThanOrEqual(45);
    const tested: string[] = [];
    for (const [table, column, refTable] of refs) {
      const target = await db.query<{ id: string }>(`SELECT id FROM "${refTable}" WHERE workspace_id = $1 LIMIT 1`, [B.workspaceId]);
      const own = await db.query<{ ctid: string }>(`SELECT ctid::text AS ctid FROM "${table}" WHERE workspace_id = $1 LIMIT 1`, [A.workspaceId]);
      expect([table, column, target.rows.length, own.rows.length]).toEqual([table, column, 1, 1]);
      const err = await errorOf(`UPDATE "${table}" SET "${column}" = $1 WHERE ctid = $2::tid`, [target.rows[0]!.id, own.rows[0]!.ctid]);
      expect([table, column, err]).toEqual([table, column, expect.stringMatching(/NZ_CROSS_WORKSPACE|violates|SUPERVISOR/)]);
      tested.push(`${table}.${column}`);
    }
    expect(tested.length).toBe(refs.length);
  });

  it('workspace_id is immutable on every business table', async () => {
    for (const t of tables) {
      const own = await db.query<{ ctid: string }>(`SELECT ctid::text AS ctid FROM "${t}" WHERE workspace_id = $1 LIMIT 1`, [A.workspaceId]);
      const err = await errorOf(`UPDATE "${t}" SET workspace_id = $1 WHERE ctid = $2::tid`, [B.workspaceId, own.rows[0]!.ctid]);
      // audit_log refuses every UPDATE (append-only) before the workspace guard runs.
      expect([t, err]).toEqual([t, expect.stringMatching(/NZ_CROSS_WORKSPACE|violates|append-only/)]);
    }
  });

  it('a new row pointing into the other workspace is refused (insert path)', async () => {
    const err = await errorOf(
      `INSERT INTO tasks (project_id, name, start_date, end_date, workspace_id, updated_at) VALUES ($1, 'x', '2026-10-01', '2026-10-01', $2, now())`,
      [B.ids.project, A.workspaceId],
    );
    expect(err).toMatch(/NZ_CROSS_WORKSPACE/);
  });

  it('files.entity_id (polymorphic) must point into the same workspace', async () => {
    const err = await errorOf(`UPDATE files SET entity_id = $1 WHERE id = $2`, [B.ids.task, A.ids.taskFile]);
    expect(err).toMatch(/NZ_CROSS_WORKSPACE/);
  });

  it('users referenced by business rows must be members of that workspace', async () => {
    expect(await errorOf(`UPDATE tasks SET assignee_id = $1 WHERE id = $2`, [B.users.supervisor, A.ids.task])).toMatch(/ASSIGNEE_NOT_SUPERVISOR/);
    expect(await errorOf(`UPDATE teams SET supervisor_id = $1 WHERE id = $2`, [B.users.supervisor, A.ids.team])).toMatch(/NOT_A_SUPERVISOR/);
    expect(
      await errorOf(`INSERT INTO team_supervisors (team_id, user_id, workspace_id) VALUES ($1, $2, $3)`, [A.ids.team, B.users.supervisor, A.workspaceId]),
    ).toMatch(/NOT_A_SUPERVISOR/);
    expect(await errorOf(`UPDATE org_positions SET holder_user_id = $1 WHERE id = $2`, [B.users.admin, A.ids.position])).toMatch(/NZ_CROSS_WORKSPACE/);
    expect(
      await errorOf(`INSERT INTO project_access (project_id, user_id, workspace_id) VALUES ($1, $2, $3)`, [A.ids.project, B.users.monitor, A.workspaceId]),
    ).toMatch(/NZ_CROSS_WORKSPACE/);
  });
});
