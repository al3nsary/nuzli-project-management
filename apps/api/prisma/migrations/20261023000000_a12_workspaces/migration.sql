-- A12 — workspaces (أقسام) with strict isolation (ADR-142 … ADR-147, docs/a12-isolation-design.md).
--
-- BACK UP THE DATABASE BEFORE APPLYING (docs/backup-restore.md). The whole migration runs in one
-- transaction and verifies itself: per-table row counts before/after, every business row in the
-- «إدارة المشاريع» workspace, every account converted. Any mismatch raises and rolls everything back.
--
-- What it does:
--   1. helper functions nz_current_workspace() / nz_rls_bypass(), enums, workspaces, workspace_memberships;
--   2. creates the first workspace «إدارة المشاريع» (code "projects") and moves EVERY business row into it
--      (45 tables get workspace_id NOT NULL + FK + index; audit_log and files allow NULL for
--      global rows: account-level audit entries and user profile photos);
--   3. accounts: username (generated from the e-mail local part, de-duplicated), account_role,
--      ADMIN/SUPERVISOR/MONITOR → a workspace membership of the same role, the bootstrap admin → OWNER;
--   4. uniqueness per workspace (colours, names, worker national ID, defaults, codes);
--   5. guards: a row can never reference a row of another workspace (constraint triggers),
--      workspace_id is immutable, users referenced by tasks/teams/positions/access must be members;
--   6. counts verification;
--   7. Row Level Security (ENABLE + FORCE) on every business table, role nuzli_app for the API.

BEGIN;

-- ─────────────────────────────────────────────────────────── 1. helpers, enums, tables

-- The active workspace of the current transaction (SET LOCAL by the API per request, ADR-143).
CREATE OR REPLACE FUNCTION nz_current_workspace() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $fn$;

-- The audited owner escape hatch (ADR-145). Never set by anything else.
CREATE OR REPLACE FUNCTION nz_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'on' $fn$;

CREATE TYPE "AccountRole" AS ENUM ('OWNER', 'USER');
CREATE TYPE "WorkspaceRole" AS ENUM ('ADMIN', 'ASSISTANT', 'SUPERVISOR', 'MONITOR', 'MEMBER');
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "WorkspaceMembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspaces_code_key" ON "workspaces"("code");
ALTER TABLE "workspaces"
  ADD CONSTRAINT workspaces_code_chk CHECK (code ~ '^[a-z][a-z0-9-]{1,39}$'),
  ADD CONSTRAINT workspaces_name_chk CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT workspaces_archived_chk CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL));

CREATE TABLE "workspace_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "title" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "scope" JSONB NOT NULL DEFAULT '{}',
    "status" "WorkspaceMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workspace_memberships_user_id_idx" ON "workspace_memberships"("user_id");
CREATE UNIQUE INDEX "workspace_memberships_workspace_id_user_id_role_key" ON "workspace_memberships"("workspace_id", "user_id", "role");
CREATE INDEX workspace_memberships_live_idx ON workspace_memberships (workspace_id, role) WHERE archived_at IS NULL;
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────── 2. counts before, first workspace

