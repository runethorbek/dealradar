import assert from "node:assert/strict";
import test from "node:test";
import {
  includeRequestedProduct,
  parseDashboardView,
  parseProductId,
} from "../lib/dashboard-products.mts";
import {
  dashboardSourceFilters,
  parseDashboardSource,
} from "../lib/dashboard-source.mts";
import { parseDashboardBrand } from "../lib/dashboard-brand.mts";
import {
  dashboardFreshnessOptions,
  parseDashboardFreshness,
} from "../lib/dashboard-freshness.mts";

test("dashboard freshness defaults to Last 24 hours and accepts both supported windows", () => {
  assert.equal(parseDashboardFreshness(undefined), "24h");
  assert.equal(parseDashboardFreshness("24h"), "24h");
  assert.equal(parseDashboardFreshness("7d"), "7d");
  assert.equal(parseDashboardFreshness("unexpected"), "24h");
  assert.deepEqual(dashboardFreshnessOptions, [
    { label: "Last 24 hours", value: "24h", hours: 24 },
    { label: "Last 7 days", value: "7d", hours: 168 },
  ]);
});

test("parseDashboardView defaults to Visible and accepts Hidden and Watchlist", () => {
  assert.equal(parseDashboardView(undefined), "visible");
  assert.equal(parseDashboardView("visible"), "visible");
  assert.equal(parseDashboardView("hidden"), "hidden");
  assert.equal(parseDashboardView("watchlist"), "watchlist");
  assert.equal(parseDashboardView("unexpected"), "visible");
});

test("dashboard source filters include only All, Vinted, and Zalando", () => {
  assert.deepEqual(dashboardSourceFilters, [
    { label: "All", value: null },
    { label: "Vinted", value: "vinted.com" },
    { label: "Zalando", value: "zalando.dk" },
  ]);
});

test("parseDashboardSource accepts Vinted and Zalando", () => {
  assert.equal(parseDashboardSource("vinted.com"), "vinted.com");
  assert.equal(parseDashboardSource("zalando.dk"), "zalando.dk");
});

test("parseDashboardSource defaults unsupported sources to All", () => {
  assert.equal(parseDashboardSource("scarosso.com"), null);
  assert.equal(parseDashboardSource("unsupported.example"), null);
});

test("dashboard brands are accepted only for Zalando", () => {
  assert.equal(parseDashboardBrand("Mango", "zalando.dk"), "Mango");
  assert.equal(parseDashboardBrand("Mango", "vinted.com"), null);
  assert.equal(parseDashboardBrand("Mango", null), null);
  assert.equal(parseDashboardBrand("", "zalando.dk"), null);
  assert.equal(parseDashboardBrand(["Mango"], "zalando.dk"), null);
});

test("parseProductId accepts positive PostgreSQL BIGINT product IDs", () => {
  assert.equal(parseProductId("1"), "1");
  assert.equal(
    parseProductId("9223372036854775807"),
    "9223372036854775807",
  );
});

test("parseProductId ignores invalid and out-of-range product IDs", () => {
  for (const value of [
    undefined,
    ["1"],
    "",
    "0",
    "-1",
    "1.5",
    "product-1",
    "9223372036854775808",
    "99999999999999999999999999999999999999999999999999",
  ]) {
    assert.equal(parseProductId(value), null);
  }
});

test("a requested hidden product outside the top 50 is displayed exactly once", () => {
  const topFifty = Array.from({ length: 50 }, (_, index) => ({
    id: String(index + 1),
  }));
  const requestedProduct = { id: "51", hidden: true };

  const displayedProducts = includeRequestedProduct(
    topFifty,
    requestedProduct,
  );

  assert.equal(displayedProducts.length, 51);
  assert.equal(displayedProducts[0], requestedProduct);
  assert.equal(
    displayedProducts.filter((product) => product.id === requestedProduct.id)
      .length,
    1,
  );
});

test("a requested product already in the top 50 is not duplicated", () => {
  const topFifty = Array.from({ length: 50 }, (_, index) => ({
    id: String(index + 1),
  }));

  const displayedProducts = includeRequestedProduct(topFifty, topFifty[24]);

  assert.equal(displayedProducts, topFifty);
  assert.equal(
    displayedProducts.filter((product) => product.id === "25").length,
    1,
  );
});
