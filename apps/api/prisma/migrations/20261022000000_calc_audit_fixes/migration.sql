-- Calculations audit 2026-10 (docs/calculations-audit-2026-10.md, ADR-133..ADR-136). Data only:
-- no schema change. Brings existing rows in line with the rules the engine now applies on
-- every write (@nuzli/scheduling: normalizeStatusProgress, rollUpStatus, weightedProgress).
-- Every changed task gets version + 1 so a client holding the old row gets 409 and refreshes.
-- Archived tasks are left as they are (they are out of the schedule; a restore recomputes).

-- 1. L9: the 2.25″ × 1.25″ built-in label is exactly 57.15 × 31.75 mm.
UPDATE card_sizes
   SET width_mm = 57.15, height_mm = 31.75, updated_at = now()
 WHERE is_builtin AND name = '2.25″ × 1.25″' AND width_mm = 57 AND height_mm = 32;

-- 2. H1: the leaf invariant — DONE ⇒ 100; progress ≥ 100 ⇒ DONE; NOT_STARTED with progress ⇒ IN_PROGRESS.
--    A leaf = a live task that is not a GROUP and has no live child.
UPDATE tasks t
   SET progress = 100, version = t.version + 1, updated_at = now()
 WHERE t.archived_at IS NULL AND t.type <> 'GROUP' AND t.status = 'DONE' AND t.progress <> 100
   AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.archived_at IS NULL);

UPDATE tasks t
   SET status = 'DONE', progress = 100, version = t.version + 1, updated_at = now()
 WHERE t.archived_at IS NULL AND t.type <> 'GROUP' AND t.status <> 'DONE' AND t.progress >= 100
   AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.archived_at IS NULL);

UPDATE tasks t
   SET status = 'IN_PROGRESS', version = t.version + 1, updated_at = now()
 WHERE t.archived_at IS NULL AND t.type <> 'GROUP' AND t.status = 'NOT_STARTED' AND t.progress > 0
   AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.archived_at IS NULL);

-- 3. H2: a GROUP without live children has no work left — progress 0, costs 0, NOT_STARTED.
--    Its dates and duration are kept.
UPDATE tasks t
   SET progress = 0, planned_cost = 0, actual_cost = 0, status = 'NOT_STARTED',
       version = t.version + 1, updated_at = now()
 WHERE t.archived_at IS NULL AND t.type = 'GROUP'
   AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.archived_at IS NULL)
   AND (t.progress <> 0 OR t.planned_cost <> 0 OR t.actual_cost <> 0 OR t.status <> 'NOT_STARTED');

-- 4. H1/H2/M1: every task with live children gets, bottom-up,
--    * progress = the weighted average of its children (2 decimals): weight = working minutes in
--      HOUR projects, working days in DAY projects; milestones and empty groups weigh 0; the plain
--      average when every weight is 0;
--    * costs = the sum of its children (so the sum of its leaves);
--    * status = derived from its children:
--        every child DONE → DONE; any child IN_PROGRESS or DONE, or progress > 0 → IN_PROGRESS;
--        every non-DONE child ON_HOLD → ON_HOLD; else NOT_STARTED (the order of rollUpStatus).
--    One pass settles one level, so the loop repeats until nothing changes (bounded).
DO $$
DECLARE
  changed integer;
  pass integer := 0;
BEGIN
  LOOP
    pass := pass + 1;
    WITH kids AS (
      SELECT c.parent_id AS id,
             count(*) AS n,
             count(*) FILTER (WHERE c.status = 'DONE') AS n_done,
             count(*) FILTER (WHERE c.status = 'ON_HOLD') AS n_hold,
             count(*) FILTER (WHERE c.status IN ('IN_PROGRESS', 'DONE')) AS n_active,
             sum(w.weight * c.progress) AS weighted,
             sum(w.weight) AS weights,
             avg(c.progress) AS plain,
             sum(c.planned_cost) AS planned,
             sum(c.actual_cost) AS actual
        FROM tasks c
        JOIN projects p ON p.id = c.project_id
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN c.type = 'MILESTONE' THEN 0
                   WHEN c.type = 'GROUP' AND NOT EXISTS (SELECT 1 FROM tasks g WHERE g.parent_id = c.id AND g.archived_at IS NULL) THEN 0
                   WHEN p.duration_unit = 'HOUR' THEN GREATEST(COALESCE(c.duration_minutes, 0), 0)
                   ELSE GREATEST(c.duration_days, 0)
                 END::numeric AS weight
        ) w
       WHERE c.archived_at IS NULL AND c.parent_id IS NOT NULL
       GROUP BY c.parent_id
    ),
    target AS (
      SELECT k.id, k.n, k.n_done, k.n_hold, k.n_active, k.planned, k.actual,
             round(CASE WHEN k.weights > 0 THEN k.weighted / k.weights ELSE k.plain END, 2) AS progress
        FROM kids k
    ),
    derived AS (
      SELECT t.id, t.progress, t.planned, t.actual,
             (CASE
                WHEN t.n_done = t.n THEN 'DONE'
                WHEN t.n_active > 0 OR t.progress > 0 THEN 'IN_PROGRESS'
                WHEN t.n_hold > 0 AND t.n_done + t.n_hold = t.n THEN 'ON_HOLD'
                ELSE 'NOT_STARTED'
              END)::"TaskStatus" AS status
        FROM target t
    )
    UPDATE tasks x
       SET progress = d.progress,
           planned_cost = d.planned,
           actual_cost = d.actual,
           status = d.status,
           version = x.version + 1,
           updated_at = now()
      FROM derived d
     WHERE x.id = d.id AND x.archived_at IS NULL
       AND (x.progress <> d.progress OR x.status <> d.status OR x.planned_cost <> d.planned OR x.actual_cost <> d.actual);
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0 OR pass >= 100;
  END LOOP;
END $$;
