# A12 round 1 — workspace isolation (design and as built)

> Owner (A12): «تأكد من العزل الصحيح… تداخل المعلومات أو فقدانها بين الأقسام مصيبة… العزل أولًا».
> Brief: `PROMPT.md` §18 A12 and `docs/brief/A12-request.md`. ADRs: ADR-142 … ADR-147.
> Round 1 = the isolation foundation (schema, migration, scoping layer, RLS, sessions, permissions,
> tests). Round 2 = assistants, project participants, user-management screens; the web port comes after.

## 1. Tenancy model (ADR-142)

- **Workspace (قسم)** — a complete, isolated copy of the business system: projects, teams, workers,
  violations, cards, org structure, reports, notifications, audit, settings and reference data.
  Table `workspaces(id, name, code UNIQUE, status ACTIVE|ARCHIVED, created_at, created_by, archived_at)`.
  Never deleted: archived (no cross-workspace cascades; `workspace_id` FKs are `ON DELETE RESTRICT`).
- **Shared tables + `workspace_id`** on every business row (not schema-per-tenant): one migration
  chain, one Prisma client, cross-workspace reporting possible for owners later.
- **Identity is global.** One `users` row per person, unique e-mail / mobile / national ID / **username**
  (new, case-insensitive: stored lower case, `CHECK username ~ '^[a-z][a-z0-9._-]{2,31}$'`).
  - `users.account_role` **OWNER | USER**. Owners hold every permission in every workspace.
  - `workspace_memberships(id, workspace_id, user_id, role ADMIN|ASSISTANT|SUPERVISOR|MONITOR|MEMBER,
    title, permissions jsonb, scope jsonb, status ACTIVE|SUSPENDED, created_at, created_by, archived_at)`,
    unique `(workspace_id, user_id, role)`. A person may hold roles in several workspaces, and two roles
    in one (dual role; the matrix grants the union).
  - `users.role` is **legacy**: frozen at the migration, never read by the API, dropped in a later release.
  - `users.requested_workspace_id` — the workspace a registration applies to.
  - `refresh_tokens.workspace_id` — the workspace a session is bound to (kept across refreshes).

### Table classification (50 tables)

| Kind | Tables |
|---|---|
| **Global — identity/session (5)** | `users`, `refresh_tokens`, `action_tokens`, `workspaces`, `workspace_memberships` |
| **Workspace-scoped (45)** — `workspace_id NOT NULL` + FK + index + RLS + guard trigger | `team_colors`, `teams`, `team_supervisors`, `team_supervisor_history`, `team_members`, `team_memberships`, `departments`, `job_titles`, `org_units`, `org_positions`, `calendars`, `calendar_exceptions`, `projects`, `project_access`, `tasks`, `task_dependencies`, `task_comments`, `task_comment_reads`, `project_labels`, `task_labels`, `custom_fields`, `task_custom_values`, `task_checklist_items`, `time_entries`, `baselines`, `baseline_tasks`, `user_view_prefs`, `portfolios`, `portfolio_projects`, `violation_types`, `violations`, `violation_ocr`, `violation_files`, `violation_responses`, `violation_visibility`, `import_previews`, `files`, `logos`, `card_sizes`, `card_templates`, `card_print_batches`, `card_print_items`, `notifications`, `settings`, `audit_log` |
| Scoped, **NULL allowed** (2 of the 45) | `audit_log` (account-level entries: login lock, refresh reuse, owner cross-workspace access); `files` (only `entity_type = 'user_photo'`: profile photos follow the global account — `CHECK files_workspace_chk`) |

Children carry `workspace_id` themselves (tasks, comments, checklists…) so RLS never needs a join.

### Uniqueness per workspace

