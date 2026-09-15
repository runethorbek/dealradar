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

test("evaluation-run batch progress is additive and recoverable", async () => {
  const migration = await readFile(
    new URL("../migrations/014_evaluation_run_batch_progress.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN batches_processed INTEGER NOT NULL DEFAULT 0/i);
  assert.match(migration, /CHECK \(batches_processed >= 0\)/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});

test("Gemini settings default includes the workflow batch size", async () => {
  const migration = await readFile(
    new URL("../migrations/015_gemini_workflow_batch_size.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /"workflowBatchSize":5/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});

test("evaluation-run candidate claims persist processing recovery state", async () => {
  const migration = await readFile(new URL("../migrations/016_evaluation_run_candidate_claims.sql", import.meta.url), "utf8");
  assert.match(migration, /'processing'/i);
  assert.match(migration, /ADD COLUMN claimed_at TIMESTAMPTZ/i);
  assert.match(migration, /evaluation_run_candidates_processing_idx/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});

test("evaluation-run finalization stores import context and notification claim state", async () => {
  const migration = await readFile(new URL("../migrations/017_evaluation_run_finalization.sql", import.meta.url), "utf8");
  assert.match(migration, /import_summary JSONB/i);
  assert.match(migration, /scan_warnings JSONB/i);
  assert.match(migration, /notification_claimed_at TIMESTAMPTZ/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});

test("notification recovery and lease migrations remain additive", async () => {
  const recovery = await readFile(new URL("../migrations/018_evaluation_run_notification_recovery.sql", import.meta.url), "utf8");
  const idempotency = await readFile(new URL("../migrations/019_evaluation_run_slack_idempotency.sql", import.meta.url), "utf8");
  const lease = await readFile(new URL("../migrations/020_evaluation_run_notification_lease_tokens.sql", import.meta.url), "utf8");
  assert.match(recovery, /notification_claimed_at/i);
  assert.match(idempotency, /notification_client_message_id/i);
  assert.match(lease, /notification_claim_token/i);
  assert.doesNotMatch(`${recovery}${idempotency}${lease}`, /DROP TABLE|DELETE\s+FROM/i);
});

test("launch recovery migration persists a minimal pending/started state", async () => {
  const migration = await readFile(new URL("../migrations/021_evaluation_run_launch_recovery.sql", import.meta.url), "utf8");
  assert.match(migration, /launch_status/i);
  assert.match(migration, /launch_attempts/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});

test("launch claims are additive and persisted", async () => {
  const migration = await readFile(new URL("../migrations/022_evaluation_run_launch_claims.sql", import.meta.url), "utf8");
  assert.match(migration, /launch_claim_token/i);
  assert.match(migration, /launch_claimed_at/i);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE\s+FROM/i);
});
