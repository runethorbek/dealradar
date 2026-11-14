import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvaluationRun } from "../lib/evaluation-finalization.mts";
import type { EvaluationRun, EvaluationRunSql } from "../lib/evaluation-runs.mts";

const completedRun: EvaluationRun = { id: "7", importRef: "abc", status: "completed", startedAt: "now", completedAt: "now", notificationSent: false, createdAt: "now", candidatesSelected: 2, evaluationsCompleted: 1, evaluationsFailed: 1, pendingCandidates: 0, batchesProcessed: 1 };

test("finalizes completed persisted work once with the operational per-import message", async () => {
  let claimed = false;
  let sent = false;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun, notificationSent: sent }];
    if (query.includes("SET notification_claimed_at = NOW")) { if (claimed) return []; claimed = true; return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000007", notificationClaimToken: "claim-7" }]; }
    if (query.includes("SET notification_sent")) { sent = true; return [{ id: "7" }]; }
    if (query.includes("import_summary")) return [{ importSummary: { ref: "abc", productsProcessed: 3, productsInserted: 2, productsUpdated: 1, snapshotsInserted: 3 }, scanWarnings: [] }];
    throw new Error(query);
  };
  const messages: string[] = [];
  const dependencies = { sql, run: completedRun, postSlackMessage: async (message: string) => { messages.push(message); return { success: true }; } };
  assert.deepEqual(await finalizeEvaluationRun(dependencies), { finalized: true, notificationSent: true });
  assert.deepEqual(await finalizeEvaluationRun(dependencies), { finalized: false, notificationSent: true });
  assert.equal(messages.length, 1);
  // productsEvaluated is the run's completed evaluations, not the stored count.
  assert.equal(messages[0], "DealRadar updated: 3 processed · 2 new · 1 updated · 3 snapshots · 1 evaluated");
});

test("the per-import message has only counts and scan warnings, and finalization reads no evaluations or ranking settings (#90)", async () => {
  const messages: string[] = [];
  const queries: string[] = [];
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    queries.push(query);
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun }];
    if (query.includes("SET notification_claimed_at = NOW")) return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000011", notificationClaimToken: "claim-11" }];
    if (query.includes("SET notification_sent")) return [{ id: "7" }];
    // The run still records the import's watched historical lows as a
    // diagnostic record; finalization does not read them.
    if (query.includes("import_summary")) return [{
      importSummary: { productsProcessed: 4, productsInserted: 1, productsUpdated: 3, snapshotsInserted: 2 },
      scanWarnings: [{ sourceName: "Zalando", successfulPages: 5, attemptedPages: 6, failedPages: 1, failures: [{ name: "Page 6", url: null, error: "timeout" }] }],
      watchedHistoricalLows: [{ productId: "5", snapshotId: "51", dropPercent: 12.5 }],
    }];
    throw new Error(query);
  };
  await finalizeEvaluationRun({ sql, run: completedRun, postSlackMessage: async (message: string) => { messages.push(message); return { success: true }; } });

  assert.equal(
    messages[0],
    "DealRadar updated: 4 processed · 1 new · 3 updated · 2 snapshots · 1 evaluated\n\n" +
      "Scan warnings:\n• Zalando: 5/6 pages succeeded; 1 failed\n  ◦ Page 6: timeout",
  );
  assert.doesNotMatch(messages[0]!, /recommendation/i);
  assert.ok(queries.every((query) => !query.includes("product_evaluations")), "no product_evaluations query");
  assert.ok(queries.every((query) => !query.includes("application_settings")), "no application_settings query");
  assert.ok(queries.every((query) => !query.includes("watched_historical_lows")), "watched_historical_lows is not read");
  // The only candidate access is the run's own terminality and count reload.
  assert.ok(
    queries.filter((query) => query.includes("evaluation_run_candidates")).every((query) => query.includes("COUNT(erc.product_id)")),
    "no query loads the run's completed candidate rows",
  );
});

test("a failure to record the sent notification releases the claim through the normal error path", async () => {
  let claimed = false;
  let notificationSent = false;
  let deliveries = 0;
  let markCalls = 0;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun, notificationSent }];
    if (query.includes("SET notification_claimed_at = NOW")) { if (claimed) return []; claimed = true; return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000009", notificationClaimToken: "claim-9" }]; }
    if (query.includes("SET notification_sent")) {
      markCalls += 1;
      if (markCalls === 1) return [];
      notificationSent = true;
      return [{ id: "7" }];
    }
    if (query.includes("SET notification_claimed_at = NULL")) { claimed = false; return []; }
    if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
    throw new Error(query);
  };
  const dependencies = { sql, run: completedRun, postSlackMessage: async () => { deliveries += 1; return { success: true }; } };

  await assert.rejects(finalizeEvaluationRun(dependencies), /can be retried/);
  assert.equal(claimed, false, "the notification claim must be released when it cannot be recorded");

  assert.deepEqual(await finalizeEvaluationRun(dependencies), { finalized: true, notificationSent: true });
  assert.equal(deliveries, 2);
});

test("does not finalize before all candidates are terminal", async () => {
  let calls = 0;
  const result = await finalizeEvaluationRun({ sql: async (strings) => { calls += 1; return strings.join("$parameter").includes("COUNT(erc.product_id)") ? [{ ...completedRun, status: "running", pendingCandidates: 1 }] : []; }, run: { ...completedRun, pendingCandidates: 1 }, postSlackMessage: async () => ({ success: true }) });
  assert.deepEqual(result, { finalized: false, notificationSent: false });
  assert.equal(calls, 1);
});

test("reloads terminality from Postgres instead of trusting a stale workflow snapshot", async () => {
  let deliveries = 0;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun }];
    if (query.includes("SET notification_claimed_at = NOW")) return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000007", notificationClaimToken: "claim-7" }];
    if (query.includes("SET notification_sent")) return [{ id: "7" }];
    if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
    if (query.includes("SET notification_claimed_at = NULL")) return [];
    throw new Error(query);
  };
  await finalizeEvaluationRun({ sql, run: { ...completedRun, status: "running", pendingCandidates: 1 }, postSlackMessage: async () => { deliveries += 1; return { success: true }; } });
  assert.equal(deliveries, 1);
});

test("a Slack failure remains terminal and cannot trigger another delivery or Gemini work", async () => {
  let claimed = false;
  let deliveries = 0;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun }];
    if (query.includes("SET notification_claimed_at = NOW")) { if (claimed) return []; claimed = true; return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000007", notificationClaimToken: "claim-7" }]; }
    if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
    if (query.includes("SET notification_claimed_at = NULL")) { claimed = false; return []; }
    throw new Error(query);
  };
  const dependencies = { sql, run: completedRun, postSlackMessage: async () => { deliveries += 1; return { success: false, error: "unavailable" }; } };
  await assert.rejects(finalizeEvaluationRun(dependencies), /can be retried/);
  await assert.rejects(finalizeEvaluationRun(dependencies), /can be retried/);
  assert.equal(deliveries, 2);
});

test("a thrown Slack error is non-fatal after the one persisted claim", async () => {
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun }];
    if (query.includes("SET notification_claimed_at = NOW")) return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000007", notificationClaimToken: "claim-7" }];
    if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
    if (query.includes("SET notification_claimed_at = NULL")) return [];
    throw new Error(query);
  };
  await assert.rejects(finalizeEvaluationRun({ sql, run: completedRun, postSlackMessage: async () => { throw new Error("network"); } }), /can be retried/);
});
