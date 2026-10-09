---
name: build-slice
description: Implement exactly one agent-ready slice end to end. The main session orchestrates; a slice-implementer subagent builds and tests; a fresh slice-reviewer subagent (no write tools) reviews the actual diff; blocking findings go through a bounded correction loop. Ends with a local branch, or a PR if that is the repository's workflow. Keeps a recoverable handoff record.
argument-hint: <issue number | issue URL | path to slice> [--no-pr]
disable-model-invocation: true
allowed-tools: Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh label list:*), Bash(gh repo view:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git rev-parse:*)
---

# Build slice

Input: $ARGUMENTS

If the input is empty, ask for an issue number, URL, or slice path and stop. If it contains `--no-pr`, run in **no-PR mode**: do everything except push and open a PR.

You (the main session) are the **orchestrator**. You read context, prepare briefs, hand work to subagents, verify their results against the repository, run the git operations, and keep the handoff record. You do not write or edit the slice's source code or tests yourself; all changes to the code go through `slice-implementer`. Routine handoffs between agents are your job, not the user's.

## Hard rules

- One slice only. Never start the next slice, even if the issue lists more.
- Never merge, deploy, run migrations or scripts against real services, modify production data, or send real messages. Never state that a smoke test or deployed check was performed unless it actually was in this run.
- Never push to or commit on the default branch. Never force-push. Never rewrite history you did not create in this run.
- Never discard, stash, overwrite, or commit changes you did not make in this run.
- Never put secrets in briefs, logs, the handoff record, commits, or the PR.
- If the repository's instructions are stricter than this skill (for example, about tracker writes, pushing, or opening PRs), follow the repository.
- Only stop and prompt the user in the situations listed under **Stop conditions**. Everything else (routine implementation choices, review findings, test fixes within the slice) you handle yourself.

## Stop conditions

Stop, update the handoff record, and tell the user what you found, what you need, and the options when:

1. **Missing product decision:** the issue has open questions, conflicting requirements, or acceptance criteria that cannot be verified, or several slices and the input does not say which one.
2. **Scope would expand materially:** the slice cannot be done without changing behavior outside its scope, a new dependency, persistent state, new infrastructure, an architectural change, or weakening a security boundary.
3. **Access unavailable:** the issue, repository, required credentials, APIs, or schemas cannot be read; or the working tree has uncommitted changes that are not from a resumable run of this skill.
4. **Undiagnosed test failure:** a test failure that the implementer and you cannot explain within the correction loop, or baseline tests that cannot run at all.
5. **Loop limit:** two unsuccessful correction attempts at the same substantive problem, or three review rounds that each still end BLOCKED.
6. **Repository requires approval for push or PR:** the repository's instructions require explicit approval for pushing or creating PRs. Then show the PR title and body and ask for that one approval.

## 1. Load context

The current repository (the working directory) is the target.

- Read the repository's agent instructions: `AGENTS.md`, `CLAUDE.md`, and similar files at the root or in `.claude/`. Do not assume they are already loaded.
- Read the issue. For GitHub: `gh issue view <n> --comments`, plus its parent and linked issues where they define scope. If the input is a path, read the file. If reading fails, stop (condition 3).
- Identify the slice: goal, scope, out of scope, numbered acceptance criteria, and verification notes. If the issue is not ready (open questions, no observable acceptance criteria, or several unordered slices), stop (condition 1). The user can prepare it with `/agent-ready`.
- Learn the repository's conventions from its instructions, `README`, `CONTRIBUTING`, CI workflows (`.github/workflows/`), and package or build files:
  - test, lint, and type-check commands;
  - branch naming (`git branch -a`, recent PR head branches);
  - commit message style (`git log --oneline -15`);
  - PR practice: `gh pr list --state all --limit 10` and merge history. If the repository has PRs, it uses a PR workflow. If recent work is committed directly to the default branch and there are no PRs, it does not.
- Read only the code needed to write a good brief: the entry points and modules the slice touches, and their tests.

## 2. Check git state and resume

- Run `git status --porcelain`, `git rev-parse --abbrev-ref HEAD`, and find the default branch (`gh repo view --json defaultBranchRef` or `git rev-parse --abbrev-ref origin/HEAD`).
- Handoff directory: `<git-dir>/build-slice/<slug>/`, where `<git-dir>` is `git rev-parse --absolute-git-dir` and `<slug>` is `issue-<n>` (or the slice file name). It lives inside `.git`, so it never enters the diff or the PR.
- If `handoff.md` exists there, read it. You are resuming: do not check out or reset anything; confirm the current branch, HEAD, and working tree match the record. If they match, continue from the recorded phase. If they do not, stop (condition 3) and describe the difference.
- If not resuming and the working tree has uncommitted or untracked changes (other than ignored files), stop (condition 3). Do not stash or commit them. Suggest that the user commit or stash them, or run in a clean worktree.

## 3. Prepare the branch and record

- Base: the up-to-date default branch unless the issue or repository says otherwise. Record the base commit SHA.
- Create a branch from the base using the repository's naming convention. If it has none, use `slice/<n>-<short-kebab-title>`. Do this even if the repository usually commits to the default branch; merging is the user's decision.
- **Baseline:** run the test (and lint/type-check, if the repository uses them) commands on the base. Record exact commands and results. Pre-existing failures are not caused by the slice, but they must be reported.
- Create `handoff.md` in the handoff directory:

```markdown
# build-slice handoff: <issue ref> — <title>

Updated: <UTC timestamp>
Phase: implementing | verifying | reviewing (round k) | correcting (finding id, attempt a) | ready | pr-open | stopped
Issue: <URL or path>   Mode: pr | no-pr | local-only (repo has no PR workflow)
Repository: <path>   Default branch: <name>
Branch: <name>   Base: <sha>   HEAD: <sha>
Working tree: clean | <summary>

## Slice
<goal, and the numbered acceptance criteria verbatim>

## Conventions found
Tests: <commands>   Lint/types: <commands>   Commits: <style>   PR workflow: yes/no (evidence)

## Checks
| When | Command | Result |
<baseline and every later run, with exact results>

## Changed files
<path — purpose>

## Review log
<round k: reviewer verdict; each finding id, severity, summary; resolution: fixed in <sha> | rejected with evidence | deferred (non-blocking) | open; attempt count>

## Decisions and assumptions
## Unverified / needs post-deployment check
## Next step
<the one next action a new session should take>
```

Update this file at every phase change, after every check, and before stopping. It must let a new session continue from the repository and this file alone.

## 4. Implement

Start the `slice-implementer` subagent (in the foreground, since you need the result) with a self-contained brief:

- the repository path, the branch, and the handoff file path;
- the issue reference and the slice text, including acceptance criteria verbatim, scope, and out-of-scope items;
- the repository instruction files to read, and the constraints from them that apply;
- relevant files and seams you found (as pointers, not an implementation recipe);
- test/lint commands and the baseline results;
- the reminder that it must not commit, change branches, touch the tracker, add dependencies, or call real services, and must stop and report on missing decisions or scope growth.

Keep its agent ID. You resume the same implementer for corrections.

If it reports `BLOCKED`, decide whether this is a stop condition. If it is, stop. If it is not (for example, a question the repository answers), resume it with the answer.

## 5. Verify and commit

Do not rely on the implementer's report as evidence. Check the result yourself:

- `git status --porcelain` and `git diff`. Read any new untracked files. Every changed file must belong to the slice. If something is outside scope, resume the implementer to revert or explain it.
- Run the test (and lint/type-check) commands yourself and record the actual results. Compare them with the baseline.
- Commit only the slice's files, named explicitly (`git add <paths>`, never `git add -A` or `.`). Follow the repository's commit style, reference the issue, and add any attribution lines this session requires. Record the SHA.

## 6. Independent review

- Write the complete diff against the base to `<handoff dir>/review-<k>.diff` (`git diff <base>..HEAD > <file>`). Do not edit or filter it.
- Start a **new** `slice-reviewer` subagent for every review round, never a resumed one. Its brief contains:
  - the issue or slice text and the acceptance criteria verbatim;
  - the diff file path, the changed-file list, the base SHA, and the branch;
  - the repository instruction files and any relevant specs or docs;
  - the exact test commands and actual results you recorded (baseline and current);
  - on later rounds: the previous findings, and for each one what was changed (commit SHA) or why it was rejected;
  - the implementer's stated assumptions and unverified items, labelled as **unverified claims to check**.
  Do not include the implementer's reasoning or your own opinion of the change.
- Record the verdict and every finding in the handoff record.

## 7. Correction loop

For each **blocking** finding:

1. Check it against the code. If it is demonstrably wrong, record it as rejected with evidence and make sure the next review round sees that rationale. Do not reject findings merely because they are inconvenient.
2. Otherwise, resume the same implementer (SendMessage with its agent ID) with only the finding: id, evidence, impact, and fix direction. Ask for the smallest fix and no other changes.
3. Repeat step 5 (verify scope, run checks yourself, commit), then step 6 with a new reviewer, focused on the affected behavior but given the full current diff.

Count attempts per substantive problem. A problem counts as the same one if a later finding has the same root cause, even if it has a new id. After **two unsuccessful attempts** at the same problem, or **three review rounds** that each end BLOCKED, stop (condition 5). Report the problem, what was tried, the current diagnosis, and the state of the branch.

Do not act on **should-fix** or **nit** findings unless the fix is small, clearly in scope, and does not change behavior beyond the slice. Record the others as deferred, and list them in the PR.

The review passes when the verdict is PASS, or all remaining findings are non-blocking and every acceptance criterion is `met` or `cannot determine locally`.

## 8. Finish

Set the handoff phase to `ready` and choose the ending:

- **No-PR mode, or the repository has no PR workflow:** do not push. Report the branch and commits, and put the PR title and body you would have used (below) in your report and in the handoff record.
- **PR workflow:** if the repository's instructions require explicit approval for push or PR creation, stop (condition 6) and show the title and body first. Otherwise, or once approved: push the branch (`git push -u origin <branch>`, never to the default branch) and open the PR with `gh pr create` against the default branch, following any PR template in `.github/`. Do not merge it. Record the PR URL.

PR body (adapt to any template):

```markdown
Closes #<n>   (use "Part of #<n>" if the issue has more slices)

## What changed
## Acceptance criteria
<each: met — evidence | cannot determine locally — why>
## Verification performed
<exact commands and actual results; baseline failures noted>
## Not verified
<what was not checked, and why>
## Post-deployment smoke test
Required: yes/no. <if yes: exactly what to check after deploy>
## Review
<review rounds, findings and resolutions, deferred non-blocking findings>
## Assumptions and risks
```

## 9. Report

End with a concise report to the user:

- issue and slice, and the final phase (ready / pr-open / stopped);
- branch, base, and commits (and PR URL if one was opened);
- changed files;
- checks run and their actual results, compared with the baseline;
- review rounds: findings and how each was resolved;
- what remains unverified, and whether a post-deployment smoke test is needed;
- assumptions and open risks;
- the handoff file path;
- if stopped: which stop condition applies, the diagnosis, and the decision or action needed from the user.
