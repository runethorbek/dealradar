export type GeminiSettings = {
  automaticEvaluationLimit: number;
  workflowBatchSize: number;
};

export const defaultGeminiSettings: GeminiSettings = {
  automaticEvaluationLimit: 50,
  workflowBatchSize: 5,
};

export const maximumAutomaticEvaluationLimit = 500;
export const minimumWorkflowBatchSize = 1;
export const maximumWorkflowBatchSize = 10;

export function parseGeminiSettings(value: unknown): GeminiSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const automaticEvaluationLimit = (value as Record<string, unknown>).automaticEvaluationLimit;
  const configuredWorkflowBatchSize = (value as Record<string, unknown>).workflowBatchSize;
  if (
    typeof automaticEvaluationLimit !== "number" ||
    !Number.isInteger(automaticEvaluationLimit) ||
    automaticEvaluationLimit < 1 ||
    automaticEvaluationLimit > maximumAutomaticEvaluationLimit
  ) return null;

  if (
    configuredWorkflowBatchSize !== undefined &&
    (typeof configuredWorkflowBatchSize !== "number" ||
      !Number.isInteger(configuredWorkflowBatchSize) ||
      configuredWorkflowBatchSize < minimumWorkflowBatchSize ||
      configuredWorkflowBatchSize > maximumWorkflowBatchSize)
  ) return null;

  return {
    automaticEvaluationLimit,
    workflowBatchSize: configuredWorkflowBatchSize ?? defaultGeminiSettings.workflowBatchSize,
  };
}
