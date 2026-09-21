<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# DealRadar Agent Instructions

## Repository purpose

DealRadar is a Next.js application that:

1. Imports normalized deal data from the separate `deals` scraper repository.
2. Stores products and price history in Neon/Postgres.
3. Evaluates products using Gemini.
4. Stores user preferences and product feedback.
5. Displays and ranks deals in the web application.
6. Sends operational and deal notifications to Slack.

Keep changes small and explicit.

## Implementation workflow

When asked to implement or fix something:

1. Inspect the relevant API route, library code, migration, UI, tests, and documentation.
2. State assumptions before changing:
   - database schemas or migrations;
   - import semantics;
   - product pricing or currency semantics;
   - API contracts;
   - authentication or secrets;
   - Gemini evaluation behavior.
3. Keep the change limited to the requested task.
4. Add or update deterministic tests where practical.
5. Run the relevant repository checks.
6. Inspect the final diff for unrelated changes.
7. Report:
   - files changed;
   - checks run;
   - remaining risks;
   - manual steps required, such as applying a Neon migration.

Do not commit, push, or deploy unless explicitly requested.

## Branch, PR, and CI workflow

DealRadar's default workflow is issue → branch → implementation → local
verification → independent review coordinated by the repository owner →
fixes if needed → push → PR → CI → human merge → automatic Vercel deploy →
production smoke test where appropriate. See `docs/workflow.md` for the
human-readable version of this flow.

Implementation agents:

1. Never implement directly on `main`.
2. Before editing files, inspect the current git branch.
3. If on `main`, create and switch to a dedicated issue/topic branch before
   making any changes.
4. Name the branch after the issue, e.g. `issue-54-ci-workflow`,
   `issue-51-postgres-integration-test`.
5. Inspect the issue/specification and relevant existing code before
   implementing.
6. Implement the smallest scoped change.
7. Run the appropriate local verification (`npm test`, `npm run lint`,
   `next build`, and any other checks relevant to the change).
8. Stop and report the implementation and verification results.

Independent review of the branch/diff is coordinated by the repository
owner. The implementation agent must not assume review is complete and must
not start its own review agent unless explicitly asked.

Once the repository owner confirms the change is ready for a PR, the
implementation agent:

9. Pushes the current issue branch.
10. Opens a pull request targeting `main`.
11. Includes in the PR description: the issue reference, a concise change
    summary, verification performed, any migrations/manual steps required,
    and known limitations or deferred follow-ups.
12. Inspects and reports CI status when possible.

Implementation agents must not:

- push directly to `main`;
- merge a pull request;
- enable or change branch protection;
- change repository access or settings without explicit approval.

Review agents are read-only by default: they inspect the diff and report
findings, and must not modify code, push, merge, or broaden the task unless
explicitly asked.

## CI

`.github/workflows/ci.yml` (job `verify`, required check name "CI / verify")
runs `npm test`, `npm run lint`, and `npm run build` (`next build`) on pull
requests targeting `main` and on pushes to `main`. It requires no live
Gemini, Slack, Neon, or other production-service credentials. The
Postgres integration test (`npm run test:integration`, see
`docs/architecture.md`) is intentionally not part of this workflow.

## Repository documentation

Read the documentation relevant to the change before editing:

- `docs/architecture.md` for repository boundaries, system responsibilities,
  data flow, and cross-system changes.
- `docs/import-contract.md` for scraper feeds, import behavior, source fields,
  pricing/currency semantics, timestamps, images, and scan metadata.
- `docs/ubiquitous-language.md` for feedback, scoring, ranking,
  recommendation, and user-facing domain semantics.
- `docs/adr/0001-vercel-workflow-platform-boundary.md` before changing
  durable evaluation execution or Vercel Workflow integration.

Do not read every document mechanically for unrelated changes.

When a change alters a documented contract, architectural responsibility, or
domain meaning, update the relevant documentation in the same change and call
out the semantic change during review.

## Engineering rules

### Database

- Database schema changes must be represented by a numbered SQL migration under `migrations/`.
- Never assume that adding a migration file automatically changes Neon.
- Clearly report when a migration must be applied manually.
- Preserve historical/source data when introducing normalized data.
- Avoid destructive migrations unless explicitly approved.

### Imports and pricing

