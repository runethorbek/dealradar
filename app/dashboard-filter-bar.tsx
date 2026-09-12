"use client";

import { useRouter } from "next/navigation";
import {
  dashboardSourceFilters,
  type DashboardSource,
} from "@/lib/dashboard-source.mts";
import {
  dashboardFreshnessOptions,
  type DashboardFreshness,
} from "@/lib/dashboard-freshness.mts";
import type { DashboardView } from "@/lib/dashboard-products.mts";
import type { DashboardSort } from "@/lib/dashboard-product-query.mts";
import { getDashboardHref } from "@/lib/dashboard-href.mts";

const sortOptions: { label: string; value: DashboardSort }[] = [
  { label: "Best match", value: "best_match" },
  { label: "Best deal", value: "best_deal" },
  { label: "Newest", value: "newest" },
];

const viewOptions: { label: string; value: DashboardView }[] = [
  { label: "Visible", value: "visible" },
  { label: "Watchlist", value: "watchlist" },
  { label: "Hidden", value: "hidden" },
];

type DashboardFilterBarProps = {
  source: DashboardSource | null;
  sort: DashboardSort;
  view: DashboardView;
  freshness: DashboardFreshness;
  brand: string | null;
  monitor: string | null;
  brands: string[];
  monitors: string[];
};

export function DashboardFilterBar({
  source,
  sort,
  view,
  freshness,
  brand,
  monitor,
  brands,
  monitors,
}: DashboardFilterBarProps) {
  const router = useRouter();

  function navigate(
    nextSource: DashboardSource | null = source,
    nextSort: DashboardSort = sort,
    nextView: DashboardView = view,
    nextFreshness: DashboardFreshness = freshness,
    nextBrand: string | null = brand,
    nextMonitor: string | null = monitor,
  ) {
    router.push(getDashboardHref(
      nextSource,
      nextSort,
      nextView,
      nextFreshness,
      nextBrand,
      nextMonitor,
    ));
  }

  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
      <label className="flex min-w-24 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        View
        <select
          aria-label="Choose dashboard view"
          value={view}
          onChange={(event) => navigate(undefined, undefined, event.target.value as DashboardView)}
          className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-zinc-600"
        >
          {viewOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>

      <label className="flex min-w-24 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Source
        <select
          aria-label="Filter deals by source"
          value={source ?? ""}
          onChange={(event) => navigate(event.target.value as DashboardSource || null, undefined, undefined, undefined, null)}
          className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-zinc-600"
        >
          {dashboardSourceFilters.map((filter) => <option key={filter.label} value={filter.value ?? ""}>{filter.label}</option>)}
        </select>
      </label>

      <label className="flex min-w-28 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Freshness
        <select
          aria-label="Filter deals by freshness"
          value={freshness}
          onChange={(event) => navigate(undefined, undefined, undefined, event.target.value as DashboardFreshness)}
          className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-zinc-600"
        >
          {dashboardFreshnessOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>

      {source === "zalando.dk" ? (
        <label className="flex min-w-28 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
          Brand
          <select
            aria-label="Filter deals by brand"
            value={brand ?? ""}
            onChange={(event) => navigate(undefined, undefined, undefined, undefined, event.target.value || null)}
            className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-zinc-600"
          >
            <option value="">All brands</option>
            {brands.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      ) : null}

      {monitors.length > 0 ? (
        <label className="flex min-w-28 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
          Monitor
          <select
            aria-label="Filter deals by monitor"
            value={monitor ?? ""}
            onChange={(event) => navigate(undefined, undefined, undefined, undefined, undefined, event.target.value || null)}
            className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-zinc-600"
          >
            <option value="">All monitors</option>
            {monitors.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      ) : null}

      <label className="flex min-w-28 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Sort
        <select
          aria-label="Sort deals"
          value={sort}
          onChange={(event) => navigate(undefined, event.target.value as DashboardSort)}
          className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-zinc-600"
        >
          {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
  );
}
