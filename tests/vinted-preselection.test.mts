import assert from "node:assert/strict";
import test from "node:test";
import { selectEvaluationCandidatesWithPreselection, type ImportEvaluationResult } from "../lib/import-evaluation.mts";

function candidate(productId: string, overrides: Partial<ImportEvaluationResult> = {}): ImportEvaluationResult {
  return {
    productId,
    externalUrl: `https://example.test/${productId}`,
    title: productId,
    currentPrice: "100",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    inserted: true,
    priceChanged: false,
    priceDropPercent: null,
    discountPercent: null,
    source: "vinted.com",
    brand: null,
    articleCondition: null,
    ...overrides,
  };
}

test("Vinted condition filtering uses the configured deterministic ordering and preserves missing values", () => {
  const { candidates, metrics } = selectEvaluationCandidatesWithPreselection([
    candidate("new-tags", { articleCondition: "Ny med prismærker" }),
    candidate("new-no-tags", { articleCondition: "Ny uden prismærker" }),
    candidate("very-good", { articleCondition: "Meget god" }),
    candidate("good", { articleCondition: "God" }),
    candidate("satisfactory", { articleCondition: "Tilfredsstillende" }),
    candidate("missing"),
  ], { minimumCondition: "Meget god", excludedBrands: [] });
  assert.deepEqual(candidates.map((item) => item.productId), ["new-tags", "new-no-tags", "very-good", "missing"]);
  assert.equal(metrics.excludedByCondition, 2);
});

test("Vinted excluded brands are trimmed and case-insensitive while unknown brands remain eligible", () => {
  const { candidates, metrics } = selectEvaluationCandidatesWithPreselection([
    candidate("hm", { brand: "H&M" }), candidate("lower", { brand: " h&m " }),
    candidate("zara", { brand: "Zara" }), candidate("zara-man", { brand: "Zara Man" }),
    candidate("hugo", { brand: "Hugo Boss" }), candidate("missing"),
  ], { minimumCondition: null, excludedBrands: [" H&M ", "zara"] });
  assert.deepEqual(candidates.map((item) => item.productId), ["zara-man", "hugo", "missing"]);
  assert.equal(metrics.excludedByBrand, 3);
});

test("Vinted filtering occurs before the default fifty-candidate cap and does not change Zalando selection", () => {
  const vinted = Array.from({ length: 70 }, (_, index) => candidate(`vinted-${index}`, { brand: index < 20 ? "Zara" : "Other" }));
  const zalando = candidate("zalando", { source: "zalando.dk", brand: "Zara", articleCondition: "God", priceDropPercent: "100" });
  const { candidates, metrics } = selectEvaluationCandidatesWithPreselection([...vinted, zalando], { minimumCondition: "Ny med prismærker", excludedBrands: ["zara"] });
  assert.equal(candidates.length, 50);
  assert.equal(metrics.excludedByBrand, 20);
  assert.ok(candidates.some((item) => item.productId === "zalando"));
});

test("automatic evaluation limit defaults to 50 and accepts configured lower and higher limits", () => {
  const results = Array.from({ length: 120 }, (_, index) => candidate(`candidate-${index}`));

  assert.equal(selectEvaluationCandidatesWithPreselection(results).candidates.length, 50);
  assert.equal(selectEvaluationCandidatesWithPreselection(results, undefined, 10).candidates.length, 10);
  assert.equal(selectEvaluationCandidatesWithPreselection(results, undefined, 100).candidates.length, 100);
});

test("automatic evaluation limit changes only the cutoff, not candidate ordering", () => {
  const results = [
    candidate("low", { priceDropPercent: "5" }),
    candidate("highest-discount", { discountPercent: "70" }),
    candidate("highest-drop", { priceDropPercent: "80" }),
    candidate("inserted", { inserted: true, priceChanged: false }),
    candidate("changed", { inserted: false, priceChanged: true, priceDropPercent: "100" }),
  ];

  const all = selectEvaluationCandidatesWithPreselection(results, undefined, 100).candidates.map((item) => item.productId);
  const limited = selectEvaluationCandidatesWithPreselection(results, undefined, 3).candidates.map((item) => item.productId);
  assert.deepEqual(limited, all.slice(0, 3));
});