- Treat data from the `deals` repository as external input.
- Validate imported values before storing them.
- Preserve source price and source currency when normalizing prices.
- DealRadar's normalized monetary values should use explicit currency semantics.
- Do not silently guess currencies or prices.
- Import failures for optional enrichment should not corrupt otherwise valid product data.

### External services

- Keep secrets server-side.
- Never log API keys, bearer tokens, database credentials, or Slack tokens.
- Handle failures from Gemini, Slack, exchange-rate providers, GitHub, and other external services explicitly.
- Avoid making external API calls once per product when one call per import is sufficient.

### Durable execution platform boundary

- Vercel Workflow is a replaceable execution mechanism, not part of
  DealRadar's application or domain model.
- Keep Vercel-specific APIs or types inside an orchestration adapter. Do not introduce
  them into candidate selection, deterministic preselection, evaluation-limit
  policy, Gemini evaluation or retry/failure semantics, evaluation batching
  logic, persistence, recommendation selection, or Slack formatting and
  notification semantics.
- Operations run by a Workflow must remain callable independently of Vercel.
- #34 deterministic preselection, #35 Gemini evaluation and bounded
  retry/failure behavior, #36 maximum evaluation workload per import, and
  `workflowBatchSize` remain application-level concerns. `workflowBatchSize`
  only controls how many already-selected candidates a durable step processes.

### UI

- Prefer server-side data loading where appropriate.
- Keep display logic separate from persistence and import logic.
- Do not hide data-quality problems by formatting invalid values as if they were correct.

## Change discipline

- Keep changes scoped to the requested task.
- Do not perform unrelated refactors or cleanup.
- Do not change database semantics, authentication, or external integrations incidentally.
- Run relevant checks after implementation.
- Do not commit, push, or deploy unless explicitly requested.

### Domain language

- Read `docs/ubiquitous-language.md` before changing feedback semantics,
  evaluation prompts, scoring, ranking, recommendation logic, or user-facing
  terminology.
- Use the terms defined there consistently across code, UI, tests, Slack,
  prompts, and documentation.
- If a change alters the meaning of a defined domain term, update the
  ubiquitous-language document explicitly and call out the semantic change
  for human review.

## Review workflow

When asked to review:

- Use a separate Codex context from the implementation context.
- Review the current uncommitted diff on the same branch.
- Do not modify files during the first review pass.
- Inspect the task, diff, relevant migrations, API contracts, tests, and documentation.
- Report findings by severity with file and line references.
- If there are no meaningful actionable findings, say so explicitly.
- Verify relevant changes remain consistent with the architecture, import contract, and ubiquitous language.sl

Review for:

- correctness;
- regressions;
- edge cases;
- backwards compatibility;
- database migration safety;
- data integrity;
- pricing and currency semantics;
- security and secret handling;
- authentication and authorization;
- input validation;
- external API failure modes;
- Gemini/AI prompt and output validation;
- whether responsibilities belong in DealRadar or the scraper repository.
- For changes affecting feedback, scoring, ranking, evaluations, or
  recommendations, verify consistency with `docs/ubiquitous-language.md`.

## Human approval required

Obtain explicit human approval before:

- applying or changing a production database migration;
- changing authentication or authorization;
- changing secrets or environment-variable requirements;
- changing published/imported data contracts;
- changing pricing or currency semantics;
- adding a new external service;
- deleting or destructively rewriting stored data;
- committing, pushing, or deploying.

## GitHub issue access

When asked to read a GitHub issue:

- Use `gh` as the source of truth.
- Do not attempt `gh` inside the sandbox.
- Use the approved host execution path directly.
- Read-only GitHub commands such as `gh issue view` and `gh issue list` may be used without asking first when permitted by Codex rules.
- Do not perform GitHub write operations unless explicitly requested.

When asked to create or modify a GitHub issue:

- Use `gh` for the requested GitHub write operation.
- Do not attempt `gh` inside the sandbox.
- Request permission before executing the write operation unless the user has explicitly asked for that exact operation in the current request and the Codex permission system already allows it.
- Before execution, state briefly what will change on GitHub.
- Do not create, edit, close, comment on, relabel, assign, or otherwise modify additional issues beyond the explicit request.
- After execution, report the issue number and the change performed.