CREATE TEMP TABLE _a12_counts (tbl text PRIMARY KEY, n bigint NOT NULL) ON COMMIT DROP;
INSERT INTO _a12_counts (tbl, n)
  SELECT 'team_colors', count(*) FROM "team_colors" UNION ALL
  SELECT 'teams', count(*) FROM "teams" UNION ALL
  SELECT 'team_supervisors', count(*) FROM "team_supervisors" UNION ALL
  SELECT 'team_supervisor_history', count(*) FROM "team_supervisor_history" UNION ALL
  SELECT 'team_members', count(*) FROM "team_members" UNION ALL
  SELECT 'team_memberships', count(*) FROM "team_memberships" UNION ALL
  SELECT 'departments', count(*) FROM "departments" UNION ALL
  SELECT 'job_titles', count(*) FROM "job_titles" UNION ALL
  SELECT 'org_units', count(*) FROM "org_units" UNION ALL
  SELECT 'org_positions', count(*) FROM "org_positions" UNION ALL
  SELECT 'calendars', count(*) FROM "calendars" UNION ALL
  SELECT 'calendar_exceptions', count(*) FROM "calendar_exceptions" UNION ALL
  SELECT 'projects', count(*) FROM "projects" UNION ALL
  SELECT 'project_access', count(*) FROM "project_access" UNION ALL
  SELECT 'tasks', count(*) FROM "tasks" UNION ALL
  SELECT 'task_dependencies', count(*) FROM "task_dependencies" UNION ALL
  SELECT 'task_comments', count(*) FROM "task_comments" UNION ALL
  SELECT 'project_labels', count(*) FROM "project_labels" UNION ALL
  SELECT 'task_labels', count(*) FROM "task_labels" UNION ALL
  SELECT 'custom_fields', count(*) FROM "custom_fields" UNION ALL
  SELECT 'task_custom_values', count(*) FROM "task_custom_values" UNION ALL
  SELECT 'task_checklist_items', count(*) FROM "task_checklist_items" UNION ALL
  SELECT 'user_view_prefs', count(*) FROM "user_view_prefs" UNION ALL
  SELECT 'portfolios', count(*) FROM "portfolios" UNION ALL
  SELECT 'portfolio_projects', count(*) FROM "portfolio_projects" UNION ALL
  SELECT 'time_entries', count(*) FROM "time_entries" UNION ALL
  SELECT 'task_comment_reads', count(*) FROM "task_comment_reads" UNION ALL
  SELECT 'baselines', count(*) FROM "baselines" UNION ALL
  SELECT 'baseline_tasks', count(*) FROM "baseline_tasks" UNION ALL
  SELECT 'violation_types', count(*) FROM "violation_types" UNION ALL
  SELECT 'violations', count(*) FROM "violations" UNION ALL
  SELECT 'violation_ocr', count(*) FROM "violation_ocr" UNION ALL
  SELECT 'violation_files', count(*) FROM "violation_files" UNION ALL
  SELECT 'violation_responses', count(*) FROM "violation_responses" UNION ALL
  SELECT 'violation_visibility', count(*) FROM "violation_visibility" UNION ALL
  SELECT 'import_previews', count(*) FROM "import_previews" UNION ALL
  SELECT 'files', count(*) FROM "files" UNION ALL
  SELECT 'logos', count(*) FROM "logos" UNION ALL
  SELECT 'card_sizes', count(*) FROM "card_sizes" UNION ALL
  SELECT 'card_templates', count(*) FROM "card_templates" UNION ALL
  SELECT 'card_print_batches', count(*) FROM "card_print_batches" UNION ALL
  SELECT 'card_print_items', count(*) FROM "card_print_items" UNION ALL
  SELECT 'notifications', count(*) FROM "notifications" UNION ALL
  SELECT 'settings', count(*) FROM "settings" UNION ALL
  SELECT 'audit_log', count(*) FROM "audit_log"
  UNION ALL SELECT 'users', count(*) FROM "users";

INSERT INTO "workspaces" ("name", "code", "updated_at") VALUES ('إدارة المشاريع', 'projects', CURRENT_TIMESTAMP);

-- ─────────────────────────────────────────────────────────── 3. workspace_id on every business table

ALTER TABLE "team_colors" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "teams" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "team_supervisors" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "team_supervisor_history" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "team_members" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "team_memberships" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "departments" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "job_titles" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "org_units" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "org_positions" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "calendars" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "calendar_exceptions" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "projects" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "project_access" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "task_dependencies" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "task_comments" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "project_labels" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "task_labels" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "custom_fields" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "task_custom_values" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "task_checklist_items" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "user_view_prefs" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "portfolios" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "portfolio_projects" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "time_entries" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "task_comment_reads" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "baselines" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "baseline_tasks" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "violation_types" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "violations" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "violation_ocr" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "violation_files" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "violation_responses" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "violation_visibility" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "import_previews" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "files" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "logos" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "card_sizes" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "card_templates" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "card_print_batches" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "card_print_items" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "notifications" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "settings" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "audit_log" ADD COLUMN "workspace_id" UUID;

-- audit_log is append-only: its guard trigger is paused for this one backfill.
ALTER TABLE "audit_log" DISABLE TRIGGER audit_log_no_update_trg;
UPDATE "team_colors" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "teams" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "team_supervisors" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "team_supervisor_history" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "team_members" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "team_memberships" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "departments" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "job_titles" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "org_units" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "org_positions" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "calendars" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "calendar_exceptions" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "projects" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "project_access" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "tasks" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "task_dependencies" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "task_comments" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "project_labels" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "task_labels" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "custom_fields" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "task_custom_values" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "task_checklist_items" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "user_view_prefs" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "portfolios" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "portfolio_projects" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "time_entries" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "task_comment_reads" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "baselines" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "baseline_tasks" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "violation_types" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "violations" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "violation_ocr" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "violation_files" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "violation_responses" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "violation_visibility" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "import_previews" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "files" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "logos" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "card_sizes" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "card_templates" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "card_print_batches" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "card_print_items" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "notifications" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "settings" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
UPDATE "audit_log" SET "workspace_id" = (SELECT id FROM workspaces WHERE code = 'projects');
ALTER TABLE "audit_log" ENABLE TRIGGER audit_log_no_update_trg;

