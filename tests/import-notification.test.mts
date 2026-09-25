import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCandidates,
  selectEvaluationCandidates,
  type ImportEvaluationResult,
} from "../lib/import-evaluation.mts";
import {
  formatImportSlackMessage,
  parsePartialScanWarning,
  selectTopRecommendation,
  selectVintedRecommendation,
  type ImportRecommendation,
} from "../lib/import-notification.mts";

const noRecommendations = { zalando: null, vinted: null };

const summary = {
  ref: "main",
  productsProcessed: 541,
  productsInserted: 138,
  productsUpdated: 403,
  snapshotsInserted: 358,
  productsEvaluated: 50,
};

const recommendations: ImportRecommendation[] = [
  {
    productId: "1",
    externalUrl: "https://retailer.example/products/deal-one",
    title: "Deal One",
    currentPrice: "900.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 8,
    dealScore: 7,
  },
  {
    productId: "2",
    externalUrl: "https://retailer.example/products/deal-two",
    title: "Deal Two",
    currentPrice: "1200.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 9,
    dealScore: 8,
  },
];

test("selects the recommendation with the highest rounded overall score", () => {
  assert.equal(selectTopRecommendation(recommendations)?.productId, "2");
});

test("a configured preference weight can flip which recommendation is selected", () => {
  const tradeoffRecommendations: ImportRecommendation[] = [
    { ...recommendations[0], productId: "preference-heavy", preferenceScore: 9, dealScore: 3 },
    { ...recommendations[0], productId: "deal-heavy", preferenceScore: 3, dealScore: 9 },
  ];

  assert.equal(selectTopRecommendation(tradeoffRecommendations)?.productId, "preference-heavy");
  assert.equal(selectTopRecommendation(tradeoffRecommendations, 20)?.productId, "deal-heavy");
});

test("evaluates hidden and visible products before selecting a visible recommendation", async () => {
  const importedResults: ImportEvaluationResult[] = [
    {
      productId: "hidden",
      externalUrl: "https://retailer.example/products/hidden",
      title: "Hidden deal",
      currentPrice: "1200.00",
      currency: "DKK",
      sourceCurrentPrice: null,
      sourceCurrency: null,
      hidden: true,
      inserted: true,
      priceChanged: false,
      priceDropPercent: null,
      discountPercent: null,
    },
    {
      productId: "visible",
      externalUrl: "https://retailer.example/products/visible",
      title: "Visible deal",
      currentPrice: "900.00",
      currency: "DKK",
      sourceCurrentPrice: null,
      sourceCurrency: null,
      hidden: false,
      inserted: true,
      priceChanged: false,
      priceDropPercent: null,
      discountPercent: null,
    },
  ];
  const evaluatedProductIds: string[] = [];

  const { evaluatedProducts } = await evaluateCandidates(
    selectEvaluationCandidates(importedResults),
    async (candidate) => {
      evaluatedProductIds.push(candidate.productId);

      return {
        preferenceScore: candidate.hidden ? 10 : 8,
        dealScore: candidate.hidden ? 10 : 7,
      };
    },
    { sleep: async () => {} },
  );

  assert.deepEqual(evaluatedProductIds.sort(), ["hidden", "visible"]);
  assert.deepEqual(
    evaluatedProducts.map(({ productId, hidden }) => ({ productId, hidden })),
    [
      { productId: "hidden", hidden: true },
      { productId: "visible", hidden: false },
    ],
  );
  assert.equal(selectTopRecommendation(evaluatedProducts)?.productId, "visible");
});

test("returns no recommendation when every evaluated product is hidden", async () => {
  const importedResults: ImportEvaluationResult[] = [
    {
      productId: "hidden-source-price",
      externalUrl: "https://retailer.example/products/hidden-source-price",
      title: "Hidden source-priced deal",
      currentPrice: null,
      currency: null,
      sourceCurrentPrice: "100.00",
      sourceCurrency: "USD",
      hidden: true,
      inserted: true,
      priceChanged: false,
      priceDropPercent: null,
      discountPercent: null,
    },
  ];
  let evaluationCount = 0;

  const { evaluatedProducts } = await evaluateCandidates(
    selectEvaluationCandidates(importedResults),
    async () => {
      evaluationCount += 1;
      return { preferenceScore: 10, dealScore: 10 };
    },
    { sleep: async () => {} },
  );

  assert.equal(evaluationCount, 1);
  assert.equal(selectTopRecommendation(evaluatedProducts), null);
});

