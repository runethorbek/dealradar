# DealRadar smoke-test failure localization

Companion to [`docs/smoke-test.md`](./smoke-test.md) (#52). Produced for #53.

This document does not redefine the smoke test's legs, steps, credentials,
data seeding, or overall pass/fail criteria — all of that remains
`docs/smoke-test.md`'s scope, unchanged. This document only adds, for each
checkpoint along the agreed Leg 3 critical path, the observable evidence
needed to localize a failure to a likely subsystem, using signals that
already exist in the current codebase (API responses, table/column values,
existing log lines, existing dashboard behavior, existing Slack messages).
It introduces no new logging, metrics, persisted audit state, or endpoints.

## How to use this document

Walk the checkpoints in order (they follow `docs/smoke-test.md`'s Step
numbers). Stop at the first checkpoint whose "expected value/state" is not
met, and read that checkpoint's "likely subsystem if it fails" — that is the
first place to look, not necessarily the final diagnosis. If a checkpoint
was never reached because an earlier one failed, its own evidence is not
informative and should not be treated as a new finding.

All SQL below is illustrative of what to inspect; run it against the same
non-production Neon branch configured as `DATABASE_URL` for the smoke test,
never production. All `curl` commands target the local `next dev` server
(`http://localhost:3000`), never the deployed production URL, per
`docs/smoke-test.md`'s safety constraints.

## Checkpoints

### Checkpoint 1 — Preflight: Postgres reachable (Step 4)

- **Evidence of success:** `GET /api/db-test` response body.
- **Where to inspect it:** `curl http://localhost:3000/api/db-test`
  (`app/api/db-test/route.ts`).
- **Expected value/state:** HTTP 200, `{"success": true, "databaseTime":
  "<timestamp>"}`.
- **Likely subsystem if it fails:**
  - HTTP 500 with `{"success": false, "error": "Database query failed:
    ..."}` → `DATABASE_URL` / the non-production Neon branch itself
    (connectivity, credentials, or the branch not existing yet — see
    `docs/smoke-test.md` Precondition 1).
  - HTTP 500 with `{"error": "DATABASE_URL is not configured on the
    server."}` → local environment configuration (`.env.local`), not
    Postgres itself.
  - `curl` fails to connect at all → the local `next dev` process is not
    running; not a Postgres problem.

### Checkpoint 2 — Preflight: Gemini reachable (Step 4)

- **Evidence of success:** `GET /api/gemini-test` response body.
- **Where to inspect it:** `curl http://localhost:3000/api/gemini-test`
  (`app/api/gemini-test/route.ts`).
- **Expected value/state:** HTTP 200, `{"success": true, "response":
  "<non-empty text>"}`. The route only checks that Gemini's response text is
  non-empty after trimming — it does not assert the exact echoed string, so
  do not treat minor wording differences as a failure.
- **Likely subsystem if it fails:** HTTP 500 with `{"success": false,
  "response": null, "error": "Gemini connectivity test failed."}` (or
  `"Gemini is not configured on the server."` if `GEMINI_API_KEY` is unset)
  → `GEMINI_API_KEY` / Gemini API reachability from the local `next dev`
  process, independent of anything else in the path. If this fails, Checkpoint
  7 will also fail, but Checkpoint 7 failing with this one passing points
  elsewhere (see Checkpoint 7).

### Checkpoint 3 — Preflight: Slack reachable (Step 4)

- **Evidence of success:** `POST /api/slack-test` response body, **and**
  visual confirmation of the test message in the non-production Slack
  channel.
- **Where to inspect it:** `curl -X POST http://localhost:3000/api/slack-test`
  (`app/api/slack-test/route.ts`); the non-production channel identified by
  `SLACK_CHANNEL_ID`.
- **Expected value/state:** HTTP 200, `{"success": true}`, and the message
  "DealRadar Slack integration is working." visible in the non-production
  channel within seconds.
- **Likely subsystem if it fails:**
  - HTTP 500 `{"error": "Slack is not configured on the server."}` →
    `SLACK_BOT_TOKEN`/`SLACK_CHANNEL_ID` not set locally.
  - HTTP 502 `{"error": "Slack rejected the message: <code>."}` → Slack API
    credential/permission problem; `<code>` is Slack's own `error` field
    (sanitized to `[a-z0-9_-]{1,100}` or else reported as `unknown_error` by
    `getSlackError` in `lib/slack.ts`) — e.g. `invalid_auth`,
    `channel_not_found`, `not_in_channel`.
  - **Ambiguous case:** `success: true` only proves Slack accepted the
    `chat.postMessage` call for whatever channel ID is currently configured
    — it does not by itself prove that is the intended non-production
    channel. A misconfigured `SLACK_CHANNEL_ID` pointing at a *different*,
    still-valid channel would pass this checkpoint's API response while
    silently posting to the wrong place. Only the manual visual check closes
    this gap; there is no API-observable signal for "posted to the correct
    channel."

### Checkpoint 4 — Import accepted (Step 6)

- **Evidence of success:** HTTP response from `POST
  /api/import-deals?ref=main`.
- **Where to inspect it:** the `curl` response body
  (`app/api/import-deals/route.ts`).
- **Expected value/state:** HTTP 200 with `"success": true`,
  `productsProcessed > 0`, `productsInserted > 0`, and `evaluationRunId`
  either a non-null ID or `null` (see `docs/smoke-test.md` Step 6 / Overall
  success criteria for how to interpret each case — not redefined here).
- **Likely subsystem if it fails:**
  - HTTP 401 `{"error": "Unauthorized."}` → `INGEST_API_KEY` /
    `Authorization` header mismatch — request-level auth, not the import
    pipeline.
  - HTTP 400 `{"error": "Invalid ref."}` → the `ref` query parameter itself.
  - HTTP 500 with a specific message such as `"Zalando feed returned HTTP
    404."`, `"<Source> feed does not contain a products array."`, `"<Source>
    feed product URL is invalid."`, or `"<Source> feed contains duplicate
    product URLs."` (thrown as `SourceDataError` and returned verbatim to
    the client) → the upstream `deals` feed itself, or DealRadar's feed
    validation (`validateFeed`/`fetchSourcePayload` in
    `app/api/import-deals/route.ts`) — the import/validation boundary, per
    `docs/architecture.md`'s import boundary, not persistence or evaluation.
  - HTTP 500 with the generic `"Database import failed."` → **ambiguous**,
    see below.
  - **Ambiguous case:** the generic `"Database import failed."` message is
    returned for *any* non-`SourceDataError` exception in the route's
    `try`/`catch`, which includes both real persistence failures
    (`persistImportedProducts`) **and** a durable evaluation-run launch
    failure (`startEvaluationRunWorkflow` throwing, re-thrown at
    `app/api/import-deals/route.ts:407-412`). The HTTP response body cannot
    distinguish these two very different subsystems. The only
    disambiguating signal is the server console: a persistence failure logs
    only `"[durable-import] import failed"` (with the underlying `error`),
    while a workflow-launch failure additionally logs
    `"[durable-launch] import workflow start failed"` immediately before it.
    Server console output is not exposed through any API/table today, so
    this distinction is only available to whoever is running `next dev`
    directly.

### Checkpoint 5 — Expected data persisted (Step 7)

- **Evidence of success:** rows in `products` (and, indirectly,
  `product_snapshots`).
- **Where to inspect it:**
  ```sql
  SELECT id, external_url, title, source, current_price, currency
  FROM products
  ORDER BY first_seen_at DESC
  LIMIT 5;
  ```
  Cross-check the row count against Checkpoint 4's `productsInserted`, and
  optionally confirm `product_snapshots` gained `snapshotsInserted` new rows
  (`product_id`/`current_price` from `migrations/001_initial_schema.sql`,
  `currency` added by `migrations/010_snapshot_currency.sql`).
- **Expected value/state:** rows matching the products from the fetched feed
  exist, with `first_seen_at`/`last_seen_at` timestamps at or just after the
  import.
- **Likely subsystem if it fails:** if Checkpoint 4 reported
  `productsInserted > 0` but no matching rows exist here, first confirm the
  query is running against the *same* non-production Neon branch configured
  as `DATABASE_URL` for the smoke test (an operator pointing `psql`/a SQL
  client at the wrong branch is a common false alarm, not a code defect).
  If confirmed to be the same database, this points at
  `lib/import-persistence.mts`'s `persistImportedProducts` — the persistence
  layer, not the feed/validation layer (which already succeeded, since
  Checkpoint 4 passed) and not evaluation (which has not run yet at this
  point).

### Checkpoint 6 — Evaluation started (Step 8, launch)

This is the "candidate selection led to a durable run actually starting to
process" checkpoint — distinct from Checkpoint 7, which is about a specific
Gemini call succeeding.

- **Evidence of success:** `evaluation_runs` and `evaluation_run_candidates`
  state for the `evaluationRunId` returned by Checkpoint 4, plus server
  console log lines from `workflows/evaluation-run-orchestration.ts`.
- **Where to inspect it:**
  ```sql
  SELECT id, status, launch_status, started_at, batches_processed
  FROM evaluation_runs
  WHERE id = <evaluationRunId>;

  SELECT product_id, status, claimed_at
  FROM evaluation_run_candidates
  WHERE run_id = <evaluationRunId>;
  ```
  Console log lines (in the still-running `next dev` terminal):
  `"[durable-launch] starting workflow"`, `"[durable-launch] workflow
  started"` (both include `runId`).
- **Expected value/state:** within seconds, `evaluation_runs.launch_status`
  moves from `'pending'` to `'started'`, `status` moves from `'pending'` to
  `'running'` with `started_at` populated, and at least one
  `evaluation_run_candidates` row's `status` moves from `'pending'` through
  `'processing'` (transiently, with `claimed_at` set) toward a terminal
  state (see Checkpoint 7).
- **Likely subsystem if it fails:**
  - `evaluation_runs.launch_status` stuck at `'pending'`, with server log
    `"[durable-launch] workflow start failed"` (includes the underlying
    `error`) → the durable execution/orchestration layer itself
    (`workflows/evaluation-run-orchestration.ts`, the Vercel Workflow "Local
    World" adapter) — not Gemini, not persistence.
  - `evaluation_runs.launch_status = 'started'` but `status` stays
    `'pending'`/`'running'` with no candidate ever reaching `'processing'`
    → the batch processor (`lib/evaluation-batches.mts`'s
    `processEvaluationBatch` / `claimNextEvaluationBatch`).
  - **Known environmental gotcha, not a code defect:** per
    `docs/smoke-test.md` Precondition 6, the Local World queue is in-process
    and in-memory. If the local `next dev` process was restarted or killed
    after Checkpoint 4's import request returned, any run still
    `'pending'`/`'running'` will appear identically "stuck" here whether or
    not the code itself is broken — the persisted state alone cannot tell
    the two apart (see [Ambiguous areas](#ambiguous-areas--observability-gaps)).

### Checkpoint 7 — Gemini result produced (Step 8, per candidate)

- **Evidence of success:** the specific candidate's terminal
  `evaluation_run_candidates.status`, plus the absence (success) or presence
  (failure) of a specific console warning.
- **Where to inspect it:**
  ```sql
  SELECT product_id, status, claimed_at
  FROM evaluation_run_candidates
  WHERE run_id = <evaluationRunId>;
  ```
  Console log line on failure only: `"DealRadar automatic evaluation
  failed."` (`lib/import-evaluation.mts:123`), which includes `productId`,
  `failureKind` (`rate_limit` | `transient` | `invalid_evaluation` |
  `permanent`), `status` (the HTTP status Gemini's SDK reported, if any),
  and — for `invalid_evaluation` — `validationCategory` (one of
  `empty_response`, `invalid_json`, `invalid_shape`, `unexpected_fields`,
  `missing_required_fields`, `invalid_scores`, `invalid_reason`, from
  `parseEvaluation` in `lib/product-evaluation.ts`).
- **Expected value/state:** the candidate reaches `status = 'completed'`
  with no matching warning logged. A candidate reaching `status = 'failed'`
  after the warning is logged with `retriesUsed: 3` is a valid, observed
  outcome of the real path (Gemini genuinely failed after exhausted
  retries), not itself evidence of a smoke-test defect.
- **Likely subsystem if it fails**, by `failureKind`/`validationCategory` in
  the warning log:
  - `rate_limit` (HTTP 429) or `transient` (408/5xx) → Gemini
    service-side (rate limiting or an outage), not a DealRadar defect.
  - `invalid_evaluation` with any `validationCategory` → Gemini returned a
    response `lib/product-evaluation.ts`'s schema/parsing did not accept.
    This is precisely the failure mode `docs/smoke-test.md`'s Purpose
    section names as the reason this smoke test exists (a Gemini
    model/response-shape change) — treat it as evidence of a schema or
    prompt/model drift, and check whether Checkpoint 2 (raw connectivity)
    still passes: if Checkpoint 2 passes but this fails, the problem is
    specific to `evaluateProduct`'s schema/prompt handling, not Gemini
    reachability.
  - `permanent` with no `validationCategory` → likely an
    authorization/model-availability error from Gemini distinct from
    connectivity — compare against Checkpoint 2's result for the same
    `GEMINI_API_KEY`.

### Checkpoint 8 — Evaluation/result persisted (Step 9)

- **Evidence of success:** a row in `product_evaluations`.
- **Where to inspect it:**
  ```sql
  SELECT product_id, preference_score, deal_score, reason,
    translated_listing_text_da, evaluated_at
  FROM product_evaluations
  ORDER BY evaluated_at DESC
  LIMIT 1;
  ```
- **Expected value/state:** one row, `evaluated_at` matching the recent run,
  `preference_score`/`deal_score` each an integer 0–10, non-empty `reason`.
  `translated_listing_text_da` may legitimately be `NULL` — it is
  Vinted-only optional enrichment (`getListingText`/
  `normalizeTranslatedListingText` in `lib/product-evaluation.ts`); a `NULL`
  here is not itself a failure signal, including for Zalando products.
- **Likely subsystem if it fails:** if Checkpoint 7 showed the candidate
  reached `status = 'completed'` (a real Gemini success, no warning logged)
  but no corresponding `product_evaluations` row exists, or its
  `evaluated_at` is stale — this is the narrow window between a successful
  Gemini call and its `INSERT ... ON CONFLICT` persistence, both inside the
  same `evaluateProduct` function
  (`lib/product-evaluation.ts:339-366`). Because that insert happens
  synchronously immediately after the Gemini call within the same function,
  this checkpoint failing while Checkpoint 7 passes is itself the anomaly —
  report it as a likely application-level persistence bug rather than an
  environment/credentials issue.

### Checkpoint 9 — Expected UI state visible (Step 10)

- **Evidence of success:** the evaluated product appears in the dashboard's
  default view with its evaluation-derived Overall score.
- **Where to inspect it:** `http://localhost:3000/` in a browser (default
  query params: `view=visible`, `freshness=24h`, `sort=best_match`, per
  `lib/dashboard-products.mts`/`lib/dashboard-freshness.mts`'s parsing
  defaults). There is no JSON/debug endpoint for this read path — `app/page.tsx`
  is a server component, not an API route — so this checkpoint cannot be
  checked with `curl` + a JSON assertion the way Checkpoints 1–8 can (see
  [Ambiguous areas](#ambiguous-areas--observability-gaps)).
- **Expected value/state:** the product renders with its price and an
  Overall score; the underlying query is
  `getLatestDashboardProducts` (`lib/dashboard-product-query.mts`), which
  LEFT JOINs `product_evaluations` and filters on `p.hidden = FALSE` (the
  default for newly imported products, per `migrations/007_product_visibility.sql`)
  and `p.last_seen_at >= NOW() - 24 hours`.
- **Likely subsystem if it fails:**
  - Page renders "Deals could not be loaded right now." (the `failed` state
    in `app/page.tsx`'s `getLatestProducts`) → a DB failure specific to the
    dashboard's own query path (including its own read of
    `application_settings`), which is a **separate** `try`/`catch` and
    `neon(databaseUrl)` call from `/api/db-test` — Checkpoint 1 passing does
    not guarantee this one will.
  - Page renders normally but the product is absent from the default view,
    while Checkpoint 8 confirmed its evaluation is persisted → check
    `products.hidden` (should be `FALSE`) and `products.last_seen_at`
    (must be within the last 24 hours) for that product — a dashboard
    read-path/filtering issue (`lib/dashboard-product-query.mts`) rather
    than evaluation or persistence, since the underlying evaluation data is
    already confirmed present.

### Checkpoint 10 — Slack notification delivered (Step 11)

- **Evidence of success:** the finalization message in the non-production
  Slack channel, plus `evaluation_runs` notification state.
- **Where to inspect it:** the non-production Slack channel
  (`SLACK_CHANNEL_ID`), and:
  ```sql
  SELECT id, status, notification_sent, notification_claimed_at, completed_at
  FROM evaluation_runs
  WHERE id = <evaluationRunId>;
  ```
- **Expected value/state:** `status = 'completed'`, `notification_sent =
  true`, and one new Slack message (produced by `finalizeEvaluationRun` in
  `lib/evaluation-finalization.mts`, via `formatImportSlackMessage` in
  `lib/import-notification.mts`). It references the evaluated product as the
  Zalando recommendation (`selectTopRecommendation`) unless the run's
  `watched_historical_lows` names a still-visible Watched Zalando product,
  which then takes precedence, or as the Vinted
  recommendation (`selectVintedRecommendation`) only when its unrounded
  Overall score is at least 7; see `docs/recommendation-policy.md`.
- **Likely subsystem if it fails**, given Checkpoint 8 already confirmed the
  evaluation is persisted and `evaluation_runs.status = 'completed'`:
  - `notification_claimed_at` is `NULL` and `notification_sent = false`
    with the run otherwise `'completed'` — this is the **common case for
    both** of the following, which cannot be told apart from this table
    alone:
    - the finalization step has not run at all yet, or the durable process
      was interrupted before reaching it (as with Checkpoint 6, this is
      indistinguishable from a genuine orchestration defect using
      persisted state alone if the local `next dev` process was stopped
      mid-run); or
    - finalization *did* run and the Slack delivery itself failed inside
      `finalizeEvaluationRun` — the claim taken just before the delivery
      attempt is reverted to `NULL` by `releaseEvaluationRunNotificationClaim`
      (`lib/evaluation-finalization.mts:69`) once the delivery fails, so a
      settled Slack failure looks identical, in this table, to "not yet
      run." The only trace this actually happened is the console log
      `"DealRadar Slack notification failed: unexpected_error."` — a
      generic message that does **not** include the specific Slack API
      error code (`getSlackError` in `lib/slack.ts` computes it, but
      `finalizeEvaluationRun`'s `catch` discards it before logging). See
      [Ambiguous areas](#ambiguous-areas--observability-gaps) item 7.
  - `notification_claimed_at` is non-null while `notification_sent =
    false` is a narrow, transient case: it only persists if the process
    crashed between claiming and either sending or releasing (or during
    the 15-minute claim window before `claimEvaluationRunNotification`'s
    own expiry lets another attempt reclaim it — see
    `lib/evaluation-runs.mts`). It is not the steady-state signature of a
    completed Slack failure; do not read a non-null
    `notification_claimed_at` as proof Slack was ever actually contacted.
  - If `evaluationRunId` was `null` (the zero-candidate path — see
    `docs/smoke-test.md`'s Overall success criteria #5), this checkpoint
    does not apply in this form; instead confirm the single direct-summary
    Slack message sent by `app/api/import-deals/route.ts` itself
    (`postSlackMessage` called inline, not through
    `finalizeEvaluationRun`) — a distinct code path from this checkpoint's.

## Ambiguous areas / observability gaps

Per #53's instruction to document a gap rather than invent evidence where
one exists:

1. **The import response's `evaluationMetrics` and `productsEvaluated`
   fields are always zero, structurally.** `app/api/import-deals/route.ts`
   builds and returns `evaluationMetrics`/`productsEvaluated: 0` *before*
   the durable evaluation run has done any work (evaluation happens
   asynchronously after the response is sent) — confirmed by
   `tests/import-deals-route-authentication.test.mts`'s assertion of an
   all-zero `evaluationMetrics` object even when a run is created. These
   fields cannot be used as evidence for Checkpoints 6–8 despite their
   names; only the database state and console logs described above can.
2. **A generic `"Database import failed."` response (Checkpoint 4)
   conflates two different subsystems** — real persistence failures and
   durable-workflow-launch-start failures — and the HTTP response alone
   cannot distinguish them (see Checkpoint 4).
3. **A Slack delivery failure inside finalization (Checkpoint 10) logs a
   generic message that drops the specific Slack API error code.** The
   code to compute it exists (`getSlackError` in `lib/slack.ts`) but is not
   threaded into `finalizeEvaluationRun`'s log line.
4. **There is no JSON/debug endpoint for dashboard/UI state (Checkpoint
   9).** Unlike every other checkpoint, this one cannot be verified with a
   scriptable `curl`/SQL check against the exact code path a user or agent
   would otherwise need to render `/` (or independently replicate
   `getLatestDashboardProducts`'s filter semantics via SQL, which exercises
   the same logic but not the same code).
5. **A stalled durable run (Checkpoints 6 and 10) is indistinguishable, from
   persisted state alone, between "the orchestration code is broken" and
   "the local `next dev` process was restarted mid-run."** Per
   `docs/smoke-test.md` Precondition 6, the Local World queue is
   in-process; only operator awareness of whether `next dev` kept running
   resolves this, which is not a signal available in any table or log.
6. **`/api/slack-test` returning `success: true` (Checkpoint 3) does not
   itself prove delivery to the *intended* channel** — only the required
   manual visual confirmation in the channel does. An agent without
   separate Slack read access cannot close this gap on its own.
7. **A settled Slack-delivery failure inside finalization (Checkpoint 10)
   is indistinguishable, from `evaluation_runs` table state alone, from
   finalization simply not having run yet.** `releaseEvaluationRunNotificationClaim`
   resets `notification_claimed_at` back to `NULL` once a delivery attempt
   fails (`lib/evaluation-finalization.mts:69`), so both cases leave
   `notification_claimed_at = NULL, notification_sent = false` on an
   otherwise `'completed'` run. This is distinct from item 5 above (which
   is about a stalled run generally): here, the ambiguity exists even when
   `next dev` never stopped and nothing crashed — only the generic console
   log described in item 3 (if the process is still running and its
   console is visible) distinguishes "it ran and failed" from "it hasn't
   run yet."

## Verification

This document was produced and checked against the current source without
live non-production Neon/Gemini/Slack credentials, matching the same
constraint `docs/smoke-test.md`'s own "Verification status" section
recorded for Leg 3 (this repository's local `.env.local` defines only
`VERCEL_OIDC_TOKEN`). Within that constraint:

- Every table/column name, route path, response field, status value, and
  log message string cited above was confirmed by reading the current
  source directly (`app/api/import-deals/route.ts`,
  `app/api/db-test/route.ts`, `app/api/gemini-test/route.ts`,
  `app/api/slack-test/route.ts`, `lib/evaluation-runs.mts`,
  `lib/evaluation-batches.mts`, `lib/evaluation-finalization.mts`,
  `lib/product-evaluation.ts`, `lib/import-evaluation.mts`,
  `lib/import-notification.mts`, `lib/slack.ts`,
  `lib/dashboard-product-query.mts`, `app/page.tsx`, `lib/dashboard-freshness.mts`,
  `workflows/evaluation-run-orchestration.ts`, and
  `migrations/005`, `007`, `013`, `016`, `017`, `018`–`022`), not inferred.
- `npm run build` and `npm test` were re-run against the current `main`
  while producing this document: build succeeded and all four grouped
  `node --test` invocations passed (274 tests, `fail 0` in each group).
- **Induced early failure (Checkpoint 4):** verified against the existing,
  already-passing deterministic test
  `tests/import-deals-route-authentication.test.mts`, whose `"fails when a
  required active feed is unavailable"` case returns HTTP 500 with the
  exact `SourceDataError` message documented above (e.g. `"Zalando feed
  returned HTTP 404."`), and whose bearer-credential test returns exactly
  the HTTP 401 body documented for the same checkpoint. This confirms the
  documented evidence for an early failure matches actual code behavior.
- **Induced late failure (Checkpoint 10):** verified against the existing,
  already-passing deterministic tests in `tests/evaluation-finalization.test.mts`,
  in particular `"a Slack failure remains terminal and cannot trigger
  another delivery or Gemini work"` and `"a thrown Slack error is non-fatal
  after the one persisted claim"`, both of which exercise exactly the claim/
  release/generic-log behavior documented above for a late-stage Slack
  delivery failure.
- No production database was queried and no production Slack message was
  sent while producing this document; only source reading and the existing,
  already-mocked deterministic suite were used.
- **Not verified end-to-end against a live non-production environment**,
  for the same reason Leg 3 itself is marked "designed and believed
  executable... but not yet empirically confirmed end-to-end" in
  `docs/smoke-test.md`. Whoever performs that first live walkthrough should
  confirm this document's checkpoints against what they actually observe
  and correct any drift here.
