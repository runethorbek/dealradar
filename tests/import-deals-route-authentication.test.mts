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

function sourceForUrl(url: string) {
  return url.includes("vinted-latest.json")
    ? { site: "vinted.com", domain: "www.vinted.dk", priceField: "price" }
    : { site: "zalando.dk", domain: "www.zalando.dk", priceField: "current_price" };
}

function validFeed(url: string, products?: Array<Record<string, unknown>>) {
  const source = sourceForUrl(url);
  const feedProducts = products ?? [{
    url: `https://${source.domain}/items/test-shoe`,
    title: "Test shoe",
    currency: "DKK",
    [source.priceField]: 1200,
  }];

  return {
    site: source.site,
    product_count: feedProducts.length,
    checked_at: "2026-08-30T12:00:00.000Z",
    products: feedProducts,
  };
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

    const source = sourceForUrl(url);
    const sourceProduct = {
      url: `https://${source.domain}/items/test-shoe-${feedFetchCalls}`,
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
      site: source.site,
      product_count: 1,
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
    productsSkippedInvalidPrice: 0,
  });
});

test("rejects feed-level contract violations before persistence without live URL checks", async (t) => {
  const cases = [
    ["site mismatch", (url: string) => ({ ...validFeed(url), site: "wrong.example" })],
    ["malformed URL", (url: string) => validFeed(url, [{ url: "not a URL", title: "Test shoe", current_price: 1200 }])],
    ["HTTP URL", (url: string) => validFeed(url, [{ url: "http://www.zalando.dk/items/test", title: "Test shoe", current_price: 1200 }])],
    ["wrong retailer", (url: string) => validFeed(url, [{ url: "https://not-zalando.dk/items/test", title: "Test shoe", current_price: 1200 }])],
    ["duplicate URL", (url: string) => validFeed(url, [
      { url: "https://www.zalando.dk/items/test", title: "One", current_price: 1200 },
      { url: "https://www.zalando.dk/items/test", title: "Two", current_price: 1200 },
    ])],
    ["whitespace-normalized duplicate URL", (url: string) => validFeed(url, [
      { url: "https://www.zalando.dk/items/test", title: "One", current_price: 1200 },
      { url: " https://www.zalando.dk/items/test ", title: "Two", current_price: 1200 },
    ])],
    ["product count mismatch", (url: string) => ({ ...validFeed(url), product_count: 2 })],
  ] as const;

  for (const [description, feed] of cases) {
    await t.test(description, async () => {
    reset();
      globalThis.fetch = async (input) => {
        feedFetchCalls += 1;
        const url = String(input);
        return Response.json(url.includes("zalando-latest.json") ? feed(url) : validFeed(url));
      };

    const response = await POST(importRequest("Bearer valid-ingest-key"));

      assert.equal(response.status, 500);
      assert.equal(feedFetchCalls, 2);
      assert.equal(neonCalls, 0);
    assert.equal(persistenceCalls, 0);
      assert.equal(slackCalls, 0);
    });
  }
});

test("accepts matching product counts and omitted optional product_count", async (t) => {
  for (const [description, removeCount] of [["matching count", false], ["missing count", true]] as const) {
    await t.test(description, async () => {
      reset();
      globalThis.fetch = async (input) => {
        const feed = validFeed(String(input));
        const feedWithoutCount = { ...feed };
        Reflect.deleteProperty(feedWithoutCount, "product_count");
        return Response.json(removeCount ? feedWithoutCount : feed);
      };

      const response = await POST(importRequest("Bearer valid-ingest-key"));
      assert.equal(response.status, 200);
      assert.equal(persistenceCalls, 1);
    });
  }
});

test("skips only products with invalid current prices", async () => {
  reset();
  globalThis.fetch = async (input) => {
    const url = String(input);
    const source = sourceForUrl(url);
    const feed = validFeed(url, [
      { url: `https://${source.domain}/items/positive`, title: "Positive", [source.priceField]: 1200 },
      { url: `https://${source.domain}/items/zero`, title: "Zero", [source.priceField]: 0 },
      { url: `https://${source.domain}/items/negative`, title: "Negative", [source.priceField]: -1 },
      { url: `https://${source.domain}/items/non-finite`, title: "Non-finite", [source.priceField]: Number.POSITIVE_INFINITY },
      { url: `https://${source.domain}/items/unsafe`, title: "Unsafe", [source.priceField]: Number.MAX_SAFE_INTEGER + 1 },
      { url: `https://${source.domain}/items/unparsable`, title: "Unparsable", [source.priceField]: "1200 DKK" },
      { url: `https://${source.domain}/items/no-title`, [source.priceField]: -1 },
    ]);
    return { ok: true, status: 200, json: async () => feed } as Response;
  };

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.productsProcessed, 4);
  assert.equal(body.productsSkippedInvalidPrice, 10);
  assert.equal(persistenceCalls, 1);
  assert.equal(persistedQueries.filter((query) => query.text.includes("INSERT INTO products")).length, 4);
  assert.ok(persistedQueries.every((query) => !query.values.includes(-1)));
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

        const source = sourceForUrl(url);
        return Response.json({
          site: source.site,
          product_count: 1,
          products: [{
            url: `https://${source.domain}/items/test-shoe`,
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
