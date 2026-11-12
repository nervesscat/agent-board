---
name: todo-review
description: "Works a board project's To do tickets to hand-off, several at once (same repo included): one unattended todo-review-ticket agent per ticket builds the change and runs the /feature-review cycle (verify and hunt, refute) as many rounds as the ticket's complexity sets (low none, mid one, high three, max up to ten for work built from scratch), at a depth scaled to the change, until the change survives it, then pushes, opens the PR, starts a preview and posts screenshots; a ticket is moved to blocked only for what only the human can provide, after the agent has gone as far as it can. The orchestrator schedules, checks each result against the board, and sends weak blockers back."
user-invocable: true
argument-hint: "[project=<id>] [<ticket id> ...] [parallel=N] [depth=auto|light|standard|deep] [model=<name>] [dry]"
---

# Todo Review

You are the orchestrator. You never write or review code. You inventory the To do tickets, decide
which can run at the same time, hand each one to a `todo-review-ticket` agent, check what comes
back **against the board** (not against what the agent says), send weak blockers back, and report.
Keep your own context small: read only each agent's result lines and the tickets' state.

This skill needs the board's MCP tools (`get_project`, `list_tickets`, `get_ticket`, …). Without
them, stop and say so.

## In a session without the board's tools, agent types or the Agent tool

A cloud session, or any client that reaches the board only through a proxy, may lack what this skill
names. Go on as below, and say in the run's summary which of these applied:

