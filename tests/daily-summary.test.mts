import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailySummaryMonitor,
  formatDailySummaryMessage,
  getCopenhagenDate,
  isSummaryDate,
  produceDailySummary,
  type DailySummaryContent,
  type DailySummaryMonitor,
  type DailySummarySql,
} from "../lib/daily-summary.mts";
import type { MonitorCandidate, MonitorMembers } from "../lib/monitor-recommendation.mts";

// Daily summary (#80; design D11, D13, P5, P12).

const summaryDate = "2026-10-22";
// 2026-10-22 07:00 in Copenhagen (CEST, UTC+2).
const now = new Date("2026-10-22T05:00:00.000Z");
const scanAt = "2026-10-22T03:40:00.000Z";

function candidate(overrides: Partial<MonitorCandidate> = {}): MonitorCandidate {
  return {
    productId: "1",
    title: "Test shoe",
    externalUrl: "https://www.zalando.dk/test-shoe",
    source: "zalando.dk",
    currentPrice: "1200.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    discountPercent: 25,
    preferenceScore: 8,
    dealScore: 7,
    hidden: false,
    lastSeenAt: scanAt,
    ...overrides,
  };
}

function monitor(overrides: Partial<DailySummaryMonitor> = {}): DailySummaryMonitor {
  return {
    monitorId: "zalando-scarosso-shoes-42",
    displayName: "Zalando – Scarosso shoes",
    source: "zalando.dk",
    strategy: "discount_threshold",
    threshold: 20,
    freshness: "current",
    lastScanCheckedAt: scanAt,
    qualifyingCount: 3,
    notYetEvaluatedCount: 1,
    bestMatch: {
      productId: "1",
      title: "Test shoe",
      externalUrl: "https://www.zalando.dk/test-shoe",
      price: "1200.00",
      currency: "DKK",
      discountPercent: 25,
      overallScore: 7.6,
    },
    ...overrides,
  };
}

function content(monitors: DailySummaryMonitor[], overrides: Partial<DailySummaryContent> = {}): DailySummaryContent {
  return { summaryDate, monitors, monitorDefinitionsWarning: null, scanWarnings: [], ...overrides };
}

test("the summary date is the Europe/Copenhagen calendar date", () => {
  assert.equal(getCopenhagenDate(new Date("2026-10-21T21:59:59.000Z")), "2026-10-21");
  assert.equal(getCopenhagenDate(new Date("2026-10-21T22:00:00.000Z")), "2026-10-22", "CEST is UTC+2");
  assert.equal(getCopenhagenDate(new Date("2026-12-31T22:59:59.000Z")), "2026-12-31");
  assert.equal(getCopenhagenDate(new Date("2026-12-31T23:00:00.000Z")), "2027-01-01", "CET is UTC+1");
  assert.equal(isSummaryDate("2026-10-22"), true);
  assert.equal(isSummaryDate("2026-02-30"), false);
  assert.equal(isSummaryDate("2026-10-22T00:00:00Z"), false);
  assert.equal(isSummaryDate(undefined), false);
});

test("formats a current monitor with its best match", () => {
  const message = formatDailySummaryMessage(content([monitor()]));

  assert.equal(
    message,
    "*DealRadar daily summary · 2026-10-22*\n\n" +
    "*Zalando – Scarosso shoes*\n" +
    "Strategy: discount threshold · at least 20% discount\n" +
    "Qualifying: 3 · Not yet evaluated: 1\n" +
    "Best match: Test shoe\n" +
    "1200.00 DKK · 25% discount · Overall 7.6 · <https://www.zalando.dk/test-shoe|View product>",
  );
});

