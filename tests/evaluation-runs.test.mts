import assert from "node:assert/strict";
import test from "node:test";
import {
  completeEvaluationRun,
  createEvaluationRun,
  getEvaluationRun,
  loadNextEvaluationBatch,
  markEvaluationRunNotificationSent,
  recordEvaluationCandidateOutcome,
  startEvaluationRun,
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
};

function queryText(strings: TemplateStringsArray) {
  return strings.join("$parameter");
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
  assert.deepEqual(values, ["abc123", ["42", "9"]]);
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
});

test("keeps the application persistence module free of Vercel dependencies", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../lib/evaluation-runs.mts", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /vercel/i);
});
