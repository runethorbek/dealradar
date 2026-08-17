import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeScarossoPrices,
  parseUsdToDkkRate,
} from "../lib/price-normalization.mts";

test("converts Scarosso USD prices to rounded DKK values", () => {
  assert.deepEqual(
    normalizeScarossoPrices(
      { currentPrice: 275, originalPrice: 465, currency: "USD" },
      6.4321,
    ),
    {
      currentPrice: 1768.83,
      originalPrice: 2990.93,
      currency: "DKK",
      sourceCurrentPrice: 275,
      sourceOriginalPrice: 465,
      sourceCurrency: "USD",
    },
  );
});

test("preserves source values without inventing DKK when the rate is missing", () => {
  assert.deepEqual(
    normalizeScarossoPrices(
      { currentPrice: 275, originalPrice: 465, currency: "USD" },
      null,
    ),
    {
      currentPrice: null,
      originalPrice: null,
      currency: null,
      sourceCurrentPrice: 275,
      sourceOriginalPrice: 465,
      sourceCurrency: "USD",
    },
  );
});

test("imports Scarosso prices without currency safely as source-only values", () => {
  assert.deepEqual(
    normalizeScarossoPrices(
      { currentPrice: 275, originalPrice: null, currency: null },
      6.4321,
    ),
    {
      currentPrice: null,
      originalPrice: null,
      currency: null,
      sourceCurrentPrice: 275,
      sourceOriginalPrice: null,
      sourceCurrency: null,
    },
  );
});

test("keeps Scarosso DKK prices unchanged", () => {
  assert.deepEqual(
    normalizeScarossoPrices(
      { currentPrice: 1200, originalPrice: 1800, currency: "DKK" },
      null,
    ),
    {
      currentPrice: 1200,
      originalPrice: 1800,
      currency: "DKK",
      sourceCurrentPrice: 1200,
      sourceOriginalPrice: 1800,
      sourceCurrency: "DKK",
    },
  );
});

test("accepts only a valid USD to DKK rate response", () => {
  assert.equal(
    parseUsdToDkkRate({ base: "USD", quote: "DKK", rate: 6.4321 }),
    6.4321,
  );
  assert.equal(
    parseUsdToDkkRate({ base: "EUR", quote: "DKK", rate: 7.46 }),
    null,
  );
  assert.equal(
    parseUsdToDkkRate({ base: "USD", quote: "DKK", rate: -1 }),
    null,
  );
});
