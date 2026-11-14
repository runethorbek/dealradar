import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverPendingWatchedAlerts,
  detectWatchedAlerts,
  findWatchedAlerts,
  formatWatchedAlertMessage,
  recordWatchedAlerts,
  selectWatchedAlertSnapshotIds,
  type PendingWatchedAlert,
  type WatchedAlertObservation,
  type WatchedAlertSql,
} from "../lib/watched-alerts.mts";

// Watched alerts (#81, #89; design D12, D13, P1(b)(i), P4(c), P5(b), P6(a),
// P10(a)).

// An observation: a discount with a price, null for a priced observation with
// no detected discount, "priceless" for a snapshot without a price, or an
// explicit snapshot.
type Entry = number | null | "priceless" | Partial<WatchedAlertObservation>;

function observation(entry: Entry, index: number, productId: string): WatchedAlertObservation {
  const base = { snapshotId: `${productId}-${index}`, currentPrice: "500.00", currency: "DKK" };

  if (entry === "priceless") return { ...base, currentPrice: null, currency: null, discountPercent: "25.00" };
  if (entry === null) return { ...base, discountPercent: null };
  if (typeof entry === "number") return { ...base, discountPercent: entry.toFixed(2) };

  return { ...base, discountPercent: null, ...entry };
}

// One Watched, visible product whose last entry is the observation inserted
// by this import, against monitors with the given thresholds.
function detect(
  entries: Entry[],
  thresholds: number[] = [20],
  { source = "zalando.dk", inserted }: {
    source?: string;
    inserted?: string[];
  } = {},
) {
  const observations = entries.map((entry, index) => observation(entry, index, "1"));

  return detectWatchedAlerts(
    [{
      productId: "1",
      source,
      monitors: thresholds.map((thresholdPercent, index) => ({ monitorId: `monitor-${index}`, thresholdPercent })),
      observations,
    }],
    new Set(inserted ?? [observations.at(-1)!.snapshotId]),
  );
}

const reasons = (entries: Entry[], thresholds?: number[]) =>
  detect(entries, thresholds).map((candidate) => candidate.reason);

test("the #72 §9 sequence alerts on the crossing, the new best, and the crossing after the episode ended", () => {
  const sequence = [15, 20, 20, 25, 25, 10, 20];
  const alerts = sequence.map((_, index) => reasons(sequence.slice(0, index + 1)));

  assert.deepEqual(alerts, [[], ["crossing"], [], ["new_best"], [], [], ["crossing"]]);
});

test("a candidate records the monitor, observation, discount, and threshold at detection time", () => {
  assert.deepEqual(detect([15, 25]), [{
    productId: "1",
    monitorId: "monitor-0",
    snapshotId: "1-1",
    discountPercent: 25,
    thresholdPercent: 20,
    reason: "crossing",
  }]);
});

test("D12 transition rule", async (t) => {
  const cases: Array<[string, Entry[], string[]]> = [
    ["no earlier observation", [25], []],
    ["no earlier priced observation", ["priceless", "priceless", 25], []],
    ["below the threshold", [15, 19.99], []],
    ["crossing from just below the threshold", [19.99, 20], ["crossing"]],
    ["a priced observation with no detected discount counts as 0% and ends the episode", [25, null, 25], ["crossing"]],
    ["a priceless snapshot is skipped and does not end the episode", [25, "priceless", 25], []],
    ["an out-of-range discount is skipped and does not end the episode", [25, { discountPercent: "100.00" }, 25], []],
    ["a priced zero discount counts as 0% and ends the episode", [25, { discountPercent: "0.00" }, 25], ["crossing"]],
    ["a negative discount is out of range and skipped", [25, { discountPercent: "-5.00" }, 25], []],
    ["a snapshot without currency is skipped", [25, { currency: null, discountPercent: null }, 25], []],
    ["new best within the episode", [15, 25, 22, 26], ["new_best"]],
    ["below the episode's best", [15, 25, 22, 24], []],
    ["the episode is the run before o, not all history", [30, 10, 21, 25], ["new_best"]],
    ["floored: 20.9 is not an improvement over 20.0", [15, 20, 20.9], []],
    ["floored: the next whole percentage is an improvement", [15, 20.9, 21], ["new_best"]],
    ["repeated identical observations", [15, 25, 25, 25], []],
  ];

  for (const [name, entries, expected] of cases) {
    await t.test(name, () => assert.deepEqual(reasons(entries), expected));
  }
});

