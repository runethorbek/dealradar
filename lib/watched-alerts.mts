import { loadPreferenceWeightPercent, type PostSlackMessage } from "./daily-summary.mts";
import { escapeSlackText } from "./import-notification.mts";
import { isReliableDiscount } from "./monitor-recommendation.mts";
import { getOverallScore } from "./ranking-settings.mts";
import type { WatchedHistoricalLowEvent } from "./watched-historical-low.mts";

// Watched alerts (#81, #89; design D12, D13, P1(b)(i), P4(c), P5(b), P6(a),
// P10(a) in docs/specs/monitor-recommendation-design.md). Detected at import
// time from inserted snapshots, stored in watched_alerts (migrations 031 and
// 032), and delivered once per product and observation under a claim. The
// reasons are a threshold transition per monitor (crossing, new_best) and a
// watched historical-low event (historical_low, no monitor). No Next.js,
// Gemini, or Vercel dependency.

export type WatchedAlertSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<Array<Record<string, unknown>>>;

export type WatchedAlertReason = "crossing" | "new_best";

// One stored observation (product_snapshots row). NUMERIC values are text.
export type WatchedAlertObservation = {
  snapshotId: string;
  currentPrice: string | null;
  currency: string | null;
  discountPercent: string | null;
};

export type WatchedAlertMonitor = {
  monitorId: string;
  thresholdPercent: number;
};

// A Watched, visible product with its active discount_threshold monitors and
// its full snapshot history in ascending observed_at order.
export type WatchedAlertProduct = {
  productId: string;
  source: string;
  monitors: WatchedAlertMonitor[];
  observations: WatchedAlertObservation[];
};

export type WatchedAlertCandidate = {
  productId: string;
  monitorId: string;
  snapshotId: string;
  discountPercent: number;
  thresholdPercent: number;
  reason: WatchedAlertReason;
};

// A watched historical-low event recorded as a Watched alert (P4(c)).
export type WatchedHistoricalLowAlertCandidate = WatchedHistoricalLowEvent & {
  reason: "historical_low";
};

