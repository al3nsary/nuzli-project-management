/**
 * A12: one complete "workspace worth" of business data — at least one row in EVERY one of the 45
 * workspace-scoped tables — inserted with plain SQL as the superuser. Every text a user could see
 * carries `tag`, so a test can prove that nothing of workspace B ever reaches a user of A.
 *
 * `legacy: true` writes the same rows in the PRE-A12 schema (no workspace_id, users.role), for the
 * migration test.
 */
import { randomUUID } from 'node:crypto';
import type { PGlite } from './pglite';

export interface FixtureUsers {
  admin: string;
  supervisor: string;
  monitor: string;
  /** A registration addressed to this workspace (PENDING). */
  pending: string;
}

export interface WorkspaceFixture {
  workspaceId: string | null;
  tag: string;
  users: FixtureUsers;
  /** Row ids by logical name (team, member, project, task, …). */
  ids: Record<string, string>;
  /** Rows inserted per table (the migration test compares counts). */
  counts: Record<string, number>;
}

type Row = Record<string, unknown>;

/** The API's national-ID encryption (CryptoService.encrypt), so admins can open the rows. */
export type Encrypt = (plain: string) => Buffer;

let seq = 0;
/** A unique, valid-looking Saudi national ID (check digit not needed by the DB). */
const nid = () => `1${String(100000000 + ++seq).slice(-9)}`;