-- User profile photos follow the (global) account, not a workspace.
UPDATE "files" SET "workspace_id" = NULL WHERE entity_type = 'user_photo';
ALTER TABLE "files" ADD CONSTRAINT files_workspace_chk CHECK (workspace_id IS NOT NULL OR entity_type = 'user_photo');

ALTER TABLE "team_colors" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "teams" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "team_supervisors" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "team_supervisor_history" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "team_members" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "team_memberships" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "departments" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "job_titles" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "org_units" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "org_positions" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "calendars" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "calendar_exceptions" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "projects" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "project_access" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "tasks" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "task_dependencies" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "task_comments" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "project_labels" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "task_labels" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "custom_fields" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "task_custom_values" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "task_checklist_items" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "user_view_prefs" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "portfolios" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "portfolio_projects" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "time_entries" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "task_comment_reads" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "baselines" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "baseline_tasks" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "violation_types" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "violations" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "violation_ocr" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "violation_files" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "violation_responses" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "violation_visibility" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "import_previews" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "files" ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "logos" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "card_sizes" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "card_templates" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "card_print_batches" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "card_print_items" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "notifications" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "settings" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();
ALTER TABLE "audit_log" ALTER COLUMN "workspace_id" SET DEFAULT nz_current_workspace();

CREATE INDEX "team_colors_workspace_id_idx" ON "team_colors"("workspace_id");
ALTER TABLE "team_colors" ADD CONSTRAINT "team_colors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "teams_workspace_id_idx" ON "teams"("workspace_id");
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "team_supervisors_workspace_id_idx" ON "team_supervisors"("workspace_id");
ALTER TABLE "team_supervisors" ADD CONSTRAINT "team_supervisors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "team_supervisor_history_workspace_id_idx" ON "team_supervisor_history"("workspace_id");
ALTER TABLE "team_supervisor_history" ADD CONSTRAINT "team_supervisor_history_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "team_members_workspace_id_idx" ON "team_members"("workspace_id");
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "team_memberships_workspace_id_idx" ON "team_memberships"("workspace_id");
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "departments_workspace_id_idx" ON "departments"("workspace_id");
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "job_titles_workspace_id_idx" ON "job_titles"("workspace_id");
ALTER TABLE "job_titles" ADD CONSTRAINT "job_titles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "org_units_workspace_id_idx" ON "org_units"("workspace_id");
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "org_positions_workspace_id_idx" ON "org_positions"("workspace_id");
ALTER TABLE "org_positions" ADD CONSTRAINT "org_positions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "calendars_workspace_id_idx" ON "calendars"("workspace_id");
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "calendar_exceptions_workspace_id_idx" ON "calendar_exceptions"("workspace_id");
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "project_access_workspace_id_idx" ON "project_access"("workspace_id");
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "tasks_workspace_id_idx" ON "tasks"("workspace_id");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "task_dependencies_workspace_id_idx" ON "task_dependencies"("workspace_id");
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "task_comments_workspace_id_idx" ON "task_comments"("workspace_id");
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "project_labels_workspace_id_idx" ON "project_labels"("workspace_id");
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "task_labels_workspace_id_idx" ON "task_labels"("workspace_id");
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "custom_fields_workspace_id_idx" ON "custom_fields"("workspace_id");
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "task_custom_values_workspace_id_idx" ON "task_custom_values"("workspace_id");
ALTER TABLE "task_custom_values" ADD CONSTRAINT "task_custom_values_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "task_checklist_items_workspace_id_idx" ON "task_checklist_items"("workspace_id");
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "user_view_prefs_workspace_id_idx" ON "user_view_prefs"("workspace_id");
ALTER TABLE "user_view_prefs" ADD CONSTRAINT "user_view_prefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "portfolios_workspace_id_idx" ON "portfolios"("workspace_id");
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "portfolio_projects_workspace_id_idx" ON "portfolio_projects"("workspace_id");
ALTER TABLE "portfolio_projects" ADD CONSTRAINT "portfolio_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "time_entries_workspace_id_idx" ON "time_entries"("workspace_id");
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "task_comment_reads_workspace_id_idx" ON "task_comment_reads"("workspace_id");
ALTER TABLE "task_comment_reads" ADD CONSTRAINT "task_comment_reads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "baselines_workspace_id_idx" ON "baselines"("workspace_id");
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "baseline_tasks_workspace_id_idx" ON "baseline_tasks"("workspace_id");
ALTER TABLE "baseline_tasks" ADD CONSTRAINT "baseline_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "violation_types_workspace_id_idx" ON "violation_types"("workspace_id");
ALTER TABLE "violation_types" ADD CONSTRAINT "violation_types_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "violations_workspace_id_idx" ON "violations"("workspace_id");
ALTER TABLE "violations" ADD CONSTRAINT "violations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "violation_ocr_workspace_id_idx" ON "violation_ocr"("workspace_id");
ALTER TABLE "violation_ocr" ADD CONSTRAINT "violation_ocr_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "violation_files_workspace_id_idx" ON "violation_files"("workspace_id");
ALTER TABLE "violation_files" ADD CONSTRAINT "violation_files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "violation_responses_workspace_id_idx" ON "violation_responses"("workspace_id");
ALTER TABLE "violation_responses" ADD CONSTRAINT "violation_responses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "violation_visibility_workspace_id_idx" ON "violation_visibility"("workspace_id");
ALTER TABLE "violation_visibility" ADD CONSTRAINT "violation_visibility_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "import_previews_workspace_id_idx" ON "import_previews"("workspace_id");
ALTER TABLE "import_previews" ADD CONSTRAINT "import_previews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "files_workspace_id_idx" ON "files"("workspace_id");
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "logos_workspace_id_idx" ON "logos"("workspace_id");
ALTER TABLE "logos" ADD CONSTRAINT "logos_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "card_sizes_workspace_id_idx" ON "card_sizes"("workspace_id");
ALTER TABLE "card_sizes" ADD CONSTRAINT "card_sizes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "card_templates_workspace_id_idx" ON "card_templates"("workspace_id");
ALTER TABLE "card_templates" ADD CONSTRAINT "card_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "card_print_batches_workspace_id_idx" ON "card_print_batches"("workspace_id");
ALTER TABLE "card_print_batches" ADD CONSTRAINT "card_print_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "card_print_items_workspace_id_idx" ON "card_print_items"("workspace_id");
ALTER TABLE "card_print_items" ADD CONSTRAINT "card_print_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "notifications_workspace_id_idx" ON "notifications"("workspace_id");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "settings_workspace_id_idx" ON "settings"("workspace_id");
ALTER TABLE "settings" ADD CONSTRAINT "settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "audit_log_workspace_id_idx" ON "audit_log"("workspace_id");
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- settings: one value per (workspace, key)
ALTER TABLE "settings" DROP CONSTRAINT "settings_pkey", ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("workspace_id", "key");

