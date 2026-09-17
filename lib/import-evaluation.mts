import type { ImportRecommendation } from "./import-notification.mts";
import {
  defaultVintedSettings,
  vintedArticleConditions,
  type VintedSettings,
} from "./vinted-settings.mts";
import { defaultGeminiSettings } from "./gemini-settings.mts";

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
  source?: string;
  brand?: string | null;
  listingText?: string | null;
  articleCondition?: string | null;
  sizeGuess?: string | null;
  translatedListingTextDa?: string | null;
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
  | "source"
  | "brand"
  | "articleCondition"
>;

type EvaluationScores = Pick<
  ImportRecommendation,
  "preferenceScore" | "dealScore"
>;

type EvaluateCandidate = (
  candidate: EvaluationCandidate,
) => Promise<EvaluationScores>;

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

export type PreselectionMetrics = {
  initialCandidates: number;
  excludedByCondition: number;
  excludedByBrand: number;
  eligibleCandidates: number;
  candidatesSelected: number;
};

type EvaluationOptions = {
  sleep?: (milliseconds: number) => Promise<void>;
};

export type CandidateEvaluationAttempt = {
  evaluation: EvaluationScores | null;
  metrics: EvaluationMetrics;
};

export async function evaluateProductWithRetry(
  productId: string,
  evaluateProduct: () => Promise<EvaluationScores>,
  options: EvaluationOptions = {},
): Promise<CandidateEvaluationAttempt> {
  const metrics = emptyEvaluationMetrics(1);
  const sleep = options.sleep ?? defaultSleep;
  let retries = 0;
  while (true) {
    metrics.requestsAttempted += 1;
    try {
      const evaluation = await evaluateProduct();
      metrics.successfulEvaluations += 1;
      return { evaluation, metrics };
    } catch (error) {
      const kind = classifyGeminiEvaluationFailure(error);
      if (kind === "rate_limit") metrics.rateLimitFailures += 1;
      if (isQuotaLikeGeminiFailure(error)) metrics.quotaFailures += 1;
      if (isRetryableEvaluationFailure(kind)) metrics.retryableFailures += 1;
      if (isRetryableEvaluationFailure(kind) && retries < maximumEvaluationRetries) {
        metrics.retryAttempts += 1;
        await sleep(retryDelaysMs[retries]);
        retries += 1;
        continue;
      }
      metrics.failedEvaluations += 1;
      if (isRetryableEvaluationFailure(kind)) metrics.exhaustedRetries += 1;
      else metrics.permanentFailures += 1;
      console.warn("DealRadar automatic evaluation failed.", { productId, failureKind: kind, status: getErrorStatus(error), attempt: retries + 1, retriesUsed: retries, messageCategory: getFailureMessageCategory(error), validationCategory: getEvaluationValidationCategory(error) });
      return { evaluation: null, metrics };
    }
  }
}

type EvaluationFailureKind =
  | "rate_limit"
  | "transient"
  | "invalid_evaluation"
  | "permanent";

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

  if (getEvaluationValidationCategory(error) !== null) {
    return "invalid_evaluation";
  }

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

function isRetryableEvaluationFailure(kind: EvaluationFailureKind) {
  return (
    kind === "rate_limit" ||
    kind === "transient" ||
    kind === "invalid_evaluation"
  );
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

function getEvaluationValidationCategory(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "validationCategory" in error &&
    typeof error.validationCategory === "string"
  ) {
    return error.validationCategory;
  }

  return null;
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

function selectCandidatesBeforeLimit(results: ImportEvaluationResult[]) {
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
      source: result.source,
      brand: result.brand,
      articleCondition: result.articleCondition,
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
    });
}

function normalizedBrand(brand: string) {
  return brand.trim().toLocaleLowerCase();
}

export function selectEvaluationCandidatesWithPreselection(
  results: ImportEvaluationResult[],
  settings: VintedSettings = defaultVintedSettings,
  automaticEvaluationLimit = defaultGeminiSettings.automaticEvaluationLimit,
) {
  const candidates = selectCandidatesBeforeLimit(results);
  const minimumConditionIndex = settings.minimumCondition
    ? vintedArticleConditions.indexOf(settings.minimumCondition)
    : -1;
  const excludedBrands = new Set(settings.excludedBrands.map(normalizedBrand));
  let excludedByCondition = 0;
  let excludedByBrand = 0;
  const eligible = candidates.filter((candidate) => {
    if (candidate.source !== "vinted.com") return true;
    const conditionIndex = candidate.articleCondition
      ? vintedArticleConditions.indexOf(candidate.articleCondition as (typeof vintedArticleConditions)[number])
      : -1;
    if (minimumConditionIndex >= 0 && conditionIndex >= 0 && conditionIndex < minimumConditionIndex) {
      excludedByCondition += 1;
      return false;
    }
    if (candidate.brand && excludedBrands.has(normalizedBrand(candidate.brand))) {
      excludedByBrand += 1;
      return false;
    }
    return true;
  });
  const selected = eligible.slice(0, automaticEvaluationLimit);
  return {
    candidates: selected,
    metrics: {
      initialCandidates: candidates.length,
      excludedByCondition,
      excludedByBrand,
      eligibleCandidates: eligible.length,
      candidatesSelected: selected.length,
    } satisfies PreselectionMetrics,
  };
}

export function selectEvaluationCandidates(results: ImportEvaluationResult[]) {
  return selectEvaluationCandidatesWithPreselection(results).candidates;
}

function emptyEvaluationMetrics(candidatesSelected: number): EvaluationMetrics {
  return {
    candidatesSelected,
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
}

export async function evaluateCandidateWithRetry(
  candidate: EvaluationCandidate,
  evaluateCandidate: EvaluateCandidate | null,
  options: EvaluationOptions = {},
): Promise<CandidateEvaluationAttempt> {
  if (!evaluateCandidate) return { evaluation: null, metrics: emptyEvaluationMetrics(1) };
  return evaluateProductWithRetry(candidate.productId, () => evaluateCandidate(candidate), options);
}

function addEvaluationMetrics(target: EvaluationMetrics, source: EvaluationMetrics) {
  for (const key of Object.keys(target) as Array<keyof EvaluationMetrics>) {
    target[key] += source[key];
  }
}

export async function evaluateCandidates(
  candidates: EvaluationCandidate[],
  evaluateCandidate: EvaluateCandidate | null,
  options: EvaluationOptions = {},
): Promise<CandidateEvaluationRun> {
  const metrics = emptyEvaluationMetrics(0);
  metrics.candidatesSelected = candidates.length;

  if (!evaluateCandidate) {
    return { evaluatedProducts: [], metrics };
  }

  const evaluated: ImportRecommendation[] = [];
  for (const candidate of candidates) {
    const attempt = await evaluateCandidateWithRetry(candidate, evaluateCandidate, options);
    addEvaluationMetrics(metrics, { ...attempt.metrics, candidatesSelected: 0 });
    if (attempt.evaluation) {
      evaluated.push({
        productId: candidate.productId,
        externalUrl: candidate.externalUrl,
        title: candidate.title,
        currentPrice: candidate.currentPrice,
        currency: candidate.currency,
        sourceCurrentPrice: candidate.sourceCurrentPrice,
        sourceCurrency: candidate.sourceCurrency,
        hidden: candidate.hidden,
        preferenceScore: attempt.evaluation.preferenceScore,
        dealScore: attempt.evaluation.dealScore,
      });
    }
  }

  return { evaluatedProducts: evaluated, metrics };
}
