const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");

export type Visibility = "visible" | "hidden";

export function parseVisibility(value: unknown): Visibility {
  return value === "hidden" ? "hidden" : "visible";
}

export function parseProductId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 19 ||
    !/^[1-9]\d*$/.test(value)
  ) {
    return null;
  }

  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : null;
  } catch {
    return null;
  }
}

export function includeRequestedProduct<T extends { id: string }>(
  products: T[],
  requestedProduct: T | null | undefined,
) {
  if (
    !requestedProduct ||
    products.some((product) => product.id === requestedProduct.id)
  ) {
    return products;
  }

  return [requestedProduct, ...products];
}