async function insert(db: PGlite, table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  // Values cross from the Jest realm into PGlite's (pglite-env.js): send them as text literals.
  const vals = Object.values(row).map((v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return v.toString('hex');
    if (Array.isArray(v)) return `{${v.join(',')}}`;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  const raw = Object.values(row);
  const placeholders = cols.map((_, i) => (Buffer.isBuffer(raw[i]) ? `decode($${i + 1}, 'hex')` : `$${i + 1}`));
  await db.query(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`, vals);
}

/**
 * Inserts users (global) and, unless `legacy`, their memberships of `workspaceId`.
 * `passwordHash` lets the isolation suite log them in.
 */
export async function insertUsers(
  db: PGlite,
  opts: { workspaceId: string | null; tag: string; legacy?: boolean; passwordHash: string | null; encrypt?: Encrypt },
): Promise<FixtureUsers> {
  const u: FixtureUsers = { admin: randomUUID(), supervisor: randomUUID(), monitor: randomUUID(), pending: randomUUID() };
  const short = opts.tag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  const people: Array<[keyof FixtureUsers, string, string]> = [
    ['admin', 'ADMIN', 'ACTIVE'],
    ['supervisor', 'SUPERVISOR', 'ACTIVE'],
    ['monitor', 'MONITOR', 'ACTIVE'],
    ['pending', 'SUPERVISOR', 'PENDING'],
  ];
  for (const [key, role, status] of people) {
    const n = ++seq;
    const row: Row = {
      id: u[key],
      full_name: `${opts.tag} ${key}`,
      email: `${key}.${short}.${n}@nuzli.test`,
      mobile: `+9665${String(10000000 + n).slice(-8)}`,
      national_id_enc: opts.encrypt ? opts.encrypt(nid()) : Buffer.from([1, 2, 3, n % 255]),
      national_id_hash: `hash-${short}-${key}-${n}`,
      national_id_last2: '23',
      national_id_first: '1',
      password_hash: opts.passwordHash,
      status,
      requested_role: status === 'PENDING' ? role : null,
      updated_at: new Date(),
    };
    if (opts.legacy) row.role = role;
    else {
      row.username = `${key}.${short}${n}`;
      if (status === 'PENDING') row.requested_workspace_id = opts.workspaceId;
    }
    await insert(db, 'users', row);
    if (!opts.legacy && status === 'ACTIVE') {
      await insert(db, 'workspace_memberships', { workspace_id: opts.workspaceId, user_id: u[key], role });
    }
  }
  return u;
}

/** One row (or two) in every business table of the workspace. */
export async function insertWorkspaceRows(
  db: PGlite,
  opts: { workspaceId: string | null; tag: string; users: FixtureUsers; legacy?: boolean; encrypt?: Encrypt },
): Promise<WorkspaceFixture> {
  const ws = opts.workspaceId;
  const T = opts.tag;
  const ids: Record<string, string> = {};
  const counts: Record<string, number> = {};
  const id = (name: string) => (ids[name] = randomUUID());
  const now = new Date();
  const add = async (table: string, row: Row) => {
    const r: Row = { ...row };
    if (!opts.legacy) r.workspace_id = ws;
    await insert(db, table, r);
    counts[table] = (counts[table] ?? 0) + 1;
  };
  const U = opts.users;

  await add('team_colors', { id: id('color'), name: `${T} لون`, hex: `#0A${(++seq).toString(16).toUpperCase().padStart(4, '0')}`, updated_at: now });
  await add('team_colors', { id: id('color2'), name: `${T} لون ٢`, hex: `#0B${(++seq).toString(16).toUpperCase().padStart(4, '0')}`, updated_at: now });
  await add('departments', { id: id('department'), name: `${T} إدارة`, updated_at: now });
  await add('job_titles', { id: id('jobTitle'), name: `${T} مسمى`, updated_at: now });
  await add('org_units', { id: id('unit'), name: `${T} وحدة`, kind: 'DEPARTMENT', updated_at: now });
  await add('teams', { id: id('team'), name: `${T} فريق`, color_id: ids.color, supervisor_id: U.supervisor, status: 'ACTIVE', org_unit_id: ids.unit, updated_at: now });
  await add('team_supervisors', { id: id('teamSupervisor'), team_id: ids.team, user_id: U.supervisor, is_primary: true });
  await add('team_supervisor_history', { id: id('supervisorHistory'), team_id: ids.team, supervisor_id: U.supervisor, valid_to: new Date(now.getTime() - 1000), valid_from: new Date(now.getTime() - 86_400_000) });
  // files: a member photo, a task attachment, violation photos, a logo, an import upload
  for (const [name, entity, kind, mime] of [
    ['memberPhotoFile', 'member_photo', 'PHOTO', 'image/png'],
    ['taskFile', 'task', 'ATTACHMENT', 'application/pdf'],
    ['idCardFile', 'violation', 'ID_CARD', 'image/jpeg'],
    ['evidenceFile', 'violation', 'EVIDENCE', 'image/jpeg'],
    ['logoFile', 'logo', 'LOGO', 'image/png'],
    ['importFile', 'import', null, 'text/csv'],
  ] as const) {
    await add('files', {
      id: id(name),
      storage_key: `${entity}/${randomUUID()}.bin`,
      bucket: 'nuzli-test',
      mime_type: mime,
      size_bytes: 10,
      status: 'READY',
      uploaded_by: U.admin,
      entity_type: entity,
      kind,
      updated_at: now,
    });
  }
  await add('team_members', {
    id: id('member'),
    full_name: `${T} عامل`,
    national_id_enc: opts.encrypt ? opts.encrypt(nid()) : Buffer.from([9, 9]),
    national_id_hash: `member-${T}-${randomUUID()}`,
    national_id_last4: '0023',
    national_id_first: '1',
    job_title_id: ids.jobTitle,
    department_id: ids.department,
    photo_file_id: ids.memberPhotoFile,
    updated_at: now,
  });
  await db.query(`UPDATE files SET entity_id = $1 WHERE id = $2`, [ids.member, ids.memberPhotoFile]);
  await add('team_memberships', { id: id('membership'), member_id: ids.member, team_id: ids.team, role: 'WORKER' });
  await add('org_positions', { id: id('position'), unit_id: ids.unit, title: `${T} منصب`, holder_user_id: U.supervisor, updated_at: now });
  await add('org_positions', { id: id('position2'), unit_id: ids.unit, title: `${T} منصب ٢`, holder_member_id: ids.member, reports_to_position_id: ids.position, updated_at: now });
  await add('violation_visibility', { team_id: ids.team, mode: 'SHOW', updated_at: now });
  await add('calendars', { id: id('calendar'), name: `${T} تقويم`, updated_at: now });
  await add('calendar_exceptions', { id: id('calendarException'), calendar_id: ids.calendar, date: '2026-12-01', name: `${T} عطلة`, updated_at: now });
  await add('projects', { id: id('project'), name: `${T} مشروع`, start_date: '2026-10-01', status: 'ACTIVE', calendar_id: ids.calendar, owner_id: U.admin, updated_at: now });
  await add('project_access', { project_id: ids.project, user_id: U.supervisor, level: 'VIEW' });
  await add('tasks', { id: id('task'), project_id: ids.project, name: `${T} مهمة`, start_date: '2026-10-01', end_date: '2026-10-02', duration_days: 2, assignee_id: U.supervisor, updated_at: now });
  await add('tasks', { id: id('task2'), project_id: ids.project, name: `${T} مهمة ٢`, start_date: '2026-10-04', end_date: '2026-10-04', duration_days: 1, sort_order: 2, assignee_id: U.supervisor, updated_at: now });
  await db.query(`UPDATE files SET entity_id = $1 WHERE id = $2`, [ids.task, ids.taskFile]);
  await add('task_dependencies', { id: id('dependency'), project_id: ids.project, predecessor_id: ids.task, successor_id: ids.task2, updated_at: now });
  await add('task_comments', { id: id('comment'), task_id: ids.task, author_id: U.admin, body: `${T} تعليق`, mentions: [], updated_at: now });
  await add('task_comment_reads', { user_id: U.supervisor, task_id: ids.task, last_read_at: new Date(now.getTime() - 3_600_000) });
  await add('project_labels', { id: id('label'), project_id: ids.project, name: `${T} وسم`, color: '#5030E5', updated_at: now });
  await add('task_labels', { task_id: ids.task, label_id: ids.label });
  await add('custom_fields', { id: id('customField'), project_id: ids.project, name: `${T} حقل`, type: 'TEXT', options: '[]', updated_at: now });
  await add('task_custom_values', { task_id: ids.task, field_id: ids.customField, value: JSON.stringify(`${T} قيمة`), updated_at: now });
  await add('task_checklist_items', { id: id('checklistItem'), task_id: ids.task, text: `${T} بند`, updated_at: now });
  await add('user_view_prefs', { id: id('viewPref'), user_id: U.admin, project_id: ids.project, key: 'columns', value: { tag: T }, updated_at: now });
  await add('portfolios', { id: id('portfolio'), name: `${T} محفظة`, updated_at: now });
  await add('portfolio_projects', { portfolio_id: ids.portfolio, project_id: ids.project });
  await add('time_entries', { id: id('timeEntry'), task_id: ids.task, user_id: U.supervisor, date: '2026-10-01', minutes: 60, note: `${T} وقت`, updated_at: now });
  await add('baselines', { id: id('baseline'), project_id: ids.project, name: `${T} خط أساس` });
  await add('baseline_tasks', { baseline_id: ids.baseline, task_id: ids.task, start_date: '2026-10-01', end_date: '2026-10-02', duration_days: 2 });
  await add('violation_types', { id: id('violationType'), name: `${T} نوع مخالفة`, updated_at: now });
  await add('violations', {
    id: id('violation'),
    client_uuid: randomUUID(),
    member_id: ids.member,
    team_id_snapshot: ids.team,
    supervisor_id_snapshot: U.supervisor,
    recorded_by: U.monitor,
    type_id: ids.violationType,
    description: `${T} وصف المخالفة`,
    latitude: 24.7,
    longitude: 46.7,
    accuracy_m: 5,
    captured_at: new Date(now.getTime() - 3_600_000),
    assigned_at: now,
    updated_at: now,
  });
  await db.query(`UPDATE files SET entity_id = $1 WHERE id IN ($2, $3)`, [ids.violation, ids.idCardFile, ids.evidenceFile]);
  await add('violation_files', { id: id('violationFileIdCard'), violation_id: ids.violation, file_id: ids.idCardFile, kind: 'ID_CARD' });
  await add('violation_files', { id: id('violationFileEvidence'), violation_id: ids.violation, file_id: ids.evidenceFile, kind: 'EVIDENCE' });
  await add('violation_ocr', { violation_id: ids.violation, file_id: ids.idCardFile, status: 'PENDING', updated_at: now });
  await add('violation_responses', { id: id('violationResponse'), violation_id: ids.violation, supervisor_id: U.supervisor, body: `${T} رد`, updated_at: now });
  await add('import_previews', { id: id('importPreview'), created_by: U.admin, format: 'csv', file_id: ids.importFile, payload: { tag: T }, expires_at: new Date(now.getTime() + 3_600_000) });
  await add('logos', { id: id('logo'), name: `${T} شعار`, file_id: ids.logoFile, updated_at: now });
  await add('card_sizes', { id: id('cardSize'), name: `${T} مقاس`, width_mm: 85.6, height_mm: 54, updated_at: now });
  await add('card_templates', { id: id('cardTemplate'), name: `${T} قالب`, size_id: ids.cardSize, orientation: 'LANDSCAPE', layout_key: 'CLASSIC_HORIZONTAL', logo_id: ids.logo, updated_at: now });
  await add('card_print_batches', { id: id('printBatch'), idempotency_key: randomUUID(), template_id: ids.cardTemplate, printed_by: U.admin, card_count: 1 });
  await add('card_print_items', { id: id('printItem'), batch_id: ids.printBatch, member_id: ids.member, rendered_data: { fullName: `${T} عامل` } });
  await add('notifications', { id: id('notification'), user_id: U.admin, type: 'TASK_ASSIGNED', payload: { taskName: `${T} مهمة` } });
  await add('settings', { key: `nz_fixture_${T}`, value: { tag: T }, updated_at: now });
  await add('audit_log', { id: id('audit'), actor_id: U.admin, action: 'team.created', entity_type: 'team', entity_id: ids.team, after: { name: `${T} فريق` } });
  if (!opts.legacy) {
    // A12 round 2 tables (they do not exist before the A12 migrations).
    await add('project_participants', { project_id: ids.project, user_id: U.monitor, title: `${T} منصب المشارك`, level: 'CONTRIBUTOR', added_by: U.admin, updated_at: now });
    await add('member_requests', {
      id: id('memberRequest'),
      team_id: ids.team,
      kind: 'ADD',
      payload: { fullName: `${T} عامل مطلوب`, nationalIdMasked: '1•••••••23' },
      national_id_enc: opts.encrypt ? opts.encrypt(nid()) : Buffer.from([7, 7]),
      requested_by: U.supervisor,
      updated_at: now,
    });
    await add('member_requests', { id: id('memberRequestRemove'), team_id: ids.team, member_id: ids.member, kind: 'REMOVE', payload: { fullName: `${T} عامل` }, reason: `${T} سبب`, requested_by: U.supervisor, updated_at: now });
  }
  return { workspaceId: ws, tag: T, users: U, ids, counts };
}

/** Creates a workspace row (global table). */
export async function insertWorkspace(db: PGlite, code: string, name: string): Promise<string> {
  const wsId = randomUUID();
  await db.query(`INSERT INTO workspaces (id, name, code, updated_at) VALUES ($1, $2, $3, now())`, [wsId, name, code]);
  return wsId;
}

/**
 * Security review A12 M5: a person with roles in BOTH workspaces — SUPERVISOR in A, ADMIN and
 * SUPERVISOR in B —
 * with rows in B keyed by their user id (a notification, a project participation, a team
 * supervision, a time entry, project access, a comment read, a view preference, an assigned task).
 * Every query of the API keyed by the CALLER's id (notifications, participations, my tasks, my
 * teams, view preferences…) is probed from A with this identity: a missing workspace filter on
 * such a model returns B's row to them and the leak check names it.
 */
export async function insertDualMember(
  db: PGlite,
  opts: { A: WorkspaceFixture; B: WorkspaceFixture; passwordHash: string; encrypt?: Encrypt; username?: string },
): Promise<{ id: string; username: string }> {
  const id = randomUUID();
  const n = ++seq;
  const username = opts.username ?? `dual.member${n}`;
  const T = opts.B.tag;
  await insert(db, 'users', {
    id,
    full_name: `${opts.A.tag} dual member`,
    email: `dual.${n}@nuzli.test`,
    mobile: `+9665${String(30000000 + n).slice(-8)}`,
    national_id_enc: opts.encrypt ? opts.encrypt(nid()) : Buffer.from([4, 4, n % 255]),
    national_id_hash: `hash-dual-${n}`,
    national_id_last2: '23',
    national_id_first: '1',
    password_hash: opts.passwordHash,
    status: 'ACTIVE',
    username,
    updated_at: new Date(),
  });
  await insert(db, 'workspace_memberships', { workspace_id: opts.A.workspaceId, user_id: id, role: 'SUPERVISOR' });
  await insert(db, 'workspace_memberships', { workspace_id: opts.B.workspaceId, user_id: id, role: 'ADMIN' });
  await insert(db, 'workspace_memberships', { workspace_id: opts.B.workspaceId, user_id: id, role: 'SUPERVISOR' });
  const B = opts.B.ids;
  const ws = opts.B.workspaceId;
  const now = new Date();
  const rows: Array<[string, Row]> = [
    ['notifications', { id: randomUUID(), user_id: id, type: 'TASK_ASSIGNED', payload: { taskName: `${T} مهمة المزدوج` } }],
    ['project_participants', { project_id: B.project, user_id: id, title: `${T} منصب المزدوج`, level: 'EDITOR', added_by: opts.B.users.admin, updated_at: now }],
    ['team_supervisors', { id: randomUUID(), team_id: B.team, user_id: id, is_primary: false }],
    ['time_entries', { id: randomUUID(), task_id: B.task, user_id: id, date: '2026-10-03', minutes: 30, note: `${T} وقت المزدوج`, updated_at: now }],
    ['project_access', { project_id: B.project, user_id: id, level: 'VIEW' }],
    ['task_comment_reads', { user_id: id, task_id: B.task, last_read_at: now }],
    ['user_view_prefs', { id: randomUUID(), user_id: id, project_id: B.project, key: 'gantt', value: { tag: T } , updated_at: now }],
    ['org_positions', { id: randomUUID(), unit_id: B.unit, title: `${T} منصب تنظيمي للمزدوج`, holder_user_id: id, updated_at: now }],
  ];
  for (const [table, row] of rows) await insert(db, table, { ...row, workspace_id: ws });
  await db.query(`UPDATE tasks SET assignee_id = $1 WHERE id = $2`, [id, B.task2]);
  return { id, username };
}

/**
 * Security review A12 M5: real setting keys the API reads, with values that differ between the two
 * workspaces — a missing workspace filter on `settings` would let B's value override A's. A has
 * no row for `VIOLATION_REGISTER_MAX_AGE_DAYS` (so it uses the default, 30); B has 97.
 */
export const SETTING_PROBE = { key: 'VIOLATION_REGISTER_MAX_AGE_DAYS', defaultValue: 30, bValue: 97 } as const;

export async function insertProbeSettings(db: PGlite, A: WorkspaceFixture, B: WorkspaceFixture): Promise<void> {
  await db.query(`DELETE FROM settings WHERE workspace_id = $1 AND key = $2`, [A.workspaceId, SETTING_PROBE.key]);
  await db.query(
    `INSERT INTO settings (workspace_id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [B.workspaceId, SETTING_PROBE.key, JSON.stringify(SETTING_PROBE.bValue)],
  );
}