| Was global | Now |
|---|---|
| `team_colors.hex` | `(workspace_id, hex)` |
| `team_members.national_id_hash` | `(workspace_id, national_id_hash)` — the same worker may exist in two workspaces |
| `departments.name`, `job_titles.name`, `portfolios.name`, `violation_types.name`, `card_sizes.name` | `(workspace_id, name)` |
| `settings` PK `key` | PK `(workspace_id, key)` |
| `teams_color_reserved_uq (color_id)` | `(workspace_id, color_id) WHERE status IN (ACTIVE, PENDING_APPROVAL)` |
| one default logo / template / calendar | one per workspace |
| `org_units_code_uq (lower(code))` | `(workspace_id, lower(code))` |
| `user_view_prefs` (user, project, key) | `(workspace_id, user, project, key)` |

Unchanged (globally unique random/identity values): `violations.client_uuid`, `card_print_batches.idempotency_key`,
`files.storage_key`, `logos.file_id`, `violation_files.file_id`, `team_members.user_id` (future-login hook),
users' e-mail, mobile, national ID hash, username.

## 2. The scoping layer (ADR-143)

**Request context.** `AsyncLocalStorage` store `{ workspaceId, userId, accountRole, bypass, label }`
(`src/prisma/workspace-context.ts`). A Nest middleware opens an empty store for every request;
`JwtAuthGuard` fills it after checking the token's `wid` against the user's live memberships.

**Prisma extension** (`src/prisma/prisma.service.ts`, `src/prisma/scoping.ts`). `PrismaService` returns a
proxy over `$extends({ query: { $allOperations } })`:

