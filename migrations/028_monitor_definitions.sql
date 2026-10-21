BEGIN;

-- Monitor definitions published by Deals in
-- public/deals/monitor-recommendations.json (#77, design D4). One row per
-- stable Deals monitor ID; rows are never deleted. A monitor absent from a
-- valid document keeps its row with removed_at set.
--
-- An active monitor is a row with enabled = TRUE, removed_at IS NULL, and
-- strategy IS NOT NULL. Exactly the threshold matching strategy is set, and
-- an unconfigured monitor (strategy IS NULL) has no threshold. The check
-- uses IS NOT DISTINCT FROM so it is never NULL (a NULL CHECK passes).
--
-- last_scan_checked_at and last_scan_ref are scan evidence: the feed
-- checked_at (and import ref) of the latest imported feed whose monitors[]
-- listed this monitor. The importer only moves them forward.
CREATE TABLE monitor_definitions (
  monitor_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  display_name TEXT,
  enabled BOOLEAN NOT NULL,
  strategy TEXT
    CHECK (strategy IN ('discount_threshold', 'best_match')),
  minimum_discount_percent NUMERIC(5,2)
    CHECK (minimum_discount_percent >= 1 AND minimum_discount_percent <= 99),
  minimum_overall_score NUMERIC(4,2)
    CHECK (minimum_overall_score >= 0 AND minimum_overall_score <= 10),
  contract_version INTEGER NOT NULL,
  definition JSONB NOT NULL,
  definition_ref TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  last_scan_checked_at TIMESTAMPTZ,
  last_scan_ref TEXT,
  CONSTRAINT monitor_definitions_strategy_threshold_check CHECK (
    (
      strategy IS NULL
      AND minimum_discount_percent IS NULL
      AND minimum_overall_score IS NULL
    )
    OR (
      strategy IS NOT DISTINCT FROM 'discount_threshold'
      AND minimum_discount_percent IS NOT NULL
      AND minimum_overall_score IS NULL
    )
    OR (
      strategy IS NOT DISTINCT FROM 'best_match'
      AND minimum_overall_score IS NOT NULL
      AND minimum_discount_percent IS NULL
    )
  )
);

COMMIT;
