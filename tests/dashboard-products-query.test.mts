import assert from "node:assert/strict";
import test from "node:test";
import { getLatestDashboardProducts } from "../lib/dashboard-product-query.mts";

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
