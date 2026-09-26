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
let persistedQueries: string[] = [];
let geminiClientCalls = 0;
let geminiRequestCalls = 0;
let geminiContents = "";
let geminiSystemInstruction = "";
let productSource = "vinted.com";
let productRawData: unknown = {};
let geminiResponseFields: Record<string, unknown> = defaultGeminiResponseFields();
let insertedTranslatedListingTextDa: unknown;

function defaultGeminiResponseFields() {
  return {
    preferenceScore: 8,
    dealScore: 7,
    reason: "Strong preference match at a good price.",
  };
}

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

    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
      persistenceCalls += 1;
      const query = strings.join(" ");
      persistedQueries.push(query);

      if (query.includes("FROM products")) {
        return [{
          source: productSource,
          rawData: productRawData,
          title: "Test product",
        }];
      }

      if (query.includes("FROM preferences")) return [];
      if (query.includes("FROM product_snapshots")) return [];

      // INSERT INTO product_evaluations (product_id, preference_score, deal_score, reason, translated_listing_text_da)
      const [productId, preferenceScore, dealScore, reason, translatedListingTextDa] = values;
      insertedTranslatedListingTextDa = translatedListingTextDa;

      return [
        {
          productId,
          preferenceScore,
          dealScore,
          reason,
          translatedListingTextDa,
          evaluatedAt: "2026-08-30T12:00:00.000Z",
        },
      ];
    };
  },
});
mockModule("@google/genai", {
  GoogleGenAI: class {
    models = {
      generateContent: async ({
        contents,
        config,
      }: {
        contents: string;
        config: { systemInstruction: string };
      }) => {
        geminiRequestCalls += 1;
        geminiContents = contents;
        geminiSystemInstruction = config.systemInstruction;
        return { text: JSON.stringify(geminiResponseFields) };
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
  persistedQueries = [];
  geminiClientCalls = 0;
  geminiRequestCalls = 0;
  geminiContents = "";
  geminiSystemInstruction = "";
  productSource = "vinted.com";
  productRawData = {};
  geminiResponseFields = defaultGeminiResponseFields();
  insertedTranslatedListingTextDa = undefined;
}

function getEvaluationContext() {
  const contextPrefix = "Context:\n";
  const contextStart = geminiContents.indexOf(contextPrefix);

  assert.notEqual(contextStart, -1);
  return JSON.parse(geminiContents.slice(contextStart + contextPrefix.length)) as {
    product: Record<string, unknown>;
  };
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
  assert.equal(persistenceCalls, 4);
  assert.equal(geminiClientCalls, 1);
  assert.equal(geminiRequestCalls, 1);
  assert.doesNotMatch(geminiContents, /targetSize|target_size|category/i);
  assert.match(geminiSystemInstruction, /matchedMonitors/);
  assert.match(
    geminiSystemInstruction,
    /do not treat monitor IDs as authoritative product attributes/i,
  );
  assert.equal(getEvaluationContext().product.source, "vinted.com");
  assert.equal("recentFeedback" in getEvaluationContext(), false);
  assert.doesNotMatch(geminiContents, /likes|dislikes|feedback/i);
  assert.doesNotMatch(geminiSystemInstruction, /feedback/i);
  assert.equal(persistedQueries.some((query) => query.includes("product_feedback")), false);
  assert.deepEqual(await response.json(), {
    success: true,
    evaluation: {
      productId: "42",
      preferenceScore: 8,
      dealScore: 7,
      reason: "Strong preference match at a good price.",
      translatedListingTextDa: null,
      evaluatedAt: "2026-08-30T12:00:00.000Z",
    },
  });
});

test("includes one Vinted monitor ID as matched monitor context", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  productRawData = { monitor_ids: ["vinted-mens-blazers-size-s"] };

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(geminiRequestCalls, 1);
  assert.deepEqual(getEvaluationContext().product.matchedMonitors, [
    "vinted-mens-blazers-size-s",
  ]);
});

test("includes multiple Vinted monitor IDs as matched monitor context", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  productRawData = {
    monitor_ids: [
      "vinted-mens-blazers-size-s",
      "vinted-men-pants-size-46",
    ],
  };

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(geminiRequestCalls, 1);
  assert.deepEqual(getEvaluationContext().product.matchedMonitors, [
    "vinted-mens-blazers-size-s",
    "vinted-men-pants-size-46",
  ]);
});

test("omits matched monitor context when Vinted metadata is unavailable", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(geminiRequestCalls, 1);
  assert.equal("matchedMonitors" in getEvaluationContext().product, false);
});

