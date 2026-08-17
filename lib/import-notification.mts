export type ImportRecommendation = {
  productId: string;
  title: string;
  currentPrice: string | null;
  currency: string | null;
  sourceCurrentPrice: string | null;
  sourceCurrency: string | null;
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

function getOverallScore(recommendation: ImportRecommendation) {
  return Math.round(
    recommendation.preferenceScore * 0.6 + recommendation.dealScore * 0.4,
  );
}

function escapeSlackText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  const normalizedPriceRecommendations = recommendations.filter(
    (item) => item.currentPrice !== null && item.currency !== null,
  );

  if (normalizedPriceRecommendations.length > 0) {
    return selectHighestRanked(normalizedPriceRecommendations);
  }

  return selectHighestRanked(
    recommendations.filter(
      (item) =>
        item.sourceCurrentPrice !== null && item.sourceCurrency !== null,
    ),
  );
}

export function formatImportSlackMessage(
  summary: ImportSummary,
  recommendation: ImportRecommendation | null,
  appOrigin: string,
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

  if (!recommendation || !displayPrice) {
    return summaryMessage;
  }

  const productUrl = getProductUrl(appOrigin, recommendation);

  return (
    `${summaryMessage}\nTop recommendation: ` +
    `${escapeSlackText(recommendation.title)} · ` +
    `Preference ${recommendation.preferenceScore}/10 · ` +
    `Deal ${recommendation.dealScore}/10 · ` +
    `${displayPrice.price} ${escapeSlackText(displayPrice.currency)} · ` +
    `<${productUrl}|View in DealRadar>`
  );
}
