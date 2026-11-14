BEGIN;

-- Historical low as a Watched alert reason (#89, design P4(c) and P5(b)). A
-- watched historical-low event is stored as a 'historical_low' row: it has no
-- monitor, threshold, or discount, and stores the drop percent versus the
-- previous comparable observation instead. 'crossing' and 'new_best' rows keep
-- monitor_id, discount_percent, and threshold_percent required, now through a
-- per-reason check, and have no drop percent. At most one 'historical_low' row
-- exists per (product, snapshot); the existing (product, monitor, snapshot)
-- key does not cover it because its monitor_id is NULL. The rows of one
-- product and observation share client_message_id and are sent as one
-- message. Additive only: existing rows are unchanged and satisfy the new
-- checks.
ALTER TABLE watched_alerts
  ALTER COLUMN monitor_id DROP NOT NULL,
  ALTER COLUMN discount_percent DROP NOT NULL,
  ALTER COLUMN threshold_percent DROP NOT NULL,
  ADD COLUMN drop_percent NUMERIC(7,4);

ALTER TABLE watched_alerts
  DROP CONSTRAINT watched_alerts_reason_check,
  ADD CONSTRAINT watched_alerts_reason_check
    CHECK (reason IN ('crossing', 'new_best', 'historical_low')),
  ADD CONSTRAINT watched_alerts_reason_columns_check CHECK (
    CASE reason
      WHEN 'historical_low' THEN
        monitor_id IS NULL
        AND discount_percent IS NULL
        AND threshold_percent IS NULL
        AND drop_percent IS NOT NULL
        AND drop_percent >= 0
        AND drop_percent <= 100
      ELSE
        monitor_id IS NOT NULL
        AND discount_percent IS NOT NULL
        AND threshold_percent IS NOT NULL
        AND drop_percent IS NULL
    END
  );

CREATE UNIQUE INDEX watched_alerts_historical_low_key
  ON watched_alerts (product_id, snapshot_id)
  WHERE reason = 'historical_low';

COMMIT;
