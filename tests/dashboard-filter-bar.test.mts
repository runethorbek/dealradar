import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
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

test("Brand selection navigates immediately while preserving compatible dashboard filters", async () => {
  const container = await renderFilterBar();

  assert.equal(container.querySelector("button"), null);
  await select(container, "Filter deals by brand", "Acne Studios");

  assert.deepEqual(navigations, [
    "/?source=zalando.dk&sort=newest&view=hidden&freshness=7d&brand=Acne+Studios&monitor=monitor-alpha",
  ]);
});

test("Monitor selection navigates immediately while preserving compatible dashboard filters", async () => {
  const container = await renderFilterBar();

  assert.equal(container.querySelector("button"), null);
  await select(container, "Filter deals by monitor", "monitor-beta");

  assert.deepEqual(navigations, [
    "/?source=zalando.dk&sort=newest&view=hidden&freshness=7d&brand=Mango&monitor=monitor-beta",
  ]);
});

test("source switching keeps existing source behavior by clearing the Zalando-only brand", async () => {
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

test("dashboard URLs continue to omit defaults and exclude Brand outside Zalando", () => {
  assert.equal(
    getDashboardHref(null, "best_match", "visible", "24h", "Mango", null),
    "/",
  );
  assert.equal(
    getDashboardHref("zalando.dk", "best_deal", "watchlist", "7d", "Mango", "monitor-alpha"),
    "/?source=zalando.dk&sort=best_deal&view=watchlist&freshness=7d&brand=Mango&monitor=monitor-alpha",
  );
});
