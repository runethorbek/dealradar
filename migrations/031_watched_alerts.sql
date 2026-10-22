BEGIN;

-- Watched alerts (#81, design D12 and D13). One row per (product, monitor,
-- observation) detected at import time from an inserted snapshot; detection
-- inserts with ON CONFLICT DO NOTHING, so an import retry never creates a
-- second row. discount_percent is the observation's discount and
-- threshold_percent the monitor's threshold at detection time. Delivery sends
-- one Slack message per product and observation: it claims the pending rows
-- of that observation with claimed_at and claim_token (a lease, as for daily
-- summaries), sends with client_message_id (derived from the product and
-- snapshot, so it is the same on every row of the message), and marks them
-- sent with the token. A failed send releases the claim. A pending row whose
-- product is no longer Watched, visible, and qualifying is expired instead of
-- sent (P5). Additive only.
CREATE TABLE watched_alerts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitor_definitions (monitor_id),
  snapshot_id BIGINT NOT NULL REFERENCES product_snapshots (id) ON DELETE CASCADE,
  discount_percent NUMERIC(5,2) NOT NULL,
  threshold_percent NUMERIC(5,2) NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN ('crossing', 'new_best')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'expired')),
  client_message_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT watched_alerts_product_monitor_snapshot_key
    UNIQUE (product_id, monitor_id, snapshot_id),
  CONSTRAINT watched_alerts_sent_at_check CHECK (
    (status = 'sent') = (sent_at IS NOT NULL)
  )
);

CREATE INDEX watched_alerts_pending_idx
  ON watched_alerts (product_id, snapshot_id)
  WHERE status = 'pending';

COMMIT;
