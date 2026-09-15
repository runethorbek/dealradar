BEGIN;

ALTER TABLE evaluation_runs
ADD COLUMN batches_processed INTEGER NOT NULL DEFAULT 0
  CHECK (batches_processed >= 0);

COMMIT;
