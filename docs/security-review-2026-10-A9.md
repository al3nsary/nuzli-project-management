# Security and privacy review: owner request A9 (2026-10-19)

**Scope.** API, shared, converter and compose/env changes in three commits:

- `102bd8e`: projects, supervisor scope (ADR-092), budget, labels, custom fields, view preferences, templates, portfolios, time log, hub and attachments browser.
- `4f47446`: several supervisors, the worker foreman, the org structure, violations without a person, and ID-card OCR.
- `7aa7403`: hours, imports (xlsx, CSV, MSPDI, .mpp through MPXJ, Jira CSV and REST) and exports.

`apps/web` was not reviewed. Another agent is changing it.

**Method.** I read the code. I ran `npx tsc --noEmit` in `apps/api`, which was clean. I also ran `npx jest src/projects/tasks.service.spec.ts -t "roll-up follows"`, which confirms H1. Each finding names the code it rests on. Items marked "to verify" were not proven.

## Status (2026-10-19, after the fixes)

ADRs 117–120 record the decisions. docs/API.md lists the behaviour changes (section «A9 security review — behaviour changes»).

| Finding | Status | What changed / why |
|---|---|---|
| H1 | **Fixed** | `scopeUpdateResult`: without `projects.readAll`, `PATCH /tasks/:id` (and the label path) returns `affected: []` and only the task's own `previous`. The unit test now asserts this; an admin still gets the roll-up. Other supervisor paths were audited: `GET /tasks/:id`, `/tasks/mine`, comments, checklist, time entries and attachments return only the supervisor's own task (a `parentId` is an id, not data); the hub `path` is fixed under L4. |
| M1 | **Fixed** | Route is `@RequirePermission('members.manage')` and the service checks it again, so only an admin can copy a PERSON photo. With a team, `captured_at` must be within `VIOLATION_REGISTER_MAX_AGE_DAYS` (new setting, default 30) and not in the future beyond the clock-drift threshold → else 409 `VIOLATION_TOO_OLD_TO_REGISTER`. |
| M2 | **Fixed** | `storage/zip-guard.ts` parses the EOCD and the central directory (≤ 2,000 entries, ≤ 100 MB total, ≤ 50 MB per entry, ratio ≤ 100 above 1 MB; ZIP64, encryption and odd methods refused) and verifies each entry inflates to its declared size with `maxOutputLength`. It runs at confirm and before parsing. exceljs runs in a `worker_threads` worker with `resourceLimits` (256 MB) and a 30 s deadline. |
| M3 | **Fixed** | Only real cells (`eachRow`/`eachCell` without empties), ≤ 200 columns, ≤ 5,016 non-empty rows (more → 413, no silent truncation); CSV has the same caps. A 3,000-row sheet with an XFD cell per row parses in about 4 s in a test. |
| L1 | **Fixed** | At most 200 stored preferences per user (409 `VIEW_PREF_LIMIT` on a new key; updates always work). |
| L2 | **Fixed** | At most 5 previews per admin (the oldest is deleted with its upload); the cleanup loops in batches of 500 until nothing expired is left. Notes are not truncated in previews: the commit uses the preview payload, so cutting them would lose data. |
| L3 | **Fixed** | A supervisor's entry is 404 once the task is reassigned or archived; dates must be within 366 days back and 7 days ahead (Riyadh). |
| L4 | **Fixed** | Hub `path` is `[]` for supervisors (project name kept). Hub and attachments aggregate and page in SQL with the scope as a join (no id list, no comment rows); both throttled to 60/min. |
| L5 | **Fixed** | IPv6 allow-list (global unicast only, minus 6to4, 2001::/23, documentation); mapped IPv4 judged in dotted and hex form. One 60 s `AbortSignal` across all pages, passed to the request and raced against it. |
| L6 | **Fixed** | Each conversion runs in a child JVM killed with `destroyForcibly` at the deadline; fair semaphore for concurrency; output capped. Converter moved to a new `converter` network with `internal: true` shared only with the API. Not compiled here (no JDK); the image build compiles it. |
| L7 | **Fixed** | `violation.ocr_retried` and `violation.person_photo_viewed` audit actions. The retention change of a copied PERSON photo is documented in docs/photos.md. |
| L8 | **Fixed** | Dev MinIO proxy `client_max_body_size 21m`. |
| To verify: OCR image bombs | **Fixed** | Width and height are read from the JPEG/PNG/WebP header; above 25 MP (or an unreadable header) the job fails permanently before tesseract runs. |
| To verify: converter output | **Fixed** | The API reads the converter's body as a stream and cancels it past 60 MB. |
| To verify: demoted supervisors | **Accepted** | No permission reads `team_supervisors` for a non-supervisor role today. Closing the rows on demotion would break the one-primary / last-supervisor invariants of teams and needs an owner decision on who takes over. Kept as a note for a later change. |