-- ─────────────────────────────────────────────────────────── 4. uniqueness per workspace

DROP INDEX "team_colors_hex_key";
CREATE UNIQUE INDEX "team_colors_workspace_id_hex_key" ON "team_colors"("workspace_id", "hex");
DROP INDEX "team_members_national_id_hash_key";
CREATE UNIQUE INDEX "team_members_workspace_id_national_id_hash_key" ON "team_members"("workspace_id", "national_id_hash");
DROP INDEX "departments_name_key";
CREATE UNIQUE INDEX "departments_workspace_id_name_key" ON "departments"("workspace_id", "name");
DROP INDEX "job_titles_name_key";
CREATE UNIQUE INDEX "job_titles_workspace_id_name_key" ON "job_titles"("workspace_id", "name");
DROP INDEX "portfolios_name_key";
CREATE UNIQUE INDEX "portfolios_workspace_id_name_key" ON "portfolios"("workspace_id", "name");
DROP INDEX "violation_types_name_key";
CREATE UNIQUE INDEX "violation_types_workspace_id_name_key" ON "violation_types"("workspace_id", "name");
DROP INDEX "card_sizes_name_key";
CREATE UNIQUE INDEX "card_sizes_workspace_id_name_key" ON "card_sizes"("workspace_id", "name");

-- A colour is reserved by a live team of the same workspace (colours are per workspace).
DROP INDEX teams_color_reserved_uq;
CREATE UNIQUE INDEX teams_color_reserved_uq ON teams (workspace_id, color_id) WHERE status IN ('ACTIVE', 'PENDING_APPROVAL');
-- One default logo / template / calendar per workspace.
DROP INDEX logos_one_default_uq;
CREATE UNIQUE INDEX logos_one_default_uq ON logos (workspace_id) WHERE is_default;
DROP INDEX card_templates_one_default_uq;
CREATE UNIQUE INDEX card_templates_one_default_uq ON card_templates (workspace_id) WHERE is_default AND archived_at IS NULL;
DROP INDEX calendars_one_default_uq;
CREATE UNIQUE INDEX calendars_one_default_uq ON calendars (workspace_id) WHERE is_default;
-- A live org-unit code is unique per workspace.
DROP INDEX org_units_code_uq;
CREATE UNIQUE INDEX org_units_code_uq ON org_units (workspace_id, lower(code)) WHERE code IS NOT NULL AND archived_at IS NULL;
-- View preferences are per (workspace, user, project, key).
DROP INDEX user_view_prefs_project_uq;
CREATE UNIQUE INDEX user_view_prefs_project_uq ON user_view_prefs (workspace_id, user_id, project_id, key) WHERE project_id IS NOT NULL;
DROP INDEX user_view_prefs_global_uq;
CREATE UNIQUE INDEX user_view_prefs_global_uq ON user_view_prefs (workspace_id, user_id, key) WHERE project_id IS NULL;

