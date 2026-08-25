import type { ImportRecommendation } from "./import-notification.mts";

export type ImportEvaluationResult = {
  productId: string;
  title: string;
  currentPrice: string | null;
  currency: string | null;
  sourceCurrentPrice: string | null;
  sourceCurrency: string | null;
  hidden: boolean;
  inserted: boolean;
  priceChanged: boolean;
  priceDropPercent: string | null;
  discountPercent: string | null;
};

export type EvaluationCandidate = Pick<
  ImportEvaluationResult,
  | "productId"
  | "title"
  | "currentPrice"
  | "currency"
  | "sourceCurrentPrice"
  | "sourceCurrency"
  | "hidden"
  | "inserted"
  | "priceDropPercent"
  | "discountPercent"
>;

type EvaluationScores = Pick<
  ImportRecommendation,
  "preferenceScore" | "dealScore"
>;

type EvaluateCandidate = (
  candidate: EvaluationCandidate,
) => Promise<EvaluationScores>;

const automaticEvaluationLimit = 50;
const evaluationConcurrency = 5;

function compareNullableNumbersDescending(
  leftValue: string | null,
  rightValue: string | null,
) {
  const left = leftValue === null ? null : Number(leftValue);
  const right = rightValue === null ? null : Number(rightValue);

  if (left === null && right === null) {
    return 0;
  }

  if (left === null || !Number.isFinite(left)) {
    return 1;
  }

  if (right === null || !Number.isFinite(right)) {
    return -1;
  }

  return right - left;
}

function maxNullableNumber(
  leftValue: string | null,
  rightValue: string | null,
) {
  const left = leftValue === null ? null : Number(leftValue);
  const right = rightValue === null ? null : Number(rightValue);

  if (left === null || !Number.isFinite(left)) {
    return rightValue;
  }

  if (right === null || !Number.isFinite(right)) {
    return leftValue;
  }

  return right > left ? rightValue : leftValue;
}

export function selectEvaluationCandidates(results: ImportEvaluationResult[]) {
  const candidatesByProduct = new Map<string, EvaluationCandidate>();

  for (const result of results) {
    if (!result.inserted && !result.priceChanged) {
      continue;
    }

    const existing = candidatesByProduct.get(result.productId);

    candidatesByProduct.set(result.productId, {
      productId: result.productId,
      title: result.title,
      currentPrice: result.currentPrice,
      currency: result.currency,
      sourceCurrentPrice: result.sourceCurrentPrice,
      sourceCurrency: result.sourceCurrency,
      hidden: result.hidden,
      inserted: result.inserted || existing?.inserted === true,
      priceDropPercent: maxNullableNumber(
        existing?.priceDropPercent ?? null,
        result.priceDropPercent,
      ),
      discountPercent: maxNullableNumber(
        existing?.discountPercent ?? null,
        result.discountPercent,
      ),
    });
  }

  return [...candidatesByProduct.values()]
    .sort((left, right) => {
      if (left.inserted !== right.inserted) {
        return left.inserted ? -1 : 1;
      }

      return (
        compareNullableNumbersDescending(
          left.priceDropPercent,
          right.priceDropPercent,
        ) ||
        compareNullableNumbersDescending(
          left.discountPercent,
          right.discountPercent,
        )
      );
    })
    .slice(0, automaticEvaluationLimit);
}

export async function evaluateCandidates(
  candidates: EvaluationCandidate[],
  evaluateCandidate: EvaluateCandidate | null,
) {
  if (!evaluateCandidate) {
    return [];
  }

  const evaluated: ImportRecommendation[] = [];

  for (let index = 0; index < candidates.length; index += evaluationConcurrency) {
    const batch = candidates.slice(index, index + evaluationConcurrency);
    const results = await Promise.allSettled(
      batch.map(async (candidate) => {
        const evaluation = await evaluateCandidate(candidate);

        return {
          productId: candidate.productId,
          title: candidate.title,
          currentPrice: candidate.currentPrice,
          currency: candidate.currency,
          sourceCurrentPrice: candidate.sourceCurrentPrice,
          sourceCurrency: candidate.sourceCurrency,
          hidden: candidate.hidden,
          preferenceScore: evaluation.preferenceScore,
          dealScore: evaluation.dealScore,
        };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        evaluated.push(result.value);
      }
    }
  }

  return evaluated;
}