function evaluationCandidate(productId: string) {
  return {
    productId,
    externalUrl: `https://retailer.example/products/${productId}`,
    title: `Deal ${productId}`,
    currentPrice: "100.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    inserted: true,
    priceDropPercent: null,
    discountPercent: null,
  };
}

test("evaluates candidates sequentially", async () => {
  const started: string[] = [];
  let resolveFirst: (() => void) | undefined;
  const firstComplete = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  const evaluation = evaluateCandidates(
    [evaluationCandidate("one"), evaluationCandidate("two")],
    async (candidate) => {
      started.push(candidate.productId);
      if (candidate.productId === "one") {
        await firstComplete;
      }
      return { preferenceScore: 8, dealScore: 7 };
    },
    { sleep: async () => {} },
  );

  await Promise.resolve();
  assert.deepEqual(started, ["one"]);
  resolveFirst?.();
  await evaluation;
  assert.deepEqual(started, ["one", "two"]);
});

test("retries a rate-limited candidate before evaluating the next candidate", async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const { evaluatedProducts, metrics } = await evaluateCandidates(
    [evaluationCandidate("one"), evaluationCandidate("two")],
    async (candidate) => {
      calls.push(candidate.productId);
      if (candidate.productId === "one" && calls.length === 1) {
        const error = new Error("RESOURCE_EXHAUSTED");
        Object.assign(error, { status: 429 });
        throw error;
      }
      return { preferenceScore: 8, dealScore: 7 };
    },
    { sleep: async (milliseconds) => { delays.push(milliseconds); } },
  );

  assert.deepEqual(calls, ["one", "one", "two"]);
  assert.deepEqual(delays, [5_000]);
  assert.equal(evaluatedProducts.length, 2);
  assert.deepEqual(metrics, {
    candidatesSelected: 2,
    requestsAttempted: 3,
    successfulEvaluations: 2,
    failedEvaluations: 0,
    retryAttempts: 1,
    retryableFailures: 1,
    rateLimitFailures: 1,
    quotaFailures: 0,
    permanentFailures: 0,
    exhaustedRetries: 0,
  });
});

test("does not delay between successful candidate evaluations", async () => {
  const delays: number[] = [];
  const { evaluatedProducts } = await evaluateCandidates(
    [
      evaluationCandidate("one"),
      evaluationCandidate("two"),
      evaluationCandidate("three"),
    ],
    async () => ({ preferenceScore: 8, dealScore: 7 }),
    { sleep: async (milliseconds) => { delays.push(milliseconds); } },
  );

  assert.equal(evaluatedProducts.length, 3);
  assert.deepEqual(delays, []);
});

test("continues after a candidate exhausts retries", async () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const { evaluatedProducts, metrics } = await evaluateCandidates(
    [evaluationCandidate("one"), evaluationCandidate("two")],
    async (candidate) => {
      calls.push(candidate.productId);
      if (candidate.productId === "one") {
        const error = new Error("temporary service failure");
        Object.assign(error, { status: 503 });
        throw error;
      }
      return { preferenceScore: 8, dealScore: 7 };
    },
    { sleep: async (milliseconds) => { delays.push(milliseconds); } },
  );

  assert.deepEqual(calls, ["one", "one", "one", "one", "two"]);
  assert.deepEqual(delays, [5_000, 10_000, 20_000]);
  assert.equal(evaluatedProducts.length, 1);
  assert.equal(metrics.failedEvaluations, 1);
  assert.equal(metrics.retryAttempts, 3);
  assert.equal(metrics.retryableFailures, 4);
  assert.equal(metrics.exhaustedRetries, 1);
});