-- ─────────────────────────────────────────────────────────── 5. accounts

ALTER TABLE "users"
  ADD COLUMN "account_role" "AccountRole" NOT NULL DEFAULT 'USER',
  ADD COLUMN "requested_workspace_id" UUID,
  ADD COLUMN "username" TEXT,
  ALTER COLUMN "role" DROP NOT NULL;

-- Usernames from the e-mail local part: lower case, [a-z0-9._-], starts with a letter, 3..32,
-- de-duplicated in creation order with a numeric suffix. Owners can change them later.
DO $do$
DECLARE
  u record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR u IN SELECT id, email FROM users ORDER BY created_at, id LOOP
    base := regexp_replace(lower(split_part(u.email, '@', 1)), '[^a-z0-9._-]', '', 'g');
    IF base !~ '^[a-z]' THEN base := 'u' || base; END IF;
    base := left(base, 28);
    IF length(base) < 3 THEN base := rpad(base, 3, '0'); END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM users WHERE username = candidate) LOOP
      n := n + 1;
      candidate := base || n::text;
    END LOOP;
    UPDATE users SET username = candidate WHERE id = u.id;
  END LOOP;
END
$do$;

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
ALTER TABLE "users" ADD CONSTRAINT users_username_chk CHECK (username ~ '^[a-z][a-z0-9._-]{2,31}$');
CREATE INDEX "users_requested_workspace_id_status_idx" ON "users"("requested_workspace_id", "status");
ALTER TABLE "users" ADD CONSTRAINT "users_requested_workspace_id_fkey" FOREIGN KEY ("requested_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Registrations (pending/rejected) belong to the first workspace.
UPDATE users SET requested_workspace_id = (SELECT id FROM workspaces WHERE code = 'projects')
 WHERE status IN ('PENDING', 'REJECTED');

-- Every approved account keeps its role, now as a membership of «إدارة المشاريع».
INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, created_by)
SELECT (SELECT id FROM workspaces WHERE code = 'projects'), u.id, u.role::text::"WorkspaceRole", 'ACTIVE', u.created_at, u.approved_by
  FROM users u
 WHERE u.status IN ('ACTIVE', 'SUSPENDED') AND u.role IS NOT NULL;

-- The first owner: the bootstrap admin (audited when the seed created it); without that audit
-- row, the earliest active admin. More owners come from BOOTSTRAP_OWNER_* in the seed.
UPDATE users SET account_role = 'OWNER'
 WHERE role = 'ADMIN' AND id IN (SELECT entity_id FROM audit_log WHERE action = 'user.bootstrap_admin_created' AND entity_id IS NOT NULL);
UPDATE users SET account_role = 'OWNER'
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE account_role = 'OWNER')
   AND id = (SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1);

-- Sessions remember their workspace (kept across refreshes).
ALTER TABLE "refresh_tokens" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
UPDATE refresh_tokens SET workspace_id = (SELECT id FROM workspaces WHERE code = 'projects') WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────── 6. cross-workspace guards (ADR-144)

