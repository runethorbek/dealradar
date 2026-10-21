import { vintedSource, zalandoSource } from "./import-notification.mts";

// Monitor definitions published by Deals in
// public/deals/monitor-recommendations.json (#77; design D1-D4 in
// docs/specs/monitor-recommendation-design.md). The document is optional
// enrichment: no outcome here may fail the product import. This module has
// no Next.js or Vercel dependency, so the importer can run it anywhere.

type JsonObject = Record<string, unknown>;

export const monitorDefinitionsFileName = "monitor-recommendations.json";
export const supportedMonitorDefinitionsContractVersion = 1;

export type RecommendationStrategy = "discount_threshold" | "best_match";

export type MonitorDefinition = {
  monitorId: string;
  source: string;
  displayName: string | null;
  enabled: boolean;
  strategy: RecommendationStrategy | null;
  minimumDiscountPercent: number | null;
  minimumOverallScore: number | null;
  definition: JsonObject;
};

export type MonitorDefinitionsDocument = {
  contractVersion: number;
  definitions: MonitorDefinition[];
};

export type MonitorDefinitionsParseResult =
  | { ok: true; document: MonitorDefinitionsDocument }
  | { ok: false; status: "unsupported_version" | "rejected"; warning: string };

// "not_published" is an older Deals ref without the document (HTTP 404); it is
// not a warning. Every other non-applied status leaves stored definitions
// unchanged and carries a warning.
export type MonitorDefinitionsOutcome =
  | { status: "applied"; document: MonitorDefinitionsDocument; warning: null }
  | { status: "not_published"; document: null; warning: null }
  | {
      status: "unavailable" | "unsupported_version" | "rejected";
      document: null;
      warning: string;
    };

export type MonitorScanEvidence = {
  monitorId: string;
  source: string;
  checkedAt: string;
};

// Matches the subset of @neondatabase/serverless's `neon()` client used here.
export type MonitorDefinitionsSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<unknown[]>;

// Same monitor ID rules as product evaluation (lib/product-evaluation.ts).
const maximumMonitorIdLength = 120;
const monitorIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const maximumDisplayNameLength = 80;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidMonitorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumMonitorIdLength &&
    monitorIdPattern.test(value)
  );
}

function hasAtMostOneDecimal(value: number) {
  const tenths = value * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-9;
}

function parseRecommendation(
  value: unknown,
  dealsSource: unknown,
): Pick<MonitorDefinition, "strategy" | "minimumDiscountPercent" | "minimumOverallScore"> | null {
  if (value === null) {
    return { strategy: null, minimumDiscountPercent: null, minimumOverallScore: null };
  }

  if (!isObject(value)) return null;

  const keys = Object.keys(value).sort();

  if (value.strategy === "discount_threshold") {
    const threshold = value.minimum_discount_percent;
    const valid =
      keys.join(",") === "minimum_discount_percent,strategy" &&
      dealsSource === "zalando" &&
      typeof threshold === "number" &&
      Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= 99;

    return valid
      ? { strategy: "discount_threshold", minimumDiscountPercent: threshold, minimumOverallScore: null }
      : null;
  }

  if (value.strategy === "best_match") {
    const threshold = value.minimum_overall_score;
    const valid =
      keys.join(",") === "minimum_overall_score,strategy" &&
      typeof threshold === "number" &&
      Number.isFinite(threshold) &&
      threshold >= 0 &&
      threshold <= 10 &&
      hasAtMostOneDecimal(threshold);

    return valid
      ? { strategy: "best_match", minimumDiscountPercent: null, minimumOverallScore: threshold }
      : null;
  }

  return null;
}

function parseDisplayName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;

  return typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= maximumDisplayNameLength
    ? value
    : undefined;
}

function rejected(warning: string): MonitorDefinitionsParseResult {
  return { ok: false, status: "rejected", warning };
}

