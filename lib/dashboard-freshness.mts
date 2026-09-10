export const dashboardFreshnessOptions = [
  { label: "Last 24 hours", value: "24h", hours: 24 },
  { label: "Last 7 days", value: "7d", hours: 24 * 7 },
] as const;

export type DashboardFreshness =
  (typeof dashboardFreshnessOptions)[number]["value"];

export function parseDashboardFreshness(value: unknown): DashboardFreshness {
  return dashboardFreshnessOptions.some((option) => option.value === value)
    ? (value as DashboardFreshness)
    : "24h";
}

export function dashboardFreshnessHours(value: DashboardFreshness) {
  return dashboardFreshnessOptions.find((option) => option.value === value)!
    .hours;
}