-- Constraint trigger (checked at the end of each statement, like a foreign key): every listed
-- reference column must point to a row of the SAME workspace, and workspace_id never changes.
-- Arguments: pairs (column, referenced table). SECURITY DEFINER so the lookup sees the real row
-- whatever the session's RLS context is.
CREATE OR REPLACE FUNCTION nz_same_workspace_fn() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  i integer;
  col text;
  ref_table text;
  ref_id uuid;
  ref_ws uuid;
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'NZ_CROSS_WORKSPACE: %.workspace_id is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  END IF;
  FOR i IN 0 .. (TG_NARGS / 2) - 1 LOOP
    col := TG_ARGV[2 * i];
    ref_table := TG_ARGV[2 * i + 1];
    ref_id := (new_row ->> col)::uuid;
    CONTINUE WHEN ref_id IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND (old_row ->> col) IS NOT DISTINCT FROM (new_row ->> col);
    EXECUTE format('SELECT workspace_id FROM %I WHERE id = $1', ref_table) INTO ref_ws USING ref_id;
    IF ref_ws IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'NZ_CROSS_WORKSPACE: %.% points outside the workspace', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "team_colors" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "teams" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('color_id', 'team_colors', 'org_unit_id', 'org_units');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "team_supervisors" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('team_id', 'teams');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "team_supervisor_history" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('team_id', 'teams');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "team_members" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('job_title_id', 'job_titles', 'department_id', 'departments', 'photo_file_id', 'files');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "team_memberships" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('member_id', 'team_members', 'team_id', 'teams');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "departments" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "job_titles" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "org_units" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('parent_id', 'org_units');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "org_positions" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('unit_id', 'org_units', 'holder_member_id', 'team_members', 'reports_to_position_id', 'org_positions');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "calendars" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "calendar_exceptions" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('calendar_id', 'calendars');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "projects" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('calendar_id', 'calendars', 'template_of_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "project_access" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "tasks" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects', 'parent_id', 'tasks');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "task_dependencies" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects', 'predecessor_id', 'tasks', 'successor_id', 'tasks');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "task_comments" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('task_id', 'tasks', 'reply_to_id', 'task_comments');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "project_labels" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "task_labels" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('task_id', 'tasks', 'label_id', 'project_labels');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "custom_fields" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "task_custom_values" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('task_id', 'tasks', 'field_id', 'custom_fields');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "task_checklist_items" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('task_id', 'tasks');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "user_view_prefs" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "portfolios" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "portfolio_projects" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('portfolio_id', 'portfolios', 'project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "time_entries" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('task_id', 'tasks');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "task_comment_reads" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('task_id', 'tasks');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "baselines" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('project_id', 'projects');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "baseline_tasks" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('baseline_id', 'baselines', 'task_id', 'tasks');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "violation_types" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "violations" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('member_id', 'team_members', 'team_id_snapshot', 'teams', 'type_id', 'violation_types');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "violation_ocr" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('violation_id', 'violations', 'file_id', 'files');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "violation_files" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('violation_id', 'violations', 'file_id', 'files');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "violation_responses" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('violation_id', 'violations');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "violation_visibility" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('team_id', 'teams');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "import_previews" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('file_id', 'files');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "files" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "logos" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('file_id', 'files');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "card_sizes" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "card_templates" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('size_id', 'card_sizes', 'logo_id', 'logos');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "card_print_batches" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('template_id', 'card_templates');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "card_print_items" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn('batch_id', 'card_print_batches', 'member_id', 'team_members');
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "notifications" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "settings" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();
CREATE CONSTRAINT TRIGGER nz_same_workspace_trg AFTER INSERT OR UPDATE ON "audit_log" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_same_workspace_fn();

-- files.entity_id is polymorphic: the owning violation / task / member must be in the same workspace.
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
CREATE CONSTRAINT TRIGGER nz_files_entity_workspace_trg AFTER INSERT OR UPDATE OF entity_id, entity_type ON "files" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_files_entity_workspace_fn();

-- Users referenced by business rows must belong to that workspace (identity stays global).
-- §1: tasks go to supervisors only — now: a SUPERVISOR membership of the task's workspace.
CREATE OR REPLACE FUNCTION tasks_assignee_supervisor_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships m
     WHERE m.user_id = NEW.assignee_id AND m.workspace_id = NEW.workspace_id
       AND m.role = 'SUPERVISOR' AND m.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ASSIGNEE_NOT_SUPERVISOR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION teams_supervisor_role_fn() RETURNS trigger AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workspace_memberships m
     WHERE m.user_id = NEW.supervisor_id AND m.workspace_id = NEW.workspace_id
       AND m.role = 'SUPERVISOR' AND m.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_A_SUPERVISOR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION team_supervisors_role_fn() RETURNS trigger AS $fn$
BEGIN
  IF NEW.valid_to IS NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships m
     WHERE m.user_id = NEW.user_id AND m.workspace_id = NEW.workspace_id
       AND m.role = 'SUPERVISOR' AND m.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_A_SUPERVISOR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Any member of the workspace (or an owner) may hold a position or be granted a project.
