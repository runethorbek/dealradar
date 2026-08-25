import { parseProductId } from "./dashboard-products.mts";

export type ProductVisibilityRequest = {
  productId: string;
  hidden: boolean;
};

export function parseProductVisibilityRequest(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  const productId = parseProductId(body.productId);

  if (!productId || typeof body.hidden !== "boolean") {
    return null;
  }

  return {
    productId,
    hidden: body.hidden,
  } satisfies ProductVisibilityRequest;
}
