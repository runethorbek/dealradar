import assert from "node:assert/strict";
import test from "node:test";
import {
  formatImportSlackMessage,
  selectTopRecommendation,
  type ImportRecommendation,
} from "../lib/import-notification.mts";

const summary = {
  ref: "main",
  productsProcessed: 541,
  productsInserted: 138,
  productsUpdated: 403,
  snapshotsInserted: 358,
  productsEvaluated: 50,
};

const recommendations: ImportRecommendation[] = [
  {
    productId: "1",
    title: "Deal One",
    currentPrice: "900.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    preferenceScore: 8,
    dealScore: 7,
  },
  {
    productId: "2",
    title: "Deal Two",
    currentPrice: "1200.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    preferenceScore: 9,
    dealScore: 8,
  },
];

test("selects the recommendation with the highest rounded overall score", () => {
  assert.equal(selectTopRecommendation(recommendations)?.productId, "2");
});

test("prefers complete normalized pricing over a higher-ranked source-price fallback", () => {
  const sourcePriceOnly: ImportRecommendation = {
    productId: "3",
    title: "Source-priced deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
    preferenceScore: 10,
    dealScore: 10,
  };

  assert.equal(
    selectTopRecommendation([sourcePriceOnly, recommendations[0]])?.productId,
    "1",
  );
});

test("falls back to complete preserved source pricing", () => {
  const sourcePriceOnly: ImportRecommendation = {
    productId: "3",
    title: "Source-priced deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
    preferenceScore: 8,
    dealScore: 7,
  };

  assert.equal(selectTopRecommendation([sourcePriceOnly])?.productId, "3");
});

test("does not select a recommendation without a complete price and currency", () => {
  const incomplete: ImportRecommendation = {
    productId: "4",
    title: "Incomplete deal",
    currentPrice: "100.00",
    currency: null,
    sourceCurrentPrice: null,
    sourceCurrency: null,
    preferenceScore: 10,
    dealScore: 10,
  };

  assert.equal(selectTopRecommendation([incomplete]), null);
});

test("keeps the existing import summary when there is no recommendation", () => {
  assert.equal(
    formatImportSlackMessage(summary, null, "https://dealradar.example"),
    "DealRadar updated (main): 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated",
  );
});

test("appends a safe recommendation with scores, price, and DealRadar link", () => {
  const recommendation = {
    ...recommendations[1],
    title: "Shoes <Special> & Co.",
    currency: "DKK<test>",
  };

  assert.equal(
    formatImportSlackMessage(
      summary,
      recommendation,
      "https://dealradar.example",
    ),
    "DealRadar updated (main): 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated\n" +
      "Top recommendation: Shoes &lt;Special&gt; &amp; Co. · Preference 9/10 · Deal 8/10 · 1200.00 DKK&lt;test&gt; · " +
      "<https://dealradar.example/?product=2#product-2|View in DealRadar>",
  );
});

test("formats preserved source pricing when normalized pricing is unavailable", () => {
  const recommendation: ImportRecommendation = {
    productId: "5",
    title: "USD deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "275.00",
    sourceCurrency: "USD",
    preferenceScore: 8,
    dealScore: 6,
  };

  assert.match(
    formatImportSlackMessage(
      summary,
      recommendation,
      "https://dealradar.example",
    ),
    /275\.00 USD/,
  );
});
