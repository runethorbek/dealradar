# DealRadar Recommendation Policy

This document defines which products DealRadar surfaces as recommendations
after an import, per source. It is the policy from #55, implemented since
#60; see [Current production paths](#current-production-paths) and
[Implementation status](#implementation-status).

Terms (Preference score, Deal score, Overall score, Watch, Hide,
Recommendation) are defined in `docs/ubiquitous-language.md`.

## Principles

- Vinted and Zalando have separate, explicit policies. There is no generic
  cross-source recommendation formula and no comparison between sources.
- Preference = general taste, expressed in the written preference profile.
  Watch = explicit interest in one exact product. Deal = current buying
  opportunity. Overall = ranking of Preference + Deal.
- Slack is only the output channel. The policy decides what is recommended;
  Slack formatting does not.

## One recommendation per source

An import covers both Zalando and Vinted. It produces **at most one
recommendation per source**: up to one Zalando recommendation and up to one
Vinted recommendation. If a source has no qualifying product, it has no
recommendation for that import. The two sources are never ranked against each
other.

## Shared rules

These rules apply to every recommendation below.

- **Hidden products are excluded**, including products that are both Hidden
  and Watched. This follows the Hide definition. The Watchlist still shows
  hidden watched products.
- **Overall score** uses the configured `preferenceWeightPercent` from ranking
  settings and is compared unrounded (the exact weighted score), both for the
  minimum threshold and for tie-breaks.
- **Evaluated in this import.** For Overall-based recommendations, a candidate
  is a product evaluated during this import: a new or materially changed
  product selected for evaluation whose evaluation completed. Products
  evaluated in earlier imports are not candidates again, so the same product is
  not re-posted on every import. An import that evaluates nothing has no
  Overall-based recommendation.
- **Minimum Overall ≥ 7** for Overall-based recommendations. Below that, the
  source has no Overall-based recommendation.
- **Display price.** A candidate needs a displayable price. Candidates with a
  normalized price and currency are preferred; only when no candidate for that
  source has one does selection fall back to candidates with a source price
  and source currency. This keeps today's fallback behavior.
- **Tie-breaks are deterministic** and end with ascending product id.

## Vinted recommendation

Question answered: *what is the best current listing available to me now?*

1. Existing deterministic Vinted preselection (minimum article condition,
   excluded brands) and the automatic-evaluation limit decide which listings
   are evaluated. The recommendation policy does not change them.
2. Candidates: visible Vinted products evaluated during this import with
   Overall ≥ 7.
3. Select the highest Overall.
4. Ties: higher Overall → higher Deal score → ascending product id.

Vinted has no price-history or watched-product rules. Watched
Vinted products receive no special priority.

## Zalando recommendation

Question answered: *has something I explicitly watch become a particularly
good buying opportunity?* Otherwise: *what is the best current Zalando
opportunity?*

1. **Watched historical-low event first.** If one or more visible Watched
   Zalando products have a
   [watched historical-low event](#watched-historical-low-event) in this
   import, recommend the strongest one. There is no Overall threshold and no
   evaluation is required for this step.
   Ties: larger percentage drop versus the previous observation → higher
   Overall → ascending product id. Overall here uses the product's current
   stored evaluation, however old (a watched product may not have been
   evaluated in this import). A product with a stored evaluation ranks above
   one without.
2. **Zalando fallback.** Otherwise, recommend the visible Zalando product
   evaluated during this import with the highest Overall, provided Overall ≥ 7.
   Ties: higher Overall → higher Deal score → ascending product id.

If neither step produces a product, Zalando has no recommendation.

## Watched historical-low event

A watched historical-low event is a **price transition**, not a state. It
occurs for a product in an import when all of the following hold:

1. The product is Watched, visible (not Hidden), and its source is Zalando.
2. The import inserted a **new observation** (a new `product_snapshots` row)
   for the product. Re-importing data whose observation already exists
   inserts nothing and therefore produces no event.
3. The new observation is the product's **latest** observation: no stored
   observation has a later `observed_at`. An inserted observation that is
   older than already stored ones (for example when an older ref is
   re-imported) produces no event, because it is not the current price.
4. **Compared price pair.** If the new observation has a source price
   (`source_current_price`), the source pair
   (`source_current_price` / `source_currency`) is compared. Otherwise the
   normalized pair (`current_price` / `currency`) is compared. This matches
   the pair preference of today's price-drop detection. The new observation's
   compared price and currency must both be known.
5. **Comparable history** is every observation with an `observed_at` before
   the new observation's whose compared price and currency are known and
   whose currency equals the new observation's. Observations with a missing
   currency (for example snapshots that may predate snapshot currency,
   migration 010) or a different currency do not count. No currency is
   inferred.
6. There is at least one comparable earlier observation. A product's first
   observation never qualifies.
7. **Previous observation** is the most recent comparable earlier observation
   (by `observed_at`). The new price is strictly lower than the previous
   observation's price.
8. **Previous historical minimum** is the minimum price over all comparable
   earlier observations (all stored history, no time window). The new price is
   less than or equal to the previous historical minimum.

The **drop percentage** used for ranking is
`(previous price − new price) / previous price × 100`, rounded to 4 decimal
places so that nominally equal drops tie and the next tie-break decides.

Examples (same currency, product Watched and visible):

| Comparable history → new price | Event? | Why |
| --- | --- | --- |
| `500` (first observation) | No | No earlier observation |
| `500 → 500` | No | No drop versus previous observation |
| `500 → 500 → 500` | No | Remaining at the low is not a new event |
| `500 → 600 → 500` | Yes | Dropped, and returned to the previous low |
| `500 → 450` | Yes | Dropped to a new all-time low |
| `500 → 600 → 550` | No | Dropped, but above the previous low of 500 |
| `500 (EUR) → 450 (DKK)` | No | No comparable same-currency history |
| `500 (no currency) → 600 → 500` | Yes | The currency-less 500 is ignored; comparable history is `600`, so 500 is a drop to the minimum |

Unlike today's price-drop detection, which compares against the previous
values on the `products` row, the event compares against stored snapshots.
The price-pair preference itself is unchanged.

Whether an event occurred is only known during the import (it depends on the
inserted snapshot), so it is **detected at import time** with one
snapshot-history query per import, over the stored history of visible Watched
Zalando products that received a new observation. When the import has
evaluation candidates, the Slack message is sent later by the evaluation
finalizer, so the events (product id and drop percentage) are recorded with
the evaluation run (`evaluation_runs.watched_historical_lows`, migration 026).
When the recommendation is selected, the product's current state is re-read:
a product that has been hidden or unwatched since the import no longer
qualifies, and its current stored evaluation (if any) is used for the Overall
tie-break.

## Removed: Like / Not for me

Like / Not for me feedback was removed in #66, following the #61
investigation. It had no recommendation, ranking, or visibility role; its only
remaining use was as secondary examples in the Gemini evaluation prompt. The
written preference profile is the only Preference signal. There is no Liked
price-drop rule.

## Current production paths

As of #60, production implements this policy for both sources. Every import
posts one Slack message with up to two entries, "Zalando recommendation"
followed by "Vinted recommendation"; a source without a recommendation is
omitted. Products whose source is neither Zalando nor Vinted are never
recommended.

**Vinted** — `selectVintedRecommendation` (`lib/import-notification.mts`),
called from `lib/evaluation-finalization.mts` once the durable run is
terminal, over the run's completed evaluations. It implements
[Vinted recommendation](#vinted-recommendation) as specified. An import with
no evaluation candidates has no Vinted recommendation.

**Zalando step 1** — `findWatchedHistoricalLows`
(`lib/watched-historical-low.mts`), called from
`app/api/import-deals/route.ts` with the snapshots this import inserted for
Zalando products, detects the events. `selectWatchedHistoricalLowRecommendation`
implements [Zalando recommendation](#zalando-recommendation) step 1 as
specified. It runs in the import route when there are no evaluation
candidates, and otherwise in `lib/evaluation-finalization.mts` from the events
recorded with the run.

**Zalando step 2 (fallback)** — `selectZalandoFallbackRecommendation`
(`lib/import-notification.mts`), called from `lib/evaluation-finalization.mts`
over the run's completed evaluations only when step 1 selects nothing. It
implements [Zalando recommendation](#zalando-recommendation) step 2 as
specified, with the same Overall-based selection as Vinted. An import with no
evaluation candidates has no Zalando fallback recommendation, so its only
possible Zalando recommendation is a watched historical-low event.

## Implementation status

| Slice | Issue | Scope |
| --- | --- | --- |
| 1 | #57 | This specification; characterization tests of current behavior |
| 2 | #58 | Vinted recommendation; per-source Slack output |
| 3 | #59 | Zalando watched historical-low event |
| 4 | #60 | Zalando fallback |
| 5 | #61 | Reassess Like / Not for me (investigation) |
| 6 | #66 | Remove Like / Not for me |

#58 changed the Slack message from one highlight to up to two (one per
source). #59 added the Zalando watched historical-low step. #60 replaced the
interim Zalando rules (the Watched/Liked/generic price-drop tiers for imports
without evaluation candidates, and the highest rounded Overall without a
threshold for imports with them) with the Zalando fallback.
