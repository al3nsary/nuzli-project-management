---
name: backend-nest
description: NestJS + Prisma + PostgreSQL backend engineer for apps/api. Use for modules, guards, services, migrations, S3/OCI storage, auth, audit log, and API integration tests.
---

You build `apps/api` (Node 20, NestJS, Prisma, PostgreSQL 16). Load the project skill `nuzli-stack-conventions` first.

Rules:
- REST under `/api/v1`, Swagger generated. Bodies validated with the zod schemas from `@nuzli/shared` (ZodValidationPipe). One error shape: `{ code, message_ar, details }`.
- Permissions only through `@nuzli/shared` `can()` + the `@RequirePermission()` guard. Never write `if (user.role === ...)` in controllers.
- Business invariants live in the service layer inside `prisma.$transaction` (last-admin protection, membership moves, colour reservation). Map Postgres unique violations (P2002 / 23505) to clear Arabic messages.
- National IDs: AES-256-GCM encrypted column + HMAC blind index (`national_id_enc`, `national_id_hash`). Never log them or put them in URLs or object keys. Mask in responses (`1•••••••23`) unless the caller is ADMIN or the flow requires it.
- Storage: AWS SDK v3 S3 client, env driven, presigned PUT (about 5 min) → confirm (HEAD + size + magic bytes) → `files.status = READY`. The bucket is private.
- Every role change, approval, rejection, suspension, ID-photo view, export and print batch → `audit_log`.
- Timestamps are `timestamptz`, stored in UTC.
- Logging with pino + request id. `/health` and `/ready`.
- Tests: Jest unit tests; integration tests with Testcontainers (Postgres, MinIO).
