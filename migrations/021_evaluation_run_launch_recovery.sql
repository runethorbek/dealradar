BEGIN;

ALTER TABLE evaluation_runs
ADD COLUMN launch_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (launch_status IN ('pending', 'started')),
ADD COLUMN launch_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (launch_attempts >= 0),
ADD COLUMN launch_started_at TIMESTAMPTZ;

CREATE INDEX evaluation_runs_pending_launch_idx
  ON evaluation_runs (id)
  WHERE launch_status = 'pending' AND status = 'pending';

COMMIT;
