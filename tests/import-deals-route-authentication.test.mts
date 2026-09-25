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
let workflowStarts = 0;
let evaluationRunsCreated = 0;
let persistedQueries: Array<{ text: string; values: unknown[] }> = [];
let transactionResultFactory: ((query: {
  text: string;
  values: unknown[];
}) => Record<string, unknown>) | null = null;
let storedGeminiSettings: unknown;
let storedRankingSettings: unknown;
let snapshotHistoryRows: Record<string, unknown>[] = [];
let snapshotHistoryFails = false;
let watchedHistoricalLowRows: Record<string, unknown>[] = [];
let evaluationRunInputs: Array<Record<string, unknown>> = [];
const slackMessages: string[] = [];

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
        then: (resolve: (rows: Array<Record<string, unknown>>) => unknown, reject: (error: unknown) => unknown) =>
          snapshotHistoryFails && query.text.includes("FROM product_snapshots")
            ? reject(new Error("connection reset"))
            : resolve(query.text.includes("SELECT vinted, gemini")
            ? [{ vinted: undefined, gemini: storedGeminiSettings, ranking: storedRankingSettings }]
            : query.text.includes("FROM product_snapshots")
              ? snapshotHistoryRows
              : query.text.includes("p.external_url")
                ? watchedHistoricalLowRows
                : []),
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
  postSlackMessage: async (message: string) => {
    slackCalls += 1;
    slackMessages.push(message);
    return { success: true };
  },
});
mockModule("@/lib/evaluation-runs.mts", {
  createEvaluationRun: async (_sql: unknown, input: { importRef: string; candidateProductIds: string[] }) => {
    evaluationRunsCreated += 1;
    evaluationRunInputs.push(input);
    return ({
    id: "durable-run-7", importRef: input.importRef, status: "pending", startedAt: null, completedAt: null,
    notificationSent: false, createdAt: "2026-09-15T00:00:00.000Z", candidatesSelected: input.candidateProductIds.length,
    evaluationsCompleted: 0, evaluationsFailed: 0, pendingCandidates: input.candidateProductIds.length, batchesProcessed: 0,
    });
  },
});
mockModule("@/workflows/evaluation-run-orchestration", {
  startEvaluationRunWorkflow: async () => { workflowStarts += 1; return { id: "workflow-run" }; },
  resumePendingEvaluationRunWorkflows: async () => [],
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
  workflowStarts = 0;
  evaluationRunsCreated = 0;
  persistedQueries = [];
  transactionResultFactory = null;
  storedGeminiSettings = undefined;
  storedRankingSettings = undefined;
  snapshotHistoryRows = [];
  snapshotHistoryFails = false;
  watchedHistoricalLowRows = [];
  evaluationRunInputs = [];
  slackMessages.length = 0;
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
  assert.equal(evaluationCalls, 0);
  assert.equal(workflowStarts, 1);
  assert.equal(slackCalls, 0);
  assert.equal(persistedQueries.length, 3);

  for (const query of persistedQueries.filter((query) =>
    query.text.includes("INSERT INTO products"),
  )) {
    assert.doesNotMatch(query.text, /target_size|category/i);
    assert.match(query.text, /brand/i);
    assert.match(query.text, /RETURNING\s+id,\s+source,\s+external_url,/);

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
    productsEvaluated: 0,
    evaluationRunId: "durable-run-7",
    productsSkippedInvalidPrice: 0,
    evaluationMetrics: {
      candidatesSelected: 1,
      requestsAttempted: 0,
      successfulEvaluations: 0,
      failedEvaluations: 0,
      retryAttempts: 0,
      retryableFailures: 0,
      rateLimitFailures: 0,
      quotaFailures: 0,
      permanentFailures: 0,
      exhaustedRetries: 0,
    },
    preselectionMetrics: {
      initialCandidates: 1,
      excludedByCondition: 0,
      excludedByBrand: 0,
      eligibleCandidates: 1,
      candidatesSelected: 1,
    },
  });
});

