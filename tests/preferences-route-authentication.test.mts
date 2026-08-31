import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const authOptions = { testOnly: true };
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalOwnerEmail = process.env.OWNER_EMAIL;
const authModule = new URL("../auth.ts", import.meta.url).href;
let session: { user?: { email?: string | null; emailVerified?: boolean } } | null;
let sessionCalls = 0;
let neonCalls = 0;
let persistenceCalls = 0;

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
    return async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      persistenceCalls += 1;
      return [{ profileText: values[0], updatedAt: "2026-08-30T12:00:00.000Z" }];
    };
  },
});

const { POST } = await import("../app/api/preferences/route.ts");

after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalOwnerEmail === undefined) delete process.env.OWNER_EMAIL;
  else process.env.OWNER_EMAIL = originalOwnerEmail;
});

function reset(nextSession: typeof session) {
  session = nextSession;
  sessionCalls = 0;
  neonCalls = 0;
  persistenceCalls = 0;
}

function preferenceRequest(body: BodyInit = JSON.stringify({ profileText: "Prefer leather shoes." })) {
  return new Request("http://localhost/api/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("returns 401 without a valid session and does not persist", async () => {
  reset(null);

  const response = await POST(preferenceRequest("not-json"));

  assert.equal(response.status, 401);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
});

test("returns 403 for an authenticated non-owner and does not persist", async () => {
  reset({ user: { email: "other@example.com", emailVerified: true } });

  const response = await POST(preferenceRequest("not-json"));

  assert.equal(response.status, 403);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 0);
  assert.equal(persistenceCalls, 0);
});

test("the configured owner preserves the existing preference update behavior", async () => {
  reset({ user: { email: "owner@example.com", emailVerified: true } });

  const response = await POST(preferenceRequest());

  assert.equal(response.status, 200);
  assert.equal(sessionCalls, 1);
  assert.equal(neonCalls, 1);
  assert.equal(persistenceCalls, 1);
  assert.deepEqual(await response.json(), {
    success: true,
    profileText: "Prefer leather shoes.",
    updatedAt: "2026-08-30T12:00:00.000Z",
  });
});
