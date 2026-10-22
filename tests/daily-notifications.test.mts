import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverDailyNotifications,
  deliverDailyNotificationsForEvaluationRun,
} from "../lib/daily-notifications.mts";
import type { DailySummarySql } from "../lib/daily-summary.mts";

// Daily notifications at the end of an import (#80; design D13, "Delivery
// and retry"): the daily summary, then pending Watched alerts (#81).

const summaryDate = "2026-10-22";
const now = new Date("2026-10-22T05:00:00.000Z");

// A date with one pending, unclaimed summary whose content is already stored.
// With `fresh`, the date has no row yet and one active monitor exists.
// `pendingAlerts` are pending Watched alert rows; an alert is marked sent
// when its send succeeds.
function pendingSummarySql(
  runRow?: Record<string, unknown>,
  { fresh = false, pendingAlerts = [] as Array<Record<string, unknown>> } = {},
) {
  const queries: string[] = [];
  const claimValues: unknown[][] = [];
  const insertedContent: unknown[] = [];
  let sent = false;
  let alertsSent = false;
  const sql: DailySummarySql = async (strings, ...values) => {
    const query = strings.join("$parameter");
    queries.push(query);
    if (query.includes("FROM watched_alerts alert")) return alertsSent ? [] : pendingAlerts;
    if (query.includes("UPDATE watched_alerts")) {
      if (query.includes("SET claimed_at = NOW()")) return [{ alertId: "1", claimToken: "alert-token" }];
      if (query.includes("SET status = 'sent'")) { alertsSent = true; return [{ id: "1" }]; }
      return [];
    }
    if (query.includes("FROM evaluation_runs")) return runRow ? [runRow] : [];
    if (query.includes("SELECT status FROM daily_summaries")) return fresh ? [] : [{ status: sent ? "sent" : "pending" }];
    if (query.includes("FROM monitor_definitions")) return query.includes("LIMIT 1") ? [{ active: 1 }] : [activeMonitorRow];
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
    if (query.includes("INSERT INTO daily_summaries")) { insertedContent.push(JSON.parse(values[1] as string)); return []; }
    if (query.includes("SET claimed_at = NOW()")) {
      claimValues.push(values);
      return sent ? [] : [{ content: insertedContent[0] ?? { text: "stored summary" }, clientMessageId: "client-1", claimToken: "token-1" }];
    }
    if (query.includes("SET status = 'sent'")) { sent = true; return [{ summary_date: summaryDate }]; }
    if (query.includes("SET claimed_at = NULL")) return [];
    throw new Error(`Unexpected query: ${query}`);
  };

  return { sql, queries, claimValues, insertedContent };
}

const activeMonitorRow = {
  monitorId: "vinted-mens-blazers-size-s", monitorSource: "vinted.com", displayName: null,
  strategy: "best_match", minimumDiscountPercent: null, minimumOverallScore: "7.00",
  lastScanCheckedAt: "2026-10-22T02:45:00.000Z", productId: null,
};

const noWarnings = { monitorDefinitionsWarning: null, scanWarnings: [] };

test("delivers the daily summary and reports its outcome", async () => {
  const { sql } = pendingSummarySql();
  const messages: string[] = [];

  const result = await deliverDailyNotifications({
    sql,
    summaryDate,
    now,
    postSlackMessage: async (message) => { messages.push(message); return { success: true }; },
    ...noWarnings,
  });

  assert.deepEqual(result, { summary: { status: "sent" } });
  assert.deepEqual(messages, ["stored summary"]);
});

test("throws at the end when the summary fails, so a step retry tries again", async () => {
  const { sql } = pendingSummarySql();
  let attempts = 0;
  const warn = console.warn;
  console.warn = () => {};

  try {
    await assert.rejects(
      deliverDailyNotifications({
        sql,
        summaryDate,
        now,
        postSlackMessage: async () => { attempts += 1; return { success: false, error: "unavailable" }; },
        ...noWarnings,
      }),
      /Daily notification delivery failed: daily summary\./,
    );
  } finally {
    console.warn = warn;
  }

  assert.equal(attempts, 1);
});

const pendingAlert = {
  alertId: "1", productId: "5", monitorId: "zalando-shoes", snapshotId: "51",
  discountPercent: "25.00", thresholdPercent: "20.00", reason: "crossing", clientMessageId: "alert-client-1",
  title: "Watched shoe", externalUrl: "https://www.zalando.dk/shoe", source: "zalando.dk",
  watched: true, hidden: false, member: true, monitorActive: true,
  displayName: "Zalando – shoes", currentThresholdPercent: "20.00",
  productCurrentPrice: "500.00", productCurrency: "DKK", productDiscountPercent: "25.00",
  observedPrice: "500.00", observedCurrency: "DKK", observedSourcePrice: null, observedSourceCurrency: null,
  preferenceScore: null, dealScore: null,
};