| Operation on a scoped model | Rewrite |
|---|---|
| `findUnique(OrThrow)`, `findFirst(OrThrow)`, `findMany`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `delete`, `deleteMany` | `where = { ...where, AND: [...where.AND, { workspaceId }] }` (AND only — a caller's own `workspaceId` can never widen it) |
| `create`, `createMany`, `createManyAndReturn` | `workspaceId` set (unchecked input) or `workspace: { connect }` (checked input) |
| `upsert` | both of the above |
| any write that sets another `workspaceId` / `workspace` | **throws** |
| no workspace in the context | **throws `WorkspaceScopeError`** (500, logged) — fail closed |
| an unknown operation, or a model in neither list | **throws** |

Exceptions, all explicit: `AuditLog` creates outside a workspace are written with `workspace_id NULL`;
`File` reads add `OR (workspace_id IS NULL AND entity_type = 'user_photo')`; the owner bypass (§4).
Global models pass through. Every Prisma model must be listed as scoped or global — a unit test fails
on a new, unclassified model.

**Lazy queries.** Prisma queries start when awaited. `runInWorkspace` / `runWithoutWorkspace` /
`crossWorkspace` start a returned query (`.then`) while their store is active (unit-tested), so a
query never runs in the caller's context by accident.

**Users (global table) are filtered explicitly**: `workspaceUsersWhere(ws)` (live membership, or a
registration addressed to the workspace), `supervisorsOf(ws)`, `adminsOf(ws)` (+ owners), `memberOf(ws)`
— in user lists, supervisor pickers, task/team assignee checks, mentions, notifications to admins,
imports, workload, card printing for supervisors, OCR user suggestions, org position holders,
project access, time entries, photo access.

### Raw SQL sites (every one carries the workspace itself)

| File | Statement | Change |
|---|---|---|
| `projects/hub.service.ts` | `hubStatsSql`, attachments count/page (`taskScopeSql`, `ATTACHMENT_FROM`) | `t.workspace_id = $ws AND p.workspace_id = $ws`; joins on `workspace_id`; no workspace → `FALSE` |
| `projects/project-store.ts` | `unreadCountsSql` | `c.workspace_id = $ws`, joins on `workspace_id`; no workspace → `FALSE` |
| `projects/project-store.ts` | `lockAndLoad` `SELECT … FROM projects … FOR UPDATE` | `AND workspace_id = $ws` |
| `violations/violation-stats.ts` | `violationWhereSql` (all 10 dashboard queries), `FROM`, team/member joins | `v.workspace_id = $ws` first; joins on `workspace_id`; no workspace → `FALSE` |
| `violations/violations.service.ts` | `snapshotSql` | `m.workspace_id = $ws`; supervisor sub-selects joined on `workspace_id` |
| `violations/violation-assign.service.ts` | 2 × `SELECT … FROM violations … FOR UPDATE` | `AND workspace_id = $ws` |
| `violations/violation-files.service.ts` | `SELECT … FROM violations … FOR UPDATE` | `AND workspace_id = $ws` |
| `teams/teams.service.ts` | `lockTeam` | `AND workspace_id = $ws` |
| `photos/photos.service.ts` | `SELECT … FROM team_members … FOR UPDATE` | `AND workspace_id = $ws` (the `users` lock stays global) |
| `org/org.service.ts` | `pg_advisory_xact_lock(hashtext('nuzli.org_structure'))` | key per workspace |
| `users/last-admin.ts` | `lockActiveAdmins` | ADMIN memberships of the workspace and their users (`FOR UPDATE OF m, u` — security review L3) |
| `prisma/prisma.service.ts` | `SELECT 1`, `pg_roles` check, the `set_config` GUC | no business table |

### Background jobs

Each runs every workspace explicitly (`PrismaService.forEachWorkspace`), its own context per
workspace: import-preview cleanup, task due/overdue/deadline reminders, pending-upload cleanup, orphan
files, violation photo retention (per-workspace setting and audit). Security review M4: retention and the
cleanups also visit ARCHIVED workspaces (`{ includeArchived: true }`); reminders and OCR stay on active ones. The OCR queue claims jobs
workspace by workspace (`runWithoutWorkspace` → per-workspace `claim`) and processes each job inside the
violation's workspace; the start-up sweep visits every workspace. The national-ID key-rotation CLI
uses the documented maintenance bypass (§4).

## 3. Row Level Security (ADR-143)

- `ENABLE` + **`FORCE`** row level security on the 45 tables, one policy each:
  `USING/WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass())`
  (`audit_log`: `IS NOT DISTINCT FROM`, so account-level rows are visible only outside any workspace;
  `files`: plus global user photos).
- `nz_current_workspace()` = `NULLIF(current_setting('app.workspace_id', true), '')::uuid`;
  `nz_rls_bypass()` = `current_setting('app.bypass_rls', true) = 'on'` **and** the role is not `nuzli_app`
  (nor a member of it) — security review L2, ADR-165: the API role can never bypass RLS, even by setting the GUC.
- `workspace_id DEFAULT nz_current_workspace()` on every scoped table: nested Prisma creates and raw
  inserts get the session workspace; without one the insert fails (NOT NULL / RLS).
- **How the GUC is set (performance + pooling).** No session-level `SET` (Prisma pools connections).
  Every statement that may touch a scoped table runs in a transaction whose first statement is
  `SELECT set_config('app.workspace_id', $ws, true), set_config('app.bypass_rls', $b, true)`:
  stand-alone operations become a 2-statement batch transaction; `$transaction([...])` gets the
  set_config prepended; `$transaction(fn)` runs it first on the interactive transaction. Global
  reads without relations skip it (no extra round trip for the per-request user load).
  Cost: one extra statement per scoped query (+ BEGIN/COMMIT for stand-alone ones). Accepted for
  this system's load; a per-request interactive transaction was rejected (holds a connection through
  S3/PDF calls, 5 s default timeout, error-aborted transactions break services that catch and retry).
- **Two database roles.** The migrator/owner (`DATABASE_URL`, runs `migrate deploy` + seed) and
  **`nuzli_app`** (created by the migration: `NOLOGIN NOSUPERUSER NOBYPASSRLS`, DML on all tables,
  default privileges for future tables, no access to `_prisma_migrations`). The deployment gives it a
  password once: `ALTER ROLE nuzli_app LOGIN PASSWORD '…';` and sets
  `APP_DATABASE_URL=postgresql://nuzli_app:…@db:5432/nuzli`; `docker-entrypoint.sh` then runs the server
  with it. Superusers and BYPASSRLS roles ignore RLS: the API logs a warning at start-up when its role
  bypasses RLS, and refuses to start with `DB_REQUIRE_RLS=true`.