Verification: `apps/api` `tsc --noEmit`, `jest` (489 tests, 40 suites) and `nest build` pass; `packages/shared` vitest (67) and build pass; `apps/web` `tsc --noEmit` passes. The integration suite (Docker) was not run here.

---

## Critical

None found.

## High

### H1. A supervisor's task update returns other tasks' data (ADR-092 scope leak)

- **Where:** `apps/api/src/projects/tasks.service.ts:265-269` (`update` returns `affected: dtos.slice(1)` and `previous`). The unit test `apps/api/src/projects/tasks.service.spec.ts:218-230` asserts this behaviour (`expect(res.affected.map((t) => t.id)).toEqual([G])`).
- **Scenario:**
  1. Supervisor S is assigned leaf task A under group G. G and its other children are not assigned to S.
  2. S sends `PATCH /tasks/A { version, progress: 50 }`.
  3. `recompute` rolls progress, dates and costs up into G.
  4. The response carries the full `TaskDto` of G (and of every ancestor up to the root), plus G's `previous` before-values.
- **What leaks:** each ancestor's name, description, assignee (name and team), plannedCost and actualCost (the roll-up, which is the budget of the whole branch), deadline, labels and dates.
- **Why it matters:** ADR-092 says a supervisor sees "only the tasks assigned to them; any other task is 404". The owner request is explicit: «لا يرى ادارة المشروع». Repeating the call with different progress values (and undoing) shows how the branch is weighted.
- **Fix:**
  - In `update`, when `!can(viewer, 'projects.readAll')`, return `{ task, affected: [], previous: pick(previous, [id]) }`. The supervisor client only needs its own row.
  - Apply the same filter wherever `TaskUpdateResult` reaches a non-admin, for example the `setTaskLabel` path if it is ever opened to supervisors.
  - Change the unit test to assert `affected` is `[]` for SUP, and add an int-spec case.

## Medium

### M1. A supervisor can claim any unassigned violation through `register-member`, with backdated membership and a copy of the person photo

- **Where:**
  - `apps/api/src/violations/violations.controller.ts:231` (`@RequireAnyPermission('members.manage', 'members.manageOwn')`).
  - `apps/api/src/violations/violation-assign.service.ts:318-325`: for a non-admin, the violation is loaded with a plain `findUnique`, with no scope check.
  - `:391-393`: `validFrom = v.capturedAt`, with no lower bound.
  - `:325` and `copyPersonPhoto`: the PERSON photo is copied into a member photo that the supervisor manages.
- **Scenario:**
  1. Supervisor S obtains the UUID of any unassigned violation. It may have been recorded at another site or for another team. Possible sources include a forwarded link, a screenshot, a monitor or a notification payload.
  2. S posts `register-member { teamId: <S's team>, nationalId: <any valid ID>, fullName: <anything>, usePersonPhoto: true }`.
  3. The API creates a new member in S's team with a membership starting at `captured_at`. `capturedAt` is the device time, which is only flagged on drift, never rejected, so it can be weeks earlier. The API then assigns the violation, so the snapshot resolves to S's team.
  4. S now holds the stranger's face photo as a member photo. When the team's visibility is SHOW, S also reads the violation itself: description, location and evidence.
  5. The team's membership history now claims that the person was in the team since `captured_at`.
