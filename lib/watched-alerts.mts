import { loadPreferenceWeightPercent, type PostSlackMessage } from "./daily-summary.mts";
import { escapeSlackText } from "./import-notification.mts";
import { isReliableDiscount } from "./monitor-recommendation.mts";
import { getOverallScore } from "./ranking-settings.mts";
import type { WatchedHistoricalLowEvent } from "./watched-historical-low.mts";

// Watched alerts (#81; design D12, D13, P1(b)(i), P4(ii), P5(b), P6(a), P10(a)
// in docs/specs/monitor-recommendation-design.md). Detected at import time
// from inserted snapshots, stored in watched_alerts (migration 031), and
// delivered once per product and observation under a claim. No Next.js,
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

function numericOrNull(value: string | null) {
  if (value === null || value.trim() === "") return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

// How an earlier snapshot counts for transitions (D12, P1 sub-point (i)):
// - priced (current price ≥ 0 and currency known) with a discount in range:
//   that discount;
// - priced with a null discount: 0% (no discount was detected);
// - no price, or an out-of-range discount: skipped (null).
function transitionDiscount(observation: WatchedAlertObservation) {
  const price = numericOrNull(observation.currentPrice);

  if (price === null || price < 0 || observation.currency === null) return null;

  if (observation.discountPercent === null) return 0;

  const discount = numericOrNull(observation.discountPercent);

  return discount !== null && discount > 0 && discount < 100 ? discount : null;
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
// (Watched, visible, in an active discount_threshold monitor). P4(ii): a
// product with a watched historical-low event in this import produces no
// Watched alert; both events belong to the product's latest inserted
// observation, so the product id identifies the same observation.
export function detectWatchedAlerts(
  products: WatchedAlertProduct[],
  insertedSnapshotIds: ReadonlySet<string>,
  suppressedProductIds: ReadonlySet<string> = new Set(),
): WatchedAlertCandidate[] {
  return products.flatMap((product) => {
    const latest = product.observations.at(-1);

    // The inserted observation must be the product's latest.
    if (!latest || !insertedSnapshotIds.has(latest.snapshotId) || suppressedProductIds.has(product.productId)) {
      return [];
    }

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
  watchedHistoricalLows: WatchedHistoricalLowEvent[] = [],
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

  return detectWatchedAlerts(
    [...products.values()],
    new Set(insertedSnapshotIds),
    new Set(watchedHistoricalLows.map((event) => event.productId)),
  );
}

// Detects and stores this import's Watched alerts. Rows are unique per
// (product, monitor, snapshot) and inserted with ON CONFLICT DO NOTHING, so
// detection is idempotent. client_message_id is derived from the product and
// snapshot, so every row of one message shares it.
export async function recordWatchedAlerts(
  sql: WatchedAlertSql,
  insertedSnapshotIds: string[],
  watchedHistoricalLows: WatchedHistoricalLowEvent[] = [],
): Promise<WatchedAlertCandidate[]> {
  const candidates = await findWatchedAlerts(sql, insertedSnapshotIds, watchedHistoricalLows);

  if (candidates.length === 0) return [];

  await sql`
    WITH detected AS (
      SELECT
        r.product_id,
        r.monitor_id,
        r.snapshot_id,
        r.discount_percent,
        r.threshold_percent,
        r.reason,
        md5('dealradar:watched-alert:' || r.product_id::TEXT || ':' || r.snapshot_id::TEXT) AS hash
      FROM jsonb_to_recordset(${JSON.stringify(candidates.map((candidate) => ({
        product_id: candidate.productId,
        monitor_id: candidate.monitorId,
        snapshot_id: candidate.snapshotId,
        discount_percent: candidate.discountPercent,
        threshold_percent: candidate.thresholdPercent,
        reason: candidate.reason,
      })))}::JSONB) AS r(
        product_id BIGINT,
        monitor_id TEXT,
        snapshot_id BIGINT,
        discount_percent NUMERIC,
        threshold_percent NUMERIC,
        reason TEXT
      )
    )
    INSERT INTO watched_alerts (
      product_id, monitor_id, snapshot_id, discount_percent, threshold_percent, reason, client_message_id
    )
    SELECT
      product_id, monitor_id, snapshot_id, discount_percent, threshold_percent, reason,
      concat(
        substr(hash, 1, 8), '-', substr(hash, 9, 4), '-4', substr(hash, 14, 3), '-8',
        substr(hash, 18, 3), '-', substr(hash, 21, 12)
      )
    FROM detected
    ON CONFLICT (product_id, monitor_id, snapshot_id) DO NOTHING
  `;

  return candidates;
}

// A pending alert row with the current state needed to re-check it (P5(b))
// and to format it.
export type PendingWatchedAlert = {
  alertId: string;
  productId: string;
  monitorId: string;
  snapshotId: string;
  discountPercent: number;
  thresholdPercent: number;
  reason: WatchedAlertReason;
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
  productDiscountPercent: number | null;
  observedPrice: string | null;
  observedCurrency: string | null;
  observedSourcePrice: string | null;
  observedSourceCurrency: string | null;
  preferenceScore: number | null;
  dealScore: number | null;
};

// P5(b): a pending alert is delivered only while the product is still
// Watched, visible, and qualifying for that monitor: the monitor is an active
// discount_threshold monitor, the product is still its member, and the
// product's current reliable discount is at or above the current threshold
// (D12 conditions 1, 2, and 4 on the current stored state).
export function isDeliverableWatchedAlert(alert: PendingWatchedAlert) {
  return (
    alert.watched &&
    !alert.hidden &&
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
  return alert.reason === "crossing"
    ? `crossed the ${formatNumber(alert.thresholdPercent)}% threshold`
    : `new best in the qualifying episode (threshold ${formatNumber(alert.thresholdPercent)}%)`;
}

// One message per product and observation, listing every triggering monitor
// (D10). The price is the alerted observation's, with the display-price pair
// preference (normalized, then source).
export function formatWatchedAlertMessage(alerts: PendingWatchedAlert[], preferenceWeightPercent: number) {
  const [first] = alerts;

  if (!first) throw new Error("A Watched alert message needs at least one alert.");

  const price = first.observedPrice !== null && first.observedCurrency !== null
    ? `${escapeSlackText(first.observedPrice)} ${escapeSlackText(first.observedCurrency)}`
    : first.observedSourcePrice !== null && first.observedSourceCurrency !== null
      ? `${escapeSlackText(first.observedSourcePrice)} ${escapeSlackText(first.observedSourceCurrency)}`
      : null;
  const details = [
    price,
    `${formatNumber(first.discountPercent)}% discount`,
    first.preferenceScore !== null && first.dealScore !== null
      ? `Overall ${getOverallScore(first.preferenceScore, first.dealScore, preferenceWeightPercent).toFixed(1)}`
      : null,
    `<${escapeSlackText(first.externalUrl)}|View product>`,
  ].filter((value): value is string => value !== null);
  const monitors = [...alerts]
    .sort((left, right) => left.monitorId.localeCompare(right.monitorId))
    .map((alert) => `• ${escapeSlackText(alert.displayName ?? alert.monitorId)}: ${formatReason(alert)}`);

  return [
    "*DealRadar Watched alert*",
    escapeSlackText(first.title),
    details.join(" · "),
    ...monitors,
  ].join("\n");
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePendingAlert(row: Record<string, unknown>): PendingWatchedAlert | null {
  const discountPercent = numericOrNull(textOrNull(row.discountPercent));
  const thresholdPercent = numericOrNull(textOrNull(row.thresholdPercent));

  if (
    typeof row.alertId !== "string" ||
    typeof row.productId !== "string" ||
    typeof row.monitorId !== "string" ||
    typeof row.snapshotId !== "string" ||
    typeof row.clientMessageId !== "string" ||
    !row.clientMessageId ||
    typeof row.title !== "string" ||
    typeof row.externalUrl !== "string" ||
    typeof row.source !== "string" ||
    (row.reason !== "crossing" && row.reason !== "new_best") ||
    discountPercent === null ||
    thresholdPercent === null
  ) return null;

  return {
    alertId: row.alertId,
    productId: row.productId,
    monitorId: row.monitorId,
    snapshotId: row.snapshotId,
    discountPercent,
    thresholdPercent,
    reason: row.reason,
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
    productDiscountPercent: numericOrNull(textOrNull(row.productDiscountPercent)),
    observedPrice: textOrNull(row.observedPrice),
    observedCurrency: textOrNull(row.observedCurrency),
    observedSourcePrice: textOrNull(row.observedSourcePrice),
    observedSourceCurrency: textOrNull(row.observedSourceCurrency),
    preferenceScore: numberOrNull(row.preferenceScore),
    dealScore: numberOrNull(row.dealScore),
  };
}

export type WatchedAlertDeliveryResult = {
  sent: number;
  expired: number;
};

// Delivers every pending, unclaimed Watched alert (D13, "Delivery and
// retry"). Alerts that no longer hold are expired (P5(b)). The rest are
// grouped per product and observation; each group is claimed with a lease
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
      alert.reason,
      alert.client_message_id AS "clientMessageId",
      product.title,
      product.external_url AS "externalUrl",
      product.source,
      product.watched,
      product.hidden,
      (product.monitor_ids @> ARRAY[alert.monitor_id]) AS "member",
      COALESCE(
        monitor.enabled AND monitor.removed_at IS NULL AND monitor.strategy = 'discount_threshold',
        FALSE
      ) AS "monitorActive",
      monitor.display_name AS "displayName",
      monitor.minimum_discount_percent::TEXT AS "currentThresholdPercent",
      product.current_price::TEXT AS "productCurrentPrice",
      product.currency AS "productCurrency",
      product.discount_percent::TEXT AS "productDiscountPercent",
      observation.current_price::TEXT AS "observedPrice",
      observation.currency AS "observedCurrency",
      observation.source_current_price::TEXT AS "observedSourcePrice",
      observation.source_currency AS "observedSourceCurrency",
      evaluation.preference_score AS "preferenceScore",
      evaluation.deal_score AS "dealScore"
    FROM watched_alerts alert
    JOIN products product ON product.id = alert.product_id
    JOIN monitor_definitions monitor ON monitor.monitor_id = alert.monitor_id
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
