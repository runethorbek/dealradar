import type { ProductCardProduct } from "./dashboard-product.mts";
import {
  dashboardFreshnessHours,
  type DashboardFreshness,
} from "./dashboard-freshness.mts";
import { includeRequestedProduct, type DashboardView } from "./dashboard-products.mts";

type DashboardSqlFragment = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;

export const snapshotSummaryFields = (sql: DashboardSqlFragment) => sql`
  COALESCE(snapshot_stats.observation_count, 0)::INT AS "observationCount",
  snapshot_stats.lowest_observed_price::TEXT AS "lowestObservedPrice"
`;

export const snapshotSummaryJoin = (sql: DashboardSqlFragment) => sql`
  LEFT JOIN LATERAL (
    SELECT
      COUNT(current_price) AS observation_count,
      MIN(current_price) AS lowest_observed_price
    FROM product_snapshots
    WHERE product_id = p.id
      AND current_price IS NOT NULL
      AND current_price >= 0
      AND currency IS NOT NULL
      AND p.currency IS NOT NULL
      AND currency = p.currency
  ) snapshot_stats ON TRUE
`;

export type DashboardSort = "best_match" | "best_deal" | "newest";
export type DashboardSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export async function getCurrentZalandoBrands(
  sql: DashboardSql,
  freshness: DashboardFreshness,
) {
  const freshnessHours = dashboardFreshnessHours(freshness);
  const rows = await sql`
    SELECT DISTINCT p.brand AS brand
    FROM products p
    WHERE p.source = 'zalando.dk'
      AND p.brand IS NOT NULL
      AND TRIM(p.brand) <> ''
      AND p.last_seen_at >= NOW() - ${freshnessHours} * INTERVAL '1 hour'
    ORDER BY p.brand ASC
  `;

  return (rows as { brand: string }[]).map((row) => row.brand);
}

export async function getCurrentDashboardMonitors(
  sql: DashboardSql,
  source: string | null,
  freshness: DashboardFreshness,
) {
  const freshnessHours = dashboardFreshnessHours(freshness);
  const rows = await sql`
    SELECT DISTINCT monitor_value #>> '{}' AS monitor_id
    FROM products p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p.raw_data -> 'monitor_ids') = 'array'
        THEN p.raw_data -> 'monitor_ids'
        ELSE '[]'::jsonb
      END
    ) AS monitor_value
    WHERE p.last_seen_at >= NOW() - ${freshnessHours} * INTERVAL '1 hour'
      AND (${source}::text IS NULL OR p.source = ${source})
      AND jsonb_typeof(monitor_value) = 'string'
      AND BTRIM(monitor_value #>> '{}') <> ''
    ORDER BY monitor_value #>> '{}' ASC
  `;

  return (rows as { monitor_id: string }[]).map((row) => row.monitor_id);
}

