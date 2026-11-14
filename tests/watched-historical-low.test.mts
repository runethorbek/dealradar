import assert from "node:assert/strict";
import test from "node:test";
import {
  detectWatchedHistoricalLows,
  findWatchedHistoricalLows,
  type PriceObservation,
} from "../lib/watched-historical-low.mts";

// Builds one product's ascending history; the last observation is the one
// inserted by the current import.
function history(prices: Array<number | [number | null, string | null]>, productId = "1") {
  const observations = prices.map((entry, index): PriceObservation => {
    const [price, currency] = Array.isArray(entry) ? entry : [entry, "DKK"];
    return {
      snapshotId: `${productId}-${index}`,
      productId,
      currentPrice: price === null ? null : String(price),
      currency,
      sourceCurrentPrice: null,
      sourceCurrency: null,
    };
  });

  return { observations, inserted: new Set([observations.at(-1)!.snapshotId]) };
}

const drop = (previous: number, current: number) =>
  Math.round((previous - current) / previous * 100 * 10_000) / 10_000;

function detect(prices: Parameters<typeof history>[0]) {
  const { observations, inserted } = history(prices);
  return detectWatchedHistoricalLows(observations, inserted);
}

test("detects watched historical-low events per the documented examples", () => {
  assert.deepEqual(detect([500]), [], "first observation");
  assert.deepEqual(detect([500, 500]), [], "no drop");
  assert.deepEqual(detect([500, 500, 500]), [], "remaining at the low");
  assert.deepEqual(detect([500, 600, 500]), [{ productId: "1", snapshotId: "1-2", dropPercent: drop(600, 500) }], "returning low");
  assert.deepEqual(detect([500, 450]), [{ productId: "1", snapshotId: "1-1", dropPercent: drop(500, 450) }], "new all-time low");
  assert.deepEqual(detect([500, 600, 550]), [], "drop above the previous low");
  assert.deepEqual(detect([[500, "EUR"], [450, "DKK"]]), [], "no same-currency history");
  assert.deepEqual(
    detect([[500, null], [600, "DKK"], [500, "DKK"]]),
    [{ productId: "1", snapshotId: "1-2", dropPercent: drop(600, 500) }],
    "currency-less history is ignored",
  );
  assert.deepEqual(detect([[600, "DKK"], [500, null]]), [], "new observation without currency");
  assert.deepEqual(detect([[600, "DKK"], [null, "DKK"]]), [], "new observation without price");
});

test("compares against the most recent same-currency observation, skipping other currencies", () => {
  // Comparable history is 600 → 550; the EUR 100 is ignored, so 500 < 550 and <= 550.
  assert.deepEqual(detect([600, [100, "EUR"], 550, 500]), [{ productId: "1", snapshotId: "1-3", dropPercent: drop(550, 500) }]);
});

test("rounds drop percentages to 4 decimal places", () => {
  // 11 → 9.9 is 9.999999999999996 as an unrounded float; 500 → 450 is exactly 10.
  const noisy = history([11, 9.9], "1");
  const exact = history([500, 450], "2");
  const events = detectWatchedHistoricalLows(
    [...noisy.observations, ...exact.observations],
    new Set([...noisy.inserted, ...exact.inserted]),
  );
  assert.deepEqual(events, [
    { productId: "1", snapshotId: "1-1", dropPercent: 10 },
    { productId: "2", snapshotId: "2-1", dropPercent: 10 },
  ]);
});

test("does not qualify when the import inserted no observation or an older one", () => {
  const { observations } = history([500, 600, 500]);
  assert.deepEqual(detectWatchedHistoricalLows(observations, new Set()), [], "re-imported observation");
  assert.deepEqual(
    detectWatchedHistoricalLows(observations, new Set([observations[1]!.snapshotId])),
    [],
    "inserted observation is not the latest",
  );
});

test("compares the source pair when the new observation has a source price", () => {
  const observations: PriceObservation[] = [
    { snapshotId: "a", productId: "1", currentPrice: "100", currency: "DKK", sourceCurrentPrice: "20", sourceCurrency: "EUR" },
    { snapshotId: "b", productId: "1", currentPrice: "200", currency: "DKK", sourceCurrentPrice: "15", sourceCurrency: "EUR" },
  ];
  // Normalized DKK rose (100 → 200), but the compared source EUR pair dropped 20 → 15.
  assert.deepEqual(detectWatchedHistoricalLows(observations, new Set(["b"])), [{ productId: "1", snapshotId: "b", dropPercent: drop(20, 15) }]);
});

test("detects events independently per product", () => {
  const first = history([500, 400], "1");
  const second = history([500, 500], "2");
  const third = history([300, 200], "3");
  assert.deepEqual(
    detectWatchedHistoricalLows(
      [...first.observations, ...second.observations, ...third.observations],
      new Set([...first.inserted, ...second.inserted, ...third.inserted]),
    ),
    [
      { productId: "1", snapshotId: "1-1", dropPercent: drop(500, 400) },
      { productId: "3", snapshotId: "3-1", dropPercent: drop(300, 200) },
    ],
  );
});

test("finds events with one snapshot-history query and skips the query without Zalando snapshots", async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("$"), values });
    return [
      { snapshotId: "10", productId: "1", currentPrice: "500.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
      { snapshotId: "11", productId: "1", currentPrice: "600.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
      { snapshotId: "12", productId: "1", currentPrice: "500.00", currency: "DKK", sourceCurrentPrice: null, sourceCurrency: null },
    ];
  };

  assert.deepEqual(await findWatchedHistoricalLows(sql, []), []);
  assert.equal(queries.length, 0);

  assert.deepEqual(await findWatchedHistoricalLows(sql, ["12", "99"]), [{ productId: "1", snapshotId: "12", dropPercent: drop(600, 500) }]);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.text, /p\.watched/);
  assert.match(queries[0]!.text, /NOT p\.hidden/);
  assert.match(queries[0]!.text, /ORDER BY s\.product_id, s\.observed_at/);
  assert.deepEqual(queries[0]!.values, [["12", "99"], "zalando.dk"]);
});
