import {
  compareProductIds,
  getOverallEvaluationScore,
  zalandoSource,
  type ImportSlackHighlight,
} from "./import-notification.mts";
import { defaultRankingSettings } from "./ranking-settings.mts";

// Watched historical-low event (docs/recommendation-policy.md): a price
// transition detected once per import from stored snapshots.

export type WatchedHistoricalLowEvent = {
  productId: string;
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

export type WatchedHistoricalLowCandidate = ImportSlackHighlight & {
  watched: boolean;
  dropPercent: number;
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

// Rounded to a fixed precision so nominally equal drops compare equal and the
// documented Overall tie-break decides, not floating-point noise.
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

// Events recorded with an evaluation run are read back as untrusted JSON.
export function parseWatchedHistoricalLows(value: unknown): WatchedHistoricalLowEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): WatchedHistoricalLowEvent[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }

    const { productId, dropPercent } = item as Record<string, unknown>;

    return typeof productId === "string" &&
      /^\d+$/.test(productId) &&
      typeof dropPercent === "number" &&
      Number.isFinite(dropPercent) &&
      dropPercent > 0
      ? [{ productId, dropPercent }]
      : [];
  });
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Loads the current product state and stored evaluation (however old, possibly
// none) for products with an event, so visibility and Watch are re-checked
// when the recommendation is selected.
export async function loadWatchedHistoricalLowCandidates(
  sql: WatchedHistoricalLowSql,
  events: WatchedHistoricalLowEvent[],
): Promise<WatchedHistoricalLowCandidate[]> {
  if (events.length === 0) {
    return [];
  }

  const dropPercentByProductId = new Map(events.map((event) => [event.productId, event.dropPercent]));
  const rows = await sql`
    SELECT p.id::TEXT AS "productId", p.external_url AS "externalUrl", p.title,
      p.source, p.brand,
      p.raw_data ->> 'listing_text' AS "listingText",
      p.raw_data ->> 'article_condition' AS "articleCondition",
      p.raw_data ->> 'size_guess' AS "sizeGuess",
      pe.translated_listing_text_da AS "translatedListingTextDa",
      p.current_price::TEXT AS "currentPrice", p.currency,
      p.source_current_price::TEXT AS "sourceCurrentPrice", p.source_currency AS "sourceCurrency",
      p.hidden, p.watched,
      pe.preference_score AS "preferenceScore", pe.deal_score AS "dealScore"
    FROM products p
    LEFT JOIN product_evaluations pe ON pe.product_id = p.id
    WHERE p.id = ANY(${[...dropPercentByProductId.keys()]}::BIGINT[])
  `;

  return rows.flatMap((row): WatchedHistoricalLowCandidate[] => {
    const productId = String(row.productId);
    const dropPercent = dropPercentByProductId.get(productId);

    if (dropPercent === undefined || typeof row.externalUrl !== "string" || typeof row.title !== "string") {
      return [];
    }

    return [{
      productId,
      externalUrl: row.externalUrl,
      title: row.title,
      source: textOrNull(row.source) ?? undefined,
      brand: textOrNull(row.brand),
      listingText: textOrNull(row.listingText),
      articleCondition: textOrNull(row.articleCondition),
      sizeGuess: textOrNull(row.sizeGuess),
      translatedListingTextDa: textOrNull(row.translatedListingTextDa),
      currentPrice: textOrNull(row.currentPrice),
      currency: textOrNull(row.currency),
      sourceCurrentPrice: textOrNull(row.sourceCurrentPrice),
      sourceCurrency: textOrNull(row.sourceCurrency),
      hidden: row.hidden === true,
      watched: row.watched === true,
      preferenceScore: numberOrNull(row.preferenceScore),
      dealScore: numberOrNull(row.dealScore),
      dropPercent,
    }];
  });
}

function hasNormalizedPrice(candidate: WatchedHistoricalLowCandidate) {
  return candidate.currentPrice !== null && candidate.currency !== null;
}

function hasSourcePrice(candidate: WatchedHistoricalLowCandidate) {
  return candidate.sourceCurrentPrice !== null && candidate.sourceCurrency !== null;
}

// Zalando recommendation step 1: the strongest visible Watched Zalando product
// with an event. No Overall threshold and no evaluation required. Ties: larger
// drop → higher Overall (a stored evaluation ranks above none) → ascending id.
export function selectWatchedHistoricalLowRecommendation(
  candidates: WatchedHistoricalLowCandidate[],
  preferenceWeightPercent: number = defaultRankingSettings.preferenceWeightPercent,
): ImportSlackHighlight | null {
  const overallScore = (candidate: WatchedHistoricalLowCandidate) =>
    candidate.preferenceScore !== null && candidate.dealScore !== null
      ? getOverallEvaluationScore(candidate.preferenceScore, candidate.dealScore, preferenceWeightPercent)
      : null;
  const eligible = candidates.filter(
    (candidate) =>
      candidate.source === zalandoSource &&
      candidate.watched &&
      !candidate.hidden &&
      Number.isFinite(candidate.dropPercent) &&
      candidate.dropPercent > 0,
  );
  const normalizedPriceCandidates = eligible.filter(hasNormalizedPrice);
  const pricedCandidates = normalizedPriceCandidates.length > 0
    ? normalizedPriceCandidates
    : eligible.filter(hasSourcePrice);
  const compareOverall = (left: WatchedHistoricalLowCandidate, right: WatchedHistoricalLowCandidate) => {
    const leftOverall = overallScore(left);
    const rightOverall = overallScore(right);

    if (leftOverall === null || rightOverall === null) {
      return leftOverall === rightOverall ? 0 : leftOverall === null ? 1 : -1;
    }

    return rightOverall - leftOverall;
  };
  return [...pricedCandidates].sort((left, right) =>
    right.dropPercent - left.dropPercent ||
    compareOverall(left, right) ||
    compareProductIds(left.productId, right.productId),
  )[0] ?? null;
}
