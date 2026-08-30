import { neon } from "@neondatabase/serverless";
import Link from "next/link";
import { connection } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import {
  includeRequestedProduct,
  parseVisibility,
  parseProductId,
  type Visibility,
} from "@/lib/dashboard-products.mts";
import { ProductCard, type ProductCardProduct } from "./product-card";
import { AppNavigation } from "./navigation";

type Source = "vinted.com" | "zalando.dk" | "scarosso.com";
type Sort = "best_match" | "best_deal" | "newest";

const sourceFilters: { label: string; value: Source | null }[] = [
  { label: "All", value: null },
  { label: "Vinted", value: "vinted.com" },
  { label: "Zalando", value: "zalando.dk" },
  { label: "Scarosso", value: "scarosso.com" },
];

const sortOptions: { label: string; value: Sort }[] = [
  { label: "Best match", value: "best_match" },
  { label: "Best deal", value: "best_deal" },
  { label: "Newest", value: "newest" },
];

const visibilityOptions: { label: string; value: Visibility }[] = [
  { label: "Visible", value: "visible" },
  { label: "Hidden", value: "hidden" },
];

function getDashboardHref(
  source: Source | null,
  sort: Sort,
  visibility: Visibility,
  highlightedProductId?: string | null,
) {
  const params = new URLSearchParams();

  if (source) {
    params.set("source", source);
  }

  if (sort !== "best_match") {
    params.set("sort", sort);
  }

  if (visibility !== "visible") {
    params.set("view", visibility);
  }

  if (highlightedProductId) {
    params.set("product", highlightedProductId);
  }

  const query = params.toString();
  return query ? `/?${query}` : "/";
}

