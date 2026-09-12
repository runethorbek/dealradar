import type { DashboardView } from "./dashboard-products.mts";
import type { DashboardSource } from "./dashboard-source.mts";
import type { DashboardSort } from "./dashboard-product-query.mts";
import type { DashboardFreshness } from "./dashboard-freshness.mts";

export function getDashboardHref(
  source: DashboardSource | null,
  sort: DashboardSort,
  view: DashboardView,
  freshness: DashboardFreshness,
  brand: string | null,
  monitor: string | null,
  highlightedProductId?: string | null,
) {
  const params = new URLSearchParams();

  if (source) {
    params.set("source", source);
  }

  if (sort !== "best_match") {
    params.set("sort", sort);
  }

  if (view !== "visible") {
    params.set("view", view);
  }

  if (freshness !== "24h") {
    params.set("freshness", freshness);
  }

  if (source === "zalando.dk" && brand) {
    params.set("brand", brand);
  }

  if (monitor) {
    params.set("monitor", monitor);
  }

  if (highlightedProductId) {
    params.set("product", highlightedProductId);
  }

  const query = params.toString();
  return query ? `/?${query}` : "/";
}