- FORCE applies to the table owner too: a later **data** migration run by a non-superuser owner must
  start with `SET LOCAL app.bypass_rls = 'on';` (documented in the migration header).
- What RLS is and is not: a second line of defence against a missing filter in the API (a bug). Since
  ADR-165 the API's own role cannot switch it off (an injected `SET app.bypass_rls = on` is ignored for
  `nuzli_app`); the bypass is only for maintenance connections as the migrator.

## 4. Owner bypass (ADR-145)

`PrismaService.crossWorkspace(actor, reason, fn)` — the only cross-workspace path: the actor must be an
OWNER, a reason is required, an `owner.cross_workspace_access` audit entry (workspace NULL, reason,
ip, request id) is written **before** `fn` runs; inside `fn` the scoping is off and `app.bypass_rls = on`
for that context only — which, since ADR-165, spans workspaces only on a maintenance connection (not as
`nuzli_app`, where RLS keeps the bound workspace). Round 1 has no HTTP route using it (owners work inside one workspace at a time,
like admins); round 2's owner screens will. Operator CLIs (national-ID key rotation) use an explicit
`bypass: true` maintenance store and are never reachable from HTTP.

## 5. Cross-workspace guards in the database (ADR-144)

- Constraint trigger `nz_same_workspace_trg` (AFTER INSERT/UPDATE, end of statement, `SECURITY DEFINER`)
  on all 45 tables, with the reference columns as arguments: **55 reference columns** must point to a
  row of the same workspace (e.g. `tasks.project_id`, `tasks.parent_id`, `violations.member_id`,
  `card_print_items.member_id`, `team_members.photo_file_id`…), and `workspace_id` can never change.
  Composite FKs were not used: Prisma's relations stay on `id`, cascades stay simple, and the trigger
  covers polymorphic and self references uniformly.
- `files.entity_id` (polymorphic: violation / task / member photo) checked by `nz_files_entity_workspace_trg`.
- Users referenced by business rows must be members of that workspace: `tasks.assignee_id` and
  `teams.supervisor_id` / open `team_supervisors.user_id` → a **SUPERVISOR membership** of the row's
  workspace (the old role triggers, rewritten); `org_positions.holder_user_id`, `project_access.user_id`
  → any live membership or an owner.
- A violation answers `NZ_CROSS_WORKSPACE` (SQLSTATE 23514); the API maps it to **404 NOT_FOUND**.

## 6. Sessions (ADR-146)

- Login by **username**, e-mail or mobile. The response lists the workspaces the user can enter
  (owners: every active one) and binds the session to the only one when there is exactly one.
- The access JWT carries `wid` (no role: roles always come from the database). The guard reloads the
  user, then `WorkspaceAccessService.resolve(user, wid)`: unknown workspace or no live membership →
  403 `WORKSPACE_FORBIDDEN`; archived → 403 `WORKSPACE_ARCHIVED`. A token without `wid` (pre-A12, or
  before choosing) is bound to the user's only workspace when there is exactly one; otherwise only
  `@WorkspaceOptional()` routes answer (`/auth/me`, `/auth/workspaces`, `/auth/switch-workspace`,
  `/auth/change-password`, `PATCH /me`, `/system/info`) and every other route answers
  403 `WORKSPACE_REQUIRED`.
- `POST /auth/switch-workspace {workspaceId}` → membership check (owners: any active workspace) →
  the presented refresh family is revoked → a new session (access + refresh cookie) bound to the
  target → audited `auth.workspace_switched` **in the target workspace**.
- Refresh keeps the workspace stored on the refresh token; if it was lost (membership removed,
  workspace archived) the refreshed session falls back to the only workspace, or none.