CREATE OR REPLACE FUNCTION nz_user_in_workspace_fn() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  uid uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.user_id = uid AND m.workspace_id = NEW.workspace_id AND m.archived_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uid AND u.account_role = 'OWNER') THEN
    RAISE EXCEPTION 'NZ_CROSS_WORKSPACE: %.% is not a member of the workspace', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER org_positions_holder_user_ws_trg AFTER INSERT OR UPDATE OF holder_user_id ON org_positions
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_user_in_workspace_fn('holder_user_id');
CREATE CONSTRAINT TRIGGER project_access_user_ws_trg AFTER INSERT OR UPDATE OF user_id ON project_access
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nz_user_in_workspace_fn('user_id');

-- ─────────────────────────────────────────────────────────── 7. verification (counts before = after)

DO $do$
DECLARE
  r record;
  ws uuid := (SELECT id FROM workspaces WHERE code = 'projects');
  n_after bigint;
  n_outside bigint;
  n_total bigint := 0;
  n_users_without_membership bigint;
BEGIN
  FOR r IN SELECT tbl, n FROM _a12_counts WHERE tbl <> 'users' ORDER BY tbl LOOP
    IF r.tbl = 'files' THEN
      EXECUTE format('SELECT count(*), count(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1 AND NOT (workspace_id IS NULL AND entity_type = ''user_photo'')) FROM %I', r.tbl)
        INTO n_after, n_outside USING ws;
    ELSE
      EXECUTE format('SELECT count(*), count(*) FILTER (WHERE workspace_id IS DISTINCT FROM $1) FROM %I', r.tbl)
        INTO n_after, n_outside USING ws;
    END IF;
    IF n_after <> r.n THEN
      RAISE EXCEPTION 'A12 migration check failed: % had % rows before and % after', r.tbl, r.n, n_after;
    END IF;
    IF n_outside <> 0 THEN
      RAISE EXCEPTION 'A12 migration check failed: % rows of % are not in the «إدارة المشاريع» workspace', n_outside, r.tbl;
    END IF;
    n_total := n_total + r.n;
    RAISE NOTICE 'A12: % — % rows (before) = % rows (after), all in workspace %', r.tbl, r.n, n_after, ws;
  END LOOP;

  IF (SELECT count(*) FROM users) <> (SELECT n FROM _a12_counts WHERE tbl = 'users') THEN
    RAISE EXCEPTION 'A12 migration check failed: users count changed';
  END IF;
  SELECT count(*) INTO n_users_without_membership
    FROM users u
   WHERE u.status IN ('ACTIVE', 'SUSPENDED') AND u.role IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.user_id = u.id AND m.workspace_id = ws AND m.role::text = u.role::text);
  IF n_users_without_membership <> 0 THEN
    RAISE EXCEPTION 'A12 migration check failed: % approved accounts have no membership', n_users_without_membership;
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE')
     AND NOT EXISTS (SELECT 1 FROM users WHERE account_role = 'OWNER') THEN
    RAISE EXCEPTION 'A12 migration check failed: no owner';
  END IF;
  RAISE NOTICE 'A12: % business rows moved into «إدارة المشاريع»; % memberships; % owner(s)',
    n_total, (SELECT count(*) FROM workspace_memberships), (SELECT count(*) FROM users WHERE account_role = 'OWNER');
END
$do$;

-- ─────────────────────────────────────────────────────────── 8. Row Level Security (ADR-143)
-- FORCE: the table owner is subject to the policies too. Superusers and BYPASSRLS roles are not —
-- the API must connect as nuzli_app (docs/a12-isolation-design.md §RLS). Data migrations written
-- after this one must run `SET LOCAL app.bypass_rls = 'on'` when the migrator is not a superuser.

