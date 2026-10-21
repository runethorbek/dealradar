import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

// Route-level behavior of the optional monitor definitions document (#77,
// design D3): fetched once from the import ref, written in the product
// transaction, and never able to fail the product import.

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalIngestApiKey = process.env.INGEST_API_KEY;
const originalFetch = globalThis.fetch;

type Query = { text: string; values: unknown[] };

let persistedQueries: Query[] = [];
let transactions: Query[][] = [];
let transactionFails = false;
let definedMonitorIds: string[] = [];
let definitionLookupFails = false;
let slackMessages: string[] = [];

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

function rowsFor(text: string) {
  if (text.includes("SELECT vinted, gemini")) return [{}];
  if (text.includes("SELECT monitor_id FROM monitor_definitions")) {
    return definedMonitorIds.map((monitorId) => ({ monitor_id: monitorId }));
  }
  return [];
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = { text: strings.join(" "), values };
      persistedQueries.push(query);
      return Object.assign(query, {
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
          definitionLookupFails && query.text.includes("SELECT monitor_id FROM monitor_definitions")
            ? reject(new Error("relation does not exist"))
            : resolve(rowsFor(query.text)),
      });
    };

    return Object.assign(sql, {
      transaction: async (queries: Query[]) => {
        transactions.push(queries.map(({ text, values }) => ({ text, values })));
        if (transactionFails) throw new Error("transaction aborted");
        return queries.map((query) => query.text.includes("INSERT INTO products")
          ? [{
              productId: query.values[1],
              source: query.values[0],
              externalUrl: query.values[1],
              title: query.values[2],
              currentPrice: String(query.values[4]),
              currency: query.values[6],
              sourceCurrentPrice: null,
              sourceCurrency: null,
              hidden: false,
              inserted: false,
              snapshotId: `snapshot-${String(query.values[1])}`,
              priceChanged: false,
              priceDropPercent: null,
              discountPercent: null,
            }]
          : []);
      },
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
  createEvaluationRun: async () => ({ id: "durable-run-1" }),
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

// Copy of the published Deals document (contract v1); see
// tests/monitor-definitions.test.mts.
const publishedDocument = {
  contract_version: 1,
  monitor_count: 4,
  monitors: [
    { id: "vinted-mens-blazers-size-s", source: "vinted", display_name: "Vinted – blazers", enabled: true, recommendation: { strategy: "best_match", minimum_overall_score: 7 } },
    { id: "vinted-mens-pants-size-46", source: "vinted", display_name: "Vinted – trousers", enabled: true, recommendation: { strategy: "best_match", minimum_overall_score: 7 } },
    { id: "zalando-dk-mens-trousers-size-46", source: "zalando", display_name: "Zalando – trousers", enabled: true, recommendation: { strategy: "discount_threshold", minimum_discount_percent: 50 } },
    { id: "zalando-scarosso-shoes-42", source: "zalando", display_name: "Zalando – Scarosso shoes", enabled: true, recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20 } },
  ],
};

type Feed = Record<string, unknown>;

function zalandoFeed(overrides: Feed = {}): Feed {
  return {
    site: "zalando.dk",
    checked_at: "2026-10-20T03:40:00.000Z",
    product_count: 1,
    monitors: [{ id: "zalando-scarosso-shoes-42", source: "zalando", target_size: "42" }],
    products: [{
      url: "https://www.zalando.dk/items/test-shoe",
      title: "Test shoe",
      current_price: 1200,
      original_price: 1500,
      currency: "DKK",
      discount_percent: 20,
      checked_at: "2026-10-20T03:40:00.000Z",
      monitor_ids: ["zalando-scarosso-shoes-42", "zalando-undefined-monitor"],
    }],
    ...overrides,
  };
}

function vintedFeed(overrides: Feed = {}): Feed {
  return {
    site: "vinted.com",
    checked_at: "2026-10-20T02:45:00.000Z",
    product_count: 1,
    monitors: [{ id: "vinted-mens-blazers-size-s", source: "vinted" }],
    products: [{
      url: "https://www.vinted.dk/items/123-test-blazer",
      title: "Test blazer",
      price: 150,
      currency: "DKK",
      checked_at: "2026-10-20T02:45:00.000Z",
      monitor_ids: ["vinted-mens-blazers-size-s"],
    }],
    ...overrides,
  };
}

type DocumentResponse = () => Promise<Response>;

const documentPath = "/public/deals/monitor-recommendations.json";

async function runImport(options: {
  document: DocumentResponse;
  feeds?: { zalando: Feed; vinted: Feed };
  ref?: string;
}) {
  persistedQueries = [];
  transactions = [];
  slackMessages = [];
  const fetchedUrls: string[] = [];
  const feeds = options.feeds ?? { zalando: zalandoFeed(), vinted: vintedFeed() };
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetchedUrls.push(url);

    if (url.endsWith("/public/deals/zalando-latest.json")) return Response.json(feeds.zalando);
    if (url.endsWith("/public/deals/vinted-latest.json")) return Response.json(feeds.vinted);
    if (url.endsWith(documentPath)) return options.document();
    return new Response(null, { status: 404 });
  };

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  const originalError = console.error;
  console.error = () => {};

  try {
    const ref = options.ref ?? "abc123";
    const response = await POST(new Request(
      `http://localhost/api/import-deals?ref=${encodeURIComponent(ref)}`,
      { method: "POST", headers: { authorization: "Bearer valid-ingest-key" } },
    ));
    const [transaction = []] = transactions;

    return {
      status: response.status,
      body: await response.json(),
      fetchedUrls,
      warnings,
      transactionCount: transactions.length,
      productQueries: transaction.filter((query) => query.text.includes("INSERT INTO products")),
      definitionUpserts: transaction.filter((query) => query.text.includes("INSERT INTO monitor_definitions")),
      definitionRemovals: transaction.filter((query) => query.text.includes("SET removed_at")),
      evidenceUpdates: transaction.filter((query) => query.text.includes("GREATEST(last_scan_checked_at")),
      transaction,
      slackMessages: [...slackMessages],
    };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

const notFound: DocumentResponse = async () => new Response("404: Not Found", { status: 404 });
const published: DocumentResponse = async () => Response.json(publishedDocument);

function resetDatabase() {
  transactionFails = false;
  definedMonitorIds = [];
  definitionLookupFails = false;
}

function assertProductsImported(result: Awaited<ReturnType<typeof runImport>>) {
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.productsProcessed, 2);
  assert.equal(result.productQueries.length, 2);
  assert.equal(result.transactionCount, 1);
}

function assertDefinitionsUnchanged(result: Awaited<ReturnType<typeof runImport>>) {
  assert.equal(result.definitionUpserts.length, 0);
  assert.equal(result.definitionRemovals.length, 0);
  assert.ok(result.transaction.every((query) =>
    !/monitor_definitions/.test(query.text) || /GREATEST\(last_scan_checked_at/.test(query.text)));
}

test("fetches the document once from the same exact ref as the feeds", async () => {
  resetDatabase();
  const result = await runImport({ document: published, ref: "0123456789abcdef0123456789abcdef01234567" });

  assertProductsImported(result);
  assert.deepEqual([...result.fetchedUrls].sort(), [
    "https://raw.githubusercontent.com/runethorbek/deals/0123456789abcdef0123456789abcdef01234567/public/deals/monitor-recommendations.json",
    "https://raw.githubusercontent.com/runethorbek/deals/0123456789abcdef0123456789abcdef01234567/public/deals/vinted-latest.json",
    "https://raw.githubusercontent.com/runethorbek/deals/0123456789abcdef0123456789abcdef01234567/public/deals/zalando-latest.json",
  ]);
});

test("does not fetch the document when a feed is invalid and the import fails", async () => {
  resetDatabase();
  const result = await runImport({
    document: published,
    feeds: { zalando: zalandoFeed({ site: "wrong.example" }), vinted: vintedFeed() },
  });

  assert.equal(result.status, 500);
  assert.equal(result.transactionCount, 0);
  assert.ok(result.fetchedUrls.every((url) => !url.endsWith(documentPath)));
});

test("D3: a 404 leaves definitions unchanged without a warning", async () => {
  resetDatabase();
  const result = await runImport({ document: notFound });

  assertProductsImported(result);
  assertDefinitionsUnchanged(result);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.body.monitorDefinitions, {
    status: "not_published",
    monitorsApplied: 0,
    warning: null,
    productMonitorIdsWithoutDefinition: 3,
  });
});

test("D3: other fetch failures leave definitions unchanged with a warning", async (t) => {
  for (const [description, document] of [
    ["HTTP 503", async () => new Response("unavailable", { status: 503 })],
    ["network error", async () => { throw new TypeError("fetch failed"); }],
  ] as const) {
    await t.test(description, async () => {
      resetDatabase();
      const result = await runImport({ document });

      assertProductsImported(result);
      assertDefinitionsUnchanged(result);
      assert.equal(result.body.monitorDefinitions.status, "unavailable");
      assert.equal(typeof result.body.monitorDefinitions.warning, "string");
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0]!, /monitor definitions unavailable/);
    });
  }
});

