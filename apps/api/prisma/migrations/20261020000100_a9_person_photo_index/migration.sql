-- A9 (ADR-103): at most one PERSON photo per violation. The service checks the limit under a row
-- lock; this index is the last line of defence. Separate migration: the enum value 'PERSON' was
-- added by the previous one and cannot be used in the same transaction.
CREATE UNIQUE INDEX violation_files_one_person_uq
  ON violation_files (violation_id)
  WHERE kind = 'PERSON';
