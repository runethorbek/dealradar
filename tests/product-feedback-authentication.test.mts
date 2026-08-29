import assert from "node:assert/strict";
import test from "node:test";
import { handleProductFeedbackPost } from "../lib/product-feedback-api.mts";

function feedbackRequest(rating: "like" | "dislike") {
  return new Request("http://localhost/api/product-feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "42", rating }),
  });
}

test("rejected feedback requests do not invoke persistence", async () => {
  for (const authorization of [
    { status: "unauthenticated" } as const,
    { status: "unauthorized" } as const,
  ]) {
    let saveCalls = 0;
    const response = await handleProductFeedbackPost(feedbackRequest("like"), {
      authorize: async () => authorization,
      save: async () => {
        saveCalls += 1;
        return { rating: "like" };
      },
    });

    assert.equal(response.status, authorization.status === "unauthenticated" ? 401 : 403);
    assert.equal(saveCalls, 0);
  }
});

test("an authorized owner can save Like and Not for me feedback", async () => {
  for (const rating of ["like", "dislike"] as const) {
    let savedFeedback: { productId: string; rating: "like" | "dislike" } | undefined;
    const response = await handleProductFeedbackPost(feedbackRequest(rating), {
      authorize: async () => ({ status: "authorized" }),
      save: async (feedback) => {
        savedFeedback = feedback;
        return { rating: feedback.rating };
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(savedFeedback, { productId: "42", rating });
    assert.deepEqual(await response.json(), { success: true, rating });
  }
});
