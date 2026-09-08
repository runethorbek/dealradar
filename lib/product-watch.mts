import { parseProductId } from "./dashboard-products.mts";

export type ProductWatchRequest = {
  productId: string;
  watched: boolean;
};

export function parseProductWatchRequest(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  const productId = parseProductId(body.productId);

  if (!productId || typeof body.watched !== "boolean") {
    return null;
  }

  return {
    productId,
    watched: body.watched,
  } satisfies ProductWatchRequest;
}