test("D12 lifecycle table", async (t) => {
  await t.test("Watch after crossing: the stored history decides, so the existing state does not alert", () => {
    // 25% was observed before Watch; detection only starts once Watched.
    assert.deepEqual(reasons([15, 25, 25]), []);
    assert.deepEqual(reasons([15, 25, 25, 26]), ["new_best"], "the next new best alerts");
  });

  // Hidden exclusion itself is a detection-query filter: it is covered by the
  // SQL filter assertion below and by the integration test.
  await t.test("Unhide does not alert by itself: the history-based baseline gives no alert for an unchanged discount", () => {
    assert.deepEqual(reasons([15, 25, 25]), []);
  });

  await t.test("unavailable, then reappearing: compared with the previous priced observation", () => {
    assert.deepEqual(reasons([15, 25, 25]), [], "unchanged after reappearing");
    assert.deepEqual(reasons([25, 10, 25]), ["crossing"], "fell below before disappearing");
  });

  await t.test("threshold lowered: a product already above it does not alert until a new best", () => {
    assert.deepEqual(reasons([15, 15], [10]), []);
    assert.deepEqual(reasons([15, 15, 16], [10]), ["new_best"]);
  });

  await t.test("threshold raised: the higher threshold applies to history and can end an episode", () => {
    assert.deepEqual(reasons([20, 25, 30], [30]), ["crossing"]);
    assert.deepEqual(reasons([20, 25, 28], [30]), [], "still below the raised threshold");
  });

  await t.test("price falls and recovers: the episode ends and a later crossing alerts again", () => {
    assert.deepEqual(reasons([15, 25, null, 25]), ["crossing"]);
  });

  await t.test("repeated observation with the same observed_at or an import retry: no inserted snapshot", () => {
    assert.deepEqual(detect([15, 25], [20], { inserted: [] }), []);
  });

  await t.test("an inserted observation that is not the latest does not alert", () => {
    assert.deepEqual(detect([15, 25, 10], [20], { inserted: ["1-1"] }), []);
  });

  await t.test("several monitors are detected independently", () => {
    assert.deepEqual(
      detect([22, 26], [20, 25, 30]).map((candidate) => [candidate.monitorId, candidate.reason, candidate.thresholdPercent]),
      [["monitor-0", "new_best", 20], ["monitor-1", "crossing", 25]],
    );
  });
});

test("the alerted observation needs a reliable discount at or above the threshold (D8)", async (t) => {
  await t.test("non-Zalando", () => assert.deepEqual(detect([15, 25], [20], { source: "vinted.com" }), []));
  await t.test("no detected discount", () => assert.deepEqual(reasons([15, null]), []));
  await t.test("no price", () => assert.deepEqual(reasons([15, "priceless"]), []));
  await t.test("no currency", () => assert.deepEqual(reasons([15, { discountPercent: "25.00", currency: null }]), []));
  await t.test("out of range", () => assert.deepEqual(reasons([15, { discountPercent: "100.00" }]), []));
});

test("only inserted snapshots with a reliable discount are queried", () => {
  const result = (overrides: Record<string, unknown>) => ({
    source: "zalando.dk", snapshotId: "10", currentPrice: "500.00", currency: "DKK", discountPercent: "25.00", ...overrides,
  });

  assert.deepEqual(selectWatchedAlertSnapshotIds([
    result({}),
    result({ snapshotId: null }),
    result({ snapshotId: "11", source: "vinted.com" }),
    result({ snapshotId: "12", discountPercent: null }),
    result({ snapshotId: "13", currency: null }),
    result({ snapshotId: "14", currentPrice: null }),
    result({ snapshotId: "15", discountPercent: "100.00" }),
  ]), ["10"]);
});