- **Bounds:** UUIDs cannot be guessed and supervisors have no listing of unassigned violations, so step 1 needs a leaked id. The web only offers «تسجيل عضو جديد من البطاقة» to admins (ADR-116). The supervisor branch is unused attack surface.
- **Fix (preferred):** make the route admin-only. Use `@RequirePermission('members.manage')` and drop the non-admin branch from `registerMember`.
- **Fix (if supervisors must keep it):**
  - Require an explicit hand-off. For example, an admin sets `violations.offered_team_id`, and the supervisor may register only into that team.
  - Bound the backdating: `validFrom = max(capturedAt, team.createdAt, now − N days)`.
  - Never copy the PERSON photo for a non-admin caller.

### M2. xlsx import: ZIP decompression bomb (no uncompressed-size limit)

- **Where:** `apps/api/src/imports/tabular.ts:118` calls `wb.xlsx.load(buf)`. Inside exceljs (`node_modules/exceljs/lib/xlsx/xlsx.js:279-308`), `JSZip.loadAsync` loads the whole archive, then `entry.async('nodebuffer'|'string')` inflates every entry fully into memory. The upload check (`magic-bytes.ts` `verifyImportBytes`) only looks for `[Content_Types].xml` and `xl/workbook.xml` in the compressed bytes.
- **Scenario:** an admin imports a 20 MB `.xlsx`, for example one sent by a contractor. Its `xl/worksharedStrings.xml` or a sheet inflates to several GB. The API process runs out of memory or hits the V8 string limit and crashes, taking every user offline. The route throttle is 20 per minute per IP, so the crash can be repeated after each restart.
- **Fix:**
  - Before `load`, walk the ZIP central directory (`yauzl`, or parse the EOCD yourself). Reject the file when the total uncompressed size exceeds about 100 MB, when one entry exceeds about 50 MB, or when the compression ratio exceeds about 100:1. Reject entry counts above about 1,000.
  - Do the same check in `FilesService.confirm` for `entityType: 'import'`, so a bomb never reaches READY.
  - Better still, parse in a `worker_threads` worker with `resourceLimits.maxOldGenerationSizeMb`, so a bad file kills the worker and not the API.

### M3. xlsx import: one far-right cell multiplies the work by 16,384 (CPU and memory DoS)

- **Where:** `apps/api/src/imports/tabular.ts:133-146`. `row.cellCount` is `this._cells.length` (`exceljs/lib/doc/row.js:216`), which is the highest column index used, up to 16,384 (XFD). The loop calls `row.getCell(c)` for every column, and `getCell` creates the missing cells. The cap is `100_000` rows.
- **Scenario:** a sheet of 100,000 rows, each with one cell at XFD. That is about 5 MB of XML and well under 1 MB zipped. It forces about 1.6 billion `getCell` calls and Cell objects, which blocks the event loop and exhausts the heap.
- **Fix:**
  - Iterate with `row.eachCell({ includeEmpty: false }, …)`.
  - Cap columns at, say, `MAX_IMPORT_COLUMNS = 200`, and ignore or reject anything further right.
  - Cap `ws.rowCount` against `MAX_IMPORT_TASKS + 15` before building rows.
  - Apply the same column cap in `readCsv`: Papa parse rows can be very wide within 20 MB.

## Low

### L1. The view-preferences store has no per-user limit

- **Where:** `apps/api/src/projects/view-prefs.service.ts:40-58`.
- **Scenario:** each value is at most 32 KB, but the number of keys is unlimited. The key regex allows about 10^100 distinct keys. Any user, including a MONITOR (`profile.update`), can write 300 × 32 KB per minute, which is about 13 GB of jsonb a day per account.
- **Fix:** before a create, count the user's rows and reject above about 200 (`VIEW_PREF_LIMIT`). Alternatively, allow-list key prefixes (`gantt.`, `attachments.`, `hub.`, `projects.`).

### L2. Import previews: no per-user cap, and cleanup is limited to 500 rows an hour