// Validates the whole document. Any invalid part rejects the whole document,
// so a partial set of definitions is never applied (D3). Unknown keys are
// ignored at the document and monitor level, but not inside `recommendation`
// (D1).
export function parseMonitorDefinitionsDocument(value: unknown): MonitorDefinitionsParseResult {
  if (!isObject(value)) return rejected("document is not a JSON object");

  const contractVersion = value.contract_version;

  if (typeof contractVersion !== "number" || !Number.isInteger(contractVersion)) {
    return rejected("contract_version is missing or not an integer");
  }

  if (contractVersion !== supportedMonitorDefinitionsContractVersion) {
    return {
      ok: false,
      status: "unsupported_version",
      warning: `contract_version ${contractVersion} is not supported`,
    };
  }

  if (!Array.isArray(value.monitors)) return rejected("monitors is not an array");

  if (value.monitor_count !== value.monitors.length) {
    return rejected("monitor_count does not match monitors.length");
  }

  const definitions: MonitorDefinition[] = [];
  const monitorIds = new Set<string>();

  for (const [index, monitor] of value.monitors.entries()) {
    if (!isObject(monitor)) return rejected(`monitors[${index}] is not an object`);

    if (!isValidMonitorId(monitor.id)) return rejected(`monitors[${index}] has an invalid id`);

    if (monitorIds.has(monitor.id)) return rejected(`monitors[${index}] has a duplicate id`);

    monitorIds.add(monitor.id);

    // Deals monitor sources map to DealRadar source values (D2).
    const dealsSource = monitor.source;
    const source = dealsSource === "vinted"
      ? vintedSource
      : dealsSource === "zalando"
        ? zalandoSource
        : undefined;

    if (!source) return rejected(`monitors[${index}] has an invalid source`);

    const displayName = parseDisplayName(monitor.display_name);

    if (displayName === undefined) return rejected(`monitors[${index}] has an invalid display_name`);

    if (typeof monitor.enabled !== "boolean") return rejected(`monitors[${index}] has an invalid enabled flag`);

    if (!Object.hasOwn(monitor, "recommendation")) {
      return rejected(`monitors[${index}] has no recommendation`);
    }

    const recommendation = parseRecommendation(monitor.recommendation, dealsSource);

    if (!recommendation) return rejected(`monitors[${index}] has an invalid recommendation`);

    definitions.push({
      monitorId: monitor.id,
      source,
      displayName,
      enabled: monitor.enabled,
      ...recommendation,
      definition: monitor,
    });
  }

  return { ok: true, document: { contractVersion, definitions } };
}

export function parseMonitorDefinitionsText(text: string): MonitorDefinitionsParseResult {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return rejected("document is not valid JSON");
  }

  return parseMonitorDefinitionsDocument(value);
}

// Fetches the document once and maps every compatibility case of D3 to an
// outcome. It never throws.
export async function loadMonitorDefinitions(
  fetchDocument: (url: string) => Promise<Response>,
  url: string,
): Promise<MonitorDefinitionsOutcome> {
  let text: string;

  try {
    const response = await fetchDocument(url);

    if (response.status === 404) {
      return { status: "not_published", document: null, warning: null };
    }

    if (!response.ok) {
      return { status: "unavailable", document: null, warning: `document returned HTTP ${response.status}` };
    }

    text = await response.text();
  } catch {
    return { status: "unavailable", document: null, warning: "document request failed" };
  }

  const parsed = parseMonitorDefinitionsText(text);

  return parsed.ok
    ? { status: "applied", document: parsed.document, warning: null }
    : { status: parsed.status, document: null, warning: parsed.warning };
}

// Scan evidence comes from a feed's `monitors[]` and `checked_at`. Like
// `scan_status`, it is parsed leniently: an unparsable `checked_at` or a
// malformed entry is ignored without failing the import.
export function collectMonitorScanEvidence(source: string, payload: unknown): MonitorScanEvidence[] {
  if (!isObject(payload) || !Array.isArray(payload.monitors)) return [];

  const checkedAt = payload.checked_at;

  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) return [];

  const checkedAtIso = new Date(checkedAt).toISOString();
  const monitorIds = new Set<string>();

  for (const monitor of payload.monitors) {
    if (isObject(monitor) && isValidMonitorId(monitor.id)) monitorIds.add(monitor.id);
  }

  return [...monitorIds].map((monitorId) => ({ monitorId, source, checkedAt: checkedAtIso }));
}

// Product-monitor membership stored in products.monitor_ids (#78, design D5).
// Same rules as product evaluation: invalid entries are dropped without
// failing the product, feed order is kept, and at most the first 20 valid IDs
// are kept. A missing or non-array value is no membership. Migration 029
// backfills with the same rules in SQL.
const maximumProductMonitorIds = 20;

export function normalizeProductMonitorIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isValidMonitorId).slice(0, maximumProductMonitorIds);
}

export function collectProductMonitorIds(products: Array<{ rawData: JsonObject }>) {
  const monitorIds = new Set<string>();

  for (const product of products) {
    const values = product.rawData.monitor_ids;

    if (!Array.isArray(values)) continue;

    for (const value of values) {
      if (isValidMonitorId(value)) monitorIds.add(value);
    }
  }

  return monitorIds;
}

