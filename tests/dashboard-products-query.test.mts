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
  source?: string;
  hidden?: boolean;
  watched?: boolean;
  observationCount?: number;
  lowestObservedPrice?: string | null;
  currency?: string | null;
};

type SnapshotRow = {
  productId: string;
  currentPrice: number | null;
  currency: string | null;
};

type QueryCall = {
  query: string;
  values: unknown[];
  products: ProductRow[];
};

const cutoff = new Date("2026-09-03T12:00:00.000Z");
let listProducts: ProductRow[] = [];
let highlightedProducts: ProductRow[] = [];
let snapshots: SnapshotRow[] = [];
let queryCalls: QueryCall[] = [];

function isFresh(product: ProductRow) {
  return new Date(product.lastSeenAt).getTime() >= cutoff.getTime();
}

async function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  const query = strings.join("$parameter");

  if (!query.includes("FROM products")) {
    return [];
  }

  const products = query.includes("WHERE p.id =")
    ? highlightedProducts
    : listProducts;

  queryCalls.push({ query, values, products });

  const freshProducts = query.includes(
    "p.last_seen_at >= NOW() - INTERVAL '24 hours'",
  )
    ? products.filter(isFresh)
    : products;

  const source = query.includes("p.source =")
    ? values.find(
        (value): value is string =>
          typeof value === "string" && value.includes("."),
      )
    : undefined;
  const sourceFilteredProducts = source
    ? freshProducts.filter((product) => product.source === source)
    : freshProducts;

  const highlightedViewFilteredProducts = query.includes("OR p.watched = TRUE")
    ? sourceFilteredProducts.filter((product) => {
        const allowAnyProduct = values.find(
          (value): value is boolean => typeof value === "boolean",
        );
        return allowAnyProduct || product.watched === true;
      })
    : sourceFilteredProducts;

  const viewFilteredProducts = query.includes("AND p.watched = TRUE")
    ? highlightedViewFilteredProducts.filter((product) => {
        const [watchlist, , hidden] = values.filter(
          (value): value is boolean => typeof value === "boolean",
        );
        return watchlist
          ? product.watched === true
          : (product.hidden ?? false) === hidden;
      })
    : highlightedViewFilteredProducts;

  return viewFilteredProducts.map((product) => {
    const validSnapshots = snapshots
      .filter((snapshot) => snapshot.productId === product.id)
      .filter(
        (snapshot): snapshot is SnapshotRow & { currentPrice: number } =>
          snapshot.currentPrice !== null &&
          snapshot.currentPrice >= 0 &&
          snapshot.currency !== null &&
          product.currency !== null &&
          snapshot.currency === product.currency,
      );

    return {
      ...product,
      observationCount: validSnapshots.length,
      lowestObservedPrice:
        validSnapshots.length > 0
          ? String(Math.min(...validSnapshots.map((snapshot) => snapshot.currentPrice)))
          : null,
    };
  });
}

function reset() {
  listProducts = [];
  highlightedProducts = [];
  snapshots = [];
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
    { id: "fresh", lastSeenAt: cutoff.toISOString(), source: "vinted.com" },
    {
      id: "stale",
      lastSeenAt: new Date(cutoff.getTime() - 1).toISOString(),
      source: "vinted.com",
    },
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

  const fields = snapshotSummaryFields(renderSql) as string;
  const join = snapshotSummaryJoin(renderSql) as string;

  assert.match(fields, /COALESCE\(snapshot_stats\.observation_count, 0\)::INT AS "observationCount"/);
  assert.match(fields, /snapshot_stats\.lowest_observed_price::TEXT AS "lowestObservedPrice"/);
  assert.match(join, /LEFT JOIN LATERAL/);
  assert.match(join, /COUNT\(current_price\) AS observation_count/);
  assert.doesNotMatch(join, /COUNT\(DISTINCT current_price\)/);
  assert.match(join, /MIN\(current_price\) AS lowest_observed_price/);
  assert.match(
    join,
    /WHERE product_id = p\.id\s+AND current_price IS NOT NULL\s+AND current_price >= 0\s+AND currency IS NOT NULL\s+AND p\.currency IS NOT NULL\s+AND currency = p\.currency/,
  );
});