- **Where:** `apps/api/src/imports/imports.service.ts:127` (create) and `:311-319` (`take: 500`, hourly).
- **Scenario:** one admin may create 20 previews a minute, which is 1,200 an hour. Each can hold about 40 MB of JSON (5,000 tasks with 8,000-character notes). Expired rows pile up faster than the cron deletes them.
- **Fix:**
  - Allow at most about 5 live previews per `createdById`, deleting the oldest on create.
  - Loop the cleanup until no expired row remains.
  - Optionally cap the payload size, for example by truncating notes to 2,000 characters in previews.

### L3. Time entries stay editable after the supervisor loses the task

- **Where:** `apps/api/src/projects/time-entries.service.ts:83-89` (`own`).
- **Scenario:** a supervisor removed from a task can still `PATCH` and `DELETE` their entries on it. The response includes the task name and project name. ADR-092 says losing the assignment loses the thread. Archived tasks are not checked either: `task.archivedAt` is selected but never tested.
- **Fix:** for non-admins, require `e.task.assigneeId === viewer.id && !e.task.archivedAt` (select `assigneeId`). Otherwise return 404.
- **Also:** `timeEntrySchema.date` accepts any year. Bound it, for example to within 1 year in the past and 7 days in the future (Riyadh).

### L4. Hub ancestor path, and hub and attachments loading without limits

- **Where:** `apps/api/src/projects/hub.service.ts:146,176-185` and `:129`, plus `attachments` at `:191-199`.
- **Path:** `ancestors()` returns the names of every parent group of a supervisor's task. These groups are not assigned to the supervisor (same class as H1, names only). If the owner wants «لا يرى ادارة المشروع» strictly, drop `path` for non-admins.
- **Load:** for admins, `hub()` loads **every** comment of every task with comments (`taskComment.findMany({ taskId in ids })`) on each call. `attachments()` builds an `IN (…)` list of every task id. Both can be called 300 times a minute.
- **Fix:** aggregate in SQL. Use `GROUP BY task_id` with `count(*)`, `max(created_at)`, a `count(*) FILTER (WHERE …)` for unread, and `bool_or(mentions @> …)`. Use a join instead of an id list, and add a tighter `@Throttle`, for example 60 per minute.

### L5. Jira SSRF guard: IPv6 gaps and no total deadline

- **Where:** `apps/api/src/imports/jira.ts:213-219` and `:273`.
- **IPv6 gaps:** `isPrivateAddress` misses `fec0::/10` (site-local), `2002::/16` (6to4, which can embed a private v4), `::ffff:7f00:1` in hex form, `::a.b.c.d` (IPv4-compatible) and `100::/64`. The host must be `*.atlassian.net` or an exact allow-listed host, so exploiting this needs control of an allow-listed name's DNS. Practical risk is low.
- **Deadline:** `timeout: 15_000` is an idle-socket timeout. A trickling server can hold the request for 40 pages × an unbounded time.
- **Fix:**
  - Use `net.BlockList` or `ipaddr.js` `range() !== 'unicast'` for both families.
  - Add an overall `AbortSignal.timeout(60_000)` across the loop, and destroy the request on abort.

### L6. Converter: a timed-out conversion keeps its worker thread

- **Where:** `infra/converter/src/ConverterServer.java:102-104`.
- **Scenario:** `job.cancel(true)` only interrupts, and MPXJ parsing does not check for interrupts. Two pathological `.mpp` files, at the default concurrency of 2, stall every later conversion until the container restarts. Each later request answers 504.
- **Fix:**
  - Run each conversion in a child JVM or process that is killed on timeout.
  - Alternatively, use a fresh `Thread` per job, call `stop()` (deprecated, but this is a disposable service), and exit the process when stuck workers reach N, so `restart:` brings it back.
- **Also:** the `backend` network (`docker-compose.yml:132`) is not `internal: true`, so the converter has internet egress it never needs. Put the converter on its own `internal: true` network shared only with the API.

