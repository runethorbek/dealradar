import assert from "node:assert/strict";
import { mock, test } from "node:test";

let databaseUrl: string | undefined;
let query = "";
let values: unknown[] = [];

mock.module("@neondatabase/serverless", {
  exports: {
    neon: (url: string) => {
      databaseUrl = url;
      return async (strings: TemplateStringsArray, ...queryValues: unknown[]) => {
        query = strings.join("$parameter");
        values = queryValues;
        return [{
          id: "7",
          importRef: "abc123",
          status: "pending",
          startedAt: null,
          completedAt: null,
          notificationSent: false,
          createdAt: "2026-09-14T10:00:00.000Z",
          candidatesSelected: 1,
          evaluationsCompleted: 0,
          evaluationsFailed: 0,
          pendingCandidates: 1,
        }];
      };
    },
  },
} as never);

const { createEvaluationRunForWorkflow } = await import(
  "../lib/vercel-workflow/evaluation-run-orchestration.mts"
);

test("the Vercel orchestration entry point delegates durable state creation to the application operation", async () => {
  const run = await createEvaluationRunForWorkflow({
    databaseUrl: "postgresql://test-only",
    importRef: "abc123",
    candidateProductIds: ["42"],
  });

  assert.equal(databaseUrl, "postgresql://test-only");
  assert.equal(run.status, "pending");
  assert.match(query, /INSERT INTO evaluation_runs/);
  assert.match(query, /INSERT INTO evaluation_run_candidates/);
  assert.deepEqual(values, ["abc123", ["42"]]);
  assert.doesNotMatch(query, /gemini|slack/i);
});
