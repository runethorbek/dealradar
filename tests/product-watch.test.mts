import assert from "node:assert/strict";
import test from "node:test";
import { parseProductWatchRequest } from "../lib/product-watch.mts";

test("parses explicit Watch and Unwatch requests", () => {
  assert.deepEqual(
    parseProductWatchRequest({ productId: "42", watched: true }),
    { productId: "42", watched: true },
  );
  assert.deepEqual(
    parseProductWatchRequest({ productId: "42", watched: false }),
    { productId: "42", watched: false },
  );
});

test("rejects malformed Watch requests", () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { productId: "0", watched: true },
    { productId: "9223372036854775808", watched: true },
    { productId: "42", watched: "true" },
    { productId: "42", watched: null },
  ]) {
    assert.equal(parseProductWatchRequest(value), null);
  }
});
