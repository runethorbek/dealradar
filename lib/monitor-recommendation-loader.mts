import type { MonitorCandidate, MonitorMembers, MonitorPolicy } from "./monitor-recommendation.mts";

// Read-only loader for the monitor recommendation policy (#79, design D6/D7).
// One query returns every active monitor with its fresh, visible members and
// their stored evaluations, whatever their age (P9(a)). An active monitor is
// enabled, not removed, and has a strategy (migrations/028).

export type MonitorRecommendationSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<Array<Record<string, unknown>>>;

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function integerOrNull(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// NUMERIC columns are read as text. An unparsable value is null, never a
// valid-looking number.
function numericOrNull(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function parsePolicy(row: Record<string, unknown>): MonitorPolicy | null {
  if (typeof row.monitorId !== "string" || typeof row.monitorSource !== "string") return null;

  const base = {
    monitorId: row.monitorId,
    source: row.monitorSource,
    displayName: textOrNull(row.displayName),
  };

  if (row.strategy === "discount_threshold") {
    const minimumDiscountPercent = numericOrNull(row.minimumDiscountPercent);
    return minimumDiscountPercent === null
      ? null
      : { ...base, strategy: "discount_threshold", minimumDiscountPercent };
  }

  if (row.strategy === "best_match") {
    const minimumOverallScore = numericOrNull(row.minimumOverallScore);
    return minimumOverallScore === null
      ? null
      : { ...base, strategy: "best_match", minimumOverallScore };
  }

  return null;
}

function parseCandidate(row: Record<string, unknown>): MonitorCandidate | null {
  if (
    typeof row.productId !== "string" ||
    typeof row.title !== "string" ||
    typeof row.externalUrl !== "string" ||
    typeof row.source !== "string" ||
    typeof row.lastSeenAt !== "string"
  ) return null;

  return {
    productId: row.productId,
    title: row.title,
    externalUrl: row.externalUrl,
    source: row.source,
    currentPrice: textOrNull(row.currentPrice),
    currency: textOrNull(row.currency),
    sourceCurrentPrice: textOrNull(row.sourceCurrentPrice),
    sourceCurrency: textOrNull(row.sourceCurrency),
    discountPercent: numericOrNull(row.discountPercent),
    preferenceScore: integerOrNull(row.preferenceScore),
    dealScore: integerOrNull(row.dealScore),
    hidden: row.hidden === true,
    lastSeenAt: row.lastSeenAt,
  };
}

// A fresh member has the monitor in products.monitor_ids and was seen no
// earlier than the monitor's last_scan_checked_at (tolerance 0, P3). A
// never-scanned monitor therefore has no members. Hidden products are
// excluded. Monitors are returned in monitor_id order, members in product id
// order.
export async function loadActiveMonitorMembers(sql: MonitorRecommendationSql): Promise<MonitorMembers[]> {
  const rows = await sql`
    SELECT
      m.monitor_id AS "monitorId", m.source AS "monitorSource", m.display_name AS "displayName",
      m.strategy,
      m.minimum_discount_percent::TEXT AS "minimumDiscountPercent",
      m.minimum_overall_score::TEXT AS "minimumOverallScore",
      m.last_scan_checked_at::TEXT AS "lastScanCheckedAt",
      p.id::TEXT AS "productId", p.title, p.external_url AS "externalUrl", p.source,
      p.current_price::TEXT AS "currentPrice", p.currency,
      p.source_current_price::TEXT AS "sourceCurrentPrice", p.source_currency AS "sourceCurrency",
      p.discount_percent::TEXT AS "discountPercent",
      p.hidden, p.last_seen_at::TEXT AS "lastSeenAt",
      pe.preference_score AS "preferenceScore", pe.deal_score AS "dealScore"
    FROM monitor_definitions m
    LEFT JOIN products p
      ON p.monitor_ids @> ARRAY[m.monitor_id]
      AND p.hidden = FALSE
      AND p.last_seen_at >= m.last_scan_checked_at
    LEFT JOIN product_evaluations pe ON pe.product_id = p.id
    WHERE m.enabled = TRUE
      AND m.removed_at IS NULL
      AND m.strategy IS NOT NULL
    ORDER BY m.monitor_id, p.id
  `;

  const monitors = new Map<string, MonitorMembers>();

  for (const row of rows) {
    const monitorId = textOrNull(row.monitorId);

    if (monitorId === null) continue;

    let monitor = monitors.get(monitorId);

    if (!monitor) {
      const policy = parsePolicy(row);

      // A row that violates migration 028's constraints yields no policy.
      if (!policy) continue;

      monitor = { policy, lastScanCheckedAt: textOrNull(row.lastScanCheckedAt), candidates: [] };
      monitors.set(monitorId, monitor);
    }

    // A monitor without fresh members has one row with no product.
    if (row.productId === null || row.productId === undefined) continue;

    const candidate = parseCandidate(row);

    if (candidate) monitor.candidates.push(candidate);
  }

  return [...monitors.values()];
}
