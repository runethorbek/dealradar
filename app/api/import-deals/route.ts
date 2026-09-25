import { neon } from "@neondatabase/serverless";
import {
  selectEvaluationCandidatesWithPreselection,
} from "@/lib/import-evaluation.mts";
import {
  persistImportedProducts,
  type ImportPersistenceSql,
  type NormalizedProduct,
} from "@/lib/import-persistence.mts";
import { defaultVintedSettings, parseVintedSettings } from "@/lib/vinted-settings.mts";
import { defaultGeminiSettings, parseGeminiSettings } from "@/lib/gemini-settings.mts";
import { defaultRankingSettings, parseRankingSettings } from "@/lib/ranking-settings.mts";
import {
  formatImportSlackMessage,
  parsePartialScanWarning,
  zalandoSource,
} from "@/lib/import-notification.mts";
import {
  findWatchedHistoricalLows,
  loadWatchedHistoricalLowCandidates,
  selectWatchedHistoricalLowRecommendation,
} from "@/lib/watched-historical-low.mts";
import { postSlackMessage } from "@/lib/slack";
import { createEvaluationRun } from "@/lib/evaluation-runs.mts";
import { resumePendingEvaluationRunWorkflows, startEvaluationRunWorkflow } from "@/workflows/evaluation-run-orchestration";

export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

type NormalizationResult = {
  products: NormalizedProduct[];
  productsSkippedInvalidPrice: number;
};

class SourceDataError extends Error {}

const repositoryUrl = "https://raw.githubusercontent.com/runethorbek/deals";
const sources = [
  {
    name: "Zalando",
    expectedSite: "zalando.dk",
    expectedProductDomain: "zalando.dk",
    fileName: "zalando-latest.json",
    priceField: "current_price",
  },
  {
    name: "Vinted",
    expectedSite: "vinted.com",
    expectedProductDomain: "vinted.dk",
    fileName: "vinted-latest.json",
    priceField: "price",
  },
] as const;

function isValidGitRef(ref: string) {
  const hasSafeCharacters = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref);
  const hasInvalidPath =
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => part.endsWith(".lock"));

  return hasSafeCharacters && !hasInvalidPath;
}

function asObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceDataError(`${context} must be a JSON object.`);
  }

  return value as JsonObject;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalHttpsUrl(value: unknown) {
  const text = optionalString(value);

  if (!text) {
    return null;
  }

  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname ? text : null;
  } catch {
    return null;
  }
}

function optionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isExpectedRetailerHostname(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function validateFeed(
  payloadValue: unknown,
  definition: (typeof sources)[number],
) {
  const payload = asObject(payloadValue, `${definition.name} feed`);

  if (!Array.isArray(payload.products)) {
    throw new SourceDataError(
      `${definition.name} feed does not contain a products array.`,
    );
  }

  if (payload.site !== definition.expectedSite) {
    throw new SourceDataError(
      `${definition.name} feed site must be ${definition.expectedSite}.`,
    );
  }

  if (
    payload.product_count !== undefined &&
    payload.product_count !== payload.products.length
  ) {
    throw new SourceDataError(
      `${definition.name} feed product_count does not match products.length.`,
    );
  }

  const urls = new Set<string>();

  for (const productValue of payload.products) {
    const product = asObject(productValue, `${definition.name} feed product`);
    const urlText = product.url;

    if (
      typeof urlText !== "string" ||
      !urlText.trim() ||
      urlText !== urlText.trim()
    ) {
      throw new SourceDataError(`${definition.name} feed product URL is invalid.`);
    }

    let url: URL;

    try {
      url = new URL(urlText);
    } catch {
      throw new SourceDataError(`${definition.name} feed product URL is invalid.`);
    }

    if (
      url.protocol !== "https:" ||
      !isExpectedRetailerHostname(
        url.hostname.toLowerCase(),
        definition.expectedProductDomain,
      )
    ) {
      throw new SourceDataError(`${definition.name} feed product URL is invalid.`);
    }

    if (urls.has(urlText)) {
      throw new SourceDataError(`${definition.name} feed contains duplicate product URLs.`);
    }

    urls.add(urlText);
  }

  return payload;
}

function currentPrice(value: unknown) {
  return value === null || (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  )
    ? value
    : undefined;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function validTimestamp(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }

  return new Date().toISOString();
}

function normalizeProducts(
  payload: JsonObject,
  definition: (typeof sources)[number],
) : NormalizationResult {
  const source = definition.expectedSite;
  const productValues = payload.products as unknown[];
  let productsSkippedInvalidPrice = 0;

  const products = productValues.flatMap((productValue): NormalizedProduct[] => {
    if (
      typeof productValue !== "object" ||
      productValue === null ||
      Array.isArray(productValue)
    ) {
      return [];
    }

    const product = productValue as JsonObject;
    const externalUrl = optionalHttpsUrl(product.url);
    const title = optionalString(product.title);
    const imageUrl = optionalString(product.image);
    const sourceCurrentPrice = currentPrice(product[definition.priceField]);
    const sourceOriginalPrice = optionalNumber(product.original_price);
    const sourceCurrency = optionalString(product.currency);

    if (sourceCurrentPrice === undefined) {
      productsSkippedInvalidPrice += 1;
      return [];
    }

    if (!externalUrl || !title) {
      return [];
    }

    const availabilitySize =
      definition.priceField === "price"
        ? optionalString(product.size_guess) ??
          optionalString(payload.target_size_id)
        : optionalString(product.target_size) ?? optionalString(payload.target_size);

    let available = optionalBoolean(product.available);

    if (available === null && availabilitySize) {
      available = optionalBoolean(product[`size_${availabilitySize}_available`]);
    }

    if (available === null && definition.priceField === "price") {
      available = true;
    }

    const prices = {
      currentPrice: sourceCurrentPrice,
      originalPrice: sourceOriginalPrice,
      currency: sourceCurrency,
      sourceCurrentPrice: null,
      sourceOriginalPrice: null,
      sourceCurrency: null,
    };

    return [{
      source,
      externalUrl,
      title,
      imageUrl,
      currentPrice: prices.currentPrice,
      originalPrice: prices.originalPrice,
      currency: prices.currency,
      sourceCurrentPrice: prices.sourceCurrentPrice,
      sourceOriginalPrice: prices.sourceOriginalPrice,
      sourceCurrency: prices.sourceCurrency,
      discountPercent: optionalNumber(product.discount_percent),
      available,
      brand: optionalString(product.brand),
      observedAt: validTimestamp(product.checked_at, payload.checked_at),
      rawData: product,
    }];
  });

  return { products, productsSkippedInvalidPrice };
}

async function fetchSourcePayload(
  definition: (typeof sources)[number],
  ref: string,
) {
  const url = `${repositoryUrl}/${ref}/public/deals/${definition.fileName}`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new SourceDataError(
      `${definition.name} feed returned HTTP ${response.status}.`,
    );
  }

  return response.json() as Promise<unknown>;
}