function recordingSql(rowsFor: (query: string, values: unknown[]) => Array<Record<string, unknown>>) {
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const sql: WatchedAlertSql = async (strings, ...values) => {
    const query = strings.join("$parameter");
    queries.push({ query, values });
    return rowsFor(query, values);
  };

  return { sql, queries };
}

const historyRows = [
  { snapshotId: "50", productId: "5", source: "zalando.dk", monitors: [{ monitorId: "zalando-shoes", thresholdPercent: "20.00" }], currentPrice: "600.00", currency: "DKK", discountPercent: "15.00" },
  { snapshotId: "51", productId: "5", source: "zalando.dk", monitors: [{ monitorId: "zalando-shoes", thresholdPercent: "20.00" }], currentPrice: "500.00", currency: "DKK", discountPercent: "25.00" },
];

test("detection is one query over Watched, visible products in active discount_threshold monitors", async () => {
  const { sql, queries } = recordingSql((query) => query.includes("FROM product_snapshots s") ? historyRows : []);

  assert.deepEqual(await findWatchedAlerts(sql, []), [], "no inserted snapshot, no query");
  assert.equal(queries.length, 0);

  const candidates = await findWatchedAlerts(sql, ["51"]);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]!.values, [["51"]]);
  assert.match(queries[0]!.query, /m\.strategy = 'discount_threshold'/, "best_match monitors never alert (P10(a))");
  assert.match(queries[0]!.query, /m\.enabled = TRUE\s+AND m\.removed_at IS NULL/);
  assert.match(queries[0]!.query, /AND p\.watched\s+AND NOT p\.hidden/);
  assert.match(queries[0]!.query, /ANY\(p\.monitor_ids\)/);
  assert.deepEqual(candidates, [{
    productId: "5", monitorId: "zalando-shoes", snapshotId: "51", discountPercent: 25, thresholdPercent: 20, reason: "crossing",
  }]);
});

test("detected alerts are inserted once per product, monitor, and snapshot", async () => {
  const { sql, queries } = recordingSql((query) => query.includes("FROM product_snapshots s") ? historyRows : []);

  await recordWatchedAlerts(sql, ["51"]);

  const insert = queries.find(({ query }) => query.includes("INSERT INTO watched_alerts"));
  assert.ok(insert);
  // One untargeted ON CONFLICT covers the (product, monitor, snapshot) key and
  // the historical-low (product, snapshot) key of migration 032.
  assert.match(insert.query, /ON CONFLICT DO NOTHING/);
  assert.match(insert.query, /md5\('dealradar:watched-alert:' \|\| r\.product_id::TEXT \|\| ':' \|\| r\.snapshot_id::TEXT\)/);
  assert.deepEqual(JSON.parse(insert.values[0] as string), [{
    product_id: "5", monitor_id: "zalando-shoes", snapshot_id: "51", discount_percent: 25, threshold_percent: 20,
    drop_percent: null, reason: "crossing",
  }]);
});

test("P4(c): threshold alerts are detected when a historical-low event exists, and the event is stored as a historical_low alert", async () => {
  const { sql, queries } = recordingSql((query) => query.includes("FROM product_snapshots s") ? historyRows : []);

  assert.deepEqual(await recordWatchedAlerts(sql, ["51"], [{ productId: "5", snapshotId: "51", dropPercent: 16.6667 }]), [
    { productId: "5", monitorId: "zalando-shoes", snapshotId: "51", discountPercent: 25, thresholdPercent: 20, reason: "crossing" },
    { productId: "5", snapshotId: "51", dropPercent: 16.6667, reason: "historical_low" },
  ]);

  const inserts = queries.filter(({ query }) => query.includes("INSERT INTO watched_alerts"));
  assert.deepEqual(inserts.map(({ values }) => JSON.parse(values[0] as string)), [
    [{ product_id: "5", monitor_id: "zalando-shoes", snapshot_id: "51", discount_percent: 25, threshold_percent: 20, drop_percent: null, reason: "crossing" }],
    [{ product_id: "5", monitor_id: null, snapshot_id: "51", discount_percent: null, threshold_percent: null, drop_percent: 16.6667, reason: "historical_low" }],
  ], "threshold and historical-low rows are inserted independently");
});

