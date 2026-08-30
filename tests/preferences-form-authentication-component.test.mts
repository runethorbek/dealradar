import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
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
