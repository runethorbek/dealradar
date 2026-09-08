import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const authOptions = { testOnly: true };
const authModule = new URL("../auth.ts", import.meta.url).href;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalOwnerEmail = process.env.OWNER_EMAIL;
let session: { user?: { email?: string | null; emailVerified?: boolean } } | null;
let persistedWatched: boolean[] = [];
let sessionCalls = 0;
let neonCalls = 0;
let persistenceCalls = 0;
let databaseResult: "product" | "not-found" | "error" = "product";

process.env.DATABASE_URL = "postgresql://test-only";
process.env.OWNER_EMAIL = "owner@example.com";

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
mockModule("@neondatabase/serverless", {
  neon: () => {
    neonCalls += 1;
    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      persistenceCalls += 1;
      const query = strings.join("$parameter");
      assert.match(query, /SET watched = \$parameter/);
      assert.doesNotMatch(query, /hidden|product_feedback|rating/);
      assert.equal(typeof values[0], "boolean");
      assert.equal(typeof values[1], "string");
      if (databaseResult === "error") throw new Error("database failure");
      persistedWatched.push(values[0] as boolean);
      if (databaseResult === "not-found") return [];
      return [{ productId: values[1], watched: values[0] }];
    };
  },
});

const { POST } = await import("../app/api/product-watch/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalOwnerEmail === undefined) delete process.env.OWNER_EMAIL;
  else process.env.OWNER_EMAIL = originalOwnerEmail;
});

function reset(nextSession: typeof session) {
  session = nextSession;
  persistedWatched = [];
  sessionCalls = 0;
  neonCalls = 0;
  persistenceCalls = 0;
  databaseResult = "product";
}

function watchRequest(watched = true) {
  return new Request("http://localhost/api/product-watch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "42", watched }),
  });
}

test("returns 401 before persistence without a session", async () => {
  reset(null);
  const response = await POST(watchRequest());
  assert.equal(response.status, 401);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.deepEqual(persistedWatched, []);
});

test("returns 403 before persistence for a non-owner", async () => {
  reset({ user: { email: "other@example.com", emailVerified: true } });
  const response = await POST(watchRequest());
  assert.equal(response.status, 403);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.deepEqual(persistedWatched, []);
});

test("the owner can persist Watch and Unwatch without changing feedback or visibility", async () => {
  for (const watched of [true, false]) {
    reset({ user: { email: "owner@example.com", emailVerified: true } });
    const response = await POST(watchRequest(watched));

    assert.equal(response.status, 200);
    assert.equal(sessionCalls, 1);
    assert.equal(neonCalls, 1);
    assert.equal(persistenceCalls, 1);
    assert.deepEqual(persistedWatched, [watched]);
    assert.deepEqual(await response.json(), {
      success: true,
      productId: "42",
      watched,
    });
  }
});

test("authorized requests preserve validation and persistence error responses", async () => {
  const owner = { user: { email: "owner@example.com", emailVerified: true } };
  reset(owner);

  const invalidJson = new Request("http://localhost/api/product-watch", {
    method: "POST",
    body: "not-json",
  });
  const invalidBody = new Request("http://localhost/api/product-watch", {
    method: "POST",
    body: JSON.stringify({ productId: "42", watched: "true" }),
  });

  assert.equal((await POST(invalidJson)).status, 400);
  assert.equal((await POST(invalidBody)).status, 400);
  assert.deepEqual(persistedWatched, []);

  reset(owner);
  databaseResult = "not-found";
  assert.equal((await POST(watchRequest())).status, 404);

  reset(owner);
  databaseResult = "error";
  assert.equal((await POST(watchRequest())).status, 500);
});
