# DealRadar test coverage and verification audit

> Note: product feedback (Like / Not for me), `POST /api/product-feedback`, and
> the `product-feedback-*.test.mts` tests were removed in #66. References to
> them below are historical.

Investigation-only audit produced for issue #48. No production code, tests,
migrations, workflows, configuration, or generated output were changed while
producing this report. All findings are based on reading the current test
suite (`tests/*.test.mts`), the library/route/workflow code it exercises, the
migrations under `migrations/`, and `docs/architecture.md`,
`docs/import-contract.md`, `docs/ubiquitous-language.md`, and
`docs/adr/0001-vercel-workflow-platform-boundary.md`.

The issue template originates from the sibling `deals` (scraper) repository
and lists scraper-shaped categories (retailer parsing, scan diagnostics,
fail-closed publication). Per the template's own instruction to "adjust the
categories if the actual repository structure suggests a better grouping,"
this report maps to DealRadar's actual responsibilities as defined in
`docs/architecture.md`: import validation/normalization, persistence and
dashboard querying, Gemini evaluation, durable evaluation-run orchestration,
ranking, Slack notification, and the web UI.

Test counts and line numbers below reflect the suite at the time of this
audit (`git log` HEAD: `6c20592`).

## 1. Executive summary

**Overall quality:** The suite is substantial (29 test files, ~5,900 lines)
and unusually good at boundary-value and cross-formula consistency testing
(exact percentage thresholds, 0/100 weighting boundaries, three independent
implementations of the Overall-score formula checked against each other).
Authentication/authorization gating is tested at every mutating API route,
consistently checking that persistence is not invoked before authorization
succeeds. Domain-language invariants from `docs/ubiquitous-language.md`
(Watch/Hide/Like independence, price-drop highlight tiers) have explicit,
named test coverage.

**Strongest areas:**
- Owner authentication/authorization gating (every mutating route checks 401
  before 403 before persistence, with call-count assertions proving
  short-circuiting).
- Ranking/score-weighting consistency across its three implementations (SQL,
  Slack recommendation, dashboard display).
