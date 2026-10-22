import {
  isSummaryDate,
  produceDailySummary,
  type DailySummaryResult,
  type DailySummarySql,
  type DailySummaryWarnings,
  type PostSlackMessage,
} from "./daily-summary.mts";
import type { PartialScanWarning } from "./import-notification.mts";
import { deliverPendingWatchedAlerts } from "./watched-alerts.mts";

// Daily notifications delivered at the end of an import (#80; design D13,
// "Delivery and retry"). Both triggers call deliverDailyNotifications: the
// Workflow step after evaluation-run finalization, and the import route's
// no-candidate path after the legacy message. No Vercel dependency (ADR 0001).

type DailyNotificationsDependencies = DailySummaryWarnings & {
  sql: DailySummarySql;
  summaryDate: string;
  postSlackMessage: PostSlackMessage;
  now?: Date;
};

// Order (D13, QB): the daily summary, then pending Watched alerts (#81),
// which catches alerts left pending by an earlier failed send. Both are
// always attempted; a failure in one does not skip the other. It throws at
// the end if either failed, so a step retry tries again. Retries are
// idempotent through each part's claim and sent state.
export async function deliverDailyNotifications({
  sql,
  summaryDate,
  postSlackMessage,
  monitorDefinitionsWarning,
  scanWarnings,
  now,
}: DailyNotificationsDependencies): Promise<{ summary: DailySummaryResult | null }> {
  const failures: string[] = [];
  let summary: DailySummaryResult | null = null;

  try {
    summary = await produceDailySummary({
      sql,
      summaryDate,
      postSlackMessage,
      monitorDefinitionsWarning,
      scanWarnings,
      now,
    });
  } catch {
    failures.push("daily summary");
    console.warn("DealRadar daily summary failed.", { summaryDate });
  }

  try {
    await deliverPendingWatchedAlerts({ sql, postSlackMessage });
  } catch {
    failures.push("Watched alerts");
    console.warn("DealRadar Watched alert delivery failed.");
  }

  if (failures.length > 0) {
    throw new Error(`Daily notification delivery failed: ${failures.join(", ")}.`);
  }

  return { summary };
}

function asObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

// The Workflow path reads the summary date and warnings the import stored
// with the run (evaluation_runs.import_summary and scan_warnings), so step
// retries, runs that finish after Copenhagen midnight, and resumed runs that
// receive only the run ID all use the date computed at import start. A run
// created before #80 has no stored date and produces no summary; a later
// import on the same date does.
export async function deliverDailyNotificationsForEvaluationRun({
  sql,
  runId,
  postSlackMessage,
  now,
}: {
  sql: DailySummarySql;
  runId: string;
  postSlackMessage: PostSlackMessage;
  now?: Date;
}) {
  const [row] = await sql`
    SELECT import_summary AS "importSummary", scan_warnings AS "scanWarnings"
    FROM evaluation_runs WHERE id = ${runId}
  `;
  const importSummary = asObject(row?.importSummary);
  const summaryDate = importSummary.summaryDate;

  if (!isSummaryDate(summaryDate)) {
    console.info("DealRadar daily notifications skipped: the run has no summary date.", { runId });
    return { summary: null };
  }

  const monitorDefinitionsWarning = typeof importSummary.monitorDefinitionsWarning === "string"
    ? importSummary.monitorDefinitionsWarning
    : null;
  const scanWarnings = Array.isArray(row?.scanWarnings) ? row.scanWarnings as PartialScanWarning[] : [];

  return deliverDailyNotifications({
    sql,
    summaryDate,
    postSlackMessage,
    monitorDefinitionsWarning,
    scanWarnings,
    now,
  });
}
