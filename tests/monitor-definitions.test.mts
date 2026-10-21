import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildMonitorPersistenceQueries,
  collectMonitorScanEvidence,
  collectProductMonitorIds,
  countMonitorIdsWithoutDefinition,
  loadMonitorDefinitions,
  parseMonitorDefinitionsDocument,
  parseMonitorDefinitionsText,
  type MonitorDefinitionsDocument,
  type MonitorDefinitionsSql,
} from "../lib/monitor-definitions.mts";

// Copy of the sample document Deals publishes at
// public/deals/monitor-recommendations.json (contract v1, design §14 shared
// contract fixture). Drift between the two is caught in review.
const publishedDocument = {
  contract_version: 1,
  monitor_count: 4,
  monitors: [
    {
      id: "vinted-mens-blazers-size-s",
      source: "vinted",
      display_name: "Vinted – blazers",
      enabled: true,
      recommendation: { strategy: "best_match", minimum_overall_score: 7 },
    },
    {
      id: "vinted-mens-pants-size-46",
      source: "vinted",
      display_name: "Vinted – trousers",
      enabled: true,
      recommendation: { strategy: "best_match", minimum_overall_score: 7 },
    },
    {
      id: "zalando-dk-mens-trousers-size-46",
      source: "zalando",
      display_name: "Zalando – trousers",
      enabled: true,
      recommendation: { strategy: "discount_threshold", minimum_discount_percent: 50 },
    },
    {
      id: "zalando-scarosso-shoes-42",
      source: "zalando",
      display_name: "Zalando – Scarosso shoes",
      enabled: true,
      recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20 },
    },
  ],
};

type Monitor = Record<string, unknown>;

function documentWith(monitors: unknown[], overrides: Record<string, unknown> = {}) {
  return { contract_version: 1, monitor_count: monitors.length, monitors, ...overrides };
}

function monitor(overrides: Monitor = {}): Monitor {
  return { ...publishedDocument.monitors[3], ...overrides };
}

function parsedDocument(value: unknown): MonitorDefinitionsDocument {
  const result = parseMonitorDefinitionsDocument(value);
  assert.equal(result.ok, true, result.ok ? undefined : result.warning);
  return (result as { document: MonitorDefinitionsDocument }).document;
}

function recordingSql() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("$"), values };
    queries.push(query);
    return Object.assign(Promise.resolve([]), query);
  }) as MonitorDefinitionsSql;
  return { sql, queries };
}

function jsonResponse(value: unknown) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 });
}

const documentUrl = "https://raw.githubusercontent.com/runethorbek/deals/abc123/public/deals/monitor-recommendations.json";

