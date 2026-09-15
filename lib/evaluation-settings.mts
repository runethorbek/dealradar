import { defaultGeminiSettings, parseGeminiSettings } from "./gemini-settings.mts";
import type { EvaluationRunSql } from "./evaluation-runs.mts";

export async function loadWorkflowBatchSize(sql: EvaluationRunSql) {
  const [settings] = await sql`SELECT gemini FROM application_settings WHERE id = 1`;
  return parseGeminiSettings(settings?.gemini)?.workflowBatchSize ?? defaultGeminiSettings.workflowBatchSize;
}
