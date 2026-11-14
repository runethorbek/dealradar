import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

// Representative route-level check (#90, #72 DoD 20; design D14, P7(b)): one
// import with no evaluation candidates and two Vinted and two Zalando Active
// monitors. The per-import message has only counts and scan warnings, the
// Daily summary has one entry per monitor, and Watched alerts are detected per
// monitor. SQL, Slack, and the evaluation Workflow are mocked.

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalIngestApiKey = process.env.INGEST_API_KEY;
const originalFetch = globalThis.fetch;

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
process.env.INGEST_API_KEY = "valid-ingest-key";

type Delivery = { message: string; clientMessageId: string | undefined };
type StoredAlert = Record<string, unknown> & { status: string; claimToken: string | null };

const now = Date.now();
const lastScanCheckedAt = new Date(now - 60 * 60 * 1000).toISOString();
const lastSeenAt = new Date(now).toISOString();

const urls = {
  watchedShoe: "https://www.zalando.dk/items/watched-shoe",
  loafer: "https://www.zalando.dk/items/loafer",
  blazer: "https://www.vinted.dk/items/1-blazer",
  coat: "https://www.vinted.dk/items/2-coat",
};

// What the product upserts return, in feed order. Nothing is new or changed,
// so the import has no evaluation candidates; only the Watched shoe gets a new
// snapshot (25%, previously 15%).
const importedRows = [
  { productId: "5", source: "zalando.dk", externalUrl: urls.watchedShoe, title: "Watched shoe", currentPrice: "450.00", currency: "DKK", snapshotId: "51", discountPercent: "25.00" },
  { productId: "6", source: "zalando.dk", externalUrl: urls.loafer, title: "Loafer", currentPrice: "300.00", currency: "DKK", snapshotId: null, discountPercent: "40.00" },
  { productId: "7", source: "vinted.com", externalUrl: urls.blazer, title: "Blazer", currentPrice: "120.00", currency: "DKK", snapshotId: null, discountPercent: null },
  { productId: "8", source: "vinted.com", externalUrl: urls.coat, title: "Coat", currentPrice: "200.00", currency: "DKK", snapshotId: null, discountPercent: null },
].map((row) => ({
  ...row,
  sourceCurrentPrice: null,
  sourceCurrency: null,
  hidden: false,
  inserted: false,
  priceChanged: false,
  priceDropPercent: null,
}));

const monitors = {
  "vinted-blazers": { displayName: "Vinted – blazers", source: "vinted.com", strategy: "best_match", minimumDiscountPercent: null, minimumOverallScore: "7.00" },
  "vinted-coats": { displayName: "Vinted – coats", source: "vinted.com", strategy: "best_match", minimumDiscountPercent: null, minimumOverallScore: "8.00" },
  "zalando-shoes-10": { displayName: "Zalando – shoes from 10%", source: "zalando.dk", strategy: "discount_threshold", minimumDiscountPercent: "10.00", minimumOverallScore: null },
  "zalando-shoes-20": { displayName: "Zalando – shoes from 20%", source: "zalando.dk", strategy: "discount_threshold", minimumDiscountPercent: "20.00", minimumOverallScore: null },
} as const;

function member(monitorId: keyof typeof monitors, productId: string, scores: { preferenceScore: number; dealScore: number } | null) {
  const monitor = monitors[monitorId];
  const product = importedRows.find((row) => row.productId === productId)!;

  return {
    monitorId,
    monitorSource: monitor.source,
    displayName: monitor.displayName,
    strategy: monitor.strategy,
    minimumDiscountPercent: monitor.minimumDiscountPercent,
    minimumOverallScore: monitor.minimumOverallScore,
    lastScanCheckedAt,
    productId,
    title: product.title,
    externalUrl: product.externalUrl,
    source: product.source,
    currentPrice: product.currentPrice,
    currency: product.currency,
    sourceCurrentPrice: null,
    sourceCurrency: null,
    discountPercent: product.discountPercent,
    hidden: false,
    lastSeenAt,
    preferenceScore: scores?.preferenceScore ?? null,
    dealScore: scores?.dealScore ?? null,
  };
}

