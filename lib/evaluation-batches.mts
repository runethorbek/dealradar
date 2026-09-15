import {
  completeEvaluationRun,
  getEvaluationRun,
  claimNextEvaluationBatch,
  recoverExpiredEvaluationCandidateClaims,
  recordEvaluationBatchProcessed,
  recordEvaluationCandidateOutcome,
  startEvaluationRun,
  type EvaluationRun,
  type EvaluationRunSql,
} from "./evaluation-runs.mts";
import { evaluateProductWithRetry, type EvaluationMetrics } from "./import-evaluation.mts";

export const evaluationBatchPacingMs = 10_000;

export type EvaluationBatchResult = {
  run: EvaluationRun;
  batchSize: number;
  candidatesAttempted: number;
  successfulEvaluations: number;
  failedEvaluations: number;
  metrics: EvaluationMetrics;
};

type ProcessEvaluationBatchDependencies = {
  sql: EvaluationRunSql;
  runId: string;
  batchSize: number;
  evaluateProduct: (productId: string) => Promise<{
    preferenceScore: number;
    dealScore: number;
  }>;
  retrySleep?: (milliseconds: number) => Promise<void>;
  paceSleep?: (milliseconds: number) => Promise<void>;
};

function emptyMetrics(): EvaluationMetrics {
  return {
    candidatesSelected: 0,
    requestsAttempted: 0,
    successfulEvaluations: 0,
    failedEvaluations: 0,
    retryAttempts: 0,
    retryableFailures: 0,
    rateLimitFailures: 0,
    quotaFailures: 0,
    permanentFailures: 0,
    exhaustedRetries: 0,
  };
}

function addMetrics(target: EvaluationMetrics, source: EvaluationMetrics) {
  for (const key of Object.keys(target) as Array<keyof EvaluationMetrics>) {
    target[key] += source[key];
  }
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Processes only persisted pending membership, so its state can be resumed
 * without orchestration state or the synchronous import route.
 */
export async function processEvaluationBatch(
  dependencies: ProcessEvaluationBatchDependencies,
): Promise<EvaluationBatchResult> {
  const { sql, runId, batchSize, evaluateProduct } = dependencies;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error("Evaluation batch size must be an integer from 1 to 10.");
  const retrySleep = dependencies.retrySleep ?? defaultSleep;
  const paceSleep = dependencies.paceSleep ?? defaultSleep;
  const started = await startEvaluationRun(sql, runId);
  const currentRun = started ?? await getEvaluationRun(sql, runId);

  if (!currentRun) throw new Error("Evaluation run was not found.");
  if (currentRun.status === "completed") {
    return { run: currentRun, batchSize, candidatesAttempted: 0, successfulEvaluations: 0, failedEvaluations: 0, metrics: emptyMetrics() };
  }
  if (currentRun.status !== "running") throw new Error("Evaluation run could not be started.");

  await recoverExpiredEvaluationCandidateClaims(sql, runId);
  const candidates = await claimNextEvaluationBatch(sql, runId, batchSize);
  const metrics = emptyMetrics();
  let successfulEvaluations = 0;
  let failedEvaluations = 0;

  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) await paceSleep(evaluationBatchPacingMs);

    const attempt = await evaluateProductWithRetry(
      candidate.productId,
      () => evaluateProduct(candidate.productId),
      { sleep: retrySleep },
    );
    addMetrics(metrics, attempt.metrics);
    const status = attempt.evaluation ? "completed" : "failed";
    const recorded = await recordEvaluationCandidateOutcome(sql, {
      runId,
      productId: candidate.productId,
      status,
    });

    if (!recorded) throw new Error("Evaluation candidate outcome could not be recorded.");
    if (status === "completed") successfulEvaluations += 1;
    else failedEvaluations += 1;
  }

  if (candidates.length > 0) await recordEvaluationBatchProcessed(sql, runId);
  const run = (await completeEvaluationRun(sql, runId)) ?? await getEvaluationRun(sql, runId);
  if (!run) throw new Error("Evaluation run disappeared during processing.");

  return {
    run,
    batchSize,
    candidatesAttempted: candidates.length,
    successfulEvaluations,
    failedEvaluations,
    metrics,
  };
}
