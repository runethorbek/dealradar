import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

// Route-level Watched alerts (#81, design D12/D13): detected from the
// snapshots this import inserted, suppressed by a watched historical-low event
// for the same product and observation (P4(ii)), delivered right after
// detection, and never failing the import.

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalIngestApiKey = process.env.INGEST_API_KEY;
const originalFetch = globalThis.fetch;

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

type Delivery = { message: string; clientMessageId: string | undefined };
type StoredAlert = Record<string, unknown> & { status: string; claimToken: string | null };

const watchedUrl = "https://www.zalando.dk/items/watched-shoe";
let snapshotInserted = true;
let historicalLowHistory = false;
let detectionFails = false;
let alertSlackFails = false;
let storedAlerts: StoredAlert[] = [];
let alertInserts = 0;
let slackDeliveries: Delivery[] = [];

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

// Watched shoe in a 20% discount_threshold monitor: 15% → 25% (a crossing).
const alertHistory = [
  { snapshotId: "50", productId: "5", source: "zalando.dk", monitors: [{ monitorId: "zalando-shoes", thresholdPercent: "20.00" }], currentPrice: "600.00", currency: "DKK", discountPercent: "15.00" },
  { snapshotId: "51", productId: "5", source: "zalando.dk", monitors: [{ monitorId: "zalando-shoes", thresholdPercent: "20.00" }], currentPrice: "450.00", currency: "DKK", discountPercent: "25.00" },
];

function rowsFor(text: string, values: unknown[]) {
  if (text.includes("SELECT vinted, gemini")) return [{}];
  // Watched historical-low snapshot history.
  if (text.includes("SELECT DISTINCT s.product_id")) {
    return historicalLowHistory
      ? [
          { snapshotId: "50", productId: "5", currentPrice: "600.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
          { snapshotId: "51", productId: "5", currentPrice: "450.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
        ]
      : [];
  }
  if (text.includes("p.external_url")) {
    return [{
      productId: "5", externalUrl: watchedUrl, title: "Watched shoe", source: "zalando.dk", brand: null,
      currentPrice: "450.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null,
      hidden: false, watched: true, preferenceScore: null, dealScore: null,
    }];
  }
  // Watched alert detection.
  if (text.includes("jsonb_agg(")) return alertHistory;
  if (text.includes("INSERT INTO watched_alerts")) {
    alertInserts += 1;
    for (const row of JSON.parse(values[0] as string) as Array<Record<string, unknown>>) {
      if (storedAlerts.some((alert) => alert.monitorId === row.monitor_id && alert.snapshotId === row.snapshot_id)) continue;
      storedAlerts.push({
        alertId: String(storedAlerts.length + 1), productId: row.product_id, monitorId: row.monitor_id,
        snapshotId: row.snapshot_id, discountPercent: String(row.discount_percent), thresholdPercent: String(row.threshold_percent),
        reason: row.reason, clientMessageId: "alert-client-id",
        title: "Watched shoe", externalUrl: watchedUrl, source: "zalando.dk",
        watched: true, hidden: false, member: true, monitorActive: true,
        displayName: "Zalando – shoes", currentThresholdPercent: "20.00",
        productCurrentPrice: "450.00", productCurrency: "DKK", productDiscountPercent: "25.00",
        observedPrice: "450.00", observedCurrency: "DKK", observedSourcePrice: null, observedSourceCurrency: null,
        preferenceScore: null, dealScore: null,
        status: "pending", claimToken: null,
      });
    }
    return [];
  }
  if (text.includes("FROM watched_alerts alert")) {
    return storedAlerts.filter((alert) => alert.status === "pending" && alert.claimToken === null);
  }
  if (text.includes("UPDATE watched_alerts")) {
    const ids = values[0] as string[];
    const matching = storedAlerts.filter((alert) => ids.includes(alert.alertId as string) && alert.status === "pending");
    if (text.includes("SET claimed_at = NOW()")) {
      return matching.map((alert) => {
        alert.claimToken = "alert-token";
        return { alertId: alert.alertId, claimToken: "alert-token" };
      });
    }
    if (text.includes("SET status = 'sent'")) {
      return matching.map((alert) => {
        alert.status = "sent";
        alert.claimToken = null;
        return { id: alert.alertId };
      });
    }
    for (const alert of matching) alert.claimToken = null;
    return [];
  }
  return [];
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(" ");
      return {
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
          detectionFails && text.includes("jsonb_agg(")
            ? reject(new Error("relation \"watched_alerts\" does not exist"))
            : resolve(rowsFor(text, values)),
      };
    };

    return Object.assign(sql, {
      transaction: async (queries: Array<{ then: unknown }>) => queries.map(() => [{
        productId: "5",
        source: "zalando.dk",
        externalUrl: watchedUrl,
        title: "Watched shoe",
        currentPrice: "450.00",
        currency: "DKK",
        sourceCurrentPrice: null,
        sourceCurrency: null,
        hidden: false,
        inserted: false,
        snapshotId: snapshotInserted ? "51" : null,
        priceChanged: false,
        priceDropPercent: null,
        discountPercent: "25.00",
      }]),
    });
  },
});
mockModule("@/lib/slack", {
  postSlackMessage: async (message: string, clientMessageId?: string) => {
    slackDeliveries.push({ message, clientMessageId });
    return alertSlackFails && message.startsWith("*DealRadar Watched alert*")
      ? { success: false, error: "unavailable" }
      : { success: true };
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

async function runImport() {
  slackDeliveries = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/public/deals/zalando-latest.json")) {
      return Response.json({
        site: "zalando.dk",
        product_count: 1,
        products: [{ url: watchedUrl, title: "Watched shoe", current_price: 450, currency: "DKK" }],
      });
    }
    if (url.endsWith("/public/deals/vinted-latest.json")) return Response.json({ site: "vinted.com", product_count: 0, products: [] });
    return new Response(null, { status: 404 });
  };

  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
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
  snapshotInserted = true;
  historicalLowHistory = false;
  detectionFails = false;
  alertSlackFails = false;
  storedAlerts = [];
  alertInserts = 0;
}

test("a crossing is stored and delivered right after detection, once, and an import retry adds nothing", async () => {
  reset();
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.evaluationRunId, null);
  assert.deepEqual(result.warnings, []);
  assert.equal(alertInserts, 1);
  assert.equal(slackDeliveries.length, 2);
  assert.equal(
    slackDeliveries[0]!.message,
    "*DealRadar Watched alert*\nWatched shoe\n450.00 DKK · 25% discount · " +
      `<${watchedUrl}|View product>\n• Zalando – shoes: crossed the 20% threshold`,
  );
  assert.equal(slackDeliveries[0]!.clientMessageId, "alert-client-id");
  assert.match(slackDeliveries[1]!.message, /^DealRadar updated: /, "the legacy message follows");
  assert.equal(slackDeliveries[1]!.clientMessageId, undefined);
  assert.deepEqual(storedAlerts.map((alert) => alert.status), ["sent"]);

  // Same ref again: no inserted snapshot, so no detection and no message.
  snapshotInserted = false;
  const retry = await runImport();
  assert.equal(retry.status, 200);
  assert.equal(alertInserts, 1);
  assert.equal(slackDeliveries.length, 1);
  assert.match(slackDeliveries[0]!.message, /^DealRadar updated: /);
});

