# DealRadar Ubiquitous Language

## Like

A user feedback signal meaning:

> "This product is relevant to my taste and I would like DealRadar to learn
> from it."

"Like" is primarily preference feedback.

It does not necessarily mean:
- the current price is good;
- the user intends to buy it now;
- the deal score should be high.

A product can be highly liked while being a poor deal.

## Not for me

A user feedback signal meaning:

> "This product is not a good match for my taste and DealRadar should learn
> to recommend fewer products like it."

"Not for me" is primarily preference feedback.

It does not necessarily mean:
- the product is objectively bad;
- the price is bad;
- the retailer or product data is incorrect.

## Visibility

The presentation state that determines whether a tracked product appears in
the user's default product view.

Visibility is separate from preference feedback. A product may be hidden while
being liked or marked "Not for me."

## Hide

A reversible visibility action meaning:

> "Keep tracking this product, but do not show it in my default product view
> or product recommendations until I choose Unhide."

Hide is not preference feedback. It must not teach DealRadar that the product
is liked or not relevant. Hiding does not change existing import, evaluation
eligibility, scoring, sorting, or price-tracking behavior.

Hidden products remain available through the Hidden view. An explicitly
requested hidden product remains available and is clearly identified as
Hidden. Hidden products are excluded from product recommendation selection,
but hiding does not affect operational import summaries or scan warnings.

## Unhide

A visibility action that returns a hidden product to the default product view
and product recommendation eligibility.

Unhide is always explicit and does not change existing Like or Not for me
feedback. Like and Not for me never change product visibility. Unhide restores
eligibility for future product recommendations but does not itself trigger a
notification.

## Preference score

A score from 1-10 representing how well the product matches the user's
learned and explicitly stated preferences.

Preference score should consider characteristics such as:
- style
- shape
- material
- color
- brand where relevant
- category
- details learned from Like / Not for me feedback

Preference score should not primarily reflect whether the current price is
attractive.

Examples:

- 9/10 preference, 3/10 deal:
  Excellent style match, but currently overpriced.

- 3/10 preference, 9/10 deal:
  Excellent discount, but not a product the user is likely to want.

## Deal score

A score from 1-10 representing how attractive the current buying opportunity is.

Deal score should consider available evidence such as:
- current price
- original/reference price
- discount percentage
- price history
- previous observed prices
- confidence and quality of pricing data

Deal score should not primarily reflect personal taste.

Insufficient or unreliable price information should reduce confidence in the
deal score rather than being guessed.

## Overall score

The ranking score used to combine preference and deal quality.

Current intended weighting:

- 60% Preference
- 40% Deal

Overall score is a ranking mechanism, not an independent AI judgment.

## Recommendation

A product surfaced because DealRadar considers it sufficiently relevant based
on its current evaluation and ranking.

A recommendation does not imply an instruction to purchase.

## New recommendation

A newly imported or materially changed product that has been evaluated during
the current import and is worth surfacing to the user.

## Price change

A change in the observed current price compared with the previously stored
observation for the same product.

## Scan warning

A scraper run that completed sufficiently to publish/import data but where one
or more source pages failed.

A scan warning is not the same as a failed import or failed workflow.
