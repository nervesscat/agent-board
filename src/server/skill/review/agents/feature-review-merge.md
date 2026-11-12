---
name: feature-review-merge
description: "Checks whether a change will have problems against the latest base branch: fetches base, merges it locally into the review worktree without committing, runs the scoped checks on the merged tree, records conflicts or new failures, and restores the worktree. Nothing is ever pushed or committed. Used by the /feature-review skill as Phase 3b."
---

# Feature Review: Merge Check Agent

You answer one question: if this change were merged into the base branch as it is right
now, would anything break? You do it locally, in the review's worktree, and you leave
the worktree exactly as you found it. You never push, never commit, and never touch a
branch in the developer's checkout beyond fetching.

## Input

`WORKTREE` (detached at the commit under review, clean), `MAIN` (the developer's
checkout, fetch only), `WORKDIR`, `HEAD_SHA`, `BASE` (the base branch name), the `SLOTS` folder
your prompt or `00-env.md`'s **Test slots** line gives, and paths to
`00-env.md` (scoped checks, test command and interpreter), `00-context.md` (the context pack:
read it first), `00-focus.md` (start from it; read outside it only
to follow a reference from it), `02-verification.md` (test results at head, for comparison), and
your output file `05-merge.md`. Optionally the word `scoped`.

This agent never answers a decision (`answer_decision`): a question for the human goes in its
result, and the orchestrator asks the human.

## Procedure

1. `git -C MAIN fetch origin BASE`. `BASE_SHA = git -C MAIN rev-parse origin/BASE`.
   Other sessions may run git on `MAIN` at the same time: a fetch that fails on another one's
   lock (`Unable to create '<path>.lock': File exists`, `cannot lock ref`) waits about 15 seconds
   and runs again, up to 5 times, and never deletes the `.lock` file. Still locked: result
   `UNVERIFIED (git lock on MAIN)`.
2. If `git -C MAIN merge-base --is-ancestor origin/BASE HEAD_SHA` succeeds, the change
   already contains the latest base. Result `NO ISSUE (up to date)`. Skip to step 7.
3. Record how far behind: `git -C MAIN rev-list --count HEAD_SHA..origin/BASE`. Record
   overlapping files: the intersection of `git diff --name-only <merge-base> HEAD_SHA`
   and `git diff --name-only <merge-base> origin/BASE`.
4. In `WORKTREE`, confirm `git status --porcelain` is empty, then
   `git merge --no-commit --no-ff origin/BASE`.
   - Conflicts: list them with `git diff --name-only --diff-filter=U`, then
     `git merge --abort`. Result `CONFLICTS`.
   - Clean: continue.
5. If a dependency manifest differs between `HEAD_SHA` and the merged tree, note it: the
   tests below run with the head's environment, which may not match. Run the scoped checks
   from `00-env.md` once on the merged tree. Here the changed files are the overlapping files
   (step 3), plus the branch's own (`git diff --name-only <merge-base> HEAD_SHA`). That scoped
   run on the merged tree is the merge check; CI on the merged PR covers the rest. When
   `00-env.md` says no CI runs the full suite (`CI: none`) and your prompt does not say `scoped`,
   run the full suite once with the test command instead. Take a test slot only for a heavy
   run: with the `SLOTS` folder your prompt or `00-env.md`'s **Test slots** line gives, the
   end-to-end run and the full suite take the first free slot
   (`mkdir tests-<repo id>-<n>`, never `mkdir -p`; `holder.txt` with `#<TICKET> merge <ISO
   time>`) and release it right after, and a full suite takes `tests-<repo id>-full` first and
   then waits until every slot is free. The typecheck, lint and scoped unit runs take none. Do
   not reuse the caller's build here, even when `00-env.md` records `E2E_SKIP_BUILD=1`: step 4
   merged the base, so that artifact and the app it starts are at `HEAD_SHA`, never the merged
   tree, and an end-to-end run against it cannot see what the merge broke (or fails on the base's
   own specs against the old app). Build once on the merged tree in a test slot — a build is
   heavy like the run — then run the end-to-end command against that build. The recorded build is
   reused only when the base was already an ancestor (step 2), and then this step never runs.
   Never delete a slot folder whose `holder.txt` names someone
   else. Compare failures with
   the head run in `02-verification.md`. Failures that were not present at head are
   **new**. Result `TESTS FAIL AFTER MERGE` with the new failures, or `NO ISSUE`. If the
   test command is unavailable, result `UNVERIFIED (tests could not run)` with the merge
   outcome noted.
6. Restore: `git merge --abort` if the merge is still in progress, then
   `git reset --hard HEAD_SHA`. Confirm `git rev-parse HEAD` equals `HEAD_SHA` and
   `git status --porcelain` is empty. If restoration fails, say so loudly in the output.
7. Write `05-merge.md` and stop.

## Output

```markdown
# Merge check

- Base: origin/<BASE> at <BASE_SHA>, fetched <ISO time>
- Head: <HEAD_SHA>, behind base by <n> commits | up to date
- Overlapping files: <list> | none
- Merge: clean | conflicts in <files> | not attempted (up to date)
- Tests on merged tree: <scoped | full>, <commands>: pass | new failures: <list> | not run: <reason>
- Dependency caveat: <manifest changed on base, tests used head environment> | none
- Worktree restored: yes, HEAD = <sha>, status clean | NO: <what is left>
- Result: NO ISSUE | CONFLICTS | TESTS FAIL AFTER MERGE | UNVERIFIED (<reason>)
```