test("uses the persisted Gemini automatic evaluation limit during import candidate selection", async () => {
  reset();
  storedGeminiSettings = { automaticEvaluationLimit: 10 };
  let productNumber = 0;
  transactionResultFactory = () => {
    productNumber += 1;
    return {
      productId: String(productNumber),
      externalUrl: `https://example.com/test-shoe-${productNumber}`,
      title: `Test shoe ${productNumber}`,
      currentPrice: "1200",
      currency: "DKK",
      sourceCurrentPrice: null,
      sourceCurrency: null,
      hidden: false,
      inserted: true,
      snapshotId: `snapshot-${productNumber}`,
      priceChanged: false,
      priceDropPercent: null,
      discountPercent: "20",
    };
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    const source = sourceForUrl(url);
    return Response.json(validFeed(url, Array.from({ length: 6 }, (_, index) => ({
      url: `https://${source.domain}/items/test-shoe-${index}`,
      title: `Test shoe ${index}`,
      currency: "DKK",
      [source.priceField]: 1200,
    }))));
  };

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(evaluationCalls, 0);
  assert.equal(workflowStarts, 1);
  const body = await response.json();
  assert.equal(body.productsEvaluated, 0);
  assert.equal(body.preselectionMetrics.candidatesSelected, 10);
});

test("zero-candidate imports send one direct summary without durable work", async () => {
  reset();
  transactionResultFactory = () => ({
    productId: "42", externalUrl: "https://example.com/existing", title: "Existing", currentPrice: "1200", currency: "DKK",
    sourceCurrentPrice: null, sourceCurrency: null, hidden: false, inserted: false, snapshotId: "snapshot-42",
    priceChanged: false, priceDropPercent: null, discountPercent: null,
  });
  globalThis.fetch = async (input) => Response.json(validFeed(String(input)));
  const response = await POST(importRequest("Bearer valid-ingest-key"));
  assert.equal(response.status, 200);
  assert.equal(evaluationRunsCreated, 0);
  assert.equal(workflowStarts, 0);
  assert.equal(slackCalls, 1);
  const body = await response.json();
  assert.equal(body.evaluationRunId, null);
  assert.equal(body.productsEvaluated, 0);
});

function twoProductZeroCandidateSetup() {
  const productAUrl = "https://www.zalando.dk/items/product-a";
  const productBUrl = "https://www.zalando.dk/items/product-b";

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("zalando-latest.json")) {
      return Response.json(validFeed(url, [
        { url: productAUrl, title: "Product A", currency: "DKK", current_price: 1200 },
        { url: productBUrl, title: "Product B", currency: "DKK", current_price: 1200 },
      ]));
    }

    return Response.json(validFeed(url));
  };

  transactionResultFactory = (query) => {
    const isProductA = query.values.includes(productAUrl);

    return {
      productId: isProductA ? "product-a" : "product-b",
      source: "zalando.dk",
      externalUrl: isProductA ? productAUrl : productBUrl,
      title: isProductA ? "Product A" : "Product B",
      currentPrice: "1200",
      currency: "DKK",
      sourceCurrentPrice: null,
      sourceCurrency: null,
      hidden: false,
      inserted: false,
      snapshotId: isProductA ? "snapshot-a" : "snapshot-b",
      priceChanged: false,
      priceDropPercent: "20",
      discountPercent: null,
    };
  };
}

test("zero-candidate imports have no Zalando fallback recommendation, even for large price drops", async () => {
  reset();
  twoProductZeroCandidateSetup();

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(evaluationRunsCreated, 0);
  assert.equal(slackMessages.length, 1);
  assert.doesNotMatch(slackMessages[0]!, /recommendation:/);
  // No Like / Watch price-drop state is loaded: the Zalando fallback (#60)
  // only uses products evaluated in this import.
  assert.equal(persistedQueries.some((query) => query.text.includes("product_feedback")), false);
});

test("zero-candidate imports never recommend Vinted, even for a Watched price drop", async () => {
  reset();
  transactionResultFactory = () => ({
    productId: "vinted-watched", source: "vinted.com", externalUrl: "https://www.vinted.dk/items/watched", title: "Watched Vinted",
    currentPrice: "1000", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null, hidden: false, inserted: false,
    snapshotId: "snapshot-vinted", priceChanged: false, priceDropPercent: "30", discountPercent: null,
  });
  globalThis.fetch = async (input) => Response.json(validFeed(String(input)));

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(evaluationRunsCreated, 0);
  assert.equal(slackMessages.length, 1);
  assert.doesNotMatch(slackMessages[0]!, /recommendation:/);
});

