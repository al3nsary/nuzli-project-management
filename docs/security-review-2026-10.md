# Security & privacy review — phases 1–4 (2026-10-12)

Scope: `apps/api` (src, prisma), `packages/shared/src`, compose files, `infra/nginx`, `infra/backup`, both Dockerfiles, `.env.example`. Read-only review against brief §4.4/§13 and `.claude/agents/security-privacy.md`. `apps/web` was not reviewed (another agent is editing it).

Every finding below was checked in the code. Items marked **to verify** need a runtime check.

---

## Status (2026-10-12, commit `fix(security): address 2026-10 review findings`)

Fixed in the API and infrastructure. The web client still has follow-ups for M2, M4, M5 and L4 (see the ADRs). Integration tests (`test/int`) were updated but not run here: no Docker on this machine.

| # | Status | Where (ADR) |
|---|---|---|
| H1 | **Fixed** | `apps/api/src/config/env.schema.ts`, `config/secret-strength.ts`, `seed/seed.ts`, `.env.example`, `env/*.env.example`. Tests: `config/env.schema.spec.ts` (ADR-061) |
| M1 | **Fixed** | `storage/files.service.ts` (`pending/` key → `CopyObject` → verify the copy → delete pending), `storage/storage.service.ts`. Tests: `storage/files.service.spec.ts`, `test/int/files.int-spec.ts` (ADR-065) |
| M2 | **Fixed** | Migration `20261016000000_card_print_masked_ids` (masks old rows, adds `national_id_printed`), `cards/print.service.ts`, `cards/card-data.ts`. Full IDs only in the `POST /cards/batches` answer (`cards`) and in the PDF request (ADR-064) |
| M3 | **Fixed** | `cards.preview_full_ids` audit (count and template only) + 20/min limit on `POST /cards/preview` (ADR-064) |
| M4 | **Fixed** | `auth/auth.service.ts` `register`: always `201 {status:'PENDING'}`, owner e-mail, `registration.duplicate_attempt` audit. Tests: `auth/auth.service.spec.ts`, `test/int/registration.int-spec.ts` (ADR-063) |
| M5 | **Fixed** | `auth/login-throttle.ts` (per IP / identifier / pair, progressive, ident capped at 60 s) + 5-minute silent lock answering `INVALID_CREDENTIALS`, `auth.account_locked` audit and owner e-mail; a reset clears it (ADR-062) |
| M6 | **Fixed** | `env/{api,db,backup,minio}.env.example`, `docker-compose*.yml`, `infra/backup/common.sh` (`BACKUP_S3_*` required, off by default, no fallback to `S3_*`) (ADR-068) |
| M7 | **Fixed** | `infra/backup/restore.sh`: mandatory checksum → decrypt to a temp file → archive check → restore into a new database in one transaction → checks → transactional rename swap. Runbook and drill: `docs/backup-restore.md` (ADR-069). The truncation drill itself still has to be run on a Docker host (§3 of the runbook) |
| L1 | **Fixed** | `gpg --symmetric --cipher-algo AES256` (MDC; tamper and truncation fail, checked locally), `pg_dump -Fc`, missing checksum is fatal (ADR-069) |
| L2 | **Fixed** | `violations/violation-files.service.ts`: CANCELLED → `INVALID_STATE`; after the edit window only up to the expected counts (ADR-066) |
| L3 | **Superseded by A8 — reopened with scope hook** | `storage/file-policy.ts`: logos admin-only without `entityId`; member and user photos open only through `photos/photos.service.ts` hooks (leading supervisor or admin; self or admin), refused when no hook is registered; `cleanupOrphans` also covers user photos (ADR-066, ADR-083) |
| L4 | **Fixed** | `POST /members/search`, `POST /users/search`; GET list routes refuse full IDs in `q` (`common/search-term.ts`, `isFullNationalIdTerm` in shared) (ADR-067) |
| L5 | **Fixed** | `SWAGGER_ENABLED` unset → off in production; examples set `false` (ADR-061) |
| L6 | **Fixed** | Server sets `nationalId`, `qrValue` and `photoFileId` from the DB on `POST /cards/batches` (ADR-064) |
| L7 | **Fixed** | `members/member-writes.ts` `hideDuplicateNationalId`: non-admins get `NATIONAL_ID_NOT_ACCEPTED` + `member.duplicate_rejected` audit; 30/min on member and team writes (ADR-067). **Accepted residual:** a failed save still hints that something is wrong with the ID |
| L8 | **Fixed** | `change-password` counts toward the throttle and the account lock (ADR-062) |
| L9 | **Fixed / Accepted** | Fixed: root-owned read-only code in `apps/api/Dockerfile`; `read_only`, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges` on api, proxy and backup (`no-new-privileges` only on db). **Accepted (open):** no committed `pnpm-lock.yaml` yet (ADR-022) |
| L10 | **Fixed** | Dev ports bound to `127.0.0.1`; `infra/nginx/dev-storage.conf` repeats nosniff and adds a sandbox CSP (ADR-068) |
| To verify: PDF transport | **Fixed (config)** | `X-Pdf-Service-Token` from `PDF_SERVICE_TOKEN` (required in production with `PDF_SERVICE_URL`) on card and dashboard PDFs. The renderer must join only the `backend` network. No PDF service is deployed yet |
| To verify: logout clears caches | Open (web) | Out of scope for this change (`apps/web`) |

---

## High

### H1. Placeholder secrets pass start-up validation, so access tokens can be forged
- `apps/api/src/config/env.schema.ts:53` only requires `JWT_ACCESS_SECRET` to be at least 32 characters. The placeholder `CHANGE_ME_at_least_32_random_characters_here` (`.env.example:41`) is 44 characters, so it passes.
- Exploit: an operator copies `.env.example` and forgets this line. Any user can learn an admin's UUID from data they can already see (comment authors, `recordedBy`, `supervisor` in DTOs). They sign `{sub: <admin uuid>, iss: nuzli-api, aud: nuzli-web}` with the public placeholder secret. `JwtAuthGuard` then loads the real admin, so the attacker gets full admin rights, including full national IDs and ID photos.
- The same problem affects `BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_Admin12345` (`.env.example:57`). It meets the password policy, and `src/seed/seed.ts:125-159` accepts it. If the operator fills in the national ID but not the password, whoever logs in first owns the bootstrap admin, because `mustChangePassword` lets that person choose the new password.
- **Fix:** in `envSchema`, reject any secret containing `CHANGE_ME` (`JWT_ACCESS_SECRET`, `S3_*`, `SMTP_PASS`) and require high entropy (for example, base64 of 32 or more random bytes). In `seed.ts`, refuse a bootstrap password containing `CHANGE_ME`.

---

## Medium

### M1. The presigned PUT URL still works after confirm, so verified uploads can be replaced
- `storage/files.service.ts:77` issues a PUT URL valid for `PRESIGNED_URL_TTL_SECONDS` (up to 3600 s). `confirm()` (`:119`) checks size, magic bytes and sha256, then marks the file READY. Nothing invalidates the URL afterwards.
- Exploit: a monitor confirms a genuine ID or evidence photo, then PUTs other bytes of the same length and content type to the same URL. Size and content type are signed (`storage.service.ts:47-56`), but the content is not. The stored object is now unverified (arbitrary bytes, a polyglot, or doctored evidence), and the file row still shows the checked sha256 and `READY`.
- **Fix:** on confirm, `CopyObject` the pending key to a final key (`violations/yyyy/mm/<uuid>.<ext>`), delete the pending key, and store the final key. Never serve the pending key. Optionally record the ETag at confirm and compare it on GET.

### M2. Full national IDs are stored unencrypted in `card_print_items.rendered_data`
- `cards/card-data.ts:79-87` (`storedCardData`) keeps the full ID when the template prints it unmasked. `print.service.ts:203` stores it as plain JSON, `:318` (`getBatch`) returns it, and `:359` sends it to the PDF service. This breaks brief §13 / ADR-011 ("AES-GCM at rest"): the ID ends up in plain text in the DB, in every backup, and in any JSON export of the table.
- **Fix:** always store the masked form plus `memberId`/`userId`. When rendering a PDF or reprinting, decrypt from `team_members` / `users` at that moment (as `memberCard` already does). If an exact as-printed copy is legally required, store it as an AES-GCM ciphertext (`crypto.encrypt`) and decrypt only in `streamPdf`.

### M3. Card preview decrypts up to 1,000 full national IDs with no audit entry
- `cards/print.service.ts:97` (`preview`, route `cards.controller.ts:104`) calls `crypto.decrypt` for every subject when the template is unmasked. It writes no audit entry. Only `createBatch` and the PDF are audited. In practice this is a bulk export of national IDs that leaves no trace.
- **Fix:** add a `cards.previewed` audit entry with `{ templateId, count, nationalIdFull: true, teamIds, memberIds }` whenever the full ID is included. Optionally, mask the preview and decrypt only when a batch is recorded.

### M4. Public registration reveals whether a national ID, e-mail or mobile number exists
- `auth/auth.service.ts:183-219` together with `common/prisma-errors.ts:7-9`: `POST /auth/register` (anonymous, 10 requests/min/IP) returns `NATIONAL_ID_TAKEN`, `EMAIL_TAKEN` or `MOBILE_TAKEN`. Anyone can test whether a given person (by national ID) has an account. This is a PDPL disclosure, and it undoes the anti-enumeration care taken in `forgotPassword`.
- **Fix:** always answer `202 { status: 'PENDING' }`. When the national ID, e-mail or mobile already exists, create nothing and e-mail the existing account holder ("someone tried to register with your details"). Keep the unique index as the race guard, and map P2002 to the same 202.

### M5. Lockout is per account only, so anyone can lock out admins, and the lockout reveals which accounts exist
- `auth/auth.service.ts:111` returns `ACCOUNT_LOCKED` before checking the password, and `:120-128` locks after `LOGIN_MAX_FAILURES` attempts from any source.
- Exploit 1: five bad guesses every 15 minutes keep a known admin e-mail locked indefinitely. From several IPs, every admin can be locked at once.
- Exploit 2: unknown identifiers never return `ACCOUNT_LOCKED`, so five guesses show whether an e-mail or mobile number has an account.
- **Fix:** count failures per (account, IP) or (account, /24), or use exponential back-off instead of a hard lock. Return `INVALID_CREDENTIALS` for a locked account, and say "locked" only after the correct password, the same way status errors already work at `:133-135`. Notify the account owner by e-mail when a lock happens.

### M6. Every container receives every secret, and backups default to the app bucket with the app's keys
- `docker-compose.yml:37` and `:72`: both `api` and `backup` load `env_file: .env`. The API process therefore holds `BACKUP_ENCRYPTION_PASSPHRASE`. The backup container holds `NATIONAL_ID_ENC_KEY`, `NATIONAL_ID_HMAC_KEY` and `JWT_ACCESS_SECRET`, so compromising it exposes the ciphertext dump together with the keys that decrypt it.
- `infra/backup/backup.sh:31-34`: the bucket and credentials default to `S3_BUCKET` / `S3_ACCESS_KEY`, which are the API's own. With the API's S3 key, an attacker can delete or overwrite every backup.
- **Fix:** split the env files: `.env.api` (no backup passphrase) and `.env.backup` (PG*, `BACKUP_*` only). Make `BACKUP_S3_BUCKET` and `BACKUP_S3_ACCESS_KEY` required whenever `BACKUP_S3_ENABLED=true`. Use a separate bucket with write-only credentials and retention (object lock).

### M7. Restore pipes straight into psql, so a truncated backup can be committed half-restored (to verify by drill)
- `infra/backup/restore.sh:88` runs `decrypt | psql --single-transaction`. The dump was made with `--clean`, so it starts with DROP statements. If the file is truncated or corrupt, openssl and gunzip still emit everything before the error. If the stream ends inside a `COPY … FROM stdin` block, psql ends the copy at EOF and COMMITs. The result is dropped tables, partly filled data and a committed transaction. `pipefail` only fails the script after the damage is done. `--verify` (`:69`) checks only two row counts.
- **Fix:** decrypt into `$work` first, then run `gunzip -t`. Check that the plaintext ends with pg_dump's `-- PostgreSQL database dump complete` trailer. Only then feed the file to psql. Better still, switch to `pg_dump -Fc` and use `pg_restore --single-transaction`, which rejects truncated archives. In `--verify`, compare per-table row counts written to a manifest at backup time.

---

## Low

| # | Finding | Location | Fix |
|---|---|---|---|
| L1 | Backup encryption has no authentication (`aes-256-cbc`, no MAC). The `.sha256` integrity file sits in the same bucket, and a missing one only triggers a warning. | `infra/backup/backup.sh:24`, `restore.sh:57,61` | Use `age` or `gpg --symmetric` (authenticated), or encrypt-then-HMAC with a separate key. Treat a missing or failed checksum as fatal unless `--force`. |
| L2 | Violation photo upload checks only recorder or admin. It ignores the edit window and status, so a monitor can add evidence to an old or CANCELLED violation at any time. | `violations/violation-files.service.ts:47-51` | In `beforePresign`/`onConfirmed`, require `now < editableUntil(receivedAt) + grace` (for offline sync) unless `violations.manage`. |
| L3 | `member_photo` and `logo` have no `FileEntityHook`. A supervisor (`members.manageOwn`) can presign and confirm any number of 10 MB images or PDFs with an arbitrary `entityId`. Nothing ever links or deletes them, because cleanup covers only PENDING files. | `storage/file-policy.ts:18`, `storage/files.service.ts:56-77` | Register hooks that validate `entityId` scope, or remove `member_photo` from `presignUploadSchema` until a member-photo flow exists. Add a job that deletes READY files with no owner after 24 h. |
| L4 | A full national ID can travel in GET query strings (`/members?q=…`, `/users?q=…`). nginx logs `$uri` and pino strips the query, but service-worker caches, browser history and intermediaries do not. This violates "never in URLs". | `members/members.service.ts:57-60`, `users/users.service.ts:65-67` | Add `POST /members/search` and `POST /users/search` with the term in the body, and make the web app use them for 10-digit input. |
| L5 | Swagger is public in production if `.env` is copied from the example. `.env.example:20` sets it to `true`, and compose interpolation of `${SWAGGER_ENABLED:-false}` reads that `.env`. The route sits outside the guards. | `.env.example:20`, `docker-compose.prod.yml:25`, `main.ts:56-67` | Set the example to `false`, and in `envSchema` force it to `false` when `NODE_ENV=production` unless `SWAGGER_ALLOW_PROD=true`. |
| L6 | Print-batch card data comes from the client and is stored and rendered as sent (`nationalId`, `qrValue` ≤ 80). A QR code could carry a national ID, contrary to brief §8.2. | `cards/print.service.ts:203`, `packages/shared/src/schemas/cards-settings.ts:73-78` | Set `qrValue` on the server to `memberId`/`userId`, and set `nationalId` from the DB-derived `memberCard`/`supervisorCard`. Accept only the save-back fields from the client. |
| L7 | A supervisor can test whether a national ID exists: `POST /teams/:id/members` returns `NATIONAL_ID_TAKEN` checked against all members, not only the supervisor's scope. | `members/member-writes.ts:409-417` | Return a generic conflict without saying which field, and rate-limit member creation per user. Accept the residual risk for admins. |
| L8 | A wrong current password on `change-password` does not count toward the lockout. A stolen 15-minute access token allows 10 guesses per minute per IP at the real password. | `auth/auth.service.ts:349` | Increment `failedLoginCount` and lock the same way `login` does. |
| L9 | Build hardening: there is no `pnpm-lock.yaml`, so images install unpinned dependencies with `--no-frozen-lockfile`. The runtime image `chown`s the app to `node`, which makes the code writable at runtime. Compose sets no `read_only`, `cap_drop` or `no-new-privileges`. | `apps/api/Dockerfile:36,62,83`, `docker-compose.yml` | Commit the lockfile and remove the fallback. Leave `dist` owned by root and readable only. Add `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]` to the api, proxy and backup services. |
| L10 | Dev only: the API (3000) and Postgres (5432) are published on all interfaces. Hitting 3000 directly lets a client spoof `X-Forwarded-For`, because `TRUST_PROXY=1`. The `/nuzli/` location's own `add_header` drops the inherited CSP and nosniff headers for bucket objects served from the app origin. | `docker-compose.dev.yml:30,48`, `infra/nginx/dev-storage.conf` | Bind to `127.0.0.1:` and repeat `X-Content-Type-Options nosniff` plus `Content-Security-Policy "default-src 'none'; sandbox"` in that location. |

---

## To verify

- **PDF service transport.** `cards/print.service.ts:347-366` and `violations.service.ts:586-616` POST card data, which can include full national IDs (see M2), to `PDF_SERVICE_URL` with no auth header. Confirm that the service is reachable only on the `backend` network and that the URL is internal. Add a shared-secret header.
- **Logout clears device caches** (role checklist). This lives in `apps/web` (service worker, IndexedDB roster, React Query cache), which was not reviewed.
- **M7 failure mode.** Confirm it with a drill: truncate a backup at about 60% and run `restore.sh --yes` against a scratch database.

## Checked and found sound

- argon2id with a dummy-hash equal-time path. 15-minute HS256 JWT with alg, iss and aud pinned. The guard reloads role and status on every request.
- Refresh token: random 32 bytes, stored as SHA-256, rotated, with family revocation on reuse, on a lost rotation race and on expiry. The cookie is `httpOnly`, `Secure` (forced in production), `SameSite=Strict` and `Path=/api/v1/auth`. Double-submit CSRF on refresh and logout uses `timingSafeEqual`.
- helmet: API CSP, `frame-ancestors 'none'`, CORP same-origin, `no-referrer`, HSTS. CORS is an allow-list with credentials. nginx: TLS 1.2/1.3, HSTS, nosniff, DENY, CSP, COOP, and `$uri`-only access logs.
- Rate limits: auth routes 10/min/IP, presign and confirm 60/min, everything else 300/min. In production the API is reachable only through nginx (`expose`), and `TRUST_PROXY=1` matches the single hop.
- National ID: AES-256-GCM with a versioned keyring, HMAC blind index, masking in DTOs, audit (`sanitizeForAudit`), Excel export and roster. QR codes use the UUID. Object keys are `folder/yyyy/mm/uuid.ext`. Pino redaction is in place, and the request serializer strips query strings.
- Uploads: SVG is not allowed. Magic bytes are checked against the declared type. Size cap is 10 MB, and the presigned PUT signs content type and length. The bucket is private, and GET URLs are issued only after a scope check. Both ID-photo routes write audit entries.
- Data scope: violations (monitor sees what they recorded; supervisor sees their current non-archived teams only when visibility is SHOW; empty page or 404 otherwise), members and teams (supervisor's own teams plus unassigned members, per ADR), projects and tasks (granted or assigned), notifications (`userId` in every where-clause).
- All `$queryRaw` calls use tagged templates or `Prisma.sql`. `Prisma.raw` is used only with constants, and there is no `*Unsafe` call. Zod objects strip unknown keys, services copy fields explicitly, and `deviceInfo` passthrough is sanitized.
- Last-admin protection: `SELECT … FOR UPDATE` on all active admins inside the transaction. READ COMMITTED re-evaluation closes the race where two admins demote each other.
- Audit covers role and status changes, exports (violations, dashboard, project), print batches, card PDF and ID-photo views. Containers run as non-root (node, nginx uid 101, postgres).
