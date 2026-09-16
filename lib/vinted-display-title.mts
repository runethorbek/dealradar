function cleanSegment(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

/**
 * Assembles the Vinted display title deterministically from already-known
 * segments. Missing segments are dropped rather than left as empty text, so
 * separators never duplicate or dangle. Prices are never a segment here.
 */
export function buildVintedDisplayTitle(input: {
  brand: string | null;
  listingText: string | null;
  translatedListingTextDa: string | null;
  articleCondition: string | null;
  sizeGuess: string | null;
}): string {
  const text =
    cleanSegment(input.translatedListingTextDa) ??
    cleanSegment(input.listingText);

  return [
    cleanSegment(input.brand),
    text,
    cleanSegment(input.articleCondition),
    cleanSegment(input.sizeGuess),
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(" - ");
}

/**
 * Vinted products get a deterministic display title built from brand,
 * translated/original listing text, condition, and size. Every other
 * source keeps using its stored `title` unchanged.
 */
export function getProductDisplayTitle(product: {
  source: string;
  title: string;
  brand: string | null;
  listingText?: string | null;
  articleCondition?: string | null;
  sizeGuess?: string | null;
  evaluation?: { translatedListingTextDa: string | null } | null;
}): string {
  if (product.source !== "vinted.com") {
    return product.title;
  }

  const displayTitle = buildVintedDisplayTitle({
    brand: product.brand,
    listingText: product.listingText ?? null,
    translatedListingTextDa: product.evaluation?.translatedListingTextDa ?? null,
    articleCondition: product.articleCondition ?? null,
    sizeGuess: product.sizeGuess ?? null,
  });

  return displayTitle || product.title;
}