test("delivers pending Watched alerts after the daily summary", async () => {
  const { sql } = pendingSummarySql(undefined, { pendingAlerts: [pendingAlert] });
  const deliveries: Array<[string, string | undefined]> = [];

  await deliverDailyNotifications({
    sql,
    summaryDate,
    now,
    postSlackMessage: async (message, clientMessageId) => { deliveries.push([message, clientMessageId]); return { success: true }; },
    ...noWarnings,
  });

  assert.deepEqual(deliveries.map(([, clientMessageId]) => clientMessageId), ["client-1", "alert-client-1"]);
  assert.match(deliveries[1]![0], /^\*DealRadar Watched alert\*\nWatched shoe\n/);
});

test("a Watched alert failure throws only after the summary was attempted, and the summary failure does not skip alerts", async () => {
  const warn = console.warn;
  console.warn = () => {};

  try {
    const alertFails = pendingSummarySql(undefined, { pendingAlerts: [pendingAlert] });
    const sent: string[] = [];
    await assert.rejects(
      deliverDailyNotifications({
        sql: alertFails.sql,
        summaryDate,
        now,
        postSlackMessage: async (message) => {
          if (message.startsWith("*DealRadar Watched alert*")) return { success: false, error: "unavailable" };
          sent.push(message);
          return { success: true };
        },
        ...noWarnings,
      }),
      /Daily notification delivery failed: Watched alerts\./,
    );
    assert.deepEqual(sent, ["stored summary"], "the summary was sent first");

    const bothFail = pendingSummarySql(undefined, { pendingAlerts: [pendingAlert] });
    const attempted: string[] = [];
    await assert.rejects(
      deliverDailyNotifications({
        sql: bothFail.sql,
        summaryDate,
        now,
        postSlackMessage: async (message) => { attempted.push(message); return { success: false, error: "unavailable" }; },
        ...noWarnings,
      }),
      /Daily notification delivery failed: daily summary, Watched alerts\./,
    );
    assert.equal(attempted.length, 2, "both parts were attempted");
  } finally {
    console.warn = warn;
  }
});

test("the Workflow path uses the summary date and warnings stored with the run", async () => {
  const run = {
    importSummary: { ref: "abc", summaryDate, monitorDefinitionsWarning: "unavailable: document request failed" },
    scanWarnings: [{ sourceName: "Vinted", successfulPages: 1, attemptedPages: 2, failedPages: 1, failures: [{ name: "Blazers", url: null, error: "HTTP 503" }] }],
  };
  const { sql, claimValues } = pendingSummarySql(run, { fresh: true });
  const messages: string[] = [];

  const result = await deliverDailyNotificationsForEvaluationRun({
    sql,
    runId: "7",
    now,
    postSlackMessage: async (message) => { messages.push(message); return { success: true }; },
  });

  assert.deepEqual(result, { summary: { status: "sent" } });
  assert.deepEqual(claimValues, [[summaryDate]]);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^\*DealRadar daily summary · 2026-10-22\*\n\n\*vinted-mens-blazers-size-s\*\n/);
  assert.match(messages[0]!, /No products qualify\./);
  assert.match(messages[0]!, /Monitor definitions were not updated \(unavailable: document request failed\)/);
  assert.match(messages[0]!, /Scan warnings:\n• Vinted: 1\/2 pages succeeded; 1 failed/);
});

test("a run that finishes after Copenhagen midnight keeps its import date and does not send late", async () => {
  const { sql, queries } = pendingSummarySql({ importSummary: { summaryDate }, scanWarnings: [] });
  let deliveries = 0;

  const result = await deliverDailyNotificationsForEvaluationRun({
    sql,
    runId: "7",
    // 2026-10-23 00:30 in Copenhagen.
    now: new Date("2026-10-22T22:30:00.000Z"),
    postSlackMessage: async () => { deliveries += 1; return { success: true }; },
  });

  assert.deepEqual(result, { summary: { status: "expired" } });
  assert.equal(deliveries, 0);
  assert.ok(queries.every((query) => !query.includes("daily_summaries")), "no summary for the new date is created");
});

test("a run created before the summary date was stored produces no summary", async () => {
  const { sql, queries } = pendingSummarySql({ importSummary: { ref: "abc", productsProcessed: 1 }, scanWarnings: [] });
  let deliveries = 0;
  const info = console.info;
  console.info = () => {};

  try {
    const result = await deliverDailyNotificationsForEvaluationRun({
      sql,
      runId: "7",
      now,
      postSlackMessage: async () => { deliveries += 1; return { success: true }; },
    });

    assert.deepEqual(result, { summary: null });
  } finally {
    console.info = info;
  }

  assert.equal(deliveries, 0);
  assert.equal(queries.length, 1, "only the run is read");
});
