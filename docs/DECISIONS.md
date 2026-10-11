# Architecture Decision Records

Format: each ADR has **Context · Decision · Consequences**. Status is *Accepted* unless noted. Anything the brief leaves open is decided here; anything the brief fixes is changed only with the owner's approval.

| # | Title | Status |
|---|---|---|
| ADR-001 | Monorepo with pnpm workspaces | Accepted |
| ADR-002 | NestJS + Prisma + raw-SQL migrations | Accepted |
| ADR-003 | zod schemas shared by API and UI | Accepted |
| ADR-004 | Mantine 7 for the RTL UI | Accepted |
| ADR-005 | Self-hosted fonts: IBM Plex Sans Arabic, Readex Pro, IBM Plex Mono | Accepted |
| ADR-006 | Single RBAC matrix in `@nuzli/shared` | Accepted |
| ADR-007 | Supervisors may update progress/status of their assigned tasks | Accepted (assumption) |
| ADR-008 | Registration requests folded into `users.status` | Accepted |
| ADR-009 | Last-admin protection with a row lock in a transaction | Accepted |
| ADR-010 | JWT access token + rotating refresh token with family reuse detection | Accepted |
| ADR-011 | National ID: AES-256-GCM at rest + HMAC blind index | Accepted |
| ADR-012 | OCI Object Storage via the S3 API; MinIO in dev | Accepted |
| ADR-013 | Membership history as half-open intervals + partial unique + exclusion constraint | Accepted |
| ADR-014 | Violation snapshots and two-clock drift detection (`clientSentAt`) | Accepted |
| ADR-015 | No PostGIS: lat/lng columns + bounding-box queries | Accepted |
| ADR-016 | Custom React + SVG Gantt with row virtualisation | Accepted |
| ADR-017 | Optimistic concurrency with a `version` column, batch per drag | Accepted |
| ADR-018 | Card printing: browser `@page` first, server PDF second, ZPL optional | Accepted |
| ADR-019 | Excel export with ExcelJS, RTL views, no freeze panes | Accepted |
| ADR-020 | GitHub Pages demo build with an in-browser `DemoApi` | Accepted (owner request A4) |
| ADR-021 | Offline outbox in IndexedDB (Dexie) with a foreground-first sync engine | Accepted |
| ADR-022 | Local toolchain: npm workspaces locally, pnpm in CI and Docker | Accepted |
| ADR-023 | A supervisor may lead several teams (setting, default on) | Accepted (assumption §17.1) |
| ADR-024 | Server-side PDF with Playwright Chromium in a separate `pdf` worker | Proposed (Phase 2) |
| ADR-025 | Web forms: a tiny zod adapter instead of `@mantine/form` | Accepted |
| ADR-026 | Flat i18n keys checked by a TypeScript-AST script | Accepted |
| ADR-027 | DemoApi persistence, demo password and sessions | Accepted |
| ADR-028 | Phase 1 audit action vocabulary | Accepted (API must match) |
| ADR-029 | CI and Pages use `npm ci` until a pnpm lockfile exists | Accepted (amends ADR-022 for CI) |
| ADR-030 | Last-admin lock under READ COMMITTED (amends ADR-009) | Accepted |
| ADR-031 | Guards reload the user on every request | Accepted |
| ADR-032 | National-ID ciphertext format and permission `nationalIds.readFull` | Accepted |
| ADR-033 | Swagger from the shared zod schemas with a small in-house converter | Accepted |
| ADR-034 | Login, lockout and enumeration rules | Accepted |
| ADR-035 | `files.kind` column and the Phase 1 file read policy | Accepted |
| ADR-036 | Dev object storage behind the HTTPS proxy (`S3_PUBLIC_ENDPOINT`) | Accepted |
| ADR-037 | Backups: sleep-loop scheduler, plain SQL + openssl, `restore.sh --verify` | Accepted |
| ADR-038 | API Docker image: pnpm prod install + global Prisma CLI | Accepted |
| ADR-039 | Phase 2 audit action vocabulary | Accepted (web must label) |
| ADR-040 | Supervisor data scope in the service + `@RequireAnyPermission` | Accepted |
| ADR-041 | Colour reservation: pre-check, partial unique index, refreshable 409 | Accepted |
| ADR-042 | Membership writes: one timestamp, strict moves, archive closes rows | Accepted (implements ADR-013) |
| ADR-043 | Server PDF through an optional `PDF_SERVICE_URL` (501 until set) | Accepted (implements ADR-024) |
| ADR-044 | Member import validated on the server, masked echo, partial commit | Accepted |
| ADR-045 | Print batches: template snapshot, masked items, 201/200 idempotency, save-back | Accepted |
| ADR-046 | Violation create: 201/200 idempotency, SQL snapshot at `captured_at`, device-info whitelist | Accepted (implements ADR-014) |
| ADR-047 | Violation scope inside the query; supervisor visibility resolution | Accepted |
| ADR-048 | Violation photos through FilesService entity hooks; limits, row lock, retention job | Accepted |
| ADR-049 | Violation statistics and exports in Asia/Riyadh time | Accepted |
| ADR-050 | Phase 3 audit action vocabulary | Accepted (web must label) |
| ADR-056 | Server-side scheduling on every task write; one locked transaction; versions only for real changes | Accepted (implements ADR-017) |
| ADR-057 | Task hierarchy: automatic GROUP, fractional sort order, server-normalised dates | Accepted |
| ADR-058 | Project scope, supervisor rights (clarifies ADR-007) and task attachments | Accepted |
| ADR-059 | Calendar edits re-derive projects; daily reminders; tasks Excel | Accepted |
| ADR-060 | Phase 4 audit action vocabulary and notifications | Accepted (web must label) |
| ADR-061 | Secrets checked at start-up; Swagger off in production by default | Accepted |
| ADR-062 | Login: progressive delays per IP and identifier, short silent lock | Accepted (web: RATE_LIMITED) |
| ADR-063 | Public registration never reveals existing accounts | Accepted (web: success text) |
| ADR-064 | Card print data masked at rest; full IDs only for the print run; server-derived ID and QR | Accepted (web: print from POST answer) |
| ADR-065 | Uploads go to pending/; confirm copies to a final key | Accepted |
| ADR-066 | Upload scope: violation window and status; logos admin-only; member photos closed | Accepted |
| ADR-067 | Full national IDs out of URLs; neutral duplicate error for supervisors | Accepted (web: POST search) |
| ADR-068 | One env file per service; read-only, capability-free containers | Accepted |
| ADR-069 | Backups: pg_dump -Fc + gpg; restore into a new database then swap | Accepted |
| ADR-070 | National-ID key rotation script | Accepted |

---

## ADR-001 — Monorepo with pnpm workspaces
**Context.** The brief fixes pnpm workspaces with `apps/web`, `apps/api`, `packages/shared`, `packages/scheduling` and `packages/ui-print`.
**Decision.** One repository; internal packages build with `tsup` to ESM + CJS so both Vite (ESM) and Nest (CJS) consume them.
**Consequences.** Internal packages must be built before the apps (`pnpm -r build` does it in topological order). Internal deps use `"*"` plus `link-workspace-packages=true` so npm and pnpm both resolve them locally (ADR-022).

## ADR-002 — NestJS + Prisma + raw-SQL migrations
**Context.** Fixed by the brief. Prisma cannot express partial unique indexes, CHECK constraints, exclusion constraints or triggers.
**Decision.** `schema.prisma` holds the model. The first migration is generated by `prisma migrate diff`; a second migration (`20261011000100_constraints`) holds the raw SQL. Later migrations follow the same split.
**Consequences.** `prisma migrate dev` must not be used to "reset" drift caused by raw SQL; new migrations are created with `--create-only` and then edited.

## ADR-003 — zod schemas shared by API and UI
**Decision.** `@nuzli/shared` exports zod schemas whose messages are in Arabic. The API validates with a `ZodValidationPipe`; the UI validates forms with the same schema.
**Consequences.** Swagger is generated from DTO classes that wrap the zod schemas (`createZodDto`-style helper), so the spec and the runtime validation cannot drift.

