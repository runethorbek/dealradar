import { neon } from "@neondatabase/serverless";
import { processEvaluationBatch, type EvaluationBatchResult } from "../lib/evaluation-batches.mts";
import { createEvaluationRun, type EvaluationRun } from "../lib/evaluation-runs.mts";
import { loadWorkflowBatchSize } from "../lib/evaluation-settings.mts";
import { evaluateProduct } from "../lib/product-evaluation.ts";

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
  return result;
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
