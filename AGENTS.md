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