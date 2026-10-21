# DealRadar import behavior

This document describes behavior owned by DealRadar at the import boundary.
The authoritative producer field meanings and publication guarantees live in
[`deals/docs/output-contract.md`](https://github.com/runethorbek/deals/blob/main/docs/output-contract.md).
This document must not redefine those meanings.

## Feed location and revision

DealRadar imports:

```text
public/deals/zalando-latest.json
public/deals/vinted-latest.json
```

from `runethorbek/deals`, normally at one exact Git commit SHA. The importer
reads all configured feeds for that revision, not only the source whose
workflow triggered the import.

An HTTP success means the feed data was persisted and, when candidates were
selected, durable evaluation was enqueued. It does not wait for Gemini or the
final Slack summary; the existing scraper trigger remains compatible because it
only requires a successful import response.

## Import mapping

DealRadar maps the source-specific producer fields as follows:

| Producer source | Current-price field |
| --- | --- |
| Vinted | `price` |
| Zalando | `current_price` |

For every source, `url` becomes the external product identity and `title`
becomes the display title. `image`, `discount_percent`, and `brand` are
imported when present and valid. Source-specific category and size metadata
remain in the complete original product object stored as `raw_data`; they are
not normalized product fields.

For availability mapping only, Vinted uses `size_guess` and falls back to the
snapshot `target_size_id`; Zalando uses product `target_size` and falls back to
the snapshot value. This source-specific size information is not persisted as
a product field. If no source-specific availability field is present, Vinted's
listing filter currently permits DealRadar to treat the product as available.

The original product object is retained as `raw_data` for diagnostics and
future migrations. This is not a substitute for normalized application fields.
For Vinted, evaluation may read `monitor_ids` from this preserved object as
non-authoritative discovery context; it is not duplicated into a product field.
For Vinted, evaluation and display also read the specific bounded
`listing_text`, `article_condition`, and `size_guess` fields from this
preserved object; arbitrary `raw_data` is never passed to Gemini. Gemini's
Danish translation of `listing_text` is persisted as evaluation enrichment
(`product_evaluations.translated_listing_text_da`), not as a product field or
a preformatted display title.

## Application normalization and persistence

DealRadar owns application-wide currency normalization. Normalization must not
infer currency from price magnitude or silently guess when source markers
conflict.

Products are persisted by `(source, external_url)`. URL normalization changes
can create duplicate products and require compatibility review. Historical
price observations and normalized values are application-owned persistence
concerns.

## Validation and tolerance

Feeds are external input from DealRadar's perspective and are validated before
use. A configured feed must declare its expected `site`; every product URL
must be a parseable HTTPS URL for that retailer domain; URLs must be unique
within the snapshot; and a present `product_count` must equal
`products.length`. A violation fails the global import before persistence.
Product titles that are unusable may be skipped safely. Unknown additive fields
are tolerated.

The producer's source-specific current-price field is accepted only when it is
`null` or a finite, non-negative number. A malformed, non-finite, or negative
current price skips that product while valid siblings continue importing; the
import result reports the aggregate number skipped. DealRadar does not coerce
price strings or other malformed values into persisted prices.

`scan_status` is optional diagnostic metadata. When present, valid status data
may be surfaced as a partial-scan warning; `failed_pages > 0` does not by
itself invalidate otherwise valid published products. Missing `scan_status`
remains backwards compatible. Malformed optional scan metadata must not corrupt
or prevent the core product import.

Invalid timestamps are not trusted blindly; the importer uses the first valid
product or snapshot observation timestamp available and otherwise records the
current import time according to application behavior.

Diagnostic strings are untrusted external text. They must be sanitized before
rendering and must never expose credentials, API keys, authorization headers,
or access tokens.

## Monitor definitions

Since #77 the importer also reads Deals' optional monitor definitions
document:

```text
public/deals/monitor-recommendations.json
```

It is fetched once per import, from the same exact ref as the feeds, after the
feeds have been validated. Deals owns the document and its field meanings
(`deals/docs/output-contract.md`); the design is in
`docs/specs/monitor-recommendation-design.md` (D1–D4). DealRadar supports
`contract_version` 1.

The document is optional enrichment. No problem with it fails the product
import:

| Situation | DealRadar behavior |
| --- | --- |
| HTTP 404 (older Deals ref without the document) | Stored definitions unchanged. No warning. |
| Other HTTP failure or network error | Stored definitions unchanged. Warning. |
| Unknown `contract_version` | Document ignored, stored definitions unchanged. Warning. |
| Invalid document | The whole document is rejected and nothing from it is written. Warning. |
| Valid document | Every listed monitor is inserted or updated in place, and `removed_at` is cleared if it was set. A stored monitor absent from the document keeps its row and gets `removed_at` (the first removal time is kept). |

A document is invalid when it is not JSON, `monitor_count` does not equal
`monitors.length`, a monitor ID is invalid or duplicated, or any monitor is
invalid: `source` must be `vinted` or `zalando` (mapped to `vinted.com` and
`zalando.dk`), `enabled` must be a boolean, `display_name` is absent, `null`,
or a trimmed string of 1–80 characters, and `recommendation` must be present
as `null` (unconfigured) or one of:

- `{ "strategy": "discount_threshold", "minimum_discount_percent": <integer 1–99> }`,
  Zalando only;
- `{ "strategy": "best_match", "minimum_overall_score": <number 0–10, at most one decimal> }`.

Unknown keys are ignored at the document and monitor level and rejected inside
`recommendation`. The order of `monitors` is not checked.

Definitions are stored in `monitor_definitions` (migration `028`), written in
the same transaction as products and snapshots. `definition` keeps the
published monitor object and `definition_ref` the import ref it came from.
The latest import is the truth: a valid document from an older ref replaces
the stored definitions, and `definition_ref` records that ref.

Scan evidence comes from each feed's existing `monitors[]` and `checked_at`.
For every monitor ID listed there, an existing definition of that feed's
source gets `last_scan_checked_at = GREATEST(stored, checked_at)`, and
`last_scan_ref` is set to the import ref only when that timestamp advances, so
an older ref never moves either value backwards. Scan evidence never creates a
definition. Like `scan_status`, it is parsed leniently: an unparsable
`checked_at` or a malformed `monitors[]` entry is ignored.

Warnings are logged and returned in the import response under
`monitorDefinitions`, together with the `status` (`applied`, `not_published`,
`unavailable`, `unsupported_version`, or `rejected`), the number of
definitions applied, and `productMonitorIdsWithoutDefinition`: the number of
distinct valid product `monitor_ids` in the import that have no
`monitor_definitions` row (`null` if the lookup failed). They are not sent to
Slack. Recommendation selection, Slack messages, and Gemini evaluation do not
use monitor definitions yet.

## Compatibility process

Before changing importer behavior:

1. Inspect the producer contract and current stored data.
2. Determine whether the change is additive or semantically breaking.
3. Update importer-owned tests and this document when applicable.
4. Coordinate with the `deals` repository for any producer contract change.
5. Obtain explicit approval for changes to identity, required fields,
   normalization, timestamps, scan-status handling, or persistence semantics.
