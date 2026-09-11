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
let persistedQueries: Array<{ text: string; values: unknown[] }> = [];
let transactionResultFactory: ((query: {
  text: string;
  values: unknown[];
}) => Record<string, unknown>) | null = null;

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    neonCalls += 1;
    const sql = (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const query = { text: strings.join(" "), values };
      persistedQueries.push(query);
      return Object.assign(query, {
        then: (resolve: (rows: Array<Record<string, unknown>>) => unknown) =>
          resolve([
            {
              productId: "42",
              watched: false,
              feedback: null,
              preferenceScore: 8,
              dealScore: 7,
            },
          ]),
      });
    };

    return Object.assign(
      sql,
      {
        transaction: async (queries: Array<{
          text: string;
          values: unknown[];
        }>) => {
          persistenceCalls += 1;
          return queries.map((query) => [
            transactionResultFactory?.(query) ?? {
              productId: "42",
              externalUrl: "https://example.com/test-shoe",
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
            },
          ]);
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
  persistedQueries = [];
  transactionResultFactory = null;
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
  const requestedFeedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    feedFetchCalls += 1;
    const url = String(input);
    requestedFeedUrls.push(url);

    const sourceProduct = {
      url: `https://example.com/test-shoe-${feedFetchCalls}`,
      title: "Test shoe",
      currency: "DKK",
      target_size: "42",
      category: "source-specific-category",
      brand: "Test brand",
      checked_at: "2026-08-30T12:00:00.000Z",
      ...(url.includes("vinted-latest.json")
        ? { price: 120 }
        : { current_price: 1200 }),
    };

    return Response.json({
      site: "example.com",
      checked_at: "2026-08-30T12:00:00.000Z",
      products: [sourceProduct],
    });
  };

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(feedFetchCalls, 2);
  assert.deepEqual(requestedFeedUrls.sort(), [
    "https://raw.githubusercontent.com/runethorbek/deals/abc123/public/deals/vinted-latest.json",
    "https://raw.githubusercontent.com/runethorbek/deals/abc123/public/deals/zalando-latest.json",
  ]);
  assert.equal(neonCalls, 1);
  assert.equal(persistenceCalls, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(slackCalls, 1);
  assert.equal(persistedQueries.length, 3);

  for (const query of persistedQueries.filter((query) =>
    query.text.includes("INSERT INTO products"),
  )) {
    assert.doesNotMatch(query.text, /target_size|category/i);
    assert.match(query.text, /brand/i);
    assert.match(query.text, /RETURNING\s+id,\s+external_url,/);

    const rawData = query.values.find(
      (value) =>
        typeof value === "string" &&
        value.includes("source-specific-category"),
    );
    assert.deepEqual(JSON.parse(rawData as string).target_size, "42");
    assert.deepEqual(
      JSON.parse(rawData as string).category,
      "source-specific-category",
    );
  }

  assert.deepEqual(await response.json(), {
    success: true,
    ref: "abc123",
    sources: 2,
    productsProcessed: 2,
    productsInserted: 2,
    productsUpdated: 0,
    snapshotsInserted: 2,
    productsEvaluated: 1,
  });
});

test("skips malformed and non-HTTPS retailer URLs before persistence", async () => {
  for (const retailerUrl of ["http://example.com/shoe", "not a URL"]) {
    reset();
    globalThis.fetch = async () => Response.json({
      products: [{
        url: retailerUrl,
        title: "Test shoe",
        current_price: 1200,
        currency: "DKK",
      }],
    });

    const response = await POST(importRequest("Bearer valid-ingest-key"));

    assert.equal(response.status, 200);
    assert.equal(persistenceCalls, 0);
    assert.equal((await response.json()).productsProcessed, 0);
  }
});

test("only reports import price changes and drops for matching explicit currencies", async (t) => {
  for (const [description, previousCurrency, currentCurrency, comparable] of [
    ["DKK to DKK", "DKK", "DKK", true],
    ["DKK to EUR", "DKK", "EUR", false],
    ["null to null", null, null, false],
    ["null to DKK", null, "DKK", false],
    ["DKK to null", "DKK", null, false],
  ] as const) {
    await t.test(description, async () => {
      reset();
      const importResults: Array<{
        priceChanged: boolean;
        priceDropPercent: string | null;
      }> = [];

      globalThis.fetch = async (input) => {
        feedFetchCalls += 1;
        const url = String(input);

        return Response.json({
          products: [{
            url: `https://example.com/${url.includes("vinted") ? "vinted" : "zalando"}`,
            title: "Test shoe",
            currency: currentCurrency,
            checked_at: "2026-08-30T12:00:00.000Z",
            ...(url.includes("vinted") ? { price: 120 } : { current_price: 1200 }),
          }],
        });
      };

      transactionResultFactory = (query) => {
        assert.match(
          query.text,
          /existing\.currency IS NOT NULL\s+AND upserted\.currency IS NOT NULL\s+AND existing\.currency = upserted\.currency/,
        );

        const currentPrice = query.values.find(
          (value): value is number => typeof value === "number",
        )!;
        const currency = query.values.find(
          (value) => value === currentCurrency) as string | null;
        const currenciesMatch =
          previousCurrency !== null &&
          currency !== null &&
          previousCurrency === currency;
        const priceChanged = currenciesMatch && currentPrice !== 1_000;
        const priceDropPercent =
          currenciesMatch && currentPrice < 1_000
            ? String(((1_000 - currentPrice) / 1_000) * 100)
            : null;

        importResults.push({ priceChanged, priceDropPercent });

        return {
          productId: "42",
          externalUrl: "https://example.com/test-shoe",
          title: "Test shoe",
          currentPrice: String(currentPrice),
          currency,
          sourceCurrentPrice: null,
          sourceCurrency: null,
          hidden: false,
          inserted: false,
          snapshotId: "snapshot-42",
          priceChanged,
          priceDropPercent,
          discountPercent: null,
        };
      };

      const response = await POST(importRequest("Bearer valid-ingest-key"));

      assert.equal(response.status, 200);
      assert.equal(importResults.length, 2);

      if (comparable) {
        for (const result of importResults) {
          assert.equal(result.priceChanged, true);
        }
        assert.ok(
          importResults.some((result) => result.priceDropPercent !== null),
        );
      } else {
        for (const result of importResults) {
          assert.equal(result.priceChanged, false);
          assert.equal(result.priceDropPercent, null);
        }
      }
    });
  }
});

test("fails when a required active feed is unavailable", async (t) => {
  for (const fileName of ["zalando-latest.json", "vinted-latest.json"]) {
    await t.test(fileName, async () => {
      reset();
      globalThis.fetch = async (input) => {
        feedFetchCalls += 1;
        return String(input).includes(fileName)
          ? new Response(null, { status: 404 })
          : Response.json({ products: [] });
      };

      const response = await POST(importRequest("Bearer valid-ingest-key"));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        success: false,
        ref: "abc123",
        error: `${fileName === "zalando-latest.json" ? "Zalando" : "Vinted"} feed returned HTTP 404.`,
      });
      assert.equal(neonCalls, 0);
      assert.equal(persistenceCalls, 0);
      assert.equal(slackCalls, 0);
    });
  }
});
