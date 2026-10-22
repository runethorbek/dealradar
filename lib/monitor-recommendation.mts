import { compareProductIds, zalandoSource } from "./import-notification.mts";
import { getOverallScore } from "./ranking-settings.mts";

// Monitor recommendation policy (#79; design D6-D10 in
// docs/specs/monitor-recommendation-design.md). Plain functions over a
// discriminated union: no database, Slack, Gemini, or Vercel dependency.
// Persistence lives in lib/monitor-recommendation-loader.mts.

export type MonitorPolicy =
  | {
      monitorId: string;
      source: string;
      displayName: string | null;
      strategy: "discount_threshold";
      minimumDiscountPercent: number;
    }
  | {
      monitorId: string;
      source: string;
      displayName: string | null;
      strategy: "best_match";
      minimumOverallScore: number;
    };

export type MonitorCandidate = {
  productId: string;
  title: string;
  externalUrl: string;
  source: string;
  currentPrice: string | null;
  currency: string | null;
  sourceCurrentPrice: string | null;
  sourceCurrency: string | null;
  discountPercent: number | null; // products.discount_percent
  preferenceScore: number | null; // null = not evaluated
  dealScore: number | null;
  hidden: boolean;
  lastSeenAt: string;
};

export type MonitorFreshness = "current" | "stale" | "never_scanned";

// One active monitor with its members and scan evidence
// (monitor_definitions.last_scan_checked_at), as returned by the loader.
export type MonitorMembers = {
  policy: MonitorPolicy;
  lastScanCheckedAt: string | null;
  candidates: MonitorCandidate[];
};

export type MonitorSelection = {
  monitorId: string;
  freshness: MonitorFreshness;
  qualifyingCount: number;
  unevaluatedQualifyingCount: number;
  best: MonitorCandidate | null;
};

// P3: the monitor scan window is 36 hours for both sources, and the product
// tolerance is 0.
export const monitorScanWindowMs = 36 * 60 * 60 * 1000;

export function getMonitorFreshness(lastScanCheckedAt: string | null, now: Date): MonitorFreshness {
  if (lastScanCheckedAt === null) return "never_scanned";

  const checkedAt = Date.parse(lastScanCheckedAt);

  // An unreadable timestamp is not evidence of a recent scan.
  if (Number.isNaN(checkedAt)) return "stale";

  return now.getTime() - checkedAt <= monitorScanWindowMs ? "current" : "stale";
}

// D7: a visible product seen in the monitor's latest scan (tolerance 0).
// Membership in products.monitor_ids is established by the loader.
export function isFreshVisibleCandidate(lastScanCheckedAt: string | null, candidate: MonitorCandidate) {
  if (candidate.hidden || lastScanCheckedAt === null) return false;

  const checkedAt = Date.parse(lastScanCheckedAt);
  const lastSeenAt = Date.parse(candidate.lastSeenAt);

  return !Number.isNaN(checkedAt) && !Number.isNaN(lastSeenAt) && lastSeenAt >= checkedAt;
}

function isEvaluated(candidate: MonitorCandidate) {
  return candidate.preferenceScore !== null && candidate.dealScore !== null;
}

function overallScore(candidate: MonitorCandidate, preferenceWeightPercent: number) {
  return isEvaluated(candidate)
    ? getOverallScore(candidate.preferenceScore!, candidate.dealScore!, preferenceWeightPercent)
    : null;
}

function parsePrice(value: string | null) {
  if (value === null) return null;

  const price = Number(value);

  return value.trim() !== "" && Number.isFinite(price) ? price : null;
}

// D8: the producer's discount_percent is used as stored, and only when it is
// reliable. This holds for every policy, so a discount on a non-Zalando
// product never qualifies.
export function isReliableDiscount(candidate: MonitorCandidate) {
  const price = parsePrice(candidate.currentPrice);
  const discount = candidate.discountPercent;

  return (
    candidate.source === zalandoSource &&
    discount !== null &&
    Number.isFinite(discount) &&
    discount > 0 &&
    discount < 100 &&
    price !== null &&
    price >= 0 &&
    candidate.currency !== null
  );
}

export function qualifies(policy: MonitorPolicy, candidate: MonitorCandidate, preferenceWeightPercent: number) {
  switch (policy.strategy) {
    case "best_match": {
      // An unevaluated product never qualifies (D9); Overall is unrounded.
      const overall = overallScore(candidate, preferenceWeightPercent);
      return overall !== null && overall >= policy.minimumOverallScore;
    }
    case "discount_threshold":
      return isReliableDiscount(candidate) && candidate.discountPercent! >= policy.minimumDiscountPercent;
  }
}

// Both strategies use today's order (P8(a)), matching
// selectOverallRecommendation in lib/import-notification.mts: higher
// Overall, then higher Deal score, then ascending product id. An unevaluated
// product sorts after every evaluated one.
export function compareQualified(
  policy: MonitorPolicy,
  left: MonitorCandidate,
  right: MonitorCandidate,
  preferenceWeightPercent: number,
) {
  switch (policy.strategy) {
    case "best_match":
    case "discount_threshold": {
      const leftOverall = overallScore(left, preferenceWeightPercent) ?? -Infinity;
      const rightOverall = overallScore(right, preferenceWeightPercent) ?? -Infinity;

      if (leftOverall !== rightOverall) return rightOverall > leftOverall ? 1 : -1;

      const leftDeal = left.dealScore ?? -Infinity;
      const rightDeal = right.dealScore ?? -Infinity;

      if (leftDeal !== rightDeal) return rightDeal > leftDeal ? 1 : -1;

      return compareProductIds(left.productId, right.productId);
    }
  }
}

function hasNormalizedPrice(candidate: MonitorCandidate) {
  return candidate.currentPrice !== null && candidate.currency !== null;
}

function hasSourcePrice(candidate: MonitorCandidate) {
  return candidate.sourceCurrentPrice !== null && candidate.sourceCurrency !== null;
}

// Each monitor is evaluated on its own (D10). Counts include unevaluated
// qualifying products (P2(b)); the best match is chosen only among evaluated
// qualifying products, after the display-price rule
// (docs/recommendation-policy.md, "Display price"), and only for a monitor
// whose latest scan is current (D7).
export function selectForMonitor(
  monitor: MonitorMembers,
  preferenceWeightPercent: number,
  now: Date,
): MonitorSelection {
  const { policy, lastScanCheckedAt } = monitor;
  const freshness = getMonitorFreshness(lastScanCheckedAt, now);
  const qualifying = monitor.candidates.filter(
    (candidate) =>
      isFreshVisibleCandidate(lastScanCheckedAt, candidate) &&
      qualifies(policy, candidate, preferenceWeightPercent),
  );
  const evaluated = qualifying.filter(isEvaluated);
  let best: MonitorCandidate | null = null;

  if (freshness === "current") {
    const normalizedPriceCandidates = evaluated.filter(hasNormalizedPrice);
    const pricedCandidates = normalizedPriceCandidates.length > 0
      ? normalizedPriceCandidates
      : evaluated.filter(hasSourcePrice);

    best = [...pricedCandidates].sort(
      (left, right) => compareQualified(policy, left, right, preferenceWeightPercent),
    )[0] ?? null;
  }

  return {
    monitorId: policy.monitorId,
    freshness,
    qualifyingCount: qualifying.length,
    unevaluatedQualifyingCount: qualifying.length - evaluated.length,
    best,
  };
}
