import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const authOptions = { testOnly: true };
const authModule = new URL("../auth.ts", import.meta.url).href;
const ownerAuthorizationModule = new URL(
  "../lib/owner-authorization.mts",
  import.meta.url,
).href;
const originalDatabaseUrl = process.env.DATABASE_URL;
let session: { user?: { email?: string | null; emailVerified?: boolean } } | null;
let authorization: "authorized" | "unauthenticated" | "unauthorized";
let persistedRatings: string[] = [];
let sessionCalls = 0;
let authorizationUsers: unknown[] = [];

process.env.DATABASE_URL = "postgresql://test-only";

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

mockModule("next-auth", {
    getServerSession: async (options: unknown) => {
      assert.equal(options, authOptions);
      sessionCalls += 1;
      return session;
    },
});

mockModule(authModule, { authOptions });

mockModule(ownerAuthorizationModule, {
  authorizeOwner: (user: unknown) => {
    authorizationUsers.push(user);
    return { status: authorization };
  },
});

mockModule("@neondatabase/serverless", {
  neon: () => async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const rating = values[1];
    assert.ok(rating === "like" || rating === "dislike");
    persistedRatings.push(rating);
    return [{ rating }];
  },
});

const { POST } = await import("../app/api/product-feedback/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

function reset(status: typeof authorization, user = session?.user) {
  authorization = status;
  session = user ? { user } : null;
  persistedRatings = [];
  sessionCalls = 0;
  authorizationUsers = [];
}

function feedbackRequest(rating = "like") {
  return new Request("http://localhost/api/product-feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "42", rating }),
  });
}

test("the product feedback route returns 401 before persistence without a session", async () => {
  reset("unauthenticated");

  const response = await POST(feedbackRequest());

  assert.equal(response.status, 401);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [undefined]);
  assert.deepEqual(persistedRatings, []);
});

test("the product feedback route returns 403 before persistence for a non-owner", async () => {
  const user = { email: "other@example.com", emailVerified: true };
  reset("unauthorized", user);

  const response = await POST(feedbackRequest());

  assert.equal(response.status, 403);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [user]);
  assert.deepEqual(persistedRatings, []);
});

test("the product feedback route persists valid feedback for the authorized owner", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset("authorized", user);

  const response = await POST(feedbackRequest("dislike"));

  assert.equal(response.status, 200);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [user]);
  assert.deepEqual(persistedRatings, ["dislike"]);
  assert.deepEqual(await response.json(), { success: true, rating: "dislike" });
});
