import {
  escapeSlackText,
  formatScanWarnings,
  type PartialScanWarning,
} from "./import-notification.mts";
import { loadActiveMonitorMembers } from "./monitor-recommendation-loader.mts";
import {
  isFreshVisibleCandidate,
  isReliableDiscount,
  selectForMonitor,
  type MonitorCandidate,
  type MonitorFreshness,
  type MonitorMembers,
} from "./monitor-recommendation.mts";
import { defaultRankingSettings, getOverallScore, parseRankingSettings } from "./ranking-settings.mts";

// Daily summary (#80; design D11, D13 "Delivery and retry", P5, P12 in
// docs/specs/monitor-recommendation-design.md). One Slack message per
// Europe/Copenhagen summary date with the best match of every active monitor.
// It reads persisted state through the monitor recommendation loader and
// policy, persists its content before sending, and is idempotent per date.
// No Gemini, Next.js, or Vercel dependency: every trigger calls
// produceDailySummary.

export type DailySummarySql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<Array<Record<string, unknown>>>;

export type PostSlackMessage = (
  message: string,
  clientMessageId?: string,
) => Promise<{ success: boolean; error?: string }>;

export type DailySummaryBestMatch = {
  productId: string;
  title: string;
  externalUrl: string;
  price: string | null;
  currency: string | null;
  discountPercent: number | null; // only a reliable discount (D8)
  overallScore: number | null;
};

export type DailySummaryMonitor = {
  monitorId: string;
  displayName: string | null;
  source: string;
  strategy: "discount_threshold" | "best_match";
  threshold: number;
  freshness: MonitorFreshness;
  lastScanCheckedAt: string | null;
  qualifyingCount: number;
  notYetEvaluatedCount: number;
  // The policy's count of qualifying products without an evaluation; it
  // decides why a monitor with qualifying products has no best match.
  unevaluatedQualifyingCount: number;
  bestMatch: DailySummaryBestMatch | null;
};

export type DailySummaryWarnings = {
  monitorDefinitionsWarning: string | null;
  scanWarnings: PartialScanWarning[];
};

export type DailySummaryContent = DailySummaryWarnings & {
  summaryDate: string;
  monitors: DailySummaryMonitor[];
};

export type DailySummaryResult = {
  status: "sent" | "already_sent" | "claimed_elsewhere" | "expired" | "no_active_monitors";
};

const summaryDatePattern = /^\d{4}-\d{2}-\d{2}$/;

