import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>");

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
});

mock.module("next/navigation", {
  exports: { useRouter: () => ({ refresh() {} }) },
} as never);

const { ProductCard } = await import("../app/product-card.tsx");

const product = {
  id: "42",
  externalUrl: "https://example.com/product",
  title: "Test product",
  imageUrl: null,
  source: "zalando.dk",
  currentPrice: "100",
  originalPrice: "200",
  currency: "DKK",
  discountPercent: "50",
  lastSeenAt: "2026-08-30T12:00:00.000Z",
  hidden: false,
  feedback: null,
  evaluation: null,
};
const authCallbackPath = "/?source=zalando.dk&sort=newest&view=hidden&product=42";
const originalFetch = globalThis.fetch;
let root: Root | undefined;

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
});

after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

async function renderFeedbackCard(response: Response) {
  globalThis.fetch = async () => response;

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      createElement(ProductCard, { product, authCallbackPath }),
    );
  });

  return container;
}

async function clickFeedback(container: HTMLElement, label: "Like" | "Not for me") {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  assert.ok(button, `Expected ${label} feedback control.`);

  await act(async () => {
    button.click();
  });
}

test("an unauthenticated Like attempt offers sign-in with the preserved dashboard callback", async () => {
  const container = await renderFeedbackCard(
    Response.json({ success: false, error: "Unauthorized." }, { status: 401 }),
  );

  await clickFeedback(container, "Like");

  const signIn = container.querySelector<HTMLAnchorElement>(
    'a[href^="/api/auth/signin?"]',
  );
  assert.ok(signIn);
  assert.equal(signIn.textContent, "Sign in");
  assert.equal(
    signIn.getAttribute("href"),
    "/api/auth/signin?callbackUrl=%2F%3Fsource%3Dzalando.dk%26sort%3Dnewest%26view%3Dhidden%26product%3D42",
  );
  assert.match(container.textContent ?? "", /to save feedback\./);
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not save feedback\.|permission to save feedback/,
  );
});

test("a non-owner Not for me attempt explains that feedback is not permitted", async () => {
  const container = await renderFeedbackCard(
    Response.json({ success: false, error: "Forbidden." }, { status: 403 }),
  );

  await clickFeedback(container, "Not for me");

  assert.match(
    container.textContent ?? "",
    /You don't have permission to save feedback\./,
  );
  assert.equal(
    container.querySelector('a[href^="/api/auth/signin?"]'),
    null,
  );
  assert.doesNotMatch(container.textContent ?? "", /Could not save feedback\./);
});

test("a successful Like attempt marks Like as selected", async () => {
  const container = await renderFeedbackCard(
    Response.json({ success: true, rating: "like" }),
  );

  await clickFeedback(container, "Like");

  assert.equal(
    container.querySelector('button[aria-label="Like"]')?.getAttribute("aria-pressed"),
    "true",
  );
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not save feedback\.|Sign in to save feedback\.|permission to save feedback/,
  );
});
