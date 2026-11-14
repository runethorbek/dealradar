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
} from "../lib/import-notification.mts";

const summary = {
  ref: "main",
  productsProcessed: 541,
  productsInserted: 138,
  productsUpdated: 403,
  snapshotsInserted: 358,
  productsEvaluated: 50,
};

test("evaluates hidden and visible products alike", async () => {
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
});

test("evaluates a product even when it is hidden", async () => {
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
  assert.deepEqual(evaluatedProducts.map(({ productId, hidden }) => ({ productId, hidden })), [
    { productId: "hidden-source-price", hidden: true },
  ]);
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

test("formats a valid summary without a visible Git ref", () => {
  assert.equal(
    formatImportSlackMessage(summary),
    "DealRadar updated: 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated",
  );
});

test("the per-import message has only the summary line and the scan-warning block (#90)", () => {
  const warning = parsePartialScanWarning("Scarosso", {
    scan_status: {
      attempted_pages: 6,
      successful_pages: 5,
      failed_pages: 1,
      failures: [{ name: "Boots", error: "timeout" }],
    },
  });

  assert.ok(warning);
  const message = formatImportSlackMessage(summary, [warning]);

  assert.equal(
    message,
    "DealRadar updated: 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated\n\n" +
      "Scan warnings:\n• Scarosso: 5/6 pages succeeded; 1 failed\n  ◦ Boots: timeout",
  );
  assert.doesNotMatch(message, /Zalando recommendation|Vinted recommendation/);
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
      [warning],
    ),
    /Scan warnings:\n• Scarosso: 5\/6 pages succeeded; 1 failed\n  ◦ Boots &lt;sale&gt; — https:\/\/shop\.example\/search\?q=boots&amp;size=42: HTTP &lt;503&gt; &amp; timeout/,
  );
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
  const message = formatImportSlackMessage(summary, [warning]);

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