ALTER TABLE "team_colors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_colors" FORCE ROW LEVEL SECURITY;
CREATE POLICY team_colors_workspace_isolation ON "team_colors" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;
CREATE POLICY teams_workspace_isolation ON "teams" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "team_supervisors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_supervisors" FORCE ROW LEVEL SECURITY;
CREATE POLICY team_supervisors_workspace_isolation ON "team_supervisors" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "team_supervisor_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_supervisor_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY team_supervisor_history_workspace_isolation ON "team_supervisor_history" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;
CREATE POLICY team_members_workspace_isolation ON "team_members" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "team_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY team_memberships_workspace_isolation ON "team_memberships" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;
CREATE POLICY departments_workspace_isolation ON "departments" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "job_titles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_titles" FORCE ROW LEVEL SECURITY;
CREATE POLICY job_titles_workspace_isolation ON "job_titles" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "org_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_units" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_units_workspace_isolation ON "org_units" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "org_positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_positions" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_positions_workspace_isolation ON "org_positions" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendars" FORCE ROW LEVEL SECURITY;
CREATE POLICY calendars_workspace_isolation ON "calendars" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "calendar_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_exceptions_workspace_isolation ON "calendar_exceptions" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_workspace_isolation ON "projects" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "project_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_access" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_access_workspace_isolation ON "project_access" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_workspace_isolation ON "tasks" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "task_dependencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_dependencies" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_dependencies_workspace_isolation ON "task_dependencies" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "task_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_comments" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_comments_workspace_isolation ON "task_comments" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "project_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_labels" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_labels_workspace_isolation ON "project_labels" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "task_labels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_labels" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_labels_workspace_isolation ON "task_labels" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "custom_fields" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_fields" FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_fields_workspace_isolation ON "custom_fields" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "task_custom_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_custom_values" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_custom_values_workspace_isolation ON "task_custom_values" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "task_checklist_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_checklist_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_checklist_items_workspace_isolation ON "task_checklist_items" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "user_view_prefs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_view_prefs" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_view_prefs_workspace_isolation ON "user_view_prefs" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "portfolios" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolios" FORCE ROW LEVEL SECURITY;
CREATE POLICY portfolios_workspace_isolation ON "portfolios" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "portfolio_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portfolio_projects" FORCE ROW LEVEL SECURITY;
CREATE POLICY portfolio_projects_workspace_isolation ON "portfolio_projects" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "time_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY time_entries_workspace_isolation ON "time_entries" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "task_comment_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_comment_reads" FORCE ROW LEVEL SECURITY;
CREATE POLICY task_comment_reads_workspace_isolation ON "task_comment_reads" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "baselines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "baselines" FORCE ROW LEVEL SECURITY;
CREATE POLICY baselines_workspace_isolation ON "baselines" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "baseline_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "baseline_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY baseline_tasks_workspace_isolation ON "baseline_tasks" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "violation_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violation_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY violation_types_workspace_isolation ON "violation_types" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "violations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violations" FORCE ROW LEVEL SECURITY;
CREATE POLICY violations_workspace_isolation ON "violations" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "violation_ocr" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violation_ocr" FORCE ROW LEVEL SECURITY;
CREATE POLICY violation_ocr_workspace_isolation ON "violation_ocr" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "violation_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violation_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY violation_files_workspace_isolation ON "violation_files" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "violation_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violation_responses" FORCE ROW LEVEL SECURITY;
CREATE POLICY violation_responses_workspace_isolation ON "violation_responses" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "violation_visibility" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violation_visibility" FORCE ROW LEVEL SECURITY;
CREATE POLICY violation_visibility_workspace_isolation ON "violation_visibility" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "import_previews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_previews" FORCE ROW LEVEL SECURITY;
CREATE POLICY import_previews_workspace_isolation ON "import_previews" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;
CREATE POLICY files_workspace_isolation ON "files" FOR ALL USING (workspace_id = nz_current_workspace() OR (workspace_id IS NULL AND entity_type = 'user_photo') OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR (workspace_id IS NULL AND entity_type = 'user_photo') OR nz_rls_bypass());
ALTER TABLE "logos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logos" FORCE ROW LEVEL SECURITY;
CREATE POLICY logos_workspace_isolation ON "logos" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "card_sizes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_sizes" FORCE ROW LEVEL SECURITY;
CREATE POLICY card_sizes_workspace_isolation ON "card_sizes" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "card_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY card_templates_workspace_isolation ON "card_templates" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "card_print_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_print_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY card_print_batches_workspace_isolation ON "card_print_batches" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "card_print_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_print_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY card_print_items_workspace_isolation ON "card_print_items" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_workspace_isolation ON "notifications" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY settings_workspace_isolation ON "settings" FOR ALL USING (workspace_id = nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id = nz_current_workspace() OR nz_rls_bypass());
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_workspace_isolation ON "audit_log" FOR ALL USING (workspace_id IS NOT DISTINCT FROM nz_current_workspace() OR nz_rls_bypass()) WITH CHECK (workspace_id IS NOT DISTINCT FROM nz_current_workspace() OR nz_rls_bypass());

-- The API's database role: data access only (no DDL, no BYPASSRLS). The deployment gives it a
-- password and LOGIN once (docs/a12-isolation-design.md); the migrator keeps owning the schema.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuzli_app') THEN
    CREATE ROLE nuzli_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA public TO nuzli_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nuzli_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nuzli_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nuzli_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO nuzli_app';
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_prisma_migrations') THEN
    EXECUTE 'REVOKE ALL ON TABLE _prisma_migrations FROM nuzli_app';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'A12: the migrator may not create roles; create nuzli_app by hand (docs/a12-isolation-design.md).';
END
$do$;

COMMIT;
