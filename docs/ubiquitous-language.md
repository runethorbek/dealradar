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
Hidden products cause no Watched alerts, including Hidden Watched products.

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
visibility, or evaluation input.

Since #81, a visible Watched product can also receive a **Watched alert** from
each Active `discount_threshold` monitor it belongs to. Watched state itself
stays independent of monitor configuration: watching does not add a product to
a monitor, and there are no per-product target prices.

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

During the parallel run (since #80), a Recommendation has two forms: the
per-source import recommendation above, which is unchanged, and the per-monitor
Best match in the Daily summary. Retiring the per-source form needs explicit
approval (design D14, Phase 7).

## New recommendation

A newly imported or materially changed product that has been evaluated during
the current import, is visible, and has an Overall score of at least 7. It is
the candidate pool for the Vinted recommendation and the Zalando fallback
recommendation. Products evaluated in earlier imports are not new
recommendations again.

The Vinted recommendation (since #58) and the Zalando fallback recommendation
(since #60) apply this definition.

## Monitor

A configured search in Deals, identified by a stable monitor ID. A changed ID
is a different monitor.

## Monitor definition

The recommendation-relevant part of a monitor, as published by Deals in
`public/deals/monitor-recommendations.json` and persisted by DealRadar in
`monitor_definitions`: source, optional display name, enabled flag, and an
optional Recommendation strategy with its threshold. Deals owns monitor
definitions; DealRadar does not edit them. A monitor absent from the latest
valid document is kept as removed.

## Active monitor

A monitor definition that is enabled, not removed, and has a Recommendation
strategy. A monitor without a strategy is unconfigured and is not active.

## Recommendation strategy

How a monitor's products qualify for a monitor recommendation:
`discount_threshold` (with a minimum discount percent; Zalando only) or
`best_match` (with a minimum Overall score). No strategy is inferred when a
monitor has none. Since #80, a monitor's strategy decides its Qualifying
products and Best match in the Daily summary; it does not change the
per-source import recommendation.

## Qualifying product

A Fresh, visible member of an Active monitor that meets that monitor's
Recommendation strategy: for `discount_threshold`, a reliable Discount at or
above the threshold; for `best_match`, an unrounded Overall score at or above
the threshold. A missing evaluation is never a low score: a
`discount_threshold` product qualifies without an evaluation and is counted as
not yet evaluated; a `best_match` product cannot qualify until it is evaluated.

## Best match

The highest-ranked Qualifying product of one Active monitor: highest Overall
score, then highest Deal score, then ascending product id, among evaluated
Qualifying products with a displayable price. A monitor that is not Fresh has
no Best match. A product can be the Best match of several monitors. "Best
match" is also the name of the `best_match` Recommendation strategy and of the
dashboard sort by rounded Overall score; the context says which is meant.

## Discount

The producer's `discount_percent` for a product, used for qualification only
when it is reliable: a Zalando product, a discount above 0 and below 100, and a
known current price and currency. DealRadar does not calculate discounts. It is
also evidence for the Deal score.

## Daily summary

The once-per-day Slack message, per Europe/Copenhagen date, with one Best match
per Active monitor, its Qualifying product and not-yet-evaluated counts, each
monitor's freshness, and the import's monitor definition and Scan warnings. It
is produced from persisted state after the first import of the day, at most
once per date, and never after its date. There is no Daily summary without an
Active monitor. It is separate from the per-import message.

## Watched alert

A Slack notification about a visible Watched product, detected at import time
from a new observation (an inserted snapshot that is the product's latest),
for an Active `discount_threshold` monitor the product belongs to. The
observation has a reliable Discount at or above the monitor's threshold, and
either the Discount crosses the threshold (the previous priced observation was
below it) or it is a new best in the Qualifying episode (its whole-percent
Discount, rounded down, is above the highest in the episode). The baseline
comes from stored history, so a product that already qualifies when it becomes
Watched, or when a threshold is lowered, alerts only on its next new best. A
product's first priced observation never alerts. `best_match` monitors give no Watched alerts. One message is sent per
product and observation, listing every monitor that triggered, and at most
once. A pending alert is not sent once the product is no longer Watched,
visible, and qualifying; it expires. While the watched historical-low event
remains separate, a Watched alert is not sent when that event occurred for the
same product and observation.

## Qualifying episode

For one product and one `discount_threshold` monitor, the run of consecutive
priced observations at or above the monitor's current threshold. A priced
observation with no detected Discount counts as 0% and ends the episode, as
does any priced observation below the threshold. Observations without a price
or with an out-of-range Discount are skipped and do not end it.

## Fresh

A monitor is Fresh (current) when its latest imported scan is no older than 36
hours; otherwise it is stale, or never scanned. A product is Fresh for a
monitor when it was seen in that monitor's latest scan. Fresh is distinct from
the dashboard's 24h/7d freshness filter.

## Price change

A change in the observed current price compared with the previously stored
observation for the same product.

## Scan warning

A scraper run that completed sufficiently to publish/import data but where one
or more source pages failed.

A scan warning is not the same as a failed import or failed workflow.
