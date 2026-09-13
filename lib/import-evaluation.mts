import type { ImportRecommendation } from "./import-notification.mts";

export type ImportEvaluationResult = {
  productId: string;
  externalUrl: string;
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
  | "externalUrl"
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
const maximumEvaluationRetries = 3;
const retryDelaysMs = [5_000, 10_000, 20_000];

export type EvaluationMetrics = {
  candidatesSelected: number;
  requestsAttempted: number;
  successfulEvaluations: number;
  failedEvaluations: number;
  retryAttempts: number;
  retryableFailures: number;
  rateLimitFailures: number;
  quotaFailures: number;
  permanentFailures: number;
  exhaustedRetries: number;
};

export type CandidateEvaluationRun = {
  evaluatedProducts: ImportRecommendation[];
  metrics: EvaluationMetrics;
};

type EvaluationOptions = {
  sleep?: (milliseconds: number) => Promise<void>;
};

type EvaluationFailureKind = "rate_limit" | "transient" | "permanent";

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function getErrorStatus(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}

export function classifyGeminiEvaluationFailure(
  error: unknown,
): EvaluationFailureKind {
  const status = getErrorStatus(error);

  if (status === 429) {
    // The SDK exposes HTTP status directly but keeps provider error details in
    // the message. RESOURCE_EXHAUSTED and quota wording do not establish that
    // the limit cannot recover after a short wait, so retry all HTTP 429s.
    return "rate_limit";
  }

  if (status === 408 || (status !== null && status >= 500 && status <= 599)) {
    return "transient";
  }

  return "permanent";
}

function isQuotaLikeGeminiFailure(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return /(?:quota|daily|per day|limit:\s*0|billing|credit|payment)/.test(
    message,
  );
}

function getFailureMessageCategory(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  if (message.includes("invalid evaluation")) {
    return "invalid_evaluation";
  }

  if (message.includes("product not found")) {
    return "product_not_found";
  }

  return getErrorStatus(error) === null ? "unexpected_error" : "provider_error";
}

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
      externalUrl: result.externalUrl,
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
  options: EvaluationOptions = {},
): Promise<CandidateEvaluationRun> {
  const metrics: EvaluationMetrics = {
    candidatesSelected: candidates.length,
    requestsAttempted: 0,
    successfulEvaluations: 0,
    failedEvaluations: 0,
    retryAttempts: 0,
    retryableFailures: 0,
    rateLimitFailures: 0,
    quotaFailures: 0,
    permanentFailures: 0,
    exhaustedRetries: 0,
  };

  if (!evaluateCandidate) {
    return { evaluatedProducts: [], metrics };
  }

  const evaluated: ImportRecommendation[] = [];
  const sleep = options.sleep ?? defaultSleep;

  for (const candidate of candidates) {
    let retries = 0;

    while (true) {
      metrics.requestsAttempted += 1;

      try {
        const evaluation = await evaluateCandidate(candidate);

        evaluated.push({
          productId: candidate.productId,
          externalUrl: candidate.externalUrl,
          title: candidate.title,
          currentPrice: candidate.currentPrice,
          currency: candidate.currency,
          sourceCurrentPrice: candidate.sourceCurrentPrice,
          sourceCurrency: candidate.sourceCurrency,
          hidden: candidate.hidden,
          preferenceScore: evaluation.preferenceScore,
          dealScore: evaluation.dealScore,
        });
        metrics.successfulEvaluations += 1;
        break;
      } catch (error) {
        const kind = classifyGeminiEvaluationFailure(error);

        if (kind === "rate_limit") {
          metrics.rateLimitFailures += 1;
        }
        if (isQuotaLikeGeminiFailure(error)) {
          metrics.quotaFailures += 1;
        }

        if (kind === "rate_limit" || kind === "transient") {
          metrics.retryableFailures += 1;
        }

        if (
          (kind === "rate_limit" || kind === "transient") &&
          retries < maximumEvaluationRetries
        ) {
          metrics.retryAttempts += 1;
          await sleep(retryDelaysMs[retries]);
          retries += 1;
          continue;
        }

        metrics.failedEvaluations += 1;
        if (kind === "rate_limit" || kind === "transient") {
          metrics.exhaustedRetries += 1;
        } else {
          metrics.permanentFailures += 1;
        }
        console.warn("DealRadar automatic evaluation failed.", {
          productId: candidate.productId,
          failureKind: kind,
          status: getErrorStatus(error),
          attempt: retries + 1,
          retriesUsed: retries,
          messageCategory: getFailureMessageCategory(error),
        });
        break;
      }
    }
  }

  return { evaluatedProducts: evaluated, metrics };
}
