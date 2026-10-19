-- Owner request A9 — hours, imports (ADR-109, ADR-110).
-- Part 1 mirrors prisma migrate diff; part 2 is raw SQL (CHECKs and deferred constraint triggers).
--
-- Dual representation of task dates (ADR-109):
--   * every task keeps start_date / end_date (DATE): the day of the first and of the last working
--     minute. Day-based queries (overdue, reports, calendar ranges, workload) work for both units.
--   * tasks of HOUR projects also carry start_at / end_at (TIMESTAMPTZ instants of Asia/Riyadh
--     wall times: first working minute, end of the last working minute, exclusive) and
--     duration_minutes (working minutes). Tasks of DAY projects have the three columns NULL.
--   The rule "HOUR project ⇔ hour columns set" spans two tables, so it is enforced by constraint
--   triggers DEFERRED to commit: a conversion (POST /projects/:id/convert) flips the project and
--   rewrites every task in one transaction.

-- CreateEnum
CREATE TYPE "DurationUnit" AS ENUM ('DAY', 'HOUR');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "duration_unit" "DurationUnit" NOT NULL DEFAULT 'DAY';

-- AlterTable
ALTER TABLE "calendars" ADD COLUMN     "working_hours" JSONB NOT NULL DEFAULT '[{"start": "09:00", "end": "13:00"}, {"start": "14:00", "end": "18:00"}]';

-- AlterTable
ALTER TABLE "calendar_exceptions" ADD COLUMN     "working_hours" JSONB;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "duration_minutes" INTEGER,
ADD COLUMN     "end_at" TIMESTAMPTZ(3),
ADD COLUMN     "start_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "task_dependencies" ADD COLUMN     "lag_minutes" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "import_previews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_by" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "file_id" UUID,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_previews_expires_at_idx" ON "import_previews"("expires_at");

-- ───────────────────────────────────────────── part 2: raw SQL

ALTER TABLE "calendars"
  ADD CONSTRAINT calendars_working_hours_chk CHECK (jsonb_typeof(working_hours) = 'array' AND jsonb_array_length(working_hours) BETWEEN 1 AND 6);

ALTER TABLE "calendar_exceptions"
  ADD CONSTRAINT calendar_exceptions_working_hours_chk CHECK (working_hours IS NULL OR (jsonb_typeof(working_hours) = 'array' AND jsonb_array_length(working_hours) BETWEEN 1 AND 6));

ALTER TABLE "tasks"
  ADD CONSTRAINT tasks_hour_columns_chk CHECK (
    (start_at IS NULL AND end_at IS NULL AND duration_minutes IS NULL)
    OR (start_at IS NOT NULL AND end_at IS NOT NULL AND duration_minutes IS NOT NULL
        AND end_at >= start_at AND duration_minutes >= 0)
  );

-- A milestone lasts zero minutes in HOUR projects (end = start).
ALTER TABLE "tasks"
  ADD CONSTRAINT tasks_hour_milestone_chk CHECK (type <> 'MILESTONE' OR duration_minutes IS NULL OR (duration_minutes = 0 AND end_at = start_at));

-- Imports cap at 5,000 tasks; a lag is at most a year of working time either way.
ALTER TABLE "task_dependencies"
  ADD CONSTRAINT task_dependencies_lag_minutes_chk CHECK (lag_minutes BETWEEN -525600 AND 525600);

CREATE OR REPLACE FUNCTION tasks_unit_columns_check() RETURNS trigger AS $$
DECLARE
  unit "DurationUnit";
BEGIN
  SELECT duration_unit INTO unit FROM projects WHERE id = NEW.project_id;
  IF unit = 'HOUR' AND NEW.start_at IS NULL THEN
    RAISE EXCEPTION 'TASK_UNIT_COLUMNS: task % of an HOUR project has no start_at', NEW.id USING ERRCODE = '23514';
  END IF;
  IF unit = 'DAY' AND NEW.start_at IS NOT NULL THEN
    RAISE EXCEPTION 'TASK_UNIT_COLUMNS: task % of a DAY project has start_at', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER tasks_unit_columns_chk
  AFTER INSERT OR UPDATE OF start_at, end_at, duration_minutes, project_id ON "tasks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tasks_unit_columns_check();

CREATE OR REPLACE FUNCTION projects_unit_columns_check() RETURNS trigger AS $$
BEGIN
  IF NEW.duration_unit = 'HOUR' AND EXISTS (SELECT 1 FROM tasks WHERE project_id = NEW.id AND start_at IS NULL) THEN
    RAISE EXCEPTION 'TASK_UNIT_COLUMNS: HOUR project % has tasks without start_at', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.duration_unit = 'DAY' AND EXISTS (SELECT 1 FROM tasks WHERE project_id = NEW.id AND start_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TASK_UNIT_COLUMNS: DAY project % has tasks with start_at', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER projects_unit_columns_chk
  AFTER UPDATE OF duration_unit ON "projects"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION projects_unit_columns_check();
