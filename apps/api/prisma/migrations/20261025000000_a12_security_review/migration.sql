-- A12 — fixes of the independent security review (docs/security-review-2026-10-A12.md, ADR-162 … ADR-166).
--
-- Schema only, no business data is moved. Idempotent where PostgreSQL allows it.
--
--   H2  users.suspended_globally: an account suspension made by an OWNER («إيقاف في كل الأقسام»)
--       is recorded, so a workspace admin can never lift it (only owners can). The flag is set for
--       accounts that are suspended today by an owner's global suspension (their latest
--       `user.suspended` audit entry has scope "global").
--   L2  nz_rls_bypass(): the GUC `app.bypass_rls` alone no longer bypasses Row Level Security. The
--       application role `nuzli_app` (and any role that is a member of it) can never bypass, even
--       if a statement sets the GUC itself (one SQL injection must not defeat RLS). Maintenance
--       CLIs that connect as the migrator (the schema owner) keep the bypass they need.

BEGIN;

-- ─────────────────────────────────────────────────────────── H2 — origin of an account suspension

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_globally" BOOLEAN NOT NULL DEFAULT false;

UPDATE "users" u
   SET suspended_globally = true
 WHERE u.status = 'SUSPENDED'::"UserStatus"
   AND (
     SELECT a.after ->> 'scope'
       FROM audit_log a
      WHERE a.entity_type = 'user' AND a.entity_id = u.id AND a.action = 'user.suspended'
      ORDER BY a.at DESC
      LIMIT 1
   ) = 'global';

-- ─────────────────────────────────────────────────────────── L2 — the bypass is tied to a role

-- `pg_has_role` errors on an unknown role: without nuzli_app (a migrator that may not create roles)
-- nothing can be a member of it, so only the GUC counts — exactly as before for such a database.
CREATE OR REPLACE FUNCTION nz_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$
    SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
       AND NOT (
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuzli_app')
         AND pg_has_role(current_user, 'nuzli_app', 'MEMBER')
         AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
       )
  $fn$;

COMMENT ON FUNCTION nz_rls_bypass() IS
  'A12 (ADR-145, security review L2): the maintenance bypass. True only when app.bypass_rls = on AND the current role is not nuzli_app (nor a member of it). The API role can never bypass Row Level Security.';

COMMIT;
