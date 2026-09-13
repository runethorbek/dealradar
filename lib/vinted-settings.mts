export const vintedArticleConditions = [
  "Tilfredsstillende",
  "God",
  "Meget god",
  "Ny uden prismærker",
  "Ny med prismærker",
] as const;

export type VintedArticleCondition = (typeof vintedArticleConditions)[number];

export type VintedSettings = {
  minimumCondition: VintedArticleCondition | null;
  excludedBrands: string[];
};

export const defaultVintedSettings: VintedSettings = {
  minimumCondition: null,
  excludedBrands: [],
};

export function parseVintedSettings(value: unknown): VintedSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  const minimumCondition = settings.minimumCondition;
  const excludedBrands = settings.excludedBrands;

  if (
    minimumCondition !== null &&
    !vintedArticleConditions.includes(minimumCondition as VintedArticleCondition)
  ) return null;
  if (!Array.isArray(excludedBrands) || excludedBrands.some((brand) => typeof brand !== "string")) return null;

  const normalizedBrands: string[] = [];
  for (const brand of excludedBrands.map((item) => item.trim()).filter(Boolean)) {
    if (!normalizedBrands.some((item) => item.toLocaleLowerCase() === brand.toLocaleLowerCase())) {
      normalizedBrands.push(brand);
    }
  }

  return {
    minimumCondition: minimumCondition as VintedArticleCondition | null,
    excludedBrands: normalizedBrands,
  };
}
