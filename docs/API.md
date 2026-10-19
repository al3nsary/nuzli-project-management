# API contract

Base: `/api/v1`. JSON bodies validated by the zod schemas in `@nuzli/shared` (names in brackets). DTO types are also in `@nuzli/shared`. The Swagger UI at `/api/docs` is generated from the code and is authoritative; this file is the hand-written index the web app and the API agree on.

## Conventions
- Errors: HTTP status + `{ code, message_ar, details? }` (`ApiErrorBody`). Validation errors: `400 VALIDATION_FAILED`, `details = { fieldErrors: Record<string, string[]> }`.
- Auth: `Authorization: Bearer <accessToken>`. Refresh token in the `nz_rt` httpOnly cookie (path `/api/v1/auth`). CSRF: the `nz_csrf` cookie (readable) must be echoed in `X-CSRF-Token` on `/auth/refresh` and `/auth/logout`.
- Lists: `?page=1&pageSize=25&sort=createdAt:desc&q=...` → `Paginated<T>` = `{ items, total, page, pageSize }`.
- Times: ISO 8601 UTC. Calendar dates: `YYYY-MM-DD`.
- Idempotency: violation create by `clientUuid`; print batch by `idempotencyKey`. Repeating the request returns the original resource with `200` instead of `201`.

## Phase 1

### Health
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness, no DB |
| GET | `/ready` | DB + storage reachable |

### Auth
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/register` | [registerSchema] | `201 { status: 'PENDING' }` |
| POST | `/auth/login` | [loginSchema] | `AuthSession` + sets cookies. Errors: `INVALID_CREDENTIALS`, `ACCOUNT_PENDING`, `ACCOUNT_REJECTED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_LOCKED` |
| POST | `/auth/refresh` | — (cookie + CSRF header) | `AuthSession`, rotates cookie. `REFRESH_REUSED` revokes the family |
| POST | `/auth/logout` | — | `204`, revokes the token family, clears cookies |
| POST | `/auth/forgot-password` | [forgotPasswordSchema] | `204` always (no account enumeration) |
| POST | `/auth/reset-password` | [resetPasswordSchema] | `204` (also used for the admin "set password" link) |
| POST | `/auth/change-password` | [changePasswordSchema] | `AuthSession` (clears `mustChangePassword`) |
| GET | `/auth/me` | — | `UserDto` |
| PATCH | `/me` | [updateProfileSchema] | `UserDto` |

### Users and registration (ADMIN)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/users?role=&status=&q=` | — | `Paginated<UserDto>` |
| POST | `/users` | [createUserSchema] | `201 UserDto` (ACTIVE, emails a set-password link) |
| GET | `/users/:id` | — | `UserDto` (full national ID for admins) |
| PATCH | `/users/:id/role` | [changeRoleSchema] | `UserDto`. `LAST_ADMIN` |
| POST | `/users/:id/suspend` | [suspendUserSchema] | `UserDto`, revokes sessions. `LAST_ADMIN` |
| POST | `/users/:id/reactivate` | — | `UserDto` |
| GET | `/registrations` | — | `Paginated<UserDto>` with `status = PENDING` |
| POST | `/registrations/:id/approve` | [approveRegistrationSchema] | `UserDto` |
| POST | `/registrations/:id/reject` | [rejectRegistrationSchema] | `UserDto` |
| GET | `/users/supervisors?q=` | — | `UserDto[]` active supervisors (for pickers; also used by Phase 2/4) |

### Audit, notifications, settings, files
| Method | Path | Notes |
|---|---|---|
| GET | `/audit?action=&entityType=&actorId=&from=&to=` | ADMIN. `Paginated<AuditEntryDto>` |
| GET | `/notifications?unread=true` | `Paginated<NotificationDto>` |
| GET | `/notifications/unread-count` | `{ count }` |
| POST | `/notifications/:id/read` | `204` |
| POST | `/notifications/read-all` | `204` |
| GET | `/settings` | `Settings` (any active user may read; only ADMIN may write) |
| PATCH | `/settings` | ADMIN, [updateSettingsSchema] → `Settings` |
| POST | `/files/presign` | [presignUploadSchema] → `PresignedUpload` |
| POST | `/files/:id/confirm` | → `{ id, status: 'READY' }`. `FILE_NOT_UPLOADED`, `FILE_TYPE_NOT_ALLOWED`, `FILE_TOO_LARGE` |
| GET | `/files/:id/url` | → `{ url, expiresAt }` after a permission check; ID-card photos are audited |

### Phase 1 implementation notes (as built)
- Status codes: `ACCOUNT_LOCKED` → 423; `REFRESH_REUSED` → 401 and clears cookies; `PASSWORD_CHANGE_REQUIRED` → 403 on every route except change-password, me and logout; `CSRF_INVALID` → 403; `INVALID_STATE` → 409 (e.g. suspending a pending user).
- A wrong current password on `/auth/change-password` → 400 `VALIDATION_FAILED` with `fieldErrors.currentPassword` (not 401, so the client does not treat it as an expired session).
- `GET /audit` also takes `entityId`; `from`/`to` accept `YYYY-MM-DD` (a bare `to` means end of that day) or ISO instants.
- Approve, reject, suspend, reactivate and confirm → 200; presign and create user → 201.
- A non-UUID route id → 404 `NOT_FOUND`.
- Audit actions: `registration.requested|approved|rejected`, `user.created|role_changed|suspended|reactivated|bootstrap_admin_created`, `settings.updated`, `auth.password_changed|password_reset|refresh_reuse_detected`, `file.id_card_url_issued`. New actions must get an Arabic label in `apps/web/src/i18n/ar.ts` (`audit.action.*`).

### Security changes (2026-10 review — docs/security-review-2026-10.md, ADR-061..070)
- `POST /auth/register` always → `201 {status:'PENDING'}`, also for duplicates (the existing owner is emailed). The UI must not claim an account was created.
- Login: locked accounts answer `401 INVALID_CREDENTIALS` (no more 423). Throttling → `429 RATE_LIMITED` with `details.retryAfterSeconds`.
- Full national IDs never go in a URL: `GET /members`, `/users`, `/users/supervisors` → `400` (`details.useInstead`) when `q` holds one. Use `POST /members/search` `{page,pageSize,sort?,q?,teamId?,unassigned}` or `POST /users/search` `{page,pageSize,sort?,q?,role?,status?}`. Decide with `isFullNationalIdTerm()` from `@nuzli/shared`.
- `POST /cards/batches` → `PrintBatchCreatedDto` = batch + `cards: PrintRunCardDto[]` (`{memberId,userId,data,nationalIdPrinted}`) — the only response with full IDs; print from it and keep it in memory. Stored items are always masked (`nationalIdPrinted: FULL|MASKED`). Client `nationalId`/`qrValue`/`photoFileId` are ignored.
- Supervisor duplicate national ID → `400 NATIONAL_ID_NOT_ACCEPTED` (admins still `409 NATIONAL_ID_TAKEN`).
- Uploads go to `pending/…` and are copied to the final key on confirm. `member_photo` presign → 403 for now; logo presign with `entityId` → 403. Violation photos on a CANCELLED violation → `409 INVALID_STATE`.
- New audit actions: `auth.account_locked`, `registration.duplicate_attempt`, `member.duplicate_rejected`, `cards.preview_full_ids`, `cards.print_data_reissued`.

## Phase 2 — teams, members, reference data, cards

Scope rules: ADMIN sees and manages all teams. A SUPERVISOR sees and manages only the teams they lead (`teams.readOwn` / `teams.manageOwn` / `members.manageOwn`); moving members between teams is ADMIN only (`members.move`). Members without an open membership are "unassigned" (a team archive closes its memberships).