test("migration 028 creates monitor_definitions additively with the D4 columns and constraints", async () => {
  const migration = await readFile(new URL("../migrations/028_monitor_definitions.sql", import.meta.url), "utf8");
  const statements = migration.replace(/--.*$/gm, "");

  assert.match(statements, /CREATE TABLE monitor_definitions \(/);
  for (const column of [
    /monitor_id TEXT PRIMARY KEY/,
    /source TEXT NOT NULL/,
    /display_name TEXT,/,
    /enabled BOOLEAN NOT NULL/,
    /strategy TEXT\s+CHECK \(strategy IN \('discount_threshold', 'best_match'\)\)/,
    /minimum_discount_percent NUMERIC\(5,2\)/,
    /minimum_overall_score NUMERIC\(4,2\)/,
    /contract_version INTEGER NOT NULL/,
    /definition JSONB NOT NULL/,
    /definition_ref TEXT NOT NULL/,
    /first_seen_at TIMESTAMPTZ NOT NULL/,
    /updated_at TIMESTAMPTZ NOT NULL/,
    /removed_at TIMESTAMPTZ,/,
    /last_scan_checked_at TIMESTAMPTZ,/,
    /last_scan_ref TEXT,/,
  ]) {
    assert.match(statements, column);
  }

  // Exactly the threshold matching the strategy is set.
  const thresholdCheck = statements.slice(statements.indexOf("monitor_definitions_strategy_threshold_check"));
  assert.match(thresholdCheck, /strategy IS NULL\s+AND minimum_discount_percent IS NULL\s+AND minimum_overall_score IS NULL/);
  assert.match(thresholdCheck, /strategy IS NOT DISTINCT FROM 'discount_threshold'\s+AND minimum_discount_percent IS NOT NULL\s+AND minimum_overall_score IS NULL/);
  assert.match(thresholdCheck, /strategy IS NOT DISTINCT FROM 'best_match'\s+AND minimum_overall_score IS NOT NULL\s+AND minimum_discount_percent IS NULL/);
  assert.doesNotMatch(statements, /DROP|DELETE\s+FROM|UPDATE\s+|ALTER TABLE/i);
});

test("parses the published Deals document and maps sources to DealRadar values", () => {
  const document = parsedDocument(publishedDocument);

  assert.equal(document.contractVersion, 1);
  assert.deepEqual(
    document.definitions.map((definition) => ({ ...definition, definition: undefined })),
    [
      {
        monitorId: "vinted-mens-blazers-size-s", source: "vinted.com", displayName: "Vinted – blazers", enabled: true,
        strategy: "best_match", minimumDiscountPercent: null, minimumOverallScore: 7, definition: undefined,
      },
      {
        monitorId: "vinted-mens-pants-size-46", source: "vinted.com", displayName: "Vinted – trousers", enabled: true,
        strategy: "best_match", minimumDiscountPercent: null, minimumOverallScore: 7, definition: undefined,
      },
      {
        monitorId: "zalando-dk-mens-trousers-size-46", source: "zalando.dk", displayName: "Zalando – trousers", enabled: true,
        strategy: "discount_threshold", minimumDiscountPercent: 50, minimumOverallScore: null, definition: undefined,
      },
      {
        monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", displayName: "Zalando – Scarosso shoes", enabled: true,
        strategy: "discount_threshold", minimumDiscountPercent: 20, minimumOverallScore: null, definition: undefined,
      },
    ],
  );
  assert.deepEqual(document.definitions[0]!.definition, publishedDocument.monitors[0]);
});

test("accepts unconfigured, disabled, unnamed, and additive monitors", () => {
  const document = parsedDocument(documentWith([
    monitor({ id: "unconfigured", recommendation: null }),
    monitor({ id: "disabled", enabled: false }),
    monitor({ id: "unnamed", display_name: undefined }),
    monitor({ id: "null-name", display_name: null }),
    monitor({ id: "decimal-score", source: "vinted", recommendation: { strategy: "best_match", minimum_overall_score: 6.5 } }),
    monitor({ id: "zero-score", source: "zalando", recommendation: { strategy: "best_match", minimum_overall_score: 0 } }),
    monitor({ id: "additive", future_field: { nested: true } }),
  ], { future_top_level: "ignored" }));

  const byId = new Map(document.definitions.map((definition) => [definition.monitorId, definition]));
  assert.deepEqual(
    [byId.get("unconfigured")!.strategy, byId.get("unconfigured")!.minimumDiscountPercent, byId.get("unconfigured")!.minimumOverallScore],
    [null, null, null],
  );
  assert.equal(byId.get("disabled")!.enabled, false);
  assert.equal(byId.get("unnamed")!.displayName, null);
  assert.equal(byId.get("null-name")!.displayName, null);
  assert.equal(byId.get("decimal-score")!.minimumOverallScore, 6.5);
  assert.equal(byId.get("zero-score")!.minimumOverallScore, 0);
  assert.deepEqual(byId.get("additive")!.definition.future_field, { nested: true });
});

test("D3: an older Deals ref without the document (404) leaves definitions unchanged without a warning", async () => {
  const outcome = await loadMonitorDefinitions(async () => new Response("Not Found", { status: 404 }), documentUrl);

  assert.deepEqual(outcome, { status: "not_published", document: null, warning: null });
});

test("D3: another fetch failure leaves definitions unchanged with a warning", async (t) => {
  for (const [description, fetchDocument] of [
    ["HTTP 500", async () => new Response("error", { status: 500 })],
    ["HTTP 403", async () => new Response("forbidden", { status: 403 })],
    ["network error", async () => { throw new TypeError("fetch failed"); }],
    ["body read error", async () => ({ ok: true, status: 200, text: async () => { throw new TypeError("terminated"); } }) as unknown as Response],
  ] as const) {
    await t.test(description, async () => {
      const outcome = await loadMonitorDefinitions(fetchDocument, documentUrl);

      assert.equal(outcome.status, "unavailable");
      assert.equal(outcome.document, null);
      assert.equal(typeof outcome.warning, "string");
    });
  }
});

test("D3: the document is fetched once from the given URL", async () => {
  const fetched: string[] = [];
  const outcome = await loadMonitorDefinitions(async (url) => {
    fetched.push(url);
    return jsonResponse(publishedDocument);
  }, documentUrl);

  assert.equal(outcome.status, "applied");
  assert.deepEqual(fetched, [documentUrl]);
});

test("D3: an unknown contract_version ignores the document with a warning", async () => {
  const outcome = await loadMonitorDefinitions(async () => jsonResponse({ ...publishedDocument, contract_version: 2 }), documentUrl);

  assert.equal(outcome.status, "unsupported_version");
  assert.equal(outcome.document, null);
  assert.match(outcome.warning!, /contract_version 2/);
});

test("D3: an invalid document is rejected as a whole with a warning", async (t) => {
  const cases: Array<[string, unknown]> = [
    ["malformed JSON", "{\"contract_version\": 1, \"monitors\": ["],
    ["not an object", [publishedDocument]],
    ["missing contract_version", { ...publishedDocument, contract_version: undefined }],
    ["string contract_version", { ...publishedDocument, contract_version: "1" }],
    ["monitors not an array", { ...publishedDocument, monitors: {} }],
    ["monitor_count mismatch", { ...publishedDocument, monitor_count: 5 }],
    ["missing monitor_count", { ...publishedDocument, monitor_count: undefined }],
    ["duplicate ID", documentWith([monitor(), monitor({ display_name: "Other" })])],
    ["monitor not an object", documentWith([monitor({ id: "valid-first" }), "monitor"])],
    ["invalid ID", documentWith([monitor({ id: "Invalid ID!" })])],
    ["unknown source", documentWith([monitor({ source: "zalando.dk" })])],
    ["empty display_name", documentWith([monitor({ display_name: "" })])],
    ["untrimmed display_name", documentWith([monitor({ display_name: " Zalando " })])],
    ["display_name over 80 characters", documentWith([monitor({ display_name: "x".repeat(81) })])],
    ["non-boolean enabled", documentWith([monitor({ enabled: "true" })])],
    ["missing recommendation", documentWith([monitor({ recommendation: undefined })])],
    ["unknown strategy", documentWith([monitor({ recommendation: { strategy: "top_n", minimum_discount_percent: 20 } })])],
    ["discount threshold for Vinted", documentWith([monitor({ source: "vinted", recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20 } })])],
    ["discount threshold below 1", documentWith([monitor({ recommendation: { strategy: "discount_threshold", minimum_discount_percent: 0 } })])],
    ["discount threshold above 99", documentWith([monitor({ recommendation: { strategy: "discount_threshold", minimum_discount_percent: 100 } })])],
    ["non-integer discount threshold", documentWith([monitor({ recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20.5 } })])],
    ["string discount threshold", documentWith([monitor({ recommendation: { strategy: "discount_threshold", minimum_discount_percent: "20" } })])],
    ["missing threshold", documentWith([monitor({ recommendation: { strategy: "discount_threshold" } })])],
    ["mismatched threshold", documentWith([monitor({ recommendation: { strategy: "discount_threshold", minimum_overall_score: 7 } })])],
    ["unknown recommendation key", documentWith([monitor({ recommendation: { strategy: "discount_threshold", minimum_discount_percent: 20, minimum_price: 100 } })])],
    ["score above 10", documentWith([monitor({ recommendation: { strategy: "best_match", minimum_overall_score: 10.5 } })])],
    ["negative score", documentWith([monitor({ recommendation: { strategy: "best_match", minimum_overall_score: -1 } })])],
    ["score with two decimals", documentWith([monitor({ recommendation: { strategy: "best_match", minimum_overall_score: 7.25 } })])],
    ["recommendation not an object", documentWith([monitor({ recommendation: "best_match" })])],
    // One invalid definition after valid ones: no partial set is accepted.
    ["invalid last definition", documentWith([
      ...publishedDocument.monitors,
      monitor({ id: "zalando-z-invalid", recommendation: { strategy: "best_match", minimum_overall_score: 11 } }),
    ])],
  ];

  for (const [description, value] of cases) {
    await t.test(description, async () => {
      const outcome = await loadMonitorDefinitions(async () => jsonResponse(value), documentUrl);

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.document, null);
      assert.equal(typeof outcome.warning, "string");
    });
  }

  assert.equal(parseMonitorDefinitionsText("not json").ok, false);
});

