# DealRadar Import Contract

## Purpose

This document defines the contract between the `deals` scraper repository and DealRadar.

The contract should remain backwards compatible unless a contract change is explicitly approved.

Source feeds are external input from DealRadar's point of view and must be validated before use.

## Feed location

DealRadar currently consumes:

```text
public/deals/scarosso-latest.json
public/deals/zalando-latest.json
public/deals/vinted-latest.json
```

from:

```text
runethorbek/deals
```

Imports should normally use an exact Git commit SHA.

## Top-level feed shape

Each feed should contain:

```json
{
  "site": "example.com",
  "checked_at": "2026-08-21T12:00:00.000Z",
  "products": []
}
```

Additional source-specific metadata is allowed.

DealRadar must tolerate additive fields it does not understand.

## Product identity

A DealRadar product is uniquely identified by:

```text
(source, external_url)
```

The scraper's product URL therefore has identity semantics.

A product URL should be:

- stable;
- canonical where possible;
- stripped of tracking-only parameters;
- specific to the actual product/variant represented.

Changing URL normalization can create duplicate products and should be reviewed carefully.

## Required product fields

A product needs enough information to identify and display it.

At minimum, DealRadar expects usable values for:

```text
url
title
```

Products missing required identity/display fields may be skipped safely.

## Common optional fields

Feeds may provide fields such as:

```text
image
current_price
original_price
price
currency
discount_percent
target_size
available
brand
category
checked_at
```

Exact fields may differ by source.

DealRadar owns source-to-normalized field mapping.

## Prices

Source prices must represent the value reported by the source.

Scrapers should not perform application-wide currency normalization unless the source itself requires parsing.

Example:

```json
{
  "current_price": 190,
  "currency": "USD"
}
```

is preferable to converting the value to DKK inside the Scarosso scraper.

DealRadar may normalize this later.

## Source price preservation

When DealRadar converts or otherwise normalizes a price, it should preserve:

```text
source_current_price
source_original_price
source_currency
```

alongside normalized values where applicable.

This allows:

- debugging;
- future re-normalization;
- historical interpretation;
- avoiding loss of retailer-reported values.

## Currency

Currency must be explicit when the price meaning depends on it.

Do not infer currency from price magnitude.

Do not silently guess when the source markers conflict.

If currency cannot be determined reliably, preserve the source data and fail safely.

## Timestamps

Feeds and products may include:

```text
checked_at
```

DealRadar uses a valid source observation timestamp where possible.

Invalid or missing timestamps must not be trusted blindly.

Snapshot semantics depend on observation timestamps, so changes here should be reviewed carefully.

## Product images

The `image` field should refer to the image associated with the specific product represented by the product URL.

A wrong product image is worse than a missing image.

Scrapers should return:

```json
{
  "image": null
}
```

when a reliable association cannot be made.

DealRadar should not attempt to infer a replacement image from unrelated source products.

## Raw data preservation

DealRadar stores the original source product object in `raw_data`.

This is useful for:

- debugging;
- future migrations;
- investigating source parsing errors;
- preserving information not yet modeled explicitly.

`raw_data` is not a substitute for normalized application fields.

## Scan status

Feeds may include additive scan metadata:

```json
{
  "scan_status": {
    "attempted_pages": 6,
    "successful_pages": 5,
    "failed_pages": 1,
    "failures": [
      {
        "url": "https://example.com/listing",
        "error_summary": "502 Bad Gateway"
      }
    ],
    "scanned_product_count": 60,
    "published_product_count": 35
  }
}
```

The common fields are:

```text
attempted_pages
successful_pages
failed_pages
failures
scanned_product_count
published_product_count
```

The invariant should hold:

```text
successful_pages + failed_pages = attempted_pages
```

## Partial scan semantics

A feed with:

```text
failed_pages > 0
```

may still be valid for import.

This represents:

```text
scan completed with warnings
```

not necessarily:

```text
scan failed
```

DealRadar should treat valid published products normally and may surface the partial failure through Slack.

## Missing `scan_status`

`scan_status` is additive.

Feeds created before the field existed, or future compatible feeds that omit it, must continue to import normally.

Missing `scan_status` must not fail an otherwise valid import.

## Malformed `scan_status`

Malformed optional scan metadata should be ignored safely.

It should not corrupt or prevent the core product import.

## Error text and secrets

Error metadata may originate from HTTP responses or external services.

Before publishing diagnostic text, scraper code must sanitize secrets including values such as:

```text
API keys
Authorization headers
Bearer tokens
access tokens
credentials
```

DealRadar should still treat diagnostic strings as untrusted external text before rendering them in Slack or HTML.

## Backwards compatibility

Changes are considered potentially breaking when they alter:

- product identity;
- meaning of price fields;
- currency semantics;
- required fields;
- timestamp semantics;
- scan-status semantics;
- source URLs;
- how source data maps into DealRadar.

Additive fields are normally preferred over replacing existing fields.

## Contract change rule

Before intentionally changing this contract:

1. inspect both repositories;
2. identify existing stored data and consumers;
3. decide whether the change is backwards compatible;
4. update this document;
5. add or update deterministic tests;
6. explicitly call out migration or rollout requirements;
7. obtain human approval for semantic changes.