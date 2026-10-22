import assert from "node:assert/strict";
import test from "node:test";
import {
  compareQualified,
  getMonitorFreshness,
  isFreshVisibleCandidate,
  isReliableDiscount,
  qualifies,
  selectForMonitor,
  type MonitorCandidate,
  type MonitorMembers,
  type MonitorPolicy,
} from "../lib/monitor-recommendation.mts";
import { loadActiveMonitorMembers } from "../lib/monitor-recommendation-loader.mts";

const now = new Date("2026-10-22T12:00:00.000Z");
const scannedAt = "2026-10-22T03:40:00.000Z";
const w = 60;

const bestMatch: MonitorPolicy = {
  monitorId: "vinted-mens-blazers-size-s",
  source: "vinted.com",
  displayName: "Vinted – blazers",
  strategy: "best_match",
  minimumOverallScore: 7,
};

const discount: MonitorPolicy = {
  monitorId: "zalando-scarosso-shoes-42",
  source: "zalando.dk",
  displayName: null,
  strategy: "discount_threshold",
  minimumDiscountPercent: 20,
};

function candidate(overrides: Partial<MonitorCandidate>): MonitorCandidate {
  return {
    productId: "1",
    title: "Product",
    externalUrl: "https://www.zalando.dk/a",
    source: "zalando.dk",
    currentPrice: "500.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    discountPercent: 30,
    preferenceScore: 8,
    dealScore: 8,
    hidden: false,
    lastSeenAt: scannedAt,
    ...overrides,
  };
}

function select(
  policy: MonitorPolicy,
  candidates: MonitorCandidate[],
  lastScanCheckedAt: string | null = scannedAt,
) {
  const monitor: MonitorMembers = { policy, lastScanCheckedAt, candidates };
  return selectForMonitor(monitor, w, now);
}

test("best_match qualifies on unrounded Overall at or above the threshold; unevaluated never qualifies", () => {
  // Overall = (p * 60 + d * 40) / 100.
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: 7, dealScore: 7 }), w), true, "exactly 7");
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: 8, dealScore: 5 }), w), false, "6.8 is not rounded up");
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: 10, dealScore: 2 }), w), false, "6.8");
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: 5, dealScore: 10 }), w), true, "7.0");
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: 5, dealScore: 10 }), 70), false, "weight applies: 6.5");
  assert.equal(qualifies({ ...bestMatch, minimumOverallScore: 6.8 }, candidate({ preferenceScore: 8, dealScore: 5 }), w), true);
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: null, dealScore: null }), w), false);
  assert.equal(qualifies(bestMatch, candidate({ preferenceScore: 10, dealScore: null }), w), false);
  assert.equal(qualifies({ ...bestMatch, minimumOverallScore: 0 }, candidate({ preferenceScore: null, dealScore: null }), w), false);
});

test("discount_threshold qualifies only with a reliable discount at or above the threshold", () => {
  assert.equal(qualifies(discount, candidate({ discountPercent: 20 }), w), true, "exactly the threshold");
  assert.equal(qualifies(discount, candidate({ discountPercent: 19.9 }), w), false);
  assert.equal(qualifies(discount, candidate({ discountPercent: 99.9 }), w), true);
  assert.equal(qualifies(discount, candidate({ preferenceScore: null, dealScore: null }), w), true, "no evaluation needed");

  const unreliable: Array<[string, Partial<MonitorCandidate>]> = [
    ["non-Zalando source", { source: "vinted.com" }],
    ["null discount", { discountPercent: null }],
    ["zero discount", { discountPercent: 0 }],
    ["100% discount", { discountPercent: 100 }],
    ["negative discount", { discountPercent: -30 }],
    ["NaN discount", { discountPercent: Number.NaN }],
    ["null price", { currentPrice: null }],
    ["negative price", { currentPrice: "-1.00" }],
    ["unparsable price", { currentPrice: "abc" }],
    ["empty price", { currentPrice: "" }],
    ["null currency", { currency: null }],
  ];

  for (const [label, overrides] of unreliable) {
    assert.equal(isReliableDiscount(candidate({ ...overrides })), false, label);
    assert.equal(qualifies({ ...discount, minimumDiscountPercent: 1 }, candidate(overrides), w), false, label);
  }

  assert.equal(isReliableDiscount(candidate({ currentPrice: "0.00" })), true, "a zero price is reliable");
  assert.equal(
    qualifies({ ...discount, source: "vinted.com" }, candidate({ source: "vinted.com" }), w),
    false,
    "a discount_threshold policy on a non-Zalando source never qualifies",
  );
});

