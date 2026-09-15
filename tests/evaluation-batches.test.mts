import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { processEvaluationBatch } from "../lib/evaluation-batches.mts";
import type { EvaluationRunSql } from "../lib/evaluation-runs.mts";

function makeSql(productIds: string[]) {
  const candidates = productIds.map((productId, index) => ({ productId, selectionPosition: index + 1, status: "pending" }));
  let status = "pending";
  let batchesProcessed = 0;

  const runRow = () => ({
    id: "7", importRef: "abc123", status, startedAt: status === "pending" ? null : "2026-09-14T10:00:00.000Z",
    completedAt: status === "completed" ? "2026-09-14T10:01:00.000Z" : null,
    notificationSent: false, createdAt: "2026-09-14T10:00:00.000Z",
    candidatesSelected: candidates.length,
    evaluationsCompleted: candidates.filter((candidate) => candidate.status === "completed").length,
    evaluationsFailed: candidates.filter((candidate) => candidate.status === "failed").length,
    pendingCandidates: candidates.filter((candidate) => candidate.status === "pending" || candidate.status === "processing").length,
    batchesProcessed,
  });

  const sql: EvaluationRunSql = async (strings, ...values) => {
    const query = strings.join("$parameter");
    if (query.includes("SET status = 'running'")) {
      if (status !== "pending") return [];
      status = "running";
      return [{ id: "7" }];
    }
    if (query.includes("SET status = $parameter")) {
      const [candidateStatus, , productId] = values as ["completed" | "failed", string, string];
      const candidate = candidates.find((item) => item.productId === productId);
      if (!candidate || candidate.status !== "processing") return [];
      candidate.status = candidateStatus;
      return [{ product_id: productId }];
    }
    if (query.includes("SET status = CASE WHEN EXISTS")) return [];
    if (query.includes("SET batches_processed")) {
      batchesProcessed += 1;
      return [{ id: "7" }];
    }
    if (query.includes("SET status = 'completed'")) {
      if (candidates.some((candidate) => candidate.status === "pending" || candidate.status === "processing")) return [];
      status = "completed";
      return [{ id: "7" }];
    }
    if (query.includes("WITH next_candidates")) {
      const batchSize = values.at(-1) as number;
      return candidates.filter((candidate) => candidate.status === "pending").slice(0, batchSize).map((candidate) => { candidate.status = "processing"; return { productId: candidate.productId, selectionPosition: candidate.selectionPosition }; });
    }
    if (query.includes("SELECT") && query.includes("FROM evaluation_runs")) return [runRow()];
    throw new Error(`Unexpected query: ${query}`);
  };
  return { sql, runRow, candidates };
}

test("processes a run smaller than one batch and completes persisted progress", async () => {
  const state = makeSql(["1", "2"]);
  const calls: string[] = [];
  const result = await processEvaluationBatch({
    sql: state.sql, runId: "7", batchSize: 5,
    evaluateProduct: async (productId) => { calls.push(productId); return { preferenceScore: 8, dealScore: 7 }; },
    paceSleep: async () => {}, retrySleep: async () => {},
  });
  assert.deepEqual(calls, ["1", "2"]);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.batchesProcessed, 1);
  assert.equal(result.successfulEvaluations, 2);
  assert.equal(result.run.pendingCandidates, 0);
});

test("uses persisted pending state for multiple batches and does not repeat completed candidates", async () => {
  const state = makeSql(["1", "2", "3"]);
  const calls: string[] = [];
  const dependencies = {
    sql: state.sql, runId: "7", batchSize: 2,
    evaluateProduct: async (productId: string) => { calls.push(productId); return { preferenceScore: 8, dealScore: 7 }; },
    paceSleep: async () => {}, retrySleep: async () => {},
  };
  const first = await processEvaluationBatch(dependencies);
  assert.equal(first.run.status, "running");
  assert.equal(first.run.pendingCandidates, 1);
  const second = await processEvaluationBatch(dependencies);
  assert.equal(second.run.status, "completed");
  assert.deepEqual(calls, ["1", "2", "3"]);
  assert.equal(second.run.batchesProcessed, 2);
  const resumed = await processEvaluationBatch(dependencies);
  assert.equal(resumed.candidatesAttempted, 0);
  assert.deepEqual(calls, ["1", "2", "3"]);
});