test("D3: rejected or missing documents write no definition queries", () => {
  const { sql, queries } = recordingSql();

  assert.deepEqual(buildMonitorPersistenceQueries(sql, { ref: "abc123", document: null, scanEvidence: [] }), []);
  assert.equal(queries.length, 0);
});

test("D3: a valid document marks absent monitors removed and upserts every present monitor", () => {
  const { sql, queries } = recordingSql();
  const document = parsedDocument(publishedDocument);

  buildMonitorPersistenceQueries(sql, { ref: "def456", document, scanEvidence: [] });

  assert.equal(queries.length, 5);
  const [removal, ...upserts] = queries;

  // Absent monitor: removed_at is set once (the original removal time is kept).
  assert.match(removal!.text, /UPDATE monitor_definitions\s+SET removed_at = NOW\(\), updated_at = NOW\(\)\s+WHERE removed_at IS NULL\s+AND monitor_id NOT IN/);
  assert.deepEqual(JSON.parse(removal!.values[0] as string), publishedDocument.monitors.map((entry) => entry.id));
  assert.doesNotMatch(removal!.text, /DELETE/i);

  for (const [index, upsert] of upserts.entries()) {
    assert.match(upsert.text, /INSERT INTO monitor_definitions/);
    // Reappearance clears removed_at; a display_name, strategy, or threshold
    // change is an in-place update of the same row.
    assert.match(upsert.text, /ON CONFLICT \(monitor_id\) DO UPDATE SET/);
    for (const column of [
      "display_name", "enabled", "strategy", "minimum_discount_percent", "minimum_overall_score",
      "contract_version", "definition", "definition_ref", "updated_at",
    ]) {
      assert.match(upsert.text, new RegExp(`${column} = EXCLUDED\\.${column}`));
    }
    assert.match(upsert.text, /removed_at = NULL\s*$/);
    assert.doesNotMatch(upsert.text, /first_seen_at = /);
    assert.equal(upsert.values[0], publishedDocument.monitors[index]!.id);
  }
});