## ADR-004 — Mantine 7 for the RTL UI
**Decision.** Mantine (as recommended), with `DirectionProvider` set to rtl and a theme built from `tokens.css`.
**Consequences.** Mantine's CSS is loaded once; component overrides live in the theme, not in ad-hoc styles.

## ADR-005 — Self-hosted fonts
**Decision.** `@fontsource/ibm-plex-sans-arabic` (body), `@fontsource-variable/readex-pro` (display, restrained), `@fontsource/ibm-plex-mono` (IDs, numbers). Bundled by Vite and precached by the service worker.
**Consequences.** Printing and offline use never depend on a CDN.

## ADR-006 — Single RBAC matrix
**Decision.** `packages/shared/src/permissions.ts` maps roles to permissions. The API guard `@RequirePermission()` and the UI `can()` read the same matrix. Data-scoped rules (own team, recorded by me, visibility setting) are applied in services.
**Consequences.** Adding a permission is one line; the matrix has its own unit tests.

## ADR-007 — Supervisors update their own task progress
**Context.** The brief assigns tasks to supervisors and gives them "My tasks", but does not say whether they can change anything.
**Decision.** A supervisor may update **progress, status and comments** of tasks assigned to them. Dates, structure and dependencies stay admin-only.
**Consequences.** One permission (`tasks.updateAssigned`), checked against `assignee_id` in the service. Easy to revoke if the owner disagrees.

## ADR-008 — Registration requests folded into users
**Decision.** No separate `registration_requests` table: a request is a `users` row with `status = PENDING`, plus `requested_role` and `requested_team_name`.
**Consequences.** Uniqueness of email, mobile and national ID covers pending requests too, so a person cannot register twice. Rejected rows keep `rejection_reason` for the audit trail.

## ADR-009 — Last-admin protection
**Decision.** Demote, suspend and delete run in a `SERIALIZABLE` transaction that first locks all active admin rows (`SELECT … FOR UPDATE`) and counts them. If the target is the only one, the action fails with `LAST_ADMIN`.
**Consequences.** Two admins demoting each other at the same moment cannot both succeed.

