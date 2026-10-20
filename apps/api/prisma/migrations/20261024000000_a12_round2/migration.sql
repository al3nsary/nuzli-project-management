-- A12 round 2 — project participants, workers' add/remove requests, project cover images
-- (docs/a12-roles.md, docs/API.md «A12 — round 2», ADR-148 … ADR-152).
--
-- Schema only (no data is moved): two new workspace-scoped tables with the same three layers as
-- every business table since A12 round 1 — workspace_id NOT NULL + DEFAULT nz_current_workspace(),
-- the same-workspace guard trigger, and Row Level Security (ENABLE + FORCE + one policy).
-- After this migration there are 47 workspace-scoped tables.

BEGIN;

CREATE TYPE "ParticipantLevel" AS ENUM ('EDITOR', 'CONTRIBUTOR', 'VIEWER');
CREATE TYPE "MemberRequestKind" AS ENUM ('ADD', 'REMOVE');
CREATE TYPE "MemberRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- ─────────────────────────────────────────────────────────── project participants

CREATE TABLE "project_participants" (
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL DEFAULT nz_current_workspace(),
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "level" "ParticipantLevel" NOT NULL,
    "added_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "project_participants_pkey" PRIMARY KEY ("project_id", "user_id"),
    CONSTRAINT project_participants_title_chk CHECK (length(btrim(title)) BETWEEN 1 AND 120)
);
CREATE INDEX "project_participants_user_id_idx" ON "project_participants"("user_id");
CREATE INDEX "project_participants_workspace_id_idx" ON "project_participants"("workspace_id");
ALTER TABLE "project_participants" ADD CONSTRAINT "project_participants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_participants" ADD CONSTRAINT "project_participants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_participants" ADD CONSTRAINT "project_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_participants" ADD CONSTRAINT "project_participants_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────── workers' add / remove requests

CREATE TABLE "member_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL DEFAULT nz_current_workspace(),
    "team_id" UUID NOT NULL,
    "member_id" UUID,
    "kind" "MemberRequestKind" NOT NULL,
    "status" "MemberRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "national_id_enc" BYTEA,
    "reason" TEXT,
    "decision_reason" TEXT,
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "member_requests_pkey" PRIMARY KEY ("id"),
    -- a REMOVE names its member; a pending ADD carries the encrypted national ID
    CONSTRAINT member_requests_remove_member_chk CHECK (kind <> 'REMOVE' OR member_id IS NOT NULL OR status <> 'PENDING'),
    CONSTRAINT member_requests_add_nid_chk CHECK (kind <> 'ADD' OR status <> 'PENDING' OR national_id_enc IS NOT NULL),
    CONSTRAINT member_requests_decision_chk CHECK ((status = 'PENDING') = (decided_at IS NULL)),
    -- the payload never holds a full national ID (10 digits starting with 1 or 2)
    CONSTRAINT member_requests_payload_no_nid_chk CHECK (payload::text !~ '(^|[^0-9])[12][0-9]{9}([^0-9]|$)')
);
CREATE INDEX "member_requests_workspace_id_status_idx" ON "member_requests"("workspace_id", "status");
CREATE INDEX "member_requests_team_id_idx" ON "member_requests"("team_id");
CREATE INDEX "member_requests_member_id_idx" ON "member_requests"("member_id");
-- one open REMOVE request per worker
CREATE UNIQUE INDEX member_requests_one_pending_remove_uq ON "member_requests"("member_id") WHERE status = 'PENDING' AND kind = 'REMOVE';
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "member_requests" ADD CONSTRAINT "member_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────── project cover image

ALTER TABLE "projects" ADD COLUMN "cover_file_id" UUID;
CREATE INDEX "projects_cover_file_id_idx" ON "projects"("cover_file_id");
ALTER TABLE "projects" ADD CONSTRAINT "projects_cover_file_id_fkey" FOREIGN KEY ("cover_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────── guards (ADR-144)

DROP TRIGGER nz_same_workspace_trg ON "projects";
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "projects" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('calendar_id', 'calendars', 'template_of_id', 'projects', 'cover_file_id', 'files');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "project_participants" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "member_requests" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('team_id', 'teams', 'member_id', 'team_members');

-- users referenced by the new rows must belong to the workspace (or be owners)
CREATE CONSTRAINT TRIGGER project_participants_user_ws_trg AFTER INSERT OR UPDATE OF user_id ON "project_participants"
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_user_in_workspace_fn('user_id');
CREATE CONSTRAINT TRIGGER member_requests_requester_ws_trg AFTER INSERT OR UPDATE OF requested_by ON "member_requests"
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_user_in_workspace_fn('requested_by');

-- files.entity_id (polymorphic) now also points at a project (cover image)
CREATE OR REPLACE FUNCTION nz_files_entity_workspace_fn() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  ref_ws uuid;
  ref_table text;
BEGIN
  IF NEW.entity_id IS NULL OR NEW.workspace_id IS NULL THEN RETURN NULL; END IF;
  ref_table := CASE NEW.entity_type
    WHEN 'violation' THEN 'violations'
    WHEN 'task' THEN 'tasks'
    WHEN 'member_photo' THEN 'team_members'
    WHEN 'project_cover' THEN 'projects'
    ELSE NULL END;
  IF ref_table IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.entity_id IS NOT DISTINCT FROM NEW.entity_id AND OLD.entity_type = NEW.entity_type THEN RETURN NULL; END IF;
  EXECUTE format('SELECT workspace_id FROM %I WHERE id = $1', ref_table) INTO ref_ws USING NEW.entity_id;
  IF ref_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'NZ_CROSS_WORKSPACE: files.entity_id points outside the workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

-- ─────────────────────────────────────────────────────────── Row Level Security (ADR-143)

ALTER TABLE "project_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_participants_workspace_isolation ON "project_participants" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "member_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY member_requests_workspace_isolation ON "member_requests" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());

-- The API role (default privileges normally cover new tables; explicit for migrators that differ).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuzli_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "project_participants", "member_requests" TO nuzli_app';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'A12 round 2: grant DML on project_participants and member_requests to nuzli_app by hand.';
END
$do$;

COMMIT;
