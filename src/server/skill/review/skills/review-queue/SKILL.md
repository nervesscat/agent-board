---
name: review-queue
description: "Reviews every open pull request across one or more repos by delegating one unattended /feature-review run per PR, scheduling runs in parallel only when they cannot contend for the same repo, ports, or browser, checking each result, re-queuing the ones that failed for environmental reasons, and writing a queue summary."
user-invocable: true
argument-hint: "[<repo path> ...] [<PR number> ...] [build] [deep] [force] [drafts] [post] [parallel=N]"
---

# Review Queue

You are the orchestrator. You never review code. You inventory the open PRs, decide
which can run at the same time, hand each one to a `feature-review-runner` agent, check
what comes back, and produce a PDF report. Keep your own context small: read only the
runner's summary lines, never a review's findings.

Nothing is ever pushed, committed, or changed on GitHub by this queue. Fetching, and a
PR comment only when `post` is given, are the only remote operations, and the runners
carry the same rule.

## Arguments

Parse `$ARGUMENTS` as space-separated tokens:

| Token | Meaning | Default |
|---|---|---|
| a path that is a directory | a repo to include | the current working directory |
| a number | review only these PR numbers (applies to every listed repo) | all open PRs |
| `mine` | only PRs where the user's review is requested (`--search "review-requested:@me"`) | all open PRs |
| `model=<name>` | model for the runner agents, which their phase agents inherit (e.g. `opus`) | the session model |
| `frontend=<path>` | UI repo checkout passed through to every review; each review then starts the dashboard against its own backend and drives it, so every review holds the browser lane and they run one at a time | none |
| `deep` | pass through to every review | off |
| `force` | review PRs even if the ledger or the board already has a review of their current head SHA, and include PRs with merge conflicts | off |
| `drafts` | include draft PRs | off |
| `post` | pass through: each fresh review posts itself as a PR comment | off |
| `parallel=N` | maximum concurrent reviews, 1 to 3 | 2 |
| `build` | on the board, after the reviews, also work the project's To do tickets with `/todo-review` (see **On the board**) | off |

## Step 1: Inventory

Create `QUEUE = ~/.claude/feature-review/queue-<YYYYMMDD-HHMM>/` (resolve `~` with
`echo ~`). For each repo, from its directory:

1. `gh auth status` must succeed. If it does not, stop and tell the user.
2. `gh pr list --state open --limit 100 --json number,title,headRefOid,headRefName,baseRefName,isDraft,mergeable,updatedAt,url,author,files`,
   adding `--search "review-requested:@me"` when `mine` was given.
3. Drop PRs not in the explicit number list when one was given. Drop drafts unless
   `drafts`. Drop `mergeable == CONFLICTING` unless `force`, recording "skipped:
   conflicts with base" in the summary.
4. Read `~/.claude/feature-review/ledger.jsonl` if it exists. A PR whose repo and
   `headRefOid` already appear in a non-stale entry is dropped unless `force`, recording
   "already reviewed: <verdict>, <path>" in the summary.
5. A PR whose `~/.claude/feature-review/<repo-dir>-pr-<N>/CLAIM.md` exists, is less
   than 6 hours old, and has no ledger entry for that PR written after the claim, is
   being reviewed by another session. Drop it, recording "in flight elsewhere: <claim
   contents>", and cite that directory's `summary.md` in the report if it exists by the
   time the PDF is built. Re-check this right before launching each
   runner, since claims can appear while the queue runs.

## Step 2: Classify for scheduling

Scheduling needs only a rough idea of what each review will touch. Do not read the code.

Per PR, from `files[].path`:
- `ui` if any path ends in `.tsx .jsx .vue .svelte .html .css .scss` or lives under a
  directory named `frontend`, `web`, `ui`, `client`, or `components`.
- `static` if every path is documentation, an image, a license, a CI workflow, or a
  lockfile-free config with no code. Static reviews need no runtime.
- `runtime` otherwise.

Per repo, once:
- Ports it declares: grep `docker-compose*.yml`, `compose*.yml`, `.env.example`,
  `Makefile`, `package.json`, `Procfile`, and the main entry file for 4 or 5 digit
  numbers that read as ports. Note whether an override exists for each (`PORT`,
  `<NAME>_PORT`, `${VAR:-8080}`, a `--port` flag). A port with no override is **fixed**.
- Write the inventory and classification to `QUEUE/plan.md`.

## Step 3: Schedule

A **lane** is an exclusive resource. Two reviews may run at the same time only when they
share no lane. Lanes:

| Lane | Held by | Why |
|---|---|---|
| `repo:<path>` | every non-static review of that repo | one app, one compose stack, one test store, mostly fixed ports |
| `port:<n>` | every runtime review of a repo that declares fixed port `n` | two repos with a fixed 8080 cannot both start |
| `browser` | every `ui` review | the browser automation tool is a single shared instance |

Rules:
1. Never two reviews of the same repo at once, static ones excepted.
2. Across repos, run in parallel when their fixed ports do not overlap. Overridable ports
   never conflict: each concurrent slot gets its own allocation range, slot 1
   `8100-8199`, slot 2 `8200-8299`, slot 3 `8300-8399`.
3. At most one `ui` review at a time, and it is the only review allowed `browser=yes`.
   Every other concurrent review runs with `browser=no` and records its UI criteria as
   unverified; if such a PR later needs the browser, it can be re-run alone.