- **No `board` MCP tools**: start them with the `board-mcp` bridge (the board's README, "Cloud
  agents"), or call each tool's REST route instead: the board skill served with `?transport=rest`
  (`<board>/api/agent-setup/skill?transport=rest`) lists every tool with its route. The agent token
  comes from the environment, never from a prompt, and is never printed.
- **The agent types (`todo-review-ticket`, `feature-review-*`) are not offered**: their files are in
  `~/.claude/agents/`, but the session did not load them. Start a general-purpose agent whose prompt
  says to read `~/.claude/agents/<type>.md` (everything after its frontmatter) as its instructions,
  followed by the brief this skill gives it, at the same effort.
- **No Agent tool** (a subagent cannot start subagents): run each phase yourself, in order, following
  its agent file as your own instructions; phases this skill runs in parallel run one after the other.
- **No board-run preview of your worktree** (the board's machine cannot see it): push the branch, then
  `preview_branch` (`POST /api/tickets/:id/branch-preview`): the board fetches the branch into a
  worktree of its own and runs the repo's preview there.

## Arguments

Parse `$ARGUMENTS` as space-separated tokens:

| Token | Meaning | Default |
|---|---|---|
| `project=<id>` | the board project | the project of the repo in the current directory (`find_project` with its origin, folder and path) |
| a number | work only these ticket ids, in this order | every eligible To do ticket |
| `parallel=N` | maximum tickets in flight, 1 to N+1 (so 1 to 3 with N = 2; the cap is one more than the repo's test slots, since a ticket waiting for one still does its light work), tickets of the same repo included | 2 |
| `depth=auto\|light\|standard\|deep` | the review depth: `auto` lets each ticket agent pick it from the size of its change (`todo-review-ticket`, "Review depth"); any other value is used for every ticket and every round | `auto` |
| `model=<name>` | model for the ticket agents, which their own agents inherit | the session model |
| `dry` | inventory and schedule only: write the plan, start nothing | off |

## Step 1: Inventory

Create `QUEUE = ~/.claude/feature-review/todo-<YYYYMMDD-HHMM>/` (resolve `~` with `echo ~`) and
`QUEUE/locks/`, where the ticket agents keep their repos' test slots (Step 2).

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
     "decision open". An unattended run never answers such a card (`answer_decision`); an
     interactive run may answer one only after it asked the human in the chat (AskUserQuestion in
     Claude Code, or the client's equivalent, with the card's options) and they answered there.
   An explicit ticket list overrides the first rule only: those are worked even when assigned to
   someone else, and the board logs the takeover.
3. Order: the explicit list's order, else oldest `createdAt` first.
4. Per ticket, its repo (`repoId`, else the project's first repo) and that repo's checkout path
   and base branch. A repo whose checkout path does not exist on this machine: skip its tickets
   with "repo not on this machine".
5. Write `QUEUE/plan.md`: every ticket with its repo, its complexity (the `complexity` field of its
   list row), eligibility and the reason it was skipped.
   With `dry`, print it and stop.

## Step 2: Schedule

A **lane** is an exclusive resource held for a ticket's whole run; two tickets run at the same time
only when they share none.

| Lane | Held by | Why |
|---|---|---|
| `ticket:<id>` | the run of that ticket | never two agents on one ticket: a send-back or re-queue starts only after its previous run returned |
| `branch:<name>` | the ticket whose `branch` is that name | never two agents on one branch: two tickets that carry the same `branch` never run together. A ticket with no `branch` yet gets a new name that its agent makes its own by creating the branch, and it works only in a worktree registered on its ticket (`todo-review-ticket` steps 1.3 and 1.4) |
| `browser` | the one ticket allowed `browser=yes` | the browser automation tool is a single shared instance |

There is no lane per repo: tickets of the same repo run at the same time, each in its own worktree
on its own branch. What they still share is guarded by step, not for the whole run:

| Shared | Guard | Rule in |
|---|---|---|
| the main checkout's git (`fetch`, `worktree add` and `remove`, the push updating its refs) | a git command that meets another one's `.lock` waits and runs again; never deletes the lock; a lock error is never the ticket's failure | `todo-review-ticket`, "Shared with the other tickets of this repo"; `/feature-review` Setup |
| the machine's CPU: two heavy runs of one repo at once make its tests flaky | the repo's **test slots** `QUEUE/locks/tests-<repo id>-1` … `-N` (N = 2, the measured count) and `QUEUE/locks/tests-<repo id>-full` for a full suite: a heavy run holds one slot, a light one none. Heavy is a build, the end-to-end tests scoped or full, and the full unit suite; the typecheck, lint, formatter, migration check, scoped unit tests and probe tests take none. The ticket agent takes the first free slot right before a heavy run and releases it right after | `todo-review-ticket`, same section |

Rules:
1. Tickets of the same repo may run at the same time, up to `parallel`. Only the lanes above keep
   two tickets apart.
2. At most one ticket holds `browser`. Give it to the first ticket that starts; every other
   concurrent ticket runs with `browser=no`. A ticket that needs the browser for its evidence
   returns `STATUS: needs-browser` and is re-queued to run with it.
3. Each ticket in flight gets its own slot, whatever its repo, and each slot its own port range for
   the review's servers: slot 1 `8100-8199`, slot 2 `8200-8299`, slot 3 `8300-8399`. Two tickets
   in flight never share a slot.
4. The total never exceeds `parallel`, and that cap is one above the test slots, not equal to
   them: a ticket waiting for a test slot still does its typecheck, lint and scoped unit tests, so
   N tickets may be running heavy checks while another one does its light work. With N = 2 that
   is 3 in flight.
5. The order the ticket agents take their test slots in: they take their own with a plain
   `mkdir`, and a heavy run's slot goes to the ticket closest to hand-off — a fix pass after a
   review, one whose PR, CI or preview is pending, one whose open tasks are nearly done — before a
   ticket still in its first build. A ticket takes a slot only for the run that needs it and never
   waits on one it does not need.

## Step 3: Run

Loop until nothing is pending or running:
- Fill every free ticket slot with the pending ticket closest to hand-off whose lanes are free
  (Step 2 rule 5). Spawn one
  `todo-review-ticket` agent per ticket, all in one message when several start together, with:
  `PROJECT=<id>`, `TICKET=<id>`, `REPO=<checkout path>`, `REPO_ID=<id>`, `BASE=<base branch>`,
  `PORTS=<slot range>`, `BROWSER=<yes|no>`, `COMPLEXITY=<low, mid, high or max>`,
  `DEPTH=<light|standard|deep>` when
  `depth=` was given and is not `auto`, `AS=<agent name>` when the ticket is reserved, and
  `QUEUE`. Pass `model` on the Agent call when `model=` was given. Pass `effort` on the Agent call
  as the ticket's complexity sets it: `low` for low, `medium` for mid and high, `high` for max; the ticket agent passes
  the same effort to every agent it starts (spec, builder, the review's phase agents). Tell it to
  `get_ticket` the ticket before anything else and to carry its context — the instructions, the
  human's posts and replies, the decisions and their answers, the attachments — into every agent
  it starts (a phase agent may read the rest itself). They run in the background; do
  not poll. Continue when a completion notification arrives. Record each start on the ticket's work
  timeline: `handoff` with `projectId`, `ticketId` and `to` the ticket agent's name.
- While runs are in flight, the ticket agents keep their tickets' work timelines (a `heartbeat`
  every few minutes, `start_span` / `end_span` around each phase, `start_wait` / `end_wait` with the
  reason, `handoff` to each agent they start). A ticket that reads as stalled (`get_summary` →
  `needsYou.stalled`, or `stalled` on `list_tickets`) has an agent that stopped saying anything:
  check on its run (a notification you missed, an agent that died) before anything else.
- On completion, however the run ended (a result, an error, an agent that died), release the
  ticket's lanes and slot, and clear the repo's dead test slots: remove every folder under
  `QUEUE/locks/` whose `holder.txt` names this ticket (`tests-<repo id>-<n>` and
  `tests-<repo id>-full`), and nothing else. The agent releases its own right after each heavy
  run; this covers a run that ended any other way, and clears a slot a dead run left behind. You
  are the only one besides the holder who clears a dead run's slot, and only when its
  `holder.txt` names that ticket. Then check the result (Step 4) and fill the slot again.

## Step 4: Check each result

The agent returns nine lines (`STATUS`, `TICKET`, `VERDICT`, `ROUNDS`, `DEPTH`, `PR`, `PREVIEW`,
`BLOCKER`, `NOTES`). They are claims. `get_ticket` and check them, in order:

1. **`handed-off`**: the ticket is in a `review` stage, `push.state` is `pushed`, `pr` is set,
   the PR's CI has finished and passed (`gh pr checks <number>`; still running: wait for it),
   and `open` is empty, or holds only the Preview phase with a summary saying why the
   change cannot be tried. The ticket's summary (`summary` on `get_ticket`, `fallback: false`:
   the hand-off is the summary the agent wrote, not a separate post) has
   screenshots in its attachments when the change has a UI, and a "Tested" part that names the
   level and what checked it (for mid, high and max, the review depth and why). Unless `depth=` was given
   (other than `auto`), measure the branch
   yourself the way the ticket agent's "Review depth" says
   (`git -C REPO diff --numstat origin/BASE...<branch>`, lockfiles and generated files left out,
   and the Classification of `QUEUE/t<id>/01-spec.md`): `DEPTH` must be at least the depth that
   measure gives (`light`, then `standard`, then `deep`); below it, the change was reviewed too
   lightly. A low ticket skips this measure: it has no review, so its `DEPTH` is `none`.
   Anything missing or wrong: send it back once (below) with the list.
2. **`blocked`**: the ticket is in a `blocked` stage with an open decision card or a post that
   says what is needed. Then judge the blocker. It stands only in these categories:
   - `decision`: two valid behaviours, a product or scope call, the complexity's rounds used up, or
     the gate's two returns used up (the agent asked the human what to do next: ship as is, keep going
     or drop). The human answers that card: an unattended run never answers it (`answer_decision`),
     and it stays blocked for them;
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
   unavailable, a git lock still held after the retries or a review's "git lock on MAIN", a
   test slot waited on too long), re-queue once to run alone after everything else: it starts
   only when no other ticket is in flight, and nothing else starts while it runs. Otherwise record
   it, and make sure the ticket is not left in progress with no word: `comment` on it with the
   error and leave it where it is.

**Sending back** is one more `todo-review-ticket` run for the same ticket with `RETRY=<what the
check found>` added. It resumes from the ticket's summary and posts, not from scratch. It goes
back in the queue and starts like any other ticket, only after the previous run of that ticket has
returned (`ticket:<id>`). Each ticket is sent back or re-queued at most once; after that its result
is recorded as it is.

Record the row: ticket, title, repo, status, verdict, rounds, depth, PR, preview, blocker, notes.

## Step 5: Report

1. Write `QUEUE/summary.md`: one table of the tickets worked (the Step 4 rows), then the skipped
   tickets with their reasons, then what waits on the human: every blocked ticket with its one-line
   ask, and every PR to review.
2. If the project keeps reports (`get_report_settings`: cadence not `off`), write the current
   period's report as its prompt says, in the shape of its template, and `post_report` it (what
   was handed off, what is blocked, what waits on the human) once the human agrees.