test("does not retry permanent Gemini failures", async () => {
  let calls = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values);

  try {
    const { metrics } = await evaluateCandidates(
      [evaluationCandidate("one")],
      async () => {
        calls += 1;
        const error = new Error("invalid request");
        Object.assign(error, { status: 400 });
        throw error;
      },
      { sleep: async () => {} },
    );

    assert.equal(calls, 1);
    assert.equal(metrics.failedEvaluations, 1);
    assert.equal(metrics.retryAttempts, 0);
    assert.deepEqual(warnings, [
      [
        "DealRadar automatic evaluation failed.",
        {
          productId: "one",
          failureKind: "permanent",
          status: 400,
          attempt: 1,
          retriesUsed: 0,
          messageCategory: "provider_error",
          validationCategory: null,
        },
      ],
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test("retries an invalid Gemini evaluation response", async () => {
  let calls = 0;
  const delays: number[] = [];
  const { evaluatedProducts, metrics } = await evaluateCandidates(
    [evaluationCandidate("one")],
    async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("Gemini returned an invalid evaluation.");
        Object.assign(error, { validationCategory: "invalid_reason" });
        throw error;
      }
      return { preferenceScore: 8, dealScore: 7 };
    },
    { sleep: async (milliseconds) => { delays.push(milliseconds); } },
  );

  assert.equal(calls, 2);
  assert.equal(evaluatedProducts.length, 1);
  assert.equal(metrics.retryAttempts, 1);
  assert.equal(metrics.retryableFailures, 1);
  assert.deepEqual(delays, [5_000]);
});

test("retries quota-like HTTP 429 responses", async () => {
  let calls = 0;
  const delays: number[] = [];
  const { metrics } = await evaluateCandidates(
    [evaluationCandidate("one")],
    async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("Quota exceeded: daily limit: 0");
        Object.assign(error, { status: 429 });
        throw error;
      }
      return { preferenceScore: 8, dealScore: 7 };
    },
    { sleep: async (milliseconds) => { delays.push(milliseconds); } },
  );

  assert.equal(calls, 3);
  assert.equal(metrics.quotaFailures, 2);
  assert.equal(metrics.rateLimitFailures, 2);
  assert.equal(metrics.retryAttempts, 2);
  assert.deepEqual(delays, [5_000, 10_000]);
});

test("prefers complete normalized pricing over a higher-ranked source-price fallback", () => {
  const sourcePriceOnly: ImportRecommendation = {
    productId: "3",
    externalUrl: "https://retailer.example/products/source-priced",
    title: "Source-priced deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
    hidden: false,
    preferenceScore: 10,
    dealScore: 10,
  };

  assert.equal(
    selectTopRecommendation([sourcePriceOnly, recommendations[0]])?.productId,
    "1",
  );
});

test("falls back to complete preserved source pricing", () => {
  const sourcePriceOnly: ImportRecommendation = {
    productId: "3",
    externalUrl: "https://retailer.example/products/source-priced",
    title: "Source-priced deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
    hidden: false,
    preferenceScore: 8,
    dealScore: 7,
  };

  assert.equal(selectTopRecommendation([sourcePriceOnly])?.productId, "3");
});

test("does not select a recommendation without a complete price and currency", () => {
  const incomplete: ImportRecommendation = {
    productId: "4",
    externalUrl: "https://retailer.example/products/incomplete",
    title: "Incomplete deal",
    currentPrice: "100.00",
    currency: null,
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 10,
    dealScore: 10,
  };

  assert.equal(selectTopRecommendation([incomplete]), null);
});

// Characterization of selectTopRecommendation (#57). Since #58 production uses
// it only for the interim Zalando recommendation; #60 is expected to replace it.
test("current behavior: equal rounded Overall keeps the first product in input order", () => {
  // 60/40: 8/7 -> 7.6 and 8/8 -> 8.0 both round to 8.
  const lowerUnrounded = { ...recommendations[0], productId: "b", preferenceScore: 8, dealScore: 7 };
  const higherUnrounded = { ...recommendations[0], productId: "a", preferenceScore: 8, dealScore: 8 };

  assert.equal(selectTopRecommendation([lowerUnrounded, higherUnrounded])?.productId, "b");
  assert.equal(selectTopRecommendation([higherUnrounded, lowerUnrounded])?.productId, "a");
});

test("current behavior: there is no minimum Overall score", () => {
  const lowScore = { ...recommendations[0], productId: "low", preferenceScore: 1, dealScore: 1 };

  assert.equal(selectTopRecommendation([lowScore])?.productId, "low");
});

function vintedRecommendation(
  productId: string,
  overrides: Partial<ImportRecommendation> = {},
): ImportRecommendation {
  return {
    ...recommendations[0],
    productId,
    source: "vinted.com",
    preferenceScore: 8,
    dealScore: 8,
    ...overrides,
  };
}

test("Vinted recommendation selects the highest unrounded Overall score", () => {
  // 60/40: 8/7 -> 7.6 and 8/8 -> 8.0 both round to 8.
  assert.equal(
    selectVintedRecommendation([
      vintedRecommendation("1", { preferenceScore: 8, dealScore: 7 }),
      vintedRecommendation("2", { preferenceScore: 8, dealScore: 8 }),
    ])?.productId,
    "2",
  );
});

