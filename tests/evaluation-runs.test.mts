import assert from "node:assert/strict";
import test from "node:test";
import {
  completeEvaluationRun,
  createEvaluationRun,
  getEvaluationRun,
  loadNextEvaluationBatch,
  loadPendingEvaluationRunIds,
  markEvaluationRunNotificationSent,
  recordEvaluationBatchProcessed,
  recordEvaluationCandidateOutcome,
  startEvaluationRun,
  claimEvaluationRunLaunch,
  markEvaluationRunLaunched,
  releaseEvaluationRunLaunchClaim,
  type EvaluationRunSql,
} from "../lib/evaluation-runs.mts";

const runRow = {
  id: "7",
  importRef: "abc123",
  status: "pending",
  startedAt: null,
  completedAt: null,
  notificationSent: false,
  createdAt: "2026-09-14T10:00:00.000Z",
  candidatesSelected: 2,
  evaluationsCompleted: 0,
  evaluationsFailed: 0,
  pendingCandidates: 2,
  batchesProcessed: 0,
};

function queryText(strings: TemplateStringsArray) {
  return strings.join("$parameter");
}

/**
 * Simulates PostgreSQL's data-modifying-CTE snapshot rule: a statement that
 * re-reads evaluation_runs/evaluation_run_candidates as base tables (outside
 * their own INSERT clauses) cannot see rows written earlier in the same
 * statement, so real Postgres returns no row there. A query that only reads
 * the INSERT CTEs' own RETURNING output (via their CTE names) does see them.
 */
function simulateEvaluationRunCreationSql(): EvaluationRunSql {
  return async (strings, ...values) => {
    const query = queryText(strings);
    const withoutInserts = query.replace(
      /INSERT INTO evaluation_run(?:s|_candidates)\s*\([^)]*\)/gi,
      "",
    );

    if (/(?:FROM|JOIN)\s+evaluation_run(?:s|_candidates)\b/i.test(withoutInserts)) {
      return [];
    }

    const productIds = values.at(-1) as string[];

    return [{
      id: "7",
      importRef: values[0],
      status: "pending",
      startedAt: null,
      completedAt: null,
      notificationSent: false,
      createdAt: "2026-09-16T00:00:00.000Z",
      candidatesSelected: productIds.length,
      evaluationsCompleted: 0,
      evaluationsFailed: 0,
      pendingCandidates: productIds.length,
      batchesProcessed: 0,
    }];
  };
}

test("creates a pending run with ordered candidate membership", async () => {
  let query = "";
  let values: unknown[] = [];
  const sql: EvaluationRunSql = async (strings, ...queryValues) => {
    query = queryText(strings);
    values = queryValues;
    return [runRow];
  };

  const run = await createEvaluationRun(sql, {
    importRef: "abc123",
    candidateProductIds: ["42", "9"],
  });

  assert.deepEqual(run, runRow);
  assert.match(query, /INSERT INTO evaluation_runs/);
  assert.match(query, /INSERT INTO evaluation_run_candidates/);
  assert.match(query, /WITH ORDINALITY/);
  assert.deepEqual(values, [
    "abc123",
    JSON.stringify({ ref: "abc123", productsProcessed: 0, productsInserted: 0, productsUpdated: 0, snapshotsInserted: 0, productsEvaluated: 0 }),
    "[]",
    "[]",
    ["42", "9"],
  ]);
});

test("records the import's watched historical-low events with the run", async () => {
  let values: unknown[] = [];
  const sql: EvaluationRunSql = async (strings, ...queryValues) => {
    values = queryValues;
    return [runRow];
  };

  await createEvaluationRun(sql, {
    importRef: "abc123",
    candidateProductIds: ["42"],
    importContext: {
      productsProcessed: 1, productsInserted: 0, productsUpdated: 1, snapshotsInserted: 1, scanWarnings: [],
      watchedHistoricalLows: [{ productId: "5", dropPercent: 12.5 }],
    },
  });

  assert.equal(values[3], JSON.stringify([{ productId: "5", dropPercent: 12.5 }]));
});

test("creates a run from the INSERT CTEs' own RETURNING output, guarding against a base-table re-read", async () => {
  let query = "";
  const sql: EvaluationRunSql = async (strings, ...values) => {
    query = queryText(strings);
    return simulateEvaluationRunCreationSql()(strings, ...values);
  };

  const run = await createEvaluationRun(sql, {
    importRef: "abc123",
    candidateProductIds: ["42", "9", "17"],
  });

  assert.equal(run.id, "7");
  assert.equal(run.status, "pending");
  assert.equal(run.candidatesSelected, 3);
  assert.equal(run.pendingCandidates, 3);
  assert.equal(run.evaluationsCompleted, 0);
  assert.equal(run.evaluationsFailed, 0);
  assert.match(query, /FROM created_run/);
  assert.doesNotMatch(
    query.replace(/INSERT INTO evaluation_run(?:s|_candidates)\s*\([^)]*\)/gi, ""),
    /(?:FROM|JOIN)\s+evaluation_run(?:s|_candidates)\b/i,
  );
});