3. Print the table to the user, then what waits on them, then `QUEUE`. Do not restate findings or
   diffs: the tickets and PRs carry them.

## Notes

- Delegation depth: you spawn ticket agents; a ticket agent spawns its spec and builder agents and
  runs `/feature-review`, whose phase agents (env, verify, hunt, refute, merge) are its own. Do not
  add a level, and never do a ticket agent's work yourself.
- Never two ticket agents on one ticket or one branch. Never move a ticket yourself except to leave
  a comment on an error; the ticket agents own their tickets' stages.
- The orchestrator never changes a ticket's complexity: it passes the level on, and the ticket agent
  never changes its own.
- Where posts go on a ticket: progress posts and anything posted `as` one of the project's agents
  (spec, builder, the review phases) land in its Agents tab, the agents' working record; Main is
  the human's and stays short and to the point: their posts, decision cards, questions to them,
  and the summary on top. The hand-off is the summary (`set_ticket_summary`), rewritten to the
  current state, never a new hand-off post. Your own writes follow the same rules: an error
  comment (Step 4) is a word to the human, so it goes to Main and stays one line; a relay of the
  human's chat answer (`answer_decision`, only in a session with the human) lands under its card.
  When the human posted on a ticket, the answer goes under their post, never as a new top-level
  post: a reply with the plan first, then a reply with the result and its proofs. The ticket agent
  does both; when you check a `handed-off` result, see that it did.
- Nothing here merges, approves, or comments on GitHub. Pushing the ticket's own branch and opening
  its PR (the project's way) are the ticket agent's only remote writes.
- If the user interrupts, tell them which tickets were in flight. Their worktrees are registered
  on the tickets (`get_ticket` → `workspaces`), and `git worktree list` in each repo shows what is
  left, review worktrees under `~/.claude/feature-review/` included. The test slot folders live in
  this run's `QUEUE` only: a new run starts with none.
