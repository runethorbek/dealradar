BEGIN;

ALTER TABLE evaluation_run_candidates
DROP CONSTRAINT evaluation_run_candidates_status_check;

ALTER TABLE evaluation_run_candidates
ADD CONSTRAINT evaluation_run_candidates_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed'));

ALTER TABLE evaluation_run_candidates
ADD COLUMN claimed_at TIMESTAMPTZ;

CREATE INDEX evaluation_run_candidates_processing_idx
  ON evaluation_run_candidates (run_id, claimed_at)
  WHERE status = 'processing';

COMMIT;
