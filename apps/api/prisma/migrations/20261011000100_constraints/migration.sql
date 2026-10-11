-- Constraints that Prisma's schema language cannot express (brief §2, §5.2, §5.3, §11).

-- gen_random_uuid() is built into PostgreSQL 13+; pgcrypto kept for digest() in scripts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- §5.2 A colour is reserved by any ACTIVE or PENDING_APPROVAL team.
CREATE UNIQUE INDEX teams_color_reserved_uq
  ON teams (color_id)
  WHERE status IN ('ACTIVE', 'PENDING_APPROVAL');

-- §5.3 A member belongs to exactly one team at any moment.
CREATE UNIQUE INDEX team_memberships_one_open_uq
  ON team_memberships (member_id)
  WHERE valid_to IS NULL;

ALTER TABLE team_memberships
  ADD CONSTRAINT team_memberships_interval_chk CHECK (valid_to IS NULL OR valid_to > valid_from);

-- No two overlapping membership intervals for the same member (history stays a clean timeline).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE team_memberships
  ADD CONSTRAINT team_memberships_no_overlap_excl
  EXCLUDE USING gist (
    member_id WITH =,
    tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
  );

-- §5.3 One open supervisor-history row per team.
CREATE UNIQUE INDEX team_supervisor_history_one_open_uq
  ON team_supervisor_history (team_id)
  WHERE valid_to IS NULL;

ALTER TABLE team_supervisor_history
  ADD CONSTRAINT team_supervisor_history_interval_chk CHECK (valid_to IS NULL OR valid_to > valid_from);

-- §11 Dependencies: no self links.
ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_not_self_chk CHECK (predecessor_id <> successor_id);

-- Tasks: sane values.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_progress_chk CHECK (progress >= 0 AND progress <= 100),
  ADD CONSTRAINT tasks_duration_chk CHECK (duration_days >= 0),
  ADD CONSTRAINT tasks_dates_chk CHECK (end_date >= start_date),
  ADD CONSTRAINT tasks_milestone_chk CHECK (type <> 'MILESTONE' OR duration_days = 0),
  ADD CONSTRAINT tasks_not_own_parent_chk CHECK (parent_id IS NULL OR parent_id <> id);

-- §1 Tasks are assigned to supervisors only — enforced in the database as well as the service.
CREATE OR REPLACE FUNCTION tasks_assignee_supervisor_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.assignee_id AND u.role = 'SUPERVISOR'
  ) THEN
    RAISE EXCEPTION 'ASSIGNEE_NOT_SUPERVISOR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_assignee_supervisor_trg
  BEFORE INSERT OR UPDATE OF assignee_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_assignee_supervisor_fn();

-- Team leaders must be supervisors.
CREATE OR REPLACE FUNCTION teams_supervisor_role_fn() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.supervisor_id AND u.role = 'SUPERVISOR') THEN
    RAISE EXCEPTION 'NOT_A_SUPERVISOR' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER teams_supervisor_role_trg
  BEFORE INSERT OR UPDATE OF supervisor_id ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_supervisor_role_fn();

-- Violations: sane coordinates and a reason when cancelled.
ALTER TABLE violations
  ADD CONSTRAINT violations_lat_chk CHECK (latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT violations_lng_chk CHECK (longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT violations_accuracy_chk CHECK (accuracy_m >= 0),
  ADD CONSTRAINT violations_cancel_reason_chk CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL);

-- Print items reference a member or a user (the supervisor), never neither.
ALTER TABLE card_print_items
  ADD CONSTRAINT card_print_items_subject_chk CHECK (member_id IS NOT NULL OR user_id IS NOT NULL);

-- Card sizes are positive.
ALTER TABLE card_sizes
  ADD CONSTRAINT card_sizes_dims_chk CHECK (width_mm > 0 AND height_mm > 0);

-- One default logo, one default template, one default calendar.
CREATE UNIQUE INDEX logos_one_default_uq ON logos (is_default) WHERE is_default;
CREATE UNIQUE INDEX card_templates_one_default_uq ON card_templates (is_default) WHERE is_default AND archived_at IS NULL;
CREATE UNIQUE INDEX calendars_one_default_uq ON calendars (is_default) WHERE is_default;

-- §13 The audit log is append-only.
CREATE OR REPLACE FUNCTION audit_log_append_only_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_trg
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only_fn();

-- Case-insensitive search on names (Arabic and Latin).
CREATE INDEX team_members_full_name_lower_idx ON team_members (lower(full_name));
CREATE INDEX users_full_name_lower_idx ON users (lower(full_name));