test("records an exhausted failure, continues, and preserves #35 retry timing", async () => {
  const state = makeSql(["1", "2"]);
  const calls: string[] = [];
  const retryDelays: number[] = [];
  const paceDelays: number[] = [];
  const result = await processEvaluationBatch({
    sql: state.sql, runId: "7", batchSize: 2,
    evaluateProduct: async (productId) => {
      calls.push(productId);
      if (productId === "1") { const error = Object.assign(new Error("busy"), { status: 429 }); throw error; }
      return { preferenceScore: 8, dealScore: 7 };
    },
    retrySleep: async (milliseconds) => { retryDelays.push(milliseconds); },
    paceSleep: async (milliseconds) => { paceDelays.push(milliseconds); },
  });
  assert.deepEqual(calls, ["1", "1", "1", "1", "2"]);
  assert.deepEqual(retryDelays, [5_000, 10_000, 20_000]);
  assert.deepEqual(paceDelays, [10_000]);
  assert.equal(result.failedEvaluations, 1);
  assert.equal(result.successfulEvaluations, 1);
  assert.equal(result.run.evaluationsFailed, 1);
});

test("an overlapping batch cannot evaluate an already claimed candidate", async () => {
  const state = makeSql(["1"]);
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const first = processEvaluationBatch({ sql: state.sql, runId: "7", batchSize: 1, evaluateProduct: async () => { calls += 1; await waiting; return { preferenceScore: 8, dealScore: 7 }; }, paceSleep: async () => {}, retrySleep: async () => {} });
  await Promise.resolve();
  const overlapping = await processEvaluationBatch({ sql: state.sql, runId: "7", batchSize: 1, evaluateProduct: async () => { calls += 1; return { preferenceScore: 8, dealScore: 7 }; }, paceSleep: async () => {}, retrySleep: async () => {} });
  assert.equal(overlapping.candidatesAttempted, 0);
  assert.equal(calls, 1);
  release?.();
  await first;
  assert.equal(calls, 1);
});

test("rejects a batch size outside the application range", async () => {
  const state = makeSql(["1"]);
  await assert.rejects(processEvaluationBatch({ sql: state.sql, runId: "7", batchSize: 11, evaluateProduct: async () => ({ preferenceScore: 8, dealScore: 7 }) }), /1 to 10/);
});

test("recovers an expired persisted evaluation without calling Gemini again", async () => {
  let recovered = false;
  const row = (status: "running" | "completed") => ({ id: "7", importRef: "abc", status, startedAt: "2026-09-14T10:00:00.000Z", completedAt: status === "completed" ? "2026-09-14T10:01:00.000Z" : null, notificationSent: false, createdAt: "2026-09-14T10:00:00.000Z", candidatesSelected: 1, evaluationsCompleted: 1, evaluationsFailed: 0, pendingCandidates: 0, batchesProcessed: 0 });
  const sql: EvaluationRunSql = async (strings) => {
    const query = strings.join("$parameter");
    if (query.includes("SET status = 'running'")) return [];
    if (query.includes("SET status = CASE WHEN EXISTS")) { recovered = true; return []; }
    if (query.includes("WITH next_candidates") || query.includes("SET batches_processed")) return [];
    if (query.includes("SET status = 'completed'")) return [{ id: "7" }];
    if (query.includes("FROM evaluation_runs")) return [row(recovered ? "completed" : "running")];
    throw new Error(`Unexpected query: ${query}`);
  };
  let geminiCalls = 0;
  const result = await processEvaluationBatch({ sql, runId: "7", batchSize: 1, evaluateProduct: async () => { geminiCalls += 1; return { preferenceScore: 8, dealScore: 7 }; } });
  assert.equal(recovered, true);
  assert.equal(geminiCalls, 0);
  assert.equal(result.run.status, "completed");
});

test("batch processing has no Vercel dependency", async () => {
  const source = await readFile(
    new URL("../lib/evaluation-batches.mts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /vercel|workflow/i);
});
