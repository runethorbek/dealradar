import { neon } from "@neondatabase/serverless";
import { evaluateProduct } from "@/lib/product-evaluation";
import {
  evaluateCandidates,
  selectEvaluationCandidates,
  type ImportEvaluationResult,
} from "@/lib/import-evaluation.mts";
import {
  formatImportSlackMessage,
  parsePartialScanWarning,
  selectTopRecommendation,
} from "@/lib/import-notification.mts";
import {
  normalizeScarossoPrices,
  parseUsdToDkkRate,
} from "@/lib/price-normalization.mts";
import { postSlackMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

type NormalizedProduct = {
  source: string;
  externalUrl: string;
  title: string;
  imageUrl: string | null;
  currentPrice: number | null;
  originalPrice: number | null;
  currency: string | null;
  sourceCurrentPrice: number | null;
  sourceOriginalPrice: number | null;
  sourceCurrency: string | null;
  discountPercent: number | null;
  targetSize: string | null;
  available: boolean | null;
  brand: string | null;
  category: string | null;
  observedAt: string;
  rawData: JsonObject;
};

type ImportResult = ImportEvaluationResult & {
  snapshotId: string | null;
};

class SourceDataError extends Error {}

const repositoryUrl = "https://raw.githubusercontent.com/runethorbek/deals";
const usdToDkkRateUrl =
  "https://api.frankfurter.dev/v2/rate/USD/DKK?providers=DNB";

const sources = [
  {
    name: "Scarosso",
    fallbackSource: "scarosso.com",
    fileName: "scarosso-latest.json",
    priceField: "current_price",
  },
  {
    name: "Zalando",
    fallbackSource: "zalando.dk",
    fileName: "zalando-latest.json",
    priceField: "current_price",
  },
  {
    name: "Vinted",
    fallbackSource: "vinted.com",
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
  payloadValue: unknown,
  definition: (typeof sources)[number],
  usdToDkkRate: number | null,
) {
  const payload = asObject(payloadValue, `${definition.name} feed`);

  if (!Array.isArray(payload.products)) {
    throw new SourceDataError(
      `${definition.name} feed does not contain a products array.`,
    );
  }

  const source = optionalString(payload.site) ?? definition.fallbackSource;

  return payload.products.flatMap((productValue): NormalizedProduct[] => {
    if (
      typeof productValue !== "object" ||
      productValue === null ||
      Array.isArray(productValue)
    ) {
      return [];
    }

    const product = productValue as JsonObject;
    const externalUrl = optionalString(product.url);
    const title = optionalString(product.title);
    const imageUrl = optionalString(product.image);
    const sourceCurrentPrice = optionalNumber(product[definition.priceField]);
    const sourceOriginalPrice = optionalNumber(product.original_price);
    const sourceCurrency = optionalString(product.currency);

    if (!externalUrl || !title) {
      return [];
    }

    const targetSize =
      definition.priceField === "price"
        ? optionalString(product.size_guess) ??
          optionalString(payload.target_size_id)
        : optionalString(product.target_size) ?? optionalString(payload.target_size);

    let available = optionalBoolean(product.available);

    if (available === null && targetSize) {
      available = optionalBoolean(product[`size_${targetSize}_available`]);
    }

    if (available === null && definition.priceField === "price") {
      available = true;
    }

    const categories = Array.isArray(product.categories)
      ? product.categories
      : [];
    const category =
      optionalString(product.category) ?? optionalString(categories[0]);
    const prices =
      definition.name === "Scarosso"
        ? normalizeScarossoPrices(
            {
              currentPrice: sourceCurrentPrice,
              originalPrice: sourceOriginalPrice,
              currency: sourceCurrency,
            },
            usdToDkkRate,
          )
        : {
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
      targetSize,
      available,
      brand: optionalString(product.brand),
      category,
      observedAt: validTimestamp(product.checked_at, payload.checked_at),
      rawData: product,
    }];
  });
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

function sourceContainsCurrency(payloadValue: unknown, currency: string) {
  if (
    typeof payloadValue !== "object" ||
    payloadValue === null ||
    Array.isArray(payloadValue)
  ) {
    return false;
  }

  const products = (payloadValue as JsonObject).products;

  return (
    Array.isArray(products) &&
    products.some(
      (product) =>
        typeof product === "object" &&
        product !== null &&
        !Array.isArray(product) &&
        optionalString((product as JsonObject).currency)?.toUpperCase() ===
          currency,
    )
  );
}

async function fetchUsdToDkkRate() {
  try {
    const response = await fetch(usdToDkkRateUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return null;
    }

    return parseUsdToDkkRate(await response.json());
  } catch {
    return null;
  }
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
    const scarossoNeedsUsdRate = sourceContainsCurrency(
      sourcePayloads[0],
      "USD",
    );
    const usdToDkkRate = scarossoNeedsUsdRate
      ? await fetchUsdToDkkRate()
      : null;

    if (scarossoNeedsUsdRate && usdToDkkRate === null) {
      console.warn(
        "DealRadar USD to DKK rate lookup failed; source prices were preserved.",
      );
    }

    const productsBySource = sourcePayloads.map((payload, index) =>
      normalizeProducts(payload, sources[index], usdToDkkRate),
    );
    const products = productsBySource.flat();
    const sql = neon(databaseUrl);

    const queries = products.map((product) => sql`
      WITH existing AS MATERIALIZED (
        SELECT id, current_price, source_current_price
        FROM products
        WHERE source = ${product.source}
          AND external_url = ${product.externalUrl}
      ),
      upserted AS (
        INSERT INTO products (
          source,
          external_url,
          title,
          image_url,
          current_price,
          original_price,
          currency,
          source_current_price,
          source_original_price,
          source_currency,
          discount_percent,
          target_size,
          available,
          brand,
          category,
          first_seen_at,
          last_seen_at,
          raw_data
        ) VALUES (
          ${product.source},
          ${product.externalUrl},
          ${product.title},
          ${product.imageUrl},
          ${product.currentPrice},
          ${product.originalPrice},
          ${product.currency},
          ${product.sourceCurrentPrice},
          ${product.sourceOriginalPrice},
          ${product.sourceCurrency},
          ${product.discountPercent},
          ${product.targetSize},
          ${product.available},
          ${product.brand},
          ${product.category},
          ${product.observedAt},
          ${product.observedAt},
          ${JSON.stringify(product.rawData)}::JSONB
        )
        ON CONFLICT (source, external_url) DO UPDATE SET
          title = EXCLUDED.title,
          image_url = EXCLUDED.image_url,
          current_price = EXCLUDED.current_price,
          original_price = EXCLUDED.original_price,
          currency = EXCLUDED.currency,
          source_current_price = EXCLUDED.source_current_price,
          source_original_price = EXCLUDED.source_original_price,
          source_currency = EXCLUDED.source_currency,
          discount_percent = EXCLUDED.discount_percent,
          target_size = EXCLUDED.target_size,
          available = EXCLUDED.available,
          brand = EXCLUDED.brand,
          category = EXCLUDED.category,
          last_seen_at = EXCLUDED.last_seen_at,
          raw_data = EXCLUDED.raw_data
        RETURNING
          id,
          title,
          current_price,
          currency,
          source_current_price,
          source_currency,
          hidden,
          discount_percent
      ),
      snapshot AS (
        INSERT INTO product_snapshots (
          product_id,
          observed_at,
          current_price,
          original_price,
          source_current_price,
          source_original_price,
          source_currency,
          discount_percent,
          available
        )
        SELECT
          id,
          ${product.observedAt},
          ${product.currentPrice},
          ${product.originalPrice},
          ${product.sourceCurrentPrice},
          ${product.sourceOriginalPrice},
          ${product.sourceCurrency},
          ${product.discountPercent},
          ${product.available}
        FROM upserted
        WHERE TRUE
        ON CONFLICT (product_id, observed_at) DO NOTHING
        RETURNING id
      )
      SELECT
        upserted.id::TEXT AS "productId",
        upserted.title,
        upserted.current_price::TEXT AS "currentPrice",
        upserted.currency,
        upserted.source_current_price::TEXT AS "sourceCurrentPrice",
        upserted.source_currency AS "sourceCurrency",
        upserted.hidden,
        (existing.id IS NULL) AS inserted,
        snapshot.id::TEXT AS "snapshotId",
        (
          snapshot.id IS NOT NULL
          AND existing.id IS NOT NULL
          AND CASE
            WHEN upserted.source_current_price IS NOT NULL
            THEN existing.source_current_price IS NOT NULL
              AND existing.source_current_price
                IS DISTINCT FROM upserted.source_current_price
            ELSE existing.current_price IS NOT NULL
              AND upserted.current_price IS NOT NULL
              AND existing.current_price IS DISTINCT FROM upserted.current_price
          END
        ) AS "priceChanged",
        CASE
          WHEN existing.source_current_price > 0
            AND upserted.source_current_price IS NOT NULL
            AND upserted.source_current_price < existing.source_current_price
          THEN (
            (existing.source_current_price - upserted.source_current_price)
            / existing.source_current_price
            * 100
          )::TEXT
          WHEN upserted.source_current_price IS NULL
            AND existing.current_price > 0
            AND upserted.current_price IS NOT NULL
            AND upserted.current_price < existing.current_price
          THEN (
            (existing.current_price - upserted.current_price)
            / existing.current_price
            * 100
          )::TEXT
          ELSE NULL
        END AS "priceDropPercent",
        upserted.discount_percent::TEXT AS "discountPercent"
      FROM upserted
      LEFT JOIN existing ON existing.id = upserted.id
      LEFT JOIN snapshot ON TRUE
    `);

    const results = queries.length ? await sql.transaction(queries) : [];
    const importResults = results.flatMap((result) =>
      result[0] ? [result[0] as ImportResult] : [],
    );
    const productsInserted = importResults.filter(
      (result) => result.inserted,
    ).length;
    const evaluationCandidates = selectEvaluationCandidates(importResults);
    const apiKey = process.env.GEMINI_API_KEY;
    const evaluatedProducts = await evaluateCandidates(
      evaluationCandidates,
      apiKey
        ? (candidate) =>
            evaluateProduct({
              productId: candidate.productId,
              databaseUrl,
              apiKey,
            })
        : null,
    );
    const productsEvaluated = evaluatedProducts.length;
    const productsUpdated = products.length - productsInserted;
    const snapshotsInserted = importResults.filter(
      (result) => result.snapshotId,
    ).length;
    const slackMessage = formatImportSlackMessage(
      {
        ref,
        productsProcessed: products.length,
        productsInserted,
        productsUpdated,
        snapshotsInserted,
        productsEvaluated,
      },
      selectTopRecommendation(evaluatedProducts),
      new URL(request.url).origin,
      partialScanWarnings,
    );

    try {
      const slackResult = await postSlackMessage(slackMessage);

      if (!slackResult.success) {
        console.warn(
          `DealRadar Slack notification failed: ${slackResult.error}.`,
        );
      }
    } catch {
      console.warn("DealRadar Slack notification failed: unexpected_error.");
    }

    return Response.json({
      success: true,
      ref,
      sources: sources.length,
      productsProcessed: products.length,
      productsInserted,
      productsUpdated,
      snapshotsInserted,
      productsEvaluated,
    });
  } catch (error) {
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
