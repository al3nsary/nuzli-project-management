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

Scope: ADMIN creates and manages projects and tasks. SUPERVISOR sees projects they were granted (`project_access`) or where they have an assigned task, sees all tasks of those projects read-only, and may change **progress, status** of tasks assigned to them and comment (ADR-007).

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