test("threshold and historical-low alerts are recorded independently: a failure in one is logged and does not lose the other", async (t) => {
  const event = { productId: "5", snapshotId: "51", dropPercent: 16.6667 };
  const record = async (fails: (query: string, values: unknown[]) => boolean) => {
    const queries: string[] = [];
    const warnings: unknown[] = [];
    const sql: WatchedAlertSql = async (strings, ...values) => {
      const query = strings.join("$parameter");
      if (fails(query, values)) throw new Error("connection reset");
      queries.push(query);
      return query.includes("FROM product_snapshots s") ? historyRows : [];
    };
    const warn = console.warn;
    console.warn = (message: unknown) => { warnings.push(message); };
    try {
      return { recorded: await recordWatchedAlerts(sql, ["51"], [event]), queries, warnings };
    } finally {
      console.warn = warn;
    }
  };
  const insertOf = (reason: string) => (query: string, values: unknown[]) =>
    query.includes("INSERT INTO watched_alerts") && String(values[0]).includes(`"reason":"${reason}"`);

  await t.test("threshold detection query fails: the historical low is still stored", async () => {
    const { recorded, queries, warnings } = await record((query) => query.includes("FROM product_snapshots s"));
    assert.deepEqual(recorded, [{ ...event, reason: "historical_low" }]);
    assert.equal(queries.filter((query) => query.includes("INSERT INTO watched_alerts")).length, 1);
    assert.deepEqual(warnings, ["DealRadar Watched alert detection failed."]);
  });

  await t.test("threshold insert fails: the historical low is still stored", async () => {
    const { recorded, warnings } = await record(insertOf("crossing"));
    assert.deepEqual(recorded, [{ ...event, reason: "historical_low" }]);
    assert.deepEqual(warnings, ["DealRadar Watched alert detection failed."]);
  });

  await t.test("historical-low insert fails: the threshold alert is still stored", async () => {
    const { recorded, warnings } = await record(insertOf("historical_low"));
    assert.deepEqual(recorded.map((candidate) => candidate.reason), ["crossing"]);
    assert.deepEqual(warnings, ["DealRadar watched historical-low alert recording failed."]);
  });
});

test("a historical-low event is stored without a monitor, a threshold transition, or a reliable discount", async () => {
  // No inserted snapshot with a reliable discount, so no threshold query; the
  // product is in no discount_threshold monitor.
  const { sql, queries } = recordingSql(() => []);

  assert.deepEqual(await recordWatchedAlerts(sql, [], [{ productId: "7", snapshotId: "71", dropPercent: 10 }]), [
    { productId: "7", snapshotId: "71", dropPercent: 10, reason: "historical_low" },
  ]);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.query, /INSERT INTO watched_alerts/);
  assert.deepEqual(JSON.parse(queries[0]!.values[0] as string), [
    { product_id: "7", monitor_id: null, snapshot_id: "71", discount_percent: null, threshold_percent: null, drop_percent: 10, reason: "historical_low" },
  ]);

  const empty = recordingSql(() => []);
  assert.deepEqual(await recordWatchedAlerts(empty.sql, [], []), []);
  assert.equal(empty.queries.length, 0, "nothing detected, nothing stored");
});

function pendingRow(overrides: Partial<Record<keyof PendingWatchedAlert, unknown>> = {}) {
  return {
    alertId: "1", productId: "5", monitorId: "zalando-shoes", snapshotId: "51",
    discountPercent: "25.00", thresholdPercent: "20.00", dropPercent: null, reason: "crossing", clientMessageId: "client-5-51",
    title: "Watched <shoe>", externalUrl: "https://www.zalando.dk/shoe", source: "zalando.dk",
    watched: true, hidden: false, member: true, monitorActive: true,
    displayName: "Zalando – shoes", currentThresholdPercent: "20.00",
    productCurrentPrice: "500.00", productCurrency: "DKK", productSourceCurrentPrice: null, productSourceCurrency: null,
    productDiscountPercent: "25.00",
    observedPrice: "500.00", observedCurrency: "DKK", observedSourcePrice: null, observedSourceCurrency: null,
    observedDiscountPercent: "25.00",
    preferenceScore: null, dealScore: null,
    ...overrides,
  };
}

