# DealRadar Recommendation Policy

This document defines which products DealRadar surfaces as recommendations.
Since #90, the only Recommendation is the [Daily summary](#daily-summary): at
most one Best match per Active monitor per Daily summary. A
[Watched alert](#watched-alert) is a separate product notification, not a
Recommendation. The per-import Slack message is operational only: counts and
scan warnings (design P7(b)). See
[Removed: per-source recommendations](#removed-per-source-recommendations)
and [Implementation status](#implementation-status).

Terms (Preference score, Deal score, Overall score, Watch, Hide,
Recommendation, Active monitor, Best match, Watched alert) are defined in
`docs/ubiquitous-language.md`.

## Principles

- Each Active monitor is selected on its own, with its own Recommendation
  strategy and threshold. There is no generic cross-monitor or cross-source
  recommendation formula and no comparison between monitors or sources.
- Preference = general taste, expressed in the written preference profile.
  Watch = explicit interest in one exact product. Deal = current buying
  opportunity. Overall = ranking of Preference + Deal.
- Operational import information stays separate from recommendations: the
  per-import message has the import counts and scan warnings, and no product.
- Slack is only the output channel. The policy decides what is recommended;
  Slack formatting does not.

## Daily summary selection rules

These rules apply to the Best match of every Active monitor in the
[Daily summary](#daily-summary) (`selectForMonitor` in
`lib/monitor-recommendation.mts`).

- **Hidden products are excluded**, including products that are both Hidden
  and Watched. This follows the Hide definition. The Watchlist still shows
  hidden watched products.
- **Threshold per monitor.** A Fresh member qualifies against its monitor's own
  threshold: for `best_match`, an Overall score at or above the monitor's
  minimum Overall score (a product without an evaluation never qualifies);
  for `discount_threshold`, a reliable Discount at or above the monitor's
  minimum discount. There is no global minimum Overall score.
- **Overall score** uses the configured `preferenceWeightPercent` from ranking
  settings and is compared unrounded (the exact weighted score), both for the
  `best_match` threshold and for tie-breaks. The Daily summary shows it with
  one decimal.
- **Display price.** The Best match needs a displayable price. Among the
  monitor's evaluated Qualifying products, those with a normalized price and
  currency are preferred; only when none has one does selection fall back to
  products with a source price and source currency.
- **Tie-breaks are deterministic**, for both strategies: higher Overall →
  higher Deal score → ascending product id.

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

The **drop percentage**, stored with the Watched alert and shown in its
message, is `(previous price − new price) / previous price × 100`, rounded to
4 decimal places.

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
Zalando products that received a new observation. It does not require
monitor membership. Since #89, each event is stored as a `historical_low`
[Watched alert](#watched-alert) on the new observation and delivered with the
Watched alerts. When the import has evaluation candidates, the events
(product id, snapshot id, and drop percentage) are also still recorded with
the evaluation run (`evaluation_runs.watched_historical_lows`, migration 026)
as a diagnostic record that nothing reads.

## Daily summary

Since #80, DealRadar also sends a **Daily summary** (design D11, D13, P5, P12
in `docs/specs/monitor-recommendation-design.md`). Since #90 it is the only
Recommendation; it is a separate message from the per-import message. Terms
(Active monitor, Qualifying product, Best match, Discount, Fresh) are defined
in `docs/ubiquitous-language.md`.

- **Content.** One entry per Active monitor, in monitor ID order: the
  monitor's display name (or its ID when it has none), its strategy and
  threshold, the number of Qualifying products, the number not yet evaluated,
  and the Best match with title, price, Discount where reliable, Overall, and
  link. When nothing qualifies, the entry says "No products qualify." A
  monitor that is stale or never scanned states that and shows no Best match.
  The import's monitor definitions warning and scan warnings are repeated.
  The summary never lists every qualifying product.
- **Selection.** `lib/monitor-recommendation.mts` (#79): each monitor on its
  own, with the [Daily summary selection rules](#daily-summary-selection-rules),
  over Fresh members and their stored evaluations, whatever their age. The
  summary triggers no Gemini evaluation.
- **Summary date.** The Europe/Copenhagen date, computed once when the import
  starts and stored with the evaluation run (`evaluation_runs.import_summary`),
  so step retries, resumed runs, and runs that finish after midnight keep it.
- **Trigger.** At the end of the import pipeline: a Workflow step after the
  evaluation-run finalizer, or, for an import with no evaluation candidates,
  the import route after the per-import message. There is no time-based
  fallback; a day with no completed import has no summary.
- **Once per date.** `produceDailySummary` (`lib/daily-summary.mts`) persists
  the content in `daily_summaries` (migration 030) before sending, claims the
  row, sends with a client_msg_id derived from the date, and marks it sent.
  A failed send releases the claim: the Workflow step throws so its retries
  try again, and any later import on the same date retries it with the same
  content. A summary is never sent after its date. Without an Active monitor
  no summary is produced.

## Watched alert

Since #81, DealRadar also sends **Watched alerts** (design D10, D12, D13, P1,
P4, P5, P6, P10 in `docs/specs/monitor-recommendation-design.md`). They are
separate from the per-import message and the Daily summary, and a Watched
alert is not a Recommendation. Since #89 (P4(c)), a watched historical-low
event is a Watched alert reason. Terms (Watched alert, Qualifying episode,
Active monitor, Discount) are defined in `docs/ubiquitous-language.md`.

A Watched alert has one of three reasons: **crossing** and **new best**, per
`discount_threshold` monitor, and **historical low**, per product.

- **Threshold candidate.** For product *p*, monitor *M* with threshold *T*,
  and observation *o*, all of these hold:
  1. *p* is Watched and visible (not Hidden).
  2. *M* is an Active `discount_threshold` monitor and is in
     `p.monitor_ids` after this import. `best_match` monitors never alert.
  3. *o* is a snapshot inserted by this import and is *p*'s latest
     observation.
  4. *o* has a reliable Discount *d* and *d* ≥ *T*, using *T* at detection
     time.
  5. **Crossing:** the previous priced observation was below *T*; or **new
     best:** ⌊*d*⌋ is above the highest ⌊discount⌋ in the current Qualifying
     episode before *o*.
- **Earlier observations.** A priced observation (current price and currency
  known) uses its Discount, or 0% when no discount was detected or the
  Discount is 0. Observations with no price, or with a Discount below 0 or at
  least 100, are skipped. A product with
  no earlier priced observation does not alert, so the baseline comes from
  stored history: there is no alert at go-live or right after Watch.
- **Example** (*T* = 20): 15 → 20 → 20 → 25 → 25 → 10 → 20 alerts on the
  second, fourth, and seventh observation (crossing, new best, crossing).
- **Historical-low candidate.** A
  [watched historical-low event](#watched-historical-low-event) for *p* on
  *o*: Watched, visible, Zalando, *o* inserted by this import and *p*'s latest
  observation, with a price at or below every earlier comparable price and
  below the previous one. It needs no monitor membership and no Discount. It
  is detected whether or not a threshold candidate exists for the same
  observation, and threshold candidates are detected whether or not it exists
  (the P4(ii) suppression of #81 was removed in #89).
- **One message per observation.** Each monitor is detected on its own. One
  Slack message is sent per product and observation, listing every reason:
  the historical low with its drop percentage first, then every monitor that
  triggered and why. It shows the observation's price, its Discount when
  reliable, and the stored Overall when an evaluation exists.
- **Detection.** One snapshot-history query per import, next to the watched
  historical-low detection, over Watched, visible products in Active
  `discount_threshold` monitors that received a new snapshot with a reliable
  Discount. Rows go to `watched_alerts` (migrations 031 and 032) with
  `ON CONFLICT DO NOTHING`: threshold rows are unique per (product, monitor,
  snapshot), and `historical_low` rows, which have no monitor, threshold, or
  Discount and store the drop percentage, are unique per (product, snapshot).
  An import retry adds nothing. Threshold and historical-low rows are recorded
  independently, so a failure in one is logged and does not lose the other.
- **Delivery.** `deliverPendingWatchedAlerts` (`lib/watched-alerts.mts`) runs
  right after detection in the import route and again after the Daily summary
  (the Workflow step after the evaluation-run finalizer, or the import route's
  no-candidate path). It claims the pending rows of one product and
  observation with a lease and token, sends with a client_msg_id derived from
  the product and snapshot, and marks them sent. A failed send releases the
  claim, and a later delivery retries it. A pending alert is expired instead
  of sent once it no longer holds (P5(b)). The product must still be Watched
  and visible. For a threshold alert, the product must also still qualify:
  the monitor is still an Active `discount_threshold` monitor that lists the
  product, and the product's current reliable Discount is at or above the
  current threshold. For a historical-low alert, the product's current price
  must not be higher than the alerted observation's price, in the same pair
  the detection compared (the source pair when the observation has a source
  price, otherwise the normalized pair) and the same currency; an unknown
  price or a different currency expires it. An expired reason is left out of
  the message; the other reasons of the observation are still sent.
- **Failures.** A detection or delivery failure in the import route is logged
  and never fails the import. In the Workflow step, an alert failure makes
  the step throw only after the Daily summary was attempted, so the step's
  retries try again.

## Removed: Like / Not for me

Like / Not for me feedback was removed in #66, following the #61
investigation. It had no recommendation, ranking, or visibility role; its only
remaining use was as secondary examples in the Gemini evaluation prompt. The
written preference profile is the only Preference signal. There is no Liked
price-drop rule.

## Removed: per-source recommendations

The per-source recommendations were removed in #90 (design D14 Phase 7,
P7(b)), after the Daily summary had run in parallel with them since #80. Until
then, the per-import message carried up to two entries, "Zalando
recommendation" and "Vinted recommendation": for each source, the visible
product evaluated in that import with the highest unrounded Overall score,
provided it was at least 7 (`selectZalandoFallbackRecommendation` and
`selectVintedRecommendation`, removed). An import that evaluated nothing had
no recommendation. Since #89, a watched historical-low event was already a
Watched alert reason rather than a Zalando recommendation step.

The per-import message now has only the summary line and, when there are
warnings, the scan-warning block, both in the evaluation-run finalizer and in
the import route's no-candidate path. Stored evaluations, price history, user
state, and alert rows are unchanged, and `evaluation_runs.watched_historical_lows`
is still written as a diagnostic record that nothing reads.

## Implementation status

| Slice | Issue | Scope |
| --- | --- | --- |
| 1 | #57 | This specification; characterization tests of current behavior |
| 2 | #58 | Vinted recommendation; per-source Slack output |
| 3 | #59 | Zalando watched historical-low event |
| 4 | #60 | Zalando fallback |
| 5 | #61 | Reassess Like / Not for me (investigation) |
| 6 | #66 | Remove Like / Not for me |
| S7b | #90 | Remove the per-source recommendations; operational-only per-import message |

#58 changed the Slack message from one highlight to up to two (one per
source). #59 added the Zalando watched historical-low step. #60 replaced the
interim Zalando rules (the Watched/Liked/generic price-drop tiers for imports
without evaluation candidates, and the highest rounded Overall without a
threshold for imports with them) with the Zalando fallback. #89 (S7a of the
monitor recommendation design) moved the watched historical-low event from
Zalando step 1 to a Watched alert reason, leaving the fallback as the only
Zalando recommendation. #90 (S7b) removed the Zalando fallback and the Vinted
recommendation, so the Daily summary is the only Recommendation (see
[Removed: per-source recommendations](#removed-per-source-recommendations)).
