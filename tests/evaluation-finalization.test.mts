import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvaluationRun } from "../lib/evaluation-finalization.mts";
import type { EvaluationRun, EvaluationRunSql } from "../lib/evaluation-runs.mts";

const completedRun: EvaluationRun = { id: "7", importRef: "abc", status: "completed", startedAt: "now", completedAt: "now", notificationSent: false, createdAt: "now", candidatesSelected: 2, evaluationsCompleted: 1, evaluationsFailed: 1, pendingCandidates: 0, batchesProcessed: 1 };

test("finalizes completed persisted work once and uses successful persisted evaluations", async () => {
  let claimed = false;
  let sent = false;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun, notificationSent: sent }];
    if (query.includes("SET notification_claimed_at = NOW")) { if (claimed) return []; claimed = true; return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000007", notificationClaimToken: "claim-7" }]; }
    if (query.includes("SET notification_sent")) { sent = true; return [{ id: "7" }]; }
    if (query.includes("import_summary")) return [{ importSummary: { ref: "abc", productsProcessed: 3, productsInserted: 2, productsUpdated: 1, snapshotsInserted: 3 }, scanWarnings: [] }];
    if (query.includes("JOIN product_evaluations")) return [{ productId: "1", externalUrl: "https://example.com/a", title: "A", source: "zalando.dk", currentPrice: "100", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null, hidden: false, preferenceScore: 9, dealScore: 8 }];
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
    throw new Error(query);
  };
  const messages: string[] = [];
  const dependencies = { sql, run: completedRun, postSlackMessage: async (message: string) => { messages.push(message); return { success: true }; } };
  assert.deepEqual(await finalizeEvaluationRun(dependencies), { finalized: true, notificationSent: true });
  assert.deepEqual(await finalizeEvaluationRun(dependencies), { finalized: false, notificationSent: true });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /3 processed.*2 new.*1 updated.*3 snapshots.*1 evaluated/);
  assert.match(messages[0], /Zalando recommendation:\nA/);
});

test("uses the persisted ranking weight to select the Slack top recommendation", async () => {
  let claimed = false;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun }];
    if (query.includes("SET notification_claimed_at = NOW")) { if (claimed) return []; claimed = true; return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000008", notificationClaimToken: "claim-8" }]; }
    if (query.includes("SET notification_sent")) return [{ id: "7" }];
    if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
    if (query.includes("JOIN product_evaluations")) return [
      { productId: "preference-heavy", externalUrl: "https://example.com/a", title: "Preference heavy", source: "zalando.dk", currentPrice: "100", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null, hidden: false, preferenceScore: 9, dealScore: 3 },
      { productId: "deal-heavy", externalUrl: "https://example.com/b", title: "Deal heavy", source: "zalando.dk", currentPrice: "100", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null, hidden: false, preferenceScore: 3, dealScore: 9 },
    ];
    if (query.includes("FROM application_settings")) return [{ ranking: { preferenceWeightPercent: 20 } }];
    throw new Error(query);
  };
  const messages: string[] = [];
  await finalizeEvaluationRun({ sql, run: completedRun, postSlackMessage: async (message: string) => { messages.push(message); return { success: true }; } });
  assert.match(messages[0], /Zalando recommendation:\nDeal heavy/);
});

