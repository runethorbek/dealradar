import assert from "node:assert/strict";
import test from "node:test";
import {
  getLatestDashboardProducts,
  snapshotSummaryFields,
  snapshotSummaryJoin,
} from "../lib/dashboard-product-query.mts";

type ProductRow = {
  id: string;
  lastSeenAt: string;
};

type QueryCall = {
  query: string;
  products: ProductRow[];
};

const cutoff = new Date("2026-09-03T12:00:00.000Z");
let listProducts: ProductRow[] = [];
let highlightedProducts: ProductRow[] = [];
let queryCalls: QueryCall[] = [];

function isFresh(product: ProductRow) {
  return new Date(product.lastSeenAt).getTime() >= cutoff.getTime();
}

async function sql(strings: TemplateStringsArray) {
  const query = strings.join("$parameter");

  if (!query.includes("FROM products")) {
    return [];
  }

  const products = query.includes("WHERE p.id =")
    ? highlightedProducts
    : listProducts;

  queryCalls.push({ query, products });

  return query.includes("p.last_seen_at >= NOW() - INTERVAL '24 hours'")
    ? products.filter(isFresh)
    : products;
}

function reset() {
  listProducts = [];
  highlightedProducts = [];
  queryCalls = [];
}

function assertFreshnessQuery(query: string) {
  assert.match(
    query,
    /p\.last_seen_at >= NOW\(\) - INTERVAL '24 hours'/,
  );
}

test("dashboard list queries return products at the inclusive cutoff and exclude stale products in SQL", async () => {
  reset();
  listProducts = [
    { id: "fresh", lastSeenAt: cutoff.toISOString() },
    { id: "stale", lastSeenAt: new Date(cutoff.getTime() - 1).toISOString() },
  ];

  const allSources = await getLatestDashboardProducts(
    sql,
    null,
    "best_match",
    "visible",
    null,
  );
  const sourceFiltered = await getLatestDashboardProducts(
    sql,
    "vinted.com",
    "best_match",
    "visible",
    null,
  );

  assert.deepEqual(allSources.map((product) => product.id), ["fresh"]);
  assert.deepEqual(sourceFiltered.map((product) => product.id), ["fresh"]);
  assert.equal(queryCalls.length, 2);
  for (const call of queryCalls) assertFreshnessQuery(call.query);
});

test("dashboard queries include SQL snapshot aggregates for count and minimum price", () => {
  const renderSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = "";

    strings.forEach((chunk, index) => {
      query += chunk;
      if (index < values.length) {
        query += String(values[index]);
      }
    });

    return query;
  };

  const fields = snapshotSummaryFields(renderSql);
  const join = snapshotSummaryJoin(renderSql);

  assert.match(fields, /COALESCE\(snapshot_stats\.observation_count, 0\)::INT AS "observationCount"/);
  assert.match(fields, /snapshot_stats\.lowest_observed_price::TEXT AS "lowestObservedPrice"/);
  assert.match(join, /COUNT\(current_price\) AS observation_count/);
  assert.doesNotMatch(join, /COUNT\(DISTINCT current_price\)/);
  assert.match(join, /MIN\(current_price\) AS lowest_observed_price/);
  assert.match(join, /WHERE current_price IS NOT NULL/);
});

test("the highlighted-product fallback cannot reintroduce a stale product", async () => {
  reset();
  highlightedProducts = [
    { id: "stale", lastSeenAt: new Date(cutoff.getTime() - 1).toISOString() },
  ];

  const result = await getLatestDashboardProducts(
    sql,
    null,
    "best_match",
    "visible",
    "stale",
  );

  assert.deepEqual(result, []);
  assert.equal(queryCalls.length, 2);
  for (const call of queryCalls) assertFreshnessQuery(call.query);
});