test("uses the monitor ID when there is no display name, and shows a best_match strategy", () => {
  const message = formatDailySummaryMessage(content([monitor({
    monitorId: "vinted-mens-blazers-size-s",
    displayName: null,
    source: "vinted.com",
    strategy: "best_match",
    threshold: 7,
    qualifyingCount: 2,
    notYetEvaluatedCount: 4,
    bestMatch: {
      productId: "9",
      title: "Blazer <wool> & silk",
      externalUrl: "https://www.vinted.dk/items/9-blazer",
      price: "150.00",
      currency: "DKK",
      discountPercent: null,
      overallScore: 8.25,
    },
  })]));

  assert.match(message, /\n\n\*vinted-mens-blazers-size-s\*\n/);
  assert.match(message, /Strategy: best match · Overall at least 7\.0\n/);
  assert.match(message, /Qualifying: 2 · Not yet evaluated: 4\n/);
  assert.match(message, /Best match: Blazer &lt;wool&gt; &amp; silk\n150\.00 DKK · Overall 8\.3 · <https:\/\/www\.vinted\.dk\/items\/9-blazer\|View product>$/);
  assert.doesNotMatch(message, /discount/, "no discount is shown where none applies");
});

test("states the freshness of stale and never-scanned monitors and shows no best match", () => {
  const message = formatDailySummaryMessage(content([
    monitor({ freshness: "stale", lastScanCheckedAt: "2026-10-20T03:40:00.123456Z", bestMatch: null }),
    monitor({
      monitorId: "never",
      displayName: "Never scanned monitor",
      freshness: "never_scanned",
      lastScanCheckedAt: null,
      qualifyingCount: 0,
      notYetEvaluatedCount: 0,
      bestMatch: null,
    }),
  ]));

  assert.match(
    message,
    /\*Zalando – Scarosso shoes\*\nStrategy: [^\n]+\nStale: the latest scan \(2026-10-20 03:40 UTC\) is older than 36 hours\. Counts are from that scan; no best match is shown\.\nQualifying: 3 · Not yet evaluated: 1\n\n/,
  );
  assert.match(
    message,
    /\*Never scanned monitor\*\nStrategy: [^\n]+\nNever scanned: no scan of this monitor has been imported; no best match is shown\.\nQualifying: 0 · Not yet evaluated: 0$/,
  );
  assert.doesNotMatch(message, /Best match:|No products qualify/);
});

test("states clearly when nothing qualifies or no qualifying product can be shown", () => {
  const nothing = formatDailySummaryMessage(content([monitor({ qualifyingCount: 0, notYetEvaluatedCount: 0, bestMatch: null })]));
  assert.match(nothing, /Qualifying: 0 · Not yet evaluated: 0\nNo products qualify\.$/);

  const noneEvaluated = formatDailySummaryMessage(content([monitor({ qualifyingCount: 2, notYetEvaluatedCount: 2, bestMatch: null })]));
  assert.match(noneEvaluated, /Qualifying: 2 · Not yet evaluated: 2\nNo best match: no qualifying product is evaluated yet\.$/);

  const noPrice = formatDailySummaryMessage(content([monitor({ qualifyingCount: 2, notYetEvaluatedCount: 0, bestMatch: null })]));
  assert.match(noPrice, /No best match: no qualifying product has a displayable price\.$/);
});

test("repeats the monitor definitions warning and scan warnings", () => {
  const message = formatDailySummaryMessage(content([monitor()], {
    monitorDefinitionsWarning: "unavailable: document returned HTTP 500",
    scanWarnings: [{
      sourceName: "Zalando",
      successfulPages: 2,
      attemptedPages: 3,
      failedPages: 1,
      failures: [{ name: "Shoes", url: "https://www.zalando.dk/shoes", error: "timeout" }],
    }],
  }));

  assert.match(
    message,
    /\n\nMonitor definitions were not updated \(unavailable: document returned HTTP 500\); this summary uses the stored definitions\.\n\nScan warnings:\n• Zalando: 2\/3 pages succeeded; 1 failed\n  ◦ Shoes — https:\/\/www\.zalando\.dk\/shoes: timeout$/,
  );
});

