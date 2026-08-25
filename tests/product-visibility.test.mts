import assert from "node:assert/strict";
import test from "node:test";
import { parseProductVisibilityRequest } from "../lib/product-visibility.mts";

test("parses an explicit product visibility request", () => {
  assert.deepEqual(
    parseProductVisibilityRequest({ productId: "42", hidden: true }),
    { productId: "42", hidden: true },
  );
  assert.deepEqual(
    parseProductVisibilityRequest({ productId: "42", hidden: false }),
    { productId: "42", hidden: false },
  );
});

test("rejects malformed product visibility requests", () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { productId: "0", hidden: true },
    { productId: "9223372036854775808", hidden: true },
    { productId: "42", hidden: "true" },
    { productId: "42", hidden: null },
  ]) {
    assert.equal(parseProductVisibilityRequest(value), null);
  }
});