test("ranks by higher Overall, then higher Deal score, then ascending numeric product id", () => {
  const sorted = (policy: MonitorPolicy, candidates: MonitorCandidate[]) =>
    [...candidates].sort((left, right) => compareQualified(policy, left, right, w)).map((c) => c.productId);

  const candidates = [
    candidate({ productId: "10", preferenceScore: 8, dealScore: 8 }), // 8.0
    candidate({ productId: "2", preferenceScore: 8, dealScore: 8 }), // 8.0, smaller id
    candidate({ productId: "3", preferenceScore: 10, dealScore: 5 }), // 8.0, lower Deal
    candidate({ productId: "4", preferenceScore: 7, dealScore: 10 }), // 8.2
    candidate({ productId: "5", preferenceScore: 9, dealScore: 6 }), // 7.8
  ];

  for (const policy of [bestMatch, discount]) {
    assert.deepEqual(sorted(policy, candidates), ["4", "2", "10", "3", "5"], policy.strategy);
  }

  assert.equal(select(bestMatch, candidates).best?.productId, "4");
  assert.equal(select(discount, candidates).best?.productId, "4");
  assert.equal(select(bestMatch, candidates.slice(0, 3)).best?.productId, "2", "id tie-break is numeric");
  assert.equal(select(bestMatch, candidates.slice(2, 3).concat(candidates[0]!)).best?.productId, "10", "Deal tie-break");
});

test("best_match counts only qualifying products and never selects below the threshold", () => {
  const selection = select(bestMatch, [
    candidate({ productId: "1", preferenceScore: 8, dealScore: 8 }),
    candidate({ productId: "2", preferenceScore: 5, dealScore: 5 }),
    candidate({ productId: "3", preferenceScore: null, dealScore: null }),
  ]);

  assert.deepEqual(selection, {
    monitorId: bestMatch.monitorId,
    freshness: "current",
    qualifyingCount: 1,
    unevaluatedQualifyingCount: 0,
    best: selection.best,
  });
  assert.equal(selection.best?.productId, "1");

  const none = select(bestMatch, [candidate({ preferenceScore: 5, dealScore: 5 })]);
  assert.equal(none.qualifyingCount, 0);
  assert.equal(none.best, null);
  assert.deepEqual(select(bestMatch, []), {
    monitorId: bestMatch.monitorId,
    freshness: "current",
    qualifyingCount: 0,
    unevaluatedQualifyingCount: 0,
    best: null,
  });
});

test("discount_threshold counts unevaluated qualifying products and picks the best among evaluated ones", () => {
  const unevaluatedHigherDiscount = candidate({ productId: "1", discountPercent: 70, preferenceScore: null, dealScore: null });
  const evaluatedLow = candidate({ productId: "2", discountPercent: 25, preferenceScore: 3, dealScore: 4 });
  const evaluatedBelowThreshold = candidate({ productId: "3", discountPercent: 10, preferenceScore: 10, dealScore: 10 });

  const selection = select(discount, [unevaluatedHigherDiscount, evaluatedLow, evaluatedBelowThreshold]);
  assert.equal(selection.qualifyingCount, 2);
  assert.equal(selection.unevaluatedQualifyingCount, 1);
  assert.equal(selection.best?.productId, "2", "Overall threshold does not apply; discount size is not a criterion");

  const noneEvaluated = select(discount, [
    unevaluatedHigherDiscount,
    candidate({ productId: "4", discountPercent: 40, preferenceScore: null, dealScore: null }),
  ]);
  assert.deepEqual(noneEvaluated, {
    monitorId: discount.monitorId,
    freshness: "current",
    qualifyingCount: 2,
    unevaluatedQualifyingCount: 2,
    best: null,
  });
});