test("builds monitor entries from the S4 policy, including the not-yet-evaluated count", () => {
  const unevaluated = { preferenceScore: null, dealScore: null };
  const discountMonitor: MonitorMembers = {
    policy: { monitorId: "d", source: "zalando.dk", displayName: null, strategy: "discount_threshold", minimumDiscountPercent: 20 },
    lastScanCheckedAt: scanAt,
    candidates: [
      candidate({ productId: "1" }),
      candidate({ productId: "2", ...unevaluated }),
      candidate({ productId: "3", discountPercent: 10, ...unevaluated }),
    ],
  };
  const bestMatchMonitor: MonitorMembers = {
    policy: { monitorId: "b", source: "zalando.dk", displayName: "Best", strategy: "best_match", minimumOverallScore: 7 },
    lastScanCheckedAt: scanAt,
    candidates: [
      candidate({ productId: "1" }),
      candidate({ productId: "2", ...unevaluated }),
      candidate({ productId: "3", discountPercent: 10, ...unevaluated }),
      candidate({ productId: "4", preferenceScore: 2, dealScore: 2 }),
    ],
  };

  assert.deepEqual(buildDailySummaryMonitor(discountMonitor, 60, now), {
    monitorId: "d",
    displayName: null,
    source: "zalando.dk",
    strategy: "discount_threshold",
    threshold: 20,
    freshness: "current",
    lastScanCheckedAt: scanAt,
    qualifyingCount: 2,
    notYetEvaluatedCount: 1,
    bestMatch: {
      productId: "1",
      title: "Test shoe",
      externalUrl: "https://www.zalando.dk/test-shoe",
      price: "1200.00",
      currency: "DKK",
      discountPercent: 25,
      overallScore: 7.6,
    },
  });

  const bestMatch = buildDailySummaryMonitor(bestMatchMonitor, 60, now);
  assert.equal(bestMatch.qualifyingCount, 1);
  assert.equal(bestMatch.notYetEvaluatedCount, 2, "fresh unevaluated members of a best_match monitor");
  assert.equal(bestMatch.threshold, 7);
  assert.equal(bestMatch.bestMatch?.productId, "1");

  const stale = buildDailySummaryMonitor({ ...discountMonitor, lastScanCheckedAt: "2026-10-20T03:40:00.000Z", candidates: discountMonitor.candidates.map((item) => ({ ...item, lastSeenAt: "2026-10-20T03:40:00.000Z" })) }, 60, now);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.bestMatch, null);
});

