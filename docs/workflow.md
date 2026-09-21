# Development workflow

How a change moves from a GitHub issue to production.

```text
issue
  → agent creates an issue/topic branch (e.g. issue-54-ci-workflow)
  → agent implements the smallest scoped change
  → agent runs local verification (npm test, npm run lint, next build)
  → independent review, coordinated by the repository owner
  → agent applies accepted fixes, re-verifies
  → agent pushes the branch
  → agent opens a pull request targeting main
  → GitHub Actions CI runs (npm test, npm run lint, next build)
  → repository owner reviews the PR and CI result, and merges
  → Vercel deploys main automatically
  → production smoke test, where appropriate
```

Normative rules for agents live in `AGENTS.md` ("Branch, PR, and CI
workflow"). This document is the short human-readable summary of the same
flow.

## Notes

- Direct implementation on `main` is not the normal workflow.
- The repository owner decides when review is complete and when a PR should
  be opened; agents do not push or open a PR on their own initiative.
- CI (`.github/workflows/ci.yml`) runs on every PR targeting `main` and on
  every push to `main` as a safety net. It does not require Gemini, Slack,
  or Neon credentials.
- The Postgres integration test (`npm run test:integration`,
  see `docs/architecture.md`) is a separate, Docker-based check and is not
  part of CI.
- Merging to `main` is a human decision. Branch protection for `main` is a
  repository-owner-managed GitHub setting, not something an agent enables
  — see below for the exact configuration.

## Branch protection settings for `main` (owner-applied, not automated)

These settings are not enabled by this repository's code or CI. The
repository owner applies them manually in GitHub:

`github.com/runethorbek/dealradar` → **Settings** → **Branches** →
**Branch protection rules** → **Add branch protection rule** (or add a
**Add ruleset** targeting `main`, either works) with:

- **Branch name pattern:** `main`
- **Require a pull request before merging** — on.
  - **Require approvals** — optional; leave at 0 for a single-owner
    repository, or set to 1 if you want an explicit second reviewer
    besides the fresh-context review agent.
- **Require status checks to pass before merging** — on.
  - Search for and select **`CI / verify`** — this is the required check
    produced by the `verify` job in `.github/workflows/ci.yml`'s `CI`
    workflow. It only appears in the search list after the workflow has
    run at least once (e.g. after this issue's first PR).
  - **Require branches to be up to date before merging** — recommended on.
- **Do not allow bypassing the above settings** — recommended on, so the
  rule also applies to repository admins and normal `git push` to `main`
  is rejected for everyone, including the owner.
- Leave **Restrict who can push to matching branches** off/unset — the
  rule pattern only matches `main`, so pushes to issue/topic branches are
  unaffected either way.

This produces exactly: PRs required into `main`, the CI check required,
direct pushes to `main` blocked, and feature-branch pushes unrestricted —
matching this issue's acceptance criteria.
