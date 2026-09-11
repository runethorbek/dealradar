import type { ImportEvaluationResult } from "./import-evaluation.mts";
import {
  getOverallEvaluationScore,
  type ImportSlackHighlight,
} from "./import-notification.mts";

export type SlackHighlightCandidate = ImportEvaluationResult & {
  watched: boolean;
  feedback: "like" | "dislike" | null;
  preferenceScore: number | null;
  dealScore: number | null;
};

function getOverallScore(candidate: SlackHighlightCandidate) {
  if (
    candidate.preferenceScore === null ||
    candidate.dealScore === null ||
    !Number.isFinite(candidate.preferenceScore) ||
    !Number.isFinite(candidate.dealScore)
  ) {
    return null;
  }

  return getOverallEvaluationScore(
    candidate.preferenceScore,
    candidate.dealScore,
  );
}

function getPriceDropPercent(candidate: SlackHighlightCandidate) {
  if (candidate.priceDropPercent === null) {
    return null;
  }

  const priceDropPercent = Number(candidate.priceDropPercent);

  return Number.isFinite(priceDropPercent) && priceDropPercent > 0
    ? priceDropPercent
    : null;
}

function compareProductIds(left: SlackHighlightCandidate, right: SlackHighlightCandidate) {
  return left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0;
}

function comparePriceDropCandidates(left: SlackHighlightCandidate, right: SlackHighlightCandidate) {
  const priceDropDifference = getPriceDropPercent(right)! - getPriceDropPercent(left)!;

  if (priceDropDifference !== 0) {
    return priceDropDifference;
  }

  const leftOverallScore = getOverallScore(left);
  const rightOverallScore = getOverallScore(right);

  if (leftOverallScore === null && rightOverallScore !== null) {
    return 1;
  }

  if (leftOverallScore !== null && rightOverallScore === null) {
    return -1;
  }

  if (leftOverallScore !== null && rightOverallScore !== null) {
    const overallScoreDifference = rightOverallScore - leftOverallScore;

    if (overallScoreDifference !== 0) {
      return overallScoreDifference;
    }
  }

  return compareProductIds(left, right);
}

function toHighlight(candidate: SlackHighlightCandidate): ImportSlackHighlight {
  return {
    productId: candidate.productId,
    externalUrl: candidate.externalUrl,
    title: candidate.title,
    currentPrice: candidate.currentPrice,
    currency: candidate.currency,
    sourceCurrentPrice: candidate.sourceCurrentPrice,
    sourceCurrency: candidate.sourceCurrency,
    hidden: candidate.hidden,
    preferenceScore: candidate.preferenceScore,
    dealScore: candidate.dealScore,
  };
}

function selectPriceDropHighlight(candidates: SlackHighlightCandidate[], minimumPriceDropPercent: number) {
  const eligibleCandidates = candidates.filter(
    (candidate) =>
      !candidate.hidden &&
      !candidate.inserted &&
      (getPriceDropPercent(candidate) ?? 0) >= minimumPriceDropPercent,
  );

  if (eligibleCandidates.length === 0) {
    return null;
  }

  return toHighlight(eligibleCandidates.sort(comparePriceDropCandidates)[0]);
}

export function selectSlackHighlight(candidates: SlackHighlightCandidate[]): ImportSlackHighlight | null {
  const watchedHighlight = selectPriceDropHighlight(candidates.filter((candidate) => candidate.watched), 5);

  if (watchedHighlight) {
    return watchedHighlight;
  }

  const likedHighlight = selectPriceDropHighlight(candidates.filter((candidate) => candidate.feedback === "like"), 10);

  if (likedHighlight) {
    return likedHighlight;
  }

  const existingHighlight = selectPriceDropHighlight(
    candidates.filter((candidate) => !candidate.watched && candidate.feedback !== "like"),
    20,
  );

  if (existingHighlight) {
    return existingHighlight;
  }

  const newCandidates = candidates
    .filter(
      (candidate) =>
        !candidate.hidden &&
        candidate.inserted &&
        (getOverallScore(candidate) ?? 0) >= 7,
    )
    .sort((left, right) => {
      const overallScoreDifference = getOverallScore(right)! - getOverallScore(left)!;

      return overallScoreDifference || compareProductIds(left, right);
    });

  return newCandidates[0] ? toHighlight(newCandidates[0]) : null;
}