// In-memory daily_summaries row and loader rows behind the SQL tag.
function fakeDatabase(options: { monitors?: Array<Record<string, unknown>> } = {}) {
  const state = {
    monitors: options.monitors ?? [loaderRow()],
    row: null as null | {
      status: "pending" | "sent";
      content: unknown;
      clientMessageId: string;
      claimToken: string | null;
      claimed: boolean;
    },
    events: [] as string[],
    queries: 0,
    tokens: 0,
  };
  const sql: DailySummarySql = async (strings, ...values) => {
    const query = strings.join("$parameter");
    state.queries += 1;

    if (query.includes("SELECT status FROM daily_summaries")) {
      return state.row ? [{ status: state.row.status }] : [];
    }
    if (query.includes("SELECT 1 AS \"active\" FROM monitor_definitions")) {
      return state.monitors.length > 0 ? [{ active: 1 }] : [];
    }
    if (query.includes("FROM monitor_definitions")) {
      state.events.push("load");
      return state.monitors;
    }
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
    if (query.includes("INSERT INTO daily_summaries")) {
      state.events.push("insert");
      assert.equal(values[0], summaryDate);
      assert.match(query, /md5\('dealradar:daily-summary:'/);
      if (!state.row) {
        state.row = {
          status: "pending",
          content: JSON.parse(values[1] as string),
          clientMessageId: `client-${String(values[2])}`,
          claimToken: null,
          claimed: false,
        };
      }
      return [];
    }
    if (query.includes("SET claimed_at = NOW()")) {
      if (!state.row || state.row.status !== "pending" || state.row.claimed) return [];
      state.tokens += 1;
      state.row.claimed = true;
      state.row.claimToken = `token-${state.tokens}`;
      state.events.push("claim");
      return [{ content: state.row.content, clientMessageId: state.row.clientMessageId, claimToken: state.row.claimToken }];
    }
    if (query.includes("SET status = 'sent'")) {
      if (!state.row || state.row.claimToken !== values.at(-1)) return [];
      state.row.status = "sent";
      state.row.claimed = false;
      state.row.claimToken = null;
      state.events.push("mark-sent");
      return [{ summary_date: summaryDate }];
    }
    if (query.includes("SET claimed_at = NULL, claim_token = NULL")) {
      if (state.row && state.row.claimToken === values.at(-1)) {
        state.row.claimed = false;
        state.row.claimToken = null;
        state.events.push("release");
      }
      return [];
    }
    throw new Error(`Unexpected query: ${query}`);
  };

  return { sql, state };
}

function loaderRow(overrides: Record<string, unknown> = {}) {
  return {
    monitorId: "zalando-scarosso-shoes-42",
    monitorSource: "zalando.dk",
    displayName: "Zalando – Scarosso shoes",
    strategy: "discount_threshold",
    minimumDiscountPercent: "20.00",
    minimumOverallScore: null,
    lastScanCheckedAt: scanAt,
    productId: "1",
    title: "Test shoe",
    externalUrl: "https://www.zalando.dk/test-shoe",
    source: "zalando.dk",
    currentPrice: "1200.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    discountPercent: "25.00",
    hidden: false,
    lastSeenAt: scanAt,
    preferenceScore: 8,
    dealScore: 7,
    ...overrides,
  };
}

function slack(outcomes: Array<"ok" | "fail" | "throw"> = []) {
  const deliveries: Array<{ message: string; clientMessageId: string | undefined }> = [];
  let call = 0;
  const postSlackMessage = async (message: string, clientMessageId?: string) => {
    deliveries.push({ message, clientMessageId });
    const outcome = outcomes[call] ?? "ok";
    call += 1;
    if (outcome === "throw") throw new Error("network");
    return outcome === "fail" ? { success: false, error: "unavailable" } : { success: true };
  };

  return { deliveries, postSlackMessage };
}

const noWarnings = { monitorDefinitionsWarning: null, scanWarnings: [] };

test("persists the content before sending, sends once, and does nothing once sent", async () => {
  const { sql, state } = fakeDatabase();
  const { deliveries, postSlackMessage } = slack();
  const send = async (message: string, clientMessageId?: string) => {
    state.events.push("send");
    return postSlackMessage(message, clientMessageId);
  };

  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage: send, now, ...noWarnings }), { status: "sent" });
  assert.deepEqual(state.events, ["load", "insert", "claim", "send", "mark-sent"]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.clientMessageId, `client-${summaryDate}`);
  assert.match(deliveries[0]!.message, /^\*DealRadar daily summary · 2026-10-22\*\n\n\*Zalando – Scarosso shoes\*/);
  assert.equal((state.row!.content as { text: string }).text, deliveries[0]!.message, "the sent text is the persisted text");
  assert.equal((state.row!.content as DailySummaryContent).monitors[0]!.bestMatch?.productId, "1");

  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage: send, now, ...noWarnings }), { status: "already_sent" });
  assert.equal(deliveries.length, 1);
});

test("a failed send releases the claim, and a retry resends the same content with the same client_msg_id", async () => {
  const { sql, state } = fakeDatabase();
  const { deliveries, postSlackMessage } = slack(["fail", "throw", "ok"]);

  await assert.rejects(produceDailySummary({ sql, summaryDate, postSlackMessage, now, ...noWarnings }), /can be retried/);
  assert.equal(state.row!.status, "pending");
  assert.equal(state.row!.claimed, false, "the claim is released");

  await assert.rejects(produceDailySummary({ sql, summaryDate, postSlackMessage, now, ...noWarnings }), /can be retried/);
  assert.equal(state.row!.claimed, false, "a thrown send also releases the claim");

  // Persisted state changed in between; the retry still sends the stored content.
  state.monitors = [loaderRow({ title: "Changed title" })];
  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage, now, ...noWarnings }), { status: "sent" });

  assert.equal(deliveries.length, 3);
  assert.equal(new Set(deliveries.map((delivery) => delivery.message)).size, 1);
  assert.equal(new Set(deliveries.map((delivery) => delivery.clientMessageId)).size, 1);
  assert.doesNotMatch(deliveries[2]!.message, /Changed title/);
  assert.equal(state.events.filter((event) => event === "insert").length, 1, "content is built once per date");
  assert.equal(state.row!.status, "sent");
});

