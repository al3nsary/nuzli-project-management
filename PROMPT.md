# Build Prompt — Field Teams & Project Management System (Arabic / RTL)

> Paste this whole document into your coding agent as the project brief. It is the single source of truth. Where the brief is silent, choose the simplest robust option, write the decision into `docs/DECISIONS.md`, and continue. Ask before you change anything this brief fixes.

---

## 0. Your role and how to work

You are a senior full-stack engineer and software architect. You will build a production-grade web system end to end: architecture, database, backend, frontend, offline mobile web, printing, Docker deployment, and tests.

Work rules:

1. **Build in phases** (section 16). Finish each phase completely: code, migrations, seed data, tests, and a short `docs/phase-N.md` covering what was built, how to run it, and what is left. Do not start the next phase with failing tests.
2. **Do not invent business data.** The owner will supply real database details, departments, job titles, violation types, logos and other reference data later. Until then use clearly marked seed/demo data (`seed/demo/*`) that is easy to replace, and keep all reference lists admin-editable instead of hard-coded.
3. **Do not over-engineer.** This is a simplified GanttPRO, not a clone of every feature. Section 6 says what is in scope and what is not.
4. **Arabic first.** Every screen is Arabic and RTL by default. No English strings are visible to end users.
5. **Explain trade-offs** in `docs/DECISIONS.md` (ADR style: context, decision, consequences) whenever you choose a library or pattern.
6. **Security and privacy are requirements, not extras.** The system stores Saudi national ID numbers and ID card photos (section 13).

---

## 1. Product overview

The system has two halves that share one user and permission model:

- **A. Project management:** projects, hierarchical tasks, an RTL Gantt chart, dependencies, list and board views. **Tasks are assigned to supervisors only**, never to team members.
- **B. Field team operations:** teams (one supervisor plus members), each with a unique color; drag-and-drop reassignment of members between teams; **violations** recorded in the field by monitoring supervisors (offline-capable, with GPS location and photos); a violations analytics page; and **work card printing** on Zebra card printers.

Team members do **not** log in in this version. They are records only. Their other future use will be specified later, so the design must allow a member to become a login user later without a data migration (section 5.4).

---

## 2. Tech stack (fixed)

| Layer | Choice |
|---|---|
| Runtime | Everything runs in **Docker** containers, orchestrated by **docker compose** |
| Database | **PostgreSQL 16** |
| File and image storage | **OCI Object Storage** (Oracle Cloud) through its **S3-compatible API**. Use **MinIO** as the local and dev stand-in. The same code path serves both, selected by environment variables. |
| Frontend | **React 18 + TypeScript + Vite** |
| Backend | **Node.js 20 LTS + TypeScript + NestJS** (modules, guards and interceptors fit the RBAC model) |
| ORM / migrations | **Prisma**. Use raw SQL inside migrations for anything Prisma cannot express: partial unique indexes, CHECK constraints, triggers. |
| Validation | **zod** schemas in a shared package, used by both API and UI |
| Monorepo | **pnpm workspaces**: `apps/web`, `apps/api`, `packages/shared` (types and zod schemas), `packages/scheduling` (pure TypeScript Gantt scheduling engine), `packages/ui-print` (card templates) |

Recommended frontend libraries (record any substitution in `DECISIONS.md`):

- **Mantine**: native RTL support, Arabic-friendly components, date pickers.
- **TanStack Query** for server state and **Zustand** for light client state.
- **React Router**.
- **dnd-kit** for team reassignment and the Kanban board.
- **Dexie** (IndexedDB) and **vite-plugin-pwa / Workbox** for offline use.
- **Leaflet** with OpenStreetMap tiles for violation maps.
- **Apache ECharts** for statistics.
- **browser-image-compression** for client-side image resizing.
- **qrcode** for card QR codes.

Font: **IBM Plex Sans Arabic**, or Cairo or Tajawal, self-hosted and not loaded from a CDN, so printing and offline use work.

---

## 3. Architecture and Docker

### 3.1 Services (`docker-compose.yml`)

```
proxy    → Nginx: TLS termination, serves the built React app, reverse-proxies /api → api
api      → NestJS application
db       → postgres:16 (named volume, healthcheck)
storage  → minio (dev/test ONLY; production points to OCI via env)
backup   → small cron container running pg_dump daily to a volume and/or OCI bucket (prod)
```

