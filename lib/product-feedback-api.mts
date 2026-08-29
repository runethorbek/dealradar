import type { OwnerAuthorization } from "./owner-authorization.mts";

export type Rating = "like" | "dislike";

type SavedFeedback = { rating: Rating };

type ProductFeedbackHandlerDependencies = {
  authorize: () => Promise<OwnerAuthorization>;
  save: (feedback: { productId: string; rating: Rating }) => Promise<SavedFeedback>;
};

function getProductId(value: unknown) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  return null;
}

function getRating(value: unknown): Rating | null {
  return value === "like" || value === "dislike" ? value : null;
}

function authorizationResponse(authorization: OwnerAuthorization) {
  if (authorization.status === "unauthenticated") {
    return Response.json({ success: false, error: "Unauthorized." }, { status: 401 });
  }
  if (authorization.status === "unauthorized") {
    return Response.json({ success: false, error: "Forbidden." }, { status: 403 });
  }
  return null;
}

export async function handleProductFeedbackPost(
  request: Request,
  dependencies: ProductFeedbackHandlerDependencies,
) {
  const rejectedResponse = authorizationResponse(await dependencies.authorize());
  if (rejectedResponse) return rejectedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ success: false, error: "Invalid feedback." }, { status: 400 });
  }

  const productId = getProductId((body as Record<string, unknown>).productId);
  const rating = getRating((body as Record<string, unknown>).rating);

  if (!productId || !rating) {
    return Response.json({ success: false, error: "Invalid feedback." }, { status: 400 });
  }

  try {
    const feedback = await dependencies.save({ productId, rating });
    return Response.json({ success: true, rating: feedback.rating });
  } catch {
    return Response.json({ success: false, error: "Feedback could not be saved." }, { status: 500 });
  }
}
