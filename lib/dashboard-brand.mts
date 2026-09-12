import type { DashboardSource } from "./dashboard-source.mts";

export function parseDashboardBrand(
  value: unknown,
  source: DashboardSource | null,
) {
  return source === "zalando.dk" && typeof value === "string" && value
    ? value
    : null;
}
