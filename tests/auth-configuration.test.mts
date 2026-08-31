import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { NextAuthOptions } from "next-auth";
import {
  authorizeOwner,
  type AuthenticatedUser,
} from "../lib/owner-authorization.mts";

const ownerEmail = "owner@example.com";
const require = createRequire(import.meta.url);
const { authOptions } = require("../auth.ts") as { authOptions: NextAuthOptions };
const jwt = authOptions.callbacks?.jwt;
const session = authOptions.callbacks?.session;

assert.ok(jwt, "auth configuration must define a JWT callback");
assert.ok(session, "auth configuration must define a session callback");

async function sessionUserForGoogleProfile(profile: unknown) {
  const token = await jwt!({
    token: { email: ownerEmail },
    profile,
  } as never);
  const result = await session!({
    session: {
      user: { email: ownerEmail },
      expires: "2026-09-30T00:00:00.000Z",
    },
    token,
  } as never);

  assert.ok(result.user, "the session callback must preserve the user identity");
  return result.user as AuthenticatedUser;
}

test("uses JWT sessions with a lifetime of at least 30 days", () => {
  assert.equal(authOptions.session?.strategy, "jwt");
  assert.ok((authOptions.session?.maxAge ?? 0) >= 30 * 24 * 60 * 60);
});

test("a Google-verified email becomes the trusted owner session identity", async () => {
  const user = await sessionUserForGoogleProfile({ email_verified: true });

  assert.equal(user.emailVerified, true);
  assert.deepEqual(authorizeOwner(user, ownerEmail), { status: "authorized" });
});

test("unverified, missing, and malformed Google verification states cannot authorize the owner", async (t) => {
  const invalidProfiles: Array<[string, unknown]> = [
    ["false", { email_verified: false }],
    ["missing", {}],
    ["string", { email_verified: "true" }],
    ["number", { email_verified: 1 }],
    ["object", { email_verified: {} }],
    ["null", { email_verified: null }],
  ];

  for (const [description, profile] of invalidProfiles) {
    await t.test(description, async () => {
      const user = await sessionUserForGoogleProfile(profile);

      assert.equal(user.emailVerified, false);
      assert.deepEqual(authorizeOwner(user, ownerEmail), { status: "unauthorized" });
    });
  }
});
