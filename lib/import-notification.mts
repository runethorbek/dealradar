import { getProductDisplayTitle } from "./vinted-display-title.mts";
import { defaultRankingSettings, getOverallScore as computeOverallScore } from "./ranking-settings.mts";

export type ImportRecommendation = {
  productId: string;
  externalUrl: string;
  title: string;
  source?: string;
  brand?: string | null;
  listingText?: string | null;
  articleCondition?: string | null;
  sizeGuess?: string | null;
  translatedListingTextDa?: string | null;
  currentPrice: string | null;
  currency: string | null;
  sourceCurrentPrice: string | null;
  sourceCurrency: string | null;
  hidden: boolean;
  preferenceScore: number;
  dealScore: number;
};

export type ImportSlackHighlight = Omit<
  ImportRecommendation,
  "preferenceScore" | "dealScore"
> & {
  preferenceScore: number | null;
  dealScore: number | null;
};

export const vintedSource = "vinted.com";
export const zalandoSource = "zalando.dk";

export type SourceRecommendations = {
  zalando: ImportSlackHighlight | null;
  vinted: ImportSlackHighlight | null;
};

export type ImportSummary = {
  ref: string;
  productsProcessed: number;
  productsInserted: number;
  productsUpdated: number;
  snapshotsInserted: number;
  productsEvaluated: number;
};

export type PartialScanFailure = {
  name: string | null;
  url: string | null;
  error: string;
};

export type PartialScanWarning = {
  sourceName: string;
  successfulPages: number;
  attemptedPages: number;
  failedPages: number;
  failures: PartialScanFailure[];
};

const minimumRecommendationOverallScore = 7;
const maximumRenderedFailures = 5;
const maximumFailureNameLength = 120;
const maximumFailureErrorLength = 240;

export function getOverallEvaluationScore(
  preferenceScore: number,
  dealScore: number,
  preferenceWeightPercent: number = defaultRankingSettings.preferenceWeightPercent,
) {
  return computeOverallScore(preferenceScore, dealScore, preferenceWeightPercent);
}

function getOverallScore(
  recommendation: ImportRecommendation,
  preferenceWeightPercent: number,
) {
  return Math.round(
    getOverallEvaluationScore(
      recommendation.preferenceScore,
      recommendation.dealScore,
      preferenceWeightPercent,
    ),
  );
}

function escapeSlackText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPageCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function conciseText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.replace(/\s+/g, " ").trim();

  if (!text) {
    return null;
  }

  return text.length <= maximumLength
    ? text
    : `${text.slice(0, maximumLength - 1)}…`;
}