test("dashboard query aggregates repeated valid prices and ignores null and negative prices", async () => {
  reset();
  listProducts = [{
    id: "product-1",
    lastSeenAt: cutoff.toISOString(),
    currency: "DKK",
  }];
  snapshots = [
    { productId: "product-1", currentPrice: 100, currency: "DKK" },
    { productId: "product-1", currentPrice: 100, currency: "DKK" },
    { productId: "product-1", currentPrice: null, currency: "DKK" },
    { productId: "product-1", currentPrice: -10, currency: "DKK" },
    { productId: "product-1", currentPrice: 80, currency: "DKK" },
  ];

  const result = await getLatestDashboardProducts(
    sql,
    null,
    "best_match",
    "visible",
    null,
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.observationCount, 3);
  assert.equal(result[0]?.lowestObservedPrice, "80");
  assert.equal(queryCalls.length, 1);
});

test("dashboard query compares only historical prices with the product's explicit currency", async (t) => {
  for (const [description, productCurrency, snapshotCurrency, expectedCount] of [
    ["DKK to DKK", "DKK", "DKK", 1],
    ["DKK to EUR", "EUR", "DKK", 0],
    ["null to null", null, null, 0],
    ["null to DKK", "DKK", null, 0],
    ["DKK to null", null, "DKK", 0],
  ] as const) {
    await t.test(description, async () => {
      reset();
      listProducts = [{
        id: "product-1",
        lastSeenAt: cutoff.toISOString(),
        currency: productCurrency,
      }];
      snapshots = [{
        productId: "product-1",
        currentPrice: 100,
        currency: snapshotCurrency,
      }];

      const [product] = await getLatestDashboardProducts(
        sql,
        null,
        "best_match",
        "visible",
        null,
      );

      assert.equal(product?.observationCount, expectedCount);
      assert.equal(product?.lowestObservedPrice, expectedCount ? "100" : null);
    });
  }
});

test("Watchlist returns watched products only and includes persisted Watch state", async () => {
  reset();
  listProducts = [
    {
      id: "visible-watched",
      lastSeenAt: cutoff.toISOString(),
      hidden: false,
      watched: true,
    },
    {
      id: "hidden-watched",
      lastSeenAt: cutoff.toISOString(),
      hidden: true,
      watched: true,
    },
    {
      id: "not-watched",
      lastSeenAt: cutoff.toISOString(),
      hidden: false,
      watched: false,
    },
  ];

  const result = await getLatestDashboardProducts(
    sql,
    null,
    "best_match",
    "watchlist",
    null,
  );

  assert.deepEqual(
    result.map(({ id, hidden, watched }) => ({ id, hidden, watched })),
    [
      { id: "visible-watched", hidden: false, watched: true },
      { id: "hidden-watched", hidden: true, watched: true },
    ],
  );
  assert.match(queryCalls[0]?.query ?? "", /p\.watched = TRUE/);
  assert.match(queryCalls[0]?.query ?? "", /p\.watched,/);
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

test("the highlighted-product fallback cannot reintroduce an unwatched product into Watchlist", async () => {
  reset();
  highlightedProducts = [
    {
      id: "not-watched",
      lastSeenAt: cutoff.toISOString(),
      watched: false,
    },
  ];

  const result = await getLatestDashboardProducts(
    sql,
    null,
    "best_match",
    "watchlist",
    "not-watched",
  );

  assert.deepEqual(result, []);
  assert.equal(queryCalls.length, 2);
  assert.match(queryCalls[1]?.query ?? "", /OR p\.watched = TRUE/);
});

test("the highlighted-product fallback respects the selected source", async () => {
  reset();
  highlightedProducts = [
    {
      id: "scarosso-product",
      lastSeenAt: cutoff.toISOString(),
      source: "scarosso.com",
    },
  ];

  const result = await getLatestDashboardProducts(
    sql,
    "vinted.com",
    "best_match",
    "visible",
    "scarosso-product",
  );

  assert.deepEqual(result, []);
  assert.equal(queryCalls.length, 2);
  assert.match(queryCalls[1]?.query ?? "", /p\.source = \$parameter/);
  assert.ok(queryCalls[1]?.values.includes("vinted.com"));
});
