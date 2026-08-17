import assert from "node:assert/strict";
import test from "node:test";
import {
  formatImportSlackMessage,
  parsePartialScanWarning,
  selectTopRecommendation,
  type ImportRecommendation,
} from "../lib/import-notification.mts";

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
    title: "Deal One",
    currentPrice: "900.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    preferenceScore: 8,
    dealScore: 7,
  },
  {
    productId: "2",
    title: "Deal Two",
    currentPrice: "1200.00",
    currency: "DKK",
    sourceCurrentPrice: null,
    sourceCurrency: null,
    preferenceScore: 9,
    dealScore: 8,
  },
];

test("selects the recommendation with the highest rounded overall score", () => {
  assert.equal(selectTopRecommendation(recommendations)?.productId, "2");
});

test("prefers complete normalized pricing over a higher-ranked source-price fallback", () => {
  const sourcePriceOnly: ImportRecommendation = {
    productId: "3",
    title: "Source-priced deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
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
    title: "Source-priced deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "100.00",
    sourceCurrency: "USD",
    preferenceScore: 8,
    dealScore: 7,
  };

  assert.equal(selectTopRecommendation([sourcePriceOnly])?.productId, "3");
});

test("does not select a recommendation without a complete price and currency", () => {
  const incomplete: ImportRecommendation = {
    productId: "4",
    title: "Incomplete deal",
    currentPrice: "100.00",
    currency: null,
    sourceCurrentPrice: null,
    sourceCurrency: null,
    preferenceScore: 10,
    dealScore: 10,
  };

  assert.equal(selectTopRecommendation([incomplete]), null);
});

test("keeps the existing import summary when there is no recommendation", () => {
  assert.equal(
    formatImportSlackMessage(summary, null, "https://dealradar.example"),
    "DealRadar updated (main): 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated",
  );
});

test("appends a safe recommendation with scores, price, and DealRadar link", () => {
  const recommendation = {
    ...recommendations[1],
    title: "Shoes <Special> & Co.",
    currency: "DKK<test>",
  };

  assert.equal(
    formatImportSlackMessage(
      summary,
      recommendation,
      "https://dealradar.example",
    ),
    "DealRadar updated (main): 541 processed · 138 new · 403 updated · 358 snapshots · 50 evaluated\n" +
      "Top recommendation: Shoes &lt;Special&gt; &amp; Co. · Preference 9/10 · Deal 8/10 · 1200.00 DKK&lt;test&gt; · " +
      "<https://dealradar.example/?product=2#product-2|View in DealRadar>",
  );
});

test("formats preserved source pricing when normalized pricing is unavailable", () => {
  const recommendation: ImportRecommendation = {
    productId: "5",
    title: "USD deal",
    currentPrice: null,
    currency: null,
    sourceCurrentPrice: "275.00",
    sourceCurrency: "USD",
    preferenceScore: 8,
    dealScore: 6,
  };

  assert.match(
    formatImportSlackMessage(
      summary,
      recommendation,
      "https://dealradar.example",
    ),
    /275\.00 USD/,
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
      null,
      "https://dealradar.example",
      [warning],
    ),
    /Scan warnings:\n• Scarosso: 5\/6 pages succeeded; 1 failed\n  ◦ Boots &lt;sale&gt; — https:\/\/shop\.example\/search\?q=boots&amp;size=42: HTTP &lt;503&gt; &amp; timeout/,
  );
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
    null,
    "https://dealradar.example",
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
