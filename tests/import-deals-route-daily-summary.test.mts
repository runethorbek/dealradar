import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

// Route-level daily summary trigger (#80, design D13): the no-candidate path
// sends the daily summary after the legacy message and never fails the
// import because of it; the evaluation path stores the summary date with the
// run instead.

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalIngestApiKey = process.env.INGEST_API_KEY;
const originalFetch = globalThis.fetch;

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

type SlackDelivery = { message: string; clientMessageId: string | undefined };

let productsInserted = false;
let summaryRow: { status: "pending" | "sent"; content: unknown } | null = null;
let activeMonitors: Array<Record<string, unknown>> = [];
let summaryQueriesFail = false;
let slackDeliveries: SlackDelivery[] = [];
let summarySlackFails = false;
let evaluationRunInputs: Array<Record<string, unknown>> = [];

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

function rowsFor(text: string, values: unknown[]) {
  if (text.includes("SELECT vinted, gemini")) return [{}];
  if (text.includes("SELECT status FROM daily_summaries")) return summaryRow ? [{ status: summaryRow.status }] : [];
  if (text.includes("SELECT 1 AS \"active\" FROM monitor_definitions")) return activeMonitors.length > 0 ? [{ active: 1 }] : [];
  if (text.includes("FROM monitor_definitions m")) return activeMonitors;
  if (text.includes("INSERT INTO daily_summaries")) {
    summaryRow ??= { status: "pending", content: JSON.parse(values[1] as string) };
    return [];
  }
  if (text.includes("SET claimed_at = NOW()")) {
    return summaryRow?.status === "pending"
      ? [{ content: summaryRow.content, clientMessageId: "daily-client-id", claimToken: "token" }]
      : [];
  }
  if (text.includes("SET status = 'sent'")) {
    summaryRow!.status = "sent";
    return [{ summary_date: values[0] }];
  }
  return [];
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(" ");
      return {
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
          summaryQueriesFail && text.includes("daily_summaries")
            ? reject(new Error("relation \"daily_summaries\" does not exist"))
            : resolve(rowsFor(text, values)),
      };
    };

    return Object.assign(sql, {
      transaction: async (queries: Array<{ then: unknown }>) => queries.map(() => [{
        productId: "42",
        source: "zalando.dk",
        externalUrl: "https://www.zalando.dk/items/test-shoe",
        title: "Test shoe",
        currentPrice: "1200",
        currency: "DKK",
        sourceCurrentPrice: null,
        sourceCurrency: null,
        hidden: false,
        inserted: productsInserted,
        snapshotId: null,
        priceChanged: false,
        priceDropPercent: null,
        discountPercent: "20",
      }]),
    });
  },
});
mockModule("@/lib/slack", {
  postSlackMessage: async (message: string, clientMessageId?: string) => {
    slackDeliveries.push({ message, clientMessageId });
    return summarySlackFails && message.startsWith("*DealRadar daily summary")
      ? { success: false, error: "unavailable" }
      : { success: true };
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
const { getCopenhagenDate } = await import("../lib/daily-summary.mts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;

  if (originalIngestApiKey === undefined) delete process.env.INGEST_API_KEY;
  else process.env.INGEST_API_KEY = originalIngestApiKey;

  globalThis.fetch = originalFetch;
});

const feeds = {
  zalando: {
    site: "zalando.dk",
    product_count: 1,
    products: [{ url: "https://www.zalando.dk/items/test-shoe", title: "Test shoe", current_price: 1200, currency: "DKK" }],
  },
  vinted: { site: "vinted.com", product_count: 0, products: [] },
};

const activeMonitor = {
  monitorId: "zalando-scarosso-shoes-42",
  monitorSource: "zalando.dk",
  displayName: "Zalando – Scarosso shoes",
  strategy: "discount_threshold",
  minimumDiscountPercent: "20.00",
  minimumOverallScore: null,
  lastScanCheckedAt: new Date().toISOString(),
  productId: null,
};

async function runImport() {
  slackDeliveries = [];
  evaluationRunInputs = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/public/deals/zalando-latest.json")) return Response.json(feeds.zalando);
    if (url.endsWith("/public/deals/vinted-latest.json")) return Response.json(feeds.vinted);
    return new Response(null, { status: 404 });
  };

  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  console.info = () => {};

  try {
    const response = await POST(new Request("http://localhost/api/import-deals?ref=abc123", {
      method: "POST",
      headers: { authorization: "Bearer valid-ingest-key" },
    }));

    return { status: response.status, body: await response.json(), warnings };
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
}

function reset() {
  productsInserted = false;
  summaryRow = null;
  activeMonitors = [activeMonitor];
  summaryQueriesFail = false;
  summarySlackFails = false;
}

test("the no-candidate path sends the daily summary after the legacy message", async () => {
  reset();
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.evaluationRunId, null);
  assert.equal(slackDeliveries.length, 2);
  assert.match(slackDeliveries[0]!.message, /^DealRadar updated: /, "the legacy message comes first");
  assert.equal(slackDeliveries[0]!.clientMessageId, undefined, "the legacy message is unchanged");
  assert.match(slackDeliveries[1]!.message, new RegExp(`^\\*DealRadar daily summary · ${getCopenhagenDate(new Date())}\\*\\n\\n\\*Zalando – Scarosso shoes\\*`));
  assert.equal(slackDeliveries[1]!.clientMessageId, "daily-client-id");
  assert.deepEqual(result.warnings, []);

  // A later import on the same date sends nothing more.
  const repeated = await runImport();
  assert.equal(repeated.status, 200);
  assert.equal(slackDeliveries.length, 1);
  assert.match(slackDeliveries[0]!.message, /^DealRadar updated: /);
});

test("a later import on the same date retries an unsent summary", async () => {
  reset();
  summarySlackFails = true;
  const failed = await runImport();

  assert.equal(failed.status, 200, "a summary failure never fails the import");
  assert.equal(failed.body.success, true);
  assert.ok(failed.warnings.some((warning) => /daily notifications failed/.test(warning)));
  assert.equal(summaryRow?.status, "pending");

  summarySlackFails = false;
  const retried = await runImport();
  assert.equal(retried.status, 200);
  assert.equal(slackDeliveries.length, 2);
  assert.equal(slackDeliveries[1]!.message, (summaryRow!.content as { text: string }).text);
  assert.equal(summaryRow?.status, "sent");
});

test("a daily summary database failure is logged and does not fail the import", async () => {
  reset();
  summaryQueriesFail = true;
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(slackDeliveries.length, 1, "only the legacy message");
  assert.ok(result.warnings.some((warning) => /daily notifications failed/.test(warning)));
});

test("no daily summary is produced without an active monitor", async () => {
  reset();
  activeMonitors = [];
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(slackDeliveries.length, 1);
  assert.equal(summaryRow, null);
});

test("the evaluation path stores the import's summary date with the run and sends no summary itself", async () => {
  reset();
  productsInserted = true;
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.evaluationRunId, "durable-run-1");
  assert.equal(slackDeliveries.length, 0);
  const importContext = evaluationRunInputs[0]!.importContext as Record<string, unknown>;
  assert.equal(importContext.summaryDate, getCopenhagenDate(new Date()));
  assert.equal(importContext.monitorDefinitionsWarning, null, "a 404 document is not a warning");
});
