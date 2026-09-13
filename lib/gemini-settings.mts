export type GeminiSettings = {
  automaticEvaluationLimit: number;
};

export const defaultGeminiSettings: GeminiSettings = {
  automaticEvaluationLimit: 50,
};

export const maximumAutomaticEvaluationLimit = 500;

export function parseGeminiSettings(value: unknown): GeminiSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const automaticEvaluationLimit = (value as Record<string, unknown>).automaticEvaluationLimit;
  if (
    typeof automaticEvaluationLimit !== "number" ||
    !Number.isInteger(automaticEvaluationLimit) ||
    automaticEvaluationLimit < 1 ||
    automaticEvaluationLimit > maximumAutomaticEvaluationLimit
  ) return null;

  return { automaticEvaluationLimit };
}
