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
let persistedHidden: boolean[] = [];
let sessionCalls = 0;
let authorizationUsers: unknown[] = [];
let databaseResult: "product" | "not-found" | "error" = "product";

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
    assert.equal(typeof values[0], "boolean");
    assert.equal(typeof values[1], "string");
    if (databaseResult === "error") throw new Error("database failure");
    persistedHidden.push(values[0] as boolean);
    if (databaseResult === "not-found") return [];
    return [{ productId: values[1], hidden: values[0] }];
  },
});

const { POST } = await import("../app/api/product-visibility/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function reset(status: typeof authorization, user = session?.user) {
  authorization = status;
  session = user ? { user } : null;
  persistedHidden = [];
  sessionCalls = 0;
  authorizationUsers = [];
  databaseResult = "product";
}

function visibilityRequest(hidden = true) {
  return new Request("http://localhost/api/product-visibility", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "42", hidden }),
  });
}

test("returns 401 before persistence without a session", async () => {
  reset("unauthenticated");
  const response = await POST(visibilityRequest());
  assert.equal(response.status, 401);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [undefined]);
  assert.deepEqual(persistedHidden, []);
});

test("returns 403 before persistence for a non-owner", async () => {
  const user = { email: "other@example.com", emailVerified: true };
  reset("unauthorized", user);
  const response = await POST(visibilityRequest());
  assert.equal(response.status, 403);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [user]);
  assert.deepEqual(persistedHidden, []);
});

test("persists visibility for the authorized owner", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset("authorized", user);
  const response = await POST(visibilityRequest(false));
  assert.equal(response.status, 200);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [user]);
  assert.deepEqual(persistedHidden, [false]);
  assert.deepEqual(await response.json(), {
    success: true,
    productId: "42",
    hidden: false,
  });
});

test("authorized requests preserve validation responses", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset("authorized", user);

  const invalidJson = new Request("http://localhost/api/product-visibility", {
    method: "POST",
    body: "not-json",
  });
  const invalidBody = new Request("http://localhost/api/product-visibility", {
    method: "POST",
    body: JSON.stringify({ productId: "42", hidden: "true" }),
  });

  assert.equal((await POST(invalidJson)).status, 400);
  assert.equal((await POST(invalidBody)).status, 400);
  assert.deepEqual(persistedHidden, []);
});

test("returns 404 when the authorized product does not exist", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset("authorized", user);
  databaseResult = "not-found";

  const response = await POST(visibilityRequest());

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Product not found.",
  });
});

test("returns 500 when visibility persistence fails", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset("authorized", user);
  databaseResult = "error";

  const response = await POST(visibilityRequest());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Visibility could not be updated.",
  });
});
