export type ProductEvaluation = {
  preferenceScore: number;
  dealScore: number;
  reason: string;
  translatedListingTextDa: string | null;
  evaluatedAt: string;
};

export type ProductCardProduct = {
  id: string;
  externalUrl: string;
  title: string;
  imageUrl: string | null;
  source: string;
  brand: string | null;
  currentPrice: string | null;
  originalPrice: string | null;
  currency: string | null;
  discountPercent: string | null;
  lastSeenAt: string;
  hidden: boolean;
  watched: boolean;
  evaluation: ProductEvaluation | null;
  observationCount?: number | null;
  lowestObservedPrice?: string | null;
  listingText?: string | null;
  articleCondition?: string | null;
  sizeGuess?: string | null;
};
