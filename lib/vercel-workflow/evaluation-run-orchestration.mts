import { neon } from "@neondatabase/serverless";
import {
  createEvaluationRun,
  type EvaluationRun,
} from "../evaluation-runs.mts";

/**
 * The Vercel Workflow adapter's entry point for creating application-owned
 * evaluation work. It intentionally does not schedule or process that work.
 */
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
