export function parseDashboardMonitor(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
