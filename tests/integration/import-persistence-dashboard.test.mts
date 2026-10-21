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
import {
  loadDefinedMonitorIds,
  normalizeProductMonitorIds,
  parseMonitorDefinitionsDocument,
  type MonitorDefinitionsDocument,
  type MonitorScanEvidence,
} from "@/lib/monitor-definitions.mts";

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
    //
    // Persistence SQL passes JSONB as pre-serialized JSON text
    // (`${JSON.stringify(value)}::JSONB`), which Neon's HTTP driver sends as a
    // text parameter. postgres.js would instead JSON-encode that string again
    // for an inferred jsonb parameter, storing a jsonb string scalar, so text
    // is passed through unchanged here to match Neon.
    sql = postgres(container.getConnectionUri(), {
      max: 1,
      types: {
        jsonbText: {
          to: 3802,
          from: [],
          serialize: (value: unknown) => typeof value === "string" ? value : JSON.stringify(value),
          parse: (value: string) => value,
        },
      },
    });

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

function monitorDocument(monitors: Array<Record<string, unknown>>): MonitorDefinitionsDocument {
  const result = parseMonitorDefinitionsDocument({ contract_version: 1, monitor_count: monitors.length, monitors });
  assert.ok(result.ok);
  return result.document;
}

const scarossoMonitor = {
  id: "zalando-scarosso-shoes-42",
  source: "zalando",
  display_name: "Zalando – Scarosso shoes",
  enabled: true,
  recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20 },
};
const blazersMonitor = {
  id: "vinted-mens-blazers-size-s",
  source: "vinted",
  display_name: "Vinted – blazers",
  enabled: true,
  recommendation: { strategy: "best_match", minimum_overall_score: 7 },
};

async function monitorRows() {
  return sql`
    SELECT
      monitor_id, source, display_name, enabled, strategy,
      minimum_discount_percent::TEXT AS minimum_discount_percent,
      minimum_overall_score::TEXT AS minimum_overall_score,
      contract_version, definition, definition_ref,
      first_seen_at, updated_at, removed_at,
      last_scan_checked_at, last_scan_ref
    FROM monitor_definitions
    ORDER BY monitor_id
  `;
}