test("D3: an unknown contract_version is ignored with a warning", async () => {
  resetDatabase();
  const result = await runImport({ document: async () => Response.json({ ...publishedDocument, contract_version: 2 }) });

  assertProductsImported(result);
  assertDefinitionsUnchanged(result);
  assert.equal(result.body.monitorDefinitions.status, "unsupported_version");
  assert.match(result.body.monitorDefinitions.warning, /contract_version 2/);
  assert.equal(result.warnings.length, 1);
});

test("D3: an invalid document is rejected as a whole and writes no partial set", async (t) => {
  for (const [description, document] of [
    ["malformed JSON", async () => new Response("{\"contract_version\":1,", { status: 200 })],
    ["monitor_count mismatch", async () => Response.json({ ...publishedDocument, monitor_count: 3 })],
    ["duplicate ID", async () => Response.json({
      ...publishedDocument,
      monitor_count: 5,
      monitors: [...publishedDocument.monitors, publishedDocument.monitors[0]],
    })],
    ["invalid definition", async () => Response.json({
      ...publishedDocument,
      monitors: publishedDocument.monitors.map((monitor, index) => index === 3
        ? { ...monitor, recommendation: { strategy: "discount_threshold", minimum_discount_percent: 150 } }
        : monitor),
    })],
  ] as const) {
    await t.test(description, async () => {
      resetDatabase();
      const result = await runImport({ document });

      assertProductsImported(result);
      assertDefinitionsUnchanged(result);
      assert.equal(result.body.monitorDefinitions.status, "rejected");
      assert.equal(result.body.monitorDefinitions.monitorsApplied, 0);
      assert.equal(typeof result.body.monitorDefinitions.warning, "string");
      assert.equal(result.warnings.length, 1);
    });
  }
});

