import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultRankingSettings,
  getDealWeightPercent,
  getOverallScore,
  parseRankingSettings,
} from "../lib/ranking-settings.mts";
import { getOverallEvaluationScore } from "../lib/import-notification.mts";

test("the default preference weight remains 60, deriving a 40 deal weight", () => {
  assert.equal(defaultRankingSettings.preferenceWeightPercent, 60);
  assert.equal(getDealWeightPercent(defaultRankingSettings.preferenceWeightPercent), 40);
});

test("a custom preference weight parses and derives the remaining deal weight", () => {
  assert.deepEqual(parseRankingSettings({ preferenceWeightPercent: 80 }), { preferenceWeightPercent: 80 });
  assert.equal(getDealWeightPercent(80), 20);
});

test("0 and 100 preference weight boundaries are valid and derive the opposite deal weight", () => {
  assert.deepEqual(parseRankingSettings({ preferenceWeightPercent: 0 }), { preferenceWeightPercent: 0 });
  assert.equal(getDealWeightPercent(0), 100);
  assert.deepEqual(parseRankingSettings({ preferenceWeightPercent: 100 }), { preferenceWeightPercent: 100 });
  assert.equal(getDealWeightPercent(100), 0);
});

test("invalid ranking settings are rejected rather than silently accepted", () => {
  for (const value of [
    { preferenceWeightPercent: -1 },
    { preferenceWeightPercent: 101 },
    { preferenceWeightPercent: 50.5 },
    { preferenceWeightPercent: "60" },
    { preferenceWeightPercent: null },
    {},
    null,
    [],
    "60",
  ]) {
    assert.equal(parseRankingSettings(value), null);
  }
});

test("storing both weights independently is not supported by the parsed shape", () => {
  const parsed = parseRankingSettings({ preferenceWeightPercent: 60, dealWeightPercent: 40 });
  assert.deepEqual(parsed, { preferenceWeightPercent: 60 });
  assert.ok(parsed && !("dealWeightPercent" in parsed));
});

test("getOverallScore computes the weighted combination and defaults to 60/40", () => {
  assert.equal(getOverallScore(9, 3, 60), 6.6);
  assert.equal(getOverallScore(9, 3), 6.6);
  assert.equal(getOverallScore(9, 3, 90), 8.4);
  assert.equal(getOverallScore(9, 3, 0), 3);
  assert.equal(getOverallScore(9, 3, 100), 9);
});

test("import-notification's getOverallEvaluationScore stays consistent with the canonical ranking formula", () => {
  for (const [preferenceScore, dealScore, preferenceWeightPercent] of [
    [8, 7, 60],
    [9, 3, 20],
    [3, 9, 80],
    [5, 5, 0],
    [5, 5, 100],
  ] as const) {
    assert.equal(
      getOverallEvaluationScore(preferenceScore, dealScore, preferenceWeightPercent),
      getOverallScore(preferenceScore, dealScore, preferenceWeightPercent),
    );
  }
});

test("the dashboard SQL's rounded weighted formula agrees with the canonical formula", () => {
  for (const [preferenceScore, dealScore, preferenceWeightPercent] of [
    [8, 7, 60],
    [9, 3, 20],
    [3, 9, 80],
    [6, 6, 0],
    [6, 6, 100],
  ] as const) {
    const dealWeightPercent = getDealWeightPercent(preferenceWeightPercent);
    const sqlEquivalent = Math.round(
      (preferenceScore * preferenceWeightPercent) / 100 + (dealScore * dealWeightPercent) / 100,
    );
    assert.equal(sqlEquivalent, Math.round(getOverallScore(preferenceScore, dealScore, preferenceWeightPercent)));
  }
});
