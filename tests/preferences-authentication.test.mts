import assert from "node:assert/strict";
import test from "node:test";
import { authorizeOwner } from "../lib/owner-authorization.mts";
import { handlePreferencesPost } from "../lib/preferences-api.mts";

const ownerEmail = "owner@example.com";

function preferenceRequest() {
  return new Request("http://localhost/api/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileText: "Prefer leather shoes." }),
  });
}

test("owner authorization distinguishes missing, non-owner, and owner identities", () => {
  assert.deepEqual(authorizeOwner(null, ownerEmail), { status: "unauthenticated" });
  assert.deepEqual(authorizeOwner({ email: "other@example.com", emailVerified: true }, ownerEmail), { status: "unauthorized" });
  assert.deepEqual(authorizeOwner({ email: ownerEmail, emailVerified: false }, ownerEmail), { status: "unauthorized" });
  assert.deepEqual(authorizeOwner({ email: "OWNER@example.com", emailVerified: true }, ownerEmail), { status: "unauthorized" });
  assert.deepEqual(authorizeOwner({ email: ownerEmail, emailVerified: true }, " OWNER@example.com"), { status: "unauthorized" });
  assert.deepEqual(authorizeOwner({ email: ownerEmail, emailVerified: true }, "OWNER@example.com"), { status: "unauthorized" });
  assert.deepEqual(authorizeOwner({ email: ownerEmail, emailVerified: true }, ownerEmail), { status: "authorized" });
});

test("rejected preference requests do not invoke persistence", async () => {
  for (const authorization of [{ status: "unauthenticated" } as const, { status: "unauthorized" } as const]) {
    let saveCalls = 0;
    const response = await handlePreferencesPost(preferenceRequest(), {
      authorize: async () => authorization,
      save: async () => {
        saveCalls += 1;
        return { profileText: "unexpected", updatedAt: "2026-01-01T00:00:00.000Z" };
      },
    });
    assert.equal(response.status, authorization.status === "unauthenticated" ? 401 : 403);
    assert.equal(saveCalls, 0);
  }
});

test("an authorized owner preserves the preference update response", async () => {
  const response = await handlePreferencesPost(preferenceRequest(), {
    authorize: async () => ({ status: "authorized" }),
    save: async (profileText) => ({ profileText, updatedAt: "2026-01-01T00:00:00.000Z" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    profileText: "Prefer leather shoes.",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});