// The monitor recommendation loader's rows, in monitor_id and product id
// order: fresh, visible members with their stored evaluations.
const activeMonitorRows = [
  member("vinted-blazers", "7", { preferenceScore: 9, dealScore: 8 }),
  member("vinted-coats", "8", null),
  member("zalando-shoes-10", "5", null),
  member("zalando-shoes-10", "6", { preferenceScore: 8, dealScore: 7 }),
  member("zalando-shoes-20", "5", null),
];

// The Watched shoe's history for Watched alert detection. Only Active
// discount_threshold monitors are listed: best_match monitors never alert.
const alertHistory = [
  { snapshotId: "50", productId: "5", source: "zalando.dk", currentPrice: "600.00", currency: "DKK", discountPercent: "15.00" },
  { snapshotId: "51", productId: "5", source: "zalando.dk", currentPrice: "450.00", currency: "DKK", discountPercent: "25.00" },
].map((row) => ({
  ...row,
  monitors: [
    { monitorId: "zalando-shoes-10", thresholdPercent: "10.00" },
    { monitorId: "zalando-shoes-20", thresholdPercent: "20.00" },
  ],
}));

let summaryRow: { status: "pending" | "sent"; content: unknown } | null = null;
const storedAlerts: StoredAlert[] = [];
const slackDeliveries: Delivery[] = [];
let evaluationRunsCreated = 0;

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

