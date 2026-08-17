export type ScarossoPriceInput = {
  currentPrice: number | null;
  originalPrice: number | null;
  currency: string | null;
};

export type NormalizedScarossoPrices = {
  currentPrice: number | null;
  originalPrice: number | null;
  currency: "DKK" | null;
  sourceCurrentPrice: number | null;
  sourceOriginalPrice: number | null;
  sourceCurrency: string | null;
};

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function convertPrice(value: number | null, rate: number) {
  return value === null ? null : roundCurrency(value * rate);
}

export function parseUsdToDkkRate(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const response = value as Record<string, unknown>;

  if (
    response.base !== "USD" ||
    response.quote !== "DKK" ||
    typeof response.rate !== "number" ||
    !Number.isFinite(response.rate) ||
    response.rate <= 0
  ) {
    return null;
  }

  return response.rate;
}

export function normalizeScarossoPrices(
  input: ScarossoPriceInput,
  usdToDkkRate: number | null,
): NormalizedScarossoPrices {
  const sourceCurrency = input.currency;
  const currencyCode = sourceCurrency?.toUpperCase() ?? null;
  const sourceValues = {
    sourceCurrentPrice: input.currentPrice,
    sourceOriginalPrice: input.originalPrice,
    sourceCurrency,
  };

  if (currencyCode === "DKK") {
    return {
      currentPrice: input.currentPrice,
      originalPrice: input.originalPrice,
      currency: "DKK",
      ...sourceValues,
    };
  }

  if (
    currencyCode === "USD" &&
    usdToDkkRate !== null &&
    Number.isFinite(usdToDkkRate) &&
    usdToDkkRate > 0
  ) {
    return {
      currentPrice: convertPrice(input.currentPrice, usdToDkkRate),
      originalPrice: convertPrice(input.originalPrice, usdToDkkRate),
      currency: "DKK",
      ...sourceValues,
    };
  }

  return {
    currentPrice: null,
    originalPrice: null,
    currency: null,
    ...sourceValues,
  };
}
