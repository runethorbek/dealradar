export type RankingSettings = {
  preferenceWeightPercent: number;
};

export const defaultRankingSettings: RankingSettings = {
  preferenceWeightPercent: 60,
};

export function getDealWeightPercent(preferenceWeightPercent: number) {
  return 100 - preferenceWeightPercent;
}

export function parseRankingSettings(value: unknown): RankingSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const preferenceWeightPercent = (value as Record<string, unknown>).preferenceWeightPercent;

  if (
    typeof preferenceWeightPercent !== "number" ||
    !Number.isInteger(preferenceWeightPercent) ||
    preferenceWeightPercent < 0 ||
    preferenceWeightPercent > 100
  ) return null;

  return { preferenceWeightPercent };
}

export function getOverallScore(
  preferenceScore: number,
  dealScore: number,
  preferenceWeightPercent: number = defaultRankingSettings.preferenceWeightPercent,
) {
  const dealWeightPercent = getDealWeightPercent(preferenceWeightPercent);
  return (preferenceScore * preferenceWeightPercent + dealScore * dealWeightPercent) / 100;
}