- `GET /system/info` → `{ workspaceCount, singleWorkspace, workspaces? }` (list for owners only);
  `GET /public/workspaces` → `[{ id, name }]` of active workspaces (registration).

## 7. Permissions (ADR-146)

The matrix is unchanged and evaluated **per active workspace**: `AuthUser.role` = the strongest live
membership role there (ADMIN > SUPERVISOR > MONITOR), `roles` = all of them (`can()` grants the union),
OWNER = everything. ASSISTANT and MEMBER grant nothing until round 2. Every data-scoped rule
(supervisor's teams/tasks, monitor's violations, visibility) runs on workspace-filtered rows, so it
also requires the same workspace. Last-admin protection is per workspace; only owners act on owners.
Suspending a user suspends their memberships in the active workspace (and the account only when it has
no live membership elsewhere — the pre-A12 behaviour in single-workspace mode).

## 8. Migration `20261023000000_a12_workspaces` (one transaction)

**Back up first** (`docs/backup-restore.md`: `scripts/backup.sh`, then verify the dump). Steps:

1. helper functions, enums, `workspaces`, `workspace_memberships`;
2. snapshot `count(*)` of the 45 tables and `users` into a temp table;
3. create «إدارة المشاريع» (code `projects`); add `workspace_id` to the 45 tables, backfill every row
   (the `audit_log` append-only trigger is paused for this one UPDATE), user photos → NULL,
   `NOT NULL` + `DEFAULT nz_current_workspace()` + index + FK;
4. per-workspace unique indexes (table in §1);
5. accounts: usernames from the e-mail local part (lower case, `[a-z0-9._-]`, letter first, 3–32,
   de-duplicated with a numeric suffix in creation order); ACTIVE/SUSPENDED users → one membership of
   their role; PENDING/REJECTED → `requested_workspace_id`; the bootstrap admin (its
   `user.bootstrap_admin_created` audit row) → OWNER, else the earliest active admin; live refresh
   tokens bound to the workspace;
6. guard triggers (§5);
7. **verification DO block**: per table, rows after = rows before and none outside «إدارة المشاريع»
   (user photos excepted), users unchanged, every approved account has its membership, an owner exists —
   any mismatch `RAISE EXCEPTION` → the whole migration rolls back. Each table's before/after count is
   printed as a NOTICE;
8. RLS + policies; role `nuzli_app` and its grants (skipped with a NOTICE if the migrator may not
   create roles — then create it by hand).

The seed afterwards: per active workspace default settings/palette/calendar/card sizes/templates;
bootstrap owner (username `BOOTSTRAP_OWNER_USERNAME`, e.g. `mmansary`, password from
`BOOTSTRAP_ADMIN_PASSWORD`, must change at first login) only on an empty system; accounts named in
`BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_USERNAME` promoted to OWNER (audited `user.owner_promoted`) —
**only while no owner exists** (security review H1, ADR-163); a lost owner is restored with
`npm run owner:recover -- --username …` (server access).

## 9. Risks and how each is tested

