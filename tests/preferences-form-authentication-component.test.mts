import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>");

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
// "input" event reliably triggers onChange in the preferred-brand test below.
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

const { PreferencesForm } = await import("../app/preferences/preferences-form.tsx");
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

async function renderPreferencesForm(response: Response) {
  globalThis.fetch = async () => response;

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      createElement(PreferencesForm, { profileText: "Prefer leather shoes." }),
    );
  });

  return container;
}

async function submitPreferences(container: HTMLElement) {
  const form = container.querySelector("form");
  assert.ok(form, "Expected preferences form.");

  await act(async () => {
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

test("an unauthenticated preferences save offers sign-in that returns to preferences", async () => {
  const container = await renderPreferencesForm(
    Response.json({ success: false, error: "Unauthorized." }, { status: 401 }),
  );

  await submitPreferences(container);

  const signIn = container.querySelector<HTMLAnchorElement>(
    'a[href^="/api/auth/signin?"]',
  );
  assert.ok(signIn);
  assert.equal(signIn.textContent, "Sign in");
  assert.equal(
    signIn.getAttribute("href"),
    "/api/auth/signin?callbackUrl=%2Fpreferences",
  );
  assert.match(container.textContent ?? "", /to save preferences\./);
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not save preferences\.|permission to save preferences/,
  );
});

test("a non-owner preferences save explains that saving is not permitted", async () => {
  const container = await renderPreferencesForm(
    Response.json({ success: false, error: "Forbidden." }, { status: 403 }),
  );

  await submitPreferences(container);

  assert.match(
    container.textContent ?? "",
    /You don't have permission to save preferences\./,
  );
  assert.equal(
    container.querySelector('a[href^="/api/auth/signin?"]'),
    null,
  );
  assert.doesNotMatch(container.textContent ?? "", /Could not save preferences\./);
});

test("an authorized preferences save retains the saved confirmation", async () => {
  const container = await renderPreferencesForm(
    Response.json({
      success: true,
      profileText: "Prefer leather shoes.",
      updatedAt: "2026-08-30T12:00:00.000Z",
    }),
  );

  await submitPreferences(container);

  assert.match(container.textContent ?? "", /Saved\./);
  assert.doesNotMatch(
    container.textContent ?? "",
    /Could not save preferences\.|Sign in to save preferences\.|permission to save preferences/,
  );
});

test("Settings shows the default automatic Gemini evaluation limit as an integer input", async () => {
  const container = await renderPreferencesForm(Response.json({ success: true }));
  const input = container.querySelector<HTMLInputElement>("#automatic-evaluation-limit");

  assert.ok(input);
  assert.equal(input.type, "number");
  assert.equal(input.value, "50");
  assert.equal(input.min, "1");
  const batchInput = container.querySelector<HTMLInputElement>("#workflow-batch-size");
  assert.ok(batchInput);
  assert.equal(batchInput.type, "number");
  assert.equal(batchInput.value, "5");
  assert.equal(batchInput.min, "1");
  assert.equal(batchInput.max, "10");
});

test("Settings shows the default 60% preference weight and includes it when settings are saved", async () => {
  const container = await renderPreferencesForm(Response.json({ success: true }));
  const input = container.querySelector<HTMLInputElement>("#preference-weight-percent");

  assert.ok(input);
  assert.equal(input.type, "number");
  assert.equal(input.value, "60");
  assert.equal(input.min, "0");
  assert.equal(input.max, "100");
  assert.match(container.textContent ?? "", /Deal weight: 40%/);

  let savedBody: unknown;
  globalThis.fetch = async (_url, init) => {
    savedBody = init && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    return Response.json({ success: true });
  };

  const saveButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save settings",
  );
  assert.ok(saveButton);

  await act(async () => {
    saveButton.click();
  });

  assert.deepEqual(
    (savedBody as { ranking?: { preferenceWeightPercent: number } } | undefined)?.ranking,
    { preferenceWeightPercent: 60 },
  );
});

test("clearing the preference-weight input keeps the Deal weight display numeric instead of showing NaN", async () => {
  const container = await renderPreferencesForm(Response.json({ success: true }));
  const input = container.querySelector<HTMLInputElement>("#preference-weight-percent");
  assert.ok(input);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )!.set!;

  await act(async () => {
    nativeInputValueSetter.call(input, "");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  assert.doesNotMatch(container.textContent ?? "", /NaN/);
  assert.match(container.textContent ?? "", /Deal weight: 40%/);
});

test("the Deal weight display stays numeric and derives correctly at the 0 and 100 preference-weight boundaries", async () => {
  const container = await renderPreferencesForm(Response.json({ success: true }));
  const input = container.querySelector<HTMLInputElement>("#preference-weight-percent");
  assert.ok(input);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )!.set!;

  await act(async () => {
    nativeInputValueSetter.call(input, "0");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.doesNotMatch(container.textContent ?? "", /NaN/);
  assert.match(container.textContent ?? "", /Deal weight: 100%/);

  await act(async () => {
    nativeInputValueSetter.call(input, "100");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.doesNotMatch(container.textContent ?? "", /NaN/);
  assert.match(container.textContent ?? "", /Deal weight: 0%/);
});

test("Preferred brands can be added and removed, and are included when settings are saved", async () => {
  const container = await renderPreferencesForm(Response.json({ success: true }));

  const input = container.querySelector<HTMLInputElement>("#preferred-brand");
  assert.ok(input);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  )!.set!;

  await act(async () => {
    nativeInputValueSetter.call(input, "Tiger of Sweden");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  const addButton = [...container.querySelectorAll("button")].find(
    (button) => button.type === "button" && button.textContent === "Add brand" && button.previousElementSibling === input,
  );
  assert.ok(addButton, "Expected an Add brand button next to the preferred-brand input.");

  await act(async () => {
    addButton.click();
  });

  assert.match(container.textContent ?? "", /Tiger of Sweden ×/);

  let savedBody: unknown;
  globalThis.fetch = async (_url, init) => {
    savedBody = init && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    return Response.json({ success: true });
  };

  const saveButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save settings",
  );
  assert.ok(saveButton);

  await act(async () => {
    saveButton.click();
  });

  assert.deepEqual(
    (savedBody as { brandFilter?: { preferredBrands: string[] } } | undefined)?.brandFilter,
    { preferredBrands: ["Tiger of Sweden"] },
  );
});
