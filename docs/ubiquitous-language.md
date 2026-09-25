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

## Watch

A reversible tracking-intent action meaning:

> "I am specifically interested in this product and want to keep an eye on
> it over time."

The active state is called **Watched**, and watched products can be retrieved
through the **Watchlist** view. Watch is independent from visibility and
preference feedback: watching does not Like, unhide, hide, or otherwise
re-rank a product, and those actions do not change Watch state.

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
visibility, feedback, evaluation input, or the absence of target-price alerts.

Current production still uses the earlier rule until #59 is implemented: for
Slack import highlights in imports with no evaluation candidates, a visible
Watched product that existed before the import and has a valid same-currency
price drop of at least 5% receives first selection priority.

## Preference score

A score from 1-10 representing how well the product matches the user's
learned and explicitly stated preferences.

Preference score should consider characteristics such as:
- style
- shape
- material
- color
- brand where relevant
- product type when it can be established reliably from the supplied product data
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
Like / Not for me have no direct recommendation priority; they only inform
Gemini's Preference score as secondary examples. The full rules are in
`docs/recommendation-policy.md`.

A recommendation does not imply an instruction to purchase.

Current production does not yet follow the per-source rules (#58-#60): each
import still produces at most one recommendation across both sources, and
Liked price drops still receive selection priority when an import has no
evaluation candidates. See "Current production paths" in
`docs/recommendation-policy.md`.

## New recommendation

A newly imported or materially changed product that has been evaluated during
the current import, is visible, and has an Overall score of at least 7. It is
the candidate pool for the Vinted recommendation and the Zalando fallback
recommendation. Products evaluated in earlier imports are not new
recommendations again.

Current production does not yet apply the minimum Overall score when an
import has evaluation candidates: the highest-ranked visible evaluated
product is selected regardless of score, until #58 and #60 are implemented.

## Price change

A change in the observed current price compared with the previously stored
observation for the same product.

## Scan warning

A scraper run that completed sufficiently to publish/import data but where one
or more source pages failed.

A scan warning is not the same as a failed import or failed workflow.
