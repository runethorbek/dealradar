import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("evaluation-run migration persists the minimal durable lifecycle and membership", async () => {
  const migration = await readFile(
    new URL("../migrations/013_evaluation_runs.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE evaluation_runs/i);
  assert.match(migration, /import_ref TEXT NOT NULL/i);
  assert.match(migration, /'pending', 'running', 'completed'/i);
  assert.match(migration, /notification_sent BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(migration, /CREATE TABLE evaluation_run_candidates/i);
  assert.match(migration, /PRIMARY KEY \(run_id, product_id\)/i);
  assert.match(migration, /UNIQUE \(run_id, selection_position\)/i);
  assert.match(migration, /'pending', 'completed', 'failed'/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});
