import {
  claimEvaluationRunNotification,
  getEvaluationRun,
  markEvaluationRunNotificationSent,
  releaseEvaluationRunNotificationClaim,
  type EvaluationRun,
  type EvaluationRunSql,
} from "./evaluation-runs.mts";
import {
  formatImportSlackMessage,
  selectTopRecommendation,
  type ImportRecommendation,
  type ImportSummary,
  type PartialScanWarning,
} from "./import-notification.mts";

type FinalizationDependencies = {
  sql: EvaluationRunSql;
  run: EvaluationRun;
  postSlackMessage: (message: string, clientMessageId?: string) => Promise<{ success: boolean; error?: string }>;
};

function summary(value: unknown, fallbackRef: string): ImportSummary {
  const source = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const count = (key: string) => typeof source[key] === "number" && Number.isSafeInteger(source[key]) && source[key] >= 0 ? source[key] : 0;
  return { ref: typeof source.ref === "string" ? source.ref : fallbackRef, productsProcessed: count("productsProcessed"), productsInserted: count("productsInserted"), productsUpdated: count("productsUpdated"), snapshotsInserted: count("snapshotsInserted"), productsEvaluated: count("productsEvaluated") };
}

export async function finalizeEvaluationRun({ sql, run, postSlackMessage }: FinalizationDependencies) {
  const persistedRun = await getEvaluationRun(sql, run.id);
  if (!persistedRun) throw new Error("Evaluation run was not found during finalization.");
  if (persistedRun.status !== "completed" || persistedRun.pendingCandidates > 0 || persistedRun.notificationSent) return { finalized: false, notificationSent: persistedRun.notificationSent };

  // Claim before the external side effect. This gives retries/re-entry at-most-one
  // delivery attempt; Slack remains non-fatal and never reopens Gemini work.
  const claim = await claimEvaluationRunNotification(sql, persistedRun.id);
  if (!claim) return { finalized: false, notificationSent: false };

  const [metadata] = await sql`
    SELECT import_summary AS "importSummary", scan_warnings AS "scanWarnings"
    FROM evaluation_runs WHERE id = ${persistedRun.id}
  `;
  const recommendations = await sql`
    SELECT p.id::TEXT AS "productId", p.external_url AS "externalUrl", p.title,
      p.source, p.brand,
      p.raw_data ->> 'listing_text' AS "listingText",
      p.raw_data ->> 'article_condition' AS "articleCondition",
      p.raw_data ->> 'size_guess' AS "sizeGuess",
      pe.translated_listing_text_da AS "translatedListingTextDa",
      p.current_price::TEXT AS "currentPrice", p.currency,
      p.source_current_price::TEXT AS "sourceCurrentPrice", p.source_currency AS "sourceCurrency",
      p.hidden, pe.preference_score AS "preferenceScore", pe.deal_score AS "dealScore"
    FROM evaluation_run_candidates erc
    JOIN products p ON p.id = erc.product_id
    JOIN product_evaluations pe ON pe.product_id = p.id
    WHERE erc.run_id = ${persistedRun.id} AND erc.status = 'completed'
  ` as ImportRecommendation[];
  const importSummary = summary(metadata?.importSummary, persistedRun.importRef);
  importSummary.productsEvaluated = persistedRun.evaluationsCompleted;
  const warnings = Array.isArray(metadata?.scanWarnings) ? metadata.scanWarnings as PartialScanWarning[] : [];
  try {
    const result = await postSlackMessage(formatImportSlackMessage(importSummary, selectTopRecommendation(recommendations), warnings), claim.clientMessageId);
    if (!result.success) throw new Error(`Slack delivery failed: ${result.error ?? "unknown_error"}.`);
    if (!await markEvaluationRunNotificationSent(sql, persistedRun.id, claim.claimToken)) throw new Error("Evaluation run notification could not be recorded.");
  } catch {
    await releaseEvaluationRunNotificationClaim(sql, persistedRun.id, claim.claimToken);
    console.warn("DealRadar Slack notification failed: unexpected_error.");
    throw new Error("Slack finalization failed and can be retried without rerunning Gemini.");
  }
  return { finalized: true, notificationSent: true };
}