## ADR-010 — Tokens
**Decision.** Access JWT (15 min, HS256) returned in the body and kept in memory. Refresh token: 256-bit random, stored as SHA-256, sent as an `httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie, rotated on every use. Each login starts a token *family*; presenting a revoked token revokes the whole family (reuse detection). CSRF: the refresh and logout endpoints also require a double-submit `X-CSRF-Token` header that matches a non-httpOnly `csrf` cookie.
**Consequences.** Reloading the page performs a refresh call. SSO can be added later as another way to *start* a family (ADR keeps `AuthService.issueSession(user)` as the single entry point).

## ADR-011 — National ID protection
**Decision.** `national_id_enc` = AES-256-GCM (`iv 12 | tag 16 | ciphertext`) with `NATIONAL_ID_ENC_KEY`. `national_id_hash` = HMAC-SHA256 with `NATIONAL_ID_HMAC_KEY` → unique index and exact lookup. The first digit and the last 2 (users) or 4 (members, for on-device search) digits are stored in clear for masking.
**Key rotation.** Keys carry a version prefix (`v1:`). Rotation script: add `v2` key, re-encrypt rows in batches, recompute the HMAC into the new column, swap, drop old — documented in `docs/backup-restore.md`.
**Consequences.** No `LIKE` search on full IDs; search by exact ID or by the last 4 digits.

## ADR-012 — Object storage
**Decision.** AWS SDK v3 S3 client; `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`. Presigned PUT (TTL from settings, default 300 s), then confirm: HEAD, size check, magic-byte check with a 4 KB ranged GET. Keys `{entity}/{yyyy}/{mm}/{uuid}.{ext}`.
**Consequences.** MinIO in dev and OCI in prod use the same code path. Unconfirmed `PENDING` files older than 24 h are deleted by a scheduled job.

## ADR-013 — Membership history
**Decision.** `team_memberships` rows are half-open intervals `[valid_from, valid_to)`. A partial unique index enforces one open row; an exclusion constraint (btree_gist) forbids overlapping intervals. A move closes and opens with **the same timestamp** taken once in the transaction.
**Consequences.** "Team at time T" is a single indexed lookup, and past statistics never change.

## ADR-014 — Violation snapshots and clock drift
**Decision.** On create, the service resolves team and supervisor at `captured_at` from history and stores them as snapshots. The client also sends `clientSentAt`; drift = |clientSentAt − receivedAt|. Without it, only a capture time in the future beyond the threshold is flagged.
**Consequences.** A violation recorded offline hours ago is not falsely flagged; a device with a wrong clock is.

## ADR-015 — No PostGIS
**Decision.** Plain `latitude`/`longitude` with a composite index; the map area filter is a bounding box. Clustering happens in the browser (Leaflet.markercluster).
**Consequences.** Fewer moving parts. Revisit if polygon filters or >100k points are needed.

## ADR-016 — Custom Gantt
**Decision.** React + SVG, rows virtualised (fixed row height, render only visible rows plus overscan). Coordinates are computed in "logical x" (days from start) and converted once: `x = width − logicalX` in RTL.
**Consequences.** Full control of RTL behaviour; must stay smooth at 2,000 tasks (measured in a Vitest benchmark and in the browser).

## ADR-017 — Optimistic concurrency
**Decision.** Every task has `version`. A batch update checks all versions inside one transaction; any mismatch → 409 `CONFLICT_VERSION` and nothing is written.

## ADR-018 — Card printing
**Decision.** Primary: browser printing with `@page { size: Wmm Hmm; margin: 0 }`. Secondary: server PDF (ADR-024). ZPL (Phase 5) only for text templates, because ZPL cannot shape Arabic glyphs and images must be converted to monochrome bitmaps.

## ADR-019 — Excel export
**Decision.** ExcelJS. Every sheet: `views: [{ rightToLeft: true }]`, **never** a frozen view; real dates; Arabic headers; widths fitted to content. A unit test opens every exported workbook and asserts `rightToLeft === true` and no `state: 'frozen'`.

## ADR-020 — GitHub Pages demo
**Context.** The owner asked to view the system on GitHub Pages. Pages is static hosting: it cannot run NestJS, PostgreSQL or MinIO.
**Decision.** The web app talks to an `ApiClient` interface. `HttpApi` calls the real backend. `DemoApi` runs entirely in the browser, seeded from `seed/demo/*`, persisting to IndexedDB, and enforcing the same permissions matrix and the same invariants (unique colours, membership history, last admin). `vite build --mode demo` sets `VITE_DEMO=1` and the Pages base path. A visible strip says «نسخة عرض — البيانات تجريبية».
**Consequences.** The demo is honest about being a demo and lets the owner try every screen with demo accounts. The real deployment remains Docker (§3).

## ADR-021 — Offline outbox
**Decision.** Dexie tables `roster`, `outbox`, `outboxFiles`. A single sync loop processes items in order with exponential backoff (2 s → 5 min). Triggers: `online`, `visibilitychange`, a 60 s timer, Background Sync where supported.

## ADR-022 — Local toolchain
**Context.** The brief fixes pnpm. On the build machine pnpm was not available, and Docker is not installed.
**Decision.** The root `package.json` has `"workspaces"` (npm) **and** `pnpm-workspace.yaml` (pnpm). CI and Dockerfiles use pnpm via corepack. Local development may use either.
**Consequences.** Two lockfiles must not be committed together; CI uses `pnpm-lock.yaml` once it is generated on a machine with pnpm. Until then CI runs `pnpm install --no-frozen-lockfile`.

## ADR-023 — Several teams per supervisor
**Decision.** Allowed by default; setting `ALLOW_MULTIPLE_TEAMS_PER_SUPERVISOR` can turn it off (brief §17.1).

## ADR-024 — Server-side PDF (proposed)
**Decision.** A separate `pdf` service (Playwright Chromium image) renders the same print page and returns a PDF with exact page sizes, so the API image stays small.

## ADR-025 — Web forms: a tiny zod adapter instead of `@mantine/form`
**Context.** The brief asks for forms validated by the shared zod schemas. `@mantine/form` is not installed, and adding a package while other agents work in the same `node_modules` is risky.
**Decision.** `apps/web/src/forms/useZodForm.ts` (about 100 lines): `zodResolver(schema)` turns zod issues into `{ field: firstArabicMessage }`; `useZodForm` holds values and errors, validates on submit and then per field, and accepts server field errors (`ApiError.fieldErrors`, which also maps `EMAIL_TAKEN`/`MOBILE_TAKEN`/`NATIONAL_ID_TAKEN` to their field).
**Consequences.** One source of validation rules (`@nuzli/shared`) and no new dependency. Moving to `@mantine/form` later only touches the hook.

## ADR-026 — Flat i18n keys checked by a TypeScript-AST script
**Decision.** `ar.ts` is one flat object (`'area.thing': '…'`) typed `as const`, so `t(key)` is checked by TypeScript. `en.ts` is `Record<MessageKey, string>` (a scaffold; most values empty). `scripts/check-i18n.mjs` parses both files and every `.tsx` with the TypeScript compiler API and fails on a missing key, an empty Arabic value, Latin JSX text, or a Latin string literal in a visible attribute (`label`, `placeholder`, `title`, `aria-label`, `alt`, `description`, `error`). Keys built at runtime (`role.${role}`) go through `tKey(key, fallback)`, so an unknown code never shows a raw Latin identifier.
**Consequences.** No regex false positives on TypeScript generics. CI runs the check before building.

## ADR-027 — DemoApi persistence, demo password and sessions
**Decision.** `DemoApi` (GitHub Pages build only) keeps users, notifications, audit entries, sessions and settings in IndexedDB through Dexie (database `nuzli-demo`), seeded once from `seed/demo/*.json`. Every demo account shares one password (`NuzliDemo2026`, shown on the login page in demo mode). Passwords are stored as SHA-256 only to avoid plain text in the browser; the real API uses argon2id. The "access token" is a random id in the `sessions` table, and the current one is kept in IndexedDB so a reload restores the session (the HTTP adapter keeps its token in memory only and refreshes through the cookie, ADR-010). Users that an admin creates in the demo get the shared password with `mustChangePassword = true`, standing in for the set-password email. The demo never issues reset tokens, so "reset password" always answers `TOKEN_INVALID`; "forgot password" answers 204 like the API.
**Consequences.** Data lives only in the visitor's browser; «إعادة ضبط بيانات العرض» clears it and reseeds. The real build loads the adapter through a dynamic import, so the DemoApi chunk and the seed are not shipped to production.

## ADR-028 — Phase 1 audit action vocabulary
**Decision.** Audit `action` values written in Phase 1: `registration.requested`, `registration.approved`, `registration.rejected`, `user.created`, `user.role_changed`, `user.suspended`, `user.reactivated`, `settings.updated`, `auth.password_changed`. `entityType` is `user` or `settings`. `before` and `after` hold only the changed fields (for example `{ role }` or `{ status }`). The web app labels these in Arabic and shows a field-level diff.
**Consequences.** The API must write the same names. The list lives in `apps/web/src/pages/AuditPage.tsx` (`AUDIT_ACTIONS`) and should move to `@nuzli/shared` when the API adopts it. Unknown actions display as «إجراء آخر».

## ADR-029 — CI and Pages use `npm ci` for now
**Context.** ADR-022 plans pnpm in CI, but the repository only has an npm `package-lock.json`.
**Decision.** `.github/workflows/ci.yml` and `pages.yml` run `npm ci` and `npm run … -w <workspace>`.
**Consequences.** Switch both workflows to pnpm (corepack) in the same change that commits `pnpm-lock.yaml`.

## ADR-030 — Last-admin lock under READ COMMITTED (amends ADR-009)
**Context.** ADR-009 asked for a `SERIALIZABLE` transaction plus `SELECT … FOR UPDATE` on the active admin rows. Under SERIALIZABLE the losing transaction of two concurrent demotions fails with a serialization error (P2034) instead of the meaningful `LAST_ADMIN`.
**Decision.** `apps/api/src/users/last-admin.ts` runs in the default READ COMMITTED transaction: `SELECT id FROM users WHERE role='ADMIN' AND status='ACTIVE' ORDER BY id FOR UPDATE`. The second transaction waits on the row locks, PostgreSQL re-evaluates the `WHERE` on the locked rows after the first commits, so it sees the reduced set and fails with `LAST_ADMIN`. The lock is taken only when the change would remove an active admin (demote, suspend; delete later). P2034 is still mapped to `CONFLICT_VERSION` if it ever occurs.
**Consequences.** Same guarantee (never zero active admins), clearer error. Covered by unit tests (mocked transaction) and an integration test with two concurrent mutual demotions.

## ADR-031 — Guards reload the user on every request
**Decision.** `JwtAuthGuard` verifies the 15-minute HS256 token and then loads `id, role, status, mustChangePassword` by primary key. The `role` claim in the token is informational only. Non-active users get `ACCOUNT_PENDING/REJECTED/SUSPENDED`; while `mustChangePassword` is true only routes marked `@AllowWhenPasswordChangeRequired()` pass (`/auth/change-password`, `/auth/me`; `/auth/logout` and `/auth/refresh` are cookie routes and public). `PermissionsGuard` then applies `can()` from `@nuzli/shared`. Guard order: throttler → JWT → permissions.
**Consequences.** Suspension and role changes apply immediately, not after the access token expires — one indexed lookup per request.

## ADR-032 — National-ID ciphertext format and `nationalIds.readFull`
**Decision.** `national_id_enc` = ASCII key version + `:` (e.g. `v1:`) ‖ IV (12) ‖ GCM tag (16) ‖ ciphertext. `NATIONAL_ID_ENC_KEY` is `vN:<base64 32 bytes>` (bare base64 = `v1`); `NATIONAL_ID_ENC_KEYS_OLD` lists older keys kept for decryption during rotation. The blind index is unversioned HMAC-SHA256 hex over the Western-digit form, so rotating `NATIONAL_ID_HMAC_KEY` needs the column recompute described in ADR-011. A new permission `nationalIds.readFull` (ADMIN only, via the matrix) decides when a `UserDto` includes the decrypted value (`GET /users/:id`, admin actions); lists always return `nationalIdMasked` built from the stored first/last digits with `maskNationalIdParts()` (new in `@nuzli/shared`), without decrypting. Audit snapshots never contain the full value (`sanitizeForAudit` masks any `nationalId` key and drops secrets).

## ADR-033 — Swagger from the shared zod schemas
**Decision.** No `nestjs-zod` dependency. `apps/api/src/common/zod-openapi.ts` converts the zod features used in `@nuzli/shared` (objects, strings with formats, numbers, enums, optional/default/nullable, effects, arrays, records, unions) to OpenAPI. `@ZodBody(schema)` / `@ZodQuery(schema)` apply the `ZodValidationPipe` **and** the Swagger metadata in one parameter decorator, so documentation and validation cannot drift.
**Consequences.** Response schemas are not documented yet (the DTO interfaces live in `@nuzli/shared`).

## ADR-034 — Login, lockout and enumeration rules
**Decision.** Login by email (contains `@`) or Saudi mobile (normalised to E.164). Unknown accounts still run an argon2 verify against a dummy hash. Account status (`ACCOUNT_PENDING/REJECTED/SUSPENDED`) is revealed only after a correct password. `LOGIN_MAX_FAILURES` (5) consecutive failures lock the account for `LOGIN_LOCK_MINUTES` (15) → `ACCOUNT_LOCKED` (HTTP 423), even with the right password. Auth endpoints are throttled per IP (`THROTTLE_AUTH_LIMIT`/min). `forgot-password` answers 204 immediately and does the lookup and e-mail after the response. One-time action tokens (`SET_PASSWORD` 72 h, `RESET_PASSWORD` 1 h) are stored as SHA-256, claimed with a conditional update, and every use revokes all sessions. Concurrent refresh of the same token counts as reuse (the whole family is revoked) — the web app serialises refreshes (single-flight).

## ADR-035 — `files.kind` and the Phase 1 file read policy
**Decision.** Migration `20261012000000_files_kind` adds a nullable `files.kind` (ID_CARD, EVIDENCE, ATTACHMENT, LOGO, PHOTO) so ID-card photo URLs can be audited (`file.id_card_url_issued`) before violations exist. Presigned URLs (`GET /files/:id/url`) are issued to the uploader, or by entity: violation → `violations.readAll`; task → `projects.readAll`; logo → `cards.print`/`logos.manage`; member photo → `teams.readAll`/`members.manage`/`cards.print`. ID-card photos additionally need `violations.viewIdPhoto`. Phases 2–4 add data-scoped rules that only narrow this. Confirm rejects anything whose magic bytes are not JPEG/PNG/WebP/PDF or differ from the declared type, deletes the object and marks the row `deleted_at`.

## ADR-036 — Dev object storage behind the HTTPS proxy
**Context.** Presigned URLs embed the host they were signed for; the API reaches MinIO as `http://minio:9000`, browsers cannot, and an `http://` URL from an `https://` page is mixed content on phones.
**Decision.** `S3_PUBLIC_ENDPOINT` (optional) is the endpoint used only to sign browser URLs. In dev it is `https://localhost` (or the LAN origin), and `infra/nginx/dev-storage.conf` proxies `/<bucket>/` to MinIO with the Host header unchanged, so signatures match. In production `S3_PUBLIC_ENDPOINT` is unset and browsers talk to OCI directly (the SPA CSP allows `https://*.oraclecloud.com`).
**Consequences.** The dev bucket name must match the nginx location (`nuzli`). OCI bucket CORS must allow the site origin for PUT (deployment note).

## ADR-037 — Backups
**Decision.** `infra/backup` (postgres:16-alpine + openssl + AWS CLI) runs as the `postgres` user with a sleep-loop scheduler (no root crond): daily at `BACKUP_TIME` UTC, `pg_dump --clean --if-exists | gzip -9 | openssl enc -aes-256-cbc -pbkdf2 -iter 200000`, a `.sha256` next to each file, local retention `BACKUP_RETENTION_DAYS`, optional upload to an S3-compatible bucket. `restore.sh <file|s3://…> --verify` restores into a throw-away database, counts migrations and users, and drops it — a safe drill for CI or ops; `--yes` restores in place.

## ADR-038 — API Docker image
**Decision.** Multi-stage, pnpm via corepack, build context = repo root. The runtime stage installs production dependencies with `pnpm install --prod --filter "@nuzli/api..."`, copies the built `dist` of api/shared/scheduling, installs the Prisma CLI globally at the client's version (needed for `prisma migrate deploy` at start) and runs `prisma generate` into the production `node_modules`. Runs as `node` under `tini`; entrypoint: migrate → seed → `node dist/main.js`. The `dev` stage (compose dev) runs `nest start --watch` with `src` bind-mounted.

## ADR-039 — Phase 2 audit action vocabulary
**Decision.** New `action` values (constants in `apps/api/src/audit/audit.service.ts`): `team.created`, `team.updated`, `team.approved`, `team.rejected`, `team.archived`, `team.supervisor_changed`, `team.visibility_changed`, `member.created`, `member.updated`, `members.moved`, `members.imported`, `color.created`, `color.updated`, `reference.created`, `reference.updated`, `reference.deleted`, `card_template.created`, `card_template.updated`, `card_template.archived`, `card_size.created`, `card_size.deleted`, `logo.created`, `logo.deleted`, `logo.default_set`, `cards.printed`, `cards.pdf_exported` (brief §13: every export is audited). `entityType`: `team`, `member`, `team_color`, `department`, `job_title`, `card_template`, `card_size`, `logo`, `card_print_batch`. `members.moved` and `members.imported` use `entityType = team` (the target team). A team created with an inline supervisor also writes `user.created`; a print with save-back writes one `member.updated` per member (`after.source = "cards.saveBack"`). Snapshots carry masked national IDs only.
**Consequences.** `apps/web/src/i18n/ar.ts` needs an Arabic label for each (`audit.action.*`).

## ADR-040 — Supervisor data scope in the service + `@RequireAnyPermission`
**Context.** Admin and supervisor reach the same routes through different permissions (`teams.readAll` vs `teams.readOwn`); `@RequirePermission` requires all listed permissions.
**Decision.** `@RequireAnyPermission(...)` (new, read by `PermissionsGuard`) opens a route to any listed permission; the service then applies the data scope (`apps/api/src/teams/team-dto.ts`). A supervisor sees and manages only teams where `teams.supervisor_id = me`; another team answers **404** (its existence is not revealed), a visible team without the right answers 403. Members: a supervisor sees the members of their teams **and unassigned members** (needed to build a team from existing people); they may edit only members of their own teams. Moving between teams (`members.move`), import (`members.import`), approval, supervisor change and violation visibility stay ADMIN-only per the matrix. `GET /teams` without `status` returns ACTIVE + PENDING_APPROVAL; `status=ARCHIVED|ALL` on request.
**Consequences.** No role checks in controllers; the matrix stays the single source.

## ADR-041 — Colour reservation: pre-check, partial unique index, refreshable 409
**Decision.** Create/edit first checks inside the transaction that the colour is active (`COLOR_INACTIVE`) and not held by another ACTIVE/PENDING team; the partial unique index `teams_color_reserved_uq` is the real guard for concurrent requests. Both paths answer **409 `COLOR_TAKEN`** with `details = { fieldErrors: { colorId: [...] }, refresh: "colors", available: TeamColorDto[] }`, so the client swaps its picker without another request. `GET /colors/available` computes the list in code from the palette and the reserving teams (`availableColors()`); with `excludeTeamId` the edited team keeps its own colour even if it was retired since (a supervisor may only pass a team they lead). Retiring a colour never touches the teams that use it. A duplicate hex → `COLOR_EXISTS`.

## ADR-042 — Membership writes: one timestamp, strict moves, archive closes rows
**Decision.** `apps/api/src/members/member-writes.ts` is the only writer of `team_memberships`. A move takes `t = new Date()` once per transaction, closes each open row (`valid_to = t`) and opens the new one (`valid_from = t`). If any selected member is already in the target team the whole request fails with `MEMBER_ALREADY_IN_TEAM` (`details.memberIds`); the client filters same-column drops. If a concurrent move closed a row first (the conditional `updateMany` count differs) → `CONFLICT_VERSION`; the unique open-row index backs this up. The target must be ACTIVE (`TEAM_NOT_ACTIVE`). Archiving or rejecting a team closes its open memberships **and** its open supervisor-history row with one timestamp; the members become "unassigned". Supervisor changes close/open `team_supervisor_history` the same way and update `teams.supervisor_id`. New members (team creation, `POST /teams/:id/members`, import) open their first row at the creation instant; `existingMemberIds` on team creation are moved with the same rules.

## ADR-043 — Server PDF through an optional `PDF_SERVICE_URL` (implements ADR-024)
**Decision.** `GET /cards/batches/:id/pdf` answers **501 `PDF_NOT_CONFIGURED`** (Arabic message: use browser printing) while `PDF_SERVICE_URL` is unset. When set, the API sends `POST {PDF_SERVICE_URL}/render` with JSON `{ batchId, template, cards }` (`template` = the stored snapshot of the batch: size in mm, orientation, layout, config; `cards` = the stored `CardData` items) and streams the `application/pdf` answer as an attachment (`cards-<id>.pdf`, `no-store`). Timeout `PDF_SERVICE_TIMEOUT_MS` (60 s); unreachable or non-2xx → **502 `PDF_FAILED`**. Each successful export is audited (`cards.pdf_exported`). The pdf worker itself (Playwright + `packages/ui-print`) is not part of this change.
**Consequences.** The API image stays small; adding the worker is configuration only. `.env.example` should list `PDF_SERVICE_URL` (commented).

## ADR-044 — Member import validated on the server, masked echo, partial commit
**Decision.** The client parses Excel or pasted text into rows (`fullName`, `nationalId`, `jobTitle`, `department`; Arabic headers such as «الاسم الكامل» and «رقم الهوية», and numeric cells, are also accepted). The server validates each row with the shared `fullName`/`nationalId` schemas, flags duplicates inside the file (`row` is 1-based over the data rows) and against stored members (blind index), and matches job title/department by name to the active lists (else free text, `jobTitleMatched = false`). Results never contain a full national ID, only `nationalIdMasked`. `commit=false` is a dry run; `commit=true` inserts **only the valid rows** in one transaction with their memberships and one `members.imported` audit entry. Import is ADMIN-only (`members.import`) and refused on archived teams.

## ADR-045 — Print batches: template snapshot, masked items, 201/200 idempotency, save-back
**Decision.** `POST /cards/batches` is idempotent by `idempotencyKey`: a repeat (or the loser of a concurrent duplicate) returns the original batch with **200**; a new batch returns **201**. The batch stores a snapshot of the template (size, orientation, layout, parsed config), so later template edits never rewrite the log. Each item's `rendered_data` keeps the national ID masked unless the template printed it in full (`maskNationalId = false` and the field shown). Items need a `memberId` or a `userId` (supervisor cards); `saveBack` is allowed on member cards only and writes the changed name / job title text / department text (a changed title or department becomes free text and unlinks the list entry), with one audited `member.updated` each. `POST /cards/preview` lists, per team, the supervisor card first (`roleLabel` «مشرف الفريق») and then the current members by name; hidden fields are sent empty; `qrValue` is the internal UUID. Seeded built-in templates: «كلاسيكية أفقية — CR80» (default), «شارة عمودية — CR80», «ملصق مدمج — 90 × 40».

## ADR-046 — Violation create: 201/200 idempotency, SQL snapshot at `captured_at`, device-info whitelist (implements ADR-014)
**Decision.** `POST /violations` first looks up `clientUuid`: found → the stored violation with **200**, nothing written. Otherwise one transaction resolves the snapshot and inserts; the loser of two concurrent first attempts gets P2002 on `client_uuid` and returns the winner's row with 200. A `clientUuid` recorded by **another** user answers `409 CONFLICT_VERSION` (the row is never revealed). The snapshot is one SQL statement over both histories with half-open intervals — `valid_from <= t AND (valid_to IS NULL OR valid_to > t)` with `t = captured_at` — so a violation recorded offline before a move and synced after it keeps the old team and the supervisor of that moment. No membership at `t` → `team_id_snapshot = NULL` (allowed, shown in the UI). Recorder = the current user; `received_at` = server time; `client_sent_at` is stored and `clock_drift_suspect` uses `isClockDriftSuspect()` with `CLOCK_DRIFT_THRESHOLD_MINUTES`. `device_info` keeps only `userAgent`, `platform`, `appVersion` and `online`. An inactive/archived member or an inactive type → `VALIDATION_FAILED` with `fieldErrors.memberId/typeId`; `expectedEvidencePhotos > VIOLATION_MAX_PHOTOS` → `TOO_MANY_PHOTOS`.
**Consequences.** A retried sync never duplicates; statistics never move when people move. The bootstrap seed creates **no** violation types; `npm run seed:demo` adds three placeholders named «… (تجريبي)» (or the list in `seed/demo/violation-types.json` when present).

## ADR-047 — Violation scope inside the query; supervisor visibility resolution
**Decision.** `violationScopeWhere()` (`apps/api/src/violations/violation-scope.ts`) is AND-ed into every list, count, detail, edit, status, response, file-URL and export query: `violations.readAll` → all; `violations.readRecorded` → `recorded_by = me`; `violations.readOwnTeams` → `team_id_snapshot` is a **non-archived** team whose `supervisor_id = me` now, and visibility resolves to SHOW: the team override `SHOW`/`HIDE` wins; `INHERIT` (or no row) follows `SUPERVISORS_CAN_SEE_VIOLATIONS`. Out of scope → empty page / **404**. Supervisors never receive ID-card photos (`violations.viewIdPhoto` is not theirs). Edits: the recorder within `VIOLATION_EDIT_WINDOW_MINUTES` after `received_at`, else `violations.manage` only (`403 EDIT_WINDOW_CLOSED`). Status changes are ADMIN; `CANCELLED` requires a reason (`CANCEL_REASON_REQUIRED` in the service, the zod refine and a CHECK constraint); leaving CANCELLED clears the reason. Responses: anyone with `violations.respond` on a violation in their scope; every other active admin is notified (`VIOLATION_OBJECTION`).
**Consequences.** Hiding is enforced by the database query, not by the UI. A violation without a team snapshot is visible to admins and its recorder only.

## ADR-048 — Violation photos through FilesService entity hooks; limits, row lock, retention job
**Decision.** `FilesService.registerHook(entity, hook)` lets a feature module add rules to the generic presign/confirm flow without StorageModule importing it. The violations hook: presign needs `entityId` + `kind` (`ID_CARD`/`EVIDENCE`), images only (JPEG/PNG/WebP, else `415 FILE_TYPE_NOT_ALLOWED`), the recorder or `violations.manage` (else 404); limit = 1 ID card / `VIOLATION_MAX_PHOTOS` evidence, counting linked files **plus** PENDING uploads whose URL has not expired (an abandoned upload stops counting after the TTL, so an offline retry is never locked out) → `409 TOO_MANY_PHOTOS`. Confirm (after the HEAD + size + magic-byte checks) marks READY and links the file inside a transaction that locks the violation row (`FOR UPDATE`), re-checks the limit and inserts `violation_files`; over the limit → the object is deleted and the row marked deleted. A repeated confirm of a READY file re-runs the idempotent link (unique `file_id`). A partial unique index allows one ID card per violation. Keys: `violations/{yyyy}/{mm}/{uuid}.{ext}`. Retention: a daily job (03:15 Asia/Riyadh) does nothing while `VIOLATION_PHOTO_RETENTION_DAYS = 0`; otherwise it deletes the objects of photos whose violation was captured before the cut-off (unlinked uploads: created before it), sets `files.deleted_at` (the link stays, `ready = false`) and writes one system audit entry `violations.photos_purged`.

## ADR-049 — Violation statistics and exports in Asia/Riyadh time
**Decision.** Filters `from`/`to` are Riyadh calendar days turned into instants `[D 00:00+03:00, D+1 00:00+03:00)` (Riyadh has no DST). `GET /violations/stats` runs one `$queryRaw` per chart with one shared, fully parameterised WHERE (`violationWhereSql()`); grouping uses `AT TIME ZONE 'Asia/Riyadh'` (trend per day, heatmap weekday 0 = Sunday × hour). KPIs: `total` uses all filters; `thisWeek`/`previousWeek` are Sunday-start Riyadh weeks relative to today and ignore the date range (they keep the other filters). `byTeam` uses the snapshot, leaves out violations without a team, and `members` = memberships of the team open at period end (the end of `to`, or now, whichever is earlier); `perMember = count / members` (0 when the team has none). `topMembers` = the 10 members with more than one violation (current team shown). `points` = the 5,000 newest, with `pointsTruncated`. Excel (ADR-019): sheets «المخالفات» and «ملخص», `views: [{ rightToLeft: true }]`, no frozen view, Arabic headers, date cells shifted to Riyadh wall-clock time with `yyyy-mm-dd hh:mm`, masked national IDs, widths fitted (10–60), at most 50,000 rows (the summary says when truncated); audited `violations.exported`. `GET /violations/dashboard.pdf` follows ADR-043: 501 without `PDF_SERVICE_URL`, otherwise `POST {PDF_SERVICE_URL}/render/violations-dashboard` with `{ kind, filters, stats, generatedAt }`; audited `violations.dashboard_exported`.

## ADR-050 — Phase 3 audit action vocabulary
**Decision.** New `action` values: `violation_type.created`, `violation_type.updated`, `violation.updated` (before/after of the changed fields), `violation.status_changed`, `violation.response_added` (`after = { responseId, length }`, not the text), `violation.id_photo_viewed` (every presigned URL of an ID-card photo issued through `/violations/:id/files/:fileId/url`; the generic `/files/:id/url` keeps `file.id_card_url_issued`), `violations.exported`, `violations.dashboard_exported`, `violations.photos_purged` (system actor). `entityType`: `violation`, `violation_type`, `violation_file`. Creating a violation is not audited (the row itself records who, when and from which device). Evidence-photo views are **not** audited: they carry no identity document, and auditing every thumbnail would bury the ID-photo entries the brief asks for.
**Consequences.** `apps/web/src/i18n/ar.ts` needs an `audit.action.*` label for each, and a label for the notification type `VIOLATION_OBJECTION`.

## ADR-051 — Web Phase 2: one demo module with the API's rules and seed
**Decision.** Phase 2 endpoints live in `apps/web/src/api/demo/phase2.ts`, created by `DemoApi` with a narrow internals interface (`actor`, `writeAudit`, `notify`, `readSettings`). Every write runs in one Dexie `rw` transaction over all tables, so two concurrent creations with the same colour serialise and the second gets `COLOR_TAKEN` with `ColorTakenDetails` — the demo's stand-in for the partial unique index. The colour rule is a copy of the API's `availableColors()`. Dexie schema v2 adds the Phase 2 tables; a `seededPhase2` flag seeds them in browsers seeded during Phase 1. `seed/demo/colors.json` and `cards.json` use the API seed's palette, built-in sizes and three templates verbatim; the placeholder logo is a neutral generated PNG (no organisation). The as-built API deviations (`docs/phase-2-backend.md`) are mirrored: `GET /teams` default ACTIVE+PENDING, whole-move rejection with `details.memberIds`, `DELETE /reference` → `{ result, item }`, logo deletion detaches templates.
**Consequences.** `ReferenceRemoveResult` and the `status: 'ALL'` team filter are typed locally in `apps/web/src/api/client.ts` (not yet in `@nuzli/shared`).

## ADR-052 — Formation board: physical edge auto-scroll and position-based keyboard moves
**Context.** dnd-kit's auto-scroller decides "can scroll left" from `scrollLeft > 0`; in RTL `scrollLeft` is 0 at the start and negative towards the left, so it never scrolls towards the later columns.
**Decision.** `autoScroll={false}`; a `requestAnimationFrame` loop scrolls the board by ±14px when the pointer is within 64px of its left/right edge. Pointer x and `scrollBy` are both physical, so no sign flip is needed. The keyboard sensor's coordinate getter jumps to the droppable whose centre is physically left/right of the dragged item (ArrowLeft = the column on the left, in any direction); the target column is brought into view with `scrollIntoView` (direction-aware). Programmatic "next/previous columns" buttons use `scrollInline(el, logical)` = `scrollBy(logical × dirSign())`. Collision: `pointerWithin`, falling back to `rectIntersection` for the keyboard. The «بلا فريق» column is a drag source only — the API has no "unassign" move. Moves are optimistic on the `['members','all']` cache and rolled back on error.

## ADR-053 — Create-team flow: local preview first, server commit after creation
**Decision.** The create dialog has two steps. Rows (typed, pasted, or read from .xlsx in the browser with exceljs loaded on demand) are previewed with the shared `memberInputSchema`, in-file duplicates and list matching (`features/members/importRows.ts`, the same function the demo adapter uses). Commit = `POST /teams` (no inline members) then `POST /members/import` with `commit: true`, whose per-row results (e.g. an ID already registered) are shown in the same table; the team is created once and reused if the import is retried. Existing teams use the server preview (`commit: false`). On `COLOR_TAKEN` the dialog returns to step 1, shows `message_ar` and replaces the picker with `details.available`; reserved colours are never rendered.

## ADR-054 — Browser printing from the batch, not from screen state
**Decision.** «طباعة N كروت» first creates the batch (`idempotencyKey` = one UUID per print attempt, kept across a failed retry, reset when the cards or template change), then navigates to `/cards/print/:batchId?auto=1`, outside the app shell. The print view renders `<PrintSheet>` from the batch items and the template snapshot (falling back to the live template for missing fields), waits for `document.fonts.load()` of IBM Plex Sans Arabic 400/500/700 and IBM Plex Mono 400/500, `document.fonts.ready` and every `<img>`, then calls `window.print()` once. Reprinting from the log reopens the same batch without logging a new one. Screen previews scale mm-sized cards with CSS `zoom` (`FitCard`) so the layout stays in millimetres; print never goes through it.

## ADR-055 — Lazy-loaded Phase 2 routes
**Decision.** Phase 2 pages (dnd-kit, exceljs, card layouts) are `React.lazy` chunks behind a `Suspense` loader in `app/router.tsx`, keeping the main bundle at ~740 kB (was ~970 kB). Routes may set `handle: { fullWidth: true }` (formation, cards, templates) to drop the 1200px content width.

## ADR-056 — Server-side scheduling on every task write (implements ADR-017)
**Context.** The browser runs `@nuzli/scheduling` while dragging and sends the shifted tasks, but the server must not trust client dates (brief §6.4).
**Decision.** Every task write (`POST /projects/:id/tasks`, `PATCH /tasks/:id`, `POST /projects/:id/tasks/batch`, `DELETE /tasks/:id`, `POST /projects/:id/dependencies`, calendar and project-setting changes) runs one interactive transaction (`apps/api/src/projects/project-store.ts`): `SELECT … FROM projects … FOR UPDATE` serialises writers of one project; all non-archived tasks and dependencies are loaded; **all** expected versions are checked first (any mismatch → `409 CONFLICT_VERSION`, `details = { refresh: 'tasks', conflicts: [{ id, currentVersion | null }] }`, nothing written); the edit is applied; `recompute()` re-runs `schedule()` (auto-schedule per project, `changed` = the edited ids) and `computeWbs()`; the result is diffed with what was loaded. Tasks whose start, end, duration, progress, status, parent, sort order, type, name, priority, assignee or description changed are written with `version + 1` behind `WHERE id AND version` (a lost race also ends in 409); a task whose only change is its WBS number gets `wbs_cache` refreshed **without** a version bump (it is derived, and bumping it would make unrelated open editors conflict). The response lists every task written (`affected` / `tasks`) so the client never re-fetches. Each written task gets an audit entry: the edited ones with the request's action, the others `task.moved` with `after.auto = true`. Engine errors are mapped: `CycleError` → `409 DEPENDENCY_CYCLE` with `details.path`; `HierarchyError` → `TASK_PARENT_INVALID`.
**Consequences.** One code path for all writes; a 2,000-task batch is one transaction (timeout 60 s). Removing a dependency never reschedules (forward-only engine).

## ADR-057 — Task hierarchy: automatic GROUP, fractional sort order, server-normalised dates
**Decision.** (1) A `TASK` that receives a child becomes a `GROUP` automatically (in the same write); a `GROUP` that loses its last child stays a `GROUP` with its last rolled-up dates; a `MILESTONE` can never be a parent (`TASK_PARENT_INVALID`), nor can a task be moved under itself or a descendant. (2) `sort_order` is a float: insert after a sibling = midpoint to the next sibling, append = last + 1, re-parent without `sortOrder` = append; when two neighbours are closer than 1e-9 the sibling group is renumbered 1..n first. (3) For edited leaves the server snaps a weekend/holiday start to the next working day, keeps `durationDays` (an `endDate` alone becomes the working-day count, both ends included) and recomputes `endDate = endFromDuration(start, duration)`; a `TASK` lasts at least 1 working day; a `MILESTONE` has duration 0 and end = start. Dates sent for a task that has children are ignored — groups are always rolled up. (4) Delete archives the task and its whole subtree (`archived_at`, version + 1) and **deletes** the dependencies that touch them (listed in the `task.archived` audit entry); the remaining parents are rolled up.

## ADR-058 — Project scope, supervisor rights (clarifies ADR-007) and task attachments
**Decision.** Scope (`projectScopeWhere`): `projects.readAll` → every project; `projects.readGranted` → non-archived projects with a `project_access` row for the user **or** a non-archived task assigned to them; anything else answers 404. Supervisors read every task of a visible project, may `PATCH` only `progress` and `status` (plus `version`) of tasks assigned to them — any other field → `403 FORBIDDEN` with `details.fields`, someone else's task → 403. They may **comment on any task of a visible project** (collaboration and replying to @mentions; ADR-007 is read as "comments are not limited to own tasks"). Mentions must be ACTIVE admins or supervisors who can see the project (`VALIDATION_FAILED` with `details.userIds`). Access grants (`VIEW`) go to ACTIVE supervisors only and are idempotent. Assignees must be ACTIVE supervisors (`ASSIGNEE_NOT_SUPERVISOR`, also mapped from the DB trigger, SQLSTATE 23514). Calendars are managed under `projects.manage` (no new permission). Attachments: the generic `/files/presign` + confirm with `entityType: 'task'`, `entityId` = the task (required), `kind` ATTACHMENT; the task hook allows uploads by `tasks.manage` and the assignee; confirm attaches through `files.entity_type/entity_id` (no link table) and audits `task.attachment_added` once; `POST /tasks/:id/attachments { fileId }` attaches a READY file uploaded without `entityId`; anyone who can see the project gets a download URL through `GET /tasks/:id/attachments/:fileId/url`; admins and the uploader delete (`task.attachment_removed`).

## ADR-059 — Calendar edits re-derive projects; daily reminders; tasks Excel
**Decision.** Changing a calendar's weekend, adding or deleting an exception, changing a project's calendar or switching its auto-schedule on re-derives every non-archived project concerned in the same transaction: each leaf end is recomputed from start + duration with the new calendar, then the full forward pass runs (successors only move later — a removed holiday shortens tasks but does not pull successors back). A duplicate exception date → `409 CALENDAR_DATE_EXISTS`. No holiday data is seeded. Reminders: a cron at 07:00 Asia/Riyadh sends `TASK_OVERDUE` (end < today in Riyadh, not DONE, assigned, project not archived) and `TASK_DUE_SOON` (end between today and the 2nd working day after today on the project calendar) once per task: the run first claims `overdue_notified_at` / `due_soon_notified_at` with a conditional `UPDATE … WHERE column IS NULL`, so repeated or concurrent runs never notify twice; any write that moves a task's end date clears both columns. `GET /tasks/mine` uses the same rule for its `overdue` / `dueSoon` flags. Excel (`GET /projects/:id/export.xlsx`, ADR-019): sheets «المهام» (WBS order, Arabic headers, real date cells `yyyy-mm-dd`, progress as a `0%` cell, task name indented by level with `alignment.indent`, groups bold) and «المشروع», both `rightToLeft`, no frozen view; audited `project.exported`.

## ADR-060 — Phase 4 audit action vocabulary and notifications
**Decision.** New `action` values: `project.created`, `project.updated`, `project.archived`, `project.access_granted`, `project.access_revoked`, `project.exported`, `task.created`, `task.updated`, `task.archived`, `task.moved` (batch edits and automatic shifts — `after.auto`, `after.cause` = `dependency` / `archive` / `calendar…` / `project.updated`), `task.comment_added` (`after = { commentId, length, mentions }`, not the text), `task.attachment_added`, `task.attachment_removed`, `dependency.created`, `dependency.deleted`, `calendar.created`, `calendar.updated`, `calendar_exception.created`, `calendar_exception.deleted`. `entityType`: `project`, `task`, `dependency`, `calendar`. `GET /tasks/:id/activity` returns the task's entries plus the dependency entries naming it (newest first, at most 200). Notifications with Arabic e-mails: `TASK_ASSIGNED` (create or re-assign, never to oneself), `TASK_MENTIONED`, `TASK_DUE_SOON`, `TASK_OVERDUE`; payload `{ taskId, taskName, projectId, projectName, endDate | commentId, authorName }`.
**Consequences.** `apps/web/src/i18n/ar.ts` needs an `audit.action.*` label for each new action.

## ADR-061 — Secrets are checked at start-up; Swagger is off in production by default
**Context.** Security review 2026-10 H1/L5: the `.env.example` JWT placeholder passed the 32-character rule, so a copied file let anyone forge admin tokens. The example bootstrap password met the password policy. Swagger was on whenever `.env` was copied from the example.
**Decision.** With `NODE_ENV=production`, `envSchema` refuses: any value containing `CHANGE_ME` (any case, `-`/`_`) in `JWT_ACCESS_SECRET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `SMTP_PASS`, `DATABASE_URL`; a `JWT_ACCESS_SECRET` that is not base64/base64url of ≥ 32 bytes, lacks mixed case, has < 16 distinct characters or < 3.8 bits/char (`config/secret-strength.ts`); national-ID keys whose 32 bytes have < 16 distinct values, or an HMAC key equal to the encryption key; `PDF_SERVICE_URL` without a strong `PDF_SERVICE_TOKEN`. The seed refuses a `CHANGE_ME` bootstrap password in every environment. `SWAGGER_ENABLED` unset → on in development/test, off in production; only an explicit `true` turns it on there. All example values are deliberately invalid (`CHANGE_ME…`), with `openssl rand -base64 48` / `echo "v1:$(openssl rand -base64 32)"` next to them.
**Consequences.** The entropy rule is best effort: it stops placeholders, repeats and single-case phrases but cannot recognise every memorable phrase, so the examples insist on `openssl`. Development and tests keep accepting simple values.

## ADR-062 — Login: progressive delays per IP and per identifier, short silent lock
**Context.** Review M5/L8: five bad guesses locked any account for 15 minutes from anywhere (a cheap way to lock admins out), `ACCOUNT_LOCKED` revealed which identifiers exist, and wrong current passwords on `change-password` were not counted.
**Decision.** `LoginThrottleService` (in memory; one API instance) keeps three buckets per failed check: IP (20 free, then 1 s doubling to 15 min), identifier as typed and normalised — e-mail lower-cased, mobile in E.164, unknown identifiers too (5 free, capped at **60 s**), and identifier+IP (3 free, up to 15 min). While a bucket cools down the API answers `429 RATE_LIMITED` with `details.retryAfterSeconds` before checking the password. Identifiers are SHA-256-hashed in memory. The account lock stays but is short (`LOGIN_MAX_FAILURES=10`, `LOGIN_LOCK_MINUTES=5`): a locked account answers `401 INVALID_CREDENTIALS` even with the right password (hash still verified, so timing is unchanged), the lock is audited `auth.account_locked` and the owner gets an e-mail with the reset link. A successful password reset clears `lockedUntil` and the account's delays. `change-password` uses the same buckets (key `user:<id>`) and the same failure counter.
**Consequences.** `ACCOUNT_LOCKED` is no longer returned by the API (the code stays in `@nuzli/shared`). The web client should show `RATE_LIMITED`'s `message_ar` (and may count down `retryAfterSeconds`). A second API replica would need a shared store (Redis) for the buckets.

## ADR-063 — Public registration never reveals existing accounts
**Context.** Review M4: `POST /auth/register` answered `EMAIL_TAKEN` / `MOBILE_TAKEN` / `NATIONAL_ID_TAKEN`, so anyone could test whether a national ID has an account (PDPL).
**Decision.** The endpoint always answers `201 { status: 'PENDING' }`. If the e-mail, mobile or national-ID blind index already belongs to a user, nothing is created. After the response, each matching owner gets the e-mail «محاولة تسجيل ببياناتك في نزلي» and the attempt is audited `registration.duplicate_attempt` (`entityId` = the owner, no personal data). The unique indexes still guard the race, and a P2002 there gets the same answer. Admin-created users (`POST /users`) still get the precise `*_TAKEN` conflict.
**Consequences.** An applicant who registers twice sees "pending" and finds the explanation in their mailbox. The web success screen must not claim that an account was created; it should say "if the details are new, your request awaits approval; check your e-mail".

## ADR-064 — Card print data: masked at rest, full IDs only for the print run; server-derived ID and QR
**Context.** Review M2/M3/L6: `card_print_items.rendered_data` kept full national IDs in plain JSON (DB, backups, exports), card previews decrypted up to 1,000 IDs without an audit entry, and the client could choose `nationalId` / `qrValue`.
**Decision.** `rendered_data.nationalId` is always masked. A new column `national_id_printed` (`'FULL' | 'MASKED'`, CHECK constraint) records what the physical card carried; migration `20261016000000_card_print_masked_ids` masks and flags the existing rows. `POST /cards/batches` derives `nationalId` (from `team_members` / `users`, per the template) and `qrValue` (the member or user UUID) on the server, plus `photoFileId` (from the member), and ignores the client's values. Only the text fields (name, job title, department, team label, colour, validUntil, roleLabel) come from the client. Its answer adds `cards: PrintRunCardDto[]`, and that is the only place where full IDs appear. An idempotent replay re-derives them from the DB and is audited `cards.print_data_reissued`. `GET /cards/batches` and `GET /cards/batches/:id` return masked data plus `items[].nationalIdPrinted`. The PDF path decrypts FULL items from the DB at render time and sends them to `PDF_SERVICE_URL` with `X-Pdf-Service-Token: <PDF_SERVICE_TOKEN>`. The service must sit on the internal `backend` network only (the dashboard PDF sends the same header). `POST /cards/preview` is limited to 20 requests per minute per IP. When it decrypts full IDs, it writes `cards.preview_full_ids` with `{ templateId, templateName, count, teamCount, memberCount }`, and never the IDs or the people.
**Consequences.** A reprint shows the member's current national ID, not a historical copy. The web print view must take the cards to print from the `POST /cards/batches` answer, keep them in memory only, and never re-read full IDs from the batch detail.

## ADR-065 — Uploads go to `pending/`; confirm copies to a final key that never had a PUT URL
**Context.** Review M1: the presigned PUT URL stayed valid after confirm, so verified evidence could be replaced with other bytes of the same length and type.
**Decision.** Presign hands out a PUT URL for `pending/<uuid>.<ext>` only. Confirm checks that the object exists and its size, then calls S3 `CopyObject` to the final key `<folder>/<yyyy>/<mm>/<uuid>.<ext>` (supported by OCI Object Storage and MinIO). It verifies the **copy** (HEAD, size, magic bytes, declared sha256), deletes the pending object, and stores the final key with the sha256 of the final bytes (now always recorded). Any failure deletes both objects. A concurrent duplicate confirm returns the winner's READY state. The PENDING cleanup removes `pending/` objects. A bucket lifecycle rule on `pending/` (1 day) is recommended.
**Consequences.** Confirm reads each upload in full (≤ 10 MB). Files confirmed before this change keep their keys. Nothing changes for the client.

## ADR-066 — Upload scope: violation window and status; logos admin-only; member photos closed
**Context.** Review L2/L3: a monitor could add photos to old or CANCELLED violations at any time, and `member_photo` / `logo` uploads had no owner checks and were never cleaned up.
**Decision.** Violation photos: never on a CANCELLED violation (`409 INVALID_STATE`, admins included). Within `VIOLATION_EDIT_WINDOW_MINUTES` of `received_at`, the configured limits apply. After the window, the recorder may only finish the **original sync**: up to `expected_id_photos` / `expected_evidence` of each kind. Beyond that, the answer is `403 EDIT_WINDOW_CLOSED`, or `TOO_MANY_PHOTOS` at confirm. `violations.manage` is not bound by the window. Logos: `logos.manage` (admins) only, and no `entityId`. Member photos: nobody can presign one until a member-photo route exists that checks the member's scope and links the file at confirm. The enum value stays for compatibility. A new hourly job deletes READY logo or member-photo files that nothing links to after 24 h.
**Consequences.** Offline devices that announced their photo counts can still sync late. A later member-photo feature must add its own `FileEntityHook`.

## ADR-067 — Full national IDs stay out of URLs; supervisors get a neutral duplicate error
**Context.** Review L4/L7: `GET /members?q=` and `GET /users?q=` accepted full IDs in the query string, and `POST /teams/:id/members` told a supervisor that an ID already existed anywhere.
**Decision.** `GET /members`, `GET /users` and `GET /users/supervisors` answer `400 VALIDATION_FAILED` (`details.useInstead`) when `q` contains a full ID: 10 digits starting with 1 or 2, Arabic-Indic digits included (`isFullNationalIdTerm`). Mobiles and last-4 searches pass. New endpoints `POST /members/search` (`memberSearchSchema`: `page, pageSize, sort, q, teamId, unassigned:boolean`) and `POST /users/search` (`userSearchSchema`: `page, pageSize, sort, q, role, status`) take the same filters in the body and answer `200` with the same paginated list. For callers without `members.manage`, a duplicate national ID on member create, member update or team-with-members create answers `400 NATIONAL_ID_NOT_ACCEPTED` with a neutral message on the same field paths, and writes `member.duplicate_rejected` (scope and row count only). Admins keep `409 NATIONAL_ID_TAKEN`. These routes are limited to 30 requests per minute per IP.
**Consequences.** The fact that the save failed still tells the supervisor something; rate limit plus audit make probing slow and visible. The web search box must switch to `POST …/search` when `isFullNationalIdTerm(term)`.

## ADR-068 — One env file per service; read-only, capability-free containers
**Context.** Review M6/L9/L10: every container loaded the whole `.env` (the API held the backup passphrase, the backup container held the national-ID keys), backups defaulted to the app bucket and keys, the API image's code was writable by the runtime user, and dev ports listened on every interface.
**Decision.** Root `.env` keeps only compose settings (ports, tag, certificate folder). Secrets live in `env/api.env`, `env/db.env`, `env/backup.env` (+ `env/minio.env` for dev), each loaded by its service only. Examples are committed, and `env/.gitignore` ignores the real files. The backup container uploads only with its own `BACKUP_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY`: all are required when `BACKUP_S3_ENABLED=true`, which defaults to off in every environment, and nothing falls back to `S3_*`. The api, proxy and backup services run with `read_only: true`, a tmpfs `/tmp`, `cap_drop: [ALL]` and `no-new-privileges`. Postgres gets `no-new-privileges` only, since it needs its capabilities to set up its data directory. The API image leaves `/repo` owned by root and read-only for `node`. Dev publishes 3000, 5432, 8025 and 9001 on `127.0.0.1` only. The dev storage location repeats `nosniff` and adds `Content-Security-Policy: default-src 'none'; sandbox`, CORP and no-referrer. When run on the host, the API also reads `env/api.env`.
**Consequences.** Existing installs must split their `.env` (README still describes a single `.env` and needs updating). The DB password appears in `env/db.env`, in `env/api.env` (`DATABASE_URL`) and in `env/backup.env` (`PGPASSWORD`). The lockfile gap (ADR-022) remains open until `pnpm-lock.yaml` is committed.

## ADR-069 — Backups: pg_dump custom format + gpg (MDC); restore into a new database, then swap
**Context.** Review M7/L1: restore piped `openssl | gunzip | psql` straight into the live database, so a truncated file could commit half a restore. The CBC encryption had no MAC, and a missing checksum only produced a warning.
**Decision.** `backup.sh` streams `pg_dump -Fc` into `gpg --symmetric --cipher-algo AES256` (S2K SHA-512), so no plaintext touches the disk. It reads the result back (`gpg -d | pg_restore --list`) before keeping it, and writes `.sha256`. The passphrase must be at least 40 characters and never `CHANGE_ME`. `restore.sh` requires a matching `.sha256` and decrypts to a private temp directory on the backups volume (gpg MDC: a tampered or truncated file fails). It validates the archive (`pg_restore --list`; legacy `.sql.gz.enc`: `gzip -t` plus the dump trailer) and restores with `--single-transaction --exit-on-error` into `<db>_restore_<ts>`. It then checks migrations, users and admins, and swaps by renaming both databases in one transaction (the previous one is kept as `<db>_pre_restore_<ts>`). `--verify` does the same into a scratch database and drops it. Any failure drops the new database and leaves the live one untouched. Runbook and drill: `docs/backup-restore.md`.
**Consequences.** A restore needs free space for a second copy of the database. The old database must be dropped by hand once checked.

## ADR-070 — National-ID key rotation script
**Context.** ADR-011 versions the encryption key but had no tool to re-encrypt existing rows or to move the blind index to a new HMAC key.
**Decision.** `apps/api/src/scripts/rotate-national-id-key.ts` (`node dist/scripts/rotate-national-id-key.js [--dry-run] [--batch-size=N]`) walks `users` and `team_members` by id in batches. Each row is decrypted with the keyring (`NATIONAL_ID_ENC_KEY` plus `NATIONAL_ID_ENC_KEYS_OLD`) and re-encrypted when its version is not current. Its hash is recomputed with the current `NATIONAL_ID_HMAC_KEY` and written when it differs, one transaction per batch. The script is idempotent and logs counts only. Encryption-key rotation runs with the API up. HMAC rotation needs the API stopped (lookups and uniqueness use the hash).
**Consequences.** Old encryption keys stay in `NATIONAL_ID_ENC_KEYS_OLD` until every backup that needs them has expired. Restoring an older backup requires running the script again before the API starts.
