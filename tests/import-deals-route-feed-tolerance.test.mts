import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

// Characterizes how the import treats additive feed changes (issue #76), so
// Deals can publish new fields and documents before DealRadar consumes them.

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalIngestApiKey = process.env.INGEST_API_KEY;
const originalFetch = globalThis.fetch;
let persistedQueries: Array<{ text: string; values: unknown[] }> = [];
let productsInserted = false;
let evaluationRunInputs: Array<Record<string, unknown>> = [];
let slackMessages: string[] = [];

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = { text: strings.join(" "), values };
      persistedQueries.push(query);
      return Object.assign(query, {
        then: (resolve: (rows: Array<Record<string, unknown>>) => unknown) =>
          resolve(query.text.includes("SELECT vinted, gemini") ? [{}] : []),
      });
    };

    return Object.assign(sql, {
      transaction: async (queries: Array<{ text: string; values: unknown[] }>) =>
        queries.map((query) => {
          const externalUrl = query.values[1] as string;
          return [{
            productId: externalUrl,
            source: query.values[0],
            externalUrl,
            title: query.values[2],
            currentPrice: String(query.values[4]),
            currency: query.values[6],
            sourceCurrentPrice: null,
            sourceCurrency: null,
            hidden: false,
            inserted: productsInserted,
            snapshotId: `snapshot-${externalUrl}`,
            priceChanged: false,
            priceDropPercent: null,
            discountPercent: null,
          }];
        }),
    });
  },
});
mockModule("@/lib/slack", {
  postSlackMessage: async (message: string) => {
    slackMessages.push(message);
    return { success: true };
  },
});
mockModule("@/lib/evaluation-runs.mts", {
  createEvaluationRun: async (_sql: unknown, input: Record<string, unknown>) => {
    evaluationRunInputs.push(input);
    return { id: "durable-run-1" };
  },
});
mockModule("@/workflows/evaluation-run-orchestration", {
  startEvaluationRunWorkflow: async () => ({ id: "workflow-run" }),
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

type Feed = Record<string, unknown>;

function zalandoProduct(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://www.zalando.dk/items/test-shoe",
    title: "Test shoe",
    brand: "Test brand",
    image: "https://img.zalando.dk/test-shoe.jpg",
    current_price: 1200,
    original_price: 1500,
    currency: "DKK",
    discount_percent: 20,
    target_size: "42",
    size_42_available: true,
    checked_at: "2026-10-20T03:40:00.000Z",
    monitor_ids: ["zalando-scarosso-shoes-42"],
    ...overrides,
  };
}

function vintedProduct(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://www.vinted.dk/items/123-test-blazer",
    title: "Test blazer",
    brand: "Test brand",
    price: 150,
    currency: "DKK",
    size_guess: "S",
    checked_at: "2026-10-20T02:45:00.000Z",
    monitor_ids: ["vinted-mens-blazers-size-s"],
    ...overrides,
  };
}

function zalandoFeed(overrides: Feed = {}): Feed {
  const products = [zalandoProduct()];
  return {
    site: "zalando.dk",
    checked_at: "2026-10-20T03:40:00.000Z",
    product_count: products.length,
    monitors: [{
      id: "zalando-scarosso-shoes-42",
      source: "zalando",
      target_size: "42",
      min_discount_percent: 20,
    }],
    products,
    ...overrides,
  };
}

function vintedFeed(overrides: Feed = {}): Feed {
  const products = [vintedProduct()];
  return {
    site: "vinted.com",
    checked_at: "2026-10-20T02:45:00.000Z",
    product_count: products.length,
    monitors: [{ id: "vinted-mens-blazers-size-s", source: "vinted" }],
    products,
    ...overrides,
  };
}

const partialScanStatus = {
  attempted_pages: 3,
  successful_pages: 2,
  failed_pages: 1,
  published_product_count: 1,
  failures: [{
    name: "zalando-scarosso-shoes-42 page 3",
    url: "https://www.zalando.dk/scarosso/?p=3",
    error_summary: "HTTP 503",
  }],
};

async function runImport(
  feeds: { zalando: Feed; vinted: Feed },
  options: { ref?: string; inserted?: boolean } = {},
) {
  persistedQueries = [];
  productsInserted = options.inserted ?? false;
  evaluationRunInputs = [];
  slackMessages = [];
  const fetchedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetchedUrls.push(url);

    if (url.endsWith("/public/deals/zalando-latest.json")) return Response.json(feeds.zalando);
    if (url.endsWith("/public/deals/vinted-latest.json")) return Response.json(feeds.vinted);
    return new Response(null, { status: 404 });
  };

  const ref = options.ref ?? "abc123";
  const response = await POST(new Request(
    `http://localhost/api/import-deals?ref=${encodeURIComponent(ref)}`,
    { method: "POST", headers: { authorization: "Bearer valid-ingest-key" } },
  ));

  return {
    status: response.status,
    body: await response.json(),
    fetchedUrls,
    productQueries: persistedQueries
      .filter((query) => query.text.includes("INSERT INTO products"))
      .map(({ text, values }) => ({ text, values })),
    slackMessages: [...slackMessages],
    evaluationRunInputs: [...evaluationRunInputs],
  };
}

function isRawDataValue(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("{");
}

test("an unknown top-level feed field does not change the import or the persisted products", async () => {
  const control = await runImport({ zalando: zalandoFeed(), vinted: vintedFeed() });
  const withUnknownField = await runImport({
    zalando: zalandoFeed({ contract_hint: { monitor_recommendations: "monitor-recommendations.json" } }),
    vinted: vintedFeed({ future_top_level_field: ["additive", 1, null] }),
  });

  assert.equal(control.status, 200);
  assert.equal(withUnknownField.status, 200);
  assert.equal(control.productQueries.length, 2);
  assert.deepEqual(withUnknownField.productQueries, control.productQueries);
  assert.deepEqual(withUnknownField.body, control.body);
});

