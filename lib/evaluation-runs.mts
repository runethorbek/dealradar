export type EvaluationRunStatus = "pending" | "running" | "completed";
export type EvaluationCandidateStatus = "pending" | "processing" | "completed" | "failed";

export type EvaluationRun = {
  id: string;
  importRef: string;
  status: EvaluationRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  notificationSent: boolean;
  createdAt: string;
  candidatesSelected: number;
  evaluationsCompleted: number;
  evaluationsFailed: number;
  pendingCandidates: number;
  batchesProcessed: number;
};

export type EvaluationRunCandidate = {
  productId: string;
  selectionPosition: number;
};

export type EvaluationRunSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>;

type EvaluationRunRow = Record<string, unknown>;

function asCount(value: unknown, field: string) {
  const count = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid evaluation run ${field}.`);
  }

  return count;
}

function asStatus(value: unknown): EvaluationRunStatus {
  if (value === "pending" || value === "running" || value === "completed") {
    return value;
  }

  throw new Error("Invalid evaluation run status.");
}

function asTimestamp(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asEvaluationRun(row: EvaluationRunRow): EvaluationRun {
  if (
    (typeof row.id !== "string" && typeof row.id !== "number") ||
    typeof row.importRef !== "string" ||
    typeof row.createdAt !== "string"
  ) {
    throw new Error("Invalid evaluation run row.");
  }

  return {
    id: String(row.id),
    importRef: row.importRef,
    status: asStatus(row.status),
    startedAt: asTimestamp(row.startedAt),
    completedAt: asTimestamp(row.completedAt),
    notificationSent: row.notificationSent === true,
    createdAt: row.createdAt,
    candidatesSelected: asCount(row.candidatesSelected, "candidate count"),
    evaluationsCompleted: asCount(row.evaluationsCompleted, "completed count"),
    evaluationsFailed: asCount(row.evaluationsFailed, "failed count"),
    pendingCandidates: asCount(row.pendingCandidates, "pending count"),
    batchesProcessed: asCount(row.batchesProcessed, "batches processed"),
  };
}

function uniqueProductIds(productIds: string[]) {
  if (productIds.length === 0) {
    throw new Error("An evaluation run requires at least one selected candidate.");
  }

  if (productIds.some((productId) => !/^\d+$/.test(productId))) {
    throw new Error("Evaluation run candidate IDs must be product IDs.");
  }

  if (new Set(productIds).size !== productIds.length) {
    throw new Error("An evaluation run cannot contain a product more than once.");
  }

  return productIds;
}

async function loadRun(sql: EvaluationRunSql, runId: string) {
  const [row] = await sql`
    SELECT
      er.id::TEXT AS "id",
      er.import_ref AS "importRef",
      er.status,
      er.started_at::TEXT AS "startedAt",
      er.completed_at::TEXT AS "completedAt",
      er.notification_sent AS "notificationSent",
      er.created_at::TEXT AS "createdAt",
      COUNT(erc.product_id)::INTEGER AS "candidatesSelected",
      COUNT(erc.product_id) FILTER (WHERE erc.status = 'completed')::INTEGER AS "evaluationsCompleted",
      COUNT(erc.product_id) FILTER (WHERE erc.status = 'failed')::INTEGER AS "evaluationsFailed",
      COUNT(erc.product_id) FILTER (WHERE erc.status IN ('pending', 'processing'))::INTEGER AS "pendingCandidates"
      , er.batches_processed::INTEGER AS "batchesProcessed"
    FROM evaluation_runs er
    LEFT JOIN evaluation_run_candidates erc ON erc.run_id = er.id
    WHERE er.id = ${runId}
    GROUP BY er.id
  `;

  return row ? asEvaluationRun(row) : null;
}

export async function createEvaluationRun(
  sql: EvaluationRunSql,
  input: { importRef: string; candidateProductIds: string[] },
) {
  const productIds = uniqueProductIds(input.candidateProductIds);

  if (!input.importRef.trim()) {
    throw new Error("An evaluation run requires an import reference.");
  }

  const [row] = await sql`
    WITH created_run AS (
      INSERT INTO evaluation_runs (import_ref)
      VALUES (${input.importRef})
      RETURNING id
    ), created_candidates AS (
      INSERT INTO evaluation_run_candidates (
        run_id,
        product_id,
        selection_position
      )
      SELECT
        created_run.id,
        selected.product_id::BIGINT,
        selected.selection_position::INTEGER
      FROM created_run
      CROSS JOIN UNNEST(${productIds}::TEXT[]) WITH ORDINALITY
        AS selected(product_id, selection_position)
    )
    SELECT
      er.id::TEXT AS "id",
      er.import_ref AS "importRef",
      er.status,
      er.started_at::TEXT AS "startedAt",
      er.completed_at::TEXT AS "completedAt",
      er.notification_sent AS "notificationSent",
      er.created_at::TEXT AS "createdAt",
      COUNT(erc.product_id)::INTEGER AS "candidatesSelected",
      COUNT(erc.product_id) FILTER (WHERE erc.status = 'completed')::INTEGER AS "evaluationsCompleted",
      COUNT(erc.product_id) FILTER (WHERE erc.status = 'failed')::INTEGER AS "evaluationsFailed",
      COUNT(erc.product_id) FILTER (WHERE erc.status IN ('pending', 'processing'))::INTEGER AS "pendingCandidates"
      , er.batches_processed::INTEGER AS "batchesProcessed"
    FROM evaluation_runs er
    JOIN created_run ON created_run.id = er.id
    LEFT JOIN evaluation_run_candidates erc ON erc.run_id = er.id
    GROUP BY er.id
  `;

  if (!row) {
    throw new Error("Evaluation run creation did not return a run.");
  }

  return asEvaluationRun(row);
}

export function getEvaluationRun(sql: EvaluationRunSql, runId: string) {
  return loadRun(sql, runId);
}

export async function startEvaluationRun(sql: EvaluationRunSql, runId: string) {
  const rows = await sql`
    UPDATE evaluation_runs
    SET status = 'running', started_at = NOW()
    WHERE id = ${runId}
      AND status = 'pending'
    RETURNING id
  `;

  return rows.length > 0 ? loadRun(sql, runId) : null;
}

export async function recoverExpiredEvaluationCandidateClaims(
  sql: EvaluationRunSql,
  runId: string,
) {
  await sql`
    UPDATE evaluation_run_candidates erc
    SET status = CASE WHEN EXISTS (
      SELECT 1 FROM product_evaluations pe
      WHERE pe.product_id = erc.product_id
        AND pe.evaluated_at >= erc.claimed_at
    ) THEN 'completed' ELSE 'pending' END,
    claimed_at = NULL
    WHERE erc.run_id = ${runId}
      AND erc.status = 'processing'
      AND erc.claimed_at <= NOW() - INTERVAL '15 minutes'
  `;
}

export async function claimNextEvaluationBatch(
  sql: EvaluationRunSql,
  runId: string,
  batchSize: number,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) {
    throw new Error("Evaluation batch size must be an integer from 1 to 10.");
  }

  const rows = await sql`
    WITH next_candidates AS (
      SELECT erc.run_id, erc.product_id
      FROM evaluation_run_candidates erc
      JOIN evaluation_runs er ON er.id = erc.run_id
      WHERE erc.run_id = ${runId}
        AND er.status = 'running'
        AND erc.status = 'pending'
      ORDER BY erc.selection_position ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE evaluation_run_candidates erc
    SET status = 'processing', claimed_at = NOW()
    FROM next_candidates next
    WHERE erc.run_id = next.run_id AND erc.product_id = next.product_id
    RETURNING erc.product_id::TEXT AS "productId", erc.selection_position AS "selectionPosition"
  `;

  return rows.map((row) => {
    if (
      (typeof row.productId !== "string" && typeof row.productId !== "number") ||
      !Number.isInteger(row.selectionPosition)
    ) {
      throw new Error("Invalid evaluation run candidate row.");
    }

    return {
      productId: String(row.productId),
      selectionPosition: row.selectionPosition as number,
    } satisfies EvaluationRunCandidate;
  });
}

export async function recordEvaluationCandidateOutcome(
  sql: EvaluationRunSql,
  input: {
    runId: string;
    productId: string;
    status: Extract<EvaluationCandidateStatus, "completed" | "failed">;
  },
) {
  const rows = await sql`
    UPDATE evaluation_run_candidates
    SET status = ${input.status}
    WHERE run_id = ${input.runId}
      AND product_id = ${input.productId}
      AND status = 'processing'
      AND EXISTS (
        SELECT 1
        FROM evaluation_runs
        WHERE id = ${input.runId}
          AND status = 'running'
      )
    RETURNING product_id
  `;

  return rows.length > 0;
}

/** @deprecated Use claimNextEvaluationBatch for durable processors. */
export const loadNextEvaluationBatch = claimNextEvaluationBatch;

export async function completeEvaluationRun(sql: EvaluationRunSql, runId: string) {
  const rows = await sql`
    UPDATE evaluation_runs er
    SET status = 'completed', completed_at = NOW()
    WHERE er.id = ${runId}
      AND er.status = 'running'
      AND NOT EXISTS (
        SELECT 1
        FROM evaluation_run_candidates erc
        WHERE erc.run_id = er.id
          AND erc.status IN ('pending', 'processing')
      )
    RETURNING er.id
  `;

  return rows.length > 0 ? loadRun(sql, runId) : null;
}

export async function recordEvaluationBatchProcessed(
  sql: EvaluationRunSql,
  runId: string,
) {
  const rows = await sql`
    UPDATE evaluation_runs
    SET batches_processed = batches_processed + 1
    WHERE id = ${runId}
      AND status = 'running'
    RETURNING id
  `;

  return rows.length > 0;
}

export async function markEvaluationRunNotificationSent(
  sql: EvaluationRunSql,
  runId: string,
) {
  const rows = await sql`
    UPDATE evaluation_runs
    SET notification_sent = TRUE
    WHERE id = ${runId}
      AND status = 'completed'
      AND notification_sent = FALSE
    RETURNING id
  `;

  return rows.length > 0;
}