- Deterministic preselection and evaluation-limit policy (#34/#36) and the
  durable batch processor's retry/resume/claim semantics (#35, Slice 4).
- Vinted display-title assembly and Slack message HTML-escaping.

**Most important gaps:**
- **No test in the suite executes against a real PostgreSQL instance.**
  Every "database" test is either (a) a hand-written in-memory function that
  pattern-matches query text and simulates results, or (b) a regex assertion
  against migration file text. SQL syntax errors, real JSONB/CTE semantics,
  and constraint behavior are not verified by any deterministic test in this
  repository.
- `lib/slack.ts` (the only code that actually calls the Slack HTTP API) has
  no direct test; it is mocked away everywhere it is used.
- The manual per-product evaluation path (`/api/evaluate-product`, backed by
  `lib/product-evaluation.ts`) and the automated import/durable-batch
  evaluation paths (`lib/import-evaluation.mts`, `lib/evaluation-batches.mts`)
  are tested with completely separate fakes; no test confirms both paths
  actually call the same real Gemini-evaluation function with a consistent
  contract.
- Only 3 of 25 migrations (009, 023, plus the 013–022 evaluation-run cluster)
  have any content-level test; the foundational schema and several
  feature migrations (001–008, 010–012, 024, 025) have none.
- The unauthenticated diagnostic routes (`/api/db-test`, `/api/db-schema-test`,
  `/api/gemini-test`, `/api/slack-test`) have no tests and, on inspection,
  no owner-authorization check at all.
- There is no CI workflow in this repository (`.github/workflows` does not
  exist); `npm test` is not run automatically on push or before deploy.

**Misleading/low-value coverage patterns:** several `dashboard-products-query`
assertions check for specific regex fragments of generated SQL text rather
than observable behavior against a real database; passing tests there confirm
internal consistency between the test's own SQL simulator and the query
builder, not correctness against Postgres. A few authorization test pairs
(preferences, product-feedback) duplicate the same gating assertions once at
the extracted-handler level and once at the route level, which is reasonable
belt-and-suspenders but adds limited additional evidence per line.

**Recommended smoke-test areas:** a real-database round trip of import →
persistence → dashboard read, a real Slack API call in a manual/staging
context, and an end-to-end `next build` + `npm test` run before any deploy.
See Section 5.

## 2. Test inventory

Legend for **Type**: unit (pure function/logic), integration (exercises a
route or module boundary with mocked externals), component (jsdom-rendered
React component), fixture-based (asserts against a static file, e.g. a
migration), contract (asserts an architectural boundary/invariant rather than
runtime behavior).

| Test / group | Type | Behavior | Responsibility | Failure mode(s) | Notes |
| --- | --- | --- | --- | --- | --- |
| `auth-configuration.test.mts` | unit/contract | JWT session strategy (≥30 days), Google `email_verified` → session identity, `authorizeOwner` integration | Authentication (owner identity) | Unverified/malformed Google profile granting owner status | Exercises the real `auth.ts` config, not a mock; deterministic. |
| `dashboard-filter-bar.test.mts` | component (jsdom) | `DashboardFilterBar`: source/sort/view/freshness/brand/monitor selects navigate immediately; preferred-brand prominence and case-insensitive search; brand cleared on source switch | Dashboard UI (filtering) | Broken/incorrect navigation URLs, brand list empty when it shouldn't be | Only `next/navigation` is mocked; component and `getDashboardHref` are real. |
| `dashboard-products-query.test.mts` | unit/fixture-based | `getLatestDashboardProducts`/brand/monitor listing: freshness cutoffs, source/brand/monitor filters, Watchlist/Hidden views, snapshot aggregation (count/min price) restricted to matching currency, highlighted-product fallback bounds, savings sort, `best_match` weighting parameterization | Dashboard querying, ranking-weight plumbing | Stale product leaking past freshness cutoff, cross-currency price aggregation, highlighted-product fallback re-including an out-of-window/hidden/wrong-source/wrong-monitor product, ranking weight not reaching the SQL | The `sql` tag is a **bespoke in-memory simulator** keyed off substrings of the query text (largest, most implementation-coupled file in the suite at 800 lines). It proves internal consistency between the query builder and the test's own model of it — it cannot catch a real Postgres/JSONB/type-coercion mismatch. |
| `dashboard-products.test.mts` | unit | `parseDashboardFreshness/View/Source/Brand/Monitor/ProductId`, `includeRequestedProduct` top-50 fallback | URL/query-param parsing, display inclusion | Invalid/out-of-range BIGINT IDs accepted, duplicate highlighted product | Deterministic pure functions. |
| `evaluate-product-route-authentication.test.mts` | integration | `POST /api/evaluate-product`: auth gating before any DB/Gemini call; real Gemini prompt-context construction (bounded `matchedMonitors`, bounded `listingText`, no `raw_data` leak); translated-text degrade-to-null rules; strict evaluation schema validation | Manual Gemini evaluation trigger; evaluation-output validation | Non-owner triggering evaluation; monitor-ID/raw-data injection into the Gemini prompt; malformed Gemini JSON silently accepted | Only `@google/genai` and `@neondatabase/serverless` are mocked — `lib/product-evaluation.ts`'s real prompt-building and `parseEvaluation` logic run under test here. This is the **only** place that logic executes for real. |
| `evaluation-batches.test.mts` | unit | `processEvaluationBatch`: batch sizing/resumability, #35 retry/backoff timing, exclusive candidate claims under overlap, batch-size range validation, recovery of an expired "running" persisted state, static no-Vercel-dependency check | Durable evaluation batch orchestration (ADR 0001) | Double-evaluating a claimed candidate; losing retry pacing; re-evaluating completed candidates on resume | `evaluateProduct` is always a stub — intentionally, since this tests orchestration, not Gemini content. |
| `evaluation-finalization.test.mts` | unit | `finalizeEvaluationRun`: single-claim finalization, ranking-weighted recommendation selection, claim release on a read failure between claim and Slack, "not yet all-terminal" guard, reload-from-Postgres instead of trusting a stale run object, Slack failure/exception leaves state retryable | Durable-run finalization + Slack delivery | Double Slack delivery; finalizing early; losing the notification claim on failure | In-memory `sql` mock is stateful per test; several assertions match literal SQL fragments. |
| `evaluation-run-orchestration.test.mts` | unit/contract | Vercel Workflow adapter (`workflows/evaluation-run-orchestration.ts`) delegates run creation to the application operation; adapter file contains `"use workflow"`/`"use step"`/`processEvaluationBatch` | ADR 0001 platform boundary | Adapter re-implementing selection/evaluation instead of delegating | The "contains these directives" assertion is structural (string search), not behavioral — it detects *absence*, not misuse. |
| `evaluation-run-schema-migration.test.mts` | fixture-based | Migrations 013–022 contain expected DDL fragments (tables, CHECKs, indexes, status enums) and no `DROP TABLE`/`DELETE FROM` | Schema/migration safety (evaluation-run subsystem) | Destructive migration content; missing constraints | Regex-against-file-text only; does not execute the SQL against any database engine. |
| `evaluation-runs.test.mts` | unit | `createEvaluationRun`/`getEvaluationRun`/`loadNextEvaluationBatch`/candidate outcome/launch-claim exclusivity; one test explicitly **simulates PostgreSQL's data-modifying-CTE visibility rule** | Durable evaluation-run persistence primitives | Duplicate/invalid candidate membership accepted; non-exclusive launch claim; base-table re-read bug in the INSERT CTE | The CTE-snapshot test is a good example of a test encoding a specific Postgres engine nuance in a comment — but it is a hand-coded simulation of that nuance, not a real Postgres round trip, so a change in actual engine behavior would not be caught here. |
| `import-deals-route-authentication.test.mts` | integration | `POST /api/import-deals`: bearer auth, exact-ref feed fetch (2 sources), feed contract validation (site/domain/HTTPS/duplicate-URL/count), price-skip rules (non-finite/negative/unsafe/unparsable), currency-gated price-change/drop detection, automatic-evaluation-limit application, zero-candidate direct-Slack-summary path, durable-run creation + workflow enqueue, feed-fetch-failure handling | Import boundary, feed validation, normalization trigger, evaluation-candidate handoff | Malformed/duplicate/wrong-domain URL accepted; invalid price persisted; cross-currency false price-drop; feed HTTP failure not surfaced; import proceeding without valid credentials | Largest and most central test file (631 lines). Persistence is entirely mocked via a hand-rolled `transaction` function returning caller-supplied rows — it verifies route control flow and some persisted-query text via regex, **not** the real upsert/normalization SQL against Postgres. |
| `import-notification.test.mts` | unit | `selectTopRecommendation` weighting; `evaluateCandidates` sequential evaluation + retry classification (429/RESOURCE_EXHAUSTED/quota/5xx/validation) + metrics; `formatImportSlackMessage` HTML-escaping and Vinted/Zalando title branching; `parsePartialScanWarning` validation and bounded failure rendering | Import-time (non-durable) evaluation loop; Slack message formatting; scan-warning parsing | Injection into Slack message via unescaped title/currency/URL; malformed `scan_status` corrupting import; retryable vs. permanent misclassification; recommending an incomplete price | Exercises a **second, separate** evaluation-loop implementation (`evaluateCandidates`) from the durable batch processor tested in `evaluation-batches.test.mts`; both independently assert the same 5s/10s/20s backoff schedule. |
| `preferences-authentication.test.mts` | unit | `authorizeOwner` case-sensitivity/whitespace matrix; `handlePreferencesPost` gating before persistence | Authorization; preferences write gating | Case-insensitive owner-email bypass; saving without authorization | Deterministic, uses injected `authorize`/`save`. |
| `preferences-form-authentication-component.test.mts` | component (jsdom) | `PreferencesForm`: 401 sign-in prompt, 403 forbidden message, save confirmation, default automatic-evaluation-limit/workflow-batch-size display, preference-weight input with derived deal-weight (incl. NaN-avoidance on a cleared input and the 0/100 boundaries), preferred-brand add/remove and save payload | Settings/preferences UI | NaN rendering on cleared numeric input; wrong derived deal weight; incorrect brand-list payload | Mocks only `fetch`; component logic is real. |
| `preferences-route-authentication.test.mts` | integration | `POST /api/preferences` auth gating + persistence pass-through | Preferences API route | Same failure modes as the handler test, at the HTTP boundary | Overlaps substantially with `preferences-authentication.test.mts` (handler vs. route layer) — reasonable defense in depth, modest marginal evidence per added line. |
| `price-history-summary.test.mts` | unit | `getPriceHistorySummary`: no-history / lowest-now / above-lowest% / missing-current / invalid-aggregate / zero-minimum cases | Price-history display computation | Misleading percentage from invalid inputs; zero-minimum divide issue | Pure function, no mocking, deterministic. |
| `product-card-feedback-authentication-component.test.mts` | component (jsdom) | `ProductCard`: price-history rendering; Like/Not-for-me/Hide/Unhide/Watch/Unwatch/Evaluate actions incl. 401/403 messaging; explicit assertions that each action's request body only touches its own field (Watch never touches `hidden`/feedback, etc.); Overall-score weighting display | Dashboard product-card UI; feedback/visibility/watch/evaluate wiring | Cross-contamination between Watch/Hide/Feedback state; wrong overall-score weighting shown | Largest component test (526 lines); explicitly checks the Watch/Hide/Like independence rules from `docs/ubiquitous-language.md`. |
| `product-feedback-authentication.test.mts` | unit | `handleProductFeedbackPost` gating + save pass-through for like/dislike | Feedback API handler | Persisting feedback without authorization | Deterministic. |
| `product-feedback-route-authentication.test.mts` | integration | `POST /api/product-feedback` auth + persistence | Feedback API route | Same as above at the HTTP boundary | Overlaps with the handler test, same pattern as preferences. |
| `product-schema-migration.test.mts` | fixture-based | Migration 009 (drop `target_size`/`category`) and 023 (add nullable `translated_listing_text_da`) contain expected DDL and no unexpected destructive statements | Schema/migration safety | Destructive/incorrect migration content | Only 2 non-evaluation-run migrations have any such test. |
| `product-visibility-route-authentication.test.mts` | integration | `POST /api/product-visibility`: auth gating, persistence, validation-error passthrough, 404 on missing product, 500 on persistence failure | Visibility API route | Hiding a nonexistent product silently succeeding; DB failure surfaced as success | Query-shape assertion confirms only `hidden` is written. |
| `product-visibility.test.mts` | unit | `parseProductVisibilityRequest` accept/reject matrix (BIGINT bounds, type checks) | Visibility request validation | Out-of-range/malformed product ID accepted | Pure function. |
| `product-watch-route-authentication.test.mts` | integration | `POST /api/product-watch`: auth gating; **explicit query-text assertion that the UPDATE never touches `hidden`/`product_feedback`/`rating`**; 404/500/validation passthrough | Watch API route | Watch action mutating hidden/feedback state | Directly encodes the ubiquitous-language Watch/Hide/Feedback independence rule as a regression guard. |
| `product-watch.test.mts` | unit | `parseProductWatchRequest` accept/reject matrix | Watch request validation | Malformed request accepted | Mirrors `product-visibility.test.mts`. |
| `ranking-settings.test.mts` | unit | `parseRankingSettings` validation (0–100 integer, boundaries, rejects independent `dealWeightPercent`); `getOverallScore` weighting math; **cross-check that `import-notification`'s `getOverallEvaluationScore`, the canonical `getOverallScore`, and the dashboard SQL's rounded formula all agree** | Overall-score ranking semantics | Three independently-implemented copies of the weighting formula silently diverging | The cross-formula check is a genuinely valuable regression guard against a real, current architectural risk (the formula exists in ≥3 places: SQL string, `import-notification.mts`, `ranking-settings.mts`). |
| `settings-authentication.test.mts` | unit | `handleSettingsPost`: joint vinted/gemini/brandFilter/ranking validation and normalization, case-insensitive brand dedup/trim, per-sub-setting rejection, 403 on unauthorized, clean omission of absent optional fields | Settings API validation/normalization | Invalid `automaticEvaluationLimit`/`workflowBatchSize`/`preferenceWeightPercent` silently accepted; duplicate brand entries persisted | Deterministic, injected `authorize`/`save`. |
| `slack-highlight.test.mts` | unit | `selectSlackHighlight`: Watched (≥5%) / Liked (≥10%) / generic (≥20%) price-drop tiers at exact boundaries; tie-break order (largest drop → higher weighted score → product ID); new-product 60/40 (and configurable) threshold at the 7.0 boundary; hidden/price-increase/cross-currency exclusion | Slack "existing product" highlight selection | Hidden product surfacing in Slack; wrong tier priority; boundary off-by-one | Pure function; strong, deliberate boundary-value coverage. |
| `vinted-display-title.test.mts` | unit | `buildVintedDisplayTitle` segment-joining/fallback; `getProductDisplayTitle` source branching (Vinted vs. Zalando) | Vinted display-title construction | Price leaking into a display title; wrong segment order; Zalando title incorrectly transformed | Deterministic pure functions. |
| `vinted-preselection.test.mts` | unit | `selectEvaluationCandidatesWithPreselection`: minimum-condition ordering, case-insensitive/trimmed excluded-brand filtering, preselection-before-cap interaction, evaluation-limit boundaries, limit changes cutoff only (not order), Zalando bypass of Vinted-only rules | Deterministic preselection (#34) + evaluation workload limit (#36) | Excluded brand not filtered due to case/whitespace; limit changing candidate order; Zalando incorrectly subjected to Vinted rules | Pure function, strong boundary coverage; well aligned with the architecture doc's "Evaluation prioritization policy." |
| `tests/path-alias-loader.mjs`, `tests/server-only.mjs` | test infrastructure | Node loader for `@/` alias resolution; stub for the `server-only` import guard | N/A (harness) | N/A | Not behavioral tests; enable the other files to import route/lib code that assumes Next.js resolution and server-only guards. |

## 3. Responsibility coverage

| Responsibility | Evidence | Assessment | Gaps |
| --- | --- | --- | --- |
| Import validation & normalization (`app/api/import-deals/route.ts`) | `import-deals-route-authentication.test.mts` | **Strong at the black-box/route level.** Feed-contract violations, price validation, currency-gated comparisons, and duplicate URLs are all covered with both happy- and failure-path cases. | `validateFeed`, `normalizeProducts`, and the price/timestamp helper functions are not unit-tested in isolation — all inline in a 687-line route file and reached only through the composed HTTP handler. No test runs against a real Postgres upsert, so the actual `INSERT ... ON CONFLICT` SQL text is asserted by regex, not executed. |
| Product/price/history persistence & dashboard querying | `dashboard-products-query.test.mts`, `dashboard-products.test.mts`, `price-history-summary.test.mts` | **Partial, and behaviorally focused on the query-builder layer, not the database.** Freshness/visibility/watchlist/brand/monitor filtering and snapshot aggregation logic are extensively exercised. | No test executes any of this SQL against a real or ephemeral Postgres instance. The hand-rolled `sql` simulator encodes the same assumptions being tested (e.g., which JSONB predicate a query "should" contain), so a genuine Postgres/JSONB behavior mismatch would not surface here. |
| Gemini evaluation (manual, `/api/evaluate-product`) | `evaluate-product-route-authentication.test.mts` | **Strong.** Real prompt-context construction, monitor-ID/listing-text bounding, and strict output-schema validation all run under test with the real evaluation module. | None significant for this specific path. |
| Gemini evaluation (automated import path) | `import-notification.test.mts` (`evaluateCandidates`), `evaluation-batches.test.mts` (`processEvaluationBatch`) | **Partial.** Retry/backoff/failure-classification logic is well tested, but always against a stub `evaluateProduct`/candidate evaluator. | No test confirms that either automated path actually invokes the real `lib/product-evaluation.ts` function with a compatible signature/contract; a refactor could silently break the wiring between orchestration and evaluation without any test failing. |
| Durable evaluation-run persistence & orchestration (Slice 3/4, ADR 0001) | `evaluation-runs.test.mts`, `evaluation-batches.test.mts`, `evaluation-finalization.test.mts`, `evaluation-run-orchestration.test.mts`, `evaluation-run-schema-migration.test.mts` | **Strong and well-designed for the stated architecture.** Explicit tests for exclusivity, resumability, claim release, notification idempotency, and a static check that the platform-boundary (ADR 0001) is respected in both the batch processor and the persistence module. | The Vercel-adapter test only checks for the *presence* of `"use workflow"`/`"use step"` directives, not correct usage; the Postgres CTE-visibility behavior it depends on is simulated, not verified against a real database. |
| Ranking / scoring (Preference, Deal, Overall) | `ranking-settings.test.mts`, `slack-highlight.test.mts`, `product-card-feedback-authentication-component.test.mts`, `dashboard-products-query.test.mts` | **Strong**, including an explicit cross-check between the three separate implementations of the Overall-score formula. | None significant; this is one of the best-covered areas relative to its risk. |
| Slack notification formatting & delivery | `import-notification.test.mts` (formatting), `slack-highlight.test.mts` (selection), `evaluation-finalization.test.mts` (delivery orchestration, mocked) | **Formatting and selection logic: strong. Actual delivery: untested.** | `lib/slack.ts` (the function that calls `https://slack.com/api/chat.postMessage`, including its `not_configured`/`unknown_error` classification) has no direct test anywhere; it is always replaced with a mock `postSlackMessage`. |
| User feedback / visibility / watch actions | `product-feedback-*.test.mts`, `product-visibility-*.test.mts`, `product-watch-*.test.mts`, `product-card-feedback-authentication-component.test.mts` | **Strong**, with explicit cross-field isolation assertions matching `docs/ubiquitous-language.md`. | None significant. |
| Preferences & Settings (Vinted/Gemini/brand-filter/ranking config) | `preferences-*.test.mts`, `settings-authentication.test.mts` | **Strong** for validation/normalization and UI wiring. | None significant. |
| Authentication / authorization | `auth-configuration.test.mts`, and gating checks embedded in nearly every route/handler test | **Strong and consistent** — every mutating route is checked for 401-before-403-before-persistence with call-count evidence. | The four diagnostic routes (`/api/db-test`, `/api/db-schema-test`, `/api/gemini-test`, `/api/slack-test`) have **no owner-authorization check in the code and no tests** — an architectural inconsistency with the rest of the API surface, not just a coverage gap. |
| Database schema / migrations | `product-schema-migration.test.mts`, `evaluation-run-schema-migration.test.mts` | **Uneven.** The evaluation-run subsystem (013–022) and two other migrations (009, 023) have content-level checks; the rest do not. | Migrations 001–008 (initial schema, snapshots, feedback, preferences, product_evaluations, source_prices, product_visibility, product_watch), 010–012 (snapshot currency, application_settings, gemini_settings), 024–025 (brand_filter_settings, ranking_settings) have no test coverage at all, deterministic or otherwise. None of the migration tests execute SQL against any database engine. |
| Workflow/orchestration platform boundary (ADR 0001) | `evaluation-run-orchestration.test.mts`, source-scan assertions in `evaluation-batches.test.mts` and `evaluation-runs.test.mts` | **Adequate for what it checks.** Confirms the adapter delegates to application code and that core modules contain no `vercel`/`workflow` string references. | These are structural/textual checks, not behavioral guarantees; they would not catch a Vercel-specific *type* import that doesn't match those literal strings, or subtly incorrect delegation. |
| DealRadar import triggering / repository boundary (`deals` → DealRadar) | `import-deals-route-authentication.test.mts` (exact-ref fetch URLs, bearer auth) | **Covered for the documented exact-ref contract.** | No test exists in this repository for the producer side (that lives in `deals`); this is expected given the repository split described in `docs/architecture.md`, but means a producer-contract change is only caught here if it breaks the specific shapes this suite already anticipates. |

## 4. Failure-mode coverage

| Failure mode | Covered? | Evidence | Notes |
| --- | --- | --- | --- |
| Malformed/duplicate/wrong-domain product URL imported | Covered | `import-deals-route-authentication.test.mts` ("rejects feed-level contract violations…") | Includes whitespace-normalized duplicate URLs. |
| Invalid/negative/non-finite/unsafe current price persisted | Covered | `import-deals-route-authentication.test.mts` ("skips only products with invalid current prices") | Also verifies the aggregate skipped-count is reported. |
| Cross-currency price compared as a real price change/drop | Covered | `import-deals-route-authentication.test.mts`, `dashboard-products-query.test.mts` | Both the import-time comparison and the dashboard's historical-minimum aggregation are checked for currency equality. |
| Malformed/absent `scan_status` corrupting or blocking import | Covered | `import-notification.test.mts` ("ignores malformed scan_status metadata") | Only the parsing/rendering function is tested; there is no end-to-end import test that supplies a malformed `scan_status` through the real route. |
| Required feed unavailable (HTTP failure) | Covered | `import-deals-route-authentication.test.mts` ("fails when a required active feed is unavailable") | Confirms no persistence/Slack side effects on failure. |
| Non-owner/unauthenticated write to any mutating endpoint | Covered | Every `*-authentication.test.mts` / `*-route-authentication.test.mts` file | Consistently checks call-count of zero for persistence before authorization succeeds. |
| Diagnostic/debug endpoints reachable without authentication | **Uncovered** | — | `/api/db-test`, `/api/db-schema-test`, `/api/gemini-test`, `/api/slack-test` have no auth check in the source and no tests of any kind. This is a fact about current behavior, not a judgment about whether it is acceptable. |
| Gemini returns invalid/malformed/extra-field JSON | Covered | `evaluate-product-route-authentication.test.mts` (strict schema tests), `lib/product-evaluation.ts`'s `parseEvaluation` exercised directly through the route | Only reached through the manual-evaluation route; the automated batch path never calls the real parser under test (see Section 3). |
| Gemini/API rate-limit, quota, and permanent-failure classification | Covered (twice, independently) | `import-notification.test.mts` and `evaluation-batches.test.mts` both test 429/quota/5xx/permanent classification and backoff timing against their own respective evaluation loops | Duplication is itself worth noting: two parallel evaluation pipelines each re-implement and re-test the same retry policy; a change to the policy must be made and tested twice. |
| Overlapping/concurrent evaluation of the same durable candidate | Covered | `evaluation-batches.test.mts` ("an overlapping batch cannot evaluate an already claimed candidate") | Simulated via an in-memory awaited promise, not real concurrent processes or a real database row lock. |
| Notification (Slack) sent more than once for one durable run | Covered | `evaluation-finalization.test.mts` (claim/idempotency tests) | Verified against the mocked claim/lease SQL shape, not a real unique-constraint enforcement in Postgres. |
| Ranking-formula drift between SQL, Slack, and settings implementations | Covered | `ranking-settings.test.mts` (three-way cross-check) | One of the more valuable tests in the suite for a real, currently-existing architectural risk (formula duplicated in ≥3 places). |
| Watch/Hide/Like feedback cross-contamination | Covered | `product-watch-route-authentication.test.mts`, `product-card-feedback-authentication-component.test.mts` | Directly encodes `docs/ubiquitous-language.md` invariants as regression guards. |
| XSS/HTML injection into Slack messages via product title/currency/URL | Covered | `import-notification.test.mts` ("formats a safe recommendation with scores, price, and retailer link") | Only covers the Slack `mrkdwn`-escaping function; does not cover whether Slack itself renders the escaped text safely (external system, reasonably out of scope). |
| Secret/credential leakage in diagnostic error messages | Partially covered | `app/api/db-test/route.ts` contains a `getSafeErrorMessage` redaction helper, but it has **no test** | The engineering rule "never log API keys/bearer tokens/DB credentials" has no automated regression guard for this specific redaction function. |
| Destructive/irreversible migration content | Partially covered | `evaluation-run-schema-migration.test.mts`, `product-schema-migration.test.mts` assert absence of `DROP TABLE`/`DELETE FROM`/`UPDATE` in the migrations they check | Only checked for 12 of 25 migrations; the check is textual (regex), not semantic — a destructive statement using different casing/whitespace or a `TRUNCATE` would not necessarily be caught, and migrations without any such test have no guard at all. |
| Real Postgres query correctness (syntax, JSONB semantics, constraint enforcement) | **Uncovered** | — | No test in the suite connects to a real or ephemeral Postgres database. This is the single largest structural gap: every "database" assertion is either a hand-simulated fixture or a static-text check. |
| Slack API failure / misconfiguration handling in production | **Uncovered** | — | `lib/slack.ts` itself (the only place `fetch` is called against Slack) has no test; its behavior is only inferred through the mocks that stand in for it elsewhere. |
| Preselection/limit interacting incorrectly under real import volumes (ordering stability, off-by-one at the exact limit) | Covered | `vinted-preselection.test.mts` | Strong deterministic boundary coverage. |

## 5. Proposed smoke tests

These are recommendations only; none have been implemented as part of this
issue.

1. **Import round trip against a real ephemeral Postgres database.**
   - *Critical path:* `POST /api/import-deals` with a small synthetic feed,
     against a real (e.g. local/ephemeral) Postgres instance running the
     current `migrations/*.sql` in order, followed by a read through
     `getLatestDashboardProducts`.
   - *Regression it would detect:* a migration/SQL mismatch, a JSONB/CTE
     semantic assumption baked into the mocked test suite that does not hold
     in real Postgres, or a broken upsert/constraint.
   - *When to run:* before merging a change to any migration, the import
     route's SQL, or `lib/dashboard-product-query.mts`; and as a pre-deploy
     gate.
   - *Automated or manual:* automated, but currently absent from this
     repository's tooling — would need a test-database provisioning step
     (e.g. a disposable Postgres container) that does not exist today.
   - *Requires:* a Postgres instance, `DATABASE_URL` pointed at it, and
     running all migrations — none of which the current deterministic suite
     needs.
   - *Why current tests are insufficient:* every existing "database" test
     substitutes a hand-written simulator or a static-text check for the
     actual database engine (Section 4).

2. **Live Slack delivery check.**
   - *Critical path:* call `lib/slack.ts`'s `postSlackMessage` (or hit
     `/api/slack-test`) against the real Slack API with valid staging
     credentials.
   - *Regression it would detect:* an expired/rotated bot token, a channel
     permission change, or a change to Slack's API response shape that the
     `getSlackError` classification does not handle.
   - *When to run:* manually, after rotating Slack credentials or changing
     `lib/slack.ts`; optionally on a low-frequency schedule against staging.
   - *Automated or manual:* manual (or a scheduled low-frequency automated
     ping), since it depends on live external credentials and should not run
     on every commit.
   - *Requires:* `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` for a
     non-production channel.
   - *Why current tests are insufficient:* `lib/slack.ts` is mocked in every
     existing test; nothing exercises the real HTTP call or its failure
     classification.

3. **`next build` + full `npm test` as a pre-deploy gate.**
   - *Critical path:* the entire TypeScript build (which type-checks routes,
     lib, and workflow code) followed by the existing four-part `npm test`
     command.
   - *Regression it would detect:* a type error or import-resolution break
     that the deterministic suite's `tsx`/loader-based execution does not
     surface the same way `next build` would (e.g. Next.js route-file
     conventions, server-only boundaries).
   - *When to run:* on every push/PR, and immediately before any deploy.
   - *Automated or manual:* automated — this is the most straightforward gap
     to close, since **no CI workflow currently exists in this repository**
     (`.github/workflows` is absent).
   - *Requires:* no external credentials beyond what `next build` itself
     needs (none, since API routes are not executed during build).
   - *Why current tests are insufficient:* they are unit/integration tests
     of behavior, not a build-correctness or type-safety gate, and today
     nothing runs them automatically.

4. **Manual end-to-end Gemini evaluation check against the real API.**
   - *Critical path:* trigger `/api/evaluate-product` (or `/api/gemini-test`)
     for one real product against the live Gemini API with a valid key.
   - *Regression it would detect:* a Gemini model/response-shape change
     (e.g. `gemini-3.5-flash-lite` deprecation or schema-enforcement
     behavior change) that a mocked `@google/genai` client cannot reveal.
   - *When to run:* manually, after upgrading `@google/genai`, changing the
     model name, or changing the evaluation prompt/schema.
   - *Automated or manual:* manual, since it costs real API quota and
     depends on live credentials.
   - *Requires:* `GEMINI_API_KEY`, a `DATABASE_URL` with at least one real
     product row.
   - *Why current tests are insufficient:* the deterministic tests mock
     `@google/genai`'s `generateContent` entirely, so they cannot detect a
     change in the real API's behavior, quota errors, or model deprecation.

Deliberately not proposed as a smoke test: a full Vinted/Zalando scrape or
live scraper run — out of scope for this repository per
`docs/architecture.md`, and the issue's constraints explicitly exclude running
live scrapers without separate approval.

## 6. Findings and follow-up candidates

### High-value gaps
- No deterministic or smoke test in this repository exercises real
  PostgreSQL. This is the largest structural gap given how central Neon/
  Postgres is to the architecture (system of record for products, snapshots,
  feedback, preferences, and evaluation runs).
- `lib/slack.ts` has no direct test of its own success/failure/redaction
  logic (`getSlackError`, the `not_configured` path, network-failure
  handling).
- The unauthenticated diagnostic routes (`/api/db-test`, `/api/db-schema-test`,
  `/api/gemini-test`, `/api/slack-test`) are both untested and structurally
  inconsistent with the rest of the API (no owner-authorization check). This
  is presented as a fact for human review, not a recommendation to add
  authorization, since that would be a security-relevant behavior change
  outside this issue's investigation-only scope.
- 13 of 25 migrations (001–008, 010–012, 024, 025) have no content-level test
  of any kind.

### Possibly redundant/low-value tests
- `preferences-authentication.test.mts` vs. `preferences-route-authentication.test.mts`,
  and `product-feedback-authentication.test.mts` vs.
  `product-feedback-route-authentication.test.mts`, each test the same
  authorization-gating behavior once at the extracted-handler level and once
  at the route level. This is reasonable defense-in-depth (it would catch a
  route accidentally bypassing the shared handler), but it is duplicated
  effort rather than additional independent evidence.
- Some of the more elaborate SQL-text regex assertions in
  `dashboard-products-query.test.mts` (e.g. matching exact `WHERE` clause
  fragments) are tightly coupled to the current SQL phrasing; a behavior-
  preserving rewrite of the query (same results, different SQL shape) would
  fail these tests without an actual regression, which is a maintenance cost
  worth being aware of.
- `import-notification.test.mts` and `evaluation-batches.test.mts`
  independently re-implement and re-assert the same retry/backoff timing
  (5s/10s/20s) for what are, in effect, two separate evaluation-loop
  implementations. Whether this reflects two implementations that should
  eventually converge, or two implementations that are intentionally
  separate (durable vs. non-durable), is a design question outside this
  audit's scope — but it does mean the retry policy must be changed and
  re-verified in two places today.

### Architectural or contract ambiguities that make testing difficult
- `app/api/import-deals/route.ts` is 687 lines with `validateFeed`,
  `normalizeProducts`, and several parsing helpers defined inline rather than
  extracted to `lib/`. This makes it harder to unit-test those functions in
  isolation from the full HTTP route, and the current suite compensates with
  a large (631-line) black-box test file instead.
- There are two structurally distinct evaluation-triggering paths (the
  non-durable `evaluateCandidates`/`selectEvaluationCandidates` in
  `lib/import-evaluation.mts`, used for the zero-candidate/legacy summary
  path, and the durable `processEvaluationBatch` in
  `lib/evaluation-batches.mts`). No test asserts a contract between them
  (e.g., that both ultimately call `lib/product-evaluation.ts`'s
  `evaluateProduct` the same way), which makes it possible for the two paths
  to drift silently.
- The hand-rolled SQL-tag simulators in `dashboard-products-query.test.mts`,
  `evaluation-batches.test.mts`, `evaluation-finalization.test.mts`, and
  `evaluation-runs.test.mts` each independently re-implement a small,
  bespoke subset of PostgreSQL/JSONB semantics. Because each simulator only
  encodes the behavior its own author expected, they cannot cross-check each
  other, and none of them can be validated against the real engine without
  a database-backed test (see Section 5, smoke test #1).

### Optional improvements
- The `npm test` script currently runs as four sequential `node --test`
  invocations chained with `&&` (grouped by which Node loader/flag
  combination each file needs). This is a tooling/ergonomics observation,
  not a correctness gap: it is deterministic and fail-fast, but a failure in
  an early group prevents later groups from running in the same invocation.
- Given the absence of any `.github/workflows` in this repository, `npm test`
  and `next build` are not currently run automatically on push, PR, or before
  deploy; codifying smoke test #3 (Section 5) would be a low-cost way to
  close that gap.