test("selects one recommendation per source from the run's completed evaluations", async () => {
  const product = (productId: string, source: string, preferenceScore: number, dealScore: number, hidden = false) => ({
    productId, externalUrl: `https://example.com/${productId}`, title: `Product ${productId}`, source, currentPrice: "100", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null, hidden, preferenceScore, dealScore,
  });
  const run = async (rows: ReturnType<typeof product>[]) => {
    const messages: string[] = [];
    const sql: EvaluationRunSql = async (strings) => {
      const query = strings.join("$parameter");
      if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun }];
      if (query.includes("SET notification_claimed_at = NOW")) return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000010", notificationClaimToken: "claim-10" }];
      if (query.includes("SET notification_sent")) return [{ id: "7" }];
      if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
      if (query.includes("JOIN product_evaluations")) return rows;
      if (query.includes("FROM application_settings")) return [{ ranking: null }];
      throw new Error(query);
    };
    await finalizeEvaluationRun({ sql, run: completedRun, postSlackMessage: async (message: string) => { messages.push(message); return { success: true }; } });
    return messages[0];
  };

  const both = await run([
    product("20", "vinted.com", 10, 10, true),
    product("21", "vinted.com", 8, 7),
    product("22", "vinted.com", 9, 9),
    product("30", "zalando.dk", 5, 5),
  ]);
  assert.match(both, /\n\nZalando recommendation:\nProduct 30\n[^\n]+\n\nVinted recommendation:\nProduct 22\n/);

  // A Vinted listing below Overall 7 (8/5 -> 6.8) gives no Vinted recommendation,
  // and a strong Vinted listing never displaces the Zalando one.
  const vintedBelowThreshold = await run([product("21", "vinted.com", 8, 5), product("30", "zalando.dk", 5, 5)]);
  assert.doesNotMatch(vintedBelowThreshold, /Vinted recommendation/);
  assert.match(vintedBelowThreshold, /Zalando recommendation:\nProduct 30/);

  const vintedOnly = await run([product("22", "vinted.com", 9, 9)]);
  assert.doesNotMatch(vintedOnly, /Zalando recommendation/);
  assert.match(vintedOnly, /Vinted recommendation:\nProduct 22/);
});

test("a ranking-settings read failure after the claim is acquired releases the claim through the normal error path", async () => {
  let claimed = false;
  let notificationSent = false;
  let deliveries = 0;
  let applicationSettingsCalls = 0;
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("FROM evaluation_runs") && query.includes("COUNT(erc.product_id)")) return [{ ...completedRun, notificationSent }];
    if (query.includes("SET notification_claimed_at = NOW")) { if (claimed) return []; claimed = true; return [{ notificationClientMessageId: "00000000-0000-4000-8000-000000000009", notificationClaimToken: "claim-9" }]; }
    if (query.includes("SET notification_sent")) { notificationSent = true; return [{ id: "7" }]; }
    if (query.includes("SET notification_claimed_at = NULL")) { claimed = false; return []; }
    if (query.includes("import_summary")) return [{ importSummary: {}, scanWarnings: [] }];
    if (query.includes("JOIN product_evaluations")) return [{ productId: "1", externalUrl: "https://example.com/a", title: "A", currentPrice: "100", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null, hidden: false, preferenceScore: 9, dealScore: 8 }];
    if (query.includes("FROM application_settings")) {
      applicationSettingsCalls += 1;
      if (applicationSettingsCalls === 1) throw new Error("connection reset");
      return [{ ranking: null }];
    }
    throw new Error(query);
  };
  const dependencies = { sql, run: completedRun, postSlackMessage: async () => { deliveries += 1; return { success: true }; } };

  await assert.rejects(finalizeEvaluationRun(dependencies), /can be retried/);
  assert.equal(deliveries, 0, "Slack must not be contacted when the ranking-settings read fails first");
  assert.equal(claimed, false, "the notification claim must be released on the failed read");

  assert.deepEqual(await finalizeEvaluationRun(dependencies), { finalized: true, notificationSent: true });
  assert.equal(deliveries, 1);
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
    if (query.includes("JOIN product_evaluations")) return [];
    if (query.includes("SET notification_claimed_at = NULL")) return [];
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
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
    if (query.includes("JOIN product_evaluations")) return [];
    if (query.includes("SET notification_claimed_at = NULL")) { claimed = false; return []; }
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
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
    if (query.includes("JOIN product_evaluations")) return [];
    if (query.includes("SET notification_claimed_at = NULL")) return [];
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
    throw new Error(query);
  };
  await assert.rejects(finalizeEvaluationRun({ sql, run: completedRun, postSlackMessage: async () => { throw new Error("network"); } }), /can be retried/);
});
