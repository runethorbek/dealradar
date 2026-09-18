import assert from "node:assert/strict";
import test from "node:test";
import { handleSettingsPost } from "../lib/settings-api.mts";

function request(body: unknown) {
  return new Request("http://localhost/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("settings validate, normalize, and persist typed Vinted, Gemini, and brand filter shapes", async () => {
  let saved: unknown;
  const response = await handleSettingsPost(request({ vinted: { minimumCondition: "Meget god", excludedBrands: [" H&M ", "h&m", "Zara"] }, gemini: { automaticEvaluationLimit: 100, workflowBatchSize: 7 }, brandFilter: { preferredBrands: [" Tiger of Sweden ", "tiger of sweden", "Filippa K"] } }), {
    authorize: async () => ({ status: "authorized" }),
    save: async (vinted, gemini, brandFilter) => { saved = { vinted, gemini, brandFilter }; return { vinted, gemini, brandFilter, updatedAt: "2026-09-13T00:00:00.000Z" }; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(saved, {
    vinted: { minimumCondition: "Meget god", excludedBrands: ["H&M", "Zara"] },
    gemini: { automaticEvaluationLimit: 100, workflowBatchSize: 7 },
    brandFilter: { preferredBrands: ["Tiger of Sweden", "Filippa K"] },
  });
});

test("settings save without brand filter settings leaves the save call's optional argument undefined", async () => {
  let receivedBrandFilter: unknown = "not called";
  const response = await handleSettingsPost(request({ vinted: { minimumCondition: null, excludedBrands: [] } }), {
    authorize: async () => ({ status: "authorized" }),
    save: async (vinted, gemini, brandFilter) => { receivedBrandFilter = brandFilter; return { vinted, updatedAt: "2026-09-13T00:00:00.000Z" }; },
  });
  assert.equal(response.status, 200);
  assert.equal(receivedBrandFilter, undefined);
});

test("settings reject invalid values and unauthorized writes", async () => {
  let saveCalls = 0;
  const invalid = await handleSettingsPost(request({ vinted: { minimumCondition: "Bad", excludedBrands: [] } }), { authorize: async () => ({ status: "authorized" }), save: async () => { saveCalls += 1; throw new Error(); } });
  assert.equal(invalid.status, 400);
  for (const gemini of [{ automaticEvaluationLimit: 0 }, { automaticEvaluationLimit: -1 }, { automaticEvaluationLimit: 1.5 }, { automaticEvaluationLimit: "50" }, { automaticEvaluationLimit: 501 }, { automaticEvaluationLimit: 50, workflowBatchSize: 0 }, { automaticEvaluationLimit: 50, workflowBatchSize: 11 }, { automaticEvaluationLimit: 50, workflowBatchSize: 1.5 }]) {
    const invalidGemini = await handleSettingsPost(request({ vinted: { minimumCondition: null, excludedBrands: [] }, gemini }), { authorize: async () => ({ status: "authorized" }), save: async () => { saveCalls += 1; throw new Error(); } });
    assert.equal(invalidGemini.status, 400);
  }
  for (const brandFilter of [{ preferredBrands: "Mango" }, { preferredBrands: [1] }, { preferredBrands: null }, {}]) {
    const invalidBrandFilter = await handleSettingsPost(request({ vinted: { minimumCondition: null, excludedBrands: [] }, brandFilter }), { authorize: async () => ({ status: "authorized" }), save: async () => { saveCalls += 1; throw new Error(); } });
    assert.equal(invalidBrandFilter.status, 400);
  }
  const unauthorized = await handleSettingsPost(request({ vinted: { minimumCondition: null, excludedBrands: [] } }), { authorize: async () => ({ status: "unauthorized" }), save: async () => { saveCalls += 1; throw new Error(); } });
  assert.equal(unauthorized.status, 403);
  assert.equal(saveCalls, 0);
});