test("the display-price rule applies to best-match selection only", () => {
  const sourceOnly = candidate({
    productId: "1",
    source: "vinted.com",
    preferenceScore: 10,
    dealScore: 10,
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "20.00",
    sourceCurrency: "EUR",
  });
  const normalized = candidate({ productId: "2", source: "vinted.com", preferenceScore: 7, dealScore: 7 });
  const noPrice = candidate({
    productId: "3",
    source: "vinted.com",
    preferenceScore: 10,
    dealScore: 10,
    currentPrice: null,
    currency: null,
  });

  const preferred = select(bestMatch, [sourceOnly, normalized, noPrice]);
  assert.equal(preferred.qualifyingCount, 3, "products without a displayable price still count");
  assert.equal(preferred.best?.productId, "2", "a normalized pair is preferred over a higher Overall");

  const fallback = select(bestMatch, [sourceOnly, noPrice]);
  assert.equal(fallback.qualifyingCount, 2);
  assert.equal(fallback.best?.productId, "1", "source pair only when no candidate has a normalized pair");

  const unpriced = select(bestMatch, [noPrice]);
  assert.equal(unpriced.qualifyingCount, 1);
  assert.equal(unpriced.best, null);
});

test("monitor freshness: current within 36 hours, stale when older, never_scanned when null", () => {
  assert.equal(getMonitorFreshness("2026-10-21T00:00:00.000Z", now), "current", "exactly 36 hours");
  assert.equal(getMonitorFreshness("2026-10-20T23:59:59.999Z", now), "stale");
  assert.equal(getMonitorFreshness("2026-10-22 03:40:00+00", now), "current", "Postgres timestamp text");
  assert.equal(getMonitorFreshness("2026-10-21 00:00:00.000999+00", now), "current", "36 hours, microsecond text");
  assert.equal(getMonitorFreshness("2026-10-20 23:59:59.999999+00", now), "stale", "microsecond text");
  assert.equal(getMonitorFreshness("2026-10-22 03:40:12.345678+00", now), "current");
  assert.equal(getMonitorFreshness(null, now), "never_scanned");
  assert.equal(getMonitorFreshness("not a time", now), "stale");

  const staleScan = "2026-10-20T03:40:00.000Z";
  const stale = select(bestMatch, [candidate({ lastSeenAt: staleScan })], staleScan);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.qualifyingCount, 1);
  assert.equal(stale.best, null, "a stale monitor has no best match");

  const discountStale = select(discount, [candidate({ lastSeenAt: staleScan })], staleScan);
  assert.equal(discountStale.best, null);

  const neverScanned = select(bestMatch, [candidate({})], null);
  assert.deepEqual(neverScanned, {
    monitorId: bestMatch.monitorId,
    freshness: "never_scanned",
    qualifyingCount: 0,
    unevaluatedQualifyingCount: 0,
    best: null,
  });
});

test("only visible products seen in the latest scan are members (tolerance 0)", () => {
  assert.equal(isFreshVisibleCandidate(scannedAt, candidate({ lastSeenAt: scannedAt })), true, "equal");
  assert.equal(isFreshVisibleCandidate(scannedAt, candidate({ lastSeenAt: "2026-10-22T05:00:00.000Z" })), true);
  assert.equal(isFreshVisibleCandidate(scannedAt, candidate({ lastSeenAt: "2026-10-22T03:39:59.999Z" })), false);
  assert.equal(isFreshVisibleCandidate(scannedAt, candidate({ hidden: true })), false);
  assert.equal(isFreshVisibleCandidate(null, candidate({})), false);

  // Postgres ::TEXT timestamps carry microseconds; Date.parse keeps
  // milliseconds, which preserves the >= order.
  const scanText = "2026-10-22 03:40:12.345678+00";
  assert.equal(isFreshVisibleCandidate(scanText, candidate({ lastSeenAt: scanText })), true, "equal");
  assert.equal(
    isFreshVisibleCandidate(scanText, candidate({ lastSeenAt: "2026-10-22 03:40:12.345999+00" })),
    true,
    "later within the same millisecond",
  );
  assert.equal(
    isFreshVisibleCandidate(scanText, candidate({ lastSeenAt: "2026-10-22 03:40:12.346001+00" })),
    true,
  );
  assert.equal(
    isFreshVisibleCandidate(scanText, candidate({ lastSeenAt: "2026-10-22 03:40:12.344999+00" })),
    false,
    "an earlier millisecond",
  );
  assert.equal(
    isFreshVisibleCandidate(scanText, candidate({ lastSeenAt: "2026-10-22 05:40:12.345678+02" })),
    true,
    "offset text for the same instant",
  );

  const selection = select(bestMatch, [
    candidate({ productId: "1", hidden: true, preferenceScore: 10, dealScore: 10 }),
    candidate({ productId: "2", lastSeenAt: "2026-10-21T03:40:00.000Z", preferenceScore: 10, dealScore: 10 }),
    candidate({ productId: "3", preferenceScore: 7, dealScore: 7 }),
  ]);
  assert.equal(selection.qualifyingCount, 1, "Hidden and missed products are not counted");
  assert.equal(selection.best?.productId, "3");
});