### L7. OCR retry is not audited, and PERSON photo views are not audited

- **OCR retry:** `apps/api/src/violations/violation-assign.service.ts:195-198` re-reads an ID card, which yields new national-ID data, without an audit entry. Add `violation.ocr_retried`.
- **PERSON photos:** these are face photos, which PDPL treats as sensitive. They are served like EVIDENCE. ID-card views are audited (ADR-050), but person photo views are not. Copying the PERSON photo into a member photo (`register-member`) also takes it out of the violation retention period. Consider auditing PERSON views the same way, and document the retention change in the privacy notes.

### L8. Dev proxy body limit is below the import size (functional, not security)

- **Where:** `infra/nginx/dev-storage.conf:17` (`client_max_body_size 12m`) against `MAX_IMPORT_BYTES = 20 MB`.
- **Effect:** import uploads between 12 and 20 MB fail with 413 in dev.
- **Fix:** raise the limit to `21m`.

## To verify

- **OCR image bombs.** A 10 MB PNG or WebP with huge dimensions (for example 30,000 × 30,000) decodes to several GB in tesseract's WASM. Confirm that the worker fails cleanly (job FAILED) and does not take down the API process. If it does not, check width and height from the image header before `recognize` (reject above about 6,000 px), or run the worker with `resourceLimits`.
- **Converter output read fully before the size check.** `apps/api/src/imports/converter-client.ts:47` calls `arrayBuffer()` before checking `MAX_CONVERTED_BYTES`. The converter is trusted and token-gated, so this only matters if it is compromised. Streaming with a cap would be cleaner.
- **Leadership of demoted supervisors.** Changing a user's role does not close their `team_supervisors` rows or their task assignments. I found no grant from this today: MONITOR lacks `tasks.readAssigned`, `violations.readOwnTeams` and `members.manageOwn`, and ADMIN sees everything anyway. Still, the trigger `team_supervisors_role_fn` only checks on insert and update. Closing the rows on demotion would keep the data honest.

---

## Checked and found sound

**Supervisor scope (ADR-092)**

- Every `/projects/*` read route requires `projects.readAll|readGranted`, and supervisors hold neither (403).
- `/tasks/:id/*` routes use `TASK_READ`, with `visibleTask` / `taskScopeWhere` (`assigneeId = me`, live, non-template, not archived) giving 404 otherwise. This covers comments, activity, attachments (list, add, URL, delete), labels and custom fields (read), checklist (supervisors may only change `done`), time entries and mark-read.
- `replyToId` must belong to the same task. Mentions and `TASK_COMMENTED` recipients are limited to active admins and the assignee.
- Hub and attachments browser go through `taskScopeWhere`.
- Generic `/files/:id/url` for task files needs `projects.readAll`, or being the uploader.

**Admin-only bulk and related routes**

- Bulk edit, bulk archive, restore, duplicate, labels, custom fields, checklist structure and templates are admin-only.
- Ids are resolved inside the project's locked state (`lockAndLoad` / `checkVersions`).
- Labels are checked against the project (`assertLabels`), custom-field values against the task's project, and checklist items against `taskId`.

**Teams and org**

- Adding, removing or making a supervisor primary requires `teams.manageAll`.
- Foreman changes go through `loadForWrite` and `assertTeamManageable`, and a DB trigger forbids a foreman with an account.
- A supervisor creating a team can only name themselves (`resolveCreateLeaders`), and cannot set `orgUnitId` on create or update.
- Team reads use `assertTeamReadable` with any open leader.
- The org tree is readable by admins and supervisors (ADR-102) and exposes names and photo ids only, no national IDs or contact data.

**Unassigned violations**

- A CHECK forces no team snapshot when there is no member, so supervisor scope, `byTeam` and the supervisor stats never include them.
- `assign` is limited to the recorder or an admin. `unassign` is admin-only and audited with the reason.
- Duplicate national IDs on register follow ADR-067: admins learn the existing member, others get a generic answer through `hideDuplicateNationalId`.

**OCR**