4. The total never exceeds `parallel`. Each review spawns up to five agents and starts
   servers, so 3 is the ceiling.
5. Order: the explicit PR list order if one was given; otherwise oldest `updatedAt`
   first within each repo. Whenever a slot frees, take the first pending PR whose lanes
   are all free.

When in doubt whether two reviews conflict, serialize them. A wrong guess costs a
re-run, not correctness: the environment agent refuses busy ports, so contention shows
up as an unverified result, never as a review of the wrong code.

## Step 4: Run

Loop until nothing is pending or running:
- Fill every free slot with the first pending PR whose lanes are free. Spawn one
  `feature-review-runner` per PR, all in one message when several start together, with:
  `REPO=<abs path>`, `TARGET=<number>`, `PORTS=<slot range>`, `BROWSER=<yes|no>`, and the
  pass-through flags. Pass `model` on the Agent call when `model=` was given. Runners
  run in the background; do not poll. Continue when a completion notification arrives.
- On completion, release the runner's lanes and slot, check the result (Step 5), then
  fill the slot again.

## Step 5: Check each result

The runner returns eight lines (`STATUS`, `VERDICT`, `CHECKS`, `COUNTS`, `SHA`, `REVIEW`,
`SUMMARY`, `NOTES`). Apply, in order:
1. `STATUS: error`: record it. If `NOTES` shows contention (a port held by another
   process, browser unavailable), re-queue the PR once to run **alone** after everything
   else finishes. Otherwise it stays an error in the summary.
2. `VERDICT` starts with `STALE`: the PR received new commits during the review. Fetch
   the new `headRefOid` and re-queue once at the end.
3. `VERDICT` is `COULD NOT VERIFY` and `NOTES` names a port or browser problem:
   re-queue once, alone. If the reason is credentials or a missing service nobody can
   provide, keep the result.
4. Sanity: the `REVIEW` path exists and `SHA` matches the inventory's `headRefOid` (or
   the refreshed one for a re-queued PR). Anything else is recorded as an error.
5. Record the row: repo, PR, title, short SHA, verdict, the three checks, counts,
   review path, summary path, notes.

Each PR is re-queued at most once.

## Step 6: Report

1. For every PR that ended in `STATUS: error` after its re-queue, write a stand-in
   `QUEUE/<repo>-pr-<N>/summary.md` in the same format as
   `~/.claude/skills/feature-review/summary-template.md`: *What it does* from the PR
   title and body, *How to test it* as "not established: the review could not run",
   *Findings* as one line with the error reason, and the checks `NO`, `NO`, `YES` with
   "not verified" as the reason. Every PR in the inventory gets a page.
2. Build the PDF from the summaries in queue order:
   ```
   python ${CLAUDE_SKILL_DIR}/build_pdf.py --out QUEUE/report.pdf --title "Review queue <date>" <summary.md paths...>
   ```
   The script renders with a headless Edge or Chrome and falls back to fpdf2; if it
   prints that no renderer was found, tell the user where the HTML is.
3. Write `QUEUE/summary.md`: one table per repo with PR, title, SHA, verdict, the three
   checks, counts, review path, notes; then the skipped PRs with their reasons.
4. Print the tables to the user, then the PDF path and the queue directory. Do not
   restate findings: the review files and the PDF carry them.

## On the board

When the board's MCP tools are available and a repo belongs to a board project (the board skill's
table, or `list_projects`), the board is the queue, and the project's agents are the team.

**Read the team first.** `get_project` → `agents`: each has `instructions` (its brief) and
`delegation` (when to call it, what to give it, what it returns, what comes next). The delegation
notes are your routing table. An agent without them is never delegated to. The default set is
`spec`, `builder`, `env`, `verify`, `hunt`, `refute`, `merge` and `runner`; the human may
have renamed, rewritten or added some, so route by the notes, not by these names.

**Reviews.** Step 1's inventory comes from `list_prs` (status `pending`, not `on_hold`), not
`gh pr list`; the board's queue is what the human wants reviewed. A PR whose head SHA already has
a result in `list_review_results` (with `sha`), or a ledger entry for that SHA from any target (a
review of its branch before the PR, such as `/todo-review`'s, included), counts as reviewed and is
skipped, unless `force`. Each
runner gets `ticket=<id>` (the PR's first ticket) so the review reports on the board (the
feature-review skill's **On the board** section); after Step 5, check that a result for that SHA
is in `list_review_results`, and record it yourself with `post_review_result` from the runner's
summary if not.

**Building** (`build` only). After the reviews and their report, run the `todo-review` skill through
the Skill tool for the same project, passing `parallel` and `model` through. It works the To do
tickets through the build cycle (spec → builder → `/feature-review` until the change survives →
hand-off), one `todo-review-ticket` agent per ticket, with its own scheduling and report. Do not
work tickets yourself.

## Notes

- Delegation depth: you spawn runners, runners spawn the review's phase agents. Do not
  add a level.
- Never read a `review.md` yourself beyond what the runner already summarized. If the
  user wants details on one PR, point them at its path.
- If the user interrupts, tell them which reviews were running; their runners' teardown
  may not have completed, so `git worktree list` in each repo and
  `docker ps --filter name=fr-` show what is left to clean.
