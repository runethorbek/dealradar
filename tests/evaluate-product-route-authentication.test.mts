import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const authOptions = { testOnly: true };
const authModule = new URL("../auth.ts", import.meta.url).href;
const ownerAuthorizationModule = new URL(
  "../lib/owner-authorization.mts",
  import.meta.url,
).href;
const productEvaluationModule = new URL(
  "../lib/product-evaluation.ts",
  import.meta.url,
).href;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
let session: { user?: { email?: string | null; emailVerified?: boolean } } | null;
let authorization: "authorized" | "unauthenticated" | "unauthorized";
let sessionCalls = 0;
let authorizationUsers: unknown[] = [];
let evaluationCalls: unknown[] = [];

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";

function mockModule(specifier: string, exports: Record<string, unknown>) {
  mock.module(specifier, { exports } as never);
}

class ProductNotFoundError extends Error {}

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
mockModule(productEvaluationModule, {
  ProductNotFoundError,
  evaluateProduct: async (input: unknown) => {
    evaluationCalls.push(input);
    return {
      productId: "42",
      preferenceScore: 8,
      dealScore: 7,
      reason: "Strong preference match at a good price.",
      evaluatedAt: "2026-08-30T12:00:00.000Z",
    };
  },
});

const { POST } = await import("../app/api/evaluate-product/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;
});

function reset(status: typeof authorization, user = session?.user) {
  authorization = status;
  session = user ? { user } : null;
  sessionCalls = 0;
  authorizationUsers = [];
  evaluationCalls = [];
}

function evaluationRequest(body = JSON.stringify({ productId: "42" })) {
  return new Request("http://localhost/api/evaluate-product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("returns 401 before parsing or evaluation without a session", async () => {
  reset("unauthenticated");

  const response = await POST(evaluationRequest("not-json"));

  assert.equal(response.status, 401);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [undefined]);
  assert.deepEqual(evaluationCalls, []);
});

test("returns 403 before parsing or evaluation for a non-owner", async () => {
  const user = { email: "other@example.com", emailVerified: true };
  reset("unauthorized", user);

  const response = await POST(evaluationRequest("not-json"));

  assert.equal(response.status, 403);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [user]);
  assert.deepEqual(evaluationCalls, []);
});

test("allows the owner to preserve successful evaluation behavior", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset("authorized", user);

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(authorizationUsers, [user]);
  assert.deepEqual(evaluationCalls, [
    {
      productId: "42",
      databaseUrl: "postgresql://test-only",
      apiKey: "test-only",
    },
  ]);
  assert.deepEqual(await response.json(), {
    success: true,
    evaluation: {
      productId: "42",
      preferenceScore: 8,
      dealScore: 7,
      reason: "Strong preference match at a good price.",
      evaluatedAt: "2026-08-30T12:00:00.000Z",
    },
  });
});
