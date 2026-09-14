BEGIN;

CREATE TABLE evaluation_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notification_sent BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE evaluation_run_candidates (
  run_id BIGINT NOT NULL REFERENCES evaluation_runs (id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  selection_position INTEGER NOT NULL CHECK (selection_position >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  PRIMARY KEY (run_id, product_id),
  UNIQUE (run_id, selection_position)
);

CREATE INDEX evaluation_run_candidates_pending_idx
  ON evaluation_run_candidates (run_id, selection_position)
  WHERE status = 'pending';

COMMIT;