// P5: the summary date is the Europe/Copenhagen calendar date, YYYY-MM-DD.
export function getCopenhagenDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isSummaryDate(value: unknown): value is string {
  if (typeof value !== "string" || !summaryDatePattern.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getDisplayPrice(candidate: MonitorCandidate) {
  if (candidate.currentPrice !== null && candidate.currency !== null) {
    return { price: candidate.currentPrice, currency: candidate.currency };
  }

  if (candidate.sourceCurrentPrice !== null && candidate.sourceCurrency !== null) {
    return { price: candidate.sourceCurrentPrice, currency: candidate.sourceCurrency };
  }

  return { price: null, currency: null };
}

function isEvaluated(candidate: MonitorCandidate) {
  return candidate.preferenceScore !== null && candidate.dealScore !== null;
}

// Builds one monitor's entry from the S4 policy. For discount_threshold the
// not-yet-evaluated count is the policy's unevaluated qualifying count. A
// best_match product cannot qualify without an evaluation (D9), so its count
// is the fresh, visible members that are not evaluated.
export function buildDailySummaryMonitor(
  monitor: MonitorMembers,
  preferenceWeightPercent: number,
  now: Date,
): DailySummaryMonitor {
  const { policy, lastScanCheckedAt } = monitor;
  const selection = selectForMonitor(monitor, preferenceWeightPercent, now);
  const notYetEvaluatedCount = policy.strategy === "discount_threshold"
    ? selection.unevaluatedQualifyingCount
    : monitor.candidates.filter(
        (candidate) => isFreshVisibleCandidate(lastScanCheckedAt, candidate) && !isEvaluated(candidate),
      ).length;
  const best = selection.best;

  return {
    monitorId: policy.monitorId,
    displayName: policy.displayName,
    source: policy.source,
    strategy: policy.strategy,
    threshold: policy.strategy === "discount_threshold"
      ? policy.minimumDiscountPercent
      : policy.minimumOverallScore,
    freshness: selection.freshness,
    lastScanCheckedAt,
    qualifyingCount: selection.qualifyingCount,
    notYetEvaluatedCount,
    unevaluatedQualifyingCount: selection.unevaluatedQualifyingCount,
    bestMatch: best
      ? {
          productId: best.productId,
          title: best.title,
          externalUrl: best.externalUrl,
          ...getDisplayPrice(best),
          discountPercent: isReliableDiscount(best) ? best.discountPercent : null,
          overallScore: isEvaluated(best)
            ? getOverallScore(best.preferenceScore!, best.dealScore!, preferenceWeightPercent)
            : null,
        }
      : null,
  };
}

function formatNumber(value: number) {
  return String(Number(value.toFixed(2)));
}

function formatScanTime(value: string | null) {
  const time = value === null ? Number.NaN : Date.parse(value);

  return Number.isNaN(time)
    ? "at an unknown time"
    : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatStrategy(monitor: DailySummaryMonitor) {
  return monitor.strategy === "discount_threshold"
    ? `Strategy: discount threshold · at least ${formatNumber(monitor.threshold)}% discount`
    : `Strategy: best match · Overall at least ${formatNumber(monitor.threshold)}`;
}

function formatBestMatch(bestMatch: DailySummaryBestMatch) {
  const details = [
    bestMatch.price !== null && bestMatch.currency !== null
      ? `${escapeSlackText(bestMatch.price)} ${escapeSlackText(bestMatch.currency)}`
      : null,
    bestMatch.discountPercent !== null ? `${formatNumber(bestMatch.discountPercent)}% discount` : null,
    bestMatch.overallScore !== null ? `Overall ${bestMatch.overallScore.toFixed(1)}` : null,
    `<${escapeSlackText(bestMatch.externalUrl)}|View product>`,
  ].filter((value): value is string => value !== null);

  return `Best match: ${escapeSlackText(bestMatch.title)}\n${details.join(" · ")}`;
}

function formatMonitor(monitor: DailySummaryMonitor) {
  // P12: the display name, or the monitor ID when it has none.
  const lines = [`*${escapeSlackText(monitor.displayName ?? monitor.monitorId)}*`, formatStrategy(monitor)];

  // D7: a stale or never-scanned monitor never shows a best match, so old
  // observations are not presented as current.
  if (monitor.freshness === "stale") {
    lines.push(
      `Stale: the latest scan (${formatScanTime(monitor.lastScanCheckedAt)}) is older than 36 hours. ` +
      "Counts are from that scan; no best match is shown.",
    );
  } else if (monitor.freshness === "never_scanned") {
    lines.push("Never scanned: no scan of this monitor has been imported; no best match is shown.");
  }

  lines.push(`Qualifying: ${monitor.qualifyingCount} · Not yet evaluated: ${monitor.notYetEvaluatedCount}`);

  if (monitor.freshness !== "current") return lines.join("\n");

  if (monitor.bestMatch) {
    lines.push(formatBestMatch(monitor.bestMatch));
  } else if (monitor.qualifyingCount === 0) {
    lines.push("No products qualify.");
  } else if (monitor.unevaluatedQualifyingCount >= monitor.qualifyingCount) {
    lines.push("No best match: no qualifying product is evaluated yet.");
  } else {
    lines.push("No best match: no qualifying product has a displayable price.");
  }

  return lines.join("\n");
}

export function formatDailySummaryMessage(content: DailySummaryContent) {
  let message = `*DealRadar daily summary · ${content.summaryDate}*`;

  for (const monitor of content.monitors) {
    message += `\n\n${formatMonitor(monitor)}`;
  }

  if (content.monitorDefinitionsWarning !== null) {
    message +=
      `\n\nMonitor definitions were not updated (${escapeSlackText(content.monitorDefinitionsWarning)}); ` +
      "this summary uses the stored definitions.";
  }

  return message + formatScanWarnings(content.scanWarnings);
}

async function loadPreferenceWeightPercent(sql: DailySummarySql) {
  const [settings] = await sql`SELECT ranking FROM application_settings WHERE id = 1`;

  return (parseRankingSettings(settings?.ranking) ?? defaultRankingSettings).preferenceWeightPercent;
}

function storedText(content: unknown) {
  let value = content;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  const text = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>).text
    : null;

  return typeof text === "string" && text ? text : null;
}

type DailySummaryDependencies = DailySummaryWarnings & {
  sql: DailySummarySql;
  summaryDate: string;
  postSlackMessage: PostSlackMessage;
  now?: Date;
};

// Produces, persists, and sends the summary for one date (D13):
// - never after its date (P5): once the Copenhagen date has passed
//   summaryDate, nothing is created, claimed, or sent;
// - the first call that finds active monitors persists the content, and every
//   later call for the date sends that same content;
// - a send claims the row with a lease and token, uses the row's
//   deterministic client_message_id, and marks the row sent with the token;
// - a failed send releases the claim and throws, so the caller can retry.
export async function produceDailySummary({
  sql,
  summaryDate,
  postSlackMessage,
  monitorDefinitionsWarning,
  scanWarnings,
  now = new Date(),
}: DailySummaryDependencies): Promise<DailySummaryResult> {
  if (!isSummaryDate(summaryDate)) throw new Error("Invalid daily summary date.");

  if (getCopenhagenDate(now) > summaryDate) return { status: "expired" };

  const [existing] = await sql`
    SELECT status FROM daily_summaries WHERE summary_date = ${summaryDate}::DATE
  `;

  if (existing?.status === "sent") return { status: "already_sent" };

  if (!existing) {
    // D14: the summary is gated by data; without an active monitor there is
    // no summary and no row. Members are loaded only when one exists.
    const [activeMonitor] = await sql`
      SELECT 1 AS "active" FROM monitor_definitions
      WHERE enabled = TRUE AND removed_at IS NULL AND strategy IS NOT NULL
      LIMIT 1
    `;

    if (!activeMonitor) return { status: "no_active_monitors" };

    const monitors = await loadActiveMonitorMembers(sql);

    if (monitors.length === 0) return { status: "no_active_monitors" };

    const preferenceWeightPercent = await loadPreferenceWeightPercent(sql);
    const content: DailySummaryContent = {
      summaryDate,
      monitors: monitors.map((monitor) => buildDailySummaryMonitor(monitor, preferenceWeightPercent, now)),
      monitorDefinitionsWarning,
      scanWarnings,
    };

    // Content is persisted before any send. A concurrent first call keeps
    // whichever row was inserted first.
    await sql`
      INSERT INTO daily_summaries (summary_date, status, content, client_message_id)
      VALUES (
        ${summaryDate}::DATE,
        'pending',
        ${JSON.stringify({ ...content, text: formatDailySummaryMessage(content) })}::JSONB,
        concat(
          substr(md5('dealradar:daily-summary:' || ${summaryDate}::TEXT), 1, 8), '-',
          substr(md5('dealradar:daily-summary:' || ${summaryDate}::TEXT), 9, 4), '-4',
          substr(md5('dealradar:daily-summary:' || ${summaryDate}::TEXT), 14, 3), '-8',
          substr(md5('dealradar:daily-summary:' || ${summaryDate}::TEXT), 18, 3), '-',
          substr(md5('dealradar:daily-summary:' || ${summaryDate}::TEXT), 21, 12)
        )
      )
      ON CONFLICT (summary_date) DO NOTHING
    `;
  }

  const [claim] = await sql`
    UPDATE daily_summaries
    SET claimed_at = NOW(),
      claim_token = md5(clock_timestamp()::TEXT || random()::TEXT || summary_date::TEXT)
    WHERE summary_date = ${summaryDate}::DATE
      AND status = 'pending'
      AND (claimed_at IS NULL OR claimed_at <= NOW() - INTERVAL '15 minutes')
    RETURNING content, client_message_id AS "clientMessageId", claim_token AS "claimToken"
  `;
  const clientMessageId = claim?.clientMessageId;
  const claimToken = claim?.claimToken;

  // Sent or being sent by another call.
  if (typeof clientMessageId !== "string" || !clientMessageId || typeof claimToken !== "string" || !claimToken) {
    return { status: "claimed_elsewhere" };
  }

  try {
    const text = storedText(claim.content);

    if (text === null) throw new Error("Daily summary content is invalid.");

    const result = await postSlackMessage(text, clientMessageId);

    if (!result.success) throw new Error("Slack delivery failed.");

    const marked = await sql`
      UPDATE daily_summaries
      SET status = 'sent', sent_at = NOW(), claimed_at = NULL, claim_token = NULL
      WHERE summary_date = ${summaryDate}::DATE
        AND status = 'pending'
        AND claim_token = ${claimToken}
      RETURNING summary_date
    `;

    if (marked.length === 0) throw new Error("Daily summary could not be recorded as sent.");
  } catch {
    await sql`
      UPDATE daily_summaries
      SET claimed_at = NULL, claim_token = NULL
      WHERE summary_date = ${summaryDate}::DATE
        AND status = 'pending'
        AND claim_token = ${claimToken}
    `;
    throw new Error("Daily summary delivery failed and can be retried for the same date.");
  }

  return { status: "sent" };
}
