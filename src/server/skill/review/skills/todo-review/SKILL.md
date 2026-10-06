---
name: todo-review
description: "Works a board project's To do tickets to hand-off: one unattended todo-review-ticket agent per ticket runs spec, build and the /feature-review cycle (verify and hunt, refute) until the change survives it, then pushes, opens the PR, starts a preview and posts screenshots; a ticket is moved to blocked only for what only the human can provide, after the agent has gone as far as it can. The orchestrator schedules, checks each result against the board, and sends weak blockers back."
user-invocable: true
argument-hint: "[project=<id>] [<ticket id> ...] [parallel=N] [rounds=N] [model=<name>] [dry]"
---

# Todo Review

You are the orchestrator. You never write or review code. You inventory the To do tickets, decide
which can run at the same time, hand each one to a `todo-review-ticket` agent, check what comes
back **against the board** (not against what the agent says), send weak blockers back, and report.
Keep your own context small: read only each agent's result lines and the tickets' state.

This skill needs the board's MCP tools (`get_project`, `list_tickets`, `get_ticket`, …). Without
them, stop and say so.

## Arguments

Parse `$ARGUMENTS` as space-separated tokens:

| Token | Meaning | Default |
|---|---|---|
| `project=<id>` | the board project | the project of the repo in the current directory (the board skill's table, or `list_projects` matched by repo path or GitHub slug) |
| a number | work only these ticket ids, in this order | every eligible To do ticket |
| `parallel=N` | maximum tickets in flight, 1 to 3 | 2 |
| `rounds=N` | build-and-review rounds per ticket before it goes to the human | 3 |
| `model=<name>` | model for the ticket agents, which their own agents inherit | the session model |
| `dry` | inventory and schedule only: write the plan, start nothing | off |

## Step 1: Inventory

Create `QUEUE = ~/.claude/feature-review/todo-<YYYYMMDD-HHMM>/` (resolve `~` with `echo ~`).

1. `whoami` (your board name) and `get_project`: its `instructions`, `repos[]` (id, checkout path,
   base branch), `stages[]` and `agents[]`. The agents' `delegation` notes are the routing table
   the ticket agents follow; an agent without them is never delegated to.
2. `list_tickets` with `status: ["todo"]`. A ticket is eligible when it is:
   - unassigned, or assigned to you;
   - not `reserved`, or reserved for a project agent that has instructions (the ticket agent then
     works it `as` that agent);
   - free of unmerged `needs`: a ticket whose needs are not all `merged` builds on someone else's
     open branch; skip it with "waits on #<id>";
   - not waiting on the human: `decisions` (its open decision cards) is 0, else skip it with
     "decision open".
   An explicit ticket list overrides the first rule only: those are worked even when assigned to
   someone else, and the board logs the takeover.
3. Order: the explicit list's order, else oldest `createdAt` first.
4. Per ticket, its repo (`repoId`, else the project's first repo) and that repo's checkout path
   and base branch. A repo whose checkout path does not exist on this machine: skip its tickets
   with "repo not on this machine".
5. Write `QUEUE/plan.md`: every ticket with its repo, eligibility and the reason it was skipped.
   With `dry`, print it and stop.

## Step 2: Schedule

A **lane** is an exclusive resource; two tickets run at the same time only when they share none.

| Lane | Held by | Why |
|---|---|---|
| `repo:<id>` | every ticket of that repo | one main checkout, its git lock, its test store, and the machine's CPU: two builds of one repo at once make its tests flaky |
| `browser` | the one ticket allowed `browser=yes` | the browser automation tool is a single shared instance |

Rules:
1. Never two tickets of the same repo at once.
2. At most one ticket holds `browser`. Give it to the first ticket that starts; every other
   concurrent ticket runs with `browser=no`. A ticket that needs the browser for its evidence
   returns `STATUS: needs-browser` and is re-queued to run with it.
3. Each concurrent slot gets its own port range for the review's servers: slot 1 `8100-8199`,
   slot 2 `8200-8299`, slot 3 `8300-8399`.
4. The total never exceeds `parallel`: each ticket runs a build and a full review, so 3 is the
   ceiling.

## Step 3: Run

Loop until nothing is pending or running:
- Fill every free slot with the first pending ticket whose lanes are free. Spawn one
  `todo-review-ticket` agent per ticket, all in one message when several start together, with:
  `PROJECT=<id>`, `TICKET=<id>`, `REPO=<checkout path>`, `REPO_ID=<id>`, `BASE=<base branch>`,
  `PORTS=<slot range>`, `BROWSER=<yes|no>`, `ROUNDS=<n>`, `AS=<agent name>` when the ticket is
  reserved, and `QUEUE`. Pass `model` on the Agent call when `model=` was given. They run in the
  background; do not poll. Continue when a completion notification arrives.
- On completion, release the ticket's lanes and slot, check the result (Step 4), then fill the slot
  again.

## Step 4: Check each result

The agent returns eight lines (`STATUS`, `TICKET`, `VERDICT`, `ROUNDS`, `PR`, `PREVIEW`,
`BLOCKER`, `NOTES`). They are claims. `get_ticket` and check them, in order:

1. **`handed-off`**: the ticket is in a `review` stage, `push.state` is `pushed`, `pr` is set,
   the PR's CI has finished and passed (`gh pr checks <number>`; still running: wait for it),
   and `handoff.missing` is empty, or holds only `no_preview` with a hand-off post saying why the
   change cannot be tried. The hand-off post (the newest progress post of the agent's) has
   screenshots in its attachments when the change has a UI, and a "Tested" part. Anything missing:
   send it back once (below) with the list.
2. **`blocked`**: the ticket is in a `blocked` stage with an open decision card or a post that
   says what is needed. Then judge the blocker. It stands only in these categories:
   - `decision`: two valid behaviours, a product or scope call, or `rounds` used up (the agent
     asked ship as is / keep going / drop);
   - `credential`: a secret or account the work cannot be written without, that the project has
     no test mode, emulator, seed or fake for;
   - `external`: a service, device or permission outside this machine;
   - `destructive`: the next step touches production data, real users, money, or rewrites shared
     history;
   - `environment`: a machine-level install or setting that needs the human (admin rights, a
     licence), with the exact command for them.
   Each must list at least two things the agent tried. A blocker outside these categories, or
   without what was tried ("tests fail", "could not get it running", "port busy", "unclear
   ticket" with no question asked), is **weak**: send it back once.
3. **`needs-browser`**: re-queue once with `browser=yes` (it waits for the browser lane).
4. **`error`**: if `NOTES` shows contention (a port held by another process, the browser
   unavailable, a git lock), re-queue once to run alone after everything else. Otherwise record it,
   and make sure the ticket is not left in progress with no word: `comment` on it with the error
   and leave it where it is.

**Sending back** is one more `todo-review-ticket` run for the same ticket with `RETRY=<what the
check found>` added. It resumes from the ticket's resume note and posts, not from scratch. Each
ticket is sent back or re-queued at most once; after that its result is recorded as it is.

Record the row: ticket, title, repo, status, verdict, rounds, PR, preview, blocker, notes.

## Step 5: Report

1. Write `QUEUE/summary.md`: one table of the tickets worked (the Step 4 rows), then the skipped
   tickets with their reasons, then what waits on the human: every blocked ticket with its one-line
   ask, and every PR to review.
2. `post_daily_summary` for the project: at most three short lines (handed off, blocked, what
   waits on the human).
3. Print the table to the user, then what waits on them, then `QUEUE`. Do not restate findings or
   diffs: the tickets and PRs carry them.

## Notes

- Delegation depth: you spawn ticket agents; a ticket agent spawns its spec and builder agents and
  runs `/feature-review`, whose phase agents (env, verify, hunt, refute, merge) are its own. Do not
  add a level, and never do a ticket agent's work yourself.
- Never two ticket agents on one ticket or one branch. Never move a ticket yourself except to leave
  a comment on an error; the ticket agents own their tickets' stages.
- Nothing here merges, approves, or comments on GitHub. Pushing the ticket's own branch and opening
  its PR (the project's way) are the ticket agent's only remote writes.
- If the user interrupts, tell them which tickets were in flight. Their worktrees are registered
  on the tickets (`get_ticket` → `workspaces`), and `git worktree list` in each repo shows what is
  left, review worktrees under `~/.claude/feature-review/` included.