function numericOrNull(value: string | null) {
  if (value === null || value.trim() === "") return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

// How an earlier snapshot counts for transitions (D12, P1 sub-point (i)):
// - priced (current price ≥ 0 and currency known) with a discount in range:
//   that discount;
// - priced with a null or 0 discount: 0% (no discount was detected; Deals
//   reports 0 when the card prices are equal);
// - no price, or a discount below 0 or at least 100: skipped (null).
function transitionDiscount(observation: WatchedAlertObservation) {
  const price = numericOrNull(observation.currentPrice);

  if (price === null || price < 0 || observation.currency === null) return null;

  if (observation.discountPercent === null) return 0;

  const discount = numericOrNull(observation.discountPercent);

  return discount !== null && discount >= 0 && discount < 100 ? discount : null;
}

// D12 condition 5 for one monitor with threshold T. `earlier` holds the
// transition discounts of the priced observations before o, oldest first.
// Crossing: the previous priced observation is below T. New best: the
// floored discount is above the highest floored discount of the current
// qualifying episode (the run of consecutive priced observations at or above
// T ending just before o). No earlier priced observation: no alert.
export function getWatchedAlertTransition(
  earlier: number[],
  discount: number,
  thresholdPercent: number,
): WatchedAlertReason | null {
  const previous = earlier.at(-1);

  if (previous === undefined) return null;

  if (previous < thresholdPercent) return "crossing";

  let episodeBest = -Infinity;

  for (let index = earlier.length - 1; index >= 0 && earlier[index]! >= thresholdPercent; index -= 1) {
    episodeBest = Math.max(episodeBest, Math.floor(earlier[index]!));
  }

  return Math.floor(discount) > episodeBest ? "new_best" : null;
}

// Applies D12 conditions 3-5 to products that already meet conditions 1-2
// (Watched, visible, in an active discount_threshold monitor).
export function detectWatchedAlerts(
  products: WatchedAlertProduct[],
  insertedSnapshotIds: ReadonlySet<string>,
): WatchedAlertCandidate[] {
  return products.flatMap((product) => {
    const latest = product.observations.at(-1);

    // The inserted observation must be the product's latest.
    if (!latest || !insertedSnapshotIds.has(latest.snapshotId)) return [];

    const discount = numericOrNull(latest.discountPercent);

    if (discount === null || !isReliableDiscount({ ...latest, source: product.source, discountPercent: discount })) {
      return [];
    }

    const earlier = product.observations
      .slice(0, -1)
      .map(transitionDiscount)
      .filter((value): value is number => value !== null);

    return product.monitors.flatMap((monitor): WatchedAlertCandidate[] => {
      if (discount < monitor.thresholdPercent) return [];

      const reason = getWatchedAlertTransition(earlier, discount, monitor.thresholdPercent);

      return reason
        ? [{
            productId: product.productId,
            monitorId: monitor.monitorId,
            snapshotId: latest.snapshotId,
            discountPercent: discount,
            thresholdPercent: monitor.thresholdPercent,
            reason,
          }]
        : [];
    });
  });
}

type ImportedObservation = {
  source?: string;
  snapshotId: string | null;
  currentPrice: string | null;
  currency: string | null;
  discountPercent: string | null;
};

// The snapshots worth a detection query: inserted by this import with a
// reliable discount (D12 condition 4 needs one). The import result carries
// the same price, currency, and discount as the snapshot it inserted.
export function selectWatchedAlertSnapshotIds(importResults: ImportedObservation[]) {
  return importResults.flatMap((result) => {
    const discount = numericOrNull(result.discountPercent);

    return result.snapshotId !== null &&
      result.source !== undefined &&
      discount !== null &&
      isReliableDiscount({ ...result, source: result.source, discountPercent: discount })
      ? [result.snapshotId]
      : [];
  });
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseMonitors(value: unknown): WatchedAlertMonitor[] {
  let parsed = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((item): WatchedAlertMonitor[] => {
    if (typeof item !== "object" || item === null) return [];

    const { monitorId, thresholdPercent } = item as Record<string, unknown>;
    const threshold = typeof thresholdPercent === "string" ? numericOrNull(thresholdPercent) : null;

    return typeof monitorId === "string" && threshold !== null ? [{ monitorId, thresholdPercent: threshold }] : [];
  });
}

// One snapshot-history query per import over Watched, visible products in an
// active discount_threshold monitor (P10(a): never best_match) that received
// a new snapshot. Membership is products.monitor_ids after this import, and
// thresholds are read at detection time.
export async function findWatchedAlerts(
  sql: WatchedAlertSql,
  insertedSnapshotIds: string[],
): Promise<WatchedAlertCandidate[]> {
  if (insertedSnapshotIds.length === 0) return [];

  const rows = await sql`
    WITH observed_products AS (
      SELECT
        p.id,
        p.source,
        jsonb_agg(
          jsonb_build_object('monitorId', m.monitor_id, 'thresholdPercent', m.minimum_discount_percent::TEXT)
          ORDER BY m.monitor_id
        ) AS monitors
      FROM products p
      JOIN monitor_definitions m
        ON m.monitor_id = ANY(p.monitor_ids)
        AND m.enabled = TRUE
        AND m.removed_at IS NULL
        AND m.strategy = 'discount_threshold'
        AND m.minimum_discount_percent IS NOT NULL
      WHERE p.id IN (
          SELECT inserted.product_id FROM product_snapshots inserted
          WHERE inserted.id = ANY(${insertedSnapshotIds}::BIGINT[])
        )
        AND p.watched
        AND NOT p.hidden
      GROUP BY p.id, p.source
    )
    SELECT
      s.id::TEXT AS "snapshotId",
      s.product_id::TEXT AS "productId",
      op.source,
      op.monitors,
      s.current_price::TEXT AS "currentPrice",
      s.currency,
      s.discount_percent::TEXT AS "discountPercent"
    FROM product_snapshots s
    JOIN observed_products op ON op.id = s.product_id
    ORDER BY s.product_id, s.observed_at, s.id
  `;
  const products = new Map<string, WatchedAlertProduct>();

  for (const row of rows) {
    if (typeof row.snapshotId !== "string" || typeof row.productId !== "string" || typeof row.source !== "string") {
      continue;
    }

    let product = products.get(row.productId);

    if (!product) {
      product = { productId: row.productId, source: row.source, monitors: parseMonitors(row.monitors), observations: [] };
      products.set(row.productId, product);
    }

    product.observations.push({
      snapshotId: row.snapshotId,
      currentPrice: textOrNull(row.currentPrice),
      currency: textOrNull(row.currency),
      discountPercent: textOrNull(row.discountPercent),
    });
  }

  return detectWatchedAlerts([...products.values()], new Set(insertedSnapshotIds));
}

// Threshold rows are unique per (product, monitor, snapshot) and
// historical-low rows per (product, snapshot); ON CONFLICT DO NOTHING covers
// both keys, so recording is idempotent. client_message_id is derived from
// the product and snapshot, so every row of one message shares it.
async function insertWatchedAlerts(
  sql: WatchedAlertSql,
  candidates: Array<WatchedAlertCandidate | WatchedHistoricalLowAlertCandidate>,
) {
  await sql`
    WITH detected AS (
      SELECT
        r.product_id,
        r.monitor_id,
        r.snapshot_id,
        r.discount_percent,
        r.threshold_percent,
        r.drop_percent,
        r.reason,
        md5('dealradar:watched-alert:' || r.product_id::TEXT || ':' || r.snapshot_id::TEXT) AS hash
      FROM jsonb_to_recordset(${JSON.stringify(candidates.map((candidate) => candidate.reason === "historical_low"
        ? {
            product_id: candidate.productId,
            monitor_id: null,
            snapshot_id: candidate.snapshotId,
            discount_percent: null,
            threshold_percent: null,
            drop_percent: candidate.dropPercent,
            reason: candidate.reason,
          }
        : {
            product_id: candidate.productId,
            monitor_id: candidate.monitorId,
            snapshot_id: candidate.snapshotId,
            discount_percent: candidate.discountPercent,
            threshold_percent: candidate.thresholdPercent,
            drop_percent: null,
            reason: candidate.reason,
          }))}::JSONB) AS r(
        product_id BIGINT,
        monitor_id TEXT,
        snapshot_id BIGINT,
        discount_percent NUMERIC,
        threshold_percent NUMERIC,
        drop_percent NUMERIC,
        reason TEXT
      )
    )
    INSERT INTO watched_alerts (
      product_id, monitor_id, snapshot_id, discount_percent, threshold_percent, drop_percent, reason,
      client_message_id
    )
    SELECT
      product_id, monitor_id, snapshot_id, discount_percent, threshold_percent, drop_percent, reason,
      concat(
        substr(hash, 1, 8), '-', substr(hash, 9, 4), '-4', substr(hash, 14, 3), '-8',
        substr(hash, 18, 3), '-', substr(hash, 21, 12)
      )
    FROM detected
    ON CONFLICT DO NOTHING
  `;
}

// Detects and stores this import's Watched alerts: the threshold transitions,
// and the watched historical-low events that findWatchedHistoricalLows
// returned for this import as 'historical_low' rows, each on the product's
// latest snapshot, inserted by this import (P4(c)). The two are recorded
// independently: a failed threshold detection or insert is logged and does
// not prevent the historical-low rows from being stored, and the reverse.
// Returns what was recorded.
export async function recordWatchedAlerts(
  sql: WatchedAlertSql,
  insertedSnapshotIds: string[],
  watchedHistoricalLows: WatchedHistoricalLowEvent[] = [],
): Promise<Array<WatchedAlertCandidate | WatchedHistoricalLowAlertCandidate>> {
  const recorded: Array<WatchedAlertCandidate | WatchedHistoricalLowAlertCandidate> = [];

  try {
    const thresholdAlerts = await findWatchedAlerts(sql, insertedSnapshotIds);

    if (thresholdAlerts.length > 0) {
      await insertWatchedAlerts(sql, thresholdAlerts);
      recorded.push(...thresholdAlerts);
    }
  } catch {
    console.warn("DealRadar Watched alert detection failed.");
  }

  const historicalLowAlerts = watchedHistoricalLows.map((event) => ({ ...event, reason: "historical_low" as const }));

  if (historicalLowAlerts.length > 0) {
    try {
      await insertWatchedAlerts(sql, historicalLowAlerts);
      recorded.push(...historicalLowAlerts);
    } catch {
      console.warn("DealRadar watched historical-low alert recording failed.");
    }
  }

  return recorded;
}

// A pending alert row with the current state needed to re-check it (P5(b))
// and to format it. A 'historical_low' row has no monitor, discount, or
// threshold and has a drop percent; a threshold row is the reverse.
type PendingWatchedAlertState = {
  alertId: string;
  productId: string;
  snapshotId: string;
  clientMessageId: string;
  title: string;
  externalUrl: string;
  source: string;
  watched: boolean;
  hidden: boolean;
  member: boolean;
  monitorActive: boolean;
  displayName: string | null;
  currentThresholdPercent: number | null;
  productCurrentPrice: string | null;
  productCurrency: string | null;
  productSourceCurrentPrice: string | null;
  productSourceCurrency: string | null;
  productDiscountPercent: number | null;
  observedPrice: string | null;
  observedCurrency: string | null;
  observedSourcePrice: string | null;
  observedSourceCurrency: string | null;
  observedDiscountPercent: number | null;
  preferenceScore: number | null;
  dealScore: number | null;
};

export type PendingWatchedAlert = PendingWatchedAlertState & (
  | {
      reason: WatchedAlertReason;
      monitorId: string;
      discountPercent: number;
      thresholdPercent: number;
      dropPercent: null;
    }
  | {
      reason: "historical_low";
      monitorId: null;
      discountPercent: null;
      thresholdPercent: null;
      dropPercent: number;
    }
);

// P5(b) for a historical low: the product's current price, in the pair the
// detection compared (the source pair when the alerted observation has a
// source price, otherwise the normalized pair), is known, in the same
// currency, and not higher than the alerted observation's price.
function isStillHistoricalLow(alert: PendingWatchedAlert) {
  const useSourcePair = alert.observedSourcePrice !== null;
  const observedPrice = numericOrNull(useSourcePair ? alert.observedSourcePrice : alert.observedPrice);
  const observedCurrency = useSourcePair ? alert.observedSourceCurrency : alert.observedCurrency;
  const currentPrice = numericOrNull(useSourcePair ? alert.productSourceCurrentPrice : alert.productCurrentPrice);
  const currentCurrency = useSourcePair ? alert.productSourceCurrency : alert.productCurrency;

  return (
    observedPrice !== null &&
    currentPrice !== null &&
    currentPrice >= 0 &&
    observedCurrency !== null &&
    currentCurrency === observedCurrency &&
    currentPrice <= observedPrice
  );
}

// P5(b): a pending alert is delivered only while the product is still
// Watched and visible, and the alert still holds. A threshold alert still
// holds while the product qualifies for that monitor: the monitor is an
// active discount_threshold monitor, the product is still its member, and the
// product's current reliable discount is at or above the current threshold
// (D12 conditions 1, 2, and 4 on the current stored state). A historical-low
// alert still holds while the current price has not risen above the alerted
// observation's price.
export function isDeliverableWatchedAlert(alert: PendingWatchedAlert) {
  if (!alert.watched || alert.hidden) return false;

  if (alert.reason === "historical_low") return isStillHistoricalLow(alert);

  return (
    alert.member &&
    alert.monitorActive &&
    alert.currentThresholdPercent !== null &&
    alert.productDiscountPercent !== null &&
    isReliableDiscount({
      source: alert.source,
      currentPrice: alert.productCurrentPrice,
      currency: alert.productCurrency,
      discountPercent: alert.productDiscountPercent,
    }) &&
    alert.productDiscountPercent >= alert.currentThresholdPercent
  );
}

function formatNumber(value: number) {
  return String(Number(value.toFixed(2)));
}

function formatReason(alert: PendingWatchedAlert) {
  if (alert.reason === "historical_low") {
    return `• Historical low: ${formatNumber(alert.dropPercent)}% below the previous price, at or below its lowest earlier price`;
  }

  const reason = alert.reason === "crossing"
    ? `crossed the ${formatNumber(alert.thresholdPercent)}% threshold`
    : `new best in the qualifying episode (threshold ${formatNumber(alert.thresholdPercent)}%)`;

  return `• ${escapeSlackText(alert.displayName ?? alert.monitorId)}: ${reason}`;
}

// The discount shown for the observation: a threshold alert's stored
// discount, otherwise the observation's discount when it is reliable (D8).
function observationDiscount(alerts: PendingWatchedAlert[]) {
  const stored = alerts.find((alert) => alert.discountPercent !== null)?.discountPercent;

  if (stored !== undefined && stored !== null) return stored;

  const [first] = alerts;

  return first &&
    first.observedDiscountPercent !== null &&
    isReliableDiscount({
      source: first.source,
      currentPrice: first.observedPrice,
      currency: first.observedCurrency,
      discountPercent: first.observedDiscountPercent,
    })
    ? first.observedDiscountPercent
    : null;
}

// One message per product and observation, listing every reason: the
// historical low first, then every triggering monitor (D10). The price is the
// alerted observation's, with the display-price pair preference (normalized,
// then source).
export function formatWatchedAlertMessage(alerts: PendingWatchedAlert[], preferenceWeightPercent: number) {
  const [first] = alerts;

  if (!first) throw new Error("A Watched alert message needs at least one alert.");

  const price = first.observedPrice !== null && first.observedCurrency !== null
    ? `${escapeSlackText(first.observedPrice)} ${escapeSlackText(first.observedCurrency)}`
    : first.observedSourcePrice !== null && first.observedSourceCurrency !== null
      ? `${escapeSlackText(first.observedSourcePrice)} ${escapeSlackText(first.observedSourceCurrency)}`
      : null;
  const discount = observationDiscount(alerts);
  const details = [
    price,
    discount !== null ? `${formatNumber(discount)}% discount` : null,
    first.preferenceScore !== null && first.dealScore !== null
      ? `Overall ${getOverallScore(first.preferenceScore, first.dealScore, preferenceWeightPercent).toFixed(1)}`
      : null,
    `<${escapeSlackText(first.externalUrl)}|View product>`,
  ].filter((value): value is string => value !== null);
  const reasons = [
    ...alerts.filter((alert) => alert.reason === "historical_low"),
    ...alerts
      .filter((alert) => alert.reason !== "historical_low")
      .sort((left, right) => (left.monitorId ?? "").localeCompare(right.monitorId ?? "")),
  ].map(formatReason);

  return [
    "*DealRadar Watched alert*",
    escapeSlackText(first.title),
    details.join(" · "),
    ...reasons,
  ].join("\n");
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePendingAlert(row: Record<string, unknown>): PendingWatchedAlert | null {
  if (
    typeof row.alertId !== "string" ||
    typeof row.productId !== "string" ||
    typeof row.snapshotId !== "string" ||
    typeof row.clientMessageId !== "string" ||
    !row.clientMessageId ||
    typeof row.title !== "string" ||
    typeof row.externalUrl !== "string" ||
    typeof row.source !== "string"
  ) return null;

  const state: PendingWatchedAlertState = {
    alertId: row.alertId,
    productId: row.productId,
    snapshotId: row.snapshotId,
    clientMessageId: row.clientMessageId,
    title: row.title,
    externalUrl: row.externalUrl,
    source: row.source,
    watched: row.watched === true,
    hidden: row.hidden === true,
    member: row.member === true,
    monitorActive: row.monitorActive === true,
    displayName: textOrNull(row.displayName),
    currentThresholdPercent: numericOrNull(textOrNull(row.currentThresholdPercent)),
    productCurrentPrice: textOrNull(row.productCurrentPrice),
    productCurrency: textOrNull(row.productCurrency),
    productSourceCurrentPrice: textOrNull(row.productSourceCurrentPrice),
    productSourceCurrency: textOrNull(row.productSourceCurrency),
    productDiscountPercent: numericOrNull(textOrNull(row.productDiscountPercent)),
    observedPrice: textOrNull(row.observedPrice),
    observedCurrency: textOrNull(row.observedCurrency),
    observedSourcePrice: textOrNull(row.observedSourcePrice),
    observedSourceCurrency: textOrNull(row.observedSourceCurrency),
    observedDiscountPercent: numericOrNull(textOrNull(row.observedDiscountPercent)),
    preferenceScore: numberOrNull(row.preferenceScore),
    dealScore: numberOrNull(row.dealScore),
  };

  if (row.reason === "historical_low") {
    const dropPercent = numericOrNull(textOrNull(row.dropPercent));

    return dropPercent === null
      ? null
      : { ...state, reason: row.reason, monitorId: null, discountPercent: null, thresholdPercent: null, dropPercent };
  }

  const discountPercent = numericOrNull(textOrNull(row.discountPercent));
  const thresholdPercent = numericOrNull(textOrNull(row.thresholdPercent));

  if (
    (row.reason !== "crossing" && row.reason !== "new_best") ||
    typeof row.monitorId !== "string" ||
    discountPercent === null ||
    thresholdPercent === null
  ) return null;

  return { ...state, reason: row.reason, monitorId: row.monitorId, discountPercent, thresholdPercent, dropPercent: null };
}

export type WatchedAlertDeliveryResult = {
  sent: number;
  expired: number;
};

// Delivers every pending, unclaimed Watched alert (D13, "Delivery and
// retry"). Alerts that no longer hold are expired (P5(b)). The rest are
// grouped per product and observation, so a historical low and the threshold
// alerts of the same observation go out as one message; each group is claimed with a lease
// and token, sent once with its client_message_id, and marked sent with the
// token. A failed send releases the claim and the other groups are still
// attempted; it throws at the end if any group failed, so the caller can
// retry later.
export async function deliverPendingWatchedAlerts({
  sql,
  postSlackMessage,
}: {
  sql: WatchedAlertSql;
  postSlackMessage: PostSlackMessage;
}): Promise<WatchedAlertDeliveryResult> {
  const rows = await sql`
    SELECT
      alert.id::TEXT AS "alertId",
      alert.product_id::TEXT AS "productId",
      alert.monitor_id AS "monitorId",
      alert.snapshot_id::TEXT AS "snapshotId",
      alert.discount_percent::TEXT AS "discountPercent",
      alert.threshold_percent::TEXT AS "thresholdPercent",
      alert.drop_percent::TEXT AS "dropPercent",
      alert.reason,
      alert.client_message_id AS "clientMessageId",
      product.title,
      product.external_url AS "externalUrl",
      product.source,
      product.watched,
      product.hidden,
      COALESCE(product.monitor_ids @> ARRAY[alert.monitor_id], FALSE) AS "member",
      COALESCE(
        monitor.enabled AND monitor.removed_at IS NULL AND monitor.strategy = 'discount_threshold',
        FALSE
      ) AS "monitorActive",
      monitor.display_name AS "displayName",
      monitor.minimum_discount_percent::TEXT AS "currentThresholdPercent",
      product.current_price::TEXT AS "productCurrentPrice",
      product.currency AS "productCurrency",
      product.source_current_price::TEXT AS "productSourceCurrentPrice",
      product.source_currency AS "productSourceCurrency",
      product.discount_percent::TEXT AS "productDiscountPercent",
      observation.current_price::TEXT AS "observedPrice",
      observation.currency AS "observedCurrency",
      observation.source_current_price::TEXT AS "observedSourcePrice",
      observation.source_currency AS "observedSourceCurrency",
      observation.discount_percent::TEXT AS "observedDiscountPercent",
      evaluation.preference_score AS "preferenceScore",
      evaluation.deal_score AS "dealScore"
    FROM watched_alerts alert
    JOIN products product ON product.id = alert.product_id
    LEFT JOIN monitor_definitions monitor ON monitor.monitor_id = alert.monitor_id
    JOIN product_snapshots observation ON observation.id = alert.snapshot_id
    LEFT JOIN product_evaluations evaluation ON evaluation.product_id = alert.product_id
    WHERE alert.status = 'pending'
      AND (alert.claimed_at IS NULL OR alert.claimed_at <= NOW() - INTERVAL '15 minutes')
    ORDER BY alert.product_id, alert.snapshot_id, alert.monitor_id
  `;
  const alerts = rows.flatMap((row) => {
    const alert = parsePendingAlert(row);
    return alert ? [alert] : [];
  });

  if (alerts.length === 0) return { sent: 0, expired: 0 };

  const expiredIds = alerts.filter((alert) => !isDeliverableWatchedAlert(alert)).map((alert) => alert.alertId);
  let expired = 0;

  if (expiredIds.length > 0) {
    expired = (await sql`
      UPDATE watched_alerts
      SET status = 'expired', claimed_at = NULL, claim_token = NULL
      WHERE id = ANY(${expiredIds}::BIGINT[])
        AND status = 'pending'
        AND (claimed_at IS NULL OR claimed_at <= NOW() - INTERVAL '15 minutes')
      RETURNING id
    `).length;
  }

  const groups = new Map<string, PendingWatchedAlert[]>();

  for (const alert of alerts.filter(isDeliverableWatchedAlert)) {
    const key = `${alert.productId}:${alert.snapshotId}`;
    groups.set(key, [...(groups.get(key) ?? []), alert]);
  }

  if (groups.size === 0) return { sent: 0, expired };

  const preferenceWeightPercent = await loadPreferenceWeightPercent(sql);
  let sent = 0;
  let failed = 0;

  for (const group of groups.values()) {
    const claimed = await sql`
      WITH token AS (SELECT md5(clock_timestamp()::TEXT || random()::TEXT) AS value)
      UPDATE watched_alerts
      SET claimed_at = NOW(), claim_token = token.value
      FROM token
      WHERE watched_alerts.id = ANY(${group.map((alert) => alert.alertId)}::BIGINT[])
        AND watched_alerts.status = 'pending'
        AND (watched_alerts.claimed_at IS NULL OR watched_alerts.claimed_at <= NOW() - INTERVAL '15 minutes')
      RETURNING watched_alerts.id::TEXT AS "alertId", watched_alerts.claim_token AS "claimToken"
    `;
    const claimToken = claimed[0]?.claimToken;
    const claimedIds = new Set(claimed.map((row) => row.alertId));
    const claimedAlerts = group.filter((alert) => claimedIds.has(alert.alertId));

    // Sent or being sent by another call.
    if (typeof claimToken !== "string" || !claimToken || claimedAlerts.length === 0) continue;

    const alertIds = claimedAlerts.map((alert) => alert.alertId);

    try {
      const result = await postSlackMessage(
        formatWatchedAlertMessage(claimedAlerts, preferenceWeightPercent),
        claimedAlerts[0]!.clientMessageId,
      );

      if (!result.success) throw new Error("Slack delivery failed.");

      const marked = await sql`
        UPDATE watched_alerts
        SET status = 'sent', sent_at = NOW(), claimed_at = NULL, claim_token = NULL
        WHERE id = ANY(${alertIds}::BIGINT[])
          AND status = 'pending'
          AND claim_token = ${claimToken}
        RETURNING id
      `;

      if (marked.length === 0) throw new Error("Watched alert could not be recorded as sent.");

      sent += 1;
    } catch {
      failed += 1;
      console.warn("DealRadar Watched alert send failed; the alert stays pending.", {
        productId: claimedAlerts[0]!.productId,
        snapshotId: claimedAlerts[0]!.snapshotId,
      });
      await sql`
        UPDATE watched_alerts
        SET claimed_at = NULL, claim_token = NULL
        WHERE id = ANY(${alertIds}::BIGINT[])
          AND status = 'pending'
          AND claim_token = ${claimToken}
      `;
    }
  }

  if (failed > 0) {
    throw new Error(`Watched alert delivery failed for ${failed} product observation(s); they can be retried.`);
  }

  return { sent, expired };
}
