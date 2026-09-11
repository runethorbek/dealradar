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
use. Products without usable `url` or `title` may be skipped safely. Unknown
additive fields are tolerated.

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

## Known compatibility gap

The current importer does not yet verify every producer-contract invariant
before persistence. In particular, expected source identity, duplicate URLs
within a snapshot, published-product counts, and
non-negative source prices need explicit importer validation. This follow-up is
tracked in [DealRadar #19](https://github.com/runethorbek/dealradar/issues/19);
it does not change the current importer behavior.

## Compatibility process

Before changing importer behavior:

1. Inspect the producer contract and current stored data.
2. Determine whether the change is additive or semantically breaking.
3. Update importer-owned tests and this document when applicable.
4. Coordinate with the `deals` repository for any producer contract change.
5. Obtain explicit approval for changes to identity, required fields,
   normalization, timestamps, scan-status handling, or persistence semantics.