test("a valid document is written in the same transaction as products, after them", async () => {
  resetDatabase();
  definedMonitorIds = publishedDocument.monitors.map((monitor) => monitor.id);
  const result = await runImport({ document: published, ref: "def456" });

  assertProductsImported(result);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.definitionRemovals.length, 1);
  assert.deepEqual(result.definitionUpserts.map((query) => [query.values[0], query.values[1], query.values[9]]), [
    ["vinted-mens-blazers-size-s", "vinted.com", "def456"],
    ["vinted-mens-pants-size-46", "vinted.com", "def456"],
    ["zalando-dk-mens-trousers-size-46", "zalando.dk", "def456"],
    ["zalando-scarosso-shoes-42", "zalando.dk", "def456"],
  ]);
  assert.deepEqual(
    result.transaction.map((query) =>
      query.text.includes("INSERT INTO products") ? "product"
        : query.text.includes("GREATEST(last_scan_checked_at") ? "evidence"
          : query.text.includes("INSERT INTO monitor_definitions") ? "upsert"
            : "removal"),
    ["product", "product", "removal", "upsert", "upsert", "upsert", "upsert", "evidence", "evidence"],
  );
  assert.deepEqual(result.body.monitorDefinitions, {
    status: "applied",
    monitorsApplied: 4,
    warning: null,
    productMonitorIdsWithoutDefinition: 1,
  });
});

test("scan evidence is written from feed monitors[] and checked_at with the import ref", async () => {
  resetDatabase();
  const result = await runImport({ document: notFound, ref: "def456" });

  assertProductsImported(result);
  assert.deepEqual(
    result.evidenceUpdates.map((query) => query.values),
    [
      ["2026-10-20T03:40:00.000Z", "def456", "2026-10-20T03:40:00.000Z", "zalando-scarosso-shoes-42", "zalando.dk"],
      ["2026-10-20T02:45:00.000Z", "def456", "2026-10-20T02:45:00.000Z", "vinted-mens-blazers-size-s", "vinted.com"],
    ],
  );
});

test("an unparsable feed checked_at is ignored for scan evidence without failing the import", async () => {
  resetDatabase();
  const result = await runImport({
    document: published,
    feeds: { zalando: zalandoFeed({ checked_at: "yesterday-ish" }), vinted: vintedFeed({ monitors: "not-an-array" }) },
  });

  assertProductsImported(result);
  assert.equal(result.evidenceUpdates.length, 0);
  assert.equal(result.definitionUpserts.length, 4);
});

test("definitions roll back with products: a failed transaction fails the import", async () => {
  resetDatabase();
  transactionFails = true;
  const result = await runImport({ document: published });

  assert.equal(result.status, 500);
  assert.equal(result.body.success, false);
  assert.equal(result.transactionCount, 1);
  assert.equal(result.definitionUpserts.length, 4);
  assert.equal(result.productQueries.length, 2);
});

test("a failed definition lookup leaves the diagnostic count unknown without failing the import", async () => {
  resetDatabase();
  definitionLookupFails = true;
  const result = await runImport({ document: published });

  assertProductsImported(result);
  assert.equal(result.body.monitorDefinitions.productMonitorIdsWithoutDefinition, null);
});

test("monitor definitions do not change the Slack message", async () => {
  resetDatabase();
  const withoutDocument = await runImport({ document: notFound });
  const withDocument = await runImport({ document: published });
  const rejectedDocument = await runImport({ document: async () => Response.json({ ...publishedDocument, monitor_count: 1 }) });

  assert.equal(withoutDocument.slackMessages.length, 1);
  assert.deepEqual(withDocument.slackMessages, withoutDocument.slackMessages);
  assert.deepEqual(rejectedDocument.slackMessages, withoutDocument.slackMessages);
  assert.doesNotMatch(withDocument.slackMessages[0]!, /monitor/i);
});
