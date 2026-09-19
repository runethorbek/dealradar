import { neon } from "@neondatabase/serverless";
import { connection } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import {
  parseDashboardView,
  parseProductId,
  type DashboardView,
} from "@/lib/dashboard-products.mts";
import {
  parseDashboardSource,
  type DashboardSource,
} from "@/lib/dashboard-source.mts";
import {
  getLatestDashboardProducts,
  getCurrentDashboardBrands,
  getCurrentDashboardMonitors,
  type DashboardSort,
  type DashboardSql,
} from "@/lib/dashboard-product-query.mts";
import {
  parseDashboardFreshness,
  type DashboardFreshness,
} from "@/lib/dashboard-freshness.mts";
import { parseDashboardBrand } from "@/lib/dashboard-brand.mts";
import { defaultBrandFilterSettings, parseBrandFilterSettings } from "@/lib/brand-filter-settings.mts";
import { defaultRankingSettings, parseRankingSettings } from "@/lib/ranking-settings.mts";
import { parseDashboardMonitor } from "@/lib/dashboard-monitor.mts";
import { getDashboardHref } from "@/lib/dashboard-href.mts";
import { ProductCard, type ProductCardProduct } from "./product-card";
import { AppNavigation } from "./navigation";
import { DashboardFilterBar } from "./dashboard-filter-bar";

type Source = DashboardSource;
type Sort = DashboardSort;

const sortOptions: { label: string; value: Sort }[] = [
  { label: "Best match", value: "best_match" },
  { label: "Best deal", value: "best_deal" },
  { label: "Newest", value: "newest" },
  { label: "Savings", value: "savings" },
];

async function getLatestProducts(
  source: Source | null,
  sort: Sort,
  view: DashboardView,
  freshness: DashboardFreshness,
  brand: string | null,
  monitor: string | null,
  highlightedProductId: string | null,
) {
  await connection();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return { products: [] as ProductCardProduct[], brands: [] as string[], preferredBrands: [] as string[], monitors: [] as string[], preferenceWeightPercent: defaultRankingSettings.preferenceWeightPercent, failed: true };
  }

  try {
    const sql = neon(databaseUrl);
    const dashboardSql = sql as DashboardSql;
    const [settings] = await sql`SELECT brand_filter AS "brandFilter", ranking FROM application_settings WHERE id = 1`;
    const preferenceWeightPercent = (parseRankingSettings(settings?.ranking) ?? defaultRankingSettings).preferenceWeightPercent;
    return {
      products: await getLatestDashboardProducts(
        dashboardSql,
        source,
        sort,
        view,
        freshness,
        highlightedProductId,
        brand,
        monitor,
        preferenceWeightPercent,
      ),
      brands: source
        ? await getCurrentDashboardBrands(dashboardSql, source, freshness)
        : [],
      preferredBrands: (parseBrandFilterSettings(settings?.brandFilter) ?? defaultBrandFilterSettings).preferredBrands,
      monitors: await getCurrentDashboardMonitors(dashboardSql, source, freshness),
      preferenceWeightPercent,
      failed: false,
    };
  } catch {
    return { products: [] as ProductCardProduct[], brands: [] as string[], preferredBrands: [] as string[], monitors: [] as string[], preferenceWeightPercent: defaultRankingSettings.preferenceWeightPercent, failed: true };
  }
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const query = await searchParams;
  const session = await getServerSession(authOptions);
  const requestedSource = query.source;
  const requestedSort = query.sort;
  const selectedView = parseDashboardView(query.view);
  const selectedFreshness = parseDashboardFreshness(query.freshness);
  const highlightedProductId = parseProductId(query.product);
  const selectedSource = parseDashboardSource(requestedSource);
  const selectedBrand = parseDashboardBrand(query.brand, selectedSource);
  const selectedMonitor = parseDashboardMonitor(query.monitor);
  const selectedSort = sortOptions.some(
    (option) => option.value === requestedSort,
  )
    ? (requestedSort as Sort)
    : "best_match";
  const { products, brands, preferredBrands, monitors, preferenceWeightPercent, failed } = await getLatestProducts(
    selectedSource,
    selectedSort,
    selectedView,
    selectedFreshness,
    selectedBrand,
    selectedMonitor,
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
          selectedView,
          selectedFreshness,
          selectedBrand,
          selectedMonitor,
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

        <DashboardFilterBar
          source={selectedSource}
          sort={selectedSort}
          view={selectedView}
          freshness={selectedFreshness}
          brand={selectedBrand}
          monitor={selectedMonitor}
          brands={brands}
          preferredBrands={preferredBrands}
          monitors={monitors}
        />

        {failed ? (
          <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-sm text-zinc-500">
              Deals could not be loaded right now.
            </p>
          </div>
        ) : products.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-zinc-500">
              {selectedView === "hidden"
                ? "No hidden products match the current filters."
                : selectedView === "watchlist"
                  ? "No watched products match the current filters."
                  : "No visible products match the current filters."}
            </p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                preferenceWeightPercent={preferenceWeightPercent}
                authCallbackPath={getDashboardHref(
                  selectedSource,
                  selectedSort,
                  selectedView,
                  selectedFreshness,
                  selectedBrand,
                  selectedMonitor,
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