// A pending historical_low row (migration 032): no monitor, discount, or
// threshold, and the drop percent versus the previous observation.
function historicalLowRow(overrides: Partial<Record<keyof PendingWatchedAlert, unknown>> = {}) {
  return pendingRow({
    alertId: "9", monitorId: null, discountPercent: null, thresholdPercent: null, dropPercent: "16.6667",
    reason: "historical_low", member: false, monitorActive: false, displayName: null, currentThresholdPercent: null,
    ...overrides,
  });
}

// A store of pending rows behind the delivery queries. Claims and marks
// follow the SQL semantics closely enough to observe claim, release, sent,
// and expiry.
function deliverySql(rows: Array<Record<string, unknown>>) {
  const state = new Map(rows.map((row) => [String(row.alertId), { row, status: "pending", token: null as string | null }]));
  const queries: string[] = [];
  let tokens = 0;
  const sql: WatchedAlertSql = async (strings, ...values) => {
    const query = strings.join("$parameter");
    queries.push(query);
    const ids = (values[0] ?? []) as string[];

    if (query.includes("FROM watched_alerts alert")) {
      return [...state.values()].filter((entry) => entry.status === "pending" && entry.token === null).map((entry) => entry.row);
    }
    if (query.includes("SET status = 'expired'")) {
      return ids.flatMap((id) => {
        const entry = state.get(id)!;
        if (entry.status !== "pending" || entry.token !== null) return [];
        entry.status = "expired";
        return [{ id }];
      });
    }
    if (query.includes("FROM application_settings")) return [{ ranking: null }];
    if (query.includes("SET claimed_at = NOW()")) {
      tokens += 1;
      return ids.flatMap((id) => {
        const entry = state.get(id)!;
        if (entry.status !== "pending" || entry.token !== null) return [];
        entry.token = `token-${tokens}`;
        return [{ alertId: id, claimToken: entry.token }];
      });
    }
    if (query.includes("SET status = 'sent'")) {
      return ids.flatMap((id) => {
        const entry = state.get(id)!;
        if (entry.status !== "pending" || entry.token !== values[1]) return [];
        entry.status = "sent";
        entry.token = null;
        return [{ id }];
      });
    }
    if (query.includes("SET claimed_at = NULL, claim_token = NULL")) {
      for (const id of ids) {
        const entry = state.get(id)!;
        if (entry.token === values[1]) entry.token = null;
      }
      return [];
    }
    throw new Error(`Unexpected query: ${query}`);
  };

  return { sql, queries, status: (id: string) => state.get(id)?.status };
}

type Delivery = { message: string; clientMessageId: string | undefined };

function slack(results: boolean[] = []) {
  const deliveries: Delivery[] = [];
  const postSlackMessage = async (message: string, clientMessageId?: string) => {
    deliveries.push({ message, clientMessageId });
    return (results.shift() ?? true) ? { success: true } : { success: false, error: "unavailable" };
  };

  return { deliveries, postSlackMessage };
}

test("delivery sends one message per product and observation, listing every triggering monitor", async () => {
  const { sql, status } = deliverySql([
    pendingRow(),
    pendingRow({ alertId: "2", monitorId: "zalando-all-shoes", displayName: null, reason: "new_best", thresholdPercent: "15.00", currentThresholdPercent: "15.00" }),
    pendingRow({ alertId: "3", productId: "6", snapshotId: "61", clientMessageId: "client-6-61", title: "Other", preferenceScore: 8, dealScore: 6 }),
  ]);
  const { deliveries, postSlackMessage } = slack();

  assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 2, expired: 0 });
  assert.deepEqual(deliveries.map((delivery) => delivery.clientMessageId), ["client-5-51", "client-6-61"]);
  assert.equal(
    deliveries[0]!.message,
    "*DealRadar Watched alert*\n" +
      "Watched &lt;shoe&gt;\n" +
      "500.00 DKK · 25% discount · <https://www.zalando.dk/shoe|View product>\n" +
      "• zalando-all-shoes: new best in the qualifying episode (threshold 15%)\n" +
      "• Zalando – shoes: crossed the 20% threshold",
  );
  assert.match(deliveries[1]!.message, /500\.00 DKK · 25% discount · Overall 7\.2 · </, "Overall is shown when evaluated");
  assert.deepEqual(["1", "2", "3"].map(status), ["sent", "sent", "sent"]);

  // At most once: a later delivery finds nothing pending.
  assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 0, expired: 0 });
  assert.equal(deliveries.length, 2);
});