test("applies migration 028 and round-trips monitor definitions, lifecycle, and scan evidence", async () => {
  const persist = (ref: string, document: MonitorDefinitionsDocument | null, scanEvidence: MonitorScanEvidence[] = []) =>
    persistImportedProducts(importSql, [], { ref, document, scanEvidence });

  await persist("ref-1", monitorDocument([blazersMonitor, scarossoMonitor]), [
    { monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", checkedAt: "2026-10-20T03:40:00.000Z" },
    // Evidence never creates a definition, and never crosses sources.
    { monitorId: "unknown-monitor", source: "zalando.dk", checkedAt: "2026-10-20T03:40:00.000Z" },
    { monitorId: "vinted-mens-blazers-size-s", source: "zalando.dk", checkedAt: "2026-10-20T03:40:00.000Z" },
  ]);

  const initialRows = await monitorRows();
  assert.equal(initialRows.length, 2);
  let [blazers, scarosso] = initialRows;
  assert.equal(blazers!.source, "vinted.com");
  assert.equal(blazers!.strategy, "best_match");
  assert.equal(blazers!.minimum_overall_score, "7.00");
  assert.equal(blazers!.minimum_discount_percent, null);
  assert.equal(blazers!.last_scan_checked_at, null);
  assert.deepEqual(blazers!.definition, blazersMonitor);
  assert.equal(scarosso!.source, "zalando.dk");
  assert.equal(scarosso!.display_name, "Zalando – Scarosso shoes");
  assert.equal(scarosso!.enabled, true);
  assert.equal(scarosso!.strategy, "discount_threshold");
  assert.equal(scarosso!.minimum_discount_percent, "20.00");
  assert.equal(scarosso!.minimum_overall_score, null);
  assert.equal(scarosso!.contract_version, 1);
  assert.equal(scarosso!.definition_ref, "ref-1");
  assert.equal(scarosso!.removed_at, null);
  assert.equal(scarosso!.last_scan_checked_at.toISOString(), "2026-10-20T03:40:00.000Z");
  assert.equal(scarosso!.last_scan_ref, "ref-1");
  const firstSeenAt = scarosso!.first_seen_at.toISOString();
  assert.deepEqual([...await loadDefinedMonitorIds(importSql)].sort(), [blazersMonitor.id, scarossoMonitor.id]);

  // Absent monitor is removed; a display_name and strategy change and
  // enabled: false are in-place updates; an older feed does not move evidence back.
  await persist("ref-2", monitorDocument([{
    ...scarossoMonitor,
    display_name: "Scarosso 42",
    enabled: false,
    recommendation: { strategy: "best_match", minimum_overall_score: 6.5 },
  }]), [
    { monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", checkedAt: "2026-10-19T03:40:00.000Z" },
  ]);

  [blazers, scarosso] = await monitorRows();
  assert.notEqual(blazers!.removed_at, null);
  assert.equal(blazers!.definition_ref, "ref-1");
  assert.equal(scarosso!.display_name, "Scarosso 42");
  assert.equal(scarosso!.enabled, false);
  assert.equal(scarosso!.strategy, "best_match");
  assert.equal(scarosso!.minimum_overall_score, "6.50");
  assert.equal(scarosso!.minimum_discount_percent, null);
  assert.equal(scarosso!.definition_ref, "ref-2");
  assert.equal(scarosso!.first_seen_at.toISOString(), firstSeenAt);
  assert.equal(scarosso!.last_scan_checked_at.toISOString(), "2026-10-20T03:40:00.000Z");
  assert.equal(scarosso!.last_scan_ref, "ref-1");
  const removedAt = blazers!.removed_at.toISOString();

  // A missing document changes no definition; still-absent monitors keep
  // their original removal time; newer evidence moves forward.
  await persist("ref-3", null, [
    { monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", checkedAt: "2026-10-21T03:40:00.000Z" },
  ]);
  await persist("ref-4", monitorDocument([scarossoMonitor]));

  [blazers, scarosso] = await monitorRows();
  assert.equal(blazers!.removed_at.toISOString(), removedAt);
  assert.equal(scarosso!.last_scan_checked_at.toISOString(), "2026-10-21T03:40:00.000Z");
  assert.equal(scarosso!.last_scan_ref, "ref-3");
  assert.equal(scarosso!.definition_ref, "ref-4");

  // Reappearance clears removed_at; an older ref's valid document replaces
  // the definitions and is recorded in definition_ref.
  await persist("ref-0", monitorDocument([blazersMonitor, scarossoMonitor]));

  [blazers, scarosso] = await monitorRows();
  assert.equal(blazers!.removed_at, null);
  assert.equal(blazers!.definition_ref, "ref-0");
  assert.equal(scarosso!.definition_ref, "ref-0");

  // Active monitors: enabled, not removed, and with a strategy.
  await persist("ref-5", monitorDocument([
    blazersMonitor,
    { ...scarossoMonitor, recommendation: null },
  ]));
  const active = await sql`
    SELECT monitor_id FROM monitor_definitions
    WHERE enabled = TRUE AND removed_at IS NULL AND strategy IS NOT NULL
  `;
  assert.deepEqual(active.map((row) => row.monitor_id), [blazersMonitor.id]);
});

test("monitor_definitions CHECK constraints allow exactly the threshold matching the strategy", async () => {
  const insert = (strategy: string | null, discount: number | null, score: number | null) => sql`
    INSERT INTO monitor_definitions (
      monitor_id, source, enabled, strategy, minimum_discount_percent, minimum_overall_score,
      contract_version, definition, definition_ref
    ) VALUES (
      ${`check-${Math.random().toString(36).slice(2)}`}, 'zalando.dk', TRUE, ${strategy}, ${discount}, ${score},
      1, '{}'::JSONB, 'ref'
    )
  `;

  await insert(null, null, null);
  await insert("discount_threshold", 20, null);
  await insert("best_match", null, 7);

  for (const [strategy, discount, score] of [
    ["discount_threshold", null, null],
    ["discount_threshold", 20, 7],
    ["discount_threshold", null, 7],
    ["best_match", null, null],
    ["best_match", 20, null],
    [null, 20, null],
    [null, null, 7],
    ["top_n", null, null],
    ["discount_threshold", 100, null],
    ["best_match", null, 11],
  ] as const) {
    await assert.rejects(insert(strategy, discount, score), /check constraint/i, `${strategy} ${discount} ${score}`);
  }
});

// Migration 029 (#78) must see pre-existing products, so it runs in a
// separate database of the same container: migrations before 029, seed rows,
// then 029.
test("migration 029 backfills products.monitor_ids with the importer's rules and changes nothing else", async () => {
  await sql.unsafe("CREATE DATABASE monitor_ids_backfill");
  const url = new URL(container.getConnectionUri());
  url.pathname = "/monitor_ids_backfill";
  const backfillSql = postgres(url.toString(), { max: 1 });

  try {
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]));
    const migration029 = files.find((file) => file.startsWith("029_"));
    assert.ok(migration029);

    for (const file of files.filter((file) => Number(file.split("_")[0]) < 29)) {
      await backfillSql.unsafe(readFileSync(path.join(migrationsDir, file), "utf8"));
    }

    const seeded: Record<string, unknown>[] = [
      { monitor_ids: ["vinted-mens-coats-size-s", "vinted-mens-blazers-size-s"], listing_text: "kept" },
      {
        monitor_ids: [
          "ok-1", "", " ", " padded", "Bad ID!", "double--hyphen", "trailing-", "line\n", "é-accent",
          "\u017F", "\u212A", 7, null, true, {}, ["nested"], "x".repeat(121), "x".repeat(120), "OK-2",
        ],
      },
      { monitor_ids: Array.from({ length: 25 }, (_, index) => [`Bad ${index}`, `monitor-${index}`]).flat() },
      { monitor_ids: "vinted-mens-blazers-size-s" },
      { monitor_ids: null },
      { monitor_ids: { id: "vinted-mens-blazers-size-s" } },
      { monitor_ids: [] },
      {},
    ];

    for (const [index, rawData] of seeded.entries()) {
      await backfillSql`
        INSERT INTO products (source, external_url, title, current_price, currency, raw_data)
        VALUES (
          ${index % 2 ? "zalando.dk" : "vinted.com"},
          ${`https://example.test/backfill-${index}`},
          ${`Backfill ${index}`},
          ${100 + index},
          'DKK',
          ${backfillSql.json(rawData as never)}
        )
      `;
    }

    const otherColumns = () => backfillSql`
      SELECT to_jsonb(products) - 'monitor_ids' AS row FROM products ORDER BY id
    `;
    const before = await otherColumns();

    await backfillSql.unsafe(readFileSync(path.join(migrationsDir, migration029), "utf8"));

    assert.deepEqual(await otherColumns(), before, "no other column or row changes");

    const rows = await backfillSql`SELECT raw_data, monitor_ids FROM products ORDER BY id`;
    assert.equal(rows.length, seeded.length);
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(row.raw_data, seeded[index]);
      assert.deepEqual(row.monitor_ids, normalizeProductMonitorIds(seeded[index]!.monitor_ids), `row ${index}`);
    }
    assert.deepEqual(rows[0]!.monitor_ids, ["vinted-mens-coats-size-s", "vinted-mens-blazers-size-s"]);
    assert.deepEqual(rows[1]!.monitor_ids, ["ok-1", "x".repeat(120), "OK-2"]);
    assert.deepEqual(rows[2]!.monitor_ids, Array.from({ length: 20 }, (_, index) => `monitor-${index}`));
    assert.ok(rows.slice(3).every((row) => row.monitor_ids.length === 0));

    const [index] = await backfillSql`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'products' AND indexname = 'products_monitor_ids_idx'
    `;
    assert.match(index!.indexdef, /USING gin \(monitor_ids\)/);
  } finally {
    await backfillSql.end({ timeout: 5 });
  }
});

test("every product upsert overwrites products.monitor_ids from the feed", async () => {
  const externalUrl = "https://www.vinted.dk/items/monitor-membership";
  const membership = async (rawData: Record<string, unknown>, observedAt: string) => {
    await persistImportedProducts(importSql, [
      product({ source: "vinted.com", externalUrl, title: "Membership product", observedAt, rawData }),
    ]);
    const [row] = await sql`
      SELECT monitor_ids, raw_data FROM products WHERE source = 'vinted.com' AND external_url = ${externalUrl}
    `;
    assert.deepEqual(row!.raw_data, rawData);
    return row!.monitor_ids;
  };

  assert.deepEqual(
    await membership(
      { monitor_ids: ["vinted-mens-blazers-size-s", "Bad ID!", 7, "vinted-mens-coats-size-s"] },
      "2026-02-01T00:00:00.000Z",
    ),
    ["vinted-mens-blazers-size-s", "vinted-mens-coats-size-s"],
  );

  const [found] = await sql`
    SELECT external_url FROM products WHERE monitor_ids @> ARRAY['vinted-mens-blazers-size-s']
  `;
  assert.equal(found?.external_url, externalUrl);

  assert.deepEqual(
    await membership({ monitor_ids: ["vinted-mens-coats-size-s"] }, "2026-02-02T00:00:00.000Z"),
    ["vinted-mens-coats-size-s"],
    "a monitor no longer listed by the feed is removed",
  );
  assert.deepEqual(await membership({}, "2026-02-03T00:00:00.000Z"), []);
});
