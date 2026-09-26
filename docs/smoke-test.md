# DealRadar live system smoke test

Defines a high-value, live smoke test for DealRadar's critical path: an
imported deal reaching evaluation and a visible/notified result, using real
external systems (Postgres, Gemini, Slack) rather than the mocks the
deterministic suite (`npm test`) uses.

Produced for #52, a follow-up to #48 (`docs/test-audit.md`, Sections 5–6).
This document defines **what runs, on what, and when**. It does not define
per-checkpoint failure localization — see
[`docs/smoke-test-diagnostics.md`](./smoke-test-diagnostics.md) (#53) and
[Relationship to #51, #53, #54](#relationship-to-51-53-54).

## Purpose

The deterministic suite mocks every external boundary: Postgres via
hand-written simulators, Gemini via `@google/genai` mocks, Slack via a
mocked `postSlackMessage`. It is good at catching logic regressions; it
cannot catch a Gemini model/response-shape change, a Slack
credential/permission change, a real Postgres/JSONB mismatch, or a wiring
break between real subsystems. This smoke test exists to catch that
category of failure. It is not a re-verification of logic `npm test`
already covers.

## Scope

### In scope

The critical path, in three legs (see [Exact smoke-test steps](#exact-smoke-test-steps)):

1. Build/typecheck + the existing deterministic suite.
2. A real-Postgres round trip: migrations → import persistence → dashboard
   read, via the existing `npm run test:integration` (#51).
3. The live end-to-end path: real `POST /api/import-deals` → real Neon-class
   Postgres persistence (a non-production branch) → real candidate
   selection → real durable evaluation batch → real Gemini call → persisted
   evaluation → dashboard visibility → real Slack delivery, run against a
   non-production environment with Gemini evaluation bounded to exactly one
   product.

### Explicit exclusions

- **The `deals` scraper repository's execution itself.** Out of repository
  boundary per `docs/architecture.md`. This smoke test only reads the
  already-published feed JSON that `deals` produces; it never triggers a
  scrape.
- **A full/unbounded automated import.** The live leg deliberately imports
  whatever the current feed contains (see
  [Data seeding](#what-data-needs-to-be-seeded-or-imported)) but bounds
  evaluation to one candidate; it is not a load or volume test.
- **The manual per-product evaluation path (`POST /api/evaluate-product`).**
  Already has strong deterministic coverage
  (`evaluate-product-route-authentication.test.mts`, rated "Strong" in
  `docs/test-audit.md` Section 3) and requires an owner-authenticated
  browser session (real Google OAuth login), which this document does not
  attempt to script. If you want to exercise it live, sign in as the
  configured `OWNER_EMAIL` against the non-production deployment and use the
  dashboard's Evaluate action on one product — this is a useful
  supplementary check but is not part of the smoke test's pass/fail
  criteria.
- **Checkpoint-level failure localization.** That is #53's scope; see
  [Relationship to #51, #53, #54](#relationship-to-51-53-54).
- **Fixing the diagnostic routes' missing owner-authorization check.**
  `/api/db-test`, `/api/db-schema-test`, `/api/gemini-test`, and
  `/api/slack-test` have no owner-authorization check in the current source
  (confirmed by reading each route for this document). This is the same
  fact `docs/test-audit.md` Section 6 surfaced. This document reuses those
  routes as preflight checks but does not add authorization to them — doing
  so is a separate, security-relevant change requiring its own review.
- **CI wiring.** Leg 1 could in principle run in CI; that decision belongs
  to #54, not here.

## Preconditions

1. **A non-production Postgres database exists.** Recommended: a dedicated
   Neon branch of the DealRadar project (e.g. `smoke-test`), never the
   production branch/database. Apply `migrations/001` through the latest
   migration to it in numeric order, exactly as they are applied to
   production (`docs/architecture.md`: "Migrations are currently applied
   manually to Neon"). This branch does not exist today as far as this
   repository's contents show — creating it is a one-time manual setup step
   for the repository owner, not something this document or an agent
   provisions automatically.
2. **A non-production Slack channel exists**, and the same (or a separate)
   Slack bot has permission to post to it. This channel does not exist
   today as far as this repository's contents show; creating it is a
   one-time manual setup step for the repository owner.
3. **A `GEMINI_API_KEY` with quota headroom for at least one evaluation
   call** (with its bounded retries — see
   [Preventing excessive Gemini quota use](#preventing-excessive-gemini-quota-use)).
4. **`automaticEvaluationLimit` is set to `1`** on the non-production
   database before running the live leg (see
   [Preventing excessive Gemini quota use](#preventing-excessive-gemini-quota-use)).
   The minimum allowed value is `1`, not `0`
   (`lib/gemini-settings.mts`); there is no way to run the live leg with
   zero Gemini spend, only with spend bounded to one product.
5. **Docker installed and running locally**, for Leg 2
   (`npm run test:integration` already requires this per
   `docs/architecture.md`).
6. **The smoke test is run from a local `next dev` process**, not against
   the deployed production URL. This is what makes Leg 3 executable without
   a separate staging Vercel deployment: the `workflow` package (imported in
   `next.config.ts` via `withWorkflow`) automatically uses its zero-config,
   in-process "Local World" whenever the app runs under `next dev` — no
   Vercel deployment, and no additional configuration, is required for the
   durable evaluation batch, Gemini call, and finalization/Slack step to
   actually execute (`node_modules/workflow/docs/deploying/index.mdx`,
   `.../world/local-world.mdx`). This also means the local `next dev`
   process must stay running for the full duration of the live leg,
   including the polling step after the import request returns (see
   [Step 8](#step-8-wait-for-and-observe-the-durable-evaluation-run)) — the
   Local World's queue is in-memory and tied to that process.

## Required environment/credentials

Set these only in a local `.env.local` (or equivalent local shell
environment) used for this smoke test — never in the production Vercel
project's environment, and never commit them:

| Variable | Value for this smoke test | Used by |
| --- | --- | --- |
| `DATABASE_URL` | Connection string for the **non-production** Neon branch | `/api/import-deals`, dashboard, evaluation, finalization |
| `GEMINI_API_KEY` | A real Gemini API key with quota headroom | `/api/import-deals` (durable evaluation), `/api/gemini-test` |
| `SLACK_BOT_TOKEN` | A real Slack bot token authorized to post to the non-production channel | Finalization, `/api/slack-test` |
| `SLACK_CHANNEL_ID` | The **non-production** Slack channel's ID | Finalization, `/api/slack-test` |
| `INGEST_API_KEY` | Any value you choose locally; must match the bearer token you send | `/api/import-deals` authorization |
| `OWNER_EMAIL` | Only needed if you also want to sign in and use the dashboard's Evaluate/Hide/Watch actions manually | Owner-gated mutating routes (not required for the core live leg) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Only needed for the manual owner sign-in above | NextAuth |

`DATABASE_URL`, `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID`, and
`INGEST_API_KEY` were not present in this repository's local `.env.local`
at the time this document was written (only `VERCEL_OIDC_TOKEN` was set) —
none of them are checked in, and none should be.

## What data needs to be seeded or imported

None needs to be hand-seeded for the live leg. `POST /api/import-deals`
fetches the real, currently published `deals` feeds
(`public/deals/zalando-latest.json`, `public/deals/vinted-latest.json`) at
the given `ref` — this is a real, read-only HTTP fetch against the sibling
repository's published output, not a live scrape. Because the
non-production database starts empty, most or all fetched products will be
treated as new/eligible candidates by the existing deterministic
preselection (`docs/architecture.md`, "Evaluation prioritization policy");
`automaticEvaluationLimit = 1` bounds how many of them are actually
evaluated, regardless of how many are eligible.

Leg 2 (`npm run test:integration`) uses its own small synthetic 2–3 product
feed defined directly in the test file — no seeding needed.

## Preventing excessive Gemini quota use

Set `automaticEvaluationLimit` to `1` directly against the non-production
database before running the live leg:

```sql
UPDATE application_settings
SET gemini = jsonb_set(gemini, '{automaticEvaluationLimit}', '1')
WHERE id = 1;
```

This bounds the durable evaluation batch to exactly one real product per
import. A single evaluated candidate can still generate more than one
Gemini API call if the first attempt is retried under the existing 5s/10s/20s
backoff policy (#35) — bounded, but not exactly one HTTP call. This is the
minimum possible; `parseGeminiSettings` rejects `0`
(`lib/gemini-settings.mts`).

## Preventing production DB mutation

- `DATABASE_URL` in the local smoke-test environment must point at the
  non-production Neon branch, never production. There is no code-level
  guard against pointing it at production — this is an operator discipline
  requirement, the same as the deploy-time `DATABASE_URL` configuration
  already is.
- Never run this document's steps against the deployed production URL.
  `/api/import-deals`, `/api/db-test`, `/api/gemini-test`, and
  `/api/slack-test` all exist in production too; running this smoke test's
  requests against the production URL would use production's configured
  credentials regardless of what your local `.env.local` contains.

## Preventing production Slack messages

- `SLACK_CHANNEL_ID` in the local smoke-test environment must be the
  non-production channel. `lib/slack.ts` posts to whatever channel ID is
  configured — there is no environment-aware branching in the code itself.
- If reusing the same production Slack bot token, confirm before running
  that `SLACK_CHANNEL_ID` is the test channel, not the production
  notification channel it is normally configured with.

## Exact smoke-test steps

### Leg 1 — build and deterministic suite

**Step 1: Type-check and build.**

```bash
npm run build
```

Expected observable result: exits 0; output includes `workflows build
complete` (confirms the workflow plugin recognizes
`processEvaluationRunWithWorkflow` and its steps) and `Compiled
successfully`.

**Step 2: Run the fast deterministic suite.**

```bash
npm test
```

Expected observable result: exits 0; final summary across all four grouped
`node --test` invocations reports `fail 0` for each group.

Both commands were run against this repository while writing this document
and passed (93 tests total across the four groups; clean build).

### Leg 2 — real Postgres round trip (no Neon, no Gemini, no Slack)

**Step 3: Run the real-database integration test.**

```bash
npm run test:integration
```

Expected observable result: exits 0. Per `docs/architecture.md`, this
starts an ephemeral Testcontainers PostgreSQL container, applies
`migrations/001`–latest in order, persists a synthetic 3-product feed
through the real `persistImportedProducts`, and reads it back through the
real `getLatestDashboardProducts`, asserting the returned rows/ordering
match. Requires Docker; not part of `npm test`; never touches Neon.

This step exercises real Postgres/JSONB/constraint behavior for the
persistence and dashboard-query layers without needing a non-production
Neon branch, Gemini, or Slack — it is the cheapest real-external-system leg
and can be run far more often than Leg 3.

### Leg 3 — live end-to-end path

Run everything below with `next dev` started against the non-production
environment variables from
[Required environment/credentials](#required-environment-credentials).

**Step 4: Preflight — confirm each credential independently before the
combined run.**

Against the locally running server (`http://localhost:3000`), **never**
against the deployed production URL:

```bash
curl http://localhost:3000/api/db-test
curl http://localhost:3000/api/gemini-test
curl -X POST http://localhost:3000/api/slack-test
```

Expected observable result: each returns `{"success": true, ...}`. `db-test`
confirms `DATABASE_URL` reaches a live Postgres and returns
`databaseTime`. `gemini-test` confirms `GEMINI_API_KEY` gets a real
completion back. `slack-test` posts "DealRadar Slack integration is
working." to `SLACK_CHANNEL_ID` — **confirm this lands in the
non-production channel before proceeding.**

These three routes have no owner-authorization check in the current source;
reusing them here is intentional (per #52's constraints) and does not
change that fact.

**Step 5: Confirm the evaluation limit is bounded.**

Run the SQL from
[Preventing excessive Gemini quota use](#preventing-excessive-gemini-quota-use)
against the non-production database, then confirm:

```sql
SELECT gemini FROM application_settings WHERE id = 1;
```

Expected observable result: `gemini->>'automaticEvaluationLimit'` is `1`.

**Step 6: Trigger the live import.**

```bash
curl -X POST "http://localhost:3000/api/import-deals?ref=main" \
  -H "Authorization: Bearer $INGEST_API_KEY"
```

Expected observable result: HTTP 200 with a JSON body including
`"success": true`, `productsProcessed` > 0, `productsInserted` > 0 (since
the non-production database starts empty), and either:
- `evaluationRunId` is a non-null ID (candidates were selected — the
  expected case for a first run against an empty database), or
- `evaluationRunId` is `null` and the response otherwise indicates zero
  candidates were selected (acceptable but less informative for this
  smoke test — see
  [Overall success criteria](#overall-success-criteria)).

**Step 7: Confirm real persistence.**

```sql
SELECT id, external_url, title, source, current_price, currency
FROM products
ORDER BY first_seen_at DESC
LIMIT 5;
```

Expected observable result: rows matching products from the fetched feed
exist in the non-production database.

**Step 8: Wait for and observe the durable evaluation run.**

`startEvaluationRunWorkflow` does not block the import response — the
workflow runs asynchronously in the still-running `next dev` process
(Local World). Poll:

```sql
SELECT id, status, notification_sent, started_at, completed_at
FROM evaluation_runs
ORDER BY id DESC
LIMIT 1;

SELECT product_id, status
FROM evaluation_run_candidates
WHERE run_id = (SELECT id FROM evaluation_runs ORDER BY id DESC LIMIT 1);
```

Expected observable result, within a short wait (seconds, not minutes, for
a single bounded candidate): `evaluation_runs.status = 'completed'`,
`notification_sent = true`, and the one candidate row's `status =
'completed'` (or `'failed'` if Gemini genuinely failed after exhausting
retries — still a valid, observed run of the real path).

**Step 9: Confirm the evaluation was persisted.**

```sql
SELECT product_id, preference_score, deal_score, reason, evaluated_at
FROM product_evaluations
ORDER BY evaluated_at DESC
LIMIT 1;
```

Expected observable result: one row, with `evaluated_at` matching the
recent run, `preference_score`/`deal_score` each an integer 0–10, and a
non-empty `reason` — the real Gemini output, parsed and persisted by
`lib/product-evaluation.ts`'s `parseEvaluation`.

**Step 10: Confirm UI visibility.**

Open `http://localhost:3000/` (the local dev server, pointed at the
non-production database).

Expected observable result: the evaluated product is visible in the
dashboard's default view, showing its price and an Overall score derived
from the persisted preference/deal scores.

**Step 11: Confirm Slack delivery.**

Check the non-production Slack channel.

Expected observable result: one new message from the finalization step
(`finalizeEvaluationRun` → `formatImportSlackMessage`), with the import
summary showing `1 evaluated`. The evaluated product appears as the
"Zalando recommendation" (`selectZalandoFallbackRecommendation`) or the
"Vinted recommendation" (`selectVintedRecommendation`) for its source only
when its unrounded Overall score is at least 7
(`docs/recommendation-policy.md`); a message without a recommendation is then
correct, not a failure. For Zalando, a visible Watched Zalando product with a
watched historical-low event in this import (recorded in
`evaluation_runs.watched_historical_lows`) takes precedence.

## Real vs mocked/fixture-backed boundaries

| Step | Postgres | Gemini | Slack | Notes |
| --- | --- | --- | --- | --- |
| Leg 1 (build, `npm test`) | Mocked/simulated | Mocked | Mocked | Unchanged from the existing deterministic suite. |
| Leg 2 (`npm run test:integration`) | **Real** (ephemeral, disposable) | Not exercised | Not exercised | Real migrations + real persistence/dashboard-query SQL; synthetic data. |
| Leg 3, steps 4–5 (preflight) | **Real** (`db-test`) | **Real** (`gemini-test`, one connectivity call) | **Real** (`slack-test`, one test message) | Isolated per-system checks before the combined run. |
| Leg 3, steps 6–11 (live import) | **Real** (non-production Neon branch) | **Real** (bounded to 1 candidate) | **Real** (non-production channel) | The only leg that exercises the full path end-to-end for real. |
| `/api/evaluate-product` (manual, excluded from pass/fail) | Real if exercised | Real if exercised | N/A | Requires owner browser login; already strongly covered deterministically. |

## Overall success criteria

The smoke test as a whole passes when:

1. Leg 1 and Leg 2 both exit 0.
2. Leg 3's preflight checks (Step 4) all return `success: true`, with the
   Slack test message confirmed in the non-production channel.
3. Leg 3's import (Step 6) returns HTTP 200 with `success: true` and
   `productsInserted > 0`.
4. **If** `evaluationRunId` was non-null (candidates were selected — expected
   against an empty non-production database): the run reaches
   `evaluation_runs.status = 'completed'` with `notification_sent = true`
   (Step 8), a `product_evaluations` row exists for the evaluated product
   (Step 9), the product is visible on the dashboard (Step 10), and the
   non-production Slack channel received the finalization message
   (Step 11).
5. **If** `evaluationRunId` was null (zero candidates selected — possible if
   the current live feed happens to contain nothing new relative to what
   the non-production database already holds on a re-run): the import's own
   direct Slack summary path still fires. This is a materially weaker pass
   for this smoke test's purpose, since it does not exercise Gemini or the
   durable evaluation path; if this happens on the intended first run
   against an empty database, treat it as a failure to investigate rather
   than a pass, since the feed should produce at least one new-product
   candidate.

A failure at any step is a failure of the smoke test as a whole for that
run. Localizing *which* subsystem caused a given failure is #53's scope,
not this document's.

## Safety constraints (summary)

- Never point the smoke test's `DATABASE_URL` at production.
- Never point the smoke test's `SLACK_CHANNEL_ID` at the production
  notification channel.
- Never run any step of this document against the deployed production URL
  — only against a locally running `next dev` process configured with the
  non-production credentials above.
- Always set `automaticEvaluationLimit = 1` on the non-production database
  before Step 6.
- Do not add authorization to `/api/db-test`, `/api/gemini-test`, or
  `/api/slack-test` as part of running this smoke test.
- Do not commit `.env.local` or any credential used for this smoke test.

## Recommended run cadence/triggers

Per `docs/test-audit.md` Section 5's original suggestions, refined here:

- **Leg 1 and Leg 2:** before merging any change to `migrations/`, the
  import route's persistence path, or `lib/dashboard-product-query.mts`;
  Leg 1 alone is cheap enough to run on every push once #54 adds CI (that
  decision belongs to #54, not this document).
- **Leg 3 (live):** manually, non-routinely —
  - before a production deploy that touches the import → evaluation →
    finalization → Slack path;
  - after upgrading `@google/genai` or `workflow`;
  - after changing the Gemini evaluation prompt/schema
    (`lib/product-evaluation.ts`);
  - after rotating `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`, or
    `SLACK_CHANNEL_ID`;
  - after changing `lib/slack.ts`, `lib/evaluation-finalization.mts`,
    `workflows/evaluation-run-orchestration.ts`, or the durable batch
    processor.

## Relationship to #51, #53, #54

- **#51** (closed) built the real-Postgres integration test this document
  reuses unchanged as Leg 2 (`npm run test:integration`). This document
  does not redefine or duplicate that test; it only cites it as one leg of
  the smoke test.
- **#53** extends this document with per-checkpoint evidence, "where to
  inspect it," and "likely failed subsystem" for each step above, in
  [`docs/smoke-test-diagnostics.md`](./smoke-test-diagnostics.md). This
  document intentionally stops at "what runs and what the expected result
  is" — it does not attempt checkpoint-level failure localization, which is
  #53's distinct deliverable.
- **#54** owns CI wiring and the branch/PR/merge gate. Leg 1 of this
  document is a candidate for that gate; Leg 2 is explicitly deferred to a
  later, separate CI decision per #51's own constraints; Leg 3 is out of
  scope for CI entirely (live credentials, real Gemini quota, real Slack
  messages) and is not proposed for automation here.

## Verification status

This document was produced by reading the current source
(`app/api/import-deals/route.ts`, `app/api/db-test/route.ts`,
`app/api/gemini-test/route.ts`, `app/api/slack-test/route.ts`,
`app/api/evaluate-product/route.ts`, `lib/slack.ts`,
`lib/product-evaluation.ts`, `lib/evaluation-finalization.mts`,
`lib/gemini-settings.mts`, `lib/owner-authorization.mts`, `auth.ts`,
`app/page.tsx`, `workflows/evaluation-run-orchestration.ts`,
`tests/integration/import-persistence-dashboard.test.mts`, and the relevant
migrations), `docs/architecture.md`, `docs/test-audit.md`, and the
`workflow` package's bundled documentation
(`node_modules/workflow/docs/deploying/`), then walking through what is
actually executable:

- **Leg 1 (build + `npm test`): actually run and verified passing** while
  producing this document (`npm run build` and `npm test` both exited 0
  against this repository's current `main`).
- **Leg 2 (`npm run test:integration`): not run while producing this
  document.** Docker was not available in the environment used to write
  this document. The test itself already exists (from #51) and is
  documented in `docs/architecture.md` as requiring Docker; its mechanism
  was read and confirmed sound, but its actual execution was not
  re-verified here.
- **Leg 3 (live end-to-end path): not run while producing this document.**
  No non-production `DATABASE_URL`, `GEMINI_API_KEY`, `SLACK_BOT_TOKEN`,
  `SLACK_CHANNEL_ID`, or `INGEST_API_KEY` were available in this
  environment (the local `.env.local` present in this repository defines
  only `VERCEL_OIDC_TOKEN`). Per #52's verification requirement, this leg
  must be manually walked through at least once by someone with real
  non-production credentials before this document's Leg 3 can be called
  confirmed rather than specified. Until that walkthrough happens and is
  recorded here (or in a follow-up note), treat Leg 3 as **designed and
  believed executable based on reading `workflow`'s Local World
  documentation and the application code it drives, but not yet
  empirically confirmed end-to-end.**
