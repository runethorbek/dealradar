BEGIN;

ALTER TABLE evaluation_runs
ADD COLUMN launch_claim_token TEXT,
ADD COLUMN launch_claimed_at TIMESTAMPTZ;

CREATE INDEX evaluation_runs_launch_claim_idx
  ON evaluation_runs (id, launch_claimed_at)
  WHERE launch_status = 'pending';

COMMIT;
