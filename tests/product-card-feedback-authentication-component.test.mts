import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
let refreshCalls = 0;

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
      refresh() {
        refreshCalls += 1;
      },
    }),
  },
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
  refreshCalls = 0;
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

async function renderProductCard(
  response: Response,
  cardProduct: typeof product = product,
) {
  globalThis.fetch = async () => response;

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      createElement(ProductCard, { product: cardProduct, authCallbackPath }),
    );
  });

  return container;
}

const renderFeedbackCard = renderProductCard;

test("renders a compact price history summary when the current price sits above the historical minimum", async () => {
  const container = await renderProductCard(
    Response.json({ success: true }),
    {
      ...product,
      observationCount: 4,
      lowestObservedPrice: "699",
      currentPrice: "749",
    },
  );

  assert.match(container.textContent ?? "", /4 observations/i);
  assert.match(container.textContent ?? "", /lowest/i);
  assert.match(container.textContent ?? "", /now \+7%/i);
  assert.doesNotMatch(container.textContent ?? "", /lowest now/i);
  assert.doesNotMatch(container.textContent ?? "", /no history yet/i);
});

test("renders a single-observation note without implying historical price movement", async () => {
  const container = await renderProductCard(
    Response.json({ success: true }),
    {
      ...product,
      observationCount: 1,
      lowestObservedPrice: "699",
      currentPrice: "699",
    },
  );

  assert.match(container.textContent ?? "", /1 observation/i);
  assert.match(container.textContent ?? "", /no history yet/i);
  assert.doesNotMatch(container.textContent ?? "", /lowest/i);
});

async function clickFeedback(container: HTMLElement, label: "Like" | "Not for me") {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  assert.ok(button, `Expected ${label} feedback control.`);

  await act(async () => {
    button.click();
  });
}

async function clickVisibility(container: HTMLElement, label: "Hide" | "Unhide") {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(button, `Expected ${label} visibility control.`);

  await act(async () => {
    button.click();
  });
}

async function clickEvaluate(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Evaluate",
  );
  assert.ok(button, "Expected Evaluate control.");

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

test("an unauthenticated Hide attempt offers sign-in with the preserved dashboard callback", async () => {
  const container = await renderProductCard(
    Response.json({ success: false, error: "Unauthorized." }, { status: 401 }),
  );

  await clickVisibility(container, "Hide");

  const signIn = container.querySelector<HTMLAnchorElement>(
    'a[href^="/api/auth/signin?"]',
  );
  assert.ok(signIn);
  assert.equal(signIn.textContent, "Sign in");
  assert.equal(
    signIn.getAttribute("href"),
    "/api/auth/signin?callbackUrl=%2F%3Fsource%3Dzalando.dk%26sort%3Dnewest%26view%3Dhidden%26product%3D42",
  );
  assert.match(container.textContent ?? "", /to update visibility\./);
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not update visibility\.|permission to update visibility/,
  );
});

test("a non-owner Unhide attempt explains that visibility is not permitted", async () => {
  const container = await renderProductCard(
    Response.json({ success: false, error: "Forbidden." }, { status: 403 }),
    { ...product, hidden: true },
  );

  await clickVisibility(container, "Unhide");

  assert.match(
    container.textContent ?? "",
    /You don't have permission to update visibility\./,
  );
  assert.equal(
    container.querySelector('a[href^="/api/auth/signin?"]'),
    null,
  );
  assert.doesNotMatch(container.textContent ?? "", /Could not update visibility\./);
});

test("authorized Hide and Unhide attempts retain their existing behavior", async () => {
  for (const [hidden, action] of [
    [false, "Hide"],
    [true, "Unhide"],
  ] as const) {
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ success: true, productId: "42", hidden: !hidden });
    };

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(ProductCard, {
          product: { ...product, hidden },
          authCallbackPath,
        }),
      );
    });

    await clickVisibility(container, action);

    assert.deepEqual(requestBody, { productId: "42", hidden: !hidden });
    assert.equal(refreshCalls, 1);
    assert.doesNotMatch(
      container.textContent ?? "",
      /Could not update visibility\.|Sign in to update visibility\.|permission to update visibility/,
    );

    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    refreshCalls = 0;
    document.body.replaceChildren();
  }
});

test("an unauthenticated Evaluate attempt offers sign-in with the preserved dashboard callback", async () => {
  const container = await renderProductCard(
    Response.json({ success: false, error: "Unauthorized." }, { status: 401 }),
  );

  await clickEvaluate(container);

  const signIn = container.querySelector<HTMLAnchorElement>(
    'a[href^="/api/auth/signin?"]',
  );
  assert.ok(signIn);
  assert.equal(signIn.textContent, "Sign in");
  assert.equal(
    signIn.getAttribute("href"),
    "/api/auth/signin?callbackUrl=%2F%3Fsource%3Dzalando.dk%26sort%3Dnewest%26view%3Dhidden%26product%3D42",
  );
  assert.match(container.textContent ?? "", /to evaluate this product\./);
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not evaluate this product\.|permission to evaluate this product/,
  );
});

test("a non-owner Evaluate attempt explains that evaluation is not permitted", async () => {
  const container = await renderProductCard(
    Response.json({ success: false, error: "Forbidden." }, { status: 403 }),
  );

  await clickEvaluate(container);

  assert.match(
    container.textContent ?? "",
    /You don't have permission to evaluate this product\./,
  );
  assert.equal(
    container.querySelector('a[href^="/api/auth/signin?"]'),
    null,
  );
  assert.doesNotMatch(container.textContent ?? "", /Could not evaluate this product\./);
});

test("an authorized Evaluate attempt renders the returned evaluation", async () => {
  const container = await renderProductCard(
    Response.json({
      success: true,
      evaluation: {
        preferenceScore: 8,
        dealScore: 7,
        reason: "Strong preference match at a good price.",
        evaluatedAt: "2026-08-30T12:00:00.000Z",
      },
    }),
  );

  await clickEvaluate(container);

  assert.match(container.textContent ?? "", /Overall 8\/10/);
  assert.match(container.textContent ?? "", /Preference 8\/10/);
  assert.match(container.textContent ?? "", /Deal 7\/10/);
  assert.match(container.textContent ?? "", /Strong preference match at a good price\./);
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not evaluate this product\.|Sign in to evaluate this product\.|permission to evaluate this product/,
  );
});
