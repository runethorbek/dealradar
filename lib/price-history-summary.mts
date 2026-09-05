export type PriceHistoryComparison =
  | { kind: "no-history" }
  | { kind: "lowest-now" }
  | { kind: "above-lowest"; percentage: number }
  | null;

export type PriceHistorySummary = {
  observationCount: number;
  lowestObservedPrice: number | null;
  comparison: PriceHistoryComparison;
};

function numericValue(value: unknown) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }

  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

function usablePrice(value: unknown) {
  const price = numericValue(value);
  return price !== null && price >= 0 ? price : null;
}

export function getPriceHistorySummary(
  observationCount: unknown,
  lowestObservedPrice: unknown,
  currentPrice: unknown,
): PriceHistorySummary | null {
  const count = numericValue(observationCount);

  if (count === null || !Number.isInteger(count) || count < 1) {
    return null;
  }

  if (count === 1) {
    return {
      observationCount: count,
      lowestObservedPrice: null,
      comparison: { kind: "no-history" },
    };
  }

  const lowest = usablePrice(lowestObservedPrice);

  if (lowest === null) {
    return null;
  }

  const current = usablePrice(currentPrice);

  if (current === null || current === lowest || lowest === 0) {
    return {
      observationCount: count,
      lowestObservedPrice: lowest,
      comparison:
        current === lowest ? { kind: "lowest-now" } : null,
    };
  }

  if (current < lowest) {
    return null;
  }

  return {
    observationCount: count,
    lowestObservedPrice: lowest,
    comparison: {
      kind: "above-lowest",
      percentage: Math.round(((current - lowest) / lowest) * 100),
    },
  };
}
