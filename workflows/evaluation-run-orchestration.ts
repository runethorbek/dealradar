import { neon } from "@neondatabase/serverless";
import { processEvaluationBatch, type EvaluationBatchResult } from "../lib/evaluation-batches.mts";
import { claimEvaluationRunLaunch, createEvaluationRun, loadPendingEvaluationRunIds, markEvaluationRunLaunched, releaseEvaluationRunLaunchClaim, type EvaluationRun } from "../lib/evaluation-runs.mts";
import { loadWorkflowBatchSize } from "../lib/evaluation-settings.mts";
import { evaluateProduct } from "../lib/product-evaluation.ts";
import { finalizeEvaluationRun } from "../lib/evaluation-finalization.mts";
import { postSlackMessage } from "../lib/slack.ts";
import { start } from "workflow/api";

/** The Vercel Workflow adapter; application progress remains in Postgres. */
export function createEvaluationRunForWorkflow(input: {
  databaseUrl: string;
  importRef: string;
  candidateProductIds: string[];
}): Promise<EvaluationRun> {
  return createEvaluationRun(neon(input.databaseUrl), {
    importRef: input.importRef,
    candidateProductIds: input.candidateProductIds,
  });
}

type ProcessEvaluationRunWorkflowInput = {
  databaseUrl: string;
  apiKey: string;
  runId: string;
};

export async function processEvaluationRunWithWorkflow(
  input: ProcessEvaluationRunWorkflowInput,
): Promise<EvaluationBatchResult> {
  "use workflow";

  const workflowBatchSize = await loadWorkflowBatchSizeStep(input.databaseUrl);
  let result: EvaluationBatchResult;
  do {
    result = await processEvaluationBatchStep({ ...input, workflowBatchSize });
  } while (result.run.pendingCandidates > 0);
  await finalizeEvaluationRunStep(input.databaseUrl, result.run);
  return result;
}

/** Starts durable execution without waiting for Gemini or final Slack. */
export async function startEvaluationRunWorkflow(input: ProcessEvaluationRunWorkflowInput) {
  const sql = neon(input.databaseUrl);
  const claimToken = await claimEvaluationRunLaunch(sql, input.runId);
  if (!claimToken) {
    console.info("[durable-launch] launch claim unavailable", { runId: input.runId });
    return null;
  }
  try {
    console.info("[durable-launch] starting workflow", { runId: input.runId });
    const run = await start(processEvaluationRunWithWorkflow, [input]);
    if (!await markEvaluationRunLaunched(sql, input.runId, claimToken)) throw new Error("Evaluation run launch claim was lost.");
    console.info("[durable-launch] workflow started", { runId: input.runId });
    return run;
  } catch (error) {
    console.error("[durable-launch] workflow start failed", { runId: input.runId, error });
    await releaseEvaluationRunLaunchClaim(sql, input.runId, claimToken);
    throw error;
  }
}

/** Re-enqueues persisted launch failures without creating another evaluation run. */
export async function resumePendingEvaluationRunWorkflows(input: Omit<ProcessEvaluationRunWorkflowInput, "runId">) {
  const pendingRunIds = await loadPendingEvaluationRunIds(neon(input.databaseUrl));
  for (const runId of pendingRunIds) {
    try { await startEvaluationRunWorkflow({ ...input, runId }); }
    catch { console.warn("DealRadar durable evaluation launch retry failed.", { runId }); }
  }
  return pendingRunIds;
}

async function loadWorkflowBatchSizeStep(databaseUrl: string): Promise<number> {
  "use step";

  return loadWorkflowBatchSize(neon(databaseUrl));
}

async function processEvaluationBatchStep(
  input: ProcessEvaluationRunWorkflowInput & { workflowBatchSize: number },
): Promise<EvaluationBatchResult> {
  "use step";

  return processEvaluationBatch({
    sql: neon(input.databaseUrl),
    runId: input.runId,
    batchSize: input.workflowBatchSize,
    evaluateProduct: (productId) => evaluateProduct({
      productId,
      databaseUrl: input.databaseUrl,
      apiKey: input.apiKey,
    }),
  });
}

async function finalizeEvaluationRunStep(databaseUrl: string, run: EvaluationBatchResult["run"]) {
  "use step";
  return finalizeEvaluationRun({ sql: neon(databaseUrl), run, postSlackMessage });
}
