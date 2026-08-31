import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const authOptions = { testOnly: true };
const authModule = new URL("../auth.ts", import.meta.url).href;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalOwnerEmail = process.env.OWNER_EMAIL;
let session: { user?: { email?: string | null; emailVerified?: boolean } } | null;
let sessionCalls = 0;
let neonCalls = 0;
let persistenceCalls = 0;
let geminiClientCalls = 0;
let geminiRequestCalls = 0;

process.env.DATABASE_URL = "postgresql://test-only";
process.env.GEMINI_API_KEY = "test-only";
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

    return async (strings: TemplateStringsArray) => {
      persistenceCalls += 1;
      const query = strings.join(" ");

      if (query.includes("FROM products")) {
        return [{ title: "Test product" }];
      }

      if (query.includes("FROM preferences")) return [];
      if (query.includes("FROM product_feedback")) return [];
      if (query.includes("FROM product_snapshots")) return [];

      return [
        {
          productId: "42",
          preferenceScore: 8,
          dealScore: 7,
          reason: "Strong preference match at a good price.",
          evaluatedAt: "2026-08-30T12:00:00.000Z",
        },
      ];
    };
  },
});
mockModule("@google/genai", {
  GoogleGenAI: class {
    models = {
      generateContent: async () => {
        geminiRequestCalls += 1;
        return {
          text: JSON.stringify({
            preferenceScore: 8,
            dealScore: 7,
            reason: "Strong preference match at a good price.",
          }),
        };
      },
    };

    constructor() {
      geminiClientCalls += 1;
    }
  },
});

const { POST } = await import("../app/api/evaluate-product/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;

  if (originalOwnerEmail === undefined) delete process.env.OWNER_EMAIL;
  else process.env.OWNER_EMAIL = originalOwnerEmail;
});

function reset(nextSession: typeof session) {
  session = nextSession;
  sessionCalls = 0;
  neonCalls = 0;
  persistenceCalls = 0;
  geminiClientCalls = 0;
  geminiRequestCalls = 0;
}

function evaluationRequest(body = JSON.stringify({ productId: "42" })) {
  return new Request("http://localhost/api/evaluate-product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("returns 401 before persistence or Gemini without a session", async () => {
  reset(null);

  const response = await POST(evaluationRequest("not-json"));

  assert.equal(response.status, 401);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.equal(geminiClientCalls, 0);
  assert.equal(geminiRequestCalls, 0);
});

test("returns 403 before persistence or Gemini for a non-owner", async () => {
  const user = { email: "other@example.com", emailVerified: true };
  reset({ user });

  const response = await POST(evaluationRequest("not-json"));

  assert.equal(response.status, 403);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.equal(geminiClientCalls, 0);
  assert.equal(geminiRequestCalls, 0);
});

test("allows the owner to preserve successful evaluation behavior", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 1);
  assert.equal(persistenceCalls, 5);
  assert.equal(geminiClientCalls, 1);
  assert.equal(geminiRequestCalls, 1);
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