function safeHttpUrl(value: unknown) {
  const text = conciseText(value, 2_000);

  if (!text) {
    return null;
  }

  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parsePartialScanFailure(value: unknown): PartialScanFailure | null {
  if (!isObject(value)) {
    return null;
  }

  const name = conciseText(value.name, maximumFailureNameLength);
  const url = safeHttpUrl(value.url);
  const error = conciseText(
    value.error_summary ?? value.error ?? value.message,
    maximumFailureErrorLength,
  );

  if ((!name && !url) || !error) {
    return null;
  }

  return { name, url, error };
}

export function parsePartialScanWarning(
  sourceName: string,
  payload: unknown,
): PartialScanWarning | null {
  if (!isObject(payload) || !isObject(payload.scan_status)) {
    return null;
  }

  const scanStatus = payload.scan_status;
  const attemptedPages = scanStatus.attempted_pages;
  const successfulPages = scanStatus.successful_pages;
  const failedPages = scanStatus.failed_pages;

  if (
    !isPageCount(attemptedPages) ||
    !isPageCount(successfulPages) ||
    !isPageCount(failedPages) ||
    successfulPages + failedPages !== attemptedPages
  ) {
    return null;
  }

  if (failedPages === 0) {
    return null;
  }

  if (!Array.isArray(scanStatus.failures)) {
    return null;
  }

  const failures = scanStatus.failures.map(parsePartialScanFailure);

  if (
    failures.length === 0 ||
    failures.some((failure) => failure === null)
  ) {
    return null;
  }

  return {
    sourceName,
    successfulPages,
    attemptedPages,
    failedPages,
    failures: failures as PartialScanFailure[],
  };
}

function getRecommendationDisplayTitle(recommendation: ImportSlackHighlight) {
  return getProductDisplayTitle({
    source: recommendation.source ?? "",
    title: recommendation.title,
    brand: recommendation.brand ?? null,
    listingText: recommendation.listingText ?? null,
    articleCondition: recommendation.articleCondition ?? null,
    sizeGuess: recommendation.sizeGuess ?? null,
    evaluation: { translatedListingTextDa: recommendation.translatedListingTextDa ?? null },
  });
}

function getDisplayPrice(recommendation: ImportSlackHighlight) {
  if (recommendation.currentPrice !== null && recommendation.currency !== null) {
    return {
      price: recommendation.currentPrice,
      currency: recommendation.currency,
    };
  }

  if (
    recommendation.sourceCurrentPrice !== null &&
    recommendation.sourceCurrency !== null
  ) {
    return {
      price: recommendation.sourceCurrentPrice,
      currency: recommendation.sourceCurrency,
    };
  }

  return null;
}

function selectHighestRanked(
  recommendations: ImportRecommendation[],
  preferenceWeightPercent: number,
) {
  return recommendations.reduce<ImportRecommendation | null>((best, item) => {
    if (
      !best ||
      getOverallScore(item, preferenceWeightPercent) >
        getOverallScore(best, preferenceWeightPercent)
    ) {
      return item;
    }

    return best;
  }, null);
}

export function selectTopRecommendation(
  recommendations: ImportRecommendation[],
  preferenceWeightPercent: number = defaultRankingSettings.preferenceWeightPercent,
) {
  const visibleRecommendations = recommendations.filter(
    (item) => !item.hidden,
  );
  const normalizedPriceRecommendations = visibleRecommendations.filter(
    (item) => item.currentPrice !== null && item.currency !== null,
  );

  if (normalizedPriceRecommendations.length > 0) {
    return selectHighestRanked(normalizedPriceRecommendations, preferenceWeightPercent);
  }

  return selectHighestRanked(
    visibleRecommendations.filter(
      (item) =>
        item.sourceCurrentPrice !== null && item.sourceCurrency !== null,
    ),
    preferenceWeightPercent,
  );
}

function hasNormalizedPrice(item: ImportRecommendation) {
  return item.currentPrice !== null && item.currency !== null;
}

function hasSourcePrice(item: ImportRecommendation) {
  return item.sourceCurrentPrice !== null && item.sourceCurrency !== null;
}

// Product ids are Postgres BIGINTs serialized as text, so ascending id order is
// numeric rather than lexicographic: a shorter unsigned integer is smaller.
export function compareProductIds(left: string, right: string) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right) && left.length !== right.length) {
    return left.length - right.length;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

// Vinted recommendation (docs/recommendation-policy.md): the visible Vinted
// product evaluated in this import with the highest unrounded Overall score,
// provided it is at least 7. Ties: higher Deal score, then ascending product id.
export function selectVintedRecommendation(
  recommendations: ImportRecommendation[],
  preferenceWeightPercent: number = defaultRankingSettings.preferenceWeightPercent,
) {
  const overallScore = (item: ImportRecommendation) =>
    getOverallEvaluationScore(item.preferenceScore, item.dealScore, preferenceWeightPercent);
  const candidates = recommendations.filter(
    (item) =>
      item.source === vintedSource &&
      !item.hidden &&
      overallScore(item) >= minimumRecommendationOverallScore,
  );
  const normalizedPriceCandidates = candidates.filter(hasNormalizedPrice);
  const pricedCandidates = normalizedPriceCandidates.length > 0
    ? normalizedPriceCandidates
    : candidates.filter(hasSourcePrice);

  return [...pricedCandidates].sort(
    (left, right) =>
      overallScore(right) - overallScore(left) ||
      right.dealScore - left.dealScore ||
      compareProductIds(left.productId, right.productId),
  )[0] ?? null;
}

function formatRecommendation(label: string, recommendation: ImportSlackHighlight) {
  const displayPrice = getDisplayPrice(recommendation);
  const scores =
    recommendation.preferenceScore !== null && recommendation.dealScore !== null
      ? `Preference ${recommendation.preferenceScore}/10 · ` +
        `Deal ${recommendation.dealScore}/10 · `
      : "";
  const price = displayPrice
    ? `${displayPrice.price} ${escapeSlackText(displayPrice.currency)} · `
    : "";

  return (
    `\n\n${label} recommendation:\n` +
    `${escapeSlackText(getRecommendationDisplayTitle(recommendation))}\n` +
    scores +
    price +
    `<${escapeSlackText(recommendation.externalUrl)}|View product>`
  );
}

export function formatImportSlackMessage(
  summary: ImportSummary,
  recommendations: SourceRecommendations,
  partialScanWarnings: PartialScanWarning[] = [],
) {
  const summaryMessage =
    `DealRadar updated: ${summary.productsProcessed} processed` +
    ` · ${summary.productsInserted} new` +
    ` · ${summary.productsUpdated} updated` +
    ` · ${summary.snapshotsInserted} snapshots` +
    ` · ${summary.productsEvaluated} evaluated`;
  let message = summaryMessage;

  // One recommendation per source; the sources are never compared.
  if (recommendations.zalando) {
    message += formatRecommendation("Zalando", recommendations.zalando);
  }

  if (recommendations.vinted) {
    message += formatRecommendation("Vinted", recommendations.vinted);
  }

  if (partialScanWarnings.length === 0) {
    return message;
  }

  message += "\n\nScan warnings:";

  for (const warning of partialScanWarnings) {
    message +=
      `\n• ${escapeSlackText(warning.sourceName)}: ` +
      `${warning.successfulPages}/${warning.attemptedPages} pages succeeded; ` +
      `${warning.failedPages} failed`;

    for (const failure of warning.failures.slice(0, maximumRenderedFailures)) {
      const target = [failure.name, failure.url]
        .filter((value): value is string => value !== null)
        .join(" — ");

      message +=
        `\n  ◦ ${escapeSlackText(target)}: ` +
        escapeSlackText(failure.error);
    }

    if (warning.failures.length > maximumRenderedFailures) {
      message += `\n  ◦ …and ${
        warning.failures.length - maximumRenderedFailures
      } more`;
    }
  }

  return message;
}
