import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("product schema migration removes target size and category columns", async () => {
  const migration = await readFile(
    new URL("../migrations/009_remove_product_target_size_and_category.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /DROP COLUMN target_size/i);
  assert.match(migration, /DROP COLUMN category/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM|UPDATE\s+products/i);
});

test("evaluation translated listing text migration is additive and nullable", async () => {
  const migration = await readFile(
    new URL("../migrations/023_evaluation_translated_listing_text.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /ALTER TABLE product_evaluations/i);
  assert.match(migration, /ADD COLUMN translated_listing_text_da TEXT/i);
  assert.doesNotMatch(migration, /NOT NULL/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE\s+FROM|UPDATE\s+product_evaluations/i);
});
