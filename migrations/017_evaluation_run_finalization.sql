BEGIN;

ALTER TABLE evaluation_runs
ADD COLUMN import_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
ADD COLUMN scan_warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
ADD COLUMN notification_claimed_at TIMESTAMPTZ;

COMMIT;