async function getLatestProducts(
  source: Source | null,
  sort: Sort,
  visibility: Visibility,
  highlightedProductId: string | null,
) {
  await connection();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return { products: [] as ProductCardProduct[], failed: true };
  }

  try {
    const sql = neon(databaseUrl);
    const rows = source
      ? await sql`
          SELECT
            p.id::TEXT AS id,
            p.external_url AS "externalUrl",
            p.title,
            p.image_url AS "imageUrl",
            p.source,
            p.current_price::TEXT AS "currentPrice",
            p.original_price::TEXT AS "originalPrice",
            p.currency,
            p.discount_percent::TEXT AS "discountPercent",
            p.last_seen_at::TEXT AS "lastSeenAt",
            p.hidden,
            pf.rating AS feedback,
            CASE
              WHEN pe.product_id IS NULL THEN NULL
              ELSE json_build_object(
                'preferenceScore', pe.preference_score,
                'dealScore', pe.deal_score,
                'reason', pe.reason,
                'evaluatedAt', pe.evaluated_at::TEXT
              )
            END AS evaluation
          FROM products p
          LEFT JOIN product_feedback pf ON pf.product_id = p.id
          LEFT JOIN product_evaluations pe ON pe.product_id = p.id
          WHERE p.source = ${source}
            AND p.hidden = ${visibility === "hidden"}
          ORDER BY
            (pe.product_id IS NULL) ASC,
            CASE
              WHEN ${sort} = 'best_match'
              THEN ROUND(pe.preference_score * 0.6 + pe.deal_score * 0.4)
            END DESC NULLS LAST,
            CASE WHEN ${sort} = 'best_deal' THEN pe.deal_score END DESC NULLS LAST,
            CASE WHEN ${sort} = 'newest' THEN p.last_seen_at END DESC NULLS LAST,
            p.last_seen_at DESC
          LIMIT 50
        `
      : await sql`
          SELECT
            p.id::TEXT AS id,
            p.external_url AS "externalUrl",
            p.title,
            p.image_url AS "imageUrl",
            p.source,
            p.current_price::TEXT AS "currentPrice",
            p.original_price::TEXT AS "originalPrice",
            p.currency,
            p.discount_percent::TEXT AS "discountPercent",
            p.last_seen_at::TEXT AS "lastSeenAt",
            p.hidden,
            pf.rating AS feedback,
            CASE
              WHEN pe.product_id IS NULL THEN NULL
              ELSE json_build_object(
                'preferenceScore', pe.preference_score,
                'dealScore', pe.deal_score,
                'reason', pe.reason,
                'evaluatedAt', pe.evaluated_at::TEXT
              )
            END AS evaluation
          FROM products p
          LEFT JOIN product_feedback pf ON pf.product_id = p.id
          LEFT JOIN product_evaluations pe ON pe.product_id = p.id
          WHERE p.hidden = ${visibility === "hidden"}
          ORDER BY
            (pe.product_id IS NULL) ASC,
            CASE
              WHEN ${sort} = 'best_match'
              THEN ROUND(pe.preference_score * 0.6 + pe.deal_score * 0.4)
            END DESC NULLS LAST,
            CASE WHEN ${sort} = 'best_deal' THEN pe.deal_score END DESC NULLS LAST,
            CASE WHEN ${sort} = 'newest' THEN p.last_seen_at END DESC NULLS LAST,
            p.last_seen_at DESC
          LIMIT 50
        `;

    const products = rows as ProductCardProduct[];

    if (
      !highlightedProductId ||
      products.some((product) => product.id === highlightedProductId)
    ) {
      return { products, failed: false };
    }

    const [highlightedProduct] = await sql`
      SELECT
        p.id::TEXT AS id,
        p.external_url AS "externalUrl",
        p.title,
        p.image_url AS "imageUrl",
        p.source,
        p.current_price::TEXT AS "currentPrice",
        p.original_price::TEXT AS "originalPrice",
        p.currency,
        p.discount_percent::TEXT AS "discountPercent",
        p.last_seen_at::TEXT AS "lastSeenAt",
        p.hidden,
        pf.rating AS feedback,
        CASE
          WHEN pe.product_id IS NULL THEN NULL
          ELSE json_build_object(
            'preferenceScore', pe.preference_score,
            'dealScore', pe.deal_score,
            'reason', pe.reason,
            'evaluatedAt', pe.evaluated_at::TEXT
          )
        END AS evaluation
      FROM products p
      LEFT JOIN product_feedback pf ON pf.product_id = p.id
      LEFT JOIN product_evaluations pe ON pe.product_id = p.id
      WHERE p.id = ${highlightedProductId}
    `;

    return {
      products: includeRequestedProduct(
        products,
        highlightedProduct as ProductCardProduct | undefined,
      ),
      failed: false,
    };
  } catch {
    return { products: [] as ProductCardProduct[], failed: true };
  }
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const query = await searchParams;
  const session = await getServerSession(authOptions);
  const requestedSource = query.source;
  const requestedSort = query.sort;
  const selectedVisibility = parseVisibility(query.view);
  const highlightedProductId = parseProductId(query.product);
  const selectedSource = sourceFilters.some(
    (filter) => filter.value === requestedSource,
  )
    ? (requestedSource as Source)
    : null;
  const selectedSort = sortOptions.some(
    (option) => option.value === requestedSort,
  )
    ? (requestedSort as Sort)
    : "best_match";
  const { products, failed } = await getLatestProducts(
    selectedSource,
    selectedSort,
    selectedVisibility,
    highlightedProductId,
  );

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <AppNavigation
        session={session}
        currentPage="dashboard"
        callbackPath={getDashboardHref(
          selectedSource,
          selectedSort,
          selectedVisibility,
          highlightedProductId,
        )}
      />

      <main className="mx-auto max-w-6xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-zinc-500">Dashboard</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Latest deals
            </h2>
          </div>
          {!failed && products.length > 0 ? (
            <p className="text-sm text-zinc-500">
              {products.length} {products.length === 1 ? "product" : "products"}
            </p>
          ) : null}
        </div>

        <div className="mb-6 space-y-3">
          <nav
            aria-label="Filter deals by visibility"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="mr-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
              View
            </span>
            {visibilityOptions.map((option) => {
              const isActive = option.value === selectedVisibility;

              return (
                <Link
                  key={option.value}
                  href={getDashboardHref(
                    selectedSource,
                    selectedSort,
                    option.value,
                  )}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    isActive
                      ? "border-zinc-950 bg-zinc-950 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-950"
                  }`}
                >
                  {option.label}
                </Link>
              );
            })}
          </nav>

          <nav
            aria-label="Filter deals by source"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="mr-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
              Source
            </span>
            {sourceFilters.map((filter) => {
              const isActive = filter.value === selectedSource;

              return (
                <Link
                  key={filter.label}
                  href={getDashboardHref(
                    filter.value,
                    selectedSort,
                    selectedVisibility,
                  )}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    isActive
                      ? "border-zinc-950 bg-zinc-950 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-950"
                  }`}
                >
                  {filter.label}
                </Link>
              );
            })}
          </nav>

          <nav
            aria-label="Sort deals"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="mr-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
              Sort
            </span>
            {sortOptions.map((option) => {
              const isActive = option.value === selectedSort;

              return (
                <Link
                  key={option.value}
                  href={getDashboardHref(
                    selectedSource,
                    option.value,
                    selectedVisibility,
                  )}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    isActive
                      ? "border-zinc-950 bg-zinc-950 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-950"
                  }`}
                >
                  {option.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {failed ? (
          <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-sm text-zinc-500">
              Deals could not be loaded right now.
            </p>
          </div>
        ) : products.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-zinc-500">
              {selectedVisibility === "hidden"
                ? "No hidden products match the current filters."
                : "No visible products match the current filters."}
            </p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
