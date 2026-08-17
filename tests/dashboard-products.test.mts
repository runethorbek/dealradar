import assert from "node:assert/strict";
import test from "node:test";
import {
  includeRequestedProduct,
  parseProductId,
} from "../lib/dashboard-products.mts";

test("parseProductId accepts positive PostgreSQL BIGINT product IDs", () => {
  assert.equal(parseProductId("1"), "1");
  assert.equal(
    parseProductId("9223372036854775807"),
    "9223372036854775807",
  );
});

test("parseProductId ignores invalid and out-of-range product IDs", () => {
  for (const value of [
    undefined,
    ["1"],
    "",
    "0",
    "-1",
    "1.5",
    "product-1",
    "9223372036854775808",
    "99999999999999999999999999999999999999999999999999",
  ]) {
    assert.equal(parseProductId(value), null);
  }
});

test("a requested product outside the top 50 is displayed exactly once", () => {
  const topFifty = Array.from({ length: 50 }, (_, index) => ({
    id: String(index + 1),
  }));
  const requestedProduct = { id: "51" };

  const displayedProducts = includeRequestedProduct(
    topFifty,
    requestedProduct,
  );

  assert.equal(displayedProducts.length, 51);
  assert.equal(displayedProducts[0], requestedProduct);
  assert.equal(
    displayedProducts.filter((product) => product.id === requestedProduct.id)
      .length,
    1,
  );
});

test("a requested product already in the top 50 is not duplicated", () => {
  const topFifty = Array.from({ length: 50 }, (_, index) => ({
    id: String(index + 1),
  }));

  const displayedProducts = includeRequestedProduct(topFifty, topFifty[24]);

  assert.equal(displayedProducts, topFifty);
  assert.equal(
    displayedProducts.filter((product) => product.id === "25").length,
    1,
  );
});
