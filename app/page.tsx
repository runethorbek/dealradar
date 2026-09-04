import { neon } from "@neondatabase/serverless";
import Link from "next/link";
import { connection } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import {
  parseVisibility,
  parseProductId,
  type Visibility,
} from "@/lib/dashboard-products.mts";
import {
  getLatestDashboardProducts,
  type DashboardSort,
  type DashboardSql,
} from "@/lib/dashboard-product-query.mts";
import { ProductCard, type ProductCardProduct } from "./product-card";
import { AppNavigation } from "./navigation";

type Source = "vinted.com" | "zalando.dk" | "scarosso.com";
type Sort = DashboardSort;

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
    return {
      products: await getLatestDashboardProducts(
        sql as DashboardSql,
        source,
        sort,
        visibility,
        highlightedProductId,
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
              <ProductCard
                key={product.id}
                product={product}
                authCallbackPath={getDashboardHref(
                  selectedSource,
                  selectedSort,
                  selectedVisibility,
                  product.id,
                )}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
