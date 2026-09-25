BEGIN;

-- Watched historical-low events (#59) are detected at import time from the
-- inserted snapshots and recorded with the run, so the finalizer can select
-- the Zalando recommendation after evaluation completes.
ALTER TABLE evaluation_runs
ADD COLUMN watched_historical_lows JSONB NOT NULL DEFAULT '[]'::JSONB;

COMMIT;