test("each monitor is evaluated independently; one product can be the best match of several monitors", () => {
  const shared = candidate({ productId: "7", discountPercent: 50, preferenceScore: 9, dealScore: 9 });
  const other = candidate({ productId: "8", discountPercent: 15, preferenceScore: 10, dealScore: 10 });
  const strictBestMatch: MonitorPolicy = { ...bestMatch, monitorId: "zalando-best", source: "zalando.dk", minimumOverallScore: 9.5 };

  const selections = [
    select(discount, [shared, other]),
    select({ ...bestMatch, source: "zalando.dk" }, [shared, other]),
    select(strictBestMatch, [shared, other]),
  ];

  assert.deepEqual(
    selections.map((selection) => [selection.monitorId, selection.qualifyingCount, selection.best?.productId ?? null]),
    [
      [discount.monitorId, 1, "7"],
      [bestMatch.monitorId, 2, "8"],
      ["zalando-best", 1, "8"],
    ],
  );

  const secondDiscount = select({ ...discount, monitorId: "zalando-second" }, [shared]);
  assert.equal(secondDiscount.best?.productId, "7", "also the best match of another monitor");
});

test("the loader groups one query's rows into active monitors with parsed members", async () => {
  const calls: string[] = [];
  const monitorRow = {
    monitorId: "zalando-scarosso-shoes-42",
    monitorSource: "zalando.dk",
    displayName: "Scarosso",
    strategy: "discount_threshold",
    minimumDiscountPercent: "20.00",
    minimumOverallScore: null,
    lastScanCheckedAt: "2026-10-22 03:40:00+00",
  };
  const productRow = {
    productId: "5",
    title: "Shoe",
    externalUrl: "https://www.zalando.dk/shoe",
    source: "zalando.dk",
    currentPrice: "500.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    discountPercent: "35.50",
    hidden: false,
    lastSeenAt: "2026-10-22 03:40:00+00",
    preferenceScore: 7,
    dealScore: 6,
  };
  const nullProduct = Object.fromEntries(Object.keys(productRow).map((key) => [key, null]));
  const sql = async (strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return [
      { ...monitorRow, ...productRow },
      { ...monitorRow, ...productRow, productId: "6", discountPercent: "abc", preferenceScore: null, dealScore: null },
      {
        ...nullProduct,
        monitorId: "vinted-mens-blazers-size-s",
        monitorSource: "vinted.com",
        displayName: null,
        strategy: "best_match",
        minimumDiscountPercent: null,
        minimumOverallScore: "6.50",
        lastScanCheckedAt: null,
      },
      { ...monitorRow, ...productRow, monitorId: "broken", minimumDiscountPercent: null },
    ];
  };

  const monitors = await loadActiveMonitorMembers(sql);

  assert.equal(calls.length, 1, "one query");
  assert.deepEqual(monitors.map((monitor) => monitor.policy), [
    { monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", displayName: "Scarosso", strategy: "discount_threshold", minimumDiscountPercent: 20 },
    { monitorId: "vinted-mens-blazers-size-s", source: "vinted.com", displayName: null, strategy: "best_match", minimumOverallScore: 6.5 },
  ]);
  assert.equal(monitors[0]!.lastScanCheckedAt, "2026-10-22 03:40:00+00");
  assert.deepEqual(monitors[0]!.candidates.map((c) => [c.productId, c.discountPercent, c.preferenceScore]), [
    ["5", 35.5, 7],
    ["6", null, null],
  ]);
  assert.deepEqual(monitors[1]!.candidates, []);
  assert.equal(monitors[1]!.lastScanCheckedAt, null);

  const [selection] = monitors.map((monitor) => selectForMonitor(monitor, w, now));
  assert.equal(selection!.qualifyingCount, 1, "an unparsable discount is not reliable");
  assert.equal(selection!.best?.productId, "5");
});