- Extracted fields are AES-256-GCM encrypted with an HMAC blind index, and are included in the key-rotation script.
- Raw text and image bytes are never persisted. Logs carry the violation id and an error class only, and the stored `error` is a code.
- `GET /violations/:id/ocr` is for admins and the recorder only, masks the number unless `nationalIds.readFull`, sends `Cache-Control: no-store`, and audits every view with a `fullNationalId` flag.
- Suggested *users* go to admins only.
- Retention deletes OCR rows, and the FK cascades on violation delete.
- Language data is local, with no CDN.

**XML (MSPDI)**

- The upload check rejects `<!DOCTYPE` in the raw bytes, and `parseMspdi` rejects it again on the decoded text, which covers UTF-16.
- fast-xml-parser 4.5.7 with no DOCTYPE expands only the five predefined entities and numeric references, so there is no XXE, no external entities and no billion-laughs.
- The writer escapes `& < > "` and strips characters that XML 1.0 forbids.

**CSV and xlsx export**

- `csvField` neutralises `= + - @ \t \r` (plain numbers excepted) and quotes per RFC 4180. exceljs writes strings as values, never as formulas.
- Export filenames are `project-<uuid8>-<date>`, with no user text in `Content-Disposition`.
- Exports are audited with the format.

**Imports**

- Imports are admin-only (`projects.create`) and throttled (20 per minute, Jira 10 per minute).
- The upload is `entityType: 'import'` with no `entityId`, can be at most 20 MB, has its structure checked per format, and can be read only by its uploader.
- The format must match the stored content type.
- A preview is bound to `createdById`: another admin cannot commit it, which is acceptable and simpler.
- Previews expire after 1 hour. Commit claims the preview inside the transaction, so a double submit cannot import twice.
- Assignees must be active SUPERVISORs (also enforced by a DB trigger).
- Task count is capped at 5,000 and Jira at 2,000.
- Uploads are deleted on commit, by the hourly cron, and by the orphan sweep.

**Jira**

- Only https and port 443 are allowed, with no credentials in the URL and no IP literals.
- The host must be `*.atlassian.net` or an exact allow-listed host.
- `guardedLookup` checks every resolved address and pins the one the socket uses, which defeats DNS rebinding. Redirects are refused (3xx → `JIRA_URL_NOT_ALLOWED`). Pages are capped at 5 MB and at 40.
- The token appears only in the Authorization header. It is never stored, audited (`apiToken` was added to `DROP_KEYS`) or logged, because pino logs no bodies.
- `projectKey` is checked against a regex before it is placed into JQL.

**Converter**

- Token required (32 characters or more, not CHANGE_ME) and compared in constant time. The API refuses to start in production with `CONVERTER_URL` but a weak or missing token.
- Body capped at 20 MB, OLE2 magic check, 50 s timeout, concurrency 1–4.
- `expose` only (not published), `read_only`, `cap_drop: ALL`, `no-new-privileges`, non-root uid 10001, tmpfs `/tmp`, 768 MB limit in production.
- MPXJ is pinned by SHA-256.

**Other checks**

- **View preferences:** 32 KB per value (service and DB CHECK), key regex, and project preferences require a visible project.
- **Schemas:** new zod objects strip unknown keys and arrays are bounded (bulk 1,000, restore 5,000, reorder 500, options 100, portfolios 500). Services copy fields explicitly, so I found no mass assignment.
- **Raw SQL:** new code uses only tagged `$queryRaw` (`FOR UPDATE` locks). The only `Prisma.raw` calls are with constants.
- **Migrations:** CHECKs for costs, colours, currency, minutes, JSON shapes and lag. Partial unique indexes for one primary supervisor and one foreman. Deferred constraint triggers for the HOUR columns. No `SECURITY DEFINER` and no dynamic SQL.
- **Regressions against the 2026-10 review:** H1 (placeholder secrets now include `CONVERTER_TOKEN`), M1–M3, L3 and L10 were rechecked in the code touched by A9. Card printing iterates all supervisors and still stores masked data. The member-photo policy uses any open leader. I found no regression.
