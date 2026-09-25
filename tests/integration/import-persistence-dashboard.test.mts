import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  persistImportedProducts,
  type ImportPersistenceSql,
  type NormalizedProduct,
} from "@/lib/import-persistence.mts";
import { getLatestDashboardProducts, type DashboardSql } from "@/lib/dashboard-product-query.mts";
import { findWatchedHistoricalLows, loadWatchedHistoricalLowCandidates } from "@/lib/watched-historical-low.mts";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

function readMigrationsInOrder() {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]))
    .map((file) => readFileSync(path.join(migrationsDir, file), "utf8"));
}

function product(overrides: Partial<NormalizedProduct>): NormalizedProduct {
  return {
    source: "zalando.dk",
    externalUrl: "https://www.zalando.dk/example",
    title: "Example product",
    imageUrl: null,
    currentPrice: 100,
    originalPrice: 200,
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceOriginalPrice: null,
    sourceCurrency: null,
    discountPercent: 50,
    available: true,
    brand: "ExampleBrand",
    observedAt: new Date().toISOString(),
    rawData: {},
    ...overrides,
  };
}

let container: StartedPostgreSqlContainer;
let sql: ReturnType<typeof postgres>;
let importSql: ImportPersistenceSql;

before(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();

  try {
    // Migration files issue their own BEGIN/COMMIT; postgres.js refuses
    // transaction-control statements through `unsafe()` unless the client is
    // pinned to a single connection (max: 1), since a pooled connection
    // could otherwise split a transaction across sockets.
    sql = postgres(container.getConnectionUri(), { max: 1 });

    for (const migration of readMigrationsInOrder()) {
      // `unsafe()` uses the simple query protocol, which (unlike the
      // prepared/extended protocol used by tagged-template queries) allows
      // a single call to run the migration file's multiple
      // semicolon-separated statements in order.
      await sql.unsafe(migration);
    }

    // `persistImportedProducts` calls `sql.transaction(queries)`, matching
    // @neondatabase/serverless's HTTP batch-transaction API. postgres.js has
    // no equivalent, so this adapts the real connection to that one method:
    // each query built by `persistImportedProducts` is already a single,
    // independently atomic upsert statement, so running them concurrently
    // reproduces the same persisted result without reimplementing Neon's
    // HTTP batching.
    const taggedQuery = (strings: TemplateStringsArray, ...values: unknown[]) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>)(
        strings,
        ...values,
      );
    importSql = Object.assign(taggedQuery, {
      transaction: (queries: PromiseLike<unknown[]>[]) => Promise.all(queries),
    }) as unknown as ImportPersistenceSql;
  } catch (error) {
    await container.stop();
    throw error;
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

test("persists a synthetic import through real persistence SQL and reads it back through the real dashboard query", async () => {
  const products: NormalizedProduct[] = [
    product({
      externalUrl: "https://www.zalando.dk/product-a",
      title: "Product A",
      currentPrice: 100,
      discountPercent: 50,
    }),
    product({
      externalUrl: "https://www.zalando.dk/product-b",
      title: "Product B",
      currentPrice: 300,
      discountPercent: 10,
    }),
    product({
      externalUrl: "https://www.zalando.dk/product-c",
      title: "Product C",
      currentPrice: 50,
      discountPercent: 75,
    }),
  ];

  const importResults = await persistImportedProducts(importSql, products);

  assert.equal(importResults.length, 3);
  assert.ok(
    importResults.every((result) => result.inserted),
    "every synthetic product should be a fresh insert",
  );

  const dashboardProducts = await getLatestDashboardProducts(
    sql as unknown as DashboardSql,
    "zalando.dk",
    "savings",
    "visible",
    "24h",
    null,
  );

  assert.equal(dashboardProducts.length, 3);
  assert.deepEqual(
    dashboardProducts.map((dashboardProduct) => dashboardProduct.title),
    ["Product C", "Product A", "Product B"],
    "dashboard read should reflect the imported products, ordered by discount percent",
  );

  const productC = dashboardProducts.find(
    (dashboardProduct) => dashboardProduct.title === "Product C",
  );
  assert.equal(productC?.currentPrice, "50.00");
  assert.equal(productC?.currency, "DKK");
  assert.equal(productC?.discountPercent, "75.00");
  assert.equal(productC?.hidden, false);
});

test("detects a watched historical-low event from real snapshot history", async () => {
  const externalUrl = "https://www.zalando.dk/watched-product";
  const observe = async (currentPrice: number, observedAt: string, currency: string | null = "DKK") => {
    const [result] = await persistImportedProducts(importSql, [
      product({ externalUrl, title: "Watched product", currentPrice, currency, observedAt }),
    ]);
    return result!;
  };
  const eventsFor = (snapshotId: string | null) =>
    findWatchedHistoricalLows(sql as never, snapshotId ? [snapshotId] : []);

  const first = await observe(500, "2026-01-01T00:00:00.000Z");
  await sql`UPDATE products SET watched = TRUE WHERE id = ${first.productId}`;
  assert.deepEqual(await eventsFor(first.snapshotId), [], "first observation");

  await observe(600, "2026-01-02T00:00:00.000Z");
  const returningLow = await observe(500, "2026-01-03T00:00:00.000Z");
  assert.deepEqual(await eventsFor(returningLow.snapshotId), [
    { productId: first.productId, dropPercent: 16.6667 },
  ]);
  const [candidate] = await loadWatchedHistoricalLowCandidates(sql as never, await eventsFor(returningLow.snapshotId));
  assert.equal(candidate?.title, "Watched product");
  assert.equal(candidate?.watched, true);
  assert.equal(candidate?.currentPrice, "500.00");
  assert.equal(candidate?.preferenceScore, null, "no stored evaluation is required");

  const reimport = await observe(500, "2026-01-03T00:00:00.000Z");
  assert.equal(reimport.snapshotId, null, "re-importing an existing observation inserts nothing");

  const unchanged = await observe(500, "2026-01-04T00:00:00.000Z");
  assert.deepEqual(await eventsFor(unchanged.snapshotId), [], "remaining at the low");

  const olderRef = await observe(400, "2025-12-31T00:00:00.000Z");
  assert.ok(olderRef.snapshotId);
  assert.deepEqual(await eventsFor(olderRef.snapshotId), [], "inserted observation is not the latest");

  const otherCurrency = await observe(300, "2026-01-05T00:00:00.000Z", "EUR");
  assert.deepEqual(await eventsFor(otherCurrency.snapshotId), [], "no same-currency history");

  await sql`UPDATE products SET hidden = TRUE WHERE id = ${first.productId}`;
  const hiddenLow = await observe(100, "2026-01-06T00:00:00.000Z");
  assert.deepEqual(await eventsFor(hiddenLow.snapshotId), [], "hidden products are excluded");
});
