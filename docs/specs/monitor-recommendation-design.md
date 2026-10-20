# Monitor-Driven Recommendations and Alerts: Design

> Status: **Proposed.** This is the Phase 1 design for #72, written for #74. It
> needs human architecture review before any Phase 2+ work starts (the #72
> review gate). It changes no code, migration, configuration, feed, Slack
> message, or Gemini prompt in either repository.

## How to read this document

- Each statement about current behavior is marked **Verified** and gives a
  file reference. Each statement about future behavior is marked
  **Proposed**. Text without a marker is explanation.
- DealRadar paths are relative to this repository at `9883f4c`. Deals paths
  start with `deals/` and refer to `runethorbek/deals` at `a52e9b7`.
- The published feeds `deals/public/deals/*-latest.json` were used for
  structure only. Their counts may be out of date.
- Domain terms follow `docs/ubiquitous-language.md`. Terms this design adds
  or changes are listed in [Terminology](#15-terminology) and are flagged
  there for review.
- Product decisions are not made here. They are listed in
  [Open product decisions](#11-open-product-decisions) as options with a
  recommendation. Where a design decision depends on one, it says so.

Where each item of #72 §13 "Output" is covered:

| #72 §13 Output item | Section |
| --- | --- |
| Current architecture | [2](#2-current-architecture) |
| Identified coupling | [3](#3-identified-coupling) |
| Proposed architecture, responsibility boundaries, data flow | [4](#4-proposed-architecture) |
| Configuration examples, proposed contracts | [D1](#d1-monitor-recommendation-configuration-schema), [D2](#d2-cross-repository-publication-contract), [D6](#d6-recommendation-strategy-interfaces), [6](#6-configuration-examples-and-contracts-at-a-glance) |
| Important invariants | [7](#7-invariants) |
| Trade-offs | [8](#8-trade-offs) |
| Known risks | [9](#9-known-risks) |
| Open product decisions | [11](#11-open-product-decisions) |
| Rollout strategy | [12](#12-cross-repository-rollout) |
| Proposed child issues | [13](#13-proposed-child-slices) |
| Verification strategy | [14](#14-verification-strategy) |
| The 16 required design decisions | [5](#5-design-decisions) (D1–D16) |
| The three investigation questions from #74 | [1](#1-investigation-answers) |

---

## 1. Investigation answers

### Q1. Is Deals' `minDiscountPercent` used in query construction, product filtering, or both?

**Neither, for the products DealRadar imports. Verified.** The value only
marks a subset of products as `matches`, and DealRadar does not read
`matches`.

- **Not in query construction. Verified.** `createZalandoScanPlan` builds the
  listing URLs only from `listingPath` and the page parameter `p`.
  `minDiscountPercent` is copied into the plan but never put into a URL
  (`deals/scripts/lib/zalando-monitor.ts:112-131`). The Vinted URL builder has
  no discount parameter (`deals/scripts/lib/vinted-monitor.ts:87-102`).
- **Not used to filter published `products`. Verified.** Every recognized
  product goes into `productMap`. The threshold only adds the URL to
  `matchingProductUrls` (`deals/scripts/scan-zalando.ts:853-885`).
  `products` is all of `productMap` (`:906-912`), and `matches` is the
  filtered subset (`:914`). Both are published (`:951-954`). The scanner test
  confirms this: two monitors with `minDiscountPercent: 30` publish 3
  products and 2 matches (`deals/test/zalando-scan.test.ts:630-662`).
- **Other uses. Verified.** The threshold is echoed in
  `monitors[].min_discount_percent` and in the legacy single-monitor scalar
  `min_discount_percent` (`deals/scripts/scan-zalando.ts:893-902`, `:944-947`).
  It drives `debug.products_below_minimum_discount` (`:961-964`) and
  `scan_status.published_product_count = matches.length` (`:916-920`). The
  output validator checks that `matches` equals the products that meet some
  monitor's threshold (`:715-737`).
- **DealRadar reads `products` only. Verified.** `validateFeed` and
  `normalizeProducts` iterate `payload.products`
  (`app/api/import-deals/route.ts:118-122`, `:211`). `matches` and
  `monitors` are never read.

**Consequence.** A `discount_threshold` below 30% is not blocked by the
current `filters.minDiscountPercent: 30` in either Zalando monitor
(`deals/config/monitors.json:22-43`). DealRadar already receives Zalando
products with discounts below 30%, and products with no discount. Two
caveats:

1. A retailer-side filter inside `listingPath` (such as a sale-only path)
   would restrict collection. The two current paths filter only by brand,
   size, and material (`deals/config/monitors.json:27`, `:38`). **Verified.**
2. Collection is limited to `pages` listing pages, 1–10
   (`deals/scripts/lib/zalando-monitor.ts:100-103`). **Verified.** Retailer
   sort order therefore decides which discounted products are collected at
   all. This is a scraping concern and does not change here.

### Q2. Does DealRadar's import validation accept, ignore, or reject unknown or additional feed fields?

**It accepts them. Unknown top-level fields are ignored. Unknown product
fields are stored unchanged in `raw_data`. Neither is rejected. Verified.**

- **Top level. Verified.** `validateFeed` checks only that the feed is an
  object, that `products` is an array, that `site` matches, that
  `product_count` (if present) equals `products.length`, and that product
  URLs are valid and unique (`app/api/import-deals/route.ts:112-179`). Other
  top-level fields are not read, except `scan_status`, which is parsed
  leniently (`lib/import-notification.mts:142-188`), and `checked_at`,
  `target_size`, and `target_size_id`, which are fallbacks
  (`route.ts:240-244`, `:279`).
- **Product level. Verified.** `normalizeProducts` reads named fields only
  (`route.ts:224-279`) and stores the whole product object as `raw_data`
  (`route.ts:280`; `lib/import-persistence.mts:86`, `:101`). Unknown product
  fields are therefore kept but not interpreted. The import contract says
  this explicitly: "Unknown additive fields are tolerated"
  (`docs/import-contract.md:76-77`).
- **Files. Verified.** The importer fetches only `zalando-latest.json` and
  `vinted-latest.json` (`route.ts:39-54`, `:287-301`). Any other file
  published by Deals is not fetched.
- **Limits. Verified.** These are rejected or skipped:
  - changing `site`, `products`, `product_count`, or product `url`, which
    fails the whole import (`route.ts:112-179`);
  - a malformed current-price field, which skips that product
    (`route.ts:181-190`, `:231-234`);
  - a non-object product or a product without a usable title, which is
    dropped (`route.ts:215-238`).

  Changing the type of an existing field such as `monitor_ids` would also
  change dashboard and evaluation behavior (`lib/dashboard-product-query.mts:66-79`;
  `lib/product-evaluation.ts:199-221`).
- **Test coverage gap. Verified.** No DealRadar test pins tolerance of
  unknown top-level or product fields. Searching `tests/` finds none. This
  design proposes such a test before Deals publishes new fields (slice S1).

**Consequence for Phase 2.** A Deals change that adds a new file, adds
top-level fields, adds fields inside `monitors[]`, or adds product fields can
deploy before DealRadar, because the current importer does not break. The
only conditions are that the change keeps `site`, `products`,
`product_count`, `url`, the current-price fields, and `monitor_ids`
unchanged. The recommended contract (D2) is a separate file. The current
importer does not fetch it at all.

### Q3. Which price, discount, currency, and timestamp fields are reliable for discount calculation and freshness?

**Verified facts:**

| Field (DealRadar column) | Comes from | Reliability for this design |
| --- | --- | --- |
| `products.discount_percent`, `product_snapshots.discount_percent` | Feed `discount_percent` via `optionalNumber` (`route.ts:95-106`, `:276`), `NUMERIC(5,2)` (`migrations/001_initial_schema.sql`) | **Usable for Zalando when `current_price` and `currency` are also present.** Deals sets it in three ways (`deals/scripts/lib/zalando-price.ts:76-170`): computed from a labelled or inferred original/current pair and rounded to 0.1 (`calculated-from-prices`, `:142-158`); the retailer-displayed discount with one price (`explicit-discount`, `:118-129`); or the displayed discount with **no** price (`explicit-discount-no-price`, `:131-139`). The last case always has `current_price: null`, so requiring a current price excludes it. DealRadar does not range-check the value: a numeric string, a negative value, or a value over 100 is stored as is. A value of 1000 or more would overflow `NUMERIC(5,2)` and fail the import transaction. Vinted feeds have no discount (`deals/docs/output-contract.md:121-143`). |
| `products.original_price` | Feed `original_price` via `optionalNumber` (`route.ts:228`) | **Not independent evidence.** In the `explicit-discount` case Deals derives it from the discount (`zalando-price.ts:121`). The producer contract says it is only comparable when it is above the current price (`deals/docs/output-contract.md:206`). Use it for display only. Do not recompute the discount from it. |
| `products.current_price` / `products.currency` | Feed `current_price` (Zalando) or `price` (Vinted), and `currency` (`route.ts:227-229`, `:256-263`) | **Reliable as source values.** They are validated as finite and non-negative, or null (`route.ts:181-190`). Despite the "normalized" column names, they hold the source price and currency without conversion. Zalando currency is `DKK` or null, and it is null exactly when `current_price` is null (`deals/scripts/scan-zalando.ts:704-707`). Vinted currency is `DKK`, `EUR`, `USD`, or null (`deals/docs/output-contract.md:140`). |
| `source_current_price`, `source_original_price`, `source_currency` | Always `null` on current imports (`route.ts:256-263`) | **Not usable.** They exist (`migrations/006_source_prices.sql`) but are never populated, so the existing source-pair branches never apply to new data. |
| `products.available` | Zalando `available: true` on every product (`deals/scripts/scan-zalando.ts:557`). For Vinted DealRadar defaults to `true` (`route.ts:246-254`). | **Not a signal.** It is always true. A product's presence in a recent scan is the only availability evidence. |
| `products.last_seen_at` | Product `checked_at` (falling back to snapshot `checked_at`, then import time), overwritten on every upsert (`route.ts:196-204`, `:279`; `lib/import-persistence.mts:84-85`, `:100`) | **Reliable as "time of the scan that last contained this product"**, because Deals sets every product's `checked_at` to the scan's `checked_at` (`deals/scripts/scan-zalando.ts:698`; `deals/scripts/scan-vinted.ts:614`, `:822`). Re-importing an unchanged feed keeps the old value, so a failed scan is not mistaken for a fresh one. Two caveats: importing an **older** ref moves it backwards, and an invalid timestamp falls back to the import time (`route.ts:203`). |
| `products.first_seen_at` | Set on insert only (`lib/import-persistence.mts:84`) | Reliable as the first observation time. |
| `product_snapshots.observed_at` | One row per `(product_id, observed_at)`, `ON CONFLICT DO NOTHING` (`migrations/002_harden_import_snapshots.sql`; `lib/import-persistence.mts:116-144`) | **Reliable for transitions.** Re-importing the same scan inserts nothing. Snapshots also store `discount_percent`, `current_price`, and (since `010`) `currency`. Older snapshots may have a null currency (`migrations/010_snapshot_currency.sql`). |
| `product_evaluations.evaluated_at` | One row per product, the latest evaluation only (`migrations/005_product_evaluations.sql`) | Reliable as the time of the current evaluation. There is no evaluation history. |
| Feed `monitors[]` and feed `checked_at` | `deals/scripts/scan-zalando.ts:893-902`, `:948`; `deals/scripts/scan-vinted.ts:922-929`, `:942` | **Reliable evidence of which monitors were scanned, and when.** DealRadar does not read them today. `monitors[]` contains only the monitors that were enabled when the scan ran (`deals/scripts/scan-zalando.ts:778-791`). |

**Proposed** use of these fields is in [D7](#d7-freshness-and-availability-rules)
and [D8](#d8-discount-calculation).

---

## 2. Current architecture

All statements in this section are **Verified**.

### 2.1 Deals

- **Monitor configuration** is a JSON array in `deals/config/monitors.json`
  with four enabled monitors: two Vinted and two Zalando. The envelope
  validator requires `id` (unique, at most 100 characters), `source`
  (`vinted` or `zalando`), a boolean `enabled`, and an object `filters`. It
  does not reject other keys (`deals/scripts/lib/monitor-config.ts:16-22`,
  `:37-48`, `:50-78`). Source validators check source-specific fields and
  also ignore unknown keys. All monitors, including disabled ones, are
  validated on every load (`deals/scripts/lib/validated-monitor-loader.ts:31-59`;
  `deals/scripts/lib/zalando-monitor.ts:74-110`, `:134-138`;
  `deals/scripts/lib/vinted-monitor.ts:26-42`).
- **Enable and disable.** Each source workflow first runs
  `scripts/monitor-enabled.ts <source>`. If no monitor for that source is
  enabled, the scan step and the commit step are skipped
  (`deals/scripts/monitor-enabled.ts`; `deals/.github/workflows/daily-vinted.yml`;
  `deals/.github/workflows/daily-zalando.yml`). The previously committed
  feed then stays in place.
- **Schedules.** Vinted scans at 02:40 UTC, Zalando at 03:37 UTC, and a
  separate workflow imports into DealRadar once a day at 05:00 UTC. It calls
  `POST /api/import-deals?ref=<sha of main>`
  (`deals/.github/workflows/daily-*.yml`).
- **Feeds.** Each source has one atomic snapshot that covers all of its
  enabled monitors. Each product has sorted, unique `monitor_ids` that must
  reference that snapshot's `monitors[]`
  (`deals/scripts/scan-zalando.ts:677-692`; `deals/scripts/scan-vinted.ts:744-753`).
  A failed or implausible scan keeps the last known-good feed
  (`deals/docs/output-contract.md:33-39`). A degraded scan can publish, with
  `scan_status.failures` (`deals/docs/output-contract.md:41-55`). A Zalando
  product URL found through two target sizes fails the scan
  (`deals/docs/output-contract.md:175-177`).
- **Contract policy.** Additive, source-specific metadata is preferred.
  "Do not introduce contract-version negotiation unless concurrent
  incompatible versions are actually needed"
  (`deals/docs/output-contract.md:224-229`).

### 2.2 DealRadar import and persistence

- One import fetches both feeds at the exact ref and validates them. A
  validation failure fails the whole import before anything is persisted
  (`app/api/import-deals/route.ts:342-352`). It then normalizes the
  products and upserts all of them, with their snapshots, in one
  `sql.transaction` (`route.ts:353-370`; `lib/import-persistence.mts:213-223`).
- Products are identified by `(source, external_url)`. On conflict, every
  current field is overwritten, including `raw_data` and `last_seen_at`
  (`lib/import-persistence.mts:88-101`).
- **Monitor membership exists only inside `raw_data.monitor_ids`.** It is
  read by the dashboard monitor filter
  (`lib/dashboard-product-query.mts:59-83`, `:134`, `:189`, `:248`), and for
  Vinted it is passed to Gemini as non-authoritative context
  (`lib/product-evaluation.ts:199-221`, `:278-284`, `:312`;
  `docs/import-contract.md:49-50`). No table stores monitor definitions.
- Hidden and Watched are booleans on `products`
  (`migrations/007_product_visibility.sql`; `migrations/008_product_watch.sql`).

### 2.3 Evaluation

- Candidates are new or price-changed products
  (`lib/import-evaluation.mts:262-317`; `lib/import-persistence.mts:161-179`).
  Vinted candidates also pass condition and brand preselection. The ordered
  list is capped by `automaticEvaluationLimit` (default 50), and candidates
  beyond the cap are not queued (`docs/architecture.md`, "Evaluation
  prioritization policy").
- Selected candidates are persisted as an `evaluation_runs` row plus
  `evaluation_run_candidates` rows and processed in durable batches by a
  Vercel Workflow adapter
  (`lib/evaluation-runs.mts:127-188`; `workflows/evaluation-run-orchestration.ts`;
  `docs/adr/0001-vercel-workflow-platform-boundary.md`).
- `product_evaluations` holds one current evaluation per product, with
  `preference_score`, `deal_score`, `reason`, `evaluated_at`, and
  `translated_listing_text_da`
  (`migrations/005_product_evaluations.sql`; `migrations/023_evaluation_translated_listing_text.sql`).
  Overall score is computed when needed, using `preferenceWeightPercent`
  (`lib/ranking-settings.mts:28-35`).

### 2.4 Recommendations and Slack

- The rules are in `docs/recommendation-policy.md`. There is at most one
  recommendation per source per import. Vinted gets the highest Overall
  score of at least 7 among products evaluated in this import. Zalando gets a
  watched historical-low event first, then the same Overall-based fallback.
- Code:
  - `selectVintedRecommendation` and `selectZalandoFallbackRecommendation`
    (`lib/import-notification.mts:241-286`);
  - `findWatchedHistoricalLows`, `loadWatchedHistoricalLowCandidates`, and
    `selectWatchedHistoricalLowRecommendation` (`lib/watched-historical-low.mts:123-302`);
  - finalization (`lib/evaluation-finalization.mts:36-89`).
- Watched historical-low events are detected at import time from the
  inserted snapshots (`route.ts:386-400`). They are stored on the run
  (`migrations/026_evaluation_run_watched_historical_lows.sql`) or, when no
  run exists, used directly (`route.ts:439-444`).
- One Slack message per import combines the import counts, up to two
  recommendations, and any scan warnings
  (`lib/import-notification.mts:308-360`). It is sent by the finalizer when
  there is a run (`lib/evaluation-finalization.mts:80`), and otherwise
  directly by the import route (`route.ts:447-455`).

### 2.5 Reliability mechanisms

- **Candidate claims and recovery.** Candidates are claimed with
  `FOR UPDATE SKIP LOCKED`, and a processing claim expires after 15 minutes
  (`lib/evaluation-runs.mts:246-305`).
- **Launch claims.** A launch claim expires after 5 minutes, and pending
  launches are resumed on the next import
  (`lib/evaluation-runs.mts:206-244`; `workflows/evaluation-run-orchestration.ts`;
  migrations `021`, `022`).
- **Notification claim.** The claim is a 15-minute lease with a claim token
  and a deterministic `client_msg_id`, derived from the run ID with `md5`.
  It is marked sent only with the matching token and released on failure
  (`lib/evaluation-runs.mts:369-421`; `lib/evaluation-finalization.mts:41-87`;
  migrations `017`–`020`; `lib/slack.ts:15-46`).
- **Gaps.**
  - The no-candidate import path posts to Slack with no claim and no
    `client_msg_id` (`route.ts:447-455`), so a retried import posts again.
  - Nothing is keyed by calendar day.
  - `evaluation_runs.import_ref` is not unique (`migrations/013_evaluation_runs.sql`).
    However, repeating an import of the same ref inserts no snapshots and
    therefore selects no candidates (`lib/import-persistence.mts:142`,
    `:161-179`).

### 2.6 Scheduling

There is no `vercel.json` and no cron configuration in this repository. The
only durable execution is the Vercel Workflow for evaluation runs
(`next.config.ts`; `workflows/evaluation-run-orchestration.ts`). DealRadar's
work is started only by the daily import call from Deals
(`deals/.github/workflows/daily-dealradar-import.yml`). **Verified.**

---

## 3. Identified coupling

All items are **Verified** facts. Their consequences shape the proposal.

1. **Recommendation is coupled to one evaluation run.** Overall-based
   candidates are exactly the products evaluated in this import
   (`lib/evaluation-finalization.mts:51-65`; `lib/import-notification.mts:241-269`).
   A strong product evaluated yesterday cannot be recommended today. #72 §7
   requires the opposite.
2. **Policy is selected by source constant.** `vintedSource` and
   `zalandoSource` are hard-coded (`lib/import-notification.mts:31-32`). The
   import route has a fixed list of two sources (`route.ts:39-54`). Monitors
   play no part.
3. **One Slack message combines three concerns:** operational import counts,
   recommendations, and scan warnings (`lib/import-notification.mts:308-360`).
4. **Watched event detection runs inside the import route** and is carried
   through `evaluation_runs` as JSON (`route.ts:386-423`;
   `lib/evaluation-finalization.mts:72-77`).
5. **Monitor membership is non-authoritative `raw_data`**
   (`docs/import-contract.md:47-50`). It is read in three places, each with
   its own parsing (`lib/dashboard-product-query.mts`; `lib/product-evaluation.ts`).
6. **Deals mixes scraping and recommendation intent in one field.**
   `filters.minDiscountPercent` defines `matches`, which no consumer reads
   (Q1).
7. **Monitor lifecycle and scan health stay in the feeds.** DealRadar does
   not persist `monitors[]` or feed `checked_at`. A disabled source's old
   feed is imported again every day unchanged (2.1).
8. **Notification idempotency is per evaluation run only** (2.5).

---

## 4. Proposed architecture

**Proposed.** The repositories stay as they are. There is no new service,
no queue, and no rules engine.

### 4.1 Responsibility boundaries

| Responsibility | Owner | Module (proposed) |
| --- | --- | --- |
| What to scrape, filters, pages, schedules | Deals | `config/monitors.json`, scanners (unchanged) |
| Recommendation strategy and threshold per monitor, display name | Deals | `config/monitors.json` → `recommendation`, `displayName` |
| Validating and publishing the monitor recommendation contract | Deals | new generator and validator script, CI check |
| Validating and persisting the contract; monitor lifecycle | DealRadar import | new `lib/monitor-definitions.mts`, called from the import route |
| Product–monitor membership | DealRadar import | `products.monitor_ids` (D5) |
| Gemini evaluation (unchanged) | DealRadar evaluation | existing modules |
| Qualification, counting, ranking, selection per monitor | DealRadar recommendation policy | new pure `lib/monitor-recommendation.mts` and a separate loader query |
| Watched alert detection and alert state | DealRadar alert detection | new `lib/watched-alerts.mts` |
| Daily summary assembly and idempotent delivery | DealRadar notification | new `lib/daily-summary.mts`, existing `lib/slack.ts` |
| Slack formatting | DealRadar notification | formatter functions only; no policy |

Vercel Workflow stays an adapter. None of the new modules may import
Workflow APIs (`docs/adr/0001-vercel-workflow-platform-boundary.md`).

### 4.2 Data flow

```text
DEALS (one commit on main)
  config/monitors.json ── generator + CI check ──> public/deals/monitor-recommendations.json   (new, D2)
  scanners (unchanged) ─────────────────────────> public/deals/{vinted,zalando}-latest.json   (unchanged)
  daily-dealradar-import.yml ── POST /api/import-deals?ref=<sha>
                                   │
DEALRADAR                          v
  Import (one exact ref)
    fetch both feeds (required) + monitor-recommendations.json (optional)
    validate ── one transaction ──> products, product_snapshots,
                                    products.monitor_ids, monitor_definitions (+ scan evidence)
    detect events from inserted snapshots ──> watched historical-low (existing), Watched alerts (new)
    select evaluation candidates (unchanged) ──> evaluation run (unchanged)
    deliver pending Watched alerts (non-fatal; D13)
  Workflow: finalize step (unchanged legacy message) ──> NEW separate step: daily summary + pending alerts
  No-candidate path: legacy message ──> daily summary + pending alerts, called directly (non-fatal)
  Daily summary:  load active monitor definitions + fresh members + stored evaluations
                  ──> pure policy (qualify, count, rank, select) ──> format ──> Slack
  Watched alerts: pending alert rows ──> format ──> Slack (claimed, idempotent)
```

---

## 5. Design decisions

### D1. Monitor recommendation configuration schema

**Recommendation (Proposed).** Add two optional keys to each monitor in
`deals/config/monitors.json`: `displayName` and `recommendation`.
`recommendation` is a small tagged object with one strategy-specific
threshold:

```json
{
  "id": "zalando-scarosso-shoes-42",
  "source": "zalando",
  "enabled": true,
  "displayName": "Zalando – Scarosso shoes",
  "filters": {
    "listingPath": "/herresko/scarosso__stoerrelse-42/",
    "targetSize": "42",
    "minDiscountPercent": 30
  },
  "pages": 2,
  "recommendation": {
    "strategy": "discount_threshold",
    "minimumDiscountPercent": 20
  }
}
```

```json
{
  "id": "vinted-mens-pants-size-46",
  "source": "vinted",
  "enabled": true,
  "displayName": "Vinted – trousers",
  "filters": { "catalogIds": ["34"], "sizeIds": ["1637"] },
  "pages": 3,
  "recommendation": {
    "strategy": "best_match",
    "minimumOverallScore": 7
  }
}
```

The values are illustrative, as in #72 §3, and are not migration defaults.

Validation rules (Proposed):

- `recommendation` is optional during rollout. If it is absent, the monitor
  is **unconfigured**: it is published with `recommendation: null` and gets
  no monitor recommendation in DealRadar. No default strategy is inferred,
  so no arbitrary rules are applied silently (#72 §5).
- `strategy` must be `discount_threshold` or `best_match`. Any other value
  is rejected.
- `discount_threshold`:
  - `minimumDiscountPercent` must be an integer from 1 to 99;
  - it is allowed only for `source: "zalando"`, because Vinted feeds carry
    no discount (Q3).
- `best_match`: `minimumOverallScore` must be a finite number from 0 to 10
  with at most one decimal.
- Unknown keys inside `recommendation` are rejected, to catch typos.
- `displayName` is optional. If present, it must be a trimmed string of 1–80
  characters. DealRadar shows the monitor ID when it is absent.
- `filters.minDiscountPercent` stays as it is. There is **no** validation
  rule linking it to `minimumDiscountPercent`, because it does not limit
  collection (Q1). What happens to it is open decision
  [P11](#p11-fate-of-deals-filtersmindiscountpercent-and-matches).
- **Recommendation validation runs in the contract generator and in Deals
  CI, not in the scanner validators.** The scanners keep ignoring the new
  keys (2.1). An invalid `recommendation` blocks merging and publishing the
  contract, but it can never stop a scrape.

**Alternatives considered.**

- (a) A separate `config/recommendations.json` keyed by monitor ID. This
  splits one monitor across two files, so a monitor can be removed from one
  and not the other. It breaks #72 §3: "remain close to the configured
  import".
- (b) Validating `recommendation` inside the existing per-source validators.
  An invalid threshold would then fail the daily scan at the
  `monitor-enabled.ts` step, which couples scraping to recommendation
  policy.
- (c) A generic `rules: [{field, op, value}]` list. This is a rules engine,
  which #72 §4 forbids.
- (d) A default strategy when `recommendation` is missing, such as
  `best_match ≥ 7`. This applies rules silently.

**Rationale.** This is the smallest explicit schema. Changing what a monitor
searches for and what qualifies happens in the same object. Adding a
strategy later is one new tagged variant in Deals validation and one in
DealRadar policy (#72 §17).

### D2. Cross-repository publication contract

**Recommendation (Proposed): option B.** Deals publishes a separate,
versioned document, `public/deals/monitor-recommendations.json`. It is
generated deterministically from `config/monitors.json` by a Deals script
and committed in the same change as the configuration. A Deals CI test fails
if the committed file differs from the generator output.

```json
{
  "contract_version": 1,
  "monitor_count": 4,
  "monitors": [
    {
      "id": "vinted-mens-blazers-size-s",
      "source": "vinted",
      "display_name": "Vinted – blazers",
      "enabled": true,
      "recommendation": { "strategy": "best_match", "minimum_overall_score": 7 }
    },
    {
      "id": "zalando-scarosso-shoes-42",
      "source": "zalando",
      "display_name": "Zalando – Scarosso shoes",
      "enabled": true,
      "recommendation": { "strategy": "discount_threshold", "minimum_discount_percent": 20 }
    }
  ]
}
```

Contract rules (Proposed):

- It contains **all** configured monitors, sorted by `id`, including
  disabled ones (`enabled: false`). A **removed** monitor is one that is
  absent from the document.
- `source` uses the Deals monitor source values, `vinted` and `zalando`.
  DealRadar maps them to its source values, `vinted.com` and `zalando.dk`
  (`lib/import-notification.mts:31-32`).
- It contains no URLs, filters, pages, selectors, or timestamps. With no
  timestamps the output is deterministic and changes only when the
  configuration changes.
- Keys are snake_case, like the existing feeds.
- DealRadar fetches it from the **same exact ref** as the feeds. One commit
  therefore gives a consistent set of definitions and observations.

**Alternatives considered.**

- **A. Embed `recommendation` in each feed's `monitors[]`.** It is atomic
  with that source's products, but it is rejected for these reasons:
  - `monitors[]` contains only the monitors enabled when the scan ran
    (Q3), so a disabled or removed monitor cannot be expressed;
  - a source with every monitor disabled is never rescanned, so its old
    feed keeps advertising its monitors every day (2.1);
  - a threshold change takes effect only after the next successful scan,
    and a failed scan keeps the old definition.

  The per-source output validators would not block this option, because
  they check named fields and do not reject extra ones
  (`deals/scripts/scan-zalando.ts:604-631`). **Verified.**
- **C. DealRadar reads `config/monitors.json` directly.** The internal
  scraper configuration would become a public contract, and DealRadar would
  depend on retailer filter details (#72 §5, §15).
- **D. A DealRadar-side monitor settings UI.** This would duplicate
  monitor configuration in two places and move ownership away from Deals
  (#72 §3, §10).
- **E. A synchronization service or API.** This is unnecessary
  infrastructure (#72 §5).

**Rationale.** Option B separates monitor lifecycle from scan success: a
disabled monitor is known as disabled even when its source is not scanned.
It reuses the exact-ref import, so no new trigger, service, or credential is
needed. The current importer does not fetch the file, so Deals can ship it
first (Q2). Scan health stays a separate signal, taken from the existing feed
`monitors[]` and `checked_at` (D4, D7).

### D3. Contract versioning and compatibility

**Recommendation (Proposed).** Use one integer `contract_version`, starting
at 1, with no negotiation. Additive optional fields do not change the
version, and DealRadar ignores unknown keys within a known version. A
breaking change uses a new version, and DealRadar must support that version
before Deals publishes it. In every case below, a problem with this optional
document never fails the product import. That follows the "optional
enrichment" rule in `AGENTS.md`.

| Situation | DealRadar behavior (Proposed) |
| --- | --- |
| Older Deals ref without the document (HTTP 404) | Persisted definitions are unchanged. If none exist, monitor recommendations are off and only legacy behavior runs. No warning. |
| Other fetch failure (5xx or network) | Definitions unchanged. An operational warning is logged and shown in the daily summary. |
| Unknown `contract_version` | Document ignored as a whole, definitions unchanged, warning. |
| Invalid document (malformed JSON, `monitor_count` mismatch, duplicate ID, invalid definition) | **The whole document is rejected**, definitions unchanged, warning. A partially applied set of definitions is never written. |
| Product with a monitor ID that has no definition | Membership stored. The product is not part of any monitor recommendation. The count of such IDs appears in import diagnostics. |
| Monitor `enabled: false` | Definition kept with `enabled = false`. No daily recommendation and no Watched alerts for it. |
| Monitor absent from a valid document (removed) | Row kept, `removed_at` set. Same effect as disabled. History, evaluations, and snapshots are untouched. If it appears again, `removed_at` is cleared. |
| Renamed monitor (`id` changes) | Treated as removal plus a new monitor. IDs must be stable. Changing only `display_name` is an in-place update. |
| Monitor changes strategy or threshold | Definition updated in place. It takes effect for the next daily summary and the next alert detection (see D12 for alert state). |
| Partially completed publication | Not possible within one ref: the document is one file in one commit, and DealRadar reads one exact ref. |
| Partially completed import | Definitions are written in the same `sql.transaction` as products and snapshots (`lib/import-persistence.mts:213-218`), so they commit or roll back together. |
| Configuration changes during an import | Not visible to the import: everything comes from one ref. The daily summary reads persisted state once at summary time. |
| Importing an older ref after a newer one | **The latest import is the truth**, which is today's semantics for product data (R1). A valid document from an older ref replaces the stored definitions, and `definition_ref` records which ref they came from. No commit-order guard is added. Rationale: production always imports the HEAD of Deals `main` (`deals/.github/workflows/daily-dealradar-import.yml:24`, **Verified**), so an older ref can only come from a manual call. The operator repairs that by importing `main` again. A guard would need the Deals commit time, which a raw-content fetch does not return (R6). Scan evidence is guarded separately with `GREATEST` (D4), because it uses feed timestamps rather than commit order. |

**Alternatives considered.**

- Semver strings, or accepting any version with best-effort parsing.
- Per-monitor acceptance, which skips invalid monitors and applies the rest.
- Failing the import on an invalid document.

**Rationale.** The Deals contract discourages version negotiation
(`deals/docs/output-contract.md:228-229`), while #72 asks for a versioned
contract. One integer with a "consumer first" rule meets both. Rejecting the
whole document keeps definitions consistent. Not failing the import protects
valid product data.

### D4. Persistence model for monitor definitions

**Recommendation (Proposed).** Add one new table, `monitor_definitions`,
with one row per monitor ID. Nothing is ever deleted.

| Column | Meaning |
| --- | --- |
| `monitor_id TEXT PRIMARY KEY` | Stable Deals monitor ID |
| `source TEXT NOT NULL` | DealRadar source value (`zalando.dk`, `vinted.com`) |
| `display_name TEXT` | Optional |
| `enabled BOOLEAN NOT NULL` | From the contract |
| `strategy TEXT` | `discount_threshold`, `best_match`, or `NULL` (unconfigured); enforced by `CHECK` |
| `minimum_discount_percent NUMERIC(5,2)` / `minimum_overall_score NUMERIC(4,2)` | Exactly one is set, matching `strategy` (`CHECK`) |
| `contract_version INTEGER NOT NULL`, `definition JSONB NOT NULL` | The validated published object, kept for diagnostics |
| `definition_ref TEXT NOT NULL` | Deals commit SHA the definition came from |
| `first_seen_at`, `updated_at TIMESTAMPTZ NOT NULL`, `removed_at TIMESTAMPTZ` | Lifecycle |
| `last_scan_checked_at TIMESTAMPTZ`, `last_scan_ref TEXT` | Scan evidence: the feed `checked_at` of the latest imported feed whose `monitors[]` listed this monitor. Updated with `GREATEST` so an older ref cannot move it backwards. Parsed leniently, like `scan_status`. |

An **active monitor** (proposed term) is a row with `enabled = TRUE`,
`removed_at IS NULL`, and `strategy IS NOT NULL`.

**Alternatives considered.**

- Store definitions as JSONB in `application_settings`. Those are user
  settings; this data belongs to Deals and has its own lifecycle.
- A full history table of definition versions. No current need: alert rows
  record the threshold they used (D12).
- Store nothing and re-read the feed during the summary. That would couple
  the summary to GitHub availability and add an external call per summary.

**Rationale.** Persisting definitions is required by #72 §5 and §10. One
table with `CHECK` constraints makes invalid states impossible to store. The
scan-evidence columns answer "did this monitor's latest scan succeed and how
old is it?" without a new feed field.

### D5. Product–monitor association model

**Recommendation (Proposed).** Add a column `products.monitor_ids TEXT[]
NOT NULL DEFAULT '{}'` with a GIN index:

- The importer fills it on every upsert from the feed's `monitor_ids`.
- It is validated with the existing ID rules (pattern, length, at most 20;
  `lib/product-evaluation.ts:31-33`). Invalid entries are dropped without
  failing the product.
- It is overwritten on every upsert, so it means "the monitors that observed
  this product in its latest imported scan".
- The migration backfills it from `raw_data -> 'monitor_ids'`. This is an
  additive update that does not delete anything.
- The existing dashboard and evaluation readers stay on `raw_data` for now.
  Moving them is a possible later cleanup, not part of this design.

**Alternatives considered.**

- (a) Keep `raw_data.monitor_ids` and add a shared validated reader. This
  needs no migration and has the same overwrite meaning, but it contradicts
  "raw_data … is not a substitute for normalized application fields"
  (`docs/import-contract.md:47-48`) once membership becomes authoritative for
  recommendations and alerts.
- (b) A join table `product_monitors(product_id, monitor_id, first_seen_at,
  last_seen_at)`. It records per-monitor history, but nothing needs that:
  each source scan covers all of its monitors at once, so the latest
  membership plus `products.last_seen_at` is enough (D7). It is more
  writes per import.

**Rationale.** An explicit, validated, indexed field. Membership meaning
does not change from what the dashboard uses today. It is the smallest
normalized change. This changes the documented status of `monitor_ids` from
non-authoritative context to authoritative membership, so
`docs/import-contract.md` must be updated in that slice (S3b).

### D6. Recommendation strategy interfaces

**Recommendation (Proposed).** Use a discriminated union and plain pure
functions in `lib/monitor-recommendation.mts`. There is no registry, no
class hierarchy, and no plugin mechanism. Persistence lives in a separate
loader.

```ts
type MonitorPolicy =
  | { monitorId: string; source: string; displayName: string | null;
      strategy: "discount_threshold"; minimumDiscountPercent: number }
  | { monitorId: string; source: string; displayName: string | null;
      strategy: "best_match"; minimumOverallScore: number };

type MonitorCandidate = {
  productId: string; title: string; externalUrl: string; source: string;
  currentPrice: string | null; currency: string | null;
  sourceCurrentPrice: string | null; sourceCurrency: string | null;
  discountPercent: number | null;       // products.discount_percent
  preferenceScore: number | null;       // null = not evaluated
  dealScore: number | null;
  hidden: boolean; lastSeenAt: string;
};

type MonitorSelection = {
  monitorId: string;
  freshness: "current" | "stale" | "never_scanned";
  qualifyingCount: number;
  unevaluatedQualifyingCount: number;
  best: MonitorCandidate | null;
};

function qualifies(policy: MonitorPolicy, c: MonitorCandidate, w: number): boolean;
function compareQualified(policy: MonitorPolicy, a: MonitorCandidate, b: MonitorCandidate, w: number): number;
function selectForMonitor(policy: MonitorPolicy, freshCandidates: MonitorCandidate[], w: number): MonitorSelection;
```

`w` is `preferenceWeightPercent`. The loader returns, for each active
monitor, its fresh, visible members (D7) with stored evaluations, in one
query. Ranking reuses `getOverallScore` and `compareProductIds`
(`lib/ranking-settings.mts:28-35`; `lib/import-notification.mts:233-239`).

Ranking (Proposed). This keeps today's tie-breaks and adds no new formula:

- `best_match`: qualifies when Overall (unrounded) ≥ `minimumOverallScore`.
  Order: higher Overall, then higher Deal score, then ascending product ID.
  This ordering matches `selectOverallRecommendation`
  (`lib/import-notification.mts:241-269`).
- **Display-price rule.** It carries over unchanged as an eligibility rule
  for the best match, for both strategies. Today the function first keeps
  only candidates with a displayable price, preferring the normalized pair
  and falling back to the source pair only when no candidate has a
  normalized pair (`lib/import-notification.mts:258-261`;
  `docs/recommendation-policy.md`, "Display price"). **Verified.** The
  proposal applies the rule per monitor to best-match selection only. A
  qualifying product without a displayable price still counts in
  `qualifyingCount` (**Proposed**). For `discount_threshold` the rule never
  removes anything, because D8 already requires `current_price` and
  `currency`.
- `discount_threshold`: qualifies when the discount is reliable and ≥ the
  threshold (D8). The order among evaluated products is the same as above.
  How unevaluated products are handled is
  [P2](#p2-qualifying-products-without-a-gemini-evaluation). Whether
  discount size becomes a ranking criterion is
  [P8](#p8-additional-ranking-criteria-for-discount_threshold). The
  recommendation for P8 is no.

**Alternatives considered.**

- A `Strategy` interface with registered implementations. This abstracts for
  hypothetical strategies, which #72 §4 forbids.
- SQL-only selection. It is hard to test without a database, and it mixes
  persistence and policy (#72 §10).

**Rationale.** The functions can be tested without a database. Adding a
strategy means one new union member and one new `switch` case, which the
type checker enforces.

### D7. Freshness and availability rules

**Recommendation (Proposed).**

- **Monitor freshness.** A monitor is `current` when `last_scan_checked_at`
  is no older than the source's scan window. It is `stale` when it is
  older, and `never_scanned` when it is null. A stale or never-scanned
  monitor appears in the daily summary with that state, and with **no best
  match**, so old observations are never presented as current. The window is
  [P3](#p3-freshness-windows); 36 hours is recommended for both sources.
- **Product freshness for a monitor.** The product's `monitor_ids` contains
  the monitor, and `last_seen_at` is no older than the monitor's
  `last_scan_checked_at` minus a source tolerance. A tolerance of 0
  (Vinted) means "present in the latest scan of that monitor". A tolerance
  over 0 (Zalando, proposed 0 for v1) would let a product missed by a
  degraded scan stay eligible. The values are part of P3.
- **Availability.** `available` is not used, because it is always true (Q3).
  Presence in a recent scan is the availability rule. Stored products are
  never assumed to be available.
- **Failed or delayed scans.**
  - A fully failed scan keeps the old feed. That feed's `checked_at` does
    not advance, so the monitor becomes stale.
  - A degraded scan still advances `checked_at`, and products on failed
    pages are not fresh. Scan warnings are repeated in the daily summary.
  - A monitor that remains enabled is never treated as proof of a
    successful scan.

**Alternatives considered.**

- `last_seen_at` within a fixed age, such as 24h or 7d as on the dashboard
  (`lib/dashboard-freshness.mts`). This ignores whether the latest scan
  succeeded.
- Trusting `available`. It carries no signal.
- Per-product availability checks. These need new scraping, which is out
  of scope.

**Rationale.** Uses only fields that are reliable (Q3). Makes failed scans
explicit rather than hiding them. Has no new external call.

### D8. Discount calculation

**Recommendation (Proposed).** DealRadar does **not** calculate discounts.
The authoritative value is the producer's `discount_percent`, as stored in
`products.discount_percent` (current state) and
`product_snapshots.discount_percent` (transitions). Deals owns how the
retailer's data is read (`docs/architecture.md`; Q3). A discount is
**reliable** for qualification only when all of these hold:

1. the product source is `zalando.dk` (the strategy is valid only there);
2. `discount_percent` is not null and is in the range 0 < d < 100;
3. `current_price` is not null and is ≥ 0;
4. `currency` is not null.

Conditions 3 and 4 exclude `explicit-discount-no-price`. A null discount
excludes `no-discount-found`. This works without reading `discount_status`
from `raw_data`. One weaker case remains: a `calculated-from-prices` discount
that Deals inferred from unlabelled card prices. It is accepted here until
[P13](#p13-inferred-pair-discounts) is decided (risk R11).

The comparison is `d ≥ minimum_discount_percent` on the stored value. Deals
rounds calculated discounts to 0.1 (`zalando-price.ts:152`); explicit
discounts are integers (`:64-73`). `original_price` is shown when it is
above `current_price` and is never used to recompute. The display price
uses the existing pair preference (`lib/import-notification.mts:202-221`).
Range-checking `discount_percent` at import time is listed separately as
risk [R3](#9-known-risks), because it changes import semantics.

**Alternatives considered.**

- Recompute the discount from `original_price` and `current_price`. This is
  circular for `explicit-discount`, and it redefines producer meaning
  (`docs/import-contract.md:3-6`).
- Accept any non-null discount. That would accept price-less discounts.
- Promote `discount_status` to a column. This needs a migration and adds
  nothing beyond rules 3 and 4.
- Compute the drop against DealRadar's own price history. That is a
  different concept, the watched historical-low event.

**Rationale.** Uses producer evidence and excludes the known unreliable
case. No new migration. Unreliable data cannot produce an apparent discount.

### D9. Candidate handling without evaluations

**Recommendation (Proposed).** Missing evaluations are never treated as low
scores. The summary reports them separately. The product choice is
[P2](#p2-qualifying-products-without-a-gemini-evaluation). The
recommended default:

- `best_match`: an unevaluated product cannot qualify, because the threshold
  is defined on Overall. Fresh unevaluated members are reported as "N not
  yet evaluated".
- `discount_threshold`: qualification does not depend on evaluation, so the
  qualifying count includes unevaluated products, with
  `unevaluatedQualifyingCount` shown. The best match is chosen only among
  evaluated qualifying products. If none is evaluated, the summary says "N
  qualify, none evaluated yet" and has no best match.
- The daily summary triggers no Gemini call (#72 §7). Which products get
  evaluated stays with the existing candidate selection and limit (#34,
  #36). This design does not change them.

**Alternatives considered.** Exclude unevaluated products entirely, which
hides qualifying deals. Use a deterministic fallback such as the highest
discount, which is a new ranking rule. Evaluate on demand at summary time,
which adds Gemini usage and contradicts #72.

**Rationale.** Explicit and honest. No new ranking rule. No extra Gemini
cost.

### D10. Multiple monitor membership

**Recommendation (Proposed).**

- Each active monitor is evaluated independently against its own rules and
  threshold. A product can qualify for several monitors, can be counted in
  each, and can be the best match of several monitors in the same summary.
  There is no deduplication across monitors.
- Overlapping or conflicting rules are not reconciled. Each monitor
  answers its own question.
- Watched alerts are detected per (product, monitor). Delivery is one alert
  message per product and observation, listing every monitor that
  triggered, so one buying opportunity is never notified twice (D12).
- Zalando cannot place one product URL in monitors with different target
  sizes (2.1). Vinted and Zalando products are always different products,
  because identity includes the source.

**Alternatives considered.** Show each product only under its "best"
monitor, which needs a cross-monitor priority rule that is a product
decision. Send one alert per monitor, which duplicates notifications.

**Rationale.** #72 §7 prefers clear behavior over speculative deduplication.

### D11. Daily summary scheduling

**Recommendation (Proposed): option C.** Imports update product,
evaluation, and definition state. The daily summary is a **separate
application operation over persisted state**,
`produceDailySummary(summaryDate)`, and it is idempotent per summary date
(D13). In v1 it is triggered at the end of the existing import pipeline:

- by a **new Workflow step after** `finalizeEvaluationRunStep`, not inside
  the finalizer;
- or, in the no-candidate path, by the import route after the legacy
  message.

The trigger points and the retry path are specified in D13, "Delivery and
retry".

The daily import is already the daily scheduled job (2.1). Triggering there
means the day's evaluations are complete, and no new scheduler, endpoint,
secret, or environment variable is needed. The first import that completes
on a summary date produces the summary. Later imports that day do nothing.

A time-based fallback (Vercel Cron) for days when the import fails or hangs
is open decision
[P5](#p5-daily-summary-date-send-time-and-fallback-trigger). Adding it needs
a `vercel.json` cron and a secret, which require human approval
(`AGENTS.md`). The operation itself takes no Vercel types, so either trigger
can call it (ADR 0001).

**Alternatives considered.**

- **A. A recommendation per import completion.** Today's model. Its pool is
  only the import's evaluations (coupling 1), and it sends one message per
  import, not per day.
- **B. A scheduled task only.** It would run at a fixed time whether or not
  the import and evaluation have finished. It needs new infrastructure and
  a secret.
- **A new endpoint called by a Deals workflow step.** Deals would then
  depend on DealRadar's API shape, and the two would be coupled through
  orchestration (#72 §15).

**Rationale.**

- **Scan, import, and evaluation timing.** Scans run 02:40 and 03:37 UTC,
  the import at 05:00 UTC, and evaluation finishes asynchronously.
  Triggering after finalization uses complete evaluations.
- **Stale products and failed scans.** Freshness is stated per monitor (D7).
- **Retries and idempotency.** A claim per date, step retries, and
  same-date imports (D13, "Delivery and retry").
- **Operational complexity.** No new component.
- **Cost.** No Gemini calls and one Slack call per day.
- **Limitation.** On a day with no completed import there is no summary.
  The missing message is the signal until P5 is decided.

### D12. Watched alert event semantics

**Recommendation (Proposed).** The proposed term is **Watched alert**: an
event detected at import time from inserted snapshots. It reuses the
proven conditions of the watched historical-low event
(`docs/recommendation-policy.md`, conditions 1–3).

A Watched alert candidate exists for product *p*, monitor *M*, and a new
observation *o* when all of these hold:

1. *p* is Watched and visible (not Hidden).
2. *M* is an active `discount_threshold` monitor, and *M* is in
   `p.monitor_ids` after this import.
3. *o* is a snapshot inserted by this import and is *p*'s latest
   observation.
4. *o* has a reliable discount *d(o)* (D8) and *d(o)* ≥ *T*, where *T* is
   *M*'s threshold **at detection time**.
5. The transition rule holds. This rule is open decision
   [P1](#p1-watched-alert-transition-policy). Recommended: either
   - (i) **crossing**: the previous **priced** observation did not meet
     *T*; or
   - (ii) **new best in episode**: ⌊*d(o)*⌋ is above the highest ⌊*d*⌋
     **observed** in the current **qualifying episode** before *o*.

   For transitions, each earlier snapshot is read like this:
   - **Priced, with a reliable discount (D8):** that discount is used.
   - **Priced, with a null discount:** treated as **0%**. A non-null
     `current_price` and `currency` with a null `discount_percent` is a
     product back at full price (`no-discount-found`;
     `deals/scripts/lib/zalando-price.ts:104-106`, `:131-139`). 0% is below
     every valid *T*, so it ends an episode.
   - **Skipped:** snapshots with no price (`current_price` or `currency`
     null, which includes `explicit-discount-no-price`) and snapshots with an
     out-of-range discount. They carry no usable evidence either way.

   A qualifying episode (proposed term) is the run of consecutive earlier
   priced observations of *p* at or above *T*, ending just before *o*.
   Skipped snapshots do not end it. The first priced observation below *T*,
   including a full-price one, ends the run and re-arms the monitor.

   For example: 25% (alerted) → full price (0%) → 25% alerts again, because
   the full-price observation ended the episode and 25% is a new crossing.

   **No earlier priced observation.** If *p* has no earlier priced
   observation, neither (i) nor (ii) fires, so there is no alert. *o* starts
   the episode and becomes its baseline. This is the same rule as the
   watched historical-low event ("a product's first observation never
   qualifies"). It also agrees with the history-based baseline recommended
   in P6(a). Under P6(b) this case would alert instead.

   - **Baseline.** The baseline is the highest discount **observed**, not the
     highest discount alerted. Every alerted discount was also observed, so
     the observed maximum is never lower. The observed baseline also covers
     episodes that have no alert row: products already qualifying when they
     become Watched, products qualifying at go-live, and products above a
     newly lowered threshold. In those cases an unchanged discount does not
     alert, which is consistent with the lifecycle table and P6(a).
   - **Rounding.** Both sides are compared as whole percentages rounded
     **down** (floor). Deals reports calculated discounts to 0.1
     (`deals/scripts/lib/zalando-price.ts:152`). Flooring means 20.9 does not
     count as an improvement over 20.0, and only a step to the next whole
     percentage point does.
   - **Episode state.** It is derived from `product_snapshots` alone, using
     *T* at detection time. Alert rows record what was sent; they are not
     needed to decide the transition.

With the #72 §9 example and *T* = 20 under the recommended rule:

| Observation | Discount | Alert |
| --- | --- | --- |
| Initial | 15% | No (below *T*) |
| New observation | 20% | Yes (crossing) |
| Same discount next day | 20% | No (no new best) |
| Improved discount | 25% | Yes (new best in episode) |
| Same discount again | 25% | No |
| Drop to 10%, then 20% | 10% → 20% | No, then Yes (episode ended, crossing) |

Lifecycle (Proposed; marked where a product decision applies):

| Case | Behavior |
| --- | --- |
| Product becomes Watched after already crossing | No alert for the existing state. The crossing is judged against stored history, which exists before Watch. The next new best alerts. The decision is [P6](#p6-alert-baseline-already-qualifying-products-and-go-live). |
| Product becomes Hidden | No alerts while Hidden. Unhide does not alert by itself (`docs/ubiquitous-language.md`, Unhide). |
| Product becomes unavailable | It is not observed, so there is no event. When it reappears, it is compared with its previous reliable observation. |
| Product in several monitors | Detected per monitor and delivered as one message per product (D10). |
| Monitor changes its threshold | *T* at detection time is applied to both *o* and the previous observation. A product already above a lowered threshold does not alert until a new best. Raising the threshold can end an episode. Each alert row stores the *T* it used. |
| Monitor disabled or removed | Not active, so no alerts. |
| Price falls and later recovers | Falling below *T* ends the episode, and that includes returning to full price (a null discount with a price counts as 0%). A later crossing alerts again. |
| Repeated identical observations | Same `observed_at`: no snapshot, no event. New `observed_at` with the same discount: no crossing and no new best, so no alert. |
| Failed Slack notification | The alert row stays pending. It is retried by the next delivery attempt under a claim. The triggers are in D13 "Delivery and retry", and the late-delivery choice is P5. |
| Import retries | Same ref, no inserted snapshot, no detection. Alert rows are unique per (*p*, *M*, snapshot). |
| Delayed evaluations | Alerts do not need an evaluation. Overall is shown if a stored evaluation exists. |

Detection uses one query per import over the history of Watched, visible
products in active `discount_threshold` monitors that received a new
snapshot. It runs next to `findWatchedHistoricalLows`, and a failure
degrades without failing the import (`route.ts:386-400`). The relationship
to watched historical-low events is [P4](#p4-fate-of-the-watched-historical-low-event).
The recommended path keeps the historical-low event unchanged until Phase 6
is verified, and then merges both into one Watched alert message per
product and observation, listing every reason.

**Alternatives considered.** Alert on every qualifying observation, which is
noisy. Alert only on crossing, which misses improvements. Require a minimum
improvement of N points, which adds a tunable. Detect at summary time, which
loses the "new observation" anchor and repeats events.

**Rationale.** A transition-based rule tied to inserted snapshots inherits
the existing import idempotency. Episode state is derived from stored
snapshots, so it survives restarts and needs no extra state.

### D13. Notification idempotency

**Recommendation (Proposed).** Reuse the evaluation-run notification
pattern: a lease claim, a claim token, a deterministic `client_msg_id`, and
mark-sent with the token (`lib/evaluation-runs.mts:369-421`). Key it to the
new units:

- **Daily summary.** New table `daily_summaries`:

  ```text
  summary_date DATE PRIMARY KEY
  status
  content JSONB          -- selection persisted before sending, so a retry sends the same content
  claimed_at
  claim_token
  client_message_id      -- derived from the date
  sent_at
  ```

  At most one summary row exists per date, and at most one is sent. A
  failed send releases the claim, so the row can be retried. The retry
  path is described in "Delivery and retry" below.
- **Watched alerts.** New table `watched_alerts`:

  ```text
  id
  product_id
  monitor_id
  snapshot_id
  discount_percent
  threshold_percent
  reason
  created_at
  claimed_at
  claim_token
  client_message_id
  sent_at
  UNIQUE (product_id, monitor_id, snapshot_id)
  ```

  Detection inserts rows with `ON CONFLICT DO NOTHING`. Delivery claims
  pending rows per product and observation.
- Import-level idempotency is **not** relied on for either (#72 §12).
  Interrupted jobs are recovered by lease expiry, as today.

**Delivery and retry (Proposed).**

Current behavior (**Verified**):

- The finalizer is one Workflow step, `finalizeEvaluationRunStep`
  (`workflows/evaluation-run-orchestration.ts:96-99`).
- It returns early once the run's notification has been sent
  (`lib/evaluation-finalization.mts:39`).
- On a Slack failure it releases its claim and throws
  (`lib/evaluation-finalization.mts:83-86`).
- A Workflow step that throws is retried up to 3 times by default
  (`node_modules/@workflow/core/dist/runtime/step-handler.js:18`,
  `DEFAULT_STEP_MAX_RETRIES = 3`).

Because of the early return, a summary placed **inside** the finalizer would
never be retried once the legacy message had been sent. The proposal
therefore separates them:

- **Daily summary, evaluation-run path.** A new step,
  `deliverDailyNotificationsStep`, runs after `finalizeEvaluationRunStep` in
  `processEvaluationRunWithWorkflow`. It calls `produceDailySummary(date)`.
  On a Slack failure it releases the claim and **throws**, so the step's
  own retries (up to 3) try again. They resend the persisted content with
  the same `client_msg_id`. The legacy step has already completed, so its
  message is not affected. The step contains no policy and no Vercel types
  in the application code (ADR 0001). If every retry fails, the run's
  workflow ends failed after evaluation and the legacy message are already
  complete. The summary row stays unsent.
- **Dependency on finalization.** The workflow runs its steps in order
  (`workflows/evaluation-run-orchestration.ts:33-38`, **Verified**). If
  `finalizeEvaluationRunStep` still throws after its retries,
  `deliverDailyNotificationsStep` never runs. That day has no daily summary,
  and no catch-up delivery of pending Watched alerts from this run, unless
  another import runs on the same date (risk R7, decision P5).
- **Summary date (QA).** The import route computes the Europe/Copenhagen
  date once, when the import starts, using the date choice in P5. It stores
  that date with the evaluation run, inside the existing `import_summary`
  JSONB (`migrations/017_evaluation_run_finalization.sql`), so no migration
  is needed. It does this through `createEvaluationRun`, so the
  workflow step reads it from Postgres. That also covers resumed launches,
  which receive only the run ID (`workflows/evaluation-run-orchestration.ts`,
  `resumePendingEvaluationRunWorkflows`). The no-candidate path passes the
  date directly. Neither step retries nor a run that finishes after
  midnight can change the date the summary belongs to.
- **Order inside `deliverDailyNotificationsStep` (QB).**
  1. Produce and send the daily summary for the passed date.
  2. Deliver pending Watched alerts.

  Both are always attempted. A failure in one is recorded and does not skip
  the other. The step throws at the end if either failed, so the step retry
  tries again. Retries are idempotent: a sent summary or alert is not sent
  again because of its claim and mark-sent state. A Watched alert that keeps
  failing therefore cannot prevent the summary from being attempted. The
  no-candidate path uses the same order, with each part in its own
  `try/catch`.
- **Daily summary, no-candidate path.** The import route calls
  `produceDailySummary(date)` after the legacy message, in a `try/catch`.
  A failure is logged and does not fail the import, which matches today's
  Slack handling (`app/api/import-deals/route.ts:449-454`). There is no
  automatic retry within the request.
- **Retry beyond that.** Every later import with the same summary date,
  scheduled or manual, calls the operation again and retries the unsent
  row. Whether an unsent summary is sent after its date is open decision
  [P5](#p5-daily-summary-date-send-time-and-fallback-trigger); not sending
  it is recommended. The time-based fallback trigger is also P5.
- **Watched alerts.** Detection writes `watched_alerts` rows in the import
  route (D12). Pending rows are then delivered at two points:
  - right after detection in the same request, which is non-fatal and
    logged on failure;
  - in the same daily-notification step or no-candidate call as the
    summary, which catches rows left pending by earlier failures. In the
    Workflow step, a failed alert send releases its claim and throws, like
    the summary.

  Rows still pending after these attempts are retried by the next import.
  Whether old pending alerts are still sent, or are expired once the state
  no longer holds, is also P5.

**Alternatives considered.** Reuse `evaluation_runs` notification columns,
which are keyed by run, not by day or alert. Rely on Slack deduplicating
`client_msg_id`; this is not verified (R5). Use a queue, which is new
infrastructure.

**Rationale.** A proven in-repo pattern with the smallest number of new
concepts.

### D14. Migration from the existing source-specific recommendations

**Recommendation (Proposed).** Run in parallel, then retire with approval.

1. Phases 2–4 do not change any Slack output. The legacy per-import message
   and `docs/recommendation-policy.md` keep working.
2. Phase 5 adds the daily summary as a **separate** message. It is gated by
   data: it is produced only when at least one active monitor exists, so
   Deals' configuration turns it on per monitor.
3. Phase 6 adds Watched alerts. The watched historical-low event stays as
   it is until P4 is decided.
4. Phase 7 starts after an agreed observation period (proposed: 14
   consecutive daily summaries without defects) and explicit approval. It:
   - removes the recommendation entries from the per-import message, keeping
     or dropping the operational part per [P7](#p7-per-import-slack-message-after-the-daily-summary);
   - retires `selectVintedRecommendation` and
     `selectZalandoFallbackRecommendation`;
   - applies P4;
   - retires the per-source meaning of Recommendation and the term New
     recommendation in `docs/ubiquitous-language.md`, and updates
     `docs/recommendation-policy.md`. The new terms were already added in
     S3a, S5, and S6 (§15).

**Alternatives considered.** Replace in one step, which silently changes
recommendation behavior (#72 §15). Keep both indefinitely, which gives two
recommendation concepts.

**Rationale.** Existing behavior is preserved until an approved replacement
has been verified (#72 §9, §15).

### D15. Necessary database migrations

**Proposed.** All are additive. None deletes or rewrites stored data. The
next free number is `028`; the latest is
`migrations/027_drop_product_feedback.sql` (**Verified**). Numbers are
tentative and depend on merge order.

| Migration | Slice | Content | Destructive? |
| --- | --- | --- | --- |
| `028_monitor_definitions.sql` | S3a | `monitor_definitions` table (D4) | No |
| `029_product_monitor_ids.sql` | S3b | `products.monitor_ids TEXT[] NOT NULL DEFAULT '{}'`, backfill from `raw_data`, GIN index (D5) | No; backfill only fills the new column |
| `030_daily_summaries.sql` | S5 | `daily_summaries` (D13) | No |
| `031_watched_alerts.sql` | S6 | `watched_alerts` (D13) | No |

No migration is needed for policy (S4) or cleanup (S7). Each must be
applied to Neon manually before the code that uses it is deployed
(`docs/architecture.md`, "Database responsibilities"). Applying each needs
human approval.

**Alternatives considered.**

- **No new migrations.** Keep membership in `raw_data` and definitions,
  summaries, and alerts in JSONB on existing rows, such as
  `application_settings` or `evaluation_runs`. Membership would stay
  non-authoritative (D5). Summary and alert state would lack the unique keys
  that idempotency depends on (D13).
- **A join table** `product_monitors` instead of the `TEXT[]` column. It is
  rejected in D5: nothing needs per-monitor history, and it means more
  writes per import.
- **Reusing the `evaluation_runs` notification columns** for summaries and
  alerts. They are keyed by run, not by date or alert (D13). A day without
  candidates has no run at all (2.5).
- **One combined migration for all tables.** That would require applying
  schema for features not yet built. It would also tie S3–S6 together, so
  one slice could not be deployed or rolled back without the others.

**Rationale.** One additive migration per slice, applied just before that
slice's code, keeps every slice independently deployable. Each migration
is approved and applied on its own. Rollback never needs a destructive
step.

### D16. Minimal implementation slices

**Proposed.** See [13. Proposed child slices](#13-proposed-child-slices).
There are 8 slices, ordered for deployment, and each can be verified on its
own.

**Alternatives considered.**

- **Merge S3a and S3b.** This gives one DealRadar import slice with two
  migrations. It is smaller in count, but the two changes have different
  risks: a new document consumer, and a change to product data with a
  backfill. They would no longer be reviewable, approvable, and revertible
  separately.
- **DealRadar first.** S3a could ship before S2 and tolerate the 404
  (D3), but it would then be exercised only against "no document" until
  Deals publishes. Deals first (S2 after S1) lets S3a be verified against a
  real published document immediately. Both orders are safe (Q2), and
  neither needs an atomic deploy.
- **One slice for Phases 3–6.** This is a single large DealRadar change
  with four migrations. It cannot be verified independently, it bundles
  several approvals, and it violates #72 §13 ("independently verifiable
  child issues").
- **Folding S1 into S3a.** This saves a slice, but Deals would then publish
  (S2) before any DealRadar test pins the tolerance that makes Deals-first
  safe.

**Rationale.** Each slice changes one concern, needs at most one migration,
and has its own tests and approval items. The order follows the data
dependencies: contract, then persistence, then policy, then outputs, then
cleanup. No slice requires both repositories to deploy at once.

---

## 6. Configuration examples and contracts at a glance

**Proposed.** These are the four current monitors with illustrative
recommendation settings, using the values from #72 §3. Filters and pages are
unchanged.

| Monitor ID | `displayName` | `recommendation` |
| --- | --- | --- |
| `zalando-scarosso-shoes-42` | Zalando – Scarosso shoes | `{ "strategy": "discount_threshold", "minimumDiscountPercent": 20 }` |
| `zalando-dk-mens-trousers-size-46` | Zalando – trousers | `{ "strategy": "discount_threshold", "minimumDiscountPercent": 50 }` |
| `vinted-mens-blazers-size-s` | Vinted – blazers | `{ "strategy": "best_match", "minimumOverallScore": 7 }` |
| `vinted-mens-pants-size-46` | Vinted – trousers | `{ "strategy": "best_match", "minimumOverallScore": 7 }` |

The contracts are:

1. the configuration schema (D1);
2. the published document (D2) and its version rules (D3);
3. the persisted model (D4, D5, D13);
4. the policy interface (D6).

Sample daily summary output, following #72 §8, with the freshness and
evaluation states added (Proposed):

```text
Daily Deals – 18 October

Zalando – Scarosso shoes
3 products qualify (discount ≥ 20%) · 1 not yet evaluated
Best match: Scarosso Oxford — 1.199 DKK · 30% discount · Overall 8.7

Zalando – trousers
No products qualify (discount ≥ 50%)

Vinted – blazers
Scan is stale: last successful scan 16 October 02:41 UTC. No recommendation.

Scan warnings: Vinted 5/6 pages succeeded
```

---

## 7. Invariants

**Proposed.** Each one must hold and be covered by tests.

1. Deals is the only writer of monitor definitions. DealRadar never edits
   them, and nothing in DealRadar edits Deals.
2. A monitor with no `recommendation` gets no monitor recommendation. No
   strategy is ever inferred.
3. Disabled, removed, unconfigured, stale, or never-scanned monitors never
   produce a best match or a Watched alert.
4. Hidden products are never a best match and never cause a Watched alert.
5. A missing evaluation is never treated as a score.
6. A discount is used only when it is reliable (D8). DealRadar never
   computes one.
7. The daily summary makes no Gemini calls.
8. At most one daily summary is sent per summary date, and at most one
   Watched alert per (product, monitor, snapshot).
9. Product, snapshot, and evaluation history is never deleted because a
   monitor changes.
10. A problem in the monitor document never fails or rolls back a valid
    product import.
11. Until Phase 7 is approved, legacy recommendation output is unchanged.
12. No new module imports Vercel Workflow APIs.

---

## 8. Trade-offs

- **A separate document (B) instead of embedding (A).** B gains a reliable
  lifecycle and immediate configuration changes. It costs a generator, a
  CI sync check in Deals, and one more fetch per import.
- **Whole-document rejection.** One bad monitor blocks updates to all
  definitions until it is fixed. In return, the stored set is never half
  applied. Deals CI makes a bad document unlikely to be published.
- **Integer version with "consumer first" breaking changes** fits the
  Deals contract's stance against negotiation. Breaking changes need
  sequencing.
- **Latest-scan membership (D5) instead of a join table.** It is cheaper
  and matches today's meaning, but there is no per-monitor membership
  history. A product dropped from monitor A but still in B leaves A
  immediately.
- **Summary triggered by the import (D11) instead of a cron.** There is
  nothing new to run, but no summary is sent on a day without a completed
  import (P5).
- **Strict freshness (tolerance 0).** It never shows sold or vanished
  listings, but it hides Zalando products missed by a degraded scan for a
  day (P3).
- **No discount-based ranking (P8).** It keeps a single personal ranking,
  but a slightly higher Overall score can beat a much larger discount.

---

## 9. Known risks

- **R1. Older-ref imports.** Importing an older ref overwrites `products`
  fields, including `last_seen_at`, `raw_data`, and the proposed
  `monitor_ids`, with older values (`lib/import-persistence.mts:88-101`).
  **Verified** pre-existing behavior. The proposal guards only scan evidence
  (D4). Definitions follow the latest import, like product fields (D3).
  Changing that is an import semantics change and is out of scope.
- **R2. Invalid timestamp fallback.** An invalid `checked_at` falls back to
  the import time (`route.ts:203`), which would make stale data look fresh.
  Deals validates timestamps, so the risk is low. **Verified.**
- **R3. Unchecked discount values.** `discount_percent` is not
  range-checked, and it accepts numeric strings (`route.ts:95-106`, `:276`).
  A value of 1000 or more overflows `NUMERIC(5,2)` and fails the whole import
  transaction. **Verified.** D8 ignores out-of-range values at
  qualification time. Hardening the import is a separate change that needs
  approval.
- **R4. Deals CI drift check.** If the generator or its CI check is
  bypassed, the published document can diverge from the configuration. The
  CI check must be a required check.
- **R5. Slack deduplication.** Whether Slack deduplicates `client_msg_id` is
  not verified. A crash between a successful post and mark-sent can produce
  one duplicate after the lease expires. Today's mechanism has the same
  property (2.5).
- **R6. Older definitions after a manual import.** D3 chooses "the latest
  import is the truth". A manual import of an older ref therefore applies
  that ref's definitions until `main` is imported again. Two guards were
  rejected. A `generated_from_commit_time` field in the document loses
  determinism. A GitHub API call to get the commit time adds an external
  call to every import. Production imports only `main` HEAD
  (`deals/.github/workflows/daily-dealradar-import.yml:24`), so the exposure
  is limited to manual calls.
- **R7. Silent misses.** The daily summary depends on the import completing
  on that day (D11, P5).
- **R8. Collection limits.** `pages` and retailer sort order limit what
  Zalando collects (Q1). A qualifying product beyond page `pages` is never
  seen. This is a scraping concern.
- **R9. Duplicate notifications during transition.** Until P4 is applied,
  one Watched Zalando price drop could cause both a historical-low entry in
  the per-import message and a Watched alert. When the original price is
  unchanged, a new low and a rising discount coincide, so this is expected
  to be common rather than rare. #72 §9 and DoD 14 require avoiding it. The
  handling is a sub-decision of
  [P4](#p4-fate-of-the-watched-historical-low-event). The recommendation is
  (ii): suppress the Watched alert for that observation and leave legacy
  output unchanged.
- **R10. Evaluation staleness.** The Deal score is computed at evaluation
  time. If the price changes and the product is not selected again (limit),
  the stored Deal score is stale ([P9](#p9-evaluation-staleness)).
- **R11. Inferred price pairs.** `calculated-from-prices` has two cases. In
  the labelled case the original price is marked `Normalpris` or
  `Oprindeligt`. In the inferred case the original and current prices are
  just the highest and lowest of two or more unlabelled card prices
  (`deals/scripts/lib/zalando-price.ts:80-99` labelled, `:108-115` inferred).
  **Verified.** The inferred case can produce a discount from prices that
  are not a sale pair. The two cases have the same `discount_status`, so
  DealRadar cannot tell them apart without new producer information. D8
  treats both as reliable. Whether inferred-pair discounts may qualify is
  open decision [P13](#p13-inferred-pair-discounts).

---

## 10. Out-of-scope observations

**Verified** pre-existing issues noticed during the investigation. None is
fixed here.

- `docs/architecture.md` ("Exact Git reference imports") says a scraper
  workflow calls DealRadar after committing. Deals now uses a separate daily
  import workflow (`deals/.github/workflows/daily-dealradar-import.yml`),
  and its own architecture document describes that.
- The no-candidate import path posts to Slack with no idempotency
  (`route.ts:447-455`).
- The dashboard sort value `best_match` ranks by **rounded** Overall
  (`lib/dashboard-product-query.mts:34`, `:142-145`). The proposed
  `best_match` strategy uses unrounded Overall. See
  [Terminology](#15-terminology).

---

## 11. Open product decisions

None of these is decided. Each has options and a recommendation for the
reviewer.

### P1. Watched alert transition policy

- Options:
  - (a) Crossing only.
  - (b) Crossing, plus a new best in the episode (any whole-percent
    improvement).
  - (c) Crossing, plus a new best by at least N points.
  - (d) Every qualifying observation.
- **Recommendation:** (b), with the episode re-arming when an observation
  falls below the threshold. It matches the #72 §9 example ("improved
  discount → potential new alert") with no new tunable. Whole-percent
  comparison suppresses 0.1-point noise.
- Also to confirm: a threshold change applies to history as described in
  D12, so a lowered threshold does not alert on an unchanged discount.

### P2. Qualifying products without a Gemini evaluation

- Options:
  - (a) Exclude them from counts and from the best match.
  - (b) Count them and report them as "not yet evaluated", with the best
    match chosen among evaluated products only.
  - (c) A deterministic fallback for the best match, such as the highest
    discount.
- **Recommendation:** (b), as described in D9. It is honest and needs no new
  ranking rule.

### P3. Freshness windows

- Options for the monitor scan window: 24h, **36h**, or 48h.
- Options for the product tolerance: Vinted **0** (latest scan only);
  Zalando **0** or up to 72h.
- **Recommendation:** a 36h window for both sources, which allows one late
  or missed daily run plus margin. Product tolerance 0 for both in v1. A
  Zalando tolerance can be revisited once degraded scans have been seen in
  practice.

### P4. Fate of the watched historical-low event

- Options:
  - (a) Replace it with Watched alerts.
  - (b) Keep it as a distinct alert type.
  - (c) Adapt it: keep the detection as one reason inside a merged Watched
    alert, one message per product and observation.
- **Recommendation:** (c), applied only after Phase 6 is verified.
  - The historical-low event detects price lows that a discount threshold
    does not, for example a lower price at the same displayed discount.
  - The merged message prevents duplicate notifications.
  - It leaves the "first Zalando recommendation priority" role in Phase 7.
- Sub-decision: duplicates during the transition (R9). Between S6 and the
  application of P4, one Watched Zalando price drop can appear both as a
  historical-low entry in the per-import message and as a Watched alert.
  - The overlap is likely to be common. When a Watched Zalando product's
    original price is unchanged, a new low price and a rising discount are
    the same buying opportunity, so both events fire on the same
    observation.
  - (i) Accept the overlap for the observation period. This conflicts with
    #72 §9 ("avoid two mechanisms generating duplicate notifications for
    the same buying opportunity") and #72 DoD 14.
  - (ii) Have S6 suppress a new Watched alert when the import detected a
    watched historical-low event for the same product and observation.
    Both are detected in the same import, so S6 reads the events
    `findWatchedHistoricalLows` returned (`app/api/import-deals/route.ts:386-400`).
    Legacy output is unchanged. Caveat: if several events exist, the
    per-import message shows only the strongest one, so a suppressed alert
    for a weaker one is not shown anywhere until P4 is applied.
  - (iii) Apply P4(c) inside S6, so the merge ships with Watched alerts.
    This changes legacy output before Phase 7.
  - **Recommendation:** (ii). It meets #72 §9 and DoD 14 without changing
    the legacy recommendation path. The caveat is limited to the period
    before P4 is applied.

### P5. Daily summary date, send time, and fallback trigger

- Options for the summary date: the Europe/Copenhagen calendar date, or the
  UTC date.
- Options for the fallback when no import completes:
  - (a) none, so the missing message is the signal;
  - (b) a Vercel Cron, for example 09:00 Copenhagen, that sends a summary
    marked "no import today". This needs `vercel.json` and a secret, which
    require approval.
  - (c) a Deals workflow step calling a new endpoint.
- Options for a summary whose send failed after all automatic retries
  (D13, "Delivery and retry"):
  - (a) send it on any later import with the same summary date, and never
    after that date;
  - (b) also send it late, marked with its date, on the next day's
    import.
- Options for Watched alerts still pending after their delivery attempts:
  - (a) deliver them on the next attempt whatever their age;
  - (b) deliver them only while the product is still Watched, visible, and
    qualifying, and drop older ones as expired.
- **Recommendation:** the Copenhagen date. Fallback (a) for v1, with (b) as
  a follow-up only if missed days occur. Failed summary (a): a day-old
  summary is replaced by the new day's summary. Pending alerts (b): an alert
  is not sent about a state that no longer holds.

### P6. Alert baseline: already-qualifying products and go-live

- Options:
  - (a) Judge against stored history, so products that already qualify do
    not alert until a new best.
  - (b) Alert on the first qualifying observation after Watch or after
    go-live.
- **Recommendation:** (a). It avoids a burst of alerts at go-live and
  avoids alerting about what the user saw when choosing to Watch.

### P7. Per-import Slack message after the daily summary

- Options:
  - (a) Keep it unchanged.
  - (b) Keep only the operational part: counts and scan warnings.
  - (c) Remove it.
- **Recommendation:** (b) in Phase 7. Operational import information stays
  separate from recommendations (`docs/ubiquitous-language.md`, Hide: hiding
  "does not affect operational import summaries").

### P8. Additional ranking criteria for `discount_threshold`

- Options:
  - (a) None: Overall, then Deal score, then ID, as today.
  - (b) Add discount as a tie-break after Overall.
  - (c) A new weighted formula.
- **Recommendation:** (a). The Deal score already considers discount
  (`docs/ubiquitous-language.md`, Deal score), and #72 §7 forbids new
  formulas without a decision.

### P9. Evaluation staleness

- Options:
  - (a) Use the stored evaluation whatever its age, as the dashboard does
    today.
  - (b) Flag it in the summary when `evaluated_at` predates the latest
    price change.
  - (c) Exclude evaluations older than N days.
- **Recommendation:** (a) in v1, with (b) as a cheap follow-up. Any
  re-evaluation policy belongs with #34 and #36, not here.

### P10. Watched products in `best_match` monitors

- Options:
  - (a) No Watched alerts for `best_match` monitors.
  - (b) Alert when a Watched product's Overall first reaches the threshold.
- **Recommendation:** (a). #72 §9 defines alerts only through discount
  thresholds, and Overall changes only when an evaluation is rerun.

### P11. Fate of Deals' `filters.minDiscountPercent` and `matches`

- Options:
  - (a) Keep both unchanged.
  - (b) Deprecate them in a later Deals slice. That changes the published
    contract and needs approval.
- **Recommendation:** (a) during this rollout. It has no effect on
  DealRadar (Q1). Revisit after Phase 7 to remove the confusion with
  `recommendation.minimumDiscountPercent`.

### P12. Display names and terminology in Slack

- Options for the monitor name: the configured `displayName`, or the
  monitor ID.
- **Recommendation:** use `displayName` with the ID as fallback, and use
  the label "Best match" as in #72 §8, after the terminology review in §15.

### P13. Inferred-pair discounts

- Context: risk R11. A `calculated-from-prices` discount may come from an
  unlabelled max and min price pair
  (`deals/scripts/lib/zalando-price.ts:108-115`).
- Options:
  - (a) Accept every `calculated-from-prices` discount, as D8 does.
  - (b) Exclude inferred-pair discounts from `discount_threshold`
    qualification and Watched alerts. This needs an additive Deals field or
    status that tells the two cases apart, which is a published-contract
    change.
  - (c) Accept them for the daily summary but not for Watched alerts, where
    a false alert costs more.
- **Recommendation:** (a) for v1. Record how often the inferred case occurs
  in the production feed, and choose (b) if it is common or produces
  visible false qualifications. (b) would be an extra Deals slice before S6.

---

## 12. Cross-repository rollout

All of this is **Proposed** and answers #72 §14.

- **Which repository changes first.**
  1. DealRadar S1, a test-only change that pins tolerance of unknown fields
     (Q2).
  2. Deals S2, which publishes the document. It is safe before DealRadar
     changes, because the current importer does not fetch the file (Q2).
  3. DealRadar S3a and S3b, after their migrations are applied.
  4. S4–S7, all in DealRadar except an optional later Deals cleanup.

  No step requires both repositories to deploy at the same time.
- **How older Deals feeds remain importable.** Feeds do not change at all.
  For refs without the new document, DealRadar handles a 404 as "no
  contract" (D3), and the product import is unchanged.
- **When the new contract becomes authoritative.** For each monitor, from
  the first successful import of a valid v1 document in which that monitor
  has a `recommendation`. For the daily summary, from S5 onward. For
  recommendations generally, only after the Phase 7 approval.
- **How DealRadar behaves before the contract is available.** Exactly as
  today. There are no definitions, so there are no active monitors, no
  daily summary, and no Watched alerts. The legacy per-import message
  continues.
- **Whether backfilling is needed.**
  - Monitor configuration does not need a backfill: the next import of a
    ref with the document fills `monitor_definitions`.
  - `products.monitor_ids` is backfilled from `raw_data` by migration `029`.
    This is product data, not configuration.
  - Watched alert and summary history are **not** backfilled. That would
    create spurious events (P6).
- **Rollback.**
  - *Deals:* revert the configuration commit. The regenerated document
    marks monitors unconfigured, disabled, or removed, and DealRadar
    applies that on the next import. Reverting S2 completely makes later
    imports see a 404, which leaves definitions as they were. To stop
    monitor recommendations, set `recommendation` to absent or
    `enabled: false` rather than deleting the file.
  - *DealRadar code:* use a Vercel instant rollback to the previous
    deployment. Every migration is additive, so earlier code ignores the
    new tables and column. After rolling back past S3b, newly inserted
    products get `monitor_ids = '{}'` until the code is redeployed. The next
    import overwrites it.
  - *Database:* migrations are not reverted. Dropping the new tables is
    destructive and needs separate approval. It is never part of a normal
    rollback.
  - *Slack:* stopping the daily summary needs no rollback. Remove every
    `recommendation` in Deals, or redeploy without S5.
- **When old source-specific behavior can be removed.** In S7, after the
  observation period in D14, after P4 and P7 are decided, and with explicit
  human approval.

---

## 13. Proposed child slices

These are in deployment order and are all **Proposed**. "Approval" refers
to the "Human approval required" list in DealRadar's `AGENTS.md` and, for
Deals, in `deals/AGENTS.md`. Every slice also needs the normal approval for
commit, push, and merge.

| # | Repository | Goal | Migration | Approval items | Independent verification |
| --- | --- | --- | --- | --- | --- |
| S1 | DealRadar | Characterization tests: the import accepts unknown top-level, `monitors[]`, and product fields, and never fetches other files. No behavior change. | No | None beyond commit and push | `npm test`. The new route tests pass against current code. |
| S2 | Deals | `displayName` and `recommendation` in the configuration; a recommendation validator; a deterministic generator; a committed `public/deals/monitor-recommendations.json`; a CI sync check; `docs/output-contract.md` section. Scanners and feeds unchanged. | No | Deals: "change published JSON schemas or semantics" (a new published document). The initial threshold values are a product choice. | `npm test` and `npm run typecheck`. Validator accept/reject cases. The generator is deterministic. CI fails on drift. Scanner tests unchanged. |
| S3a | DealRadar | Fetch, validate, and persist the monitor document at the import ref (D3, D4). Scan evidence from feed `monitors[]`. 404 tolerated. No change to recommendations or Slack. Update `docs/import-contract.md`. Add Monitor, Monitor definition, Active monitor, and Recommendation strategy to `docs/ubiquitous-language.md` (§15). | `028` | Applying the production migration; changing the imported data contract (consuming a new document) | Unit tests for the D3 table. `npm run test:integration` applies `028` and round-trips definitions. On production after deploy, inspect `monitor_definitions`. |
| S3b | DealRadar | `products.monitor_ids` filled by the importer and backfilled (D5). Readers unchanged. Update `docs/import-contract.md` (membership becomes authoritative). | `029` | Applying the production migration; import semantics change for `monitor_ids` | Unit tests for validation and overwrite. Integration test for the backfill and round trip. After deploy, compare the column with `raw_data` for a sample. |
| S4 | DealRadar | Pure policy module (D6–D10) and a read-only loader. Not wired to Slack. | No | None (no behavior change). The policy follows approved P2, P3, P8, and P9. | Unit tests for qualification, counts, ranking, ties, freshness, and unevaluated or Hidden products. Integration test for the loader query. |
| S5 | DealRadar | Daily summary operation, formatter, and idempotent delivery. Triggered by a new Workflow step after finalization, or by the no-candidate path (D11, D13). The legacy message is unchanged. In the same change, add Qualifying product, Best match, Discount, Daily summary, and Fresh to `docs/ubiquitous-language.md`, plus the parallel-run note on Recommendation (§15). Add a daily summary section to `docs/recommendation-policy.md`. | `030` | Applying the production migration; documentation of new domain terms. A cron fallback, if P5(b) is chosen, also needs approval for the environment and secret. | Unit tests for the formatter and the claim, retry, and same-date paths. Integration test of `030`. Production smoke test: exactly one summary on the first import of a day, and none on a repeated import. |
| S6 | DealRadar | Watched alert detection at import and idempotent delivery (D12, D13). The historical-low event is unchanged, unless P4's sub-decision chooses (ii) or (iii). In the same change, add Watched alert and qualifying episode, rewrite the Watch sentence at `docs/ubiquitous-language.md:58-59`, and add the Hide statement (§15). Add a Watched alert section to `docs/recommendation-policy.md`. | `031` | Applying the production migration; documentation of a changed domain meaning (Watch) | Table-driven tests from D12, including the #72 §9 sequence, retries, Hidden products, threshold change, and multiple monitors. Integration test of `031`. |
| S7 | DealRadar (and an optional, separate Deals slice for P11) | Retire the per-source recommendation paths as per P4 and P7. Update `docs/recommendation-policy.md` and `docs/architecture.md`. In `docs/ubiquitous-language.md`, retire only the per-source meaning of Recommendation and the term New recommendation (§15). Representative end-to-end check (#72 DoD 20). Fresh-context review. | No | Changes recommendation behavior; documentation of changed domain meaning. Explicit approval to remove the legacy behavior. | `npm test`, `npm run lint`, `npm run build`. A review that history and evaluations are preserved. An end-to-end run with two Vinted and two Zalando monitors. |

---

## 14. Verification strategy

**Proposed.**

- **Deterministic unit tests** are the main evidence for policy (S4),
  alert semantics (S6), contract validation (S2, S3a), and summary
  formatting and idempotency (S5). They follow the existing `node --test`
  style (`package.json`, `tests/`).
- **Shared contract fixture.** S2 commits a sample document. S3a tests copy
  the same document as a fixture, and a drift between the two is caught in
  review. Deals tests the generator, and DealRadar tests the consumer.
- **Migration safety.** `npm run test:integration` applies every migration
  in order to a disposable Postgres (`docs/architecture.md`, "Real-PostgreSQL
  integration test"). It is extended per slice to round-trip the new
  tables and columns. It is not part of CI, so each slice must report
  running it.
- **CI.** DealRadar CI runs `npm test`, `npm run lint`, and `npm run build`
  (`AGENTS.md`). Deals CI runs `npm test` and `npm run typecheck`, plus the
  new drift check.
- **Production checks after each deploy.** These are manual and owned by the
  repository owner. Read-only inspection of the new tables. Confirm that the
  legacy Slack message is unchanged until S7. For S5 and S6, observe one
  real day, including a deliberately repeated import of the same ref.
- **Regression guards.** The existing `import-notification`,
  `watched-historical-low`, `evaluation-finalization`, and import route
  tests must stay green and unchanged until S7.

---

## 15. Terminology

These terms are checked against `docs/ubiquitous-language.md`. Existing
terms are used with their defined meaning: Visibility, Hide, Hidden, Unhide,
Watch, Watched, Watchlist, Preference score, Deal score, Overall score,
Recommendation, New recommendation, watched historical-low event, Price
change, and Scan warning.

**Proposed new terms. These are flagged for review. None is in the
ubiquitous language yet.** Following `AGENTS.md`, each term is added to
`docs/ubiquitous-language.md` in the same slice that first uses it in code,
documentation, or Slack.

| Term | Proposed meaning | Added to the ubiquitous language in |
| --- | --- | --- |
| **Monitor** | A configured search in Deals, identified by a stable monitor ID. It is already shown in the dashboard filter (`app/dashboard-filter-bar.tsx:154-164`) but is not defined. | S3a |
| **Monitor definition** | The recommendation-relevant part of a monitor as published by Deals and persisted by DealRadar (D2, D4). | S3a |
| **Active monitor** | Enabled, not removed, and with a recommendation strategy (D4). | S3a |
| **Recommendation strategy** | `discount_threshold` or `best_match` (D1). | S3a |
| **Qualifying product** | A fresh, visible member of an active monitor that meets that monitor's strategy (D6–D8). | S5 |
| **Best match** | The highest-ranked qualifying product of one monitor. *Conflict:* the dashboard sort `best_match` means rounded-Overall ordering (§10). The reviewer should confirm the shared name or pick a different one. | S5 |
| **Discount** | The producer's `discount_percent`, used only when reliable (D8). Today "discount percentage" is used only as evidence for the Deal score. | S5 |
| **Daily summary** | The once-per-day Slack message with one best match per active monitor (D11). | S5 |
| **Watched alert** and **qualifying episode** | The event-based notification for a Watched product, and the run of consecutive qualifying observations (D12). | S6 |
| **Fresh** (product or monitor) | Freshness as defined in D7. It is distinct from the dashboard's 24h/7d filter. | S5 |

**Proposed changes of meaning. These are flagged for review. Each one is
documented in the slice that makes it true.**

- **Recommendation (S5, then S7).**
  - In S5 the Recommendation entry gains a note: during the parallel run
    there are two forms, the per-source import recommendation (unchanged)
    and the per-monitor best match in the daily summary.
  - In S7 the meaning changes from "at most one per source per import" to
    "at most one best match per active monitor per daily summary".
- **New recommendation (S7).** Retired in S7, when the per-import
  recommendation paths are removed. It is unchanged before that.
- **Watch (S6).** The sentence "This does not change … the absence of
  target-price alerts" (`docs/ubiquitous-language.md:58-59`) stops being
  true when Watched alerts ship. S6 must therefore update the Watch entry to
  describe Watched alerts. Watched state itself stays independent of
  monitor configuration. Any further Watch change from P4 (the role of the
  historical-low event) is made in the slice that applies P4.
- **Hide (S6).** Unchanged in meaning. S6 adds an explicit statement that
  Hidden products cause no Watched alerts. This is consistent with
  "excluded from product recommendation selection".
