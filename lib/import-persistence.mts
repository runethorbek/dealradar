import type { ImportEvaluationResult } from "@/lib/import-evaluation.mts";

type JsonObject = Record<string, unknown>;

export type NormalizedProduct = {
  source: string;
  externalUrl: string;
  title: string;
  imageUrl: string | null;
  currentPrice: number | null;
  originalPrice: number | null;
  currency: string | null;
  sourceCurrentPrice: number | null;
  sourceOriginalPrice: number | null;
  sourceCurrency: string | null;
  discountPercent: number | null;
  available: boolean | null;
  brand: string | null;
  observedAt: string;
  rawData: JsonObject;
};

export type ImportResult = ImportEvaluationResult & {
  snapshotId: string | null;
};

// Matches the subset of @neondatabase/serverless's `neon()` client that
// persistence needs: a tagged-template query function plus its
// batch-in-one-transaction helper. Any client implementing this shape
// (e.g. a test double wrapping a different Postgres driver) can be used.
export type ImportPersistenceSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown[]>;
  transaction(queries: PromiseLike<unknown[]>[]): Promise<unknown[][]>;
};

export function buildProductUpsertQuery(
  sql: ImportPersistenceSql,
  product: NormalizedProduct,
) {
  return sql`
    WITH existing AS MATERIALIZED (
      SELECT
        id,
        current_price,
        currency,
        source_current_price,
        source_currency
      FROM products
      WHERE source = ${product.source}
        AND external_url = ${product.externalUrl}
    ),
    upserted AS (
      INSERT INTO products (
        source,
        external_url,
        title,
        image_url,
        current_price,
        original_price,
        currency,
        source_current_price,
        source_original_price,
        source_currency,
        discount_percent,
        available,
        brand,
        first_seen_at,
        last_seen_at,
        raw_data
      ) VALUES (
        ${product.source},
        ${product.externalUrl},
        ${product.title},
        ${product.imageUrl},
        ${product.currentPrice},
        ${product.originalPrice},
        ${product.currency},
        ${product.sourceCurrentPrice},
        ${product.sourceOriginalPrice},
        ${product.sourceCurrency},
        ${product.discountPercent},
        ${product.available},
        ${product.brand},
        ${product.observedAt},
        ${product.observedAt},
        ${JSON.stringify(product.rawData)}::JSONB
      )
      ON CONFLICT (source, external_url) DO UPDATE SET
        title = EXCLUDED.title,
        image_url = EXCLUDED.image_url,
        current_price = EXCLUDED.current_price,
        original_price = EXCLUDED.original_price,
        currency = EXCLUDED.currency,
        source_current_price = EXCLUDED.source_current_price,
        source_original_price = EXCLUDED.source_original_price,
        source_currency = EXCLUDED.source_currency,
        discount_percent = EXCLUDED.discount_percent,
        available = EXCLUDED.available,
        brand = EXCLUDED.brand,
        last_seen_at = EXCLUDED.last_seen_at,
        raw_data = EXCLUDED.raw_data
      RETURNING
        id,
        source,
        external_url,
        title,
        current_price,
        currency,
        source_current_price,
        source_currency,
        hidden,
        brand,
        raw_data,
        discount_percent
    ),
    snapshot AS (
      INSERT INTO product_snapshots (
        product_id,
        observed_at,
        current_price,
        original_price,
        currency,
        source_current_price,
        source_original_price,
        source_currency,
        discount_percent,
        available
      )
      SELECT
        id,
        ${product.observedAt},
        ${product.currentPrice},
        ${product.originalPrice},
        ${product.currency},
        ${product.sourceCurrentPrice},
        ${product.sourceOriginalPrice},
        ${product.sourceCurrency},
        ${product.discountPercent},
        ${product.available}
      FROM upserted
      WHERE TRUE
      ON CONFLICT (product_id, observed_at) DO NOTHING
      RETURNING id
    )
    SELECT
      upserted.id::TEXT AS "productId",
      upserted.source,
      upserted.external_url AS "externalUrl",
      upserted.title,
      upserted.current_price::TEXT AS "currentPrice",
      upserted.currency,
      upserted.source_current_price::TEXT AS "sourceCurrentPrice",
      upserted.source_currency AS "sourceCurrency",
      upserted.hidden,
      upserted.brand,
      upserted.raw_data ->> 'listing_text' AS "listingText",
      upserted.raw_data ->> 'article_condition' AS "articleCondition",
      upserted.raw_data ->> 'size_guess' AS "sizeGuess",
      (existing.id IS NULL) AS inserted,
      snapshot.id::TEXT AS "snapshotId",
      (
        snapshot.id IS NOT NULL
        AND existing.id IS NOT NULL
        AND CASE
          WHEN upserted.source_current_price IS NOT NULL
          THEN existing.source_current_price IS NOT NULL
            AND existing.source_currency IS NOT NULL
            AND upserted.source_currency IS NOT NULL
            AND existing.source_currency = upserted.source_currency
            AND existing.source_current_price
              IS DISTINCT FROM upserted.source_current_price
          ELSE existing.current_price IS NOT NULL
            AND upserted.current_price IS NOT NULL
            AND existing.currency IS NOT NULL
            AND upserted.currency IS NOT NULL
            AND existing.currency = upserted.currency
            AND existing.current_price IS DISTINCT FROM upserted.current_price
        END
      ) AS "priceChanged",
      CASE
        WHEN existing.source_current_price > 0
          AND upserted.source_current_price IS NOT NULL
          AND existing.source_currency IS NOT NULL
          AND upserted.source_currency IS NOT NULL
          AND existing.source_currency = upserted.source_currency
          AND upserted.source_current_price < existing.source_current_price
        THEN (
          (existing.source_current_price - upserted.source_current_price)
          / existing.source_current_price
          * 100
        )::TEXT
        WHEN upserted.source_current_price IS NULL
          AND existing.current_price > 0
          AND upserted.current_price IS NOT NULL
          AND existing.currency IS NOT NULL
          AND upserted.currency IS NOT NULL
          AND existing.currency = upserted.currency
          AND upserted.current_price < existing.current_price
        THEN (
          (existing.current_price - upserted.current_price)
          / existing.current_price
          * 100
        )::TEXT
        ELSE NULL
      END AS "priceDropPercent",
      upserted.discount_percent::TEXT AS "discountPercent"
    FROM upserted
    LEFT JOIN existing ON existing.id = upserted.id
    LEFT JOIN snapshot ON TRUE
  `;
}

export async function persistImportedProducts(
  sql: ImportPersistenceSql,
  products: NormalizedProduct[],
): Promise<ImportResult[]> {
  const queries = products.map((product) => buildProductUpsertQuery(sql, product));
  const results = queries.length ? await sql.transaction(queries) : [];

  return results.flatMap((result) =>
    result[0] ? [result[0] as ImportResult] : [],
  );
}