| Risk | Test |
|---|---|
| A route returns or changes another workspace's data | `test/isolation/isolation-*.pg-spec.ts`: **every route** (203, read from Nest metadata) × 4 identities of A (admin, supervisor, monitor, owner working in A), aimed at B (path ids; A parent + B child for nested routes; B ids in bodies and filters): 840 probes; no B id/text in any response (JSON, CSV, XML, **xlsx parsed cell by cell**); 4xx whenever B is targeted (each documented exception named); positive controls on A; **B's 45 tables, accounts and memberships hashed before/after: identical** |
| A new route ships without an isolation case | coverage test: a route missing from `test/isolation/cases.ts` fails the suite |
| The app layer alone is wrong | the same suite runs as **superuser (RLS bypassed)**; **mutation gate** (security review M5, ADR-166): `npm run test:isolation:mutation` removes the filter of each of the 47 models in turn — the suite must fail for every one (47/47; the HTTP probes alone catch 26) |
| RLS missing or bypassable | `test/pglite/rls.pg-spec.ts`: FORCE + policy on all 45; `nuzli_app` no superuser/BYPASSRLS; no rows without a workspace; exactly A's rows in A for all 45; cross-workspace insert refused, update/delete affect 0 rows; default workspace; audit NULL rows; owner bypass |
| A row references another workspace | same file: **every one of the 55 guarded reference columns** updated to a B row → refused; `workspace_id` immutable on all 45; insert path; polymorphic `files.entity_id`; user membership checks |
| The migration loses or misplaces data | `test/pglite/migration.pg-spec.ts`: chain up to the last pre-A12 migration, every table populated twice + edge cases, then A12: counts equal for **every** table, all rows in «إدارة المشاريع», memberships = roles, bootstrap admin = OWNER, usernames valid/unique/de-duplicated, sessions bound, NOTICEs printed, RLS on, guards on |
| Scoping silently skipped | `src/prisma/scoping.spec.ts`: every model classified (45 + 5), every operation rewritten, fail-closed on missing context/unknown operation/foreign workspace id, lazy query runs in its own context |
| Session/workspace mistakes | `test/isolation/workspace-session.pg-spec.ts`: single-workspace mode, username login, `wid` binding, forged `wid`, legacy token, switch (403 for non-members; owner allowed; refresh keeps; old family revoked; audited in target), dual roles across workspaces, lost membership / archived workspace, registration by workspace and its notifications, owner escape hatch, jobs per workspace |

All of it runs in `npx jest` on PGlite (PostgreSQL 17 in WebAssembly, pgcrypto + btree_gist from its
contrib bundle) — no Docker. PGlite runs as a superuser; the RLS runs switch to `nuzli_app` with
`SET ROLE`. Harness notes: PGlite is loaded with Node's own `require` (custom Jest environment
`test/support/pglite-env.js`), and `uuid[]` columns are mapped for `pglite-prisma-adapter` 0.3
(test-only).

## 10. Not yet isolated / open items (round 2 or deployment)

Nothing in the API serves or changes data across workspaces. Open items:

1. ~~Deployment must set `APP_DATABASE_URL`~~ — **done in round 2** (ADR-152, `docs/deployment-rls.md`): env
   examples carry both URLs, the seed gives `nuzli_app` its LOGIN password, `docker-compose.prod.yml` sets
   `DB_REQUIRE_RLS=true`.
2. ~~Owner screens~~ — **API done in round 2** (ADR-148): owners, workspaces, admins, summaries. Owners act
   on another workspace inside that workspace's context (scoped + RLS + audited there), not through the
   bypass; the escape hatch stays unused by HTTP.
3. ~~Assistants and project participants~~ — **done in round 2** (ADR-150, ADR-151, `docs/a12-roles.md`);
   two new scoped tables (`project_participants`, `member_requests`) → **47** workspace-scoped tables, all
   with the three layers; the isolation suite now probes 235 routes with five identities (an assistant
   with every module and a monitor who is a project participant added) — 1,221 probes per run.
4. ~~Adding an EXISTING user~~ — **done in round 2** (`POST /workspaces/:id/members`, ADR-149).
5. The web app (workspace picker/switcher, workspace name under the logo, username login) — a later round;
   the API is backward compatible (single-workspace mode looks exactly as before).
6. `test/int` (Testcontainers) suites were adapted but not run here (no Docker on this machine).

## 11. Security review A12 (2026-10-20) — what changed

`docs/security-review-2026-10-A12.md` (status table at its top) and ADR-162 … ADR-167. Business-data
isolation was found sound; the fixes are in the global layer around it:

- **Identity is global, so it is guarded globally:** suspension origin (`users.suspended_globally`, H2),
  the profile photo under the account-edit rule (M2), account-level audit for owners' account, owner and
  workspace actions with an owners-only read path (`GET /audit?scope=account`; the scoping layer allows
  AuditLog READS outside a workspace for owners only, filtered to `workspace_id IS NULL`) (M1), a lookup that
  reveals nothing about other workspaces and a registration that does not reveal taken usernames (L1),
  user rows locked in the last-admin check (L3).