test("D3: enabled false is written as enabled = false, not removed", () => {
  const { sql, queries } = recordingSql();
  const document = parsedDocument(documentWith([monitor({ enabled: false })]));

  buildMonitorPersistenceQueries(sql, { ref: "abc123", document, scanEvidence: [] });

  const upsert = queries.find((query) => query.text.includes("INSERT INTO monitor_definitions"))!;
  assert.deepEqual(upsert.values.slice(0, 7), [
    "zalando-scarosso-shoes-42", "zalando.dk", "Zalando – Scarosso shoes", false, "discount_threshold", 20, null,
  ]);
  assert.deepEqual(JSON.parse(queries[0]!.values[0] as string), ["zalando-scarosso-shoes-42"]);
});

test("D3: a display_name or strategy change is written as new values for the same monitor ID", () => {
  const { sql, queries } = recordingSql();
  const document = parsedDocument(documentWith([
    monitor({ display_name: "Scarosso 42", recommendation: { strategy: "best_match", minimum_overall_score: 8 } }),
  ]));

  buildMonitorPersistenceQueries(sql, { ref: "abc123", document, scanEvidence: [] });

  const upsert = queries.find((query) => query.text.includes("INSERT INTO monitor_definitions"))!;
  assert.deepEqual(upsert.values.slice(0, 8), [
    "zalando-scarosso-shoes-42", "zalando.dk", "Scarosso 42", true, "best_match", null, 8, 1,
  ]);
});

test("D3: a valid document from an older ref replaces definitions and records that ref", () => {
  const { sql, queries } = recordingSql();
  const document = parsedDocument(publishedDocument);

  buildMonitorPersistenceQueries(sql, { ref: "0lderref", document, scanEvidence: [] });

  const upserts = queries.filter((query) => query.text.includes("INSERT INTO monitor_definitions"));
  assert.equal(upserts.length, 4);
  for (const upsert of upserts) {
    assert.equal(upsert.values[9], "0lderref");
    assert.match(upsert.text, /definition_ref = EXCLUDED\.definition_ref/);
    // No commit-order guard: the latest import is the truth (D3, R6).
    assert.doesNotMatch(upsert.text, /WHERE/);
  }
});

