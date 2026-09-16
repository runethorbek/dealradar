import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVintedDisplayTitle,
  getProductDisplayTitle,
} from "../lib/vinted-display-title.mts";

test("builds the full Vinted display title from brand, translated text, condition, and size", () => {
  const title = buildVintedDisplayTitle({
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    translatedListingTextDa: "Granatrød blazer med mærke",
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
  });

  assert.equal(title, "Racing Green - Granatrød blazer med mærke - Ny med prismærker - S");
});

test("falls back to the original listing text when translation is unavailable", () => {
  const title = buildVintedDisplayTitle({
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    translatedListingTextDa: null,
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
  });

  assert.equal(title, "Racing Green - granatowa marynarka z metką - Ny med prismærker - S");
});

test("falls back to the original listing text when translation is blank", () => {
  const title = buildVintedDisplayTitle({
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    translatedListingTextDa: "   ",
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
  });

  assert.equal(title, "Racing Green - granatowa marynarka z metką - Ny med prismærker - S");
});

test("missing brand, condition, and size collapse cleanly without dangling separators", () => {
  const title = buildVintedDisplayTitle({
    brand: null,
    listingText: "granatowa marynarka z metką",
    translatedListingTextDa: null,
    articleCondition: null,
    sizeGuess: null,
  });

  assert.equal(title, "granatowa marynarka z metką");
});

test("a missing middle segment does not produce a duplicate separator", () => {
  const title = buildVintedDisplayTitle({
    brand: "Racing Green",
    listingText: null,
    translatedListingTextDa: null,
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
  });

  assert.equal(title, "Racing Green - Ny med prismærker - S");
});

test("all segments missing produces an empty title", () => {
  const title = buildVintedDisplayTitle({
    brand: null,
    listingText: null,
    translatedListingTextDa: null,
    articleCondition: null,
    sizeGuess: null,
  });

  assert.equal(title, "");
});

test("the display title is built only from brand, text, condition, and size, never price", () => {
  const title = buildVintedDisplayTitle({
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    translatedListingTextDa: null,
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
  });

  assert.equal(title, "Racing Green - granatowa marynarka z metką - Ny med prismærker - S");
  assert.doesNotMatch(title, /\bkr\b|\d+[.,]\d+/);
});

test("getProductDisplayTitle assembles the Vinted title from product and evaluation data", () => {
  const title = getProductDisplayTitle({
    source: "vinted.com",
    title: "Bleizeri, Varemærke: Racing Green, Artiklens stand: Ny med prismærker, Størrelse: S, 17.43 kr",
    brand: "Racing Green",
    listingText: "granatowa marynarka z metką",
    articleCondition: "Ny med prismærker",
    sizeGuess: "S",
    evaluation: { translatedListingTextDa: "Granatrød blazer med mærke" },
  });

  assert.equal(title, "Racing Green - Granatrød blazer med mærke - Ny med prismærker - S");
});

test("getProductDisplayTitle falls back to the raw title when every Vinted segment is missing", () => {
  const title = getProductDisplayTitle({
    source: "vinted.com",
    title: "Raw fallback title",
    brand: null,
    listingText: null,
    articleCondition: null,
    sizeGuess: null,
    evaluation: null,
  });

  assert.equal(title, "Raw fallback title");
});

test("Zalando titles remain the stored title unchanged", () => {
  const title = getProductDisplayTitle({
    source: "zalando.dk",
    title: "Zalando raw title",
    brand: "Mango",
    listingText: "should be ignored",
    articleCondition: "should be ignored",
    sizeGuess: "should be ignored",
    evaluation: { translatedListingTextDa: "should be ignored" },
  });

  assert.equal(title, "Zalando raw title");
});
