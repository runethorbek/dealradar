export type ImportRecommendation = {
  productId: string;
  title: string;
  currentPrice: string | null;
  currency: string | null;
  sourceCurrentPrice: string | null;
  sourceCurrency: string | null;
  hidden: boolean;
  preferenceScore: number;
  dealScore: number;
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

const maximumRenderedFailures = 5;
const maximumFailureNameLength = 120;
const maximumFailureErrorLength = 240;

function getOverallScore(recommendation: ImportRecommendation) {
  return Math.round(
    recommendation.preferenceScore * 0.6 + recommendation.dealScore * 0.4,
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

function getDisplayPrice(recommendation: ImportRecommendation) {
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

function getProductUrl(
  appOrigin: string,
  recommendation: ImportRecommendation,
) {
  const url = new URL("/", appOrigin);
  url.searchParams.set("product", recommendation.productId);
  url.hash = `product-${recommendation.productId}`;
  return url.toString();
}

function selectHighestRanked(recommendations: ImportRecommendation[]) {
  return recommendations.reduce<ImportRecommendation | null>((best, item) => {
    if (!best || getOverallScore(item) > getOverallScore(best)) {
      return item;
    }

    return best;
  }, null);
}

export function selectTopRecommendation(
  recommendations: ImportRecommendation[],
) {
  const visibleRecommendations = recommendations.filter(
    (item) => !item.hidden,
  );
  const normalizedPriceRecommendations = visibleRecommendations.filter(
    (item) => item.currentPrice !== null && item.currency !== null,
  );

  if (normalizedPriceRecommendations.length > 0) {
    return selectHighestRanked(normalizedPriceRecommendations);
  }

  return selectHighestRanked(
    visibleRecommendations.filter(
      (item) =>
        item.sourceCurrentPrice !== null && item.sourceCurrency !== null,
    ),
  );
}

export function formatImportSlackMessage(
  summary: ImportSummary,
  recommendation: ImportRecommendation | null,
  appOrigin: string,
  partialScanWarnings: PartialScanWarning[] = [],
) {
  const summaryMessage =
    `DealRadar updated (${summary.ref}): ${summary.productsProcessed} processed` +
    ` · ${summary.productsInserted} new` +
    ` · ${summary.productsUpdated} updated` +
    ` · ${summary.snapshotsInserted} snapshots` +
    ` · ${summary.productsEvaluated} evaluated`;
  const displayPrice = recommendation
    ? getDisplayPrice(recommendation)
    : null;
  let message = summaryMessage;

  if (recommendation && displayPrice) {
    const productUrl = getProductUrl(appOrigin, recommendation);

    message +=
      `\nTop recommendation: ` +
      `${escapeSlackText(recommendation.title)} · ` +
      `Preference ${recommendation.preferenceScore}/10 · ` +
      `Deal ${recommendation.dealScore}/10 · ` +
      `${displayPrice.price} ${escapeSlackText(displayPrice.currency)} · ` +
      `<${productUrl}|View in DealRadar>`;
  }

  if (partialScanWarnings.length === 0) {
    return message;
  }

  message += "\nScan warnings:";

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