test("launch claiming is exclusive, releases failed starts, and marks only its owner", async () => {
  let claimed: string | null = null;
  let started = false;
  const sql: EvaluationRunSql = async (strings, ...values) => {
    const query = queryText(strings);
    if (query.includes("SET launch_claim_token = md5")) {
      if (claimed || started) return [];
      claimed = "owner-a";
      return [{ launchClaimToken: claimed }];
    }
    if (query.includes("SET launch_status = 'started'")) {
      if (values.at(-1) !== claimed) return [];
      started = true; claimed = null; return [{ id: "7" }];
    }
    if (query.includes("SET launch_claim_token = NULL")) {
      if (values.at(-1) === claimed) claimed = null;
      return [];
    }
    return [];
  };
  const first = await claimEvaluationRunLaunch(sql, "7");
  assert.equal(first, "owner-a");
  assert.equal(await claimEvaluationRunLaunch(sql, "7"), null);
  await releaseEvaluationRunLaunchClaim(sql, "7", "owner-a");
  assert.equal(await claimEvaluationRunLaunch(sql, "7"), "owner-a");
  assert.equal(await markEvaluationRunLaunched(sql, "7", "stale"), false);
  assert.equal(await markEvaluationRunLaunched(sql, "7", "owner-a"), true);
});

test("finds orphaned runs for launch recovery by pending status and launch_status only", async () => {
  let query = "";
  const sql: EvaluationRunSql = async (strings) => {
    query = queryText(strings);
    return [{ id: "1" }, { id: "2" }, { id: "not-a-run-id" }, { id: 3 }];
  };

  const pendingRunIds = await loadPendingEvaluationRunIds(sql);

  assert.deepEqual(pendingRunIds, ["1", "2"]);
  assert.match(query, /status = 'pending'/);
  assert.match(query, /launch_status = 'pending'/);
});

test("rejects missing, duplicate, and non-product candidate membership", async () => {
  const sql: EvaluationRunSql = async () => [runRow];

  await assert.rejects(
    createEvaluationRun(sql, { importRef: "abc123", candidateProductIds: [] }),
    /at least one selected candidate/,
  );
  await assert.rejects(
    createEvaluationRun(sql, { importRef: "abc123", candidateProductIds: ["42", "42"] }),
    /more than once/,
  );
  await assert.rejects(
    createEvaluationRun(sql, { importRef: "abc123", candidateProductIds: ["product-42"] }),
    /must be product IDs/,
  );
});

test("retrieves run state and the next pending candidates in selection order", async () => {
  const queries: string[] = [];
  const sql: EvaluationRunSql = async (strings) => {
    const query = queryText(strings);
    queries.push(query);
    return query.includes("COUNT(erc.product_id)")
      ? [runRow]
      : [
          { productId: "42", selectionPosition: 1 },
          { productId: "9", selectionPosition: 2 },
        ];
  };

  assert.deepEqual(await getEvaluationRun(sql, "7"), runRow);
  assert.deepEqual(await loadNextEvaluationBatch(sql, "7", 5), [
    { productId: "42", selectionPosition: 1 },
    { productId: "9", selectionPosition: 2 },
  ]);
  assert.match(queries[0], /COUNT\(erc.product_id\) FILTER/);
  assert.match(queries[1], /er.status = 'running'/);
  assert.match(queries[1], /erc.status = 'pending'/);
  assert.match(queries[1], /ORDER BY erc.selection_position ASC/);
});

test("has explicit, platform-independent state transitions for Slice 4", async () => {
  const queries: string[] = [];
  const sql: EvaluationRunSql = async (strings) => {
    const query = queryText(strings);
    queries.push(query);
    if (query.includes("SELECT") && query.includes("FROM evaluation_runs")) {
      return [{ ...runRow, status: "completed", pendingCandidates: 0, evaluationsCompleted: 1, evaluationsFailed: 1 }];
    }
    return [{ id: "7" }];
  };

  assert.equal((await startEvaluationRun(sql, "7"))?.status, "completed");
  assert.equal(await recordEvaluationCandidateOutcome(sql, { runId: "7", productId: "42", status: "completed" }), true);
  assert.equal(await recordEvaluationCandidateOutcome(sql, { runId: "7", productId: "9", status: "failed" }), true);
  assert.equal((await completeEvaluationRun(sql, "7"))?.status, "completed");
  assert.equal(await markEvaluationRunNotificationSent(sql, "7"), true);
  assert.ok(queries.some((query) => query.includes("status = 'running'")));
  assert.ok(queries.some((query) => query.includes("SET status = $parameter")));
  assert.ok(queries.some((query) => query.includes("SET status = 'completed'")));
  assert.ok(queries.some((query) => query.includes("notification_sent = TRUE")));
  assert.equal(await recordEvaluationBatchProcessed(sql, "7"), true);
  assert.ok(queries.some((query) => query.includes("SET batches_processed = batches_processed + 1")));
});

test("keeps the application persistence module free of Vercel dependencies", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../lib/evaluation-runs.mts", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /vercel/i);
});
