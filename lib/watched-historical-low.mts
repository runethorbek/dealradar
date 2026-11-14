import { zalandoSource } from "./import-notification.mts";

// Watched historical-low event (docs/recommendation-policy.md): a price
// transition detected once per import from stored snapshots. Since #89 each
// event is recorded as a 'historical_low' Watched alert on snapshotId, the
// product's latest observation, inserted by this import.

export type WatchedHistoricalLowEvent = {
  productId: string;
  snapshotId: string;
  dropPercent: number;
};

// One stored observation (product_snapshots row). Prices are NUMERIC text.
export type PriceObservation = {
  snapshotId: string;
  productId: string;
  currentPrice: string | null;
  currency: string | null;
  sourceCurrentPrice: string | null;
  sourceCurrency: string | null;
};

type WatchedHistoricalLowSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<Array<Record<string, unknown>>>;

function parsePrice(value: string | null) {
  if (value === null) {
    return null;
  }

  const price = Number(value);

  return Number.isFinite(price) && price >= 0 ? price : null;
}

// The new observation's pair decides which pair is compared: the source pair
// when it has a source price, otherwise the normalized pair.
function comparedPrice(observation: PriceObservation, useSourcePair: boolean) {
  const price = parsePrice(useSourcePair ? observation.sourceCurrentPrice : observation.currentPrice);
  const currency = useSourcePair ? observation.sourceCurrency : observation.currency;

  return price !== null && currency !== null ? { price, currency } : null;
}

// Rounded to a fixed precision (4 decimal places, as stored in
// watched_alerts.drop_percent) so floating-point noise is not recorded.
function roundDropPercent(dropPercent: number) {
  return Math.round(dropPercent * 10_000) / 10_000;
}

function detectEvent(observations: PriceObservation[], insertedSnapshotIds: ReadonlySet<string>) {
  // Observations are ordered by ascending observed_at, so the last one is the
  // product's latest. An inserted observation that is not the latest (or an
  // import that inserted nothing) is not an event.
  const latest = observations.at(-1);

  if (!latest || !insertedSnapshotIds.has(latest.snapshotId)) {
    return null;
  }

  const useSourcePair = latest.sourceCurrentPrice !== null;
  const current = comparedPrice(latest, useSourcePair);

  if (!current) {
    return null;
  }

  const comparableHistory = observations
    .slice(0, -1)
    .map((observation) => comparedPrice(observation, useSourcePair))
    .filter((observation) => observation?.currency === current.currency)
    .map((observation) => observation!.price);
  const previousPrice = comparableHistory.at(-1);

  if (previousPrice === undefined || current.price >= previousPrice) {
    return null;
  }

  if (current.price > Math.min(...comparableHistory)) {
    return null;
  }

  return {
    productId: latest.productId,
    snapshotId: latest.snapshotId,
    dropPercent: roundDropPercent((previousPrice - current.price) / previousPrice * 100),
  };
}

// `observations` must be ordered by product, then ascending observed_at.
export function detectWatchedHistoricalLows(
  observations: PriceObservation[],
  insertedSnapshotIds: ReadonlySet<string>,
): WatchedHistoricalLowEvent[] {
  const observationsByProduct = new Map<string, PriceObservation[]>();

  for (const observation of observations) {
    const productObservations = observationsByProduct.get(observation.productId) ?? [];
    productObservations.push(observation);
    observationsByProduct.set(observation.productId, productObservations);
  }

  return [...observationsByProduct.values()].flatMap((productObservations) => {
    const event = detectEvent(productObservations, insertedSnapshotIds);
    return event ? [event] : [];
  });
}

function textOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

// One snapshot-history query per import: the full stored history of visible
// Watched Zalando products that received a new observation in this import.
export async function findWatchedHistoricalLows(
  sql: WatchedHistoricalLowSql,
  insertedSnapshotIds: string[],
): Promise<WatchedHistoricalLowEvent[]> {
  if (insertedSnapshotIds.length === 0) {
    return [];
  }

  const rows = await sql`
    WITH observed_products AS (
      SELECT DISTINCT s.product_id
      FROM product_snapshots s
      JOIN products p ON p.id = s.product_id
      WHERE s.id = ANY(${insertedSnapshotIds}::BIGINT[])
        AND p.source = ${zalandoSource}
        AND p.watched
        AND NOT p.hidden
    )
    SELECT
      s.id::TEXT AS "snapshotId",
      s.product_id::TEXT AS "productId",
      s.current_price::TEXT AS "currentPrice",
      s.currency,
      s.source_current_price::TEXT AS "sourceCurrentPrice",
      s.source_currency AS "sourceCurrency"
    FROM product_snapshots s
    JOIN observed_products op ON op.product_id = s.product_id
    ORDER BY s.product_id, s.observed_at
  `;
  const observations = rows.flatMap((row): PriceObservation[] =>
    typeof row.snapshotId === "string" && typeof row.productId === "string"
      ? [{
          snapshotId: row.snapshotId,
          productId: row.productId,
          currentPrice: textOrNull(row.currentPrice),
          currency: textOrNull(row.currency),
          sourceCurrentPrice: textOrNull(row.sourceCurrentPrice),
          sourceCurrency: textOrNull(row.sourceCurrency),
        }]
      : [],
  );

  return detectWatchedHistoricalLows(observations, new Set(insertedSnapshotIds));
}
