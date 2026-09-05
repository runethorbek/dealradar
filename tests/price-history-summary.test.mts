import assert from "node:assert/strict";
import test from "node:test";
import { getPriceHistorySummary } from "../lib/price-history-summary.mts";

test("returns no-history for one valid observation", () => {
  assert.deepEqual(getPriceHistorySummary(1, "699.00", "699.00"), {
    observationCount: 1,
    lowestObservedPrice: null,
    comparison: { kind: "no-history" },
  });
});

test("returns lowest-now for multiple observations with an unchanged price", () => {
  assert.deepEqual(getPriceHistorySummary("4", "699.00", "699.00"), {
    observationCount: 4,
    lowestObservedPrice: 699,
    comparison: { kind: "lowest-now" },
  });
});

test("returns the rounded percentage when the current price is above the minimum", () => {
  assert.deepEqual(getPriceHistorySummary(4, "699", "749"), {
    observationCount: 4,
    lowestObservedPrice: 699,
    comparison: { kind: "above-lowest", percentage: 7 },
  });
});

test("returns no comparison when the current price is missing", () => {
  assert.deepEqual(getPriceHistorySummary(4, "699", null), {
    observationCount: 4,
    lowestObservedPrice: 699,
    comparison: null,
  });
});

test("does not return a misleading summary for invalid aggregate values", () => {
  assert.equal(getPriceHistorySummary(null, "699", "749"), null);
  assert.equal(getPriceHistorySummary(0, "699", "749"), null);
  assert.equal(getPriceHistorySummary(4, undefined, "749"), null);
  assert.equal(getPriceHistorySummary(4, null, "749"), null);
  assert.equal(getPriceHistorySummary(4, "not-a-price", "749"), null);
  assert.deepEqual(getPriceHistorySummary(4, "699", "not-a-price"), {
    observationCount: 4,
    lowestObservedPrice: 699,
    comparison: null,
  });
});

test("rejects a current price below the aggregate minimum", () => {
  assert.equal(getPriceHistorySummary(4, "699", "649"), null);
});

test("does not calculate a percentage when the historical minimum is zero", () => {
  assert.deepEqual(getPriceHistorySummary(4, "0", "10"), {
    observationCount: 4,
    lowestObservedPrice: 0,
    comparison: null,
  });
});
