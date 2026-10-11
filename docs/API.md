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
## Phase 3 (violations) — to be detailed when the phase starts
## Phase 4 (projects, tasks, Gantt) — to be detailed when the phase starts
