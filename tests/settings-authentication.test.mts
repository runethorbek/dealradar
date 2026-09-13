import assert from "node:assert/strict";
import test from "node:test";
import { handleSettingsPost } from "../lib/settings-api.mts";

function request(body: unknown) {
  return new Request("http://localhost/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("settings validate, normalize, and persist the typed Vinted shape", async () => {
  let saved: unknown;
  const response = await handleSettingsPost(request({ vinted: { minimumCondition: "Meget god", excludedBrands: [" H&M ", "h&m", "Zara"] } }), {
    authorize: async () => ({ status: "authorized" }),
    save: async (vinted) => { saved = vinted; return { vinted, updatedAt: "2026-09-13T00:00:00.000Z" }; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(saved, { minimumCondition: "Meget god", excludedBrands: ["H&M", "Zara"] });
});

test("settings reject invalid values and unauthorized writes", async () => {
  let saveCalls = 0;
  const invalid = await handleSettingsPost(request({ vinted: { minimumCondition: "Bad", excludedBrands: [] } }), { authorize: async () => ({ status: "authorized" }), save: async () => { saveCalls += 1; throw new Error(); } });
  assert.equal(invalid.status, 400);
  const unauthorized = await handleSettingsPost(request({ vinted: { minimumCondition: null, excludedBrands: [] } }), { authorize: async () => ({ status: "unauthorized" }), save: async () => { saveCalls += 1; throw new Error(); } });
  assert.equal(unauthorized.status, 403);
  assert.equal(saveCalls, 0);
});