export async function getLatestDashboardProducts(
  sql: DashboardSql,
  source: string | null,
  sort: DashboardSort,
  view: DashboardView,
  freshness: DashboardFreshness,
  highlightedProductId: string | null,
  brand: string | null = null,
  monitor: string | null = null,
) {
  const freshnessHours = dashboardFreshnessHours(freshness);
  const selectedBrand = source === "zalando.dk" ? brand : null;
  const rows = source
    ? await sql`
        SELECT
          p.id::TEXT AS id,
          p.external_url AS "externalUrl",
          p.title,
          p.image_url AS "imageUrl",
          p.source,
          p.current_price::TEXT AS "currentPrice",
          p.original_price::TEXT AS "originalPrice",
          p.currency,
          p.discount_percent::TEXT AS "discountPercent",
          p.last_seen_at::TEXT AS "lastSeenAt",
          p.hidden,
          p.watched,
          pf.rating AS feedback,
          CASE
            WHEN pe.product_id IS NULL THEN NULL
            ELSE json_build_object(
              'preferenceScore', pe.preference_score,
              'dealScore', pe.deal_score,
              'reason', pe.reason,
              'evaluatedAt', pe.evaluated_at::TEXT
            )
          END AS evaluation,
          ${snapshotSummaryFields(sql)}
        FROM products p
        LEFT JOIN product_feedback pf ON pf.product_id = p.id
        LEFT JOIN product_evaluations pe ON pe.product_id = p.id
        ${snapshotSummaryJoin(sql)}
        WHERE p.source = ${source}
          AND (${selectedBrand}::text IS NULL OR p.brand = ${selectedBrand})
          AND (${monitor}::text IS NULL OR p.raw_data -> 'monitor_ids' ? ${monitor})
          AND (
            (${view === "watchlist"} AND p.watched = TRUE)
            OR (${view !== "watchlist"} AND p.hidden = ${view === "hidden"})
          )
          AND p.last_seen_at >= NOW() - ${freshnessHours} * INTERVAL '1 hour'
        ORDER BY
          (pe.product_id IS NULL) ASC,
          CASE
            WHEN ${sort} = 'best_match'
            THEN ROUND(pe.preference_score * 0.6 + pe.deal_score * 0.4)
          END DESC NULLS LAST,
          CASE WHEN ${sort} = 'best_deal' THEN pe.deal_score END DESC NULLS LAST,
          CASE WHEN ${sort} = 'newest' THEN p.last_seen_at END DESC NULLS LAST,
          p.last_seen_at DESC
        LIMIT 50
      `
    : await sql`
        SELECT
          p.id::TEXT AS id,
          p.external_url AS "externalUrl",
          p.title,
          p.image_url AS "imageUrl",
          p.source,
          p.current_price::TEXT AS "currentPrice",
          p.original_price::TEXT AS "originalPrice",
          p.currency,
          p.discount_percent::TEXT AS "discountPercent",
          p.last_seen_at::TEXT AS "lastSeenAt",
          p.hidden,
          p.watched,
          pf.rating AS feedback,
          CASE
            WHEN pe.product_id IS NULL THEN NULL
            ELSE json_build_object(
              'preferenceScore', pe.preference_score,
              'dealScore', pe.deal_score,
              'reason', pe.reason,
              'evaluatedAt', pe.evaluated_at::TEXT
            )
          END AS evaluation,
          ${snapshotSummaryFields(sql)}
        FROM products p
        LEFT JOIN product_feedback pf ON pf.product_id = p.id
        LEFT JOIN product_evaluations pe ON pe.product_id = p.id
        ${snapshotSummaryJoin(sql)}
        WHERE (
            (${view === "watchlist"} AND p.watched = TRUE)
            OR (${view !== "watchlist"} AND p.hidden = ${view === "hidden"})
          )
          AND (${selectedBrand}::text IS NULL OR p.brand = ${selectedBrand})
          AND (${monitor}::text IS NULL OR p.raw_data -> 'monitor_ids' ? ${monitor})
          AND p.last_seen_at >= NOW() - ${freshnessHours} * INTERVAL '1 hour'
        ORDER BY
          (pe.product_id IS NULL) ASC,
          CASE
            WHEN ${sort} = 'best_match'
            THEN ROUND(pe.preference_score * 0.6 + pe.deal_score * 0.4)
          END DESC NULLS LAST,
          CASE WHEN ${sort} = 'best_deal' THEN pe.deal_score END DESC NULLS LAST,
          CASE WHEN ${sort} = 'newest' THEN p.last_seen_at END DESC NULLS LAST,
          p.last_seen_at DESC
        LIMIT 50
      `;

  const products = rows as ProductCardProduct[];

  if (
    !highlightedProductId ||
    products.some((product) => product.id === highlightedProductId)
  ) {
    return products;
  }

  const [highlightedProduct] = await sql`
    SELECT
      p.id::TEXT AS id,
      p.external_url AS "externalUrl",
      p.title,
      p.image_url AS "imageUrl",
      p.source,
      p.current_price::TEXT AS "currentPrice",
      p.original_price::TEXT AS "originalPrice",
      p.currency,
      p.discount_percent::TEXT AS "discountPercent",
      p.last_seen_at::TEXT AS "lastSeenAt",
      p.hidden,
      p.watched,
      pf.rating AS feedback,
      CASE
        WHEN pe.product_id IS NULL THEN NULL
        ELSE json_build_object(
          'preferenceScore', pe.preference_score,
          'dealScore', pe.deal_score,
          'reason', pe.reason,
          'evaluatedAt', pe.evaluated_at::TEXT
        )
      END AS evaluation,
      ${snapshotSummaryFields(sql)}
    FROM products p
    LEFT JOIN product_feedback pf ON pf.product_id = p.id
    LEFT JOIN product_evaluations pe ON pe.product_id = p.id
    ${snapshotSummaryJoin(sql)}
    WHERE p.id = ${highlightedProductId}
      AND (${source} IS NULL OR p.source = ${source})
      AND (${selectedBrand}::text IS NULL OR p.brand = ${selectedBrand})
      AND (${monitor}::text IS NULL OR p.raw_data -> 'monitor_ids' ? ${monitor})
      AND (${view !== "watchlist"} OR p.watched = TRUE)
      AND p.last_seen_at >= NOW() - ${freshnessHours} * INTERVAL '1 hour'
  `;

  return includeRequestedProduct(
    products,
    highlightedProduct as ProductCardProduct | undefined,
  );
}