test("Vinted recommendation requires an unrounded Overall score of at least 7", () => {
  // 60/40: 7/7 -> 7.0 qualifies; 8/5 -> 6.8 would round to 7 but does not.
  assert.equal(
    selectVintedRecommendation([vintedRecommendation("1", { preferenceScore: 7, dealScore: 7 })])?.productId,
    "1",
  );
  assert.equal(
    selectVintedRecommendation([vintedRecommendation("1", { preferenceScore: 8, dealScore: 5 })]),
    null,
  );
});

test("Vinted recommendation uses the configured preference weight for Overall and the threshold", () => {
  const candidates = [
    vintedRecommendation("preference-heavy", { preferenceScore: 9, dealScore: 5 }),
    vintedRecommendation("deal-heavy", { preferenceScore: 5, dealScore: 9 }),
  ];

  assert.equal(selectVintedRecommendation(candidates)?.productId, "preference-heavy");
  assert.equal(selectVintedRecommendation(candidates, 20)?.productId, "deal-heavy");
  assert.equal(selectVintedRecommendation(candidates, 50)?.productId, "deal-heavy");
});

test("Vinted recommendation breaks equal Overall by higher Deal score, then ascending product id", () => {
  // 50/50: 9/7 and 7/9 are both 8.0.
  assert.equal(
    selectVintedRecommendation([
      vintedRecommendation("1", { preferenceScore: 9, dealScore: 7 }),
      vintedRecommendation("2", { preferenceScore: 7, dealScore: 9 }),
    ], 50)?.productId,
    "2",
  );
  // Ids are BIGINTs as text: 9 sorts before 10.
  assert.equal(
    selectVintedRecommendation([vintedRecommendation("10"), vintedRecommendation("9")])?.productId,
    "9",
  );
  assert.equal(
    selectVintedRecommendation([vintedRecommendation("9"), vintedRecommendation("10")])?.productId,
    "9",
  );
});

test("Vinted recommendation excludes hidden products and non-Vinted sources", () => {
  assert.equal(
    selectVintedRecommendation([
      vintedRecommendation("hidden", { hidden: true, preferenceScore: 10, dealScore: 10 }),
      vintedRecommendation("zalando", { source: "zalando.dk", preferenceScore: 10, dealScore: 10 }),
      vintedRecommendation("unknown-source", { source: undefined, preferenceScore: 10, dealScore: 10 }),
      vintedRecommendation("visible"),
    ])?.productId,
    "visible",
  );
  assert.equal(
    selectVintedRecommendation([vintedRecommendation("hidden", { hidden: true })]),
    null,
  );
});

test("Vinted recommendation prefers normalized pricing and falls back to complete source pricing", () => {
  const sourcePriceOnly = vintedRecommendation("source-priced", {
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
    preferenceScore: 10,
    dealScore: 10,
  });
  const incomplete = vintedRecommendation("incomplete", { currency: null, preferenceScore: 10, dealScore: 10 });

  assert.equal(
    selectVintedRecommendation([sourcePriceOnly, incomplete, vintedRecommendation("normalized")])?.productId,
    "normalized",
  );
  assert.equal(selectVintedRecommendation([incomplete, sourcePriceOnly])?.productId, "source-priced");
  assert.equal(selectVintedRecommendation([incomplete]), null);
});

test("Vinted recommendation ignores Like / Not for me and Watch state", () => {
  // ImportRecommendation carries no feedback or watch fields: only Overall,
  // Deal, and product id decide, so a Liked or Watched listing gains nothing.
  assert.equal(
    selectVintedRecommendation([
      { ...vintedRecommendation("liked", { preferenceScore: 7, dealScore: 7 }), feedback: "like", watched: true } as ImportRecommendation,
      vintedRecommendation("best", { preferenceScore: 9, dealScore: 9 }),
    ])?.productId,
    "best",
  );
});

test("formats a valid summary without a recommendation or visible Git ref", () => {
  assert.equal(
    formatImportSlackMessage(summary, noRecommendations),
    "DealRadar updated: 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated",
  );
});

test("formats a safe recommendation with scores, price, and retailer link", () => {
  const recommendation = {
    ...recommendations[1],
    title: "Shoes <Special> & Co.",
    currency: "DKK<test>",
    externalUrl: "https://retailer.example/products/deal-two?colour=brown&size=42",
  };

  assert.equal(
    formatImportSlackMessage(summary, { zalando: recommendation, vinted: null }),
    "DealRadar updated: 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated\n\n" +
      "Zalando recommendation:\nShoes &lt;Special&gt; &amp; Co.\nPreference 9/10 · Deal 8/10 · 1200.00 DKK&lt;test&gt; · " +
      "<https://retailer.example/products/deal-two?colour=brown&amp;size=42|View product>",
  );
});