test("a failed send releases the claim, other observations are still sent, and a retry resends with the same client_msg_id", async () => {
  const { sql, status } = deliverySql([
    pendingRow(),
    pendingRow({ alertId: "3", productId: "6", snapshotId: "61", clientMessageId: "client-6-61" }),
  ]);
  const { deliveries, postSlackMessage } = slack([false, true]);
  const warn = console.warn;
  console.warn = () => {};

  try {
    await assert.rejects(deliverPendingWatchedAlerts({ sql, postSlackMessage }), /can be retried/);
  } finally {
    console.warn = warn;
  }

  assert.equal(status("1"), "pending");
  assert.equal(status("3"), "sent");

  assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 1, expired: 0 });
  assert.equal(deliveries.length, 3);
  assert.deepEqual(deliveries[2], deliveries[0], "the retry resends the same message");
  assert.equal(status("1"), "sent");
});

test("P5(b): pending alerts that are no longer Watched, visible, and qualifying expire", async (t) => {
  const cases: Array<[string, Partial<Record<keyof PendingWatchedAlert, unknown>>]> = [
    ["no longer Watched", { watched: false }],
    ["Hidden", { hidden: true }],
    ["no longer a member of the monitor", { member: false }],
    ["monitor disabled, removed, or best_match", { monitorActive: false }],
    ["threshold raised above the current discount", { currentThresholdPercent: "30.00" }],
    ["current discount below the threshold", { productDiscountPercent: "10.00" }],
    ["current discount no longer reliable", { productDiscountPercent: null }],
    ["current price unknown", { productCurrentPrice: null }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const { sql, status } = deliverySql([pendingRow(overrides)]);
      const { deliveries, postSlackMessage } = slack();

      assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 0, expired: 1 });
      assert.equal(deliveries.length, 0);
      assert.equal(status("1"), "expired");
    });
  }

  await t.test("only the expired monitor is left out of the message", async () => {
    const { sql, status } = deliverySql([
      pendingRow(),
      pendingRow({ alertId: "2", monitorId: "zalando-other", monitorActive: false }),
    ]);
    const { deliveries, postSlackMessage } = slack();

    assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 1, expired: 1 });
    assert.doesNotMatch(deliveries[0]!.message, /zalando-other/);
    assert.deepEqual([status("1"), status("2")], ["sent", "expired"]);
  });
});

test("P4(c): a historical low and threshold alerts of the same observation go out as one message listing every reason", async () => {
  const { sql, status } = deliverySql([
    pendingRow(),
    pendingRow({ alertId: "2", monitorId: "zalando-all-shoes", displayName: null, reason: "new_best", thresholdPercent: "15.00", currentThresholdPercent: "15.00" }),
    historicalLowRow(),
  ]);
  const { deliveries, postSlackMessage } = slack();

  assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 1, expired: 0 });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.clientMessageId, "client-5-51", "the rows share client_message_id");
  assert.equal(
    deliveries[0]!.message,
    "*DealRadar Watched alert*\n" +
      "Watched &lt;shoe&gt;\n" +
      "500.00 DKK · 25% discount · <https://www.zalando.dk/shoe|View product>\n" +
      "• Historical low: 16.67% below the previous price, at or below its lowest earlier price\n" +
      "• zalando-all-shoes: new best in the qualifying episode (threshold 15%)\n" +
      "• Zalando – shoes: crossed the 20% threshold",
  );
  assert.deepEqual(["1", "2", "9"].map(status), ["sent", "sent", "sent"]);
});