- **Side effects:** `notify()` keeps only live members (or owners) of the active workspace (M3); retention
  and cleanups include archived workspaces (M4).
- **Deployment:** owner promotion from the environment only on the first boot, recovery by CLI (H1); the
  RLS bypass is tied to the role (L2, migration `20261025000000_a12_security_review`).
- **Device (web):** unsynced violations are per workspace and never wiped by a switch (H3/L4, ADR-162).
- **Tests:** `test/isolation/a12-security-review.pg-spec.ts` ports every reproduction of the reviewer;
  the isolation suite gained a sixth identity (roles in A and B), every `/reference/:kind`, real settings
  keys, and a model-by-model probe; `test/isolation/mutation-check.ts` is the 47-model gate.

---

## ملخّص بالعربية

**المبدأ:** كل صفّ عمل في النظام يحمل رقم قسمه (`workspace_id`)، وهوية الشخص وحدها عامة. الدخول إلى
قسم يمرّ بعضويةٍ فيه (مدير نظام، مشرف، مشرف مراقبة…)، والمالك يدخل كل الأقسام.

**ثلاث طبقات عزل مستقلة:**
1. **طبقة التطبيق:** كل استعلام على جدول عمل يُضاف إليه شرط القسم آليًّا، وأي استعلام بلا قسم يُرفض
   (يفشل مغلقًا)، ولا يمكن كتابة رقم قسم آخر. الاستعلامات اليدوية (١١ ملفًّا) تحمل شرط القسم صراحةً.
2. **قاعدة البيانات (RLS):** ٤٥ جدولًا مقفلة بسياسة «صفوف القسم الحالي فقط» حتى على مالك الجداول،
   والخادم يتصل بدور `nuzli_app` الذي لا يتجاوزها.
3. **حرّاس الربط:** لا يمكن لصفّ أن يشير إلى صفّ من قسم آخر (٥٥ عمود ربط)، ولا يتغيّر قسم صفّ أبدًا،
   ولا يُسند عمل لمستخدم ليس عضوًا في القسم.

**الترحيل:** يُنشئ قسم «إدارة المشاريع» وينقل إليه كل البيانات في معاملة واحدة، ويتحقّق بنفسه من عدد
صفوف كل جدول قبل وبعد، ويتراجع كليًّا عند أي اختلاف. **خذ نسخة احتياطية قبل التشغيل.** المديرون
الحاليون صاروا أعضاء بصفة «مدير نظام» في القسم، ومدير التأسيس صار «مالكًا»، ولكل حساب اسم مستخدم.

**الجلسة:** الدخول باسم المستخدم أو البريد أو الجوال؛ صاحب القسم الواحد يدخله مباشرة؛ صاحب أكثر من
قسم يختار ويبدّل (`switch-workspace`) بجلسة جديدة مسجَّلة في سجل التدقيق. ما دام في النظام قسم واحد
فهو يعمل تمامًا كما كان.

**التحقّق:** مجموعة اختبارات تمرّ على **كل** نقطة في الواجهة البرمجية (٢٠٣) بأربع هويات من القسم «أ»
موجّهةً إلى بيانات القسم «ب» (٨٤٠ محاولة)، مرةً بالطبقات كلها ومرةً بطبقة التطبيق وحدها؛ لا تسرّب
شيء، وبيانات «ب» لم تتغيّر بايتًا واحدًا. وأي نقطة جديدة بلا اختبار عزل تُفشل المجموعة.

**المتبقّي:** ضبط `APP_DATABASE_URL` عند النشر لتفعيل RLS فعليًّا، وشاشات المالك والمساعدين وإدارة
المستخدمين (الجولة الثانية)، ونقل الواجهة.
