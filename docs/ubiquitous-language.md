# DealRadar Ubiquitous Language

## Visibility

The presentation state that determines whether a tracked product appears in
the user's default product view.

Visibility is separate from Preference. Hiding a product says nothing about
whether it matches the user's taste.

## Hide

A reversible visibility action meaning:

> "Keep tracking this product, but do not show it in my default product view
> or product recommendations until I choose Unhide."

Hide is not a Preference signal. It must not teach DealRadar that the product
is or is not relevant to the user's taste. Hiding does not change existing import, evaluation
eligibility, scoring, sorting, or price-tracking behavior.

Hidden products remain available through the Hidden view. An explicitly
requested hidden product remains available and is clearly identified as
Hidden. Hidden products are excluded from product recommendation selection,
but hiding does not affect operational import summaries or scan warnings.

## Unhide

A visibility action that returns a hidden product to the default product view
and product recommendation eligibility.

Unhide is always explicit. Unhide restores eligibility for future product recommendations but does not itself trigger a
notification.

## Watch

A reversible tracking-intent action meaning:

> "I am specifically interested in this product and want to keep an eye on
> it over time."

The active state is called **Watched**, and watched products can be retrieved
through the **Watchlist** view. Watch is independent from visibility and
Preference: watching does not unhide, hide, or otherwise re-rank a product,
and those actions do not change Watch state.

The Watchlist includes both visible and hidden watched products. Hidden
products remain clearly identified as Hidden there; Watch does not change
their visibility.

Watch records persistent explicit interest. In the recommendation policy
(`docs/recommendation-policy.md`), a visible Watched Zalando product with a
**watched historical-low event** in the current import receives first
Zalando recommendation priority. A watched historical-low event is a price
transition: the new same-currency observation is strictly lower than the
previous observation and at or below the lowest earlier same-currency
observation. Remaining at the same low price is not a new event. Watch gives no
recommendation priority for Vinted. This does not change dashboard ranking,
visibility, evaluation input, or the absence of target-price alerts.

Since #60, the watched historical-low event is the only recommendation
priority Watch gives in production: a Watched Zalando price drop that is not a
watched historical-low event gives no priority, and Watch gives no Vinted
priority.

## Preference score

A score from 1-10 representing how well the product matches the user's
stated preferences. The written preference profile is the Preference signal.

Preference score should consider characteristics such as:
- style
- shape
- material
- color
- brand where relevant
- product type when it can be established reliably from the supplied product data

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

Overall score is a weighted combination of Preference score and Deal score:

- Overall = (Preference weight × Preference score + Deal weight × Deal score) / 100

The Preference weight is configurable in Settings as `preferenceWeightPercent`
(0-100). Deal weight is always derived as `100 - preferenceWeightPercent` and
is never stored independently. The default, and the weighting used unless a
user configures otherwise, is 60% Preference / 40% Deal.

Changing the weighting changes how Preference and Deal scores are combined
into Overall score. It does not change how Preference score or Deal score
themselves are produced.

Overall score is a ranking mechanism, not an independent AI judgment.

## Recommendation

A product surfaced because DealRadar considers it sufficiently relevant based
on its current evaluation and ranking, or because a Watched product reached a
watched historical-low event.

Recommendations are per source: an import has at most one Vinted
recommendation and at most one Zalando recommendation, and the sources are
never compared with each other. Hidden products are never recommended.
The full rules are in `docs/recommendation-policy.md`.

A recommendation does not imply an instruction to purchase.

Since #60, both the Vinted and the Zalando recommendation follow the policy.
See "Current production paths" in `docs/recommendation-policy.md`.

## New recommendation

A newly imported or materially changed product that has been evaluated during
the current import, is visible, and has an Overall score of at least 7. It is
the candidate pool for the Vinted recommendation and the Zalando fallback
recommendation. Products evaluated in earlier imports are not new
recommendations again.

The Vinted recommendation (since #58) and the Zalando fallback recommendation
(since #60) apply this definition.

## Price change

A change in the observed current price compared with the previously stored
observation for the same product.

## Scan warning

A scraper run that completed sufficiently to publish/import data but where one
or more source pages failed.

A scan warning is not the same as a failed import or failed workflow.