export async function POST(request: Request) {
  const ingestApiKey = process.env.INGEST_API_KEY;
  const authorization = request.headers.get("authorization");

  if (!ingestApiKey || authorization !== `Bearer ${ingestApiKey}`) {
    return Response.json(
      {
        success: false,
        error: "Unauthorized.",
      },
      { status: 401 },
    );
  }

  const ref = new URL(request.url).searchParams.get("ref") ?? "main";

  if (!isValidGitRef(ref)) {
    return Response.json(
      {
        success: false,
        error: "Invalid ref.",
      },
      { status: 400 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      {
        success: false,
        ref,
        error: "DATABASE_URL is not configured on the server.",
      },
      { status: 500 },
    );
  }

  try {
    const sourcePayloads = await Promise.all(
      sources.map((source) => fetchSourcePayload(source, ref)),
    );
    const partialScanWarnings = sourcePayloads.flatMap((payload, index) => {
      const warning = parsePartialScanWarning(sources[index].name, payload);
      return warning ? [warning] : [];
    });
    const validatedPayloads = sourcePayloads.map((payload, index) =>
      validateFeed(payload, sources[index]),
    );
    const normalizationResults = validatedPayloads.map((payload, index) =>
      normalizeProducts(payload, sources[index]),
    );
    const products = normalizationResults.flatMap((result) => result.products);
    const productsSkippedInvalidPrice = normalizationResults.reduce(
      (total, result) => total + result.productsSkippedInvalidPrice,
      0,
    );
    const sql = neon(databaseUrl);

    // neon()'s `transaction()` overload set is more specific than the
    // minimal shape `persistImportedProducts` needs (see
    // lib/import-persistence.mts), which defeats structural assignability
    // here even though the real client satisfies it at runtime.
    const importResults = await persistImportedProducts(
      sql as unknown as ImportPersistenceSql,
      products,
    );
    const productsInserted = importResults.filter(
      (result) => result.inserted,
    ).length;
    const [storedSettings] = await sql`
      SELECT vinted, gemini, ranking FROM application_settings WHERE id = 1
    `;
    const vintedSettings = parseVintedSettings(storedSettings?.vinted) ?? defaultVintedSettings;
    const geminiSettings = parseGeminiSettings(storedSettings?.gemini) ?? defaultGeminiSettings;
    const preferenceWeightPercent = (parseRankingSettings(storedSettings?.ranking) ?? defaultRankingSettings).preferenceWeightPercent;
    const preselection = selectEvaluationCandidatesWithPreselection(importResults, vintedSettings, geminiSettings.automaticEvaluationLimit);
    const evaluationCandidates = preselection.candidates;
    const productsUpdated = products.length - productsInserted;
    const snapshotsInserted = importResults.filter(
      (result) => result.snapshotId,
    ).length;
    // Watched historical-low events depend on the snapshots inserted by this
    // import, so they are detected now and recorded with any evaluation run.
    // Products are already persisted, so a detection failure only degrades the
    // Zalando recommendation to its fallback instead of failing the import.
    let watchedHistoricalLows: Awaited<ReturnType<typeof findWatchedHistoricalLows>> = [];
    try {
      watchedHistoricalLows = await findWatchedHistoricalLows(
        sql,
        importResults.flatMap((result) =>
          result.source === zalandoSource && result.snapshotId ? [result.snapshotId] : [],
        ),
      );
    } catch {
      console.warn("DealRadar watched historical-low detection failed.");
    }
    const evaluationMetrics = {
      candidatesSelected: evaluationCandidates.length,
      requestsAttempted: 0,
      successfulEvaluations: 0,
      failedEvaluations: 0,
      retryAttempts: 0,
      retryableFailures: 0,
      rateLimitFailures: 0,
      quotaFailures: 0,
      permanentFailures: 0,
      exhaustedRetries: 0,
    };
    let evaluationRunId: string | null = null;

    if (evaluationCandidates.length > 0) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");
      await resumePendingEvaluationRunWorkflows({ databaseUrl, apiKey });
      const evaluationRun = await createEvaluationRun(sql, {
        importRef: ref,
        candidateProductIds: evaluationCandidates.map((candidate) => candidate.productId),
        importContext: { productsProcessed: products.length, productsInserted, productsUpdated, snapshotsInserted, scanWarnings: partialScanWarnings, watchedHistoricalLows },
      });
      evaluationRunId = evaluationRun.id;
      try {
        await startEvaluationRunWorkflow({ databaseUrl, apiKey, runId: evaluationRun.id });
      } catch (error) {
        console.error("[durable-launch] import workflow start failed", {
          runId: evaluationRun.id,
          error,
        });
        throw error;
      }
    }
    console.info("DealRadar durable evaluation initiated.", { ...preselection.metrics, evaluationRunId });
    // A watched historical-low event is the only Zalando recommendation an
    // import with no evaluation candidates can have: the Zalando fallback (#60)
    // and the Vinted recommendation use products evaluated in this import.
    const zalandoHighlight = evaluationCandidates.length === 0
      ? selectWatchedHistoricalLowRecommendation(
          await loadWatchedHistoricalLowCandidates(sql, watchedHistoricalLows),
          preferenceWeightPercent,
        )
      : null;
    // There is no durable work to finalize when nothing was selected, so retain
    // one useful import notification without creating a stranded empty run.
    if (evaluationCandidates.length === 0) {
      const slackMessage = formatImportSlackMessage({ ref, productsProcessed: products.length, productsInserted, productsUpdated, snapshotsInserted, productsEvaluated: 0 }, { zalando: zalandoHighlight, vinted: null }, partialScanWarnings);
      try {
        const slackResult = await postSlackMessage(slackMessage);
        if (!slackResult.success) console.warn(`DealRadar Slack notification failed: ${slackResult.error}.`);
      } catch {
        console.warn("DealRadar Slack notification failed: unexpected_error.");
      }
    }

    return Response.json({
      success: true,
      ref,
      sources: sources.length,
      productsProcessed: products.length,
      productsInserted,
      productsUpdated,
      snapshotsInserted,
      productsEvaluated: 0,
      evaluationRunId,
      productsSkippedInvalidPrice,
      evaluationMetrics,
      preselectionMetrics: preselection.metrics,
    });
  } catch (error) {
    console.error("[durable-import] import failed", { ref, error });
    const message =
      error instanceof SourceDataError
        ? error.message
        : "Database import failed.";

    return Response.json(
      {
        success: false,
        ref,
        error: message,
      },
      { status: 500 },
    );
  }
}