test("scan evidence is collected leniently from feed monitors[] and checked_at", () => {
  assert.deepEqual(
    collectMonitorScanEvidence("zalando.dk", {
      checked_at: "2026-10-20T05:40:00+02:00",
      monitors: [
        { id: "zalando-scarosso-shoes-42", source: "zalando" },
        { id: "zalando-scarosso-shoes-42" },
        { id: "Invalid ID!" },
        "not-an-object",
        null,
        { source: "zalando" },
        { id: "zalando-dk-mens-trousers-size-46", extra: true },
      ],
    }),
    [
      { monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", checkedAt: "2026-10-20T03:40:00.000Z" },
      { monitorId: "zalando-dk-mens-trousers-size-46", source: "zalando.dk", checkedAt: "2026-10-20T03:40:00.000Z" },
    ],
  );

  for (const payload of [
    { checked_at: "not a timestamp", monitors: [{ id: "zalando-scarosso-shoes-42" }] },
    { checked_at: 1760000000000, monitors: [{ id: "zalando-scarosso-shoes-42" }] },
    { monitors: [{ id: "zalando-scarosso-shoes-42" }] },
    { checked_at: "2026-10-20T03:40:00.000Z", monitors: "zalando-scarosso-shoes-42" },
    { checked_at: "2026-10-20T03:40:00.000Z" },
    null,
  ]) {
    assert.deepEqual(collectMonitorScanEvidence("zalando.dk", payload), []);
  }
});

test("scan evidence only moves forward with GREATEST and only updates existing definitions of the feed source", () => {
  const { sql, queries } = recordingSql();

  buildMonitorPersistenceQueries(sql, {
    ref: "abc123",
    document: null,
    scanEvidence: [{ monitorId: "vinted-mens-blazers-size-s", source: "vinted.com", checkedAt: "2026-10-20T02:45:00.000Z" }],
  });

  assert.equal(queries.length, 1);
  const [query] = queries;
  assert.match(query!.text, /^\s*UPDATE monitor_definitions/);
  assert.doesNotMatch(query!.text, /INSERT/);
  assert.match(query!.text, /last_scan_checked_at = GREATEST\(last_scan_checked_at, \$::TIMESTAMPTZ\)/);
  // The ref changes only when the timestamp advances, so an older ref never
  // moves either column backwards.
  assert.match(query!.text, /WHEN last_scan_checked_at IS NULL\s+OR last_scan_checked_at < \$::TIMESTAMPTZ\s+THEN \$::TEXT\s+ELSE last_scan_ref/);
  assert.match(query!.text, /WHERE monitor_id = \$\s+AND source = \$/);
  assert.deepEqual(query!.values, [
    "2026-10-20T02:45:00.000Z", "abc123", "2026-10-20T02:45:00.000Z", "vinted-mens-blazers-size-s", "vinted.com",
  ]);
});

test("definitions are applied before scan evidence", () => {
  const { sql, queries } = recordingSql();

  buildMonitorPersistenceQueries(sql, {
    ref: "abc123",
    document: parsedDocument(documentWith([monitor()])),
    scanEvidence: [{ monitorId: "zalando-scarosso-shoes-42", source: "zalando.dk", checkedAt: "2026-10-20T03:40:00.000Z" }],
  });

  assert.deepEqual(
    queries.map((query) => /GREATEST/.test(query.text) ? "evidence" : /INSERT/.test(query.text) ? "upsert" : "removal"),
    ["removal", "upsert", "evidence"],
  );
});

test("counts distinct valid product monitor IDs that have no definition", () => {
  const productMonitorIds = collectProductMonitorIds([
    { rawData: { monitor_ids: ["vinted-mens-blazers-size-s", "unknown-monitor"] } },
    { rawData: { monitor_ids: ["unknown-monitor", "other-unknown", "Invalid ID!", 7] } },
    { rawData: { monitor_ids: "vinted-mens-blazers-size-s" } },
    { rawData: {} },
  ]);

  assert.deepEqual([...productMonitorIds], ["vinted-mens-blazers-size-s", "unknown-monitor", "other-unknown"]);
  assert.equal(countMonitorIdsWithoutDefinition(productMonitorIds, new Set(["vinted-mens-blazers-size-s"])), 2);
  assert.equal(countMonitorIdsWithoutDefinition(productMonitorIds, new Set()), 3);
});