- Provide `docker-compose.yml` (base), `docker-compose.dev.yml` (hot reload, MinIO, mailpit for email), and `docker-compose.prod.yml` (no MinIO, resource limits, restart policies).
- **HTTPS is mandatory, including in dev and test.** Browser geolocation, the camera and service workers only work in a secure context. Ship a self-signed dev certificate flow (mkcert instructions) and Let's Encrypt or provided certificates for prod.
- Multi-stage Dockerfiles, non-root users, a `HEALTHCHECK` for every service, `depends_on: condition: service_healthy`.
- The API runs `prisma migrate deploy` on start, then an idempotent seed that creates the first admin from env vars (section 4.4).
- All configuration comes from env. Provide a complete `.env.example` with comments.
- **Store all timestamps in UTC** (`timestamptz`). Display them in `Asia/Riyadh`.

### 3.2 Object storage (OCI S3-compatible)

- Use the AWS SDK v3 S3 client with env-driven settings: `S3_ENDPOINT` (OCI format: `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (OCI Customer Secret Keys), `S3_FORCE_PATH_STYLE=true`.
- **The bucket is private.** No object is ever public.
- Uploads: the client asks the API for a **presigned PUT URL** (short TTL, about 5 minutes; content-type and max size enforced), uploads directly to storage, then calls a confirm endpoint. The API then verifies the object exists, checks its size, and validates its type from the magic bytes before marking the file `ready`.
- Downloads: **presigned GET URLs** with a short TTL, issued only after a permission check.
- Object key layout: `{entity}/{yyyy}/{mm}/{uuid}.{ext}`, e.g. `violations/2026/10/<uuid>.jpg`. Never put names or national IDs in keys.
- Keep a `files` table as the single registry of every stored object (section 11).

---

## 4. Users, roles, registration

### 4.1 Roles

| Role (code) | Arabic label | Logs in | Capabilities |
|---|---|---|---|
| `ADMIN` | مدير النظام | Yes | Everything. Approves registrations, creates users, grants or revokes admin, manages projects, teams, cards, violation settings, reference data, all statistics. |
| `SUPERVISOR` | مشرف | Yes | Leads one or more teams. Can create a team (section 5.1). Receives task assignments. Sees their own team(s), their tasks, and their team's violations **only if the admin enabled it** (section 7.6). |
| `MONITOR` | مشرف مراقبة | Yes | Has no team. Records violations against team members. Sees the violations they recorded. |
| Team member | عضو فريق | **No** (this version) | A record only (section 5.4). |

Implement RBAC with a permissions matrix in code (`permissions.ts`), not scattered role checks. Use NestJS guards on every endpoint and mirror the same permissions in the UI to hide actions. **The API is the authority.**

### 4.2 Self-registration (pending approval)

- Public page `/register`. The user chooses an account type: **Supervisor** or **Monitoring Supervisor**.
- Fields: full name, email, mobile, national ID / Iqama number, password (and for a supervisor: optionally request a team name; section 5.1).
- Validation:
  - Saudi mobile: accept `05XXXXXXXX` or `+9665XXXXXXXX`, normalize to E.164.
  - National ID / Iqama: 10 digits, starting with `1` (citizen) or `2` (resident), validated with the standard check-digit (Luhn-variant) algorithm.
  - Email, national ID and mobile are unique across users.
- The account is created with `status = PENDING`. **It can never log in until approved.** No automatic approval exists anywhere.
- All admins are notified in-app and by email.
- The admin's **Registration requests** page (طلبات التسجيل) lists pending requests with full details and offers Approve, Reject (reason required, emailed to the applicant), and Change requested role before approving.
- Statuses: `PENDING`, `ACTIVE`, `REJECTED`, `SUSPENDED`. Suspending revokes all sessions immediately.

### 4.3 Admin user management

- An admin can **create a user directly** (any role, including `ADMIN`). The user is active immediately and receives an email with a one-time set-password link.
- An admin can **promote** an existing user to `ADMIN` or **demote** them.
- **Last-admin protection:** the system must never reach zero active admins. Block demoting, suspending or deleting the last active admin, enforced in the service layer inside a transaction.
- Every role change, approval, rejection and suspension goes to the audit log.

### 4.4 Authentication

- Hash passwords with **argon2id**.
- Short-lived JWT access token (about 15 minutes) in memory, plus a rotating refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie. Store refresh tokens hashed with reuse detection.
- Login with email **or** mobile, plus password. Rate limiting and lockout after repeated failures.
- Forgot or reset password by email.
- **Bootstrap:** the seed creates the first admin from `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` only when there are zero admins, and forces a password change on first login.
- Design the auth module so SSO (e.g. Microsoft Entra ID) can be added later without restructuring.

---

## 5. Teams

### 5.1 Creating a team (admin **and** supervisor)

- **Admin:** creates a team by choosing an existing supervisor or creating a new one inline (name, email, mobile, national ID), then sets the name and color and adds members. The team is active immediately.
- **Supervisor:** creates a team for themselves (name, color, members). A system setting `REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS` (default **on**) decides whether the team is `PENDING_APPROVAL` or `ACTIVE`. While a team is pending, its color is still reserved.
- Required data:
  - **Supervisor:** full name, email, mobile, national ID.
  - **Member:** full name and national ID only. **Job title** and **department** are optional fields used on work cards (section 8), each chosen from an admin-managed list with a free-text fallback.
- Bulk add members by pasting rows or importing **Excel**, with validation and a preview of errors before commit.

### 5.2 Team color (unique, reserved colors hidden)

- Maintain an admin-managed **palette** (`team_colors` table, seeded with 24 visually distinct, accessible colors, each with a name and hex). Admins can add or retire colors.
- When creating or editing a team, the color picker **shows only colors not used by any active or pending team.** Reserved colors are not shown at all, not even disabled.
- Enforce uniqueness in the database with a **partial unique index** on `teams(color_id) WHERE status IN ('ACTIVE','PENDING_APPROVAL')`, so two simultaneous creations cannot take the same color. Handle the conflict with a clear Arabic message that refreshes the picker.
- Archiving a team frees its color.
- The team color is used consistently across the app: badges, board columns, Gantt assignee markers, violation charts, card accent strip.

### 5.3 Reassigning members between teams (drag and drop)

- Page **Team formation** (تشكيل الفرق): one column per team (header in the team color, supervisor name, member count), with member cards inside. Includes search and filter.
- Dragging a member to another column moves them. Show a confirmation dialog with an optional reason. Use an optimistic UI update with rollback on error. Multi-select and move in bulk.
- Keyboard-accessible drag and drop (dnd-kit sensors).
- **Membership history is mandatory.** Every move closes the current row in `team_memberships` (`valid_to = now()`) and opens a new one. **A member belongs to exactly one team at any moment**, enforced with a partial unique index on `team_memberships(member_id) WHERE valid_to IS NULL`.
- Why this matters: violations must keep the team the member belonged to **at the time of the violation** (section 7.3). Moving a member must never rewrite past statistics.
- Changing a team's supervisor is also supported and recorded in history (`team_supervisor_history`).

### 5.4 Future-proofing team members

Keep members in their own `team_members` table, with a nullable `user_id` column (FK to `users`, unique, currently always null). If members get logins later, a user is linked to the member record and no data moves.

---

## 6. Project management (simplified GanttPRO)

### 6.1 In scope

**Projects**
- Name, description, start date, owner, status, working calendar.
- Only admins create projects. Admins can also grant a supervisor **view** access to a project.

**Tasks**
- Unlimited hierarchy through `parent_id`, ordered by `sort_order`, with automatic WBS numbering (1, 1.1, 1.1.2).
- Three types: `TASK`, `GROUP` (summary), `MILESTONE` (zero duration).
- Fields: name, start, end, duration in **working days**, progress %, status (`NOT_STARTED`, `IN_PROGRESS`, `DONE`, `ON_HOLD`), priority, description, **assignee (supervisor only)**, attachments, comments.
- **Roll-up:** a group's start is the minimum start of its children, its end is the maximum end, and its progress is the duration-weighted average. Recomputed automatically.

**Dependencies**
- **Finish-to-Start**, with optional lag or lead in working days.
- Cycle detection that rejects the change with a clear message.
- Model the type column with all four values (`FS`, `SS`, `FF`, `SF`) so the others can be enabled later, but only FS is exposed in the UI for now.

**Auto-scheduling**
- When a task moves or its duration changes, successors shift forward automatically through a topological forward pass.
- A per-project toggle for auto-scheduling on or off.

**Working calendar**
- The default weekend is **Friday and Saturday**.
- Admin-managed holidays and exceptions per calendar.
- All duration math uses working days.

**Views**
- **Gantt:** RTL. Time flows right to left, with the task grid on the right and the timeline on the left.
  - Synchronized vertical scroll between grid and timeline.
  - Zoom levels: day, week, month, quarter.
  - Today line.
  - Drag a bar to move it, drag a bar edge to resize, drag between bars to create a dependency.
  - Click a bar to edit.
  - Expand and collapse groups.
  - Weekend shading.
  - Assignee shown with their team color.
  - Optional **Hijri date** row in the header (`Intl.DateTimeFormat` with `islamic-umalqura`), toggled per user.
- **List / grid:** an editable tree table.
- **Board (Kanban)** by status, using dnd-kit.
- **My tasks** for supervisors: their assigned tasks across projects.

**Collaboration**
- Comments with @mentions of users.
- Attachments stored in object storage.
- Activity log per task.
- In-app notifications for assignment, mention, due soon and overdue.

**Export**
- Gantt to **PDF/PNG**.
- Tasks to **Excel**, following the Excel rules in 7.7.

### 6.2 Phase 3 (design the schema for it, build later)
Baselines (plan snapshot vs actual), critical path (forward and backward pass with slack), a workload view per supervisor, project templates, a multi-project portfolio view.

### 6.3 Out of scope
Cost and budget tracking, MS Project import, time tracking, public share links.

### 6.4 Implementation requirements
- **The scheduling engine** (`packages/scheduling`) is pure TypeScript with no React and no database. It provides working-day math, roll-ups, FS propagation with lag, cycle detection, and WBS numbering. It runs in the browser for instant feedback while dragging and on the server to validate and persist. It must have thorough unit tests, including weekends, holidays, lag, and deep trees.
- **Build the Gantt as a custom React + SVG component**, not a third-party Gantt library, so RTL behavior is fully controlled. Virtualize rows so the chart stays smooth at **2,000 tasks**.
- Persist edits as batched changes (one request per drag-end, containing every task the engine shifted) inside a single DB transaction, with **optimistic concurrency** (a `version` column, and a 409 response with a refresh prompt on conflict).

---

## 7. Violations (المخالفات): offline-first

### 7.1 Who records
`MONITOR` users (and admins). The UI is **mobile-first**, since it is used in the field on phones.

### 7.2 Recording flow (form: تسجيل مخالفة)

1. **Select team member:** search by name or national ID. The team and its color appear automatically.
2. **Photo of the member's ID card:** taken with the camera (`<input type="file" accept="image/*" capture="environment">` or getUserMedia). Required.
3. **Photo(s) of the violation:** one or more, up to a configurable maximum (default 5). At least one is required.
4. **Violation type:** from an admin-managed catalog with an optional severity.
5. **Description** (required) and **notes** (optional).
6. **Automatically captured, not editable by the user:**
   - Date and time.
   - **GPS location** (latitude, longitude, **accuracy in meters**) via the Geolocation API with high accuracy and a timeout. If accuracy is poor, show it and let the user retry. If location is denied, block submission and explain how to enable it.
   - Recorder identity.
   - Device information.

Compress images client-side before storage or upload (longest side about 1600px, JPEG, about 80% quality), and strip EXIF data except what is needed.

### 7.3 Data integrity rules
- Each violation stores **a snapshot of `team_id` and `supervisor_id` at the time of the violation**, resolved from membership history at `captured_at`. All statistics use the snapshot.
- **Two timestamps:** `captured_at` (device time when recorded, possibly offline) and `received_at` (server time on sync). If the clock difference is above a threshold, flag `clock_drift_suspect = true` and show the flag to admins.
- Violations are **append-only** for monitors. A monitor can edit their own violation only within a configurable window (default 15 minutes after sync). After that, only an admin can change it, and every change is audited.
- Statuses: `SUBMITTED`, `UNDER_REVIEW`, `CONFIRMED`, `CANCELLED` (reason required).

### 7.4 Offline mode (confirmed requirement)

- The app is a **PWA**. A service worker caches the app shell, fonts and icons.
- **Local roster cache:** on login and periodically while online, download the minimal list a monitor needs to choose members: member id, name, **masked** national ID, team name and color. Store it in IndexedDB (Dexie). Show the "last updated" time and refresh it manually or automatically when online.
- **Offline submission:** the violation and its compressed photos (as Blobs) are saved to a local **outbox** in IndexedDB with a **client-generated UUID**, then shown in "Pending sync" with a count badge.
- **Sync engine:**
  - Triggers: the `online` event, app focus, a periodic timer, and Background Sync where supported. iOS Safari has no Background Sync, so the foreground triggers are the guaranteed path.
  - Order per item: create the violation (idempotent by client UUID, so a retry never duplicates), request presigned URLs, upload the photos, confirm.
  - Retry with exponential backoff. Partial failures resume where they stopped.
  - Show a per-item status: pending, uploading, synced, failed with reason.
- **Data on the device:**
  - Clear all cached personal data and the outbox **on logout**. Warn the user if unsynced items exist before logout.
  - Cap cached data to the minimum.
  - Request `navigator.storage.persist()` so the browser does not evict the outbox.
- Test offline mode with Playwright: go offline, record, reload the page, go online, verify the sync.

### 7.5 Violations page and statistics (admin)

**List:**
- Filters: date range, team, member, monitor, type, status, area drawn on the map.
- Table and card views.
- Detail view showing the photos (presigned), a map pin with an accuracy circle, the history, and the clock-drift flag.

**Dashboard:**
- KPIs: total violations, this week, change vs the previous period.
- **Teams ranked by number of violations** (bar chart in team colors), also normalized per member.
- Top repeat members.
- Violations per **monitor** (who records the most).
- Distribution by type and severity.
- Trend over time.
- Heatmap by weekday and hour.
- **Map** of violation locations with clustering.

Every chart responds to the same filters. Export the filtered list to **Excel** and the dashboard to **PDF**.

### 7.6 Supervisor visibility (admin-controlled)
- A global setting `SUPERVISORS_CAN_SEE_VIOLATIONS` (default off), plus a **per-team override** (inherit / show / hide).
- When visible, a supervisor sees the violations of **their own team(s) only**, read-only. They can add a **response or objection note**, which the admin can see. Supervisors can never see other teams' data.
- When hidden, the supervisor endpoints return nothing (enforced in the API, not just hidden in the UI).

### 7.7 Excel export rules (strict)
- All exported `.xlsx` files are **right-to-left** (sheet view `rightToLeft = true`).
- **Do NOT use freeze panes in any exported sheet.** They cause a blank white area when scrolling in the client's environment. This is a known, repeatedly reported issue.
- Use real date cells, Arabic headers, and auto-fit column widths.

---

## 8. Work cards (كروت العمل): Zebra printing

### 8.1 Page flow
1. Choose a **team** (or several, or individual members).
2. Choose a **card template**: size, orientation, layout.
3. The system generates a **live preview** of cards for the **supervisor and every member**.
4. **Every field is editable on the card before printing:** name, job title, national ID, department, and others. By default, edits apply **to this print batch only**. A checkbox lets the user **save the edits back to the member record**.
5. Select all or some cards, then print. Every print batch is logged: who printed, when, which cards, and which template.

### 8.2 Card content
- **Uploaded logo** (admin-managed, multiple logos allowed, one default).
- Full name, **job title**, **national ID number** (full or masked, per template setting), **department**.
- Team name with a **team color accent strip**.
- Optional: member photo (if uploaded later), QR code containing the **internal member UUID** (never the national ID), card validity date.

### 8.3 Sizes (selectable; admin can add custom sizes)

| Preset | Size (mm) | Notes |
|---|---|---|
| **CR80 (default)** | 85.6 × 54 | Standard ID card, landscape and portrait |
| 90 × 40 | 90 × 40 | The originally requested size |
| 4" × 2" | 101.6 × 50.8 | Common Zebra label |
| 3" × 2" | 76.2 × 50.8 | Common Zebra label |
| 4" × 3" | 101.6 × 76.2 | Large badge |
| 2.25" × 1.25" | 57 × 32 | Small label |
| Custom | width × height in mm | Admin-defined |

### 8.4 Templates
- At least **three built-in layouts** (e.g. classic horizontal, vertical badge, compact label). Each template defines its size, orientation, which fields are shown, font sizes, logo position, colors, and whether the national ID is masked. Admins manage templates through a form-based editor with live preview, not a free-form designer.
- Templates are React components in `packages/ui-print`, sized in **mm**.

### 8.5 Printing method
- **Primary:** browser printing of an HTML page with `@page { size: <w>mm <h>mm; margin: 0 }`, one card per page, self-hosted Arabic fonts, print-specific CSS. This works with the Zebra Windows driver set to the matching media size. Include a **calibration and test print** page and a short guide in `docs/printing.md` (driver media size, margins, scaling 100%, no headers or footers).
- **Secondary:** **server-side PDF** export with exact page sizes (headless Chromium/Playwright in the API container, or a separate `pdf` service) for archiving or printing from other machines.
- **Optional, phase 4:** raw **ZPL** output through Zebra Browser Print, for text-only templates. Note in `DECISIONS.md` that Arabic shaping and images make ZPL a poor default.

---

## 9. Notifications
- In-app notification center (bell icon, unread count) plus email through SMTP (env-configured; mailpit in dev).
- Events:
  - New registration request (to admins).
  - Registration approved or rejected (to the applicant).
  - Team pending approval (to admins).
  - Task assigned, mentioned, due soon, overdue (to supervisors).
  - Supervisor objection to a violation (to admins).
- Users control their email preferences per event type.

---

## 10. Settings and reference data (admin)
Departments, job titles, violation types and severities, team color palette, card sizes and templates, logos, working calendars and holidays, system toggles (`REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS`, `SUPERVISORS_CAN_SEE_VIOLATIONS`, the violation edit window, the maximum number of violation photos, the clock-drift threshold, presigned URL TTL).

All of these are tables or editable settings. **The owner will provide the real values later.** Seed placeholders only.

---

## 11. Data model (minimum; refine, don't shrink)

Use UUID primary keys (`uuid` v7 or `gen_random_uuid()`). Every table has `created_at`, `updated_at`, `created_by`. Soft-delete with `archived_at` where history matters.

```
users(id, full_name, email UQ, mobile UQ, national_id UQ, password_hash, role, status,
      rejection_reason, must_change_password, last_login_at, ...)
refresh_tokens(id, user_id, token_hash, expires_at, revoked_at, replaced_by)
registration_requests → (may be folded into users.status; document the choice)

team_colors(id, name, hex UQ, is_active)
teams(id, name, color_id FK, supervisor_id FK users, status[PENDING_APPROVAL|ACTIVE|ARCHIVED], ...)
  -- partial unique index: color_id WHERE status IN ('ACTIVE','PENDING_APPROVAL')
team_supervisor_history(id, team_id, supervisor_id, valid_from, valid_to)
team_members(id, full_name, national_id UQ, job_title_id, job_title_text, department_id,
             department_text, photo_file_id, user_id NULL UQ, status, ...)
team_memberships(id, member_id, team_id, valid_from, valid_to NULL, moved_by, reason)
  -- partial unique index: member_id WHERE valid_to IS NULL
departments(id, name), job_titles(id, name)

projects(id, name, description, start_date, status, calendar_id, auto_schedule, owner_id, ...)
project_access(project_id, user_id, level)
calendars(id, name, weekend_days int[]), calendar_exceptions(id, calendar_id, date, is_working, name)
tasks(id, project_id, parent_id, sort_order, wbs_cache, name, type, start_date, end_date,
      duration_days, progress, status, priority, assignee_id FK users (SUPERVISOR only — enforce),
      description, version, ...)
task_dependencies(id, project_id, predecessor_id, successor_id, type, lag_days)
  -- UQ(predecessor_id, successor_id); CHECK(predecessor_id <> successor_id)
task_comments(id, task_id, author_id, body, mentions uuid[])
baselines(id, project_id, name, created_at), baseline_tasks(baseline_id, task_id, start_date, end_date)  -- phase 3

violation_types(id, name, severity, is_active)
violations(id, client_uuid UQ, member_id, team_id_snapshot, supervisor_id_snapshot,
           recorded_by, type_id, description, notes, latitude, longitude, accuracy_m,
           captured_at, received_at, clock_drift_suspect, device_info jsonb, status,
           cancel_reason, ...)
violation_files(id, violation_id, file_id, kind[ID_CARD|EVIDENCE])
violation_responses(id, violation_id, supervisor_id, body)
violation_visibility(team_id PK, mode[INHERIT|SHOW|HIDE])

files(id, storage_key UQ, bucket, mime_type, size_bytes, sha256, status[PENDING|READY],
      uploaded_by, entity_type, entity_id)
logos(id, name, file_id, is_default)
card_sizes(id, name, width_mm, height_mm, is_builtin)
card_templates(id, name, size_id, orientation, layout_key, config jsonb, is_default)
card_print_batches(id, template_id, printed_by, printed_at, card_count)
card_print_items(id, batch_id, member_id NULL, user_id NULL, rendered_data jsonb)

notifications(id, user_id, type, payload jsonb, read_at)
settings(key PK, value jsonb)
audit_log(id, actor_id, action, entity_type, entity_id, before jsonb, after jsonb, ip, at)
```

Add indexes for every foreign key and for the main filters (violations by `captured_at`, `team_id_snapshot`, `recorded_by`, `type_id`). Consider **PostGIS** only if map queries need it; otherwise plain lat/lng columns with a bounding-box query are enough. Record the decision.

---

## 12. API and frontend conventions

**API**
- REST under `/api/v1`, with an **OpenAPI/Swagger** spec generated by NestJS.
- Request and response bodies are validated by the shared zod schemas.
- One error shape: `{ code, message_ar, details }`.
- Cursor or offset pagination, sorting and filtering conventions documented once and used everywhere.
- Idempotency keys on violation creation (`client_uuid`) and on print batch creation.
- Structured logging with **pino**, a request id on every log line, `/health` and `/ready` endpoints.

**Frontend**
- `dir="rtl"` and `lang="ar"` at the root.
- Use logical CSS properties (`margin-inline-start`, etc.) only.
- Icons that imply direction are mirrored.
- Numbers use Western digits by default, with a user setting for Arabic-Indic digits.
- Dates use Gregorian by default, with an optional Hijri display.
- All strings live in i18n files (`ar` complete; `en` scaffolded).
- Responsive at 360px and up. The violations module and the "My tasks" page must be excellent on phones.
- Accessibility: keyboard navigation, focus states, labels, color is never the only signal (team color always shown together with the team name).
- Pages:
  - Login, Register, Pending approval notice.
  - Dashboard (per role).
  - Projects, Project (Gantt / List / Board), My tasks.
  - Teams, Team formation (drag and drop), Team detail.
  - Registration requests, Users.
  - Record violation (mobile), My violations + Pending sync, Violations list, Violations dashboard.
  - Work cards, Card templates.
  - Settings (reference data), Audit log, Notifications, Profile.

---

## 13. Security and privacy (Saudi PDPL)

- National ID numbers and ID card photos are **sensitive personal data**.
  - Mask national IDs in lists and APIs (`1•••••••23`) for everyone except admins and the flows that require the full value. Card printing shows the full value only when the template says so.
  - Encrypt national ID columns at rest using application-level encryption (e.g. AES-GCM with a key from env or a secret manager), plus a **blind index** (HMAC) for exact-match lookups and uniqueness. Document key rotation.
- **Audit log** of every view of an ID card photo, every export, every print batch, and every permission or role change.
- Private bucket, short-TTL presigned URLs, uploads validated by magic bytes, size limits, no SVG uploads.
- helmet, strict CORS, CSP, rate limiting on auth and upload endpoints, CSRF protection for cookie-based refresh.
- No personal data in URLs, logs or object keys.
- Encrypted backups, with a documented restore procedure tested in CI or by script.
- A data retention setting for violation photos (configurable, default: keep).

---

## 14. Testing and quality

- **Unit:** the scheduling engine (high coverage), national ID check-digit, mobile normalization, permission matrix, membership-snapshot resolution.
- **Integration** (Testcontainers: Postgres and MinIO):
  - Registration approval flow and last-admin protection.
  - Unique color under concurrent requests.
  - Moving a member keeps old violations on the old team.
  - Idempotent violation sync.
  - Supervisor violation visibility on and off.
  - Presigned upload and confirm.
- **E2E (Playwright, mobile and desktop viewports):**
  - Register, then admin approves, then login.
  - Create a team with a color and verify the color disappears from the picker.
  - Drag a member between teams.
  - Gantt drag shifts the dependent task.
  - **Offline violation recorded, then a reload, then back online, then synced.**
  - Print preview at each card size.
- ESLint, Prettier, TypeScript `strict`, and CI (GitHub Actions) running lint, typecheck, tests and the Docker build.

---

## 15. Documentation deliverables
`README.md` (run in one command: `docker compose up`), `.env.example`, `docs/ARCHITECTURE.md` (with diagrams in Mermaid), `docs/DECISIONS.md`, `docs/DATA_MODEL.md` (ERD in Mermaid), `docs/printing.md`, `docs/offline.md`, `docs/deployment-oci.md`, `docs/backup-restore.md`, per-phase notes.

---

## 16. Phases and acceptance criteria

**Phase 1: Foundation**
Monorepo, Docker (dev and prod), HTTPS, Postgres with Prisma migrations, MinIO and the S3 abstraction, auth, registration with approval, users and roles, last-admin protection, audit log, RTL app shell, notifications skeleton.
✅ *A new supervisor registers, cannot log in, an admin approves them, and they log in. An admin creates another admin. The last admin cannot be demoted.*

**Phase 2: Teams and cards**
Teams created by admin and supervisor, the color palette with the reserved-colors rule, members and Excel import, the drag-and-drop formation page with history, reference data, work cards with every size and the templates, browser printing and PDF export, print logging.
✅ *A used color never appears in the picker. Moving a member records history. Cards print correctly at CR80 and 90×40 on a Zebra printer after following `docs/printing.md`.*

**Phase 3: Violations (offline-first)**
PWA, roster cache, recording form with camera and GPS, outbox and sync, admin list, dashboard and map, supervisor visibility settings and responses, Excel export following rule 7.7.
✅ *A monitor in airplane mode records 3 violations with photos and then reconnects; all 3 sync once, with correct location, team snapshot and photos.*

**Phase 4: Projects and Gantt**
Projects, tasks, hierarchy, the scheduling engine, the custom RTL Gantt, list and board, my tasks, comments, attachments, notifications, exports.
✅ *Delaying a task shifts its FS successors over working days, skipping Friday and Saturday and holidays. A 2,000-task project scrolls smoothly.*

**Phase 5: Advanced (optional)**
Baselines, critical path, workload, templates, portfolio, ZPL printing.

---

## 17. Assumptions to confirm (record in `DECISIONS.md`)
1. A supervisor may lead **more than one** team. Allow it, and make it a setting if simple.
2. Team-member job titles and departments are optional, and are mainly used on cards.
3. Monitors see only the violations they recorded. Admins see all.
4. The future use of team members is unknown, so keep the `user_id` hook only and build nothing more.
5. Real database data, reference lists and logos will be provided by the owner and loaded through seed scripts or admin screens.

Begin with Phase 1. Before writing code, output: (a) the repository tree, (b) the Prisma schema for the whole data model, and (c) the list of ADRs you intend to write. Then implement.

---

## 18. Amendments log (living — سجل التعديلات)

> This section is maintained by the build agent. Every owner request that adds to or changes the brief is recorded here with its date, so this file stays the single source of truth. The untouched original lives at `docs/brief/PROMPT.original.md`.

| # | Date | Owner request (as given) | Effect on the brief |
|---|---|---|---|
| A1 | 2026-10-11 | «طوّر النظام كما هو مطلوب بالضبط، وأنشئ الوكلاء الضروريين، واستدعِ المهارات اللازمة في التصميم واللغات وسجّلها في ملفات للنظام» | Project agents live in `.claude/agents/`, project skills in `.claude/skills/`, and the index is in `docs/SKILLS.md`. |
| A2 | 2026-10-11 | «حدّث برومبت وتعليمات إنشاء النظام باستمرار» | This log, plus `CLAUDE.md` (working rules), are updated in every work batch. |
| A3 | 2026-10-11 | «ضع ملفًّا لما سنقوم به وما طلبته ولم يُنفَّذ، يُحدَّث باستمرار» | `docs/STATUS.md` (Arabic) is the live tracker. |
| A4 | 2026-10-11 | «انشره في مساحتي في GitHub باسم المشروع، وضعه في GitHub Pages لأستعرضه» | Repository on the owner's GitHub account. GitHub Pages cannot run the API, Postgres or MinIO, so Pages serves a **demo build** of the web app (`VITE_DEMO=1`): the same React app, with an in-browser `DemoApi` adapter seeded from `seed/demo/*`. See ADR-020. The real deployment remains Docker (§3). |
| A5 | 2026-10-11 | Project folder name: «نزلي إدارة المشاريع» | Product display name «نزلي — إدارة المشاريع والفرق الميدانية». Repo slug `nuzli-project-management`. |
