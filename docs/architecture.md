# DealRadar Architecture

## Purpose

DealRadar is a personal deal-tracking system that collects product data from external sources, normalizes and stores it, evaluates products against user preferences, and surfaces relevant recommendations in the web application and Slack.

The system is intentionally split across two repositories:

- `runethorbek/deals` — scraping and source-specific extraction
- `runethorbek/dealradar` — normalization, persistence, evaluation, ranking, UI, and notifications

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
- a retired source's product/image association;
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
- preferences;
- Gemini evaluation;
- ranking;
- the web application;
- Slack notifications.

Examples:

- converting source prices to normalized DKK when an active feed requires it;
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
Source price:
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
- preference profile;
- latest evaluation.

Schema changes are represented as numbered SQL migrations under `migrations/`.

Migrations are currently applied manually to Neon.

Adding a migration file does not modify the production database automatically.

### Real-PostgreSQL integration test

`npm test` is fully deterministic and requires no database. A separate,
Docker-based integration test additionally proves the current
`migrations/*.sql` files apply cleanly, in order, against a real disposable
PostgreSQL instance, and that the real import-persistence and dashboard-query
code (`lib/import-persistence.mts`, `lib/dashboard-product-query.mts`)
round-trip a small synthetic product feed correctly.

- Prerequisite: Docker installed and running locally.
- Command: `npm run test:integration`.
- This is not part of `npm test` and is not wired into CI (see #54). It
  starts and tears down its own ephemeral Postgres container
  (via Testcontainers) per run; it never touches Neon or any shared database.

## Evaluation

Gemini is an evaluation service, not the system of record.

DealRadar supplies the relevant product, preference, and price-history context.

Gemini returns structured evaluation output.

Persistent memory remains in DealRadar/Neon.

Durable evaluation runs are application-owned Postgres state. The current
Vercel Workflow adapter invokes bounded application batches, while persisted
pending, processing, completed, and failed candidate state determines recovery.
Normal imports persist a selected run and enqueue that adapter before returning;
they do not wait for Gemini. Once every selected candidate is terminal, the
application finalizer reads the persisted run and evaluations, selects the
per-source recommendations (using watched historical-low events that the
import detected from its inserted snapshots and recorded with the run), and makes one claimed final Slack delivery attempt. Imports
with no selected candidates send the normal no-evaluation summary directly and
do not create an empty durable run.

Gemini preferences are soft user guidance supplied to Gemini. Application
settings are separate deterministic behavior. For Vinted, configured minimum
article condition and excluded brands preselect eligible import candidates
before the existing evaluation ranking and configured automatic-evaluation
limit (default 50); Zalando does not use these rules. Missing or unknown
Vinted condition and brand values are eligible.

### Evaluation prioritization policy

DealRadar prioritizes current products deterministically per import.
Historical evaluation completeness is not a system goal. Four concerns are
distinct and must not be conflated:

- **Candidate selection** decides which products are eligible at all: Zalando
  candidates are new or price-changed products; Vinted candidates additionally
  pass the deterministic brand/condition preselection above. Both are ordered
  deterministically (new products first, then by price-drop and discount
  percentage).
- **Configured workload limit** (`automaticEvaluationLimit`, default 50)
  bounds how many of those ordered candidates one import selects. Eligible
  candidates beyond the limit are intentionally skipped for that import. They
  are not written to any table and are not queued for a later run — DealRadar
  prioritizes the current import's most relevant deals over evaluating every
  eligible product eventually.
- **Durable recovery** only applies after a candidate has been selected and
  persisted as `evaluation_run_candidates` state. From that point, the
  existing durable batch processor owns it until it reaches a terminal
  `completed` or `failed` outcome, including recovering interrupted
  pending/processing work. Recovery never reaches back to reconsider products
  that were never selected.
- **Historical backfill** — re-evaluating products that were skipped by the
  limit, excluded by preselection, or left `failed` after exhausting retries —
  is explicitly not implemented. There is no backlog/queue mechanism; a
  terminal failure is a terminal outcome, not a retry candidate. See #12 and
  #43: the durable evaluation-run architecture was assessed against this
  question and no backfill mechanism was added.

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

Recommendation selection rules, per source, are defined in
`docs/recommendation-policy.md`.

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
