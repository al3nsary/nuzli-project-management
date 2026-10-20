# Security review — A12 workspace isolation and permission model (2026-10-20)

> Independent reviewer (did not build A12). Role: `.claude/agents/security-privacy.md`.
> Owner's instruction: «تأكد من العزل الصحيح… تداخل المعلومات أو فقدانها بين الأقسام مصيبة».
> Scope: `PROMPT.md` §18 A12, `docs/a12-isolation-design.md`, `docs/a12-roles.md`, `docs/a12-web.md`,
> ADR-142…161, migrations `20261023000000_a12_workspaces` and `20261024000000_a12_round2`, the
> scoping layer, auth/session/switch, users/accounts/memberships/owners/workspaces, photos/files,
> notifications/audit, imports, OCR queue, background jobs, every raw-SQL site, the web client's
> session/switch/offline code, and the demo backend (`apps/web/src/api/demo`).
> Method: code reading, plus throwaway reproductions against the real AppModule on PGlite with RLS on
> (`nuzli_app`), throwaway vitest runs against the real DemoApi, and mutation testing of the suites.
> No repository file was changed except this report. The scratch tests are listed in §5.

## Status (2026-10-20) — every finding fixed, server and demo alike

Fixed in commit `__COMMIT__` (ADR-162 … ADR-167). Each fix has a regression test that replays the
reviewer's scenario (ported from §5's scratch specs) and asserts the fixed behaviour.

