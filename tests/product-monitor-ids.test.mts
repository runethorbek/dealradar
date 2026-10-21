import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildProductUpsertQuery,
  type ImportPersistenceSql,
  type NormalizedProduct,
} from "@/lib/import-persistence.mts";
import { normalizeProductMonitorIds } from "@/lib/monitor-definitions.mts";

// products.monitor_ids (#78, design D5): authoritative product-monitor
// membership, set on every upsert from the feed product's monitor_ids.

type Query = { text: string; values: unknown[] };

const sql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ text: strings.join("$"), values }) as unknown as PromiseLike<unknown[]>,
  { transaction: async () => [] },
) as ImportPersistenceSql;

function product(rawData: Record<string, unknown>, source = "vinted.com"): NormalizedProduct {
  return {
    source,
    externalUrl: "https://www.vinted.dk/items/123-test-blazer",
    title: "Test blazer",
    imageUrl: null,
    currentPrice: 150,
    originalPrice: null,
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceOriginalPrice: null,
    sourceCurrency: null,
    discountPercent: null,
    available: true,
    brand: null,
    observedAt: "2026-10-20T02:45:00.000Z",
    rawData,
  };
}

function upsert(rawData: Record<string, unknown>, source?: string) {
  return buildProductUpsertQuery(sql, product(rawData, source)) as unknown as Query;
}

// The membership parameter is the only JSON array value; raw_data is a JSON object.
function persistedMonitorIds(query: Query) {
  const values = query.values.filter(
    (value): value is string => typeof value === "string" && value.startsWith("["),
  );
  assert.equal(values.length, 1);
  return JSON.parse(values[0]!) as unknown;
}

test("valid monitor IDs are kept in feed order", () => {
  const ids = ["vinted-mens-blazers-size-s", "Zalando-Scarosso-Shoes-42", "a", "x".repeat(120)];

  assert.deepEqual(normalizeProductMonitorIds(ids), ids);
  assert.deepEqual(persistedMonitorIds(upsert({ monitor_ids: ids })), ids);
});

test("invalid monitor IDs are dropped without failing the product", () => {
  const value = [
    "vinted-mens-blazers-size-s",
    "",
    " ",
    " padded-id",
    "Invalid ID!",
    "double--hyphen",
    "-leading",
    "trailing-",
    "x".repeat(121),
    7,
    null,
    true,
    {},
    ["nested"],
    "zalando-scarosso-shoes-42",
  ];

  assert.deepEqual(normalizeProductMonitorIds(value), [
    "vinted-mens-blazers-size-s",
    "zalando-scarosso-shoes-42",
  ]);

  const query = upsert({ monitor_ids: value });
  assert.deepEqual(persistedMonitorIds(query), ["vinted-mens-blazers-size-s", "zalando-scarosso-shoes-42"]);
  // The preserved feed object is unchanged.
  assert.ok(query.values.includes(JSON.stringify({ monitor_ids: value })));
});

test("at most the first 20 valid monitor IDs are kept", () => {
  const valid = Array.from({ length: 25 }, (_, index) => `monitor-${index}`);
  const withInvalid = valid.flatMap((id) => ["Invalid ID!", id]);

  assert.deepEqual(normalizeProductMonitorIds(valid), valid.slice(0, 20));
  assert.deepEqual(normalizeProductMonitorIds(withInvalid), valid.slice(0, 20));
  assert.deepEqual(persistedMonitorIds(upsert({ monitor_ids: withInvalid })), valid.slice(0, 20));
});

test("a missing or non-array monitor_ids is no membership, for every source", () => {
  for (const rawData of [{}, { monitor_ids: "vinted-mens-blazers-size-s" }, { monitor_ids: null }, { monitor_ids: {} }]) {
    assert.deepEqual(normalizeProductMonitorIds(rawData.monitor_ids), []);
    assert.deepEqual(persistedMonitorIds(upsert(rawData)), []);
  }

  assert.deepEqual(
    persistedMonitorIds(upsert({ monitor_ids: ["zalando-scarosso-shoes-42"] }, "zalando.dk")),
    ["zalando-scarosso-shoes-42"],
  );
});

test("monitor_ids is overwritten on every upsert, so a monitor no longer listed is removed", () => {
  const first = upsert({ monitor_ids: ["vinted-mens-blazers-size-s", "vinted-mens-coats-size-s"] });
  const reimported = upsert({ monitor_ids: ["vinted-mens-coats-size-s"] });
  const unlisted = upsert({});

  assert.match(first.text, /raw_data,\s+monitor_ids\s+\) VALUES/);
  assert.match(first.text, /ON CONFLICT \(source, external_url\) DO UPDATE SET[\s\S]*monitor_ids = EXCLUDED\.monitor_ids/);
  assert.match(first.text, /jsonb_array_elements_text\(\$::JSONB\)\s+WITH ORDINALITY[\s\S]*ORDER BY position/);
  assert.deepEqual(persistedMonitorIds(first), ["vinted-mens-blazers-size-s", "vinted-mens-coats-size-s"]);
  assert.deepEqual(persistedMonitorIds(reimported), ["vinted-mens-coats-size-s"]);
  assert.deepEqual(persistedMonitorIds(unlisted), []);
});

test("migration 029 adds the indexed column and backfills only that column", async () => {
  const migration = await readFile(
    new URL("../migrations/029_product_monitor_ids.sql", import.meta.url),
    "utf8",
  );
  const statements = migration.replace(/--.*$/gm, "");

  assert.match(statements, /ALTER TABLE products\s+ADD COLUMN monitor_ids TEXT\[\] NOT NULL DEFAULT '\{\}';/);
  assert.match(statements, /CREATE INDEX products_monitor_ids_idx\s+ON products USING GIN \(monitor_ids\);/);
  assert.match(statements, /UPDATE products\s+SET monitor_ids = ARRAY\(/);
  assert.equal(statements.match(/\bSET\b/g)?.length, 1);
  assert.equal(statements.match(/\bUPDATE\b/g)?.length, 1);
  assert.match(statements, /LIMIT 20/);
  assert.match(statements, /<= 120/);
  assert.doesNotMatch(statements, /DROP|DELETE\s+FROM|TRUNCATE|ALTER COLUMN|INSERT/i);
});