test("keeps an unevaluated highlight and Scan warning in the normal Slack message", () => {
  const message = formatImportSlackMessage(
    summary,
    { zalando: { ...recommendations[0], preferenceScore: null, dealScore: null }, vinted: null },
    [
      {
        sourceName: "Zalando",
        successfulPages: 5,
        attemptedPages: 6,
        failedPages: 1,
        failures: [{ name: "Page 6", url: null, error: "timeout" }],
      },
    ],
  );

  assert.match(message, /Zalando recommendation:\nDeal One\n900\.00 DKK/);
  assert.doesNotMatch(message, /Preference null|Deal null/);
  assert.match(message, /Scan warnings:/);
});

test("formats one recommendation per source, Zalando before Vinted", () => {
  const message = formatImportSlackMessage(summary, {
    zalando: { ...recommendations[0], title: "Zalando pick" },
    vinted: { ...recommendations[1], title: "Vinted pick" },
  });

  assert.match(
    message,
    /\n\nZalando recommendation:\nZalando pick\n[^\n]+\n\nVinted recommendation:\nVinted pick\n[^\n]+$/,
  );
  assert.doesNotMatch(message, /Top recommendation/);
});

test("formats preserved source pricing when normalized pricing is unavailable", () => {
  const recommendation: ImportRecommendation = {
    productId: "5",
    externalUrl: "https://retailer.example/products/usd-deal",
    title: "USD deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "275.00",
    sourceCurrency: "USD",
    hidden: false,
    preferenceScore: 8,
    dealScore: 6,
  };

  assert.match(
    formatImportSlackMessage(summary, { zalando: recommendation, vinted: null }),
    /275\.00 USD/,
  );
});

test("uses the translated Vinted display title in the Slack recommendation", () => {
  const recommendation: ImportRecommendation = {
    productId: "6",
    externalUrl: "https://vinted.dk/items/vinted-deal",
    title: "Bleizeri, Varemærke: Racing Green, Artiklens stand: Ny med prismærker, Størrelse: S, 17.43 kr",
    source: "vinted.com",
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
    translatedListingTextDa: "marineblå blazer med mærke",
    currentPrice: "120.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 8,
    dealScore: 7,
  };

  assert.match(
    formatImportSlackMessage(summary, { zalando: null, vinted: recommendation }),
    /Vinted recommendation:\nRacing Green - marineblå blazer med mærke - Ny med prismærker - S\n/,
  );
});

test("falls back to the original listing text when no translation is stored", () => {
  const recommendation: ImportRecommendation = {
    productId: "7",
    externalUrl: "https://vinted.dk/items/vinted-deal-2",
    title: "Raw Vinted title",
    source: "vinted.com",
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
    translatedListingTextDa: null,
    currentPrice: "120.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 8,
    dealScore: 7,
  };

  assert.match(
    formatImportSlackMessage(summary, { zalando: null, vinted: recommendation }),
    /Vinted recommendation:\nRacing Green - granatowa marynarka z metką - Ny med prismærker - S\n/,
  );
});

test("collapses missing Vinted title segments cleanly in Slack and never shows price text", () => {
  const recommendation: ImportRecommendation = {
    productId: "8",
    externalUrl: "https://vinted.dk/items/vinted-deal-3",
    title: "Raw Vinted title",
    source: "vinted.com",
    brand: null,
    listingText: "granatowa marynarka z metką",
    articleCondition: null,
    sizeGuess: null,
    translatedListingTextDa: null,
    currentPrice: "120.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 8,
    dealScore: 7,
  };

  const message = formatImportSlackMessage(summary, { zalando: null, vinted: recommendation });

  assert.match(message, /Vinted recommendation:\ngranatowa marynarka z metką\n/);
  assert.doesNotMatch(message.split("\n\n")[1].split("\n")[1], /\bkr\b|\d+[.,]\d+/);
});

test("keeps Zalando Slack titles unchanged even when other display-title fields are present", () => {
  const recommendation: ImportRecommendation = {
    productId: "9",
    externalUrl: "https://zalando.dk/items/zalando-deal",
    title: "Zalando raw title",
    source: "zalando.dk",
    brand: "Mango",
    listingText: "should be ignored",
    articleCondition: "should be ignored",
    sizeGuess: "should be ignored",
    translatedListingTextDa: "should be ignored",
    currentPrice: "120.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    hidden: false,
    preferenceScore: 8,
    dealScore: 7,
  };

  assert.match(
    formatImportSlackMessage(summary, { zalando: recommendation, vinted: null }),
    /Zalando recommendation:\nZalando raw title\n/,
  );
});