function watchedHistoricalLowSetup(inserted: boolean) {
  const watchedUrl = "https://www.zalando.dk/items/watched";
  const otherUrl = "https://www.zalando.dk/items/other";

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("zalando-latest.json")) {
      return Response.json(validFeed(url, [
        { url: watchedUrl, title: "Watched shoe", currency: "DKK", current_price: 500 },
        { url: otherUrl, title: "Other shoe", currency: "DKK", current_price: 500 },
      ]));
    }

    return Response.json(validFeed(url, []));
  };

  transactionResultFactory = (query) => {
    const isWatched = query.values.includes(watchedUrl);

    return {
      productId: isWatched ? "5" : "6", source: "zalando.dk", externalUrl: isWatched ? watchedUrl : otherUrl,
      title: isWatched ? "Watched shoe" : "Other shoe", currentPrice: "500", currency: "DKK",
      sourceCurrentPrice: null, sourceCurrency: null, hidden: false, inserted,
      snapshotId: isWatched ? "52" : "62", priceChanged: inserted,
      // A price drop without a watched historical-low event gives no priority.
      priceDropPercent: isWatched ? null : "40", discountPercent: null,
    };
  };
  // Watched history 500 → 600 → 500: a returning historical low.
  snapshotHistoryRows = [
    { snapshotId: "50", productId: "5", currentPrice: "500.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
    { snapshotId: "51", productId: "5", currentPrice: "600.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
    { snapshotId: "52", productId: "5", currentPrice: "500.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
  ];
  watchedHistoricalLowRows = [{
    productId: "5", externalUrl: watchedUrl, title: "Watched shoe", source: "zalando.dk", brand: null,
    currentPrice: "500.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null,
    hidden: false, watched: true, preferenceScore: null, dealScore: null,
  }];
}

test("zero-candidate imports give a watched historical-low event first Zalando priority", async () => {
  reset();
  watchedHistoricalLowSetup(false);

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(evaluationRunsCreated, 0);
  const snapshotQueries = persistedQueries.filter((query) => query.text.includes("FROM product_snapshots"));
  assert.equal(snapshotQueries.length, 1, "one snapshot-history query per import");
  assert.deepEqual(snapshotQueries[0]!.values[0], ["52", "62"]);
  assert.equal(slackMessages.length, 1);
  assert.match(slackMessages[0]!, /Zalando recommendation:\nWatched shoe\n500\.00 DKK/);
});

test("zero-candidate imports have no Zalando recommendation without an event", async () => {
  reset();
  watchedHistoricalLowSetup(false);
  // Watched history 500 → 500: remaining at the low is not an event.
  snapshotHistoryRows = snapshotHistoryRows.filter((row) => row.snapshotId !== "51");

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(persistedQueries.some((query) => query.text.includes("p.external_url")), false);
  assert.equal(slackMessages.length, 1);
  assert.doesNotMatch(slackMessages[0]!, /Zalando recommendation:/);
});

test("imports with evaluation candidates record watched historical-low events with the run", async () => {
  reset();
  watchedHistoricalLowSetup(true);

  const response = await POST(importRequest("Bearer valid-ingest-key"));

  assert.equal(response.status, 200);
  assert.equal(evaluationRunsCreated, 1);
  assert.equal(slackCalls, 0);
  const importContext = evaluationRunInputs[0]!.importContext as Record<string, unknown>;
  assert.deepEqual(importContext.watchedHistoricalLows, [{ productId: "5", dropPercent: 16.6667 }]);
});

test("a failed watched historical-low detection degrades to no event instead of failing the import", async () => {
  const warn = mock.method(console, "warn", () => {});

  try {
    reset();
    watchedHistoricalLowSetup(false);
    snapshotHistoryFails = true;

    const zeroCandidateResponse = await POST(importRequest("Bearer valid-ingest-key"));

    assert.equal(zeroCandidateResponse.status, 200);
    assert.equal(evaluationRunsCreated, 0);
    assert.equal(slackMessages.length, 1);
    assert.doesNotMatch(slackMessages[0]!, /Zalando recommendation:/);

    reset();
    watchedHistoricalLowSetup(true);
    snapshotHistoryFails = true;

    const candidateResponse = await POST(importRequest("Bearer valid-ingest-key"));

    assert.equal(candidateResponse.status, 200);
    assert.equal(evaluationRunsCreated, 1);
    const importContext = evaluationRunInputs[0]!.importContext as Record<string, unknown>;
    assert.deepEqual(importContext.watchedHistoricalLows, []);
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments),
      [["DealRadar watched historical-low detection failed."], ["DealRadar watched historical-low detection failed."]],
    );
  } finally {
    warn.mock.restore();
  }
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
