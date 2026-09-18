import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import { getDashboardHref } from "../lib/dashboard-href.mts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const navigations: string[] = [];
let root: Root | undefined;

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
});

// react-dom memoizes DOM feature detection (e.g. canUseDOM) at import time, which
// gates the modern text-input change-event path. Importing it dynamically, after
// the JSDOM globals above are installed, keeps that detection accurate so a plain
// "input" event reliably triggers onChange in the brand-search tests below.
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

mock.module("next/navigation", {
  exports: {
    useRouter: () => ({
      push(href: string) {
        navigations.push(href);
      },
    }),
  },
} as never);

const { DashboardFilterBar } = await import("../app/dashboard-filter-bar.tsx");

beforeEach(() => {
  document.body.replaceChildren();
  navigations.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

after(() => dom.window.close());

const filterBarProps: ComponentProps<typeof DashboardFilterBar> = {
  source: "zalando.dk" as const,
  sort: "newest" as const,
  view: "hidden" as const,
  freshness: "7d" as const,
  brand: "Mango",
  monitor: "monitor-alpha",
  brands: ["Mango", "Acne Studios"],
  preferredBrands: ["Acne Studios"],
  monitors: ["monitor-alpha", "monitor-beta"],
};

async function renderFilterBar(props = filterBarProps) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(createElement(DashboardFilterBar, props));
  });

  return container;
}

async function select(container: HTMLElement, label: string, value: string) {
  const control = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert.ok(control, `Expected ${label} select.`);
  control.value = value;

  await act(async () => {
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLInputElement.prototype,
  "value",
)!.set!;

async function typeBrandQuery(container: HTMLElement, query: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search brands"]');
  assert.ok(input, "Expected brand search input.");

  await act(async () => {
    nativeInputValueSetter.call(input, query);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function brandOptionValues(container: HTMLElement) {
  const control = container.querySelector<HTMLSelectElement>('select[aria-label="Filter deals by brand"]');
  assert.ok(control, "Expected brand select.");
  return [...control.options].map((option) => option.value);
}

test("Brand selection navigates immediately while preserving compatible dashboard filters", async () => {
  const container = await renderFilterBar();

  assert.equal(container.querySelector("button"), null);
  await select(container, "Filter deals by brand", "Acne Studios");

  assert.deepEqual(navigations, [
    "/?source=zalando.dk&sort=newest&view=hidden&freshness=7d&brand=Acne+Studios&monitor=monitor-alpha",
  ]);
});

test("preferred brands available in the current dataset are shown prominently before any search", async () => {
  const container = await renderFilterBar();

  assert.deepEqual(brandOptionValues(container), ["", "Mango", "Acne Studios"]);
});

test("preferred brands absent from the current dataset do not create empty or broken options", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    brand: null,
    brands: ["Mango"],
    preferredBrands: ["Burberry", "Mango"],
  });

  assert.deepEqual(brandOptionValues(container), ["", "Mango"]);
});

test("preferred brand matching is case-insensitive and uses the canonical dataset casing as the option value", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    brand: null,
    brands: ["Burberry", "Tiger of Sweden"],
    preferredBrands: ["burberry", "TIGER OF SWEDEN"],
  });

  assert.deepEqual(brandOptionValues(container), ["", "Burberry", "Tiger of Sweden"]);
});

test("a case-insensitive preferred brand match that is unavailable in the dataset remains omitted", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    brand: null,
    brands: ["Mango"],
    preferredBrands: ["burberry", "mango"],
  });

  assert.deepEqual(brandOptionValues(container), ["", "Mango"]);
});

test("brand search matches case-insensitively and partially across all available brands, not only preferred ones", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    brand: null,
    brands: ["Mango", "Acne Studios", "Tiger of Sweden", "Calvin Klein"],
    preferredBrands: ["Acne Studios"],
  });

  await typeBrandQuery(container, "TIGER");
  assert.deepEqual(brandOptionValues(container), ["", "Tiger of Sweden"]);

  await typeBrandQuery(container, "calvin");
  assert.deepEqual(brandOptionValues(container), ["", "Calvin Klein"]);
});

test("a non-preferred brand found through search can be selected and filters using existing brand semantics", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    brand: null,
    brands: ["Mango", "Acne Studios", "Tiger of Sweden"],
    preferredBrands: ["Acne Studios"],
  });

  await typeBrandQuery(container, "tiger");
  await select(container, "Filter deals by brand", "Tiger of Sweden");

  assert.deepEqual(navigations, [
    "/?source=zalando.dk&sort=newest&view=hidden&freshness=7d&brand=Tiger+of+Sweden&monitor=monitor-alpha",
  ]);
});

test("Vinted brands can be filtered the same way as Zalando brands", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    source: "vinted.com" as const,
    brand: null,
    brands: ["H&M"],
    preferredBrands: ["H&M"],
  });

  assert.deepEqual(brandOptionValues(container), ["", "H&M"]);
  await select(container, "Filter deals by brand", "H&M");

  assert.deepEqual(navigations, [
    "/?source=vinted.com&sort=newest&view=hidden&freshness=7d&brand=H%26M&monitor=monitor-alpha",
  ]);
});

test("the brand filter is not shown when no source is selected", async () => {
  const container = await renderFilterBar({
    ...filterBarProps,
    source: null,
    brand: null,
  });

  assert.equal(container.querySelector('select[aria-label="Filter deals by brand"]'), null);
  assert.equal(container.querySelector('input[aria-label="Search brands"]'), null);
});

test("Monitor selection navigates immediately while preserving compatible dashboard filters", async () => {
  const container = await renderFilterBar();

  assert.equal(container.querySelector("button"), null);
  await select(container, "Filter deals by monitor", "monitor-beta");

  assert.deepEqual(navigations, [
    "/?source=zalando.dk&sort=newest&view=hidden&freshness=7d&brand=Mango&monitor=monitor-beta",
  ]);
});

test("source switching clears the selected brand since available brands are source-specific", async () => {
  const container = await renderFilterBar();

  await select(container, "Filter deals by source", "vinted.com");

  assert.deepEqual(navigations, [
    "/?source=vinted.com&sort=newest&view=hidden&freshness=7d&monitor=monitor-alpha",
  ]);
});

test("URL-driven rerenders keep every select synchronized after history navigation", async () => {
  const container = await renderFilterBar();

  await act(async () => {
    root?.render(createElement(DashboardFilterBar, {
      ...filterBarProps,
      sort: "best_deal",
      view: "watchlist",
      freshness: "24h",
      brand: "Acne Studios",
      monitor: "monitor-beta",
    }));
  });

  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Choose dashboard view"]')?.value, "watchlist");
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Filter deals by freshness"]')?.value, "24h");
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Filter deals by brand"]')?.value, "Acne Studios");
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Filter deals by monitor"]')?.value, "monitor-beta");
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Sort deals"]')?.value, "best_deal");
});

test("dashboard URLs continue to omit defaults and exclude Brand when no source is selected", () => {
  assert.equal(
    getDashboardHref(null, "best_match", "visible", "24h", "Mango", null),
    "/",
  );
  assert.equal(
    getDashboardHref("zalando.dk", "best_deal", "watchlist", "7d", "Mango", "monitor-alpha"),
    "/?source=zalando.dk&sort=best_deal&view=watchlist&freshness=7d&brand=Mango&monitor=monitor-alpha",
  );
  assert.equal(
    getDashboardHref("vinted.com", "best_deal", "watchlist", "7d", "H&M", "monitor-alpha"),
    "/?source=vinted.com&sort=best_deal&view=watchlist&freshness=7d&brand=H%26M&monitor=monitor-alpha",
  );
});