test("does not send while another call holds the claim", async () => {
  const { sql, state } = fakeDatabase();
  const { deliveries, postSlackMessage } = slack();
  state.row = { status: "pending", content: { text: "stored" }, clientMessageId: "client-1", claimToken: "other", claimed: true };

  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage, now, ...noWarnings }), { status: "claimed_elsewhere" });
  assert.equal(deliveries.length, 0);
  assert.equal(state.row.claimToken, "other", "another owner's claim is not released");
});

test("a later call on the same date sends an unsent summary even without active monitors now", async () => {
  const { sql, state } = fakeDatabase({ monitors: [] });
  const { deliveries, postSlackMessage } = slack();
  state.row = { status: "pending", content: { text: "stored summary" }, clientMessageId: "client-1", claimToken: null, claimed: false };

  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage, now, ...noWarnings }), { status: "sent" });
  assert.deepEqual(deliveries, [{ message: "stored summary", clientMessageId: "client-1" }]);
  assert.ok(!state.events.includes("load"));
});

test("is never sent after its date", async () => {
  const { sql, state } = fakeDatabase();
  const { deliveries, postSlackMessage } = slack();
  state.row = { status: "pending", content: { text: "stored summary" }, clientMessageId: "client-1", claimToken: null, claimed: false };

  // 2026-10-23 00:00 in Copenhagen.
  const nextDay = new Date("2026-10-22T22:00:00.000Z");
  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage, now: nextDay, ...noWarnings }), { status: "expired" });
  assert.equal(state.queries, 0, "nothing is created or claimed");
  assert.equal(deliveries.length, 0);

  // The last minute of the date still sends.
  const lastMinute = new Date("2026-10-22T21:59:00.000Z");
  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage, now: lastMinute, ...noWarnings }), { status: "sent" });
});

test("produces no summary when there is no active monitor", async () => {
  const { sql, state } = fakeDatabase({ monitors: [] });
  const { deliveries, postSlackMessage } = slack();

  assert.deepEqual(await produceDailySummary({ sql, summaryDate, postSlackMessage, now, ...noWarnings }), { status: "no_active_monitors" });
  assert.equal(state.row, null);
  assert.equal(deliveries.length, 0);
});

test("persists the triggering import's warnings with the content", async () => {
  const { sql, state } = fakeDatabase();
  const { deliveries, postSlackMessage } = slack();

  await produceDailySummary({
    sql,
    summaryDate,
    postSlackMessage,
    now,
    monitorDefinitionsWarning: "rejected: monitors is not an array",
    scanWarnings: [{ sourceName: "Vinted", successfulPages: 1, attemptedPages: 2, failedPages: 1, failures: [{ name: "Blazers", url: null, error: "HTTP 503" }] }],
  });

  assert.match(deliveries[0]!.message, /Monitor definitions were not updated \(rejected: monitors is not an array\)/);
  assert.match(deliveries[0]!.message, /Scan warnings:\n• Vinted: 1\/2 pages succeeded; 1 failed\n  ◦ Blazers: HTTP 503$/);
  assert.equal((state.row!.content as DailySummaryContent).monitorDefinitionsWarning, "rejected: monitors is not an array");
});

test("rejects an invalid summary date", async () => {
  const { sql } = fakeDatabase();
  const { postSlackMessage } = slack();

  await assert.rejects(produceDailySummary({ sql, summaryDate: "22-10-2026", postSlackMessage, now, ...noWarnings }), /Invalid daily summary date/);
});
