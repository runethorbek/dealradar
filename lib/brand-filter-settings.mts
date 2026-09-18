export type BrandFilterSettings = {
  preferredBrands: string[];
};

export const defaultBrandFilterSettings: BrandFilterSettings = {
  preferredBrands: [],
};

export function parseBrandFilterSettings(value: unknown): BrandFilterSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const preferredBrands = (value as Record<string, unknown>).preferredBrands;

  if (!Array.isArray(preferredBrands) || preferredBrands.some((brand) => typeof brand !== "string")) return null;

  const normalizedBrands: string[] = [];
  for (const brand of preferredBrands.map((item) => item.trim()).filter(Boolean)) {
    if (!normalizedBrands.some((item) => item.toLocaleLowerCase() === brand.toLocaleLowerCase())) {
      normalizedBrands.push(brand);
    }
  }

  return { preferredBrands: normalizedBrands };
}
