export const dashboardSourceFilters = [
  { label: "All", value: null },
  { label: "Vinted", value: "vinted.com" },
  { label: "Zalando", value: "zalando.dk" },
] as const;

export type DashboardSource = Exclude<
  (typeof dashboardSourceFilters)[number]["value"],
  null
>;

export function parseDashboardSource(value: unknown): DashboardSource | null {
  return dashboardSourceFilters.some((filter) => filter.value === value)
    ? (value as DashboardSource)
    : null;
}