test("extra keys in monitors[] entries do not change the import or scan metadata handling", async () => {
  const plainFeeds = {
    zalando: zalandoFeed({ scan_status: partialScanStatus }),
    vinted: vintedFeed(),
  };
  const monitorsWithExtraKeys = {
    zalando: zalandoFeed({
      scan_status: partialScanStatus,
      monitors: [{
        id: "zalando-scarosso-shoes-42",
        source: "zalando",
        target_size: "42",
        min_discount_percent: 20,
        display_name: "Zalando – Scarosso shoes",
        recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20 },
      }],
    }),
    vinted: vintedFeed({
      monitors: [{
        id: "vinted-mens-blazers-size-s",
        source: "vinted",
        display_name: "Vinted – blazers",
        recommendation: { strategy: "best_match", minimum_overall_score: 7 },
      }],
    }),
  };
  const expectedScanWarnings = [{
    sourceName: "Zalando",
    successfulPages: 2,
    attemptedPages: 3,
    failedPages: 1,
    failures: [{
      name: "zalando-scarosso-shoes-42 page 3",
      url: "https://www.zalando.dk/scarosso/?p=3",
      error: "HTTP 503",
    }],
  }];

  // Zero-candidate path: the partial-scan warning is part of the Slack summary.
  const zeroCandidateControl = await runImport(plainFeeds);
  const zeroCandidateExtra = await runImport(monitorsWithExtraKeys);

  assert.equal(zeroCandidateControl.status, 200);
  assert.equal(zeroCandidateExtra.status, 200);
  assert.equal(zeroCandidateControl.slackMessages.length, 1);
  assert.match(zeroCandidateControl.slackMessages[0]!, /2\/3 pages succeeded/);
  assert.deepEqual(zeroCandidateExtra.slackMessages, zeroCandidateControl.slackMessages);
  assert.deepEqual(zeroCandidateExtra.productQueries, zeroCandidateControl.productQueries);
  assert.deepEqual(zeroCandidateExtra.body, zeroCandidateControl.body);

  // Candidate path: the partial-scan warning is recorded with the evaluation run.
  const candidateControl = await runImport(plainFeeds, { inserted: true });
  const candidateExtra = await runImport(monitorsWithExtraKeys, { inserted: true });

  assert.equal(candidateControl.status, 200);
  assert.equal(candidateExtra.status, 200);
  assert.equal(candidateControl.evaluationRunInputs.length, 1);
  const controlContext = candidateControl.evaluationRunInputs[0]!.importContext as Record<string, unknown>;
  assert.deepEqual(controlContext.scanWarnings, expectedScanWarnings);
  assert.deepEqual(candidateExtra.evaluationRunInputs, candidateControl.evaluationRunInputs);
  assert.deepEqual(candidateExtra.productQueries, candidateControl.productQueries);
  assert.deepEqual(candidateExtra.body, candidateControl.body);
});

test("an unknown product field is preserved unchanged in raw_data without affecting normalized fields", async () => {
  const unknownField = { nested: { values: [1, "two", null, true] }, note: "additive" };
  const productWithUnknownField = zalandoProduct({ future_product_field: unknownField });
  const control = await runImport({ zalando: zalandoFeed(), vinted: vintedFeed() });
  const withUnknownField = await runImport({
    zalando: zalandoFeed({ products: [productWithUnknownField] }),
    vinted: vintedFeed(),
  });

  assert.equal(control.status, 200);
  assert.equal(withUnknownField.status, 200);
  assert.deepEqual(withUnknownField.body, control.body);

  const zalandoQuery = (result: typeof control) =>
    result.productQueries.find((query) => query.values.includes(productWithUnknownField.url))!;
  const controlQuery = zalandoQuery(control);
  const unknownFieldQuery = zalandoQuery(withUnknownField);

  const rawData = unknownFieldQuery.values.filter(isRawDataValue);
  assert.equal(rawData.length, 1);
  assert.deepEqual(JSON.parse(rawData[0]!), productWithUnknownField);
  assert.deepEqual(JSON.parse(rawData[0]!).future_product_field, unknownField);

  // Every normalized column value is the same as without the unknown field.
  assert.equal(unknownFieldQuery.text, controlQuery.text);
  assert.deepEqual(
    unknownFieldQuery.values.filter((value) => !isRawDataValue(value)),
    controlQuery.values.filter((value) => !isRawDataValue(value)),
  );
  assert.deepEqual(
    withUnknownField.productQueries.filter((query) => query !== unknownFieldQuery),
    control.productQueries.filter((query) => query !== controlQuery),
  );
});

test("an import fetches only the two feed files for the requested ref", async (t) => {
  const expectedUrls = [
    "https://raw.githubusercontent.com/runethorbek/deals/feature/monitor-recs/public/deals/vinted-latest.json",
    "https://raw.githubusercontent.com/runethorbek/deals/feature/monitor-recs/public/deals/zalando-latest.json",
  ];

  for (const [description, inserted] of [
    ["zero-candidate import", false],
    ["import with evaluation candidates", true],
  ] as const) {
    await t.test(description, async () => {
      const result = await runImport(
        { zalando: zalandoFeed(), vinted: vintedFeed() },
        { ref: "feature/monitor-recs", inserted },
      );

      assert.equal(result.status, 200);
      assert.equal(result.body.ref, "feature/monitor-recs");
      assert.deepEqual([...result.fetchedUrls].sort(), expectedUrls);
      assert.ok(result.fetchedUrls.every((url) => !url.includes("monitor-recommendations")));
    });
  }
});
