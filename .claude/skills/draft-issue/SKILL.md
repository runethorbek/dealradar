---
name: draft-issue
description: Turn a feature idea or rough issue into a reviewable issue draft grounded in the current repository. Investigates relevant code, tests, and docs; separates facts from proposals and open questions. Produces an idea-stage issue for /agent-ready to make ready; does not implement or slice.
argument-hint: <feature idea | issue number>
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh label list:*), Bash(gh repo view:*)
---

# Draft issue

Input: $ARGUMENTS

If the input is empty, ask for a feature idea or an issue number and stop.

## Rules

- Do not implement anything. Do not edit repository files.
- Do not create, edit, comment on, or label issues until the user has reviewed the complete draft and explicitly approved that specific write.
- Do not invent answers to product decisions. Ask, or list them as open questions.
- The output is an idea-stage issue. It is intended that an agent afterwards makes it ready with `/agent-ready`, which resolves readiness, slicing, tracer bullets, and subissues. Do not do that work here; mention a possible split only to explain why the draft is too broad.
- Label every statement about the system as either verified in the repo (with file references) or an assumption.
- If the current repository's instructions conflict with this skill on tracker writes or approvals, follow the stricter rule.

## 1. Load context

Everything below refers to the current repository (the working directory), not any other.

- Read the repo's agent instructions: `CLAUDE.md`, `AGENTS.md`, and similar files at the root or in `.claude/`, if present. Do not assume they are already loaded.
- Determine the issue tracker. If it is GitHub (`gh repo view` succeeds), use `gh`. If it is something else, or unclear, ask how to read issues before continuing.
- If the input is an issue number, read it (for GitHub, `gh issue view <n>`), including its parent and linked issues. If tracker access fails, stop and say so; do not guess its contents.
- Read a few recent issues (`gh issue list --state all --limit 20`, then `gh issue view` on two or three well-developed ones) to learn the repo's issue structure, labels, parent/umbrella issues, and possible duplicates. Check for issue templates in `.github/ISSUE_TEMPLATE/`.
- Use the repo's own domain terms from any glossary, specs, schema docs, or ADRs it has.

## 2. Investigate

Investigate only what the idea touches: relevant modules, entry points, configuration, CI workflows, tests, specs, and README sections. Establish:

- what already exists and how it behaves today;
- what would need to change, and which existing behavior must be preserved;
- which external side effects or integrations are involved, and which architectural, security, or AI boundaries from the repo's instructions apply.

## 3. Challenge

Before drafting, tell the user briefly:

- what already exists, with file references;
- weak assumptions, unnecessary scope, or cheaper alternatives (including "this may already be covered" or "this may not be worth doing");
- product decisions the repo cannot answer, as specific questions with options where useful.

Wait for answers to decisions that materially change scope or behavior. Unanswered ones stay in **Open questions**.

## 4. Draft

Follow the repo's issue template or the structure of its recent issues. If it has neither, use this structure. Keep it concise; omit sections that add nothing.

```markdown
# <Title>

Parent: #<n>          (if any)

## Why this matters
## Goal
## Current state        (verified facts, with file references)
## Behavior / Decisions (decided behavior only)
## Constraints
## Out of scope
## Open questions
## Acceptance criteria  (numbered, observable)
## Verification         (tests plus a practical manual check)
## Risks / assumptions
```

- Acceptance criteria describe observable behavior, not implementation steps.
- Implementation notes are allowed only where they point to existing seams or conventions that constrain the work. Do not design the solution in detail.
- Suggest only labels that already exist in the repo (`gh label list`). If the repo has an idea label (e.g. `idea`, matched case-insensitively), always suggest it. Never suggest a ready-to-implement label (e.g. `agent-ready`); readiness is decided later by `/agent-ready`. If there is no idea label, say so and do not substitute another.

## 5. Review

Show the complete draft in the conversation, followed by:

- which facts were verified and which are assumptions;
- remaining open questions;
- the proposed tracker action (new issue, or update issue #n) with title, labels, and parent.

Only after explicit approval, perform exactly that action, then report the issue URL and note that the next step is `/agent-ready` on that issue.
