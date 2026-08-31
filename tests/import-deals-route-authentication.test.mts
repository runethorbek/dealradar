import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalIngestApiKey = process.env.INGEST_API_KEY;
const originalFetch = globalThis.fetch;
let feedFetchCalls = 0;
let neonCalls = 0;
let persistenceCalls = 0;
let evaluationCalls = 0;
let slackCalls = 0;

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    neonCalls += 1;

    return Object.assign(
      () => undefined,
      {
        transaction: async (queries: unknown[]) => {
          persistenceCalls += 1;
          assert.equal(queries.length, 1);
          return [[{
            productId: "42",
            title: "Test shoe",
            currentPrice: "1200",
            currency: "DKK",
            sourceCurrentPrice: null,
            sourceCurrency: null,
            hidden: false,
            inserted: true,
            snapshotId: "snapshot-42",
            priceChanged: false,
            priceDropPercent: null,
            discountPercent: "20",
          }]];
        },
      },
    );
  },
});
mockModule("@/lib/product-evaluation", {
  evaluateProduct: async () => {
    evaluationCalls += 1;
    return { preferenceScore: 8, dealScore: 7, reason: "Test result" };
  },
});
mockModule("@/lib/slack", {
  postSlackMessage: async () => {
    slackCalls += 1;
    return { success: true };
  },
});

const { POST } = await import("../app/api/import-deals/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;

  if (originalIngestApiKey === undefined) delete process.env.INGEST_API_KEY;
  else process.env.INGEST_API_KEY = originalIngestApiKey;

  globalThis.fetch = originalFetch;
});

function reset() {
  feedFetchCalls = 0;
  neonCalls = 0;
  persistenceCalls = 0;
  evaluationCalls = 0;
  slackCalls = 0;
}

function importRequest(authorization?: string) {
  return new Request("http://localhost/api/import-deals?ref=abc123", {
    method: "POST",
    headers: authorization ? { authorization } : undefined,
  });
}

function assertNoImportSideEffects() {
  assert.equal(feedFetchCalls, 0);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.equal(evaluationCalls, 0);
  assert.equal(slackCalls, 0);
}

test("rejects missing and invalid bearer credentials before import side effects", async (t) => {
  for (const [description, authorization] of [
    ["missing credentials", undefined],
    ["invalid credentials", "Bearer invalid-ingest-key"],
  ] as const) {
    await t.test(description, async () => {
      reset();
      globalThis.fetch = async () => {
        feedFetchCalls += 1;
        return Response.json({});
      };

      const response = await POST(importRequest(authorization));

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        success: false,
        error: "Unauthorized.",
      });
      assertNoImportSideEffects();
    });
  }
});

test("preserves the import flow for a valid bearer credential", async () => {
  reset();
  globalThis.fetch = async () => {
    feedFetchCalls += 1;

    const products = feedFetchCalls === 1
      ? [{
          url: "https://example.com/test-shoe",
          title: "Test shoe",
          current_price: 1200,
          currency: "DKK",
          checked_at: "2026-08-30T12:00:00.000Z",
        }]
      : [];

    return Response.json({
      site: "example.com",
      checked_at: "2026-08-30T12:00:00.000Z",
      products,
    });
  };

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(feedFetchCalls, 3);
  assert.equal(neonCalls, 1);
  assert.equal(persistenceCalls, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(slackCalls, 1);
  assert.deepEqual(await response.json(), {
    success: true,
    ref: "abc123",
    sources: 3,
    productsProcessed: 1,
    productsInserted: 1,
    productsUpdated: 0,
    snapshotsInserted: 1,
    productsEvaluated: 1,
  });
});
