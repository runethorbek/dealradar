import assert from "node:assert/strict";
import test from "node:test";
import {
  selectSlackHighlight,
  type SlackHighlightCandidate,
} from "../lib/slack-highlight.mts";

function candidate(
  productId: string,
  overrides: Partial<SlackHighlightCandidate> = {},
): SlackHighlightCandidate {
  return {
    productId,
    externalUrl: `https://retailer.example/products/${productId}`,
    title: `Product ${productId}`,
    currentPrice: "100.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    inserted: false,
    priceChanged: true,
    priceDropPercent: null,
    discountPercent: null,
    watched: false,
    feedback: null,
    preferenceScore: null,
    dealScore: null,
    ...overrides,
  };
}

test("Watched price drops take priority at the exact 5% boundary without an evaluation", () => {
  const highlight = selectSlackHighlight([
    candidate("new", { inserted: true, preferenceScore: 10, dealScore: 9 }),
    candidate("watched", { watched: true, priceDropPercent: "5" }),
  ]);

  assert.equal(highlight?.productId, "watched");
  assert.equal(highlight?.preferenceScore, null);
});

test("Watched drops below 5% do not qualify", () => {
  assert.equal(
    selectSlackHighlight([candidate("watched", { watched: true, priceDropPercent: "4.99" })]),
    null,
  );
});

test("Liked price drops take priority at the exact 10% boundary without an evaluation", () => {
  const highlight = selectSlackHighlight([
    candidate("generic", { priceDropPercent: "40" }),
    candidate("liked", { feedback: "like", priceDropPercent: "10" }),
  ]);

  assert.equal(highlight?.productId, "liked");
  assert.equal(highlight?.dealScore, null);
});

test("Liked drops below 10% do not qualify", () => {
  assert.equal(
    selectSlackHighlight([candidate("liked", { feedback: "like", priceDropPercent: "9.99" })]),
    null,
  );
});

test("generic existing price drops qualify at the exact 20% boundary without an evaluation", () => {
  const highlight = selectSlackHighlight([
    candidate("new", { inserted: true, preferenceScore: 10, dealScore: 10 }),
    candidate("generic", { priceDropPercent: "20" }),
  ]);

  assert.equal(highlight?.productId, "generic");
});

test("generic existing drops below 20% do not qualify", () => {
  assert.equal(
    selectSlackHighlight([candidate("generic", { priceDropPercent: "19.99" })]),
    null,
  );
});

test("larger drops, then existing evaluations, then product ID break price-drop ties", () => {
  assert.equal(
    selectSlackHighlight([
      candidate("b", { watched: true, priceDropPercent: "10", preferenceScore: 8, dealScore: 7 }),
      candidate("a", { watched: true, priceDropPercent: "10", preferenceScore: 8, dealScore: 7 }),
      candidate("no-evaluation", { watched: true, priceDropPercent: "10" }),
      candidate("largest", { watched: true, priceDropPercent: "11" }),
    ])?.productId,
    "largest",
  );
  assert.equal(
    selectSlackHighlight([
      candidate("lower-score", { watched: true, priceDropPercent: "10", preferenceScore: 7, dealScore: 7 }),
      candidate("higher-score", { watched: true, priceDropPercent: "10", preferenceScore: 8, dealScore: 8 }),
    ])?.productId,
    "higher-score",
  );
  assert.equal(
    selectSlackHighlight([
      candidate("without", { watched: true, priceDropPercent: "10" }),
      candidate("with", { watched: true, priceDropPercent: "10", preferenceScore: 7, dealScore: 7 }),
    ])?.productId,
    "with",
  );
  assert.equal(
    selectSlackHighlight([
      candidate("b", { watched: true, priceDropPercent: "10", preferenceScore: 8, dealScore: 7 }),
      candidate("a", { watched: true, priceDropPercent: "10", preferenceScore: 8, dealScore: 7 }),
    ])?.productId,
    "a",
  );
});

test("new products use the unrounded 60/40 score, including the exact 7.0 boundary", () => {
  assert.equal(
    selectSlackHighlight([
      candidate("below", { inserted: true, preferenceScore: 6, dealScore: 7 }),
      candidate("boundary", { inserted: true, preferenceScore: 7, dealScore: 7 }),
      candidate("higher", { inserted: true, preferenceScore: 8, dealScore: 8 }),
    ])?.productId,
    "higher",
  );
  assert.equal(
    selectSlackHighlight([candidate("below", { inserted: true, preferenceScore: 6, dealScore: 7 })]),
    null,
  );
});

test("hidden products, price increases, and missing valid price drops never qualify", () => {
  assert.equal(
    selectSlackHighlight([
      candidate("hidden", { watched: true, hidden: true, priceDropPercent: "50" }),
      candidate("increase", { watched: true, priceChanged: true, priceDropPercent: null }),
      candidate("cross-currency", { feedback: "like", priceChanged: true, priceDropPercent: null }),
    ]),
    null,
  );
});