| # | Status | Fix | Regression test |
|---|---|---|---|
| H1 | **Fixed** | `promoteOwnersFromEnv` acts only while NO owner exists (first boot); warns when a listed identifier is not an owner. Owner recovery is an operator CLI with server access: `npm run owner:recover -- --username … [--reset-password] [--dry-run]` (`src/scripts/recover-owner.ts`, audited `owner.recovered` at account level). ADR-163 | `apps/api/test/isolation/a12-security-review.pg-spec.ts` › H1 (owner removed → restart → still USER; admin takes the freed username → restart → USER; CLI restores, resets, refuses PENDING) |
| H2 | **Fixed** | `users.suspended_globally` (migration `20261025000000_a12_security_review`, back-filled from the audit); a non-owner's workspace reactivate answers 403 `SUSPENDED_BY_OWNER` and changes nothing; a cascade-only suspension is still lifted by the workspace admin. Demo: same flag, same answer, and `reactivate` refuses an owner target (G2). ADR-164 | API › H2 (R1 + cascade + cascade→global); demo `DemoApi.securityA12.test.ts` › G1, G2, cascade |
| H3 | **Fixed** (non-destructive design) | Outbox items carry `workspaceId`; the sync engine sends only the session workspace's items (none before a workspace is chosen); `enter()` never wipes the outbox — only the cache, the print run and (on a workspace change) the roster; «اختر القسم» shows a badge per workspace and a notice, a switch shows where items wait. Sign-out still warns with the count. ADR-162 | `apps/web/src/features/workspaces/workspaces.test.tsx` › H3 (re-login → pick A → nothing deleted; switch → A's item waits; engine per workspace, legacy adoption, nothing without a workspace); headless Chrome (below) |
| M1 | **Fixed** | Owners' account edits, username/password, global suspend/reactivate, account creation, owners and workspace lifecycle are account-level entries (workspace NULL) in the same transaction; memberships stay in their workspace; owners read them with `GET /audit?scope=account` (scoping allows only that, owners only); the audit page has an owner toggle. Demo identical. ADR-164 | API › M1 (R3 + workspace lifecycle); `src/prisma/scoping.spec.ts`; demo › M1 |
| M2 | **Fixed** | Someone else's `user_photo` (presign, confirm, remove) follows the account-edit rule (`assertAccountWithinReach`, shared with PATCH): `USER_IN_OTHER_WORKSPACES` / `FORBIDDEN` for an owner. Demo resolves the target through live memberships (G3–G5). ADR-164 | API › M2 (R2); `src/photos/photos.service.spec.ts` › M2; demo › G3, G4, G5 |
| M3 | **Fixed** | `notify()` keeps only ACTIVE accounts with a live ACTIVE membership of the workspace (or owners) at send time — every notification and e-mail goes through it; registration outcomes still reach the applicant. Demo identical. ADR-167 | API › M3 (R4 + positive control); demo › M3 |
| M4 | **Fixed** | `forEachWorkspace(…, { includeArchived: true })` for retention, pending uploads, orphan files and import previews. (The demo has no retention job.) ADR-167 | API › M4 (R6: the archived workspace's ID card is purged) |
| M5 | **Fixed** | Sixth identity with roles in A and B (B rows keyed by them), every `/reference/:kind`, real settings keys (A reads its own), B account hash covers the dual member/photo/flag, model-by-model probe (API: 47 models; demo: every scoped Dexie table, B rows in each). Mutation gates committed: `apps/api` `npm run test:isolation:mutation` (`test/isolation/mutation-check.ts`) and `apps/web` `npm run test:isolation:mutation` (`scripts/isolation-mutation.mjs`). ADR-166 | **API 47/47 mutants killed** (HTTP probes alone: 26/47, was 21); **demo 34/34 scoped tables killed** |
| L1 | **Fixed** | Add-member lookup: rate limited; non-ACTIVE → 404 like unknown (non-owners); `DUAL_ROLE_CONFIRM_REQUIRED` = this workspace's roles + `otherWorkspaces: true`; e-mail only in the 201 of a confirmed add. Registration: a taken username gets the nearest free variant and the same `PENDING` answer (approval e-mail names it). Demo identical. ADR-164 | API › L1 (R5 + registration); `a12-round2.pg-spec.ts`; demo › L1 |
| L2 | **Fixed** | `nz_rls_bypass()` = GUC on **and** the role is not `nuzli_app` (nor a member): the API role can never bypass RLS; maintenance CLIs connect as the migrator. ADR-165 | `apps/api/test/pglite/rls.pg-spec.ts` › L2 (nuzli_app and a member role with the GUC → own workspace only; a maintenance role → both) |
| L3 | **Fixed** | `lockActiveAdmins` locks `FOR UPDATE OF m, u` (the users rows too); the last-owner check already locks users. ADR-164 | `apps/api/src/users/last-admin.spec.ts` |
| L4 | **Fixed** (with H3) | Roster, types and form settings keyed by workspace (`rosterWorkspaceId`), dropped on a workspace change and when a lost workspace re-binds the session; outbox items tagged and synced per workspace. ADR-162 | `workspaces.test.tsx` (roster dropped, outbox kept) |

Also fixed with this round: the generated project cover takes the first letters of the first two meaningful
words (no «تإ» for «تركيب نظام ري ذكي — مبنى الإدارة (تجريبي)» → «ت‌ن»), without an underline
(`features/projects/cover.test.tsx`).

Verification (2026-10-20): 
- `apps/api`: `npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest && npx nest build` → **56 suites, 708 tests passed** (isolation: 236 routes × 6 identities, 1,512 probes per run, with and without RLS); `npm run test:isolation:mutation` → **47/47** (control green).
- `packages/shared`: `npx vitest run` → 99 passed; build OK.
- `apps/web`: `npx tsc --noEmit && npx vitest run && node scripts/check-i18n.mjs && npx vite build && npx vite build --mode demo` → **61 files, 664 tests passed**, i18n clean, both builds OK; `npm run test:isolation:mutation` → **34/34** (control green).
- Headless Chrome on the demo (390×844): monitor1 with roles in «إدارة المشاريع» and «قسم الصيانة», one pending offline violation recorded in «إدارة المشاريع» → sign-in → «اختر القسم» shows «على هذا الجهاز مخالفات سجّلتها ولم تصل إلى الخادم بعد. هي محفوظة ولن تُحذف…» and «مخالفة واحدة لم تُرسل» on that workspace's card → picking it keeps the item (still `pending`, its workspace) and lists it under «بانتظار المزامنة» → switching to «قسم الصيانة» keeps it and the home says «على هذا الجهاز مخالفة واحدة لم تُرسل من قسم «إدارة المشاريع»؛ محفوظة وتُرسل حين تدخل ذلك القسم.» Project cards: «تركيب نظام ري ذكي — مبنى الإدارة (تجريبي)» → «ت‌ن», «تأهيل حديقة الحي الشمالي» → «ت‌ح», «حملة النظافة الموسمية» → «ح‌ن», «مشروع الأداء — 2000 مهمة» → «أ‌م»; no underline (the card link no longer propagates its decoration).

---

## Verdict

**The isolation of business data between workspaces holds.** I could not make any route return,
change or delete another workspace's business rows. That covers path, query and body ids, nested
reads and writes, raw SQL, exports, imports, jobs and the OCR queue. Three layers stop it, and each
one works on its own: the Prisma scoping extension, RLS with FORCE, and the same-workspace triggers.
Every foreign-key column of the 47 scoped tables is guarded. The existing suites are green: 8 files
and 108 tests on the API, 16 files and 198 tests in the web demo.

The weak points are in the **global layer around the data**:

- **Identity.** One account is shared by every workspace, so a workspace admin can affect it beyond
  their own workspace: lifting an owner's suspension, changing the profile photo.
- **Account-level audit.** Owner actions on accounts are written into whichever workspace the owner
  happens to be bound to, so another workspace's admins can read them.
- **Deployment-time owner promotion.**
- **The device.** The offline queue of unsynced violations can be wiped silently.

None of these leaks one workspace's projects, teams or violations into another. Several of them
cross the boundary through the shared account, and one is a silent data-loss path.

## 1. Findings

| # | Severity | Finding | Where |
|---|---|---|---|
| H1 | **High** | `BOOTSTRAP_OWNER_*` promotion runs at every start: a removed owner comes back, and a freed owner username or e-mail taken by a workspace admin becomes an OWNER | `apps/api/src/seed/seed.ts:304-329`, called at `:109`; `apps/api/docker-entrypoint.sh:17` |
| H2 | **High** | A workspace admin lifts an owner's **global** suspension: the account becomes ACTIVE and the person is back in every other workspace | `apps/api/src/users/users.service.ts:386-397`, `users.controller.ts:171-183`; demo `apps/web/src/api/demo/DemoApi.ts:2029-2043` |
| H3 | **High** (data loss) | The web wipes the offline outbox (unsynced violations with their ID photos) when a workspace is entered from «اختر القسم», with **no warning**. This happens after every re-login of a multi-workspace user and after a lost workspace | `apps/web/src/features/workspaces/useWorkspaceSwitch.ts:32-40`, `WorkspacePickerPage.tsx:48, 87` |
| M1 | Medium | An owner's account edits and account creation are audited in the owner's **active** workspace. A B-only person's e-mail, mobile, name and masked ID become readable in A's audit log. This contradicts ADR-148 | `apps/api/src/users/accounts.service.ts:167, 215, 235, 263, 326, 347` |
| M2 | Medium | A workspace admin can replace or remove the **global** profile photo of a person who also belongs to other workspaces (refused for every other account edit). In the demo this extends to owners and to former members | `apps/api/src/photos/photo-policy.ts:20-24`, `photos.service.ts:96-104`; demo `apps/web/src/api/demo/photos.ts:127-133, 250-256` |
| M3 | Medium | Task reminders e-mail a person who was **removed** from the workspace (former assignee or project owner). Nothing in `notify()` checks membership | `apps/api/src/projects/task-due.service.ts:117-128, 147-161`; `notifications/notifications.service.ts:57-84` |
| M4 | Medium (PDPL) | Retention and cleanup jobs skip **archived** workspaces. ID-card photos and encrypted OCR results there are kept past `VIOLATION_PHOTO_RETENTION_DAYS` | `apps/api/src/prisma/prisma.service.ts:191-204`; `violations/violation-files.service.ts:160-166` |
| M5 | Medium (tests) | The suites miss real gaps. Mutation testing (§3) shows that removing the workspace filter for **many models** goes unnoticed. The fixture has no person with roles in two workspaces, and `/reference/:kind` is probed only with `departments`. The same holds in the demo for `notifications` and `participants` | `apps/api/test/isolation/cases.ts:90-91`, `test/support/workspace-fixture.ts`; `apps/web/src/api/demo/isolation.test.ts` (IDENTITIES) |
| L1 | Low | Account lookup and enumeration. `POST /workspaces/:id/members` resolves **any** account by username, e-mail, mobile or national ID. It answers 404 or 409 with the person's roles and statuses elsewhere, and on confirm returns their e-mail. `POST /auth/register` reveals taken usernames to anonymous callers | `apps/api/src/users/memberships.service.ts:138-173, 256`; `auth/auth.service.ts:326-328` |
| L2 | Low | The RLS bypass is a GUC that any SQL running as `nuzli_app` can set itself, so one SQL injection would bypass RLS completely | migration `20261023000000_a12_workspaces/migration.sql:30-32` |
| L3 | Low | LAST_ADMIN race: `lockActiveAdmins` locks only the membership rows (`FOR UPDATE OF m`), not `users`. A concurrent global suspension of one admin and a workspace suspension of the other can leave a workspace with no active admin | `apps/api/src/users/last-admin.ts:11-18` |
| L4 | Low | After a lost workspace (`WORKSPACE_LOST` → refresh re-binds to the fallback workspace) the web clears the query cache but **not** the offline roster or outbox. A's workers stay on the device while working in B, and outbox items carry no workspace | `apps/web/src/app/App.tsx:93-112`; `features/violations/offline/outbox.ts` |

### H1 — Owner promotion from the environment at every start

**What.** The seed runs at every container start (`docker-entrypoint.sh:17`). It calls
`promoteOwnersFromEnv`, which promotes **every ACTIVE `USER` account whose e-mail or username is
listed** in `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_USERNAME`. The documented deployment sets
`BOOTSTRAP_OWNER_USERNAME=mmansary`.

**Reproduced** (`owner-env.review-spec.ts`, both tests pass):

1. Owner 2 removes `mmansary` as owner (204, the account is now `USER`). After the next start
   (`runSeed`) it is **OWNER** again, so an owner removal does not stick for a listed account.
2. The real owner's username changes (usernames may change at any time). A workspace ADMIN then
   creates a MONITOR account with username `mmansary` (201). After the next start that account is
   **OWNER**: it holds every right in every workspace, including the owner bypass. A self-registration
   named `mmansary` that an assistant with `registrations:edit` approves gives the same result. So
   does an admin changing an A-only account's e-mail to a listed `BOOTSTRAP_OWNER_EMAIL` that the owner
   no longer uses.

**Fix.** Treat the env list as a **first-boot bootstrap only**:

- promote only while the system has no owner (the same condition as `bootstrapAdmin`); or
- record the promoted user ids once (e.g. a `settings`-like global row or the
  `user.owner_promoted` audit) and never promote a different account for the same identifier;
- never re-promote an account that has an `owner.removed` entry;
- log a warning when a listed identifier matches no owner.

Add a test: remove the owner → run the seed → still `USER`; create a username from the list → run
the seed → still `USER`.

### H2 — A workspace admin undoes an owner's global suspension

**What.** `UsersService.reactivate` runs in the admin's workspace. `displayStatus` returns the
account status when the account itself is suspended, so the call passes the `SUSPENDED` check, and
then `if (before.status === 'SUSPENDED') user.update({ status: 'ACTIVE' … })` reactivates the
**account**. The account status does not record whether an owner suspended it everywhere
(`scope: 'global'`, owner-only per ADR-149) or whether it is a cascade from the last workspace
suspension.

**Reproduced** (`findings.review-spec.ts` R1). X is MONITOR in A and ADMIN in B. The owner calls
`POST /users/X/suspend {scope:'global'}`, then admin A calls `POST /users/X/reactivate {}`. The
answer is 200, the account is `ACTIVE`, and X logs in and switches into B. The demo has the same
flaw (subagent G1). In the demo a workspace admin can even reactivate a globally suspended **owner**
(G2): `reactivate` lacks the owner check that `suspend` has.

**Fix.**

- Store the origin of an account suspension, e.g. `users.suspended_scope`
  `GLOBAL | LAST_MEMBERSHIP` (or the suspending workspace id).
- In the workspace path, reactivate the memberships of that workspace. Set the account ACTIVE only
  when its suspension was the cascade from this workspace.
- For a `GLOBAL` suspension answer 403 `FORBIDDEN` to non-owners, or reactivate the memberships
  only and leave the account suspended.
- Demo: add `if (target.accountRole === 'OWNER' && actor.accountRole !== 'OWNER') fail('FORBIDDEN')`
  to `users.reactivate`.

Test: owner global suspend → admin reactivate → account still SUSPENDED (or 403).

### H3 — Unsynced violations are wiped without a warning

**What.** `useWorkspaceSwitch().enter()` always calls `wipeDevice()`, which runs
`clearOfflineData()` and clears `outbox` and `outboxFiles`, before switching. The top-bar switcher
warns first (`WorkspaceName.tsx:52-56`). **«اختر القسم» does not**: `WorkspacePickerPage` calls
`enter()` directly at line 87 (and auto-enters at line 48).

A multi-workspace monitor lands on that page every time they sign in again. That happens after the
refresh session expired during a long offline stint, after an admin set a new password, and after a
lost workspace. They then pick the **same** workspace they recorded in, and the device silently
deletes every unsynced violation and its ID-card and evidence photos. The server never saw those
records, so they cannot be recovered. This is the «فقدان المعلومات» the owner fears. It was verified
by code reading; the flow is deterministic.

**Fix.**

- Never delete unsynced items on a workspace change.
- Tag every outbox item (and the roster) with `workspaceId` at capture time. The sync engine sends
  only the items of the session's workspace and keeps the others until the user returns there.
- If wiping must remain, apply the `unsyncedCount()` confirmation to **every** `enter()` call (put it
  in the hook, not in one caller), and skip the wipe when the target equals the workspace the items
  were recorded in.

Add a web test: an outbox item exists → picker enter → item still there.

### M1 — Owner account changes land in another workspace's audit log

`AccountsService.update`, `changeUsername`, `setPassword`, `suspendGlobal`, `reactivateGlobal` and
the `user.created` entry of `create` write their audit rows with the request's store, i.e. in the
workspace the **owner** is bound to.

**Reproduced** (R3). The owner is bound to A and edits the e-mail and mobile of a B-only person, then
creates a B-only account. Admin A calls `GET /audit?entityType=user` and gets back the B person's old
and new e-mail and the new account's name, e-mail and masked ID (`audit rows for y: ['user.updated@A']`).

ADR-148 states "Owner changes are account-level audit entries (workspace NULL)". `OwnersService`
already does this with `runWithoutWorkspace`.

**Fix.** Write the account-level entries outside any workspace. Wrap them in
`runWithoutWorkspace(() => audit.log(…))`, or pass a NULL-workspace store so they commit in the same
transaction.

- **Keep in the workspace's audit:** membership changes (already done in the target workspace).
- **Make account-level:** the identity fields.
- **Owners need** a NULL-workspace audit view (e.g. `/audit?scope=account`, owner only).

### M2 — The global profile photo is writable by any workspace admin

`userPhotoWrite` allows `users.manageRoles` for **anyone**, and `assertCanWrite` checks only
`workspaceUsersWhere(active)`. The account rule of ADR-149 (admins only for users with no live
membership elsewhere, never owners) is not applied to the photo, yet the photo is a global file.

**Reproduced** (R2). For X (SUPERVISOR in A, ADMIN in B), admin A gets
`PATCH /users/X → 403 USER_IN_OTHER_WORKSPACES`, but:

- `POST /files/presign {entityType:'user_photo', entityId:X}` → 201;
- `DELETE /users/X/photo` → 204, and the photo is gone in B as well.

The photo is shown on cards and in B's screens. The demo has the same gap and goes further
(subagent G3–G5): owners and former members who now belong only to B are writable too, because
`photos.ts:129` resolves the target through the users view.

**Fix.** For `user_photo` writes by anyone other than the person, reuse
`AccountsService.assertMayEdit` on the server (and `assertMayEditAccount` in the demo). In the demo,
resolve the target with the live-membership lookup, never through the users view.

### M3 — Reminders reach people who left the workspace

The due, overdue and deadline reminders notify `task.assigneeId` and `project.ownerId` without
checking that they are still members. The same-workspace trigger checks membership only at
assignment time.

**Reproduced** (R4). A supervisor is assigned an overdue task in A, then their A membership is
removed (204). `TaskDueService.run()` in A then creates a `TASK_OVERDUE` notification for them. The
e-mail carries A's task and project names to a person who may now work only in B.

**Fix.** In `NotificationsService.notify`, filter `ids` to `memberOf(activeWorkspaceId())` ∪ owners
before creating rows or sending e-mail; this covers every caller. Optionally, unassign or flag tasks
when a SUPERVISOR membership ends.

### M4 — Archived workspaces escape retention

`forEachWorkspace` iterates over `status: 'ACTIVE'` workspaces only, and every job uses it.

**Reproduced** (R6). With retention set to 30 days, an old ID-card photo in A is purged; the same
photo in an archived workspace C is **not**. The photos, the encrypted OCR fields and any pending
uploads of an archived workspace stay forever. Archiving is the documented way to "close" a
workspace, so this is exactly where PDPL retention matters most.

**Fix.** Give `forEachWorkspace` an option `{ includeArchived: true }`. Use it for the retention,
pending-upload, orphan-file and import-preview jobs; keep reminders on ACTIVE only. Add a test.

### M5 — Gaps in the isolation suites (they would not catch some regressions)

See §3 for the app-layer mutation table. The surviving mutants are not exploitable today: those
models are reached only through already-scoped parents or by the caller's own user id, and the
triggers stop cross references. The suites are nevertheless the safety net for future changes, and
they would not catch a regression in these models.

Root causes:

1. **No person holds roles in both A and B in the fixture.** Every query keyed by `userId`
   (notifications, participations, team-supervisor peers, project access, comment reads, view
   preferences, time entries) is untested for cross-workspace rows. In the demo this is proven: with
   the `notifications` filter removed the suite stays green, while a dual-member scratch test fails
   and shows B's notification in A.
2. **Parameterised routes are probed with one value**: `/reference/:kind` uses `departments` only
   (`cases.ts:90`), so `job-titles` (and any other kind) has no probe.
3. **Child rows are reached through a scoped parent id.** Comments, labels, custom values, the
   checklist, baselines, violation files, responses, OCR and print items are always loaded through a
   parent id that has already passed a scoped lookup, so a missing filter on the child is never
   reached. The fixture's B setting uses a key that the API ignores (`nz_fixture_B`). That is why the
   `Setting` mutant survives, yet unfiltered real B settings (e.g. the retention days or the edit
   window) **would** silently override A's. Give the B fixture real setting keys with values
   different from A's.
4. Account-level side effects (H2, M2) are invisible to the "B unchanged" hash. That hash covers B's
   tables, accounts and memberships, but the probes never target a shared account.

**Fix.**

- Add a dual-member identity (roles in A and B, with B notifications, a B participation, a B team
  supervision and a B time entry) to both suites, probing from A.
- Iterate every `kind` value for `/reference/:kind`.
- Add probes for `reactivate`, the photo routes and `PATCH /users/:id` aimed at the dual member and at
  an owner.
- Keep the mutation check as a script that loops over all models (§5) and fails on a surviving mutant
  unless it is listed with a reason.

### Low

**L1 — account lookup.** `findAccount` is global by design (ADR-149: add an existing account), but it
exposes:

- **existence:** 404 vs 409, for any national ID or mobile;
- **roles and statuses elsewhere:** `details.roles`;
- **the e-mail:** in the 201 body, without the person's consent.

Fix: rate-limit the route and audit lookups. Return the same 409 body without the per-role details
to non-owners (only "has another role"). Consider requiring the exact identifier pair (e.g. username
plus mobile) for admins. The anonymous `USERNAME_TAKEN` is documented as acceptable; it should at
least be throttled like login.

**L2 — RLS bypass by GUC.** `nz_rls_bypass()` trusts `current_setting('app.bypass_rls')`, which any
session of `nuzli_app` can set (`SET app.bypass_rls = on`). The design accepts this for a compromised
process, but it also means one injectable raw query would defeat RLS completely. None exists today:
the only `$queryRawUnsafe` / `$executeRawUnsafe` calls are in the seed, with no user input. Fix: tie
the bypass to a role, e.g. `pg_has_role(current_user, 'nuzli_maint', 'MEMBER')` or a separate
BYPASSRLS maintenance role used only by the CLI. HTTP has no bypass route, so the API role does not
need the bypass at all.

**L3 — LAST_ADMIN race.** Use `FOR UPDATE OF m, u` (lock the users rows as well), or re-check the
count after the update.

**L4 — device content after a lost workspace.** On `WORKSPACE_LOST`, wipe the roster (not the
unsynced outbox; see H3) when the refreshed session's workspace differs from the previous one. Tag
outbox items with `workspaceId` and refuse to sync them under another workspace's session. Today the
server refuses them only because the violation type id does not exist in B.

## 2. Verified sound (what I checked, and how)

| Area | How verified | Result |
|---|---|---|
| Scoping extension | Read `scoping.ts`/`prisma.service.ts`: AND-only where rewrite, create/createMany/upsert stamping, foreign `workspaceId`/`workspace.connect` refused, unknown op/model throws, fail-closed without a store; Prisma 5 has no `updateManyAndReturn` (would throw anyway) | sound |
| Nested reads/writes | Global→scoped `include`/`select` (e.g. `USER_DTO_SELECT`, workspace `memberships`) — only global relations or the user photo; nested creates take `DEFAULT nz_current_workspace()`; nested `connect` to a B row is refused by the trigger (55+ columns) | sound; app layer does not filter nested relations — relies on triggers/RLS (documented) |
| FK guard completeness | Script `fkcheck.js` parses every migration: **every FK column of the 47 scoped tables that points to a scoped table is in its `nz_same_workspace_trg` argument list** (0 unguarded) | sound |
| Raw SQL | All 20 `$queryRaw/$executeRaw` sites read: each carries `workspace_id = $ws` or joins on it; no `$queryRawUnsafe` with input; locks `FOR UPDATE` filtered by workspace | sound |
| GUC / pooling | `set_config(…, true)` per transaction, prepended to every scoped statement/batch/interactive tx; `app.bypass_rls` explicitly set `off` each time, so a session-level value cannot leak between pooled requests | sound |
| RLS | ENABLE + FORCE + one policy on 47 tables (`rls.pg-spec.ts`); `nuzli_app` NOSUPERUSER NOBYPASSRLS, DML only (no TRUNCATE), `_prisma_migrations` revoked; PostgreSQL 16 (no `CREATE` on `public` for PUBLIC); SECURITY DEFINER functions pin `search_path = public`, trigger functions not callable directly | sound (see L2) |
| Sessions | Guard reloads user + memberships every request (R7: membership archived → next request 403 with a still-valid token); archived workspace → 403 and refresh tokens revoked; refresh re-checks and re-binds; switch to a non-member workspace → 403 (R7); `wid` is signed, roles never in the token | sound |
| Owner/admin powers | Workspaces/owners/`users/all`/global suspend owner-only; `inTargetWorkspace` refuses another workspace for non-owners; owners act inside the target store; assistants cannot obtain `users.edit`/`manageRoles`; approve limited to SUPERVISOR/MONITOR; LAST_OWNER locked | sound (except H1, H2) |
| Participants / project grants | `ProjectGrantGuard` resolves the project inside the workspace; dependencies validated against the project's own task set; mention list = admins/owners + scoped peers + participants with live membership | sound |
| Files | Presign/confirm by uploader; `getUrl` scoped (B file id → 404); user photos readable only for users of the active workspace; storage keys `folder/yyyy/mm/uuid` without workspace prefix — **not a problem** because every URL is issued after a scoped row lookup | sound (except M2) |
| Imports | Preview row scoped + `createdById`; commit with another workspace's `previewId` → expired/404; assignees re-validated with `supervisorsOf(ws)` | sound |
| OCR queue / jobs | Claim and process per workspace in its own store; sweep per workspace; reminders/cleanup per workspace | sound (except M3, M4) |
| Notifications | Rows scoped; recipients of admin/approver notifications computed per workspace (+ owners) | sound (except M3) |
| Migration | Single transaction; per-table before/after counts + "all in workspace" check + membership/owner checks raise and roll back; `migration.pg-spec.ts` green | sound |
| Demo (subagent) | Dexie DBCore middleware fail-closed, writes stamped/refused, session workspace re-checked per call, switch checked, owner gates; `npx vitest run src/api/demo`: 16 files / 198 tests pass; mutation of teams/violations/audit/colors/users-view caught | sound (except H2, M2, M5 parity) |

## 3. Mutation testing (app layer, RLS off — no repository file changed)

Each run used a scratch Jest file, `mut.review-spec.ts`. It `jest.mock`s `src/prisma/scoping.ts` so
that `scopeArgs` returns the arguments unfiltered for **one** model (reads, updates and deletes;
creates are still stamped), then runs the real `defineIsolationSuite({ rls: false })`. "Killed" means
the suite failed and named the leak. "Survived" means the suite stayed green.

| Result | Count | Models |
|---|---|---|
| **Killed** (suite fails, leak named) | 21 | `TeamColor`, `Team`, `TeamMember`, `Department`, `OrgUnit`, `OrgPosition`, `Calendar`, `CalendarException`, `Project`, `Task`, `Portfolio`, `TimeEntry`, `ViolationType`, `Violation`, `File`, `Logo`, `CardSize`, `CardTemplate`, `CardPrintBatch`, `AuditLog`, `MemberRequest` |
| **Survived** (suite stays green) | 26 | `TeamSupervisor`, `TeamSupervisorHistory`, `TeamMembership`, `JobTitle`, `ProjectAccess`, `TaskDependency`, `TaskComment`, `ProjectLabel`, `TaskLabel`, `CustomField`, `TaskCustomValue`, `TaskChecklistItem`, `UserViewPref`, `PortfolioProject`, `TaskCommentRead`, `Baseline`, `BaselineTask`, `ViolationOcr`, `ViolationFile`, `ViolationResponse`, `ViolationVisibility`, `ImportPreview`, `CardPrintItem`, `Notification`, `Setting`, `ProjectParticipant` |

Two illustrative kills: removing the `Violation` filter fails with
`LEAK admin GET /violations … B text`, and removing `AuditLog` fails with `LEAK … GET /audit`.

The mutants survive for three reasons: there is no dual-workspace identity (M5.1), the route values
are not iterated (M5.2), or the DB triggers stop the cross reference before the app layer is reached.
That last case means the "app layer alone" run is not purely the app layer: triggers apply to
superusers too.

## 4. Suites run

- `apps/api`: `npx jest test/pglite test/isolation src/prisma` → **8 suites, 108 tests passed**
  (isolation: 236 routes, 1,226 probes per run, with and without RLS).
- `apps/web`: `npx vitest run src/api/demo` → **16 files, 198 tests passed**.

## 5. Scratch reproductions (outside the repository)

All are under `C:\Users\KSA\AppData\Local\Temp\claude\C--Users-KSA\95f6155d-9c59-4b48-a0e5-2addc14610db\scratchpad\a12review\`:

- `jest.review.config.js`: runs scratch specs against `apps/api` (`npx jest -c <path>` from `apps/api`).
- `findings.review-spec.ts`: R1 (H2), R2 (M2), R3 (M1), R4 (M3), R5 (L1), R6 (M4), R7 (controls). All pass.
- `owner-env.review-spec.ts`: H1, both scenarios. Both pass.
- `mut.review-spec.ts` with `MUT_MODEL=<Model>`: the mutation runs. Results are in `mutation-results.txt`.
- `fkcheck.js`: the FK and guard completeness check.
- `demo\`: the subagent's vitest reproductions G1–G5, the demo mutation runs, and the dual-member test.

## 6. Recommended order

1. **H3**: stop wiping unsynced violations. This is the only path that destroys field evidence today.
2. **H1**: make owner promotion first-boot only.
3. **H2 and M2**: apply ADR-149's account rule to reactivation and photos, on the server and in the demo.
4. **M1**: write account-level audit entries outside any workspace.
5. **M3**: filter `notify()` recipients by live membership.
6. **M4**: run retention on archived workspaces.
7. **M5**: add a dual-member identity, iterate route enums, and keep the mutation loop as a gate.
8. **L1–L4.**

---

## ملخّص بالعربية

**الحكم:** عزل بيانات العمل بين الأقسام **سليم**: المشاريع والمهام والفرق والعمّال والمخالفات والملفات
والتقارير والتصدير والاستيراد والمهام الخلفية. حاولتُ اختراقه من كل نقطة فلم تتسرّب بيانات قسم إلى آخر، ولكل
طبقة من الطبقات الثلاث (طبقة التطبيق، وRLS، وحرّاس الربط) أثرٌ مستقل. ومجموعات الاختبار كلها خضراء.

**الخلل في الطبقة العامة المحيطة بالبيانات، لا في البيانات نفسها:**
- **عالية:** ترقية المالك من متغيرات البيئة تتكرّر مع كل تشغيل. فالمالك المُزال يعود مالكًا، ومدير قسم يستطيع
  أن ينشئ حسابًا باسم مستخدم محرَّر من القائمة فيصير مالكًا بعد إعادة التشغيل.
- **عالية:** مدير قسم يرفع إيقافًا عامًّا فرضه المالك، فيعود الشخص إلى الأقسام الأخرى.
- **عالية (فقدان بيانات):** شاشة «اختر القسم» تمسح المخالفات غير المُرسلة وصورها بلا تحذير عند الدخول بعد
  إعادة تسجيل الدخول.
- **متوسطة:**
  - تعديلات المالك على الحسابات تُسجَّل في سجل تدقيق القسم الذي يعمل فيه، فيقرأ مديرو قسم آخر بيانات أشخاص
    ليسوا منهم.
  - مدير القسم يغيّر الصورة الشخصية العامة لمن له دور في قسم آخر.
  - التذكيرات تصل بالبريد إلى من أُخرج من القسم.
  - مهام الاحتفاظ لا تمسح صور الهويات في الأقسام المؤرشفة.
  - اختبارات العزل لا تكشف حذف المرشّح عن عدد من الجداول، لأنه لا يوجد فيها شخص له دور في القسمين معًا.

الإصلاحات الدقيقة في كل بند أعلاه.
