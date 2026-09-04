export type Rating = "like" | "dislike";

export type ProductEvaluation = {
  preferenceScore: number;
  dealScore: number;
  reason: string;
  evaluatedAt: string;
};

export type ProductCardProduct = {
  id: string;
  externalUrl: string;
  title: string;
  imageUrl: string | null;
  source: string;
  currentPrice: string | null;
  originalPrice: string | null;
  currency: string | null;
  discountPercent: string | null;
  lastSeenAt: string;
  hidden: boolean;
  feedback: Rating | null;
  evaluation: ProductEvaluation | null;
};
