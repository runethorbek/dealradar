# DealRadar Architecture

## Purpose

DealRadar is a personal deal-tracking system that collects product data from external sources, normalizes and stores it, evaluates products against user preferences, and surfaces relevant recommendations in the web application and Slack.

The system is intentionally split across two repositories:

- `runethorbek/deals` — scraping and source-specific extraction
- `runethorbek/dealradar` — normalization, persistence, evaluation, ranking, feedback, UI, and notifications

This boundary is intentional and should be preserved unless there is a clear reason to change it.

## System flow

```text
Retailer websites
    ↓
ScrapingAnt / scraper code
    ↓
GitHub Actions in `deals`
    ↓
Source JSON committed to GitHub
    ↓
DealRadar `/api/import-deals`
    ↓
Normalization
    ↓
Neon PostgreSQL
    ↓
Gemini evaluation
    ↓
Ranking and UI
    ↓
Slack notification
```

## Repository responsibilities

### `deals`

The `deals` repository owns:

- fetching retailer pages;
- source-specific HTML parsing;
- interpreting source-specific price formats;
- associating source-specific titles, images, categories, and product URLs;
- scan schedules;
- scan diagnostics and `scan_status`;
- publishing source JSON;
- triggering DealRadar after a scan.

Source-specific problems should normally be fixed here.

Examples:

- Zalando Danish price parsing;
- Scarosso product/image association;
- Vinted source fields;
- a retailer page failing during a scan.

### `dealradar`

The `dealradar` repository owns:

- importing source JSON;
- validating external feed data;
- normalizing source-specific data into application semantics;
- currency normalization;
- preserving source values separately from normalized values;
- product persistence;
- historical snapshots;
- preferences and user feedback;
- Gemini evaluation;
- ranking;
- the web application;
- Slack notifications.

Examples:

- converting Scarosso USD prices to normalized DKK;
- deciding when a product should be evaluated;
- ranking products by Preference and Deal scores;
- displaying a partial-scan warning in Slack.

## Import boundary

`deals` publishes data.

DealRadar consumes it as external, untrusted input.

DealRadar must not assume that a source feed is valid merely because it was produced by our own scraper repository.

The import layer should validate fields before storing or using them.

See `docs/import-contract.md` for the feed contract.

## Exact Git reference imports

A scraper workflow commits its output and then calls DealRadar using the exact Git commit SHA:

```text
POST /api/import-deals?ref=<commit-sha>
```

DealRadar fetches the source feeds from that exact ref.

This avoids relying on the moving `main` branch immediately after a push and prevents stale reads from GitHub/raw-content caching.

The exact-ref behavior is part of the integration contract and should not be removed casually.

## Import behavior

A DealRadar import currently reads all configured feeds, not only the source whose GitHub Action triggered the import.

The source that triggered the import may be passed as notification context, but it must not change which feeds are imported unless that behavior is intentionally redesigned.

## Source data and normalized data

DealRadar distinguishes between:

- source values — what the retailer/scraper reported;
- normalized values — what DealRadar uses consistently.

For example:

```text
Scarosso source price:
190 USD

DealRadar normalized price:
~1,200 DKK
```

Where source and normalized values differ, source values should be preserved.

Normalization belongs in DealRadar when it is application-wide interpretation rather than retailer-specific extraction.

## Database responsibilities

Neon/Postgres stores persistent application state.

Important categories of state include:

- current product state;
- source values;
- normalized prices;
- historical snapshots;
- feedback;
- preference profile;
- latest evaluation.

Schema changes are represented as numbered SQL migrations under `migrations/`.

Migrations are currently applied manually to Neon.

Adding a migration file does not modify the production database automatically.

## Evaluation

Gemini is an evaluation service, not the system of record.

DealRadar supplies the relevant product, preference, feedback, and price-history context.

Gemini returns structured evaluation output.

Persistent memory remains in DealRadar/Neon.

See:

- `docs/ubiquitous-language.md`
- future evaluation/ranking documentation

for score semantics.

## Slack

Slack is a notification output from DealRadar, not from individual scraper implementations.

This keeps:

- Slack credentials;
- formatting;
- recommendation logic;
- scan-warning interpretation

centralized in DealRadar.

A Slack delivery failure should not cause an otherwise successful import to fail.

## Partial scan failures

Scrapers may complete with warnings.

For example:

```text
6 pages attempted
5 succeeded
1 failed
```

This is different from:

- a failed scraper workflow;
- a failed DealRadar import.

Source feeds can expose partial scan information through `scan_status`.

DealRadar may import the valid published data while surfacing the partial failure as a warning.

## Failure philosophy

Prefer safe failure over guessing.

Examples:

- unknown currency → preserve source data rather than invent a normalized value;
- unreliable product image association → `null` is preferable to a wrong image;
- malformed optional metadata → ignore safely rather than fail a valid import;
- failed Slack notification → log it, but do not corrupt the import.

## Design principle

Keep source-specific extraction in `deals`.

Keep application semantics in `dealradar`.

When deciding where a change belongs, ask:

> Is this about understanding a retailer's data, or about what DealRadar means and does with that data?

The former normally belongs in `deals`.

The latter normally belongs in `dealradar`.