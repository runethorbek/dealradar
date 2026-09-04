import type { ProductCardProduct } from "./dashboard-product.mts";
import { includeRequestedProduct, type Visibility } from "./dashboard-products.mts";

export const snapshotSummaryFields = (sql: DashboardSql) => sql`
  COALESCE(snapshot_stats.observation_count, 0)::INT AS "observationCount",
  snapshot_stats.lowest_observed_price::TEXT AS "lowestObservedPrice"
`;

export const snapshotSummaryJoin = (sql: DashboardSql) => sql`
  LEFT JOIN (
    SELECT
      product_id,
      COUNT(current_price) AS observation_count,
      MIN(current_price) AS lowest_observed_price
    FROM product_snapshots
    WHERE current_price IS NOT NULL
    GROUP BY product_id
  ) snapshot_stats ON snapshot_stats.product_id = p.id
`;

export type DashboardSort = "best_match" | "best_deal" | "newest";
export type DashboardSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]> | unknown;
export async function getLatestDashboardProducts(
  sql: DashboardSql,
  source: string | null,
  sort: DashboardSort,
  visibility: Visibility,
  highlightedProductId: string | null,
) {
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
          AND p.hidden = ${visibility === "hidden"}
          AND p.last_seen_at >= NOW() - INTERVAL '24 hours'
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
        WHERE p.hidden = ${visibility === "hidden"}
          AND p.last_seen_at >= NOW() - INTERVAL '24 hours'
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
      AND p.last_seen_at >= NOW() - INTERVAL '24 hours'
  `;

  return includeRequestedProduct(
    products,
    highlightedProduct as ProductCardProduct | undefined,
  );
}
