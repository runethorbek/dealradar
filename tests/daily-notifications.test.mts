import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverDailyNotifications,
  deliverDailyNotificationsForEvaluationRun,
} from "../lib/daily-notifications.mts";
import type { DailySummarySql } from "../lib/daily-summary.mts";

// Daily notifications at the end of an import (#80; design D13, "Delivery
// and retry"): the daily summary, then the Watched alert seam (S6).

const summaryDate = "2026-10-22";
const now = new Date("2026-10-22T05:00:00.000Z");

// A date with one pending, unclaimed summary whose content is already stored.
// With `fresh`, the date has no row yet and one active monitor exists.
function pendingSummarySql(runRow?: Record<string, unknown>, { fresh = false } = {}) {
  const queries: string[] = [];
  const claimValues: unknown[][] = [];
  const insertedContent: unknown[] = [];
  let sent = false;
  const sql: DailySummarySql = async (strings, ...values) => {
    const query = strings.join("$parameter");
    queries.push(query);
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