test("excludes invalid and excessive Vinted monitor IDs from evaluation context", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  productRawData = {
    monitor_ids: [
      "vinted-mens-blazers-size-s",
      "not a monitor ID",
      "x".repeat(121),
      ...Array.from({ length: 20 }, (_, index) => `vinted-monitor-${index}`),
    ],
  };

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(geminiRequestCalls, 1);
  assert.deepEqual(getEvaluationContext().product.matchedMonitors, [
    "vinted-mens-blazers-size-s",
    ...Array.from({ length: 19 }, (_, index) => `vinted-monitor-${index}`),
  ]);
});

test("includes only the bounded Vinted listing text in Gemini context, without leaking other raw_data", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  productRawData = {
    listing_text: "granatowa marynarka z metką",
    article_condition: "Ny med prismærker",
    size_guess: "S",
    brand: "Should not leak from raw_data",
    unrelated_field: "should-not-leak",
  };

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal(
    getEvaluationContext().product.listingText,
    "granatowa marynarka z metką",
  );
  assert.doesNotMatch(
    geminiContents,
    /article_condition|size_guess|should-not-leak/,
  );
});

test("omits listing text context when Vinted listing text is unavailable", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 200);
  assert.equal("listingText" in getEvaluationContext().product, false);
});

test("persists a valid Danish translation returned by Gemini", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  productRawData = { listing_text: "granatowa marynarka z metką" };
  geminiResponseFields.translatedListingTextDa = "Granatrød blazer med mærke";

  const response = await POST(evaluationRequest());
  const body = (await response.json()) as { evaluation: { translatedListingTextDa: unknown } };

  assert.equal(response.status, 200);
  assert.equal(body.evaluation.translatedListingTextDa, "Granatrød blazer med mærke");
  assert.equal(insertedTranslatedListingTextDa, "Granatrød blazer med mærke");
});

test("a missing translation field still yields a successful evaluation with valid scores and reason", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  delete geminiResponseFields.translatedListingTextDa;

  const response = await POST(evaluationRequest());
  const body = (await response.json()) as {
    evaluation: { preferenceScore: unknown; dealScore: unknown; reason: unknown; translatedListingTextDa: unknown };
  };

  assert.equal(response.status, 200);
  assert.equal(body.evaluation.translatedListingTextDa, null);
  assert.equal(body.evaluation.preferenceScore, 8);
  assert.equal(body.evaluation.dealScore, 7);
  assert.equal(body.evaluation.reason, "Strong preference match at a good price.");
});

test("a null translation still yields a successful evaluation with valid scores and reason", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  geminiResponseFields.translatedListingTextDa = null;

  const response = await POST(evaluationRequest());
  const body = (await response.json()) as { evaluation: { translatedListingTextDa: unknown } };

  assert.equal(response.status, 200);
  assert.equal(body.evaluation.translatedListingTextDa, null);
  assert.equal(insertedTranslatedListingTextDa, null);
});

test("an invalid translation type degrades to null without invalidating otherwise valid scores and reason", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  geminiResponseFields.translatedListingTextDa = 12345;

  const response = await POST(evaluationRequest());
  const body = (await response.json()) as {
    evaluation: { preferenceScore: unknown; dealScore: unknown; translatedListingTextDa: unknown };
  };

  assert.equal(response.status, 200);
  assert.equal(body.evaluation.translatedListingTextDa, null);
  assert.equal(body.evaluation.preferenceScore, 8);
  assert.equal(body.evaluation.dealScore, 7);
});

test("an oversized translation degrades to null without invalidating otherwise valid scores and reason", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  geminiResponseFields.translatedListingTextDa = "x".repeat(301);

  const response = await POST(evaluationRequest());
  const body = (await response.json()) as { evaluation: { translatedListingTextDa: unknown } };

  assert.equal(response.status, 200);
  assert.equal(body.evaluation.translatedListingTextDa, null);
});

test("strict validation of preferenceScore, dealScore, and reason remains unchanged", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  geminiResponseFields.preferenceScore = 11;

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 500);
  assert.equal(geminiRequestCalls, 1);
});

test("an unexpected field alongside a valid translation still rejects the evaluation", async () => {
  const user = { email: "owner@example.com", emailVerified: true };
  reset({ user });
  geminiResponseFields.translatedListingTextDa = "Granatrød blazer med mærke";
  geminiResponseFields.unexpectedField = "not allowed";

  const response = await POST(evaluationRequest());

  assert.equal(response.status, 500);
});