test("P4(ii): a watched historical-low event for the same product and observation suppresses the Watched alert", async () => {
  reset();
  historicalLowHistory = true;
  const suppressed = await runImport();

  assert.equal(suppressed.status, 200);
  assert.equal(alertInserts, 0, "no Watched alert is stored");
  assert.equal(slackDeliveries.length, 1, "no Watched alert is sent");
  assert.match(
    slackDeliveries[0]!.message,
    /^DealRadar updated: [\s\S]*Zalando recommendation:\nWatched shoe\n450\.00 DKK/,
    "the legacy message keeps the historical-low recommendation",
  );

  // The legacy output is the same as when no Watched alert is detected.
  const legacyMessage = slackDeliveries[0]!.message;
  reset();
  historicalLowHistory = true;
  detectionFails = true;
  await runImport();
  assert.deepEqual(slackDeliveries.map((delivery) => delivery.message), [legacyMessage]);
});

test("a detection failure is logged and never fails the import", async () => {
  reset();
  detectionFails = true;
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.deepEqual(result.warnings, ["DealRadar Watched alert detection failed."]);
  assert.equal(slackDeliveries.length, 1);
  assert.match(slackDeliveries[0]!.message, /^DealRadar updated: /);
});

test("a delivery failure is logged, never fails the import, and leaves the alert pending for a retry", async () => {
  reset();
  alertSlackFails = true;
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.ok(result.warnings.includes("DealRadar Watched alert delivery failed."));
  assert.ok(result.warnings.includes("DealRadar daily notifications failed."), "the catch-up delivery also tried");
  assert.ok(slackDeliveries.some((delivery) => delivery.message.startsWith("DealRadar updated: ")));
  assert.deepEqual(storedAlerts.map((alert) => [alert.status, alert.claimToken]), [["pending", null]]);

  // A later import delivers it through the catch-up.
  alertSlackFails = false;
  snapshotInserted = false;
  const later = await runImport();
  assert.equal(later.status, 200);
  assert.deepEqual(later.warnings, []);
  assert.equal(slackDeliveries.length, 2);
  assert.match(slackDeliveries[0]!.message, /^DealRadar updated: /);
  assert.match(slackDeliveries[1]!.message, /^\*DealRadar Watched alert\*\n/, "delivered after the legacy message");
  assert.deepEqual(storedAlerts.map((alert) => alert.status), ["sent"]);
});
