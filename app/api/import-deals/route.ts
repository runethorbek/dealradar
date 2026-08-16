import { neon } from "@neondatabase/serverless";

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

class SourceDataError extends Error {}

const sources = [
  {
    name: "Scarosso",
    fallbackSource: "scarosso.com",
    url: "https://raw.githubusercontent.com/runethorbek/deals/main/public/deals/scarosso-latest.json",
    priceField: "current_price",
  },
  {
    name: "Zalando",
    fallbackSource: "zalando.dk",
    url: "https://raw.githubusercontent.com/runethorbek/deals/main/public/deals/zalando-latest.json",
    priceField: "current_price",
  },
  {
    name: "Vinted",
    fallbackSource: "vinted.com",
    url: "https://raw.githubusercontent.com/runethorbek/deals/main/public/deals/vinted-latest.json",
    priceField: "price",
  },
] as const;

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

async function fetchSource(definition: (typeof sources)[number]) {
  const response = await fetch(definition.url, { cache: "no-store" });

  if (!response.ok) {
    throw new SourceDataError(
      `${definition.name} feed returned HTTP ${response.status}.`,
    );
  }

  return normalizeProducts(await response.json(), definition);
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

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      {
        success: false,
        error: "DATABASE_URL is not configured on the server.",
      },
      { status: 500 },
    );
  }

  try {
    const productsBySource = await Promise.all(sources.map(fetchSource));
    const products = productsBySource.flat();
    const sql = neon(databaseUrl);

    const queries = products.map((product) => sql`
      WITH upserted AS (
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
        RETURNING id, (xmax = 0) AS inserted
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
      SELECT upserted.inserted, snapshot.id AS "snapshotId"
      FROM upserted
      CROSS JOIN snapshot
    `);

    const results = queries.length ? await sql.transaction(queries) : [];
    const productsInserted = results.filter(
      (result) => result[0]?.inserted === true,
    ).length;

    return Response.json({
      success: true,
      sources: sources.length,
      productsProcessed: products.length,
      productsInserted,
      productsUpdated: products.length - productsInserted,
      snapshotsInserted: results.filter((result) => result[0]?.snapshotId).length,
    });
  } catch (error) {
    const message =
      error instanceof SourceDataError
        ? error.message
        : "Database import failed.";

    return Response.json(
      {
        success: false,
        error: message,
      },
      { status: 500 },
    );
  }
}