test("a historical low alone is delivered without a monitor, with the observation's discount only when it is reliable", async () => {
  const { sql, status } = deliverySql([
    historicalLowRow(),
    historicalLowRow({ alertId: "10", productId: "6", snapshotId: "61", clientMessageId: "client-6-61", observedDiscountPercent: null }),
  ]);
  const { deliveries, postSlackMessage } = slack();

  assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 2, expired: 0 });
  assert.equal(
    deliveries[0]!.message,
    "*DealRadar Watched alert*\n" +
      "Watched &lt;shoe&gt;\n" +
      "500.00 DKK · 25% discount · <https://www.zalando.dk/shoe|View product>\n" +
      "• Historical low: 16.67% below the previous price, at or below its lowest earlier price",
  );
  assert.match(deliveries[1]!.message, /\n500\.00 DKK · <https:/, "no detected discount: none is shown");
  assert.deepEqual([status("9"), status("10")], ["sent", "sent"]);
});

test("P5(b): a pending historical-low alert is delivered only while the product is Watched, visible, and still at most the alerted price", async (t) => {
  const cases: Array<[string, Partial<Record<keyof PendingWatchedAlert, unknown>>, "sent" | "expired"]> = [
    ["still low: delivered", {}, "sent"],
    ["price fallen further: delivered", { productCurrentPrice: "450.00" }, "sent"],
    ["price since raised: expired", { productCurrentPrice: "500.01" }, "expired"],
    ["no longer Watched: expired", { watched: false }, "expired"],
    ["Hidden: expired", { hidden: true }, "expired"],
    ["currency changed: expired", { productCurrency: "EUR" }, "expired"],
    ["current price unknown: expired", { productCurrentPrice: null }, "expired"],
    // The detection compared the source pair, so delivery compares it too.
    ["source pair still low although the normalized price rose: delivered", {
      observedSourcePrice: "60.00", observedSourceCurrency: "EUR", productSourceCurrentPrice: "60.00", productSourceCurrency: "EUR",
      productCurrentPrice: "520.00",
    }, "sent"],
    ["source pair raised: expired", {
      observedSourcePrice: "60.00", observedSourceCurrency: "EUR", productSourceCurrentPrice: "61.00", productSourceCurrency: "EUR",
    }, "expired"],
  ];

  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      const { sql, status } = deliverySql([historicalLowRow(overrides)]);
      const { deliveries, postSlackMessage } = slack();

      assert.deepEqual(
        await deliverPendingWatchedAlerts({ sql, postSlackMessage }),
        expected === "sent" ? { sent: 1, expired: 0 } : { sent: 0, expired: 1 },
      );
      assert.equal(deliveries.length, expected === "sent" ? 1 : 0);
      assert.equal(status("9"), expected);
    });
  }

  await t.test("threshold deliverability is unchanged: an expired historical low leaves the threshold alert in its message", async () => {
    // The price rose above the alerted 500.00, but the discount still qualifies.
    const { sql, status } = deliverySql([
      pendingRow({ productCurrentPrice: "600.00" }),
      historicalLowRow({ productCurrentPrice: "600.00" }),
    ]);
    const { deliveries, postSlackMessage } = slack();

    assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 1, expired: 1 });
    assert.doesNotMatch(deliveries[0]!.message, /Historical low/);
    assert.deepEqual([status("1"), status("9")], ["sent", "expired"]);
  });
});

test("nothing pending: one read and no Slack call", async () => {
  const { sql, queries } = deliverySql([]);
  const { deliveries, postSlackMessage } = slack();

  assert.deepEqual(await deliverPendingWatchedAlerts({ sql, postSlackMessage }), { sent: 0, expired: 0 });
  assert.equal(queries.length, 1);
  assert.equal(deliveries.length, 0);
});

test("the message falls back to the observation's source price", () => {
  const message = formatWatchedAlertMessage([{
    ...pendingRow(),
    discountPercent: 25,
    thresholdPercent: 20,
    currentThresholdPercent: 20,
    productDiscountPercent: 25,
    observedPrice: null,
    observedCurrency: null,
    observedSourcePrice: "60.00",
    observedSourceCurrency: "EUR",
  } as PendingWatchedAlert], 60);

  assert.match(message, /\n60\.00 EUR · 25% discount · /);
});