test("does not warn when scan_status is absent", () => {
  assert.equal(parsePartialScanWarning("Scarosso", { products: [] }), null);
});

test("does not warn for a successful scan_status", () => {
  assert.equal(
    parsePartialScanWarning("Scarosso", {
      scan_status: {
        attempted_pages: 6,
        successful_pages: 6,
        failed_pages: 0,
        failures: [],
      },
    }),
    null,
  );
});

test("renders one partial source with escaped failure details", () => {
  const warning = parsePartialScanWarning("Scarosso", {
    scan_status: {
      attempted_pages: 6,
      successful_pages: 5,
      failed_pages: 1,
      failures: [
        {
          name: "Boots <sale>",
          url: "https://shop.example/search?q=boots&size=42",
          error: "HTTP <503> & timeout",
        },
      ],
    },
  });

  assert.ok(warning);
  assert.match(
    formatImportSlackMessage(
      summary,
      noRecommendations,
      [warning],
    ),
    /Scan warnings:\n• Scarosso: 5\/6 pages succeeded; 1 failed\n  ◦ Boots &lt;sale&gt; — https:\/\/shop\.example\/search\?q=boots&amp;size=42: HTTP &lt;503&gt; &amp; timeout/,
  );
});

test("keeps a recommendation and scan warning in the same message", () => {
  const warning = parsePartialScanWarning("Scarosso", {
    scan_status: {
      attempted_pages: 6,
      successful_pages: 5,
      failed_pages: 1,
      failures: [{ name: "Boots", error: "timeout" }],
    },
  });

  assert.ok(warning);
  const message = formatImportSlackMessage(summary, { zalando: recommendations[1], vinted: null }, [warning]);

  assert.match(message, /Zalando recommendation:\nDeal Two/);
  assert.match(message, /Scan warnings:\n• Scarosso: 5\/6 pages succeeded; 1 failed/);
});

test("keeps bounded failure rendering unchanged", () => {
  const warning = parsePartialScanWarning("Scarosso", {
    scan_status: {
      attempted_pages: 7,
      successful_pages: 1,
      failed_pages: 6,
      failures: Array.from({ length: 6 }, (_, index) => ({
        name: `Page ${index + 1}`,
        error: "timeout",
      })),
    },
  });

  assert.ok(warning);
  const message = formatImportSlackMessage(summary, noRecommendations, [warning]);

  assert.match(message, /◦ Page 5: timeout/);
  assert.doesNotMatch(message, /◦ Page 6: timeout/);
  assert.match(message, /◦ …and 1 more/);
});

test("renders warnings for multiple partial sources", () => {
  const warnings = [
    parsePartialScanWarning("Zalando", {
      scan_status: {
        attempted_pages: 10,
        successful_pages: 8,
        failed_pages: 2,
        failures: [
          { name: "Page 4", error: "timeout" },
          { url: "https://shop.example/page/9", error: "HTTP 500" },
        ],
      },
    }),
    parsePartialScanWarning("Vinted", {
      scan_status: {
        attempted_pages: 3,
        successful_pages: 2,
        failed_pages: 1,
        failures: [{ name: "Menswear", error_summary: "rate limited" }],
      },
    }),
  ].filter((warning) => warning !== null);

  const message = formatImportSlackMessage(
    summary,
    noRecommendations,
    warnings,
  );

  assert.match(message, /• Zalando: 8\/10 pages succeeded; 2 failed/);
  assert.match(message, /• Vinted: 2\/3 pages succeeded; 1 failed/);
});

test("ignores malformed scan_status metadata", () => {
  const malformedStatuses = [
    "partial",
    {
      attempted_pages: "6",
      successful_pages: 5,
      failed_pages: 1,
      failures: [],
    },
    {
      attempted_pages: 6,
      successful_pages: 5,
      failed_pages: 1,
      failures: [],
    },
    {
      attempted_pages: 6,
      successful_pages: 5,
      failed_pages: 2,
      failures: [],
    },
    {
      attempted_pages: 6,
      successful_pages: 5,
      failed_pages: 1,
      failures: [{ name: "Page 6", error: 503 }],
    },
  ];

  for (const scanStatus of malformedStatuses) {
    assert.equal(
      parsePartialScanWarning("Scarosso", { scan_status: scanStatus }),
      null,
    );
  }
});
