---
name: agent-ready
description: Turn an existing issue or issue draft into one small, implementable slice that a coding agent can start from in a fresh context. Assesses size, proposes slices or a tracer bullet only when needed; does not implement.
argument-hint: <issue URL | issue number | path to draft>
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh label list:*), Bash(gh repo view:*)
---

# Agent-ready

Input: $ARGUMENTS

If the input is empty, ask for an issue URL, number, or draft and stop.

## Rules

- Do not implement code, create branches, open PRs, or start `/build-slice`. Do not edit repository files.
- Do not create, edit, comment on, or label issues until the user has reviewed the exact proposed text and explicitly approved that specific write.
- Do not silently decide product questions or choices that materially change the slice. Ask.
- Label every statement about the system as either verified in the repo (with file references) or a proposed decision.
- Do not split an issue merely because this skill was called.
- If the current repository's instructions conflict with this skill on tracker writes or approvals, follow the stricter rule.

## 1. Load context

Everything below refers to the current repository (the working directory).

- Read the repo's agent instructions: `CLAUDE.md`, `AGENTS.md`, and similar files, if present. Do not assume they are already loaded.
- Read the issue (for GitHub, `gh issue view <n> --comments`), its parent, sub-issues, and linked issues. If the input is a draft, read it as given. If tracker access fails, stop and say so; do not guess.
- Learn the repo's issue conventions and labels from a few recent ready or completed issues and `gh label list`.
- Read only the code, tests, and docs needed to assess the task.

## 2. Assess

Identify, briefly:

- the intended outcome;
- relevant existing behavior, with file references;
- assumptions (and which are unvalidated), dependencies on other issues or external systems, and important failure modes;
- open product decisions in the issue.

Then decide: is it small and clear enough for one agent iteration (one reviewable change, verifiable on its own)?

- **Yes:** the whole issue is the slice.
- **No:** propose a short sequence of independently verifiable slices. Prefer a tracer bullet first when an important end-to-end assumption needs early validation, and state what it will prove.

Recommend subissues only when separate tracking adds value (e.g. slices ship separately or need separate review). Otherwise keep the slice sequence in the existing issue.

Present the assessment and any questions. Wait for answers to decisions that materially change the slice.

## 3. Prepare one slice

Write the next slice so an implementation agent with only the repo and the issue can start. Follow the repo's issue conventions; otherwise use:

```markdown
# <Title>

Parent: #<n>            (if a subissue)

## Goal                 (observable behavior)
## Context              (verified facts, with file references)
## Scope and constraints
## Out of scope / deferred
## Acceptance criteria  (numbered, observable)
## Verification         (tests, plus integration or smoke checks that cannot run locally)
```

Keep it concise: point to existing seams and conventions, but do not write an implementation recipe. No unresolved questions may remain in the slice.

## 4. Review

Show the complete proposal:

- the exact tracker action: update issue #n (new body, or a comment), or create a subissue under #n;
- the full text, and for an update, what changes compared with the current body;
- proposed labels, only from existing ones (e.g. replace an idea label with a ready label; add a tracer-bullet label if the repo has one and it applies);
- remaining slices, if any, and where they are recorded.

Only after explicit approval, perform exactly that action, then report the issue URL and note that the slice is ready for implementation.