export function countMonitorIdsWithoutDefinition(
  productMonitorIds: Iterable<string>,
  definedMonitorIds: ReadonlySet<string>,
) {
  let count = 0;

  for (const monitorId of productMonitorIds) {
    if (!definedMonitorIds.has(monitorId)) count += 1;
  }

  return count;
}

export async function loadDefinedMonitorIds(sql: MonitorDefinitionsSql) {
  const rows = await sql`SELECT monitor_id FROM monitor_definitions`;

  return new Set(
    rows.flatMap((row) =>
      isObject(row) && typeof row.monitor_id === "string" ? [row.monitor_id] : [],
    ),
  );
}

// A monitor absent from a valid document is marked removed; its row, history,
// and scan evidence are kept. The original removal time is preserved.
export function buildRemovedMonitorDefinitionsQuery(
  sql: MonitorDefinitionsSql,
  presentMonitorIds: string[],
) {
  return sql`
    UPDATE monitor_definitions
    SET removed_at = NOW(), updated_at = NOW()
    WHERE removed_at IS NULL
      AND monitor_id NOT IN (
        SELECT jsonb_array_elements_text(${JSON.stringify(presentMonitorIds)}::JSONB)
      )
  `;
}

// Inserts a new monitor or updates it in place. A monitor that reappears in a
// document has `removed_at` cleared. `definition_ref` records the import ref
// the definition came from, including an older ref imported after a newer one.
export function buildMonitorDefinitionUpsertQuery(
  sql: MonitorDefinitionsSql,
  definition: MonitorDefinition,
  contractVersion: number,
  ref: string,
) {
  return sql`
    INSERT INTO monitor_definitions (
      monitor_id,
      source,
      display_name,
      enabled,
      strategy,
      minimum_discount_percent,
      minimum_overall_score,
      contract_version,
      definition,
      definition_ref,
      first_seen_at,
      updated_at,
      removed_at
    ) VALUES (
      ${definition.monitorId},
      ${definition.source},
      ${definition.displayName},
      ${definition.enabled},
      ${definition.strategy},
      ${definition.minimumDiscountPercent},
      ${definition.minimumOverallScore},
      ${contractVersion},
      ${JSON.stringify(definition.definition)}::JSONB,
      ${ref},
      NOW(),
      NOW(),
      NULL
    )
    ON CONFLICT (monitor_id) DO UPDATE SET
      source = EXCLUDED.source,
      display_name = EXCLUDED.display_name,
      enabled = EXCLUDED.enabled,
      strategy = EXCLUDED.strategy,
      minimum_discount_percent = EXCLUDED.minimum_discount_percent,
      minimum_overall_score = EXCLUDED.minimum_overall_score,
      contract_version = EXCLUDED.contract_version,
      definition = EXCLUDED.definition,
      definition_ref = EXCLUDED.definition_ref,
      updated_at = EXCLUDED.updated_at,
      removed_at = NULL
  `;
}

// Updates only existing definitions of the feed's source; scan evidence never
// creates a definition. GREATEST keeps an older feed from moving the evidence
// backwards, and the ref changes only when the timestamp advances.
export function buildMonitorScanEvidenceQuery(
  sql: MonitorDefinitionsSql,
  evidence: MonitorScanEvidence,
  ref: string,
) {
  return sql`
    UPDATE monitor_definitions
    SET
      last_scan_ref = CASE
        WHEN last_scan_checked_at IS NULL
          OR last_scan_checked_at < ${evidence.checkedAt}::TIMESTAMPTZ
        THEN ${ref}::TEXT
        ELSE last_scan_ref
      END,
      last_scan_checked_at = GREATEST(last_scan_checked_at, ${evidence.checkedAt}::TIMESTAMPTZ)
    WHERE monitor_id = ${evidence.monitorId}
      AND source = ${evidence.source}
  `;
}

export type MonitorPersistence = {
  ref: string;
  document: MonitorDefinitionsDocument | null;
  scanEvidence: MonitorScanEvidence[];
};

// Definitions are applied before scan evidence so evidence from the same ref
// reaches monitors first defined by this import.
export function buildMonitorPersistenceQueries(
  sql: MonitorDefinitionsSql,
  { ref, document, scanEvidence }: MonitorPersistence,
) {
  const definitionQueries = document
    ? [
        buildRemovedMonitorDefinitionsQuery(
          sql,
          document.definitions.map((definition) => definition.monitorId),
        ),
        ...document.definitions.map((definition) =>
          buildMonitorDefinitionUpsertQuery(sql, definition, document.contractVersion, ref),
        ),
      ]
    : [];

  return [
    ...definitionQueries,
    ...scanEvidence.map((evidence) => buildMonitorScanEvidenceQuery(sql, evidence, ref)),
  ];
}
