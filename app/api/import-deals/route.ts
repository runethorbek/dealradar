import { neon } from "@neondatabase/serverless";
import { evaluateProduct } from "@/lib/product-evaluation";

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
  discountPercent: number | null;
  targetSize: string | null;
  available: boolean | null;
  brand: string | null;
  category: string | null;
  observedAt: string;
  rawData: JsonObject;
};

type ImportResult = {
  productId: string;
  inserted: boolean;
  snapshotId: string | null;
  priceChanged: boolean;
  priceDropPercent: string | null;
  discountPercent: string | null;
};

type EvaluationCandidate = Pick<
  ImportResult,
  "productId" | "inserted" | "priceDropPercent" | "discountPercent"
>;

class SourceDataError extends Error {}

const repositoryUrl = "https://raw.githubusercontent.com/runethorbek/deals";
const automaticEvaluationLimit = 50;
const evaluationConcurrency = 5;

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
    const currentPrice = optionalNumber(product[definition.priceField]);

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

    return [{
      source,
      externalUrl,
      title,
      imageUrl,
      currentPrice,
      originalPrice: optionalNumber(product.original_price),
      currency: optionalString(product.currency),
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

async function fetchSource(
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

  return normalizeProducts(await response.json(), definition);
}

function compareNullableNumbersDescending(
  leftValue: string | null,
  rightValue: string | null,
) {
  const left = leftValue === null ? null : Number(leftValue);
  const right = rightValue === null ? null : Number(rightValue);

  if (left === null && right === null) {
    return 0;
  }

  if (left === null || !Number.isFinite(left)) {
    return 1;
  }

  if (right === null || !Number.isFinite(right)) {
    return -1;
  }

  return right - left;
}

function maxNullableNumber(
  leftValue: string | null,
  rightValue: string | null,
) {
  const left = leftValue === null ? null : Number(leftValue);
  const right = rightValue === null ? null : Number(rightValue);

  if (left === null || !Number.isFinite(left)) {
    return rightValue;
  }

  if (right === null || !Number.isFinite(right)) {
    return leftValue;
  }

  return right > left ? rightValue : leftValue;
}

function selectEvaluationCandidates(results: ImportResult[]) {
  const candidatesByProduct = new Map<string, EvaluationCandidate>();

  for (const result of results) {
    if (!result.inserted && !result.priceChanged) {
      continue;
    }

    const existing = candidatesByProduct.get(result.productId);

    candidatesByProduct.set(result.productId, {
      productId: result.productId,
      inserted: result.inserted || existing?.inserted === true,
      priceDropPercent: maxNullableNumber(
        existing?.priceDropPercent ?? null,
        result.priceDropPercent,
      ),
      discountPercent: maxNullableNumber(
        existing?.discountPercent ?? null,
        result.discountPercent,
      ),
    });
  }

  return [...candidatesByProduct.values()]
    .sort((left, right) => {
      if (left.inserted !== right.inserted) {
        return left.inserted ? -1 : 1;
      }

      return (
        compareNullableNumbersDescending(
          left.priceDropPercent,
          right.priceDropPercent,
        ) ||
        compareNullableNumbersDescending(
          left.discountPercent,
          right.discountPercent,
        )
      );
    })
    .slice(0, automaticEvaluationLimit);
}

async function evaluateCandidates(
  candidates: EvaluationCandidate[],
  databaseUrl: string,
  apiKey: string | undefined,
) {
  if (!apiKey) {
    return 0;
  }

  let evaluated = 0;

  for (let index = 0; index < candidates.length; index += evaluationConcurrency) {
    const batch = candidates.slice(index, index + evaluationConcurrency);
    const results = await Promise.allSettled(
      batch.map((candidate) =>
        evaluateProduct({
          productId: candidate.productId,
          databaseUrl,
          apiKey,
        }),
      ),
    );

    evaluated += results.filter((result) => result.status === "fulfilled").length;
  }

  return evaluated;
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
    const productsBySource = await Promise.all(
      sources.map((source) => fetchSource(source, ref)),
    );
    const products = productsBySource.flat();
    const sql = neon(databaseUrl);

    const queries = products.map((product) => sql`
      WITH existing AS MATERIALIZED (
        SELECT id, current_price
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
          discount_percent = EXCLUDED.discount_percent,
          target_size = EXCLUDED.target_size,
          available = EXCLUDED.available,
          brand = EXCLUDED.brand,
          category = EXCLUDED.category,
          last_seen_at = EXCLUDED.last_seen_at,
          raw_data = EXCLUDED.raw_data
        RETURNING id, current_price, discount_percent
      ),
      snapshot AS (
        INSERT INTO product_snapshots (
          product_id,
          observed_at,
          current_price,
          original_price,
          discount_percent,
          available
        )
        SELECT
          id,
          ${product.observedAt},
          ${product.currentPrice},
          ${product.originalPrice},
          ${product.discountPercent},
          ${product.available}
        FROM upserted
        WHERE TRUE
        ON CONFLICT (product_id, observed_at) DO NOTHING
        RETURNING id
      )
      SELECT
        upserted.id::TEXT AS "productId",
        (existing.id IS NULL) AS inserted,
        snapshot.id::TEXT AS "snapshotId",
        (
          snapshot.id IS NOT NULL
          AND existing.id IS NOT NULL
          AND existing.current_price IS DISTINCT FROM upserted.current_price
        ) AS "priceChanged",
        CASE
          WHEN existing.current_price > 0
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
    const productsEvaluated = await evaluateCandidates(
      evaluationCandidates,
      databaseUrl,
      process.env.GEMINI_API_KEY,
    );

    return Response.json({
      success: true,
      ref,
      sources: sources.length,
      productsProcessed: products.length,
      productsInserted,
      productsUpdated: products.length - productsInserted,
      snapshotsInserted: importResults.filter((result) => result.snapshotId)
        .length,
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