function dailySummaryRows(text: string, values: unknown[]) {
  if (text.includes("SELECT status FROM daily_summaries")) return summaryRow ? [{ status: summaryRow.status }] : [];
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

function watchedAlertRows(text: string, values: unknown[]) {
  if (text.includes("INSERT INTO watched_alerts")) {
    for (const row of JSON.parse(values[0] as string) as Array<Record<string, unknown>>) {
      const monitorId = row.monitor_id as keyof typeof monitors;
      storedAlerts.push({
        alertId: String(storedAlerts.length + 1), productId: row.product_id, monitorId,
        snapshotId: row.snapshot_id, discountPercent: String(row.discount_percent),
        thresholdPercent: String(row.threshold_percent), dropPercent: null,
        reason: row.reason, clientMessageId: "alert-client-id",
        title: "Watched shoe", externalUrl: urls.watchedShoe, source: "zalando.dk",
        watched: true, hidden: false, member: true, monitorActive: true,
        displayName: monitors[monitorId].displayName, currentThresholdPercent: monitors[monitorId].minimumDiscountPercent,
        productCurrentPrice: "450.00", productCurrency: "DKK", productSourceCurrentPrice: null, productSourceCurrency: null,
        productDiscountPercent: "25.00",
        observedPrice: "450.00", observedCurrency: "DKK", observedSourcePrice: null, observedSourceCurrency: null,
        observedDiscountPercent: "25.00",
        preferenceScore: null, dealScore: null,
        status: "pending", claimToken: null,
      });
    }
    return [];
  }
  if (text.includes("FROM watched_alerts alert")) {
    return storedAlerts.filter((alert) => alert.status === "pending" && alert.claimToken === null);
  }
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

function rowsFor(text: string, values: unknown[]) {
  if (text.includes("SELECT vinted, gemini")) return [{}];
  if (text.includes("daily_summaries")) return dailySummaryRows(text, values);
  if (text.includes("watched_alerts")) return watchedAlertRows(text, values);
  if (text.includes("SELECT 1 AS \"active\" FROM monitor_definitions")) return [{ active: 1 }];
  if (text.includes("FROM monitor_definitions m")) return activeMonitorRows;
  // Watched alert detection.
  if (text.includes("jsonb_agg(")) return alertHistory;
  // Watched historical-low history: no historical low in this import.
  if (text.includes("SELECT DISTINCT s.product_id")) return [];
  return [];
}

mockModule("@neondatabase/serverless", {
  neon: () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(" ");
      return {
        then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsFor(text, values)),
      };
    };

    return Object.assign(sql, {
      transaction: async (batch: Array<{ then: unknown }>) =>
        batch.map((_, index) => (importedRows[index] ? [importedRows[index]] : [])),
    });
  },
});
mockModule("@/lib/slack", {
  postSlackMessage: async (message: string, clientMessageId?: string) => {
    slackDeliveries.push({ message, clientMessageId });
    return { success: true };
  },
});
mockModule("@/lib/evaluation-runs.mts", {
  createEvaluationRun: async () => {
    evaluationRunsCreated += 1;
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
    product_count: 2,
    products: [
      { url: urls.watchedShoe, title: "Watched shoe", current_price: 450, currency: "DKK" },
      { url: urls.loafer, title: "Loafer", current_price: 300, currency: "DKK" },
    ],
  },
  vinted: {
    site: "vinted.com",
    product_count: 2,
    products: [
      { url: urls.blazer, title: "Blazer", price: 120, currency: "DKK" },
      { url: urls.coat, title: "Coat", price: 200, currency: "DKK" },
    ],
    scan_status: {
      attempted_pages: 3,
      successful_pages: 2,
      failed_pages: 1,
      failures: [{ name: "Menswear", error_summary: "rate limited" }],
    },
  },
};

async function runImport() {
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

const scanWarnings = "\n\nScan warnings:\n• Vinted: 2/3 pages succeeded; 1 failed\n  ◦ Menswear: rate limited";

test("an import without evaluation candidates and two Vinted and two Zalando monitors sends the operational message, one Daily summary entry per monitor, and per-monitor Watched alerts", async () => {
  const result = await runImport();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.evaluationRunId, null, "no evaluation candidates");
  assert.equal(evaluationRunsCreated, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(slackDeliveries.length, 3, "Watched alert, per-import message, Daily summary");

  // Watched alerts: each Active discount_threshold monitor is detected on its
  // own, a new best for the 10% monitor and a crossing for the 20% monitor,
  // stored per monitor and sent as one message for the observation.
  assert.deepEqual(
    storedAlerts.map((alert) => [alert.reason, alert.monitorId, alert.productId, alert.snapshotId, alert.status]),
    [
      ["new_best", "zalando-shoes-10", "5", "51", "sent"],
      ["crossing", "zalando-shoes-20", "5", "51", "sent"],
    ],
  );
  assert.equal(
    slackDeliveries[0]!.message,
    "*DealRadar Watched alert*\nWatched shoe\n450.00 DKK · 25% discount · " +
      `<${urls.watchedShoe}|View product>\n` +
      "• Zalando – shoes from 10%: new best in the qualifying episode (threshold 10%)\n" +
      "• Zalando – shoes from 20%: crossed the 20% threshold",
  );
  assert.equal(slackDeliveries[0]!.clientMessageId, "alert-client-id");

  // The per-import message: counts and scan warnings only (P7(b)).
  assert.equal(
    slackDeliveries[1]!.message,
    "DealRadar updated: 4 processed · 0 new · 4 updated · 1 snapshots · 0 evaluated" + scanWarnings,
  );
  assert.doesNotMatch(slackDeliveries[1]!.message, /recommendation|Best match|View product/i);
  assert.equal(slackDeliveries[1]!.clientMessageId, undefined);

  // The Daily summary: one entry per Active monitor, in monitor ID order,
  // each with one Best match or the reason it has none.
  assert.equal(
    slackDeliveries[2]!.message,
    `*DealRadar daily summary · ${getCopenhagenDate(new Date())}*\n\n` +
      "*Vinted – blazers*\nStrategy: best match · Overall at least 7\nQualifying: 1 · Not yet evaluated: 0\n" +
      `Best match: Blazer\n120.00 DKK · Overall 8.6 · <${urls.blazer}|View product>\n\n` +
      "*Vinted – coats*\nStrategy: best match · Overall at least 8\nQualifying: 0 · Not yet evaluated: 1\n" +
      "No products qualify.\n\n" +
      "*Zalando – shoes from 10%*\nStrategy: discount threshold · at least 10% discount\nQualifying: 2 · Not yet evaluated: 1\n" +
      `Best match: Loafer\n300.00 DKK · 40% discount · Overall 7.6 · <${urls.loafer}|View product>\n\n` +
      "*Zalando – shoes from 20%*\nStrategy: discount threshold · at least 20% discount\nQualifying: 1 · Not yet evaluated: 1\n" +
      "No best match: no qualifying product is evaluated yet." +
      scanWarnings,
  );
  assert.equal(slackDeliveries[2]!.clientMessageId, "daily-client-id");
  const content = summaryRow!.content as { monitors: Array<{ monitorId: string; bestMatch: { productId: string } | null }> };
  assert.deepEqual(
    content.monitors.map((monitor) => [monitor.monitorId, monitor.bestMatch?.productId ?? null]),
    [["vinted-blazers", "7"], ["vinted-coats", null], ["zalando-shoes-10", "6"], ["zalando-shoes-20", null]],
  );
});