### Colours (brief §5.2)
| Method | Path | Notes |
|---|---|---|
| GET | `/colors/available?excludeTeamId=` | Active colours **not** reserved by any ACTIVE/PENDING_APPROVAL team (the edited team's own colour is included when `excludeTeamId` is given). Reserved colours are never returned. |
| GET | `/colors` | ADMIN: whole palette with `inUseBy: {teamId, teamName} \| null` |
| POST | `/colors` | ADMIN [teamColorSchema] |
| PATCH | `/colors/:id` | ADMIN `{ name?, isActive? }` (retire/restore) |

### Teams
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/teams?status=&q=` | — | `TeamDto[]` (scoped) |
| POST | `/teams` | [createTeamSchema] | `201 TeamDto`. Admin → ACTIVE. Supervisor → self as leader, PENDING_APPROVAL when `REQUIRE_APPROVAL_FOR_SUPERVISOR_TEAMS`, else ACTIVE; admins notified (`TEAM_PENDING_APPROVAL`). `409 COLOR_TAKEN` on the partial-unique race. |
| GET | `/teams/:id` | — | `TeamDto & { members: MemberDto[] }` |
| PATCH | `/teams/:id` | [updateTeamSchema] | `TeamDto` (`COLOR_TAKEN`) |
| POST | `/teams/:id/approve` | — | `TeamDto` (ADMIN) |
| POST | `/teams/:id/reject` | `{ reason }` | `TeamDto` → ARCHIVED, colour freed, leader notified |
| POST | `/teams/:id/archive` | [archiveTeamSchema] | `TeamDto`, frees the colour, closes open memberships |
| POST | `/teams/:id/supervisor` | [changeSupervisorSchema] | `TeamDto`, closes/opens `team_supervisor_history` with one timestamp |
| GET | `/teams/:id/supervisor-history` | — | `{ supervisor, validFrom, validTo, reason }[]` |
| PUT | `/teams/:id/violation-visibility` | `{ mode: INHERIT\|SHOW\|HIDE }` | ADMIN (used in phase 3) |

### Members
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/members?q=&teamId=&unassigned=true&page=` | — | `Paginated<MemberDto>`; `q` matches name, exact national ID (blind index) or its last 4 digits |
| POST | `/teams/:id/members` | [memberInputSchema] | `201 MemberDto` (`NATIONAL_ID_TAKEN`) |
| GET | `/members/:id` | — | `MemberDto` (full ID for admins) |
| PATCH | `/members/:id` | [updateMemberSchema] | `MemberDto` |
| GET | `/members/:id/history` | — | `MembershipHistoryDto[]` |
| POST | `/members/move` | [moveMembersSchema] | `MemberDto[]`. One transaction, one timestamp: closes each open row (`valid_to = t`) and opens a new one (`valid_from = t`). `TEAM_NOT_ACTIVE`, `MEMBER_ALREADY_IN_TEAM` |
| POST | `/members/import` | [importMembersSchema] | `{ results: ImportRowResult[], committed: number }`. `commit=false` = preview only. Rows are parsed client-side from Excel or pasted text; keys: `fullName`, `nationalId`, `jobTitle`, `department` |

### Reference data (ADMIN write, any active user read)
`GET|POST /reference/departments`, `PATCH|DELETE /reference/departments/:id`, same for `/reference/job-titles` — [referenceItemSchema] → `ReferenceItemDto`. Delete = deactivate when referenced.

### Work cards (brief §8)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/cards/sizes` | [cardSizeSchema]; built-ins cannot be deleted |
| DELETE | `/cards/sizes/:id` | custom sizes only |
| GET/POST | `/cards/templates` | [cardTemplateSchema] → `CardTemplateDto` |
| PATCH/DELETE | `/cards/templates/:id` | delete = archive |
| GET/POST | `/logos` | `{ name, fileId, isDefault }` → `LogoDto` (file uploaded via `/files/presign` with `entityType: 'logo'`) |
| POST | `/logos/:id/default` · DELETE `/logos/:id` | |
| POST | `/cards/preview` | `{ templateId, teamIds?, memberIds?, includeSupervisors=true }` → `{ subjects: { memberId?, userId?, data: CardData }[] }`. `data.nationalId` is full only when the template has `maskNationalId=false`; `qrValue` = internal member/user UUID |
| POST | `/cards/batches` | [printBatchSchema] → `PrintBatchDto` (idempotent by `idempotencyKey`). Items with `saveBack` update the member record (name, job title, department). Audited `cards.printed` |
| GET | `/cards/batches?page=` · `/cards/batches/:id` | log of who printed what, when, with which template |
| GET | `/cards/batches/:id/pdf` | server PDF with exact page sizes (ADR-024; returns `501` until the pdf service is configured) |
## Phase 3 — violations (offline-first)

Scope: MONITOR creates and reads what they recorded; ADMIN reads and manages all; SUPERVISOR reads their own teams' violations (by `team_id_snapshot` ∈ teams they lead now) **only** when visibility resolves to SHOW: team override `SHOW|HIDE`, or `INHERIT` → setting `SUPERVISORS_CAN_SEE_VIOLATIONS`. When hidden, supervisor list endpoints return an empty page and detail returns 404.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/violations/roster` | — | `{ items: RosterEntry[], generatedAt }` — MONITOR/ADMIN; active members with current team; masked ID + last 4 only |
| GET | `/violation-types?active=true` | — | `ViolationTypeDto[]` |
| POST/PATCH | `/violation-types[/:id]` | [violationTypeSchema] | ADMIN |
| POST | `/violations` | [createViolationSchema] | `201 ViolationDto`, or `200` with the existing one when `clientUuid` already exists (idempotent). Resolves team/supervisor snapshots at `capturedAt` (ADR-014), sets `received_at`, drift flag. `MEMBER_HAS_NO_TEAM` is **not** an error: snapshot null is allowed and flagged in the UI |
| POST | `/files/presign` | `entityType: 'violation', entityId, kind: 'ID_CARD'\|'EVIDENCE'` | `PresignedUpload`. Rejects more than `VIOLATION_MAX_PHOTOS` evidence photos (`TOO_MANY_PHOTOS`) and more than one ID-card photo |
| POST | `/files/:id/confirm` | — | links the file to the violation (`violation_files`) when READY; idempotent |
| GET | `/violations?…` | [violationFilterSchema] + pagination | `Paginated<ViolationDto>` (scoped) |
| GET | `/violations/mine` | pagination | MONITOR: recorded by me |
| GET | `/violations/:id` | — | `ViolationDto` |
| GET | `/violations/:id/files/:fileId/url` | — | presigned GET; ID-card views audited `violation.id_photo_viewed` |
| PATCH | `/violations/:id` | [updateViolationSchema] | recorder within `VIOLATION_EDIT_WINDOW_MINUTES` after `received_at`, else ADMIN only (`EDIT_WINDOW_CLOSED`); audited with before/after |
| POST | `/violations/:id/status` | [changeViolationStatusSchema] | ADMIN; CANCELLED requires reason |
| POST | `/violations/:id/responses` | [violationResponseSchema] | SUPERVISOR (visible + own team) → notifies admins `VIOLATION_OBJECTION` |
| GET | `/violations/stats?…` | [violationFilterSchema] | `ViolationStats` (ADMIN) — every chart uses the same filters |
| GET | `/violations/export.xlsx?…` | filters | Excel per ADR-019 (RTL, **no freeze panes**), audited `violations.exported` |
| GET | `/violations/dashboard.pdf?…` | filters | PDF via the pdf service (501 until configured) |
| PUT | `/teams/:id/violation-visibility` | `{ mode }` | (already in phase 2) |

### Phase 3 implementation notes (as built — docs/phase-3-backend.md, ADR-046..050)
- A `clientUuid` already recorded by another user → 409 `CONFLICT_VERSION`. Inactive member/type → 400 `VALIDATION_FAILED` with field errors. `TOO_MANY_PHOTOS` → 409; `EDIT_WINDOW_CLOSED` → 403; a PDF for a violation photo → 415.
- Photo uploads for a violation: recorder or admin only (else 404). One ID-card photo per violation is also enforced by a partial unique index.
- `/violations/mine` accepts the same filters; `/violations` also takes `q` (member name) and `sort`. `ViolationFileDto.id` is the file id used in `/violations/:id/files/:fileId/url`. ID-card URLs need `violations.viewIdPhoto` (supervisors get 403) and are audited; evidence views are not (ADR-050).
- Stats: `thisWeek`/`previousWeek` ignore the date range but keep other filters; `byTeam` omits violations without a team snapshot; `topMembers` counts members with more than one violation; `pointsTruncated` when > 5,000 points.
- Excel export capped at 50,000 rows, two RTL sheets, no freeze panes.
- Audit actions: `violation_type.created|updated`, `violation.updated|status_changed|response_added|id_photo_viewed`, `violations.exported|dashboard_exported|photos_purged`. Notification: `VIOLATION_OBJECTION`.

## Phase 4 — projects, tasks, Gantt

Scope: ADMIN creates and manages projects and tasks. **Superseded by A9 (ADR-092):** SUPERVISOR no longer sees projects; they reach only the tasks assigned to them (see "A9 — projects"). They may change **progress, status** of those tasks and comment (ADR-007).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/projects?status=&q=` | — | `ProjectDto[]` (scoped) |
| POST | `/projects` | [createProjectSchema] | `201 ProjectDto` (default calendar when none) |
| GET/PATCH/DELETE | `/projects/:id` | [updateProjectSchema] | delete = archive |
| GET/POST/DELETE | `/projects/:id/access[/:userId]` | [grantProjectAccessSchema] | ADMIN |
| GET | `/projects/:id/gantt` | — | `{ project, tasks: TaskDto[], dependencies: DependencyDto[], calendar: CalendarDto }` — one call for the whole chart |
| POST | `/projects/:id/tasks` | [createTaskSchema] | `201 TaskDto` (+ any rolled-up parents in `affected: TaskDto[]`) |
| PATCH | `/tasks/:id` | [updateTaskSchema] | `{ task, affected: TaskDto[] }` — server re-runs the engine (auto-schedule) and returns every changed task; `409 CONFLICT_VERSION` |
| POST | `/projects/:id/tasks/batch` | [taskBatchSchema] | `{ tasks: TaskDto[] }` — one drag-end, one transaction, all versions checked (ADR-017); server validates by re-running `@nuzli/scheduling` |
| DELETE | `/tasks/:id` | — | archives the task and its subtree; `affected` |
| POST | `/projects/:id/dependencies` | [createDependencySchema] | `201 DependencyDto` + `affected`; `DEPENDENCY_CYCLE` (409, `details.path`), `DEPENDENCY_SELF`, `DEPENDENCY_EXISTS`; only FS accepted from the UI |
| DELETE | `/dependencies/:id` | — | `204` |
| GET | `/tasks/mine` | — | supervisor's assigned tasks across projects |
| GET/POST | `/tasks/:id/comments` | [taskCommentSchema] | mentions notify `TASK_MENTIONED` |
| GET | `/tasks/:id/activity` | — | `ActivityDto[]` (from the audit log) |
| GET/POST/DELETE | `/tasks/:id/attachments[/:fileId]` | `{ fileId }` | files uploaded with `entityType: 'task'` |
| GET | `/projects/:id/export.xlsx` | — | tasks to Excel (ADR-019) |
| GET/POST/PATCH | `/calendars[/:id]` | [calendarSchema] | ADMIN |
| POST/DELETE | `/calendars/:id/exceptions[/:exId]` | [calendarExceptionSchema] | ADMIN |

### Phase 4 implementation notes (as built — docs/phase-4-backend.md, ADR-056..060)
- `POST /projects/:id/tasks` → `TaskDto & { affected }`; `POST /projects/:id/dependencies` → `DependencyDto & { affected }`; `DELETE /tasks/:id` → 200 `{ archivedIds, affected }`; `DELETE /projects/:id` → 200 archived project.
- `409 CONFLICT_VERSION` details `{ refresh: 'tasks', conflicts: [{ id, currentVersion | null }] }`. `DEPENDENCY_SELF` → 400; non-FS → 400 `DEPENDENCY_TYPE_DISABLED`. New codes: `TASK_PARENT_INVALID`, `PROJECT_ARCHIVED`, `CALENDAR_DATE_EXISTS`.
- Extra routes: `GET /tasks/:id`, `GET /tasks/:id/attachments/:fileId/url`, `DELETE /tasks/:id/attachments/:fileId`, `GET /calendars/:id`. `GET /projects` default = non-archived (`status=ARCHIVED|ALL`). Calendars include `isDefault`. `GET /tasks/mine` → `MyTaskDto` (+ `project`, `overdue`, `dueSoon`).
- A TASK that gets a child becomes a GROUP; a milestone cannot be a parent. Starts on non-working days snap forward; `endDate` alone sets the duration. WBS-only changes don't bump `version`.
- Supervisors may comment on any task of a project they can see; progress/status only on their own tasks.
- Audit: `project.created|updated|archived|access_granted|access_revoked|exported`, `task.created|updated|archived|moved|comment_added|attachment_added|attachment_removed`, `dependency.created|deleted`, `calendar.created|updated`, `calendar_exception.created|deleted`.

Notifications: `TASK_ASSIGNED` on (re)assignment, `TASK_MENTIONED`, and a daily scheduled job for `TASK_DUE_SOON` (end within 2 working days) and `TASK_OVERDUE` (end passed, not DONE), each sent once per task (`due_soon_notified_at`, `overdue_notified_at`).

## A9 — projects (owner request A9, ADR-092..097)

Schemas and DTO types are in `@nuzli/shared` (`schemas/projects.ts` additions and `schemas/projects-a9.ts`). Everything is additive: new DTO fields are optional in the shared types (older clients compile) and always sent by the API.

### Supervisor scope (ADR-092)
- SUPERVISOR no longer holds `projects.readGranted`: `GET /projects`, `/projects/:id`, `/gantt`, `/export.xlsx`, `/budget`, `/people`, `/dashboard`, `/calendar`, `/labels`, `/custom-fields`, `/project-templates`, `/portfolios`, `/reports/projects`, `/workload` → **403**. `project_access` rows are kept (admin routes unchanged) but grant nothing.
- Supervisors keep, **for tasks assigned to them only** (any other task → **404**): `GET /tasks/mine`, `GET /tasks/:id`, `PATCH /tasks/:id` (progress/status), `GET/POST /tasks/:id/comments`, `POST /tasks/:id/comments/read`, `GET /tasks/:id/activity`, `GET/POST /tasks/:id/attachments` (+ `/:fileId/url`, delete own upload), `GET /tasks/:id/checklist`, `PATCH /tasks/:id/checklist/:itemId` (`done` only), `GET /tasks/:id/labels`, `GET /tasks/:id/custom-fields`, `GET/POST /tasks/:id/time-entries`, `GET /me/time-entries`, `PATCH/DELETE /time-entries/:id` (own), `GET /hub`, `GET /attachments`.
- Mentions: only users who can open the task (active admins + the assignee); others → 400 `VALIDATION_FAILED`.

### Changed request schemas
| Schema | New fields |
|---|---|
| [createProjectSchema] | `budget?: number \| null` (≥ 0, 2 decimals), `currency?: 'XXX'` (default `SAR`), `fromTemplateId?: uuid` |
| [updateProjectSchema] | `budget?`, `currency?` (no `fromTemplateId`) |
| [createTaskSchema] / [updateTaskSchema] | `plannedCost?`, `actualCost?` (≥ 0, 2 decimals; ignored on groups), `deadline?: 'YYYY-MM-DD' \| null`, `barColor?: '#RRGGBB' \| null` |
| [taskBatchSchema] `changes[]` | `name?`, `priority?`, `assigneeId?: uuid \| null`, `plannedCost?`, `actualCost?`, `deadline?`, `barColor?`, `labelIds?: uuid[]` (replaces the set) |
| [taskCommentSchema] | `replyToId?: uuid \| null` (a comment of the same task, else 400 `COMMENT_REPLY_INVALID`) |

### Changed responses
- `ProjectDto` + `budget: number|null`, `currency`, `plannedCost`, `actualCost`, `costVariance` (= planned − actual), `budgetVariance` (= budget − actual, null without budget), `budgetUsedPct` (actual / budget × 100, 2 decimals; null without or with a zero budget), `isTemplate`.
- `TaskDto` + `plannedCost`, `actualCost`, `overBudget`, `deadline`, `deadlinePassed` (deadline < today Riyadh and not DONE), `barColor`, `labelIds: string[]`, `checklist: { total, done }`, `customValues: Record<fieldId, value>`. Groups carry the **sum** of their children's costs (persisted, versioned like dates).
- `GanttDto` + `labels: LabelDto[]`, `customFields: CustomFieldDto[]`.
- `TaskCommentDto` + `replyTo: { id, authorName, bodyPreview } | null`.
- `TaskUpdateResult`, `TaskBatchResult` + `previous: TaskPreviousMap`; `TaskArchiveResult` + `previous`, `deletedDependencies: DependencyDto[]`.
- `GET /projects` excludes templates. `DueRunResult` (internal) + `deadlinePassed`.

### Undo contract (ADR-095)
Every write that changes existing tasks returns `previous: Record<taskId, TaskPrevious>` — for each changed task (edited, shifted by the engine or rolled up) exactly the fields that changed, with their **before** values in wire format (`startDate`, `endDate`, `durationDays`, `parentId`, `sortOrder`, `name`, `type`, `progress`, `status`, `priority`, `assigneeId`, `description`, `plannedCost`, `actualCost`, `deadline`, `barColor`, `labelIds`). Inverse = `POST /projects/:id/tasks/batch { changes: Object.entries(previous).map(([id, p]) => ({ id, version: <version from the same response>, ...p })) }`; a `409` ends the redo chain. Inverse of a create/duplicate = `DELETE /tasks/:id` of the new ids; inverse of an archive = `POST /projects/:id/tasks/restore { ids: archivedIds }` then re-create `deletedDependencies`. `type` in `previous` (automatic GROUP promotion) is informational.

### Endpoints
| Method | Path | Permission | Body / query | Response |
|---|---|---|---|---|
| GET | `/projects/:id/budget` | readAll | — | `BudgetReportDto` (totals, `budgetVariance`, `budgetUsedPct`, `loggedMinutes`, `byGroup` (roots), `byAssignee` (+`loggedMinutes`), `byLabel` (a task with 2 labels counts in both; `label: null` = none), `overBudgetTasks`) |
| GET | `/projects/:id/people` | readAll | — | `ProjectPersonDto[]` (assignee + team colour, `taskCount`, `doneCount`, `overdueCount`, `progress`, costs, `budgetShare` %, `loggedMinutes`; `assignee: null` = unassigned) |
| GET | `/projects/:id/dashboard` | readAll | — | `ProjectDashboardDto` (`kpis`, `statusDistribution`, `priorityDistribution`, `overdue` top 20 with `daysOverdue`, `budgetBurn.plannedByWeek` (planned cost spread over working days, Sunday weeks, cumulative), `upcoming` deadlines/ends/milestones in 14 days) |
| GET | `/projects/:id/calendar?from&to` | readAll | [calendarRangeQuerySchema] ≤ 366 days | `ProjectCalendarDto` (calendar + tasks overlapping the range or with a deadline in it) |
| GET/POST | `/projects/:id/labels` | readAll / tasks.manage | [labelSchema] `{ name, color }` | `LabelDto[]` / `201 LabelDto`; duplicate name → 409 `NAME_TAKEN` |
| PATCH/DELETE | `/labels/:id` | tasks.manage | [updateLabelSchema] | `LabelDto` / `200 { affected: TaskDto[], previous }` (removed from its tasks with `version + 1`) |
| GET | `/tasks/:id/labels` | task read | — | `LabelDto[]` |
| POST | `/tasks/:id/labels` | tasks.manage | [taskLabelSchema] `{ labelId }` | `200 TaskUpdateResult`; other project's label → 400 `LABEL_NOT_IN_PROJECT` |
| DELETE | `/tasks/:id/labels/:labelId` | tasks.manage | — | `200 TaskUpdateResult` |
| GET/POST | `/projects/:id/custom-fields` | readAll / tasks.manage | [customFieldSchema] `{ name, type: TEXT\|NUMBER\|DROPDOWN\|DATE\|CHECKBOX, options?, sort? }` | `CustomFieldDto[]` / `201`; DROPDOWN without options → 400 `CUSTOM_FIELD_OPTIONS_REQUIRED` |
| PATCH/DELETE | `/custom-fields/:id` | tasks.manage | [updateCustomFieldSchema] (type fixed) | `CustomFieldDto` / `204` (values dropped) |
| GET | `/tasks/:id/custom-fields` | task read | — | `Array<CustomFieldDto & { value }>` |
| PUT | `/tasks/:id/custom-values/:fieldId` | tasks.manage | [customValueSchema] `{ value }` (`null` clears) | `CustomValueDto`; wrong type → 400 `CUSTOM_FIELD_VALUE_INVALID` (`normalizeCustomValue` in shared) |
| GET/POST | `/tasks/:id/checklist` | task read / tasks.manage | [checklistItemSchema] `{ text, afterId? }` | `ChecklistItemDto[]` / `201` |
| PATCH/DELETE | `/tasks/:id/checklist/:itemId` | manage or assignee (`done` only) / tasks.manage | [updateChecklistItemSchema] `{ text?, done? }` | `ChecklistItemDto` (`doneBy`, `doneAt`) / `204` |
| POST | `/tasks/:id/checklist/reorder` | tasks.manage | [checklistReorderSchema] `{ ids }` (all items) | `200 ChecklistItemDto[]` |
| POST | `/tasks/:id/duplicate` | tasks.manage | [duplicateTaskSchema] `{ withSubtasks = true }` | `201 DuplicateTaskResult { tasks, affected, idMap, dependencies, previous }` — names + « (نسخة)», placed right after the original, inner deps remapped, labels/custom values/checklist copied, no comments/attachments/time |
| POST | `/projects/:id/tasks/bulk` | tasks.manage | [taskBulkSchema] `{ ids (≤1000), versions: Record<id, version>, patch: { status?, priority?, assigneeId?, labelIdsAdd?, labelIdsRemove?, progress?, barColor?, shiftWorkingDays? } }` | `200 TaskBulkResult { tasks, previous }`; any stale version → 409, nothing written |
| POST | `/projects/:id/tasks/bulk-archive` | tasks.manage | [taskBulkArchiveSchema] `{ ids, versions }` | `200 TaskBulkArchiveResult { archivedIds, affected, previous, deletedDependencies }` |
| POST | `/projects/:id/tasks/restore` | tasks.manage | [taskRestoreSchema] `{ ids }` | `200 TaskRestoreResult { restored, affected, previous }`; parent still archived → 400 `TASK_PARENT_INVALID` |
| GET/PUT/DELETE | `/me/view-prefs` | profile.update | GET `?projectId&key`; PUT [putViewPrefSchema] `{ projectId?, key, value }`; DELETE `?projectId&key` | `ViewPrefDto[]` / `ViewPrefDto` / `204`; JSON > 32 KB → **413** `VIEW_PREF_TOO_LARGE`; keys like `gantt.columns`, `gantt.views`, `list.columns` |
| POST | `/projects/:id/save-as-template` | projects.create | [saveAsTemplateSchema] `{ name?, description? }` | `201 ProjectDto` (`isTemplate: true`) |
| GET | `/project-templates` | readAll | — | `ProjectDto[]` |
| POST | `/projects` + `fromTemplateId` | projects.create | [createProjectSchema] | `201 ProjectDto`; not a template → 409 `NOT_A_TEMPLATE` |
| GET/POST | `/portfolios` | readAll / projects.manage | [portfolioSchema] `{ name, description?, projectIds? }` | `PortfolioDto[]` / `201 PortfolioDto`; name taken → 409 |
| GET | `/portfolios/:id` | readAll | — | `PortfolioSummaryDto` (`projects[]` with `overdueCount`, `leafCount`, `doneCount`; `totals`: progress weighted by leaf count, budget, costs, date span, overdue, `byStatus`) |
| PATCH/DELETE | `/portfolios/:id` | projects.manage | [updatePortfolioSchema] (`projectIds` replaces) | `PortfolioDto` / `204` |
| POST / DELETE | `/portfolios/:id/projects[/:projectId]` | projects.manage | [portfolioProjectSchema] `{ projectId }` | `200 PortfolioDto` |
| GET/POST | `/tasks/:id/time-entries` | task read / manage or assignee | [timeEntrySchema] `{ date, minutes 1..1440, note?, userId? (admin) }` | `TimeEntryDto[]` / `201`; supervisor on another task → 404, `userId` by a supervisor → 403 |
| PATCH/DELETE | `/time-entries/:id` | owner or admin | [updateTimeEntrySchema] | `TimeEntryDto` / `204`; someone else's entry → 404 |
| GET | `/me/time-entries?from&to` | manage or updateAssigned | [timeRangeQuerySchema] (default last 31 days, ≤ 366) | `TimeEntryDto[]` |
| GET | `/workload?from&to&userIds=a,b` | readAll | [workloadQuerySchema] (≤ 92 days) | `WorkloadDto` (per user per day `assignedMinutes` = the real working minutes of each assigned TASK that day — see «A9 — imports, exports, hours» —, `loggedMinutes`, `taskCount`, `capacityMinutes`) |
| GET | `/reports/projects?status=` | readAll | [projectReportQuerySchema] | `ProjectReportRow[]` (`project`, `leafCount`, `doneCount`, `overdueCount`, `deadlinePassedCount`, `milestoneCount`) |
| GET | `/hub?projectId&filter=all\|new\|mentioned\|assigned\|created&q&page&pageSize` | tasks.comment | [hubQuerySchema] | `HubPageDto { items: HubItemDto[], total, page, pageSize, counts: Record<filter, n>, unreadTotal }`; item = `task`, `project`, `path` (ancestor names), `commentCount`, `unreadCount`, `lastReadAt`, `lastComment` (preview) |
| POST | `/tasks/:id/comments/read` | tasks.comment | — | `200 CommentReadDto { taskId, lastReadAt }` (posting a comment also marks it read for the author) |
| GET | `/attachments?projectId&type=image\|pdf\|other&uploadedBy&from&to&q&page&pageSize` | readAll or readAssigned | [attachmentBrowseQuerySchema] | `Paginated<AttachmentBrowseDto>` (file meta + `task` + `project` + `uploadedBy`); download via `GET /tasks/:id/attachments/:fileId/url` |

### New error codes
`LABEL_NOT_IN_PROJECT` (400), `CUSTOM_FIELD_VALUE_INVALID` (400), `CUSTOM_FIELD_OPTIONS_REQUIRED` (400), `VIEW_PREF_TOO_LARGE` (413), `NOT_A_TEMPLATE` (409), `TIME_ENTRY_NOT_ALLOWED` (403), `COMMENT_REPLY_INVALID` (400).

### Notifications
`TASK_COMMENTED` → the assignee and earlier commenters who can still open the task, never the author; users mentioned in the same comment get only `TASK_MENTIONED`. `TASK_DEADLINE_PASSED` → once per deadline (`deadline_notified_at`, reset when the deadline changes), to the assignee and the project owner, from the daily 07:00 job. Payloads carry `taskId, taskName, projectId, projectName` (+ `commentId, authorName, preview` with national-ID-like numbers masked, or `deadline, endDate`). Mention/comment e-mails link to `/hub?task=`.

### Audit actions
`task.duplicated`, `task.restored`, `task.custom_value_set`, `task.checklist_reordered`, `label.created|updated|deleted`, `custom_field.created|updated|deleted`, `checklist_item.created|updated|deleted`, `project.saved_as_template`, `portfolio.created|updated|deleted`, `time_entry.created|updated|deleted`. Bulk/batch writes reuse `task.updated` / `task.moved` with `after.bulk` / `after.batch`; label changes appear as `labelIds` in `task.updated`. View preferences and read marks are personal UI state and not audited (ADR-097).

## A9 — teams, org, violations (owner request A9, ADR-100..104)

Schemas and DTO types are in `@nuzli/shared` (`schemas/teams.ts`, `schemas/org.ts`, `schemas/violations.ts`). New DTO fields are optional in the shared types and always sent by the API. **Two existing types changed** because the owner's decision requires it: `ViolationDto.member` is now `… | null` and `createViolationSchema.memberId` is optional.

### Several supervisors per team (ADR-100)
"Leads the team" = an open row in `team_supervisors` (primary or not). It opens team reads/writes (`teams.readOwn`/`manageOwn`), members (`members.manageOwn`), member photos, the colour picker's "keep own colour", team lists and violation visibility (`violations.readOwnTeams`). `teams.supervisor_id` stays = the primary. `ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR=false` applies per person (primary or co-supervisor) → 409 `MULTIPLE_TEAMS_DISABLED` with `details.userId`.

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/teams` | teams.create / createOwn | [createTeamSchema] + `supervisorIds?: uuid[]` (≤ 10), `primarySupervisorId?: uuid` (one of them), `orgUnitId?: uuid` (admin). `supervisorId` and `newSupervisor` still work; primary default = the new supervisor › `supervisorId` › the first id. A supervisor always creates for self only. | `201 TeamDto` |
| GET | `/teams/:id/supervisors` | readAll / readOwn | — | `TeamSupervisorsDto { current: TeamSupervisorDto[], history: SupervisorHistoryDto[] }` |
| POST | `/teams/:id/supervisors` | teams.manageAll | [addTeamSupervisorSchema] `{ userId, isPrimary = false, reason? }` | `201 TeamDto`; already leading → 409 `SUPERVISOR_ALREADY_IN_TEAM`; not an active SUPERVISOR → 400 `NOT_A_SUPERVISOR` |
| DELETE | `/teams/:id/supervisors/:userId` | teams.manageAll | [removeTeamSupervisorSchema] `{ reason, newPrimaryUserId? }` | `200 TeamDto`; the primary without a successor → 409 `PRIMARY_SUPERVISOR_REQUIRED`; the last one → 409 `LAST_SUPERVISOR`; a successor who is not a current supervisor → 400 |
| POST | `/teams/:id/supervisors/:userId/primary` | teams.manageAll | [setPrimarySupervisorSchema] `{ reason? }` | `200 TeamDto` (the old primary stays as co-supervisor) |
| POST | `/teams/:id/supervisor` (legacy) | teams.manageAll | [changeSupervisorSchema] | `200 TeamDto` — replaces the **primary** (the old primary stops leading; co-supervisors are kept) |
| GET | `/teams/:id/supervisor-history` | readAll / readOwn | — | `SupervisorHistoryDto[]` of **all** supervisors (+ `isPrimary`); a primary change closes and reopens rows at one instant |
| PATCH | `/teams/:id` | manageAll / manageOwn | [updateTeamSchema] + `orgUnitId?: uuid \| null` (admin only, else 403) | `TeamDto` |

`TeamDto` + `supervisors: TeamSupervisorDto[]` (`{ id, fullName, isPrimary, hasPhoto, since }`, primary first) and `orgUnit: { id, name, kind } | null`. `TeamDetailDto` + `foreman: { id, fullName } | null`; members are sorted foreman first. `TEAM_APPROVED` / `TEAM_REJECTED` go to every current supervisor. Card preview with `includeSupervisors` → one card per current supervisor (primary first). The task assignee colour = the first ACTIVE team the user leads (primary teams first).

### Worker foreman — مشرف عمّال (ADR-101)
`team_memberships.role WORKER | FOREMAN` (default WORKER; at most one open FOREMAN per team). A member record only: no account and no permission. A member linked to a user is refused (409 `FOREMAN_HAS_ACCOUNT`; a DB trigger guards both directions).

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/teams/:id/foreman` | manageAll / manageOwn (a leading supervisor) | [setForemanSchema] `{ memberId }` | `200 TeamDetailDto`; not a current member → 409 `FOREMAN_NOT_MEMBER`; replaces the previous foreman |
| DELETE | `/teams/:id/foreman` | manageAll / manageOwn | — | `200 TeamDetailDto` (no foreman → no-op) |

`MemberDto.isForeman: boolean`. Moving the foreman to another team (or archiving the team) ends the flag; the new membership is WORKER; audited `team.foreman_cleared` with `after.reason`.

### Organisational structure (ADR-102)
`org.read` = ADMIN + SUPERVISOR (MONITOR: none); `org.manage` = ADMIN.

| Method | Path | Permission | Body / query | Response |
|---|---|---|---|---|
| GET | `/org?includeArchived=true` | org.read (archived units only for org.manage) | [orgTreeQuerySchema] | `OrgTreeDto { units: OrgUnitDto[] (parents first, siblings by sort), generatedAt }`. Unit = `{ id, parentId, name, kind, code, sort, archivedAt, positions: OrgPositionDto[], teams: OrgTeamLinkDto[] }`; position = `{ id, unitId, title, holder: { type: USER \| MEMBER, id, fullName, hasPhoto, role?, team? } \| null, reportsToPositionId, sort }`; team link = `{ id, name, status, color, memberCount, supervisors[] }` |
| POST | `/org/units` | org.manage | [createOrgUnitSchema] `{ parentId = null, name, kind: DEPARTMENT \| SECTION \| UNIT \| TEAM_GROUP, code?, sort? }` | `201 OrgUnitDto`; archived parent → 409 `ORG_UNIT_ARCHIVED`; live code taken → 409 `NAME_TAKEN` |
| PATCH | `/org/units/:id` | org.manage | [updateOrgUnitSchema] `{ name?, kind?, code?: string \| null, archived?: boolean }` | `OrgUnitDto`; archiving with live children or linked live teams → 409 `ORG_UNIT_NOT_EMPTY` |
| POST | `/org/units/:id/move` | org.manage | [moveOrgUnitSchema] `{ parentId: uuid \| null, sort? }` | `200 OrgUnitDto`; under itself or a descendant → 409 `ORG_CYCLE` |
| DELETE | `/org/units/:id` | org.manage | — | `204`; any child unit, position or team → 409 `ORG_UNIT_NOT_EMPTY` |
| POST | `/org/positions` | org.manage | [createOrgPositionSchema] `{ unitId, title, holderUserId?, holderMemberId?, reportsToPositionId?, sort? }` (one holder, or vacant) | `201 OrgPositionDto` |
| PATCH | `/org/positions/:id` | org.manage | [updateOrgPositionSchema] (naming one holder clears the other; both null = vacant) | `OrgPositionDto`; a loop → 409 `ORG_REPORTS_CYCLE` |
| POST | `/org/positions/:id/move` | org.manage | [moveOrgPositionSchema] `{ unitId?, reportsToPositionId?, sort? }` | `200 OrgPositionDto` |
| DELETE | `/org/positions/:id` | org.manage | — | `204` (its reports become top-level) |

### Violations without a person + ID-card OCR (ADR-103, ADR-104)
- [createViolationSchema]: `memberId?` (omit when the person is unknown) and `expectedPersonPhotos` (= 1, default 1). Without a member the violation has **no team snapshot** (team, supervisor and supervisors empty) until it is assigned, so supervisors never see it (their scope needs a team).
- Photos: `kind: 'PERSON'` is added to [presignUploadSchema] (violations only, one per violation, partial unique index). ID_CARD (one) and EVIDENCE (1..`VIOLATION_MAX_PHOTOS`) are unchanged. The after-window allowance uses `expectedPersonPhotos` (pre-A9 violations: 0). A confirmed ID_CARD queues the OCR job.
- `ViolationDto` + `assigned: boolean`, `supervisors: { id, fullName }[]` (every supervisor at `capturedAt`), `assignedAt`, `assignedBy`, `ocrStatus: PENDING | RUNNING | DONE | FAILED | null` (admin and recorder only), `expectedPhotos.person`; `member` is `null` while unassigned.
- [violationFilterSchema] + `assigned: 'true' | 'false'` (list, mine, stats, export). `ViolationStats` + `unassigned` (same filters); `byTeam` and `topMembers` exclude unassigned rows. In the Excel export the person column reads «— لم تُسند إلى شخص بعد».

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| GET | `/violations/:id/ocr` | violations.manage, or the recorder (violations.create) | — | `ViolationOcrDto { status: … \| 'NONE', attempts, extractedAt, error?, fields: { nationalId: { value (masked unless nationalIds.readFull), masked, full, confidence, kind } \| null, name, nameLatin, birthDate { value, calendar: HIJRI \| GREGORIAN, confidence }, expiryDate, nationality }, suggestedMembers: ViolationSuggestionDto[], suggestedUsers }`. Suggestions only while unassigned: the exact blind-index match first, then name similarity ≥ 0.45 (top 5) among active members; `suggestedUsers` for admins only. `Cache-Control: no-store`. Every call is audited `violation.ocr_viewed` (`after.fullNationalId`). |
| POST | `/violations/:id/ocr/retry` | violations.manage | — | `202 { queued: true }` |
| POST | `/violations/:id/assign` | violations.manage, or the recorder (any time) | [assignViolationSchema] `{ memberId }` | `200 ViolationDto` — team, primary and all supervisors resolved **at captured_at**; another member already set → 409 `VIOLATION_ALREADY_ASSIGNED`; the same member → no-op |
| POST | `/violations/:id/unassign` | violations.manage | [unassignViolationSchema] `{ reason? }` | `200 ViolationDto` (member and snapshot cleared) |
| POST | `/violations/:id/register-member` | members.manage, or members.manageOwn leading `teamId` | [registerViolationMemberSchema] `{ fullName, nationalId, teamId?, jobTitleId?, jobTitleText?, departmentId?, departmentText?, usePersonPhoto = true }` | `201 RegisterViolationMemberResultDto { member: MemberDto, violation: ViolationDto \| null }`. The membership starts at `capturedAt` (so the snapshot is that team); the PERSON photo is copied to a new `member-photos/…` object. No `teamId` → admins only (else 403). A duplicate ID → admins 409 `NATIONAL_ID_TAKEN` + `details.existingMemberId`, others `NATIONAL_ID_NOT_ACCEPTED`. Rate limited 30/min. |

OCR (ADR-104): server-side tesseract.js 5 with self-hosted `ara+eng` LSTM data (`@tesseract.js-data/*`, `4.0.0_best_int`, never a CDN) and an in-process queue (`OCR_CONCURRENCY` 1–2, `OCR_MAX_ATTEMPTS` 3, back-off 30 s ×4, a start-up sweep and a one-minute tick; `OCR_ENABLED=false` keeps jobs PENDING). Extracted fields are stored encrypted (`violation_ocr.extracted_enc`, AES-256-GCM) with `id_number_hash` (HMAC); OCR text is never stored or logged. Retention deletes OCR rows with the photos. Key rotation (`rotate-national-id-key`) also re-encrypts `violation_ocr`.

### New error codes
`SUPERVISOR_ALREADY_IN_TEAM`, `PRIMARY_SUPERVISOR_REQUIRED`, `LAST_SUPERVISOR`, `FOREMAN_NOT_MEMBER`, `FOREMAN_HAS_ACCOUNT`, `ORG_CYCLE`, `ORG_REPORTS_CYCLE`, `ORG_UNIT_NOT_EMPTY`, `ORG_UNIT_ARCHIVED`, `VIOLATION_ALREADY_ASSIGNED` (all 409). `PERSON_PHOTO_REQUIRED` is reserved for the client's completeness check.

### Audit actions
`team.supervisor_added`, `team.supervisor_removed`, `team.primary_supervisor_changed`, `team.foreman_set`, `team.foreman_cleared`, `org.unit_created`, `org.unit_updated`, `org.unit_moved`, `org.unit_deleted`, `org.position_created`, `org.position_updated`, `org.position_moved`, `org.position_deleted`, `violation.assigned` (`after.via: assign | register`), `violation.unassigned`, `violation.member_registered`, `violation.ocr_viewed`. `member.created` and `member.photo_updated` carry `fromViolationId` when the member is registered from a violation; `violations.photos_purged` gains `ocrRemoved`.


## A9 — imports, exports, hours (owner request A9, ADR-109..112)

Schemas and DTO types are in `@nuzli/shared` (`schemas/projects.ts` hours additions, `schemas/imports.ts`). New DTO fields are optional in the shared types and always sent by the API; DAY projects behave exactly as before.

### Hours (ADR-109)
- `projects.duration_unit` `DAY | HOUR` (default DAY). `calendars.working_hours` jsonb (default `[{09:00–13:00},{14:00–18:00}]`), `calendar_exceptions.working_hours` (a special working day's hours, null = the calendar's). `task_dependencies.lag_minutes`.
- **Dual representation of task dates:** every task keeps `start_date`/`end_date` (DATE) — for HOUR tasks the day of the first and of the last working minute, so day-based queries (overdue, reports, calendar ranges) work for both units. HOUR tasks also store `start_at`/`end_at` (timestamptz instants of Asia/Riyadh wall times; `end_at` = end of the last working minute, exclusive) and `duration_minutes`; DAY tasks have the three NULL. Enforced by `tasks_hour_columns_chk` (all three set or all null), `tasks_hour_milestone_chk`, and two constraint triggers **deferred to commit** (`tasks_unit_columns_chk`, `projects_unit_columns_chk`): HOUR project ⇔ hour columns set.
- **On the wire** (HOUR projects only): `TaskDto.startDate`/`endDate` are local `YYYY-MM-DDTHH:MM` (the engine's representation) and the same values are in `startAt`/`endAt`; `durationHours` (working hours, 4 decimals); `durationDays` = working days the task touches. `DependencyDto.lagHours`. `ProjectDto.durationUnit`, `CalendarDto.workingHours`, `exceptions[].workingHours`. Requests accept `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (seconds and `+03:00` tolerated, `Z` refused): a bare date in an HOUR project = the first working minute of that day; a date-time in a DAY project keeps its date. `durationHours` wins over `durationDays` in HOUR projects; `lagHours` wins over `lagDays`. The undo contract (`previous`) carries `startDate`/`endDate`/`durationHours` in the same format.
- The engine runs with `durationUnit` everywhere (create, PATCH, batch, bulk shift — one working day = the calendar's standard day of minutes —, duplicate, templates, restore, calendar changes). A non-milestone HOUR task lasts at least 15 working minutes. Changing a calendar's `workingHours` re-derives its projects. A template keeps its unit; a project created from it takes the template's unit.
- Overdue / due-soon flags and notifications compare the **day** of the end (daily job). `GET /workload`: a DAY task counts the real working minutes of each working day on its project calendar (480 with the default hours, a short exception day its own), an HOUR task only the minutes it covers that day; `days[].capacityMinutes` = the default calendar's minutes that day; `capacityMinutesPerDay` = its standard day.

| Schema | New fields |
|---|---|
| [createProjectSchema] | `durationUnit?: 'DAY' \| 'HOUR'`, `workingDays?: number[]` (0 = Sunday … 6, ≥ 1 day), `workingHours?: [{ start: 'HH:MM', end: 'HH:MM' }]` (1–6 non-overlapping, `24:00` allowed). Days/hours different from the base calendar (`calendarId` or the default) create a calendar «تقويم {name}» with the base calendar's holidays (audited `calendar.created`); identical ones reuse it. |
| [updateProjectSchema] | `durationUnit?` — a different unit converts the project (same as `/convert`). |
| [createTaskSchema] / [updateTaskSchema] / [taskBatchSchema] | `startDate` (and batch `endDate`) date or local date-time; `durationHours?: number` |
| [createDependencySchema] | `lagHours?: number` (−8760…8760) |
| [calendarSchema] / [updateCalendarSchema] | `workingHours?` |
| [calendarExceptionSchema] | `workingHours?: […] \| null` |

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/projects/:id/convert` | projects.manage | [convertProjectSchema] `{ durationUnit }` | `200 ProjectDto`. Engine conversions (`tasksToHours`/`tasksToDays`, `dependenciesToHours`/`…ToDays`): each task keeps its working days; DAY → HOUR gives it the full working hours of those days, HOUR → DAY counts a partial day as a whole day; lags × / ÷ the standard day (rounded to days). Archived tasks are converted too. Then the full forward pass. **Milestone caveat:** a DAY milestone occupies its day (an FS successor starts the next working day), an HOUR milestone is an instant at the first working minute of its day — converted dates are kept (the pass never pulls a task earlier), but links edited afterwards follow the new unit's rule. Same unit → unchanged. Audited `project.converted` `{ before: { durationUnit }, after: { durationUnit, tasks } }`; tasks get `task.moved` with `cause: 'project.converted'`. |

### Imports (ADR-110, ADR-111, ADR-112)
Flow: upload with `POST /files/presign { entityType: 'import', contentType, sizeBytes }` → PUT → `POST /files/:id/confirm` → `POST /projects/import` → preview (kept **1 hour** in `import_previews`) → `POST /projects/import/commit`.
- **Uploads `entityType: 'import'`:** admin only (`projects.create`), no `entityId`/`kind`, ≤ **20 MB**, `contentType` one of `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (.xlsx), `text/csv`, `application/xml` / `text/xml` (.xml), `application/vnd.ms-project` (.mpp) — the client sends the canonical type for the extension. Confirm checks the structure (xlsx = ZIP with `xl/workbook.xml`; .mpp = OLE2; XML = starts with `<`, **no DOCTYPE**; CSV = text without NUL bytes, UTF-8 or UTF-16 with a BOM). Keys `imports/yyyy/mm/<uuid>.<ext>`; only the uploader may read the file; it is deleted after the commit, when the preview expires, or after 24 h.

| Method | Path | Permission | Body | Response |
|---|---|---|---|---|
| POST | `/projects/import` | projects.create (20/min) | [importProjectSchema] `{ fileId, format: 'xlsx' \| 'csv' \| 'xml' \| 'mpp' \| 'jira-csv', options?: { sheetName?, durationUnit?, dateOrder?: 'DMY' (default) \| 'MDY', projectName? } }` | `200 ImportPreviewDto` (below). Not the caller's READY import file → 404; format ≠ upload type → 400 `IMPORT_FORMAT_MISMATCH`; unreadable → 400 `IMPORT_FILE_INVALID`; no task rows → 400 `IMPORT_NO_TASKS`; > 5,000 tasks → 413 `IMPORT_TOO_MANY_TASKS`. `mpp` without `CONVERTER_URL` → **501 `MPP_CONVERTER_NOT_CONFIGURED`** (the message tells the admin to save as XML in MS Project); converter unreachable or failing → 502 `MPP_CONVERSION_FAILED`. Audited `project.import_previewed` `{ format, tasks, dependencies, durationUnit }`. |
| POST | `/projects/import/jira` | projects.create (10/min) | [importJiraSchema] `{ siteUrl, email, apiToken, jql? \| projectKey?, options? }` | `200 ImportPreviewDto` (`format: 'jira'`). `siteUrl` must be `https://<name>.atlassian.net` or a host in `JIRA_ALLOWED_HOSTS`, no IP literal, port or credentials, and **every resolved address public** (checked inside the socket's DNS lookup, so it cannot be rebound) → else 400 `JIRA_URL_NOT_ALLOWED`; redirects are not followed. 401/403 from Jira → 400 `JIRA_AUTH_FAILED`; other failures → 502 `JIRA_REQUEST_FAILED`. `GET /rest/api/3/search/jql`, 100 per page with `nextPageToken`, at most 2,000 issues (warning `JIRA_LIMIT`). The token is used for this call only: never stored, logged (redacted) or audited (only the site host is). |
| POST | `/projects/import/commit` | projects.create (20/min) | [importCommitSchema] `{ previewId, assigneeMap?: Record<name, userId \| null>, name?, startDate? }` | `201 ImportCommitResultDto { projectId, taskCount, dependencyCount, calendarId, calendarCreated }`. One transaction: the preview row is claimed first (a second commit → 410 `IMPORT_PREVIEW_EXPIRED`, also after 1 h or for another admin), the calendar is reused (no calendar in the file, or an identical one) or created with the file's weekend, hours and exceptions, the project is created in the detected unit (status PLANNING, auto-schedule on), tasks go through the write path (engine run, `task.created` audits with `imported`), links keep their type and lag. Map values must be ACTIVE supervisors (else 400 `ASSIGNEE_NOT_SUPERVISOR` + `details.userIds`); unmapped names → unassigned; groups are never assigned. `startDate` re-bases every task by its working offset. Audited `project.imported` `{ format, name, durationUnit, tasks, dependencies, calendarId, calendarCreated, assigneesMapped, warnings }`; the upload is deleted. |

`ImportPreviewDto`: `{ previewId, expiresAt, format, project: { name, startDate, durationUnit, calendar: { name, weekendDays, workingHours, exceptions } }, tasks: ImportPreviewTaskDto[] (ref, sourceId, wbs, parentRef, name, type, startDate, endDate, durationDays, durationHours?, progress, status, assigneeName, plannedCost, actualCost, deadline, notes — after the engine ran, in WBS order), dependencies: { predecessorRef, successorRef, type, lagDays, lagHours? }[], warnings: { code, message_ar, row?, sourceId? }[], unmappedAssignees: { name, taskCount, suggestedUserId }[] (exact-name match among active supervisors), stats: { taskCount, groupCount, milestoneCount, dependencyCount } }`.

Warning codes (each with a ready `message_ar`): `ROW_SKIPPED`, `NAME_TRUNCATED`, `DATE_UNPARSED`, `DURATION_UNPARSED`, `PARENT_MISSING`, `PREDECESSOR_MISSING`, `DEPENDENCY_TYPE_IGNORED` (SS/FF/SF are stored but only FS schedules), `DEPENDENCY_CYCLE_DROPPED`, `DEPENDENCY_DUPLICATE`, `MILESTONE_DURATION`, `ASSIGNEE_MULTIPLE`, `CALENDAR_DEFAULTED`, `HOURS_DETECTED`, `JIRA_LIMIT`.

Mapping (docs/imports.md lists the column names): **Excel/CSV** — header synonyms in Arabic and English; outline from WBS codes, else an outline-level column, else indentation (xlsx indent / leading spaces); predecessors `3FS+2d`, `5`, `1.2SS-4h` refer to the ID column, else WBS codes or row numbers; dates as Excel serials, ISO, `DD/MM/YYYY` (or MDY), Arabic-Indic digits, month names. **MSPDI** — tasks (UID, ID, OutlineLevel, Start, Finish, Duration `PT…H…M…S`, Milestone, Summary, PercentComplete, Cost/ActualCost in hundredths, Deadline, Notes), `PredecessorLink` (Type 0 FF, 1 FS, 2 SF, 3 SS; `LinkLag` in tenths of minutes; percent lags → 0 with a warning), resources + assignments → one assignee (the largest units), the project calendar (WeekDays, working times, exceptions). HOUR when a work task's duration is not whole days or a duration/lag format is hours. **.mpp** → the `converter` service (MPXJ) → MSPDI. **Jira** — Epic → GROUP, Sub-task under its parent, Parent / Epic Link → hierarchy, status (name, then category), assignee, Start date (custom field; `customfield_10015` over REST) or Created → start, Due date → end and deadline, Original Estimate → duration, `blocks` links → FS. Jira projects are DAY unless `options.durationUnit = 'HOUR'`.

### Exports (ADR-110)
| Method | Path | Permission | Query | Response |
|---|---|---|---|---|
| GET | `/projects/:id/export` | readAll | [projectExportQuerySchema] `format=xlsx (default) \| csv \| xml` | The file (`Cache-Control: no-store`). **xlsx**: sheets «المهام» and «المشروع», RTL, **no frozen panes**; columns WBS, name, type, start, end, duration (working days, or working hours in HOUR projects with date-time cells), progress, status, priority, assignee, team, description, **planned cost, actual cost, deadline, labels**, (HOUR: working days), then one column per **custom field**. **csv**: the same columns, UTF-8 **with BOM**, CRLF, cells starting with `= + - @` prefixed with `'`. **xml**: MSPDI (calendar with working times and exceptions, `DurationFormat` hours or days, summary tasks, links with `LinkLag`, assignees as resources + assignments, costs in hundredths) — round-trips with the importer (tested). Audited `project.exported` `{ format, tasks }`. `GET /projects/:id/export.xlsx` stays (the same xlsx). PDF/PNG of the Gantt are rendered in the browser. |

### New error codes
`IMPORT_FILE_INVALID` (400), `IMPORT_FORMAT_MISMATCH` (400), `IMPORT_NO_TASKS` (400), `IMPORT_TOO_MANY_TASKS` (413), `IMPORT_PREVIEW_EXPIRED` (410), `MPP_CONVERTER_NOT_CONFIGURED` (501), `MPP_CONVERSION_FAILED` (502), `JIRA_URL_NOT_ALLOWED` (400), `JIRA_AUTH_FAILED` (400), `JIRA_REQUEST_FAILED` (502).

### Audit actions
`project.converted`, `project.import_previewed`, `project.imported`; `project.exported` now carries `format: xlsx | csv | xml`. Calendars created by the create form or an import are `calendar.created` (with `baseCalendarId`).

### Configuration
`CONVERTER_URL` (e.g. `http://converter:8080`), `CONVERTER_TOKEN` (required in production with the URL, ≥ 32 random characters, the same value as in `env/converter.env`), `CONVERTER_TIMEOUT_MS` (60000), `JIRA_ALLOWED_HOSTS` (extra exact Jira hosts, comma separated).
