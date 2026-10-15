---
name: board
description: Work through the agent board ({{BOARD_URL}}, MCP server "board") - find this repo's project, pick up a ticket, break it into tasks, split parallel work into lanes, post progress with screenshots, answer threads, hand off for review, clean up finished branches and worktrees, leave resume notes, and write the project's report. Use when the user says "pick up a ticket", "next ticket", "where did we leave off", "what's on the board", "report to the board", "post an update", "hand this off", "move it to review", "daily summary", "daily report", "weekly report", "board cleanup", "clean up branches" or "clean up worktrees", mentions a board ticket number, or when starting or finishing work in a repo that has a board project.
---

# Working through the agent board

The board is where the human and every agent coordinate. Its tools come from the `board` MCP
server. If they are missing, say so and stop: the human connects it with a gate token from the
board's Connect agents page ({{BOARD_URL}}/agents). {{MCP_HINT}} Git and GitHub stay read-only
through the board for you (only the human deletes finished branches, from its Cleanup page): never
push, merge, approve or comment on GitHub on its behalf.

## Keep the board out of the repo

The board, trazic, habits and any other personal tracking tool are private to the human. Nothing
you write into the repo or onto GitHub may mention them:

- no code comments, docs, READMEs, changelogs or config that name the board, trazic or habits,
  their tools (`post_update`, `list_tickets`, …), their URLs (`localhost:47100`, `47110`), or a
  board ticket, task, update or project (`#12`, "ticket 12", "per the board");
- no commit messages, branch names, PR titles or PR descriptions that do either;
- no links or screenshots of the board in PRs or issues.

Write those as if the board did not exist: describe the change and its reason in the repo's own
terms. If the ticket's text has something the PR needs (the why, how to test), restate it in your
own words instead of pointing at the ticket. Board updates and comments may, of course, talk about
the repo, branches and PRs freely; the rule only runs the other way.

## 1. Your project: look it up here, nowhere else

Work only in the project of the repo you are in. Do not call `list_projects`, and never read or
write another project's tickets, PRs, reviews or daily log.

Find the repo you are in (the folder name of `git rev-parse --show-toplevel`, or the working
folder, and its GitHub slug from `git remote get-url origin`), then take its project from this
table. The same repo may be checked out on Windows and in WSL, under another path: match the folder
name or the GitHub slug, and both map to the same ids.

{{PROJECT_TABLE}}

- A folder holding several repos of one project: that is the project; ask which repo (or take it
  from the ticket) before passing a `repoId`.
- A worktree of one of these repos (e.g. `.wt-pr14`) belongs to that repo.
- Not in the table: say the repo has no board project and stop using the board for it. Do not
  guess from other projects and do not create one.

Then:

1. `whoami`: your name on the board (the gate token's name). Use it as the assignee.
2. `get_project` with your `projectId`, and check its `name` matches the table (if not, the table
   is stale: tell the human to copy the skill again from the board). Its `instructions` override
   your defaults for every repo in it. Its `stages` are the board's columns, each with a `key`, a
   `name` and a `kind` (`open`, `active`, `blocked`, `review`, `done`, `cancelled`); a ticket's
   `status` is a stage key. Wherever a status is asked for you can also pass a kind, which means
   the project's stage of that kind: below, `todo`, `in_progress`, `blocked`, `review`, `done` and
   `cancelled` mean exactly that. Its `agents` are the project's own agents (see
   [The project's agents](#the-projects-agents)).
3. `get_summary` with your `projectId`: where the project stands in one read (what waits on the
   human, in progress and since when, done today, next, and what carries over from before today).

## 2. Pick up work

- First, `list_my_threads` with your `projectId`: threads where the human (or another agent)
  spoke after you. Answer those before starting anything new, and keep its `cursor` for
  [Watch for feedback](#watch-for-feedback).
- `list_tickets` with `status: ["todo"]` and `assignee: ""` (unassigned), or `assignee: <you>`, for
  candidates; `q` finds the `#id` or title first, then text in the instructions and the thread (posts, replies). If the human named a ticket, use that one.
  The list includes lanes (`parentId` set); `parentId: null` narrows it to top-level tickets,
  `parentId: <id>` to one ticket's lanes.
- `get_ticket` and read it in full. Its `updates` are the ticket's feed of posts (`progress`
  marks steps of the work; the rest is discussion), each with `thread`: how many replies and who
  spoke last. `list_comments` (`parentType: update`, the post's id) reads a post's replies. On a lane,
  `ancestors` names the tickets above it: `get_ticket` the parent too for the bigger picture, but
  the lane's own instructions are your brief.
- `claim_ticket` with the `branch` you will use: it assigns you and moves it to `in_progress`.
  Tickets are shared: claiming one another agent holds takes it over (the board logs it), so prefer
  unassigned ones and take over only what is stalled or handed to you. A ticket with
  `reserved: true` belongs to one of the project's agents: claim it only with `as`, below.
- **Start of a session: read the resume note first.** For every ticket you pick up or come back
  to, before anything else, read its `resume` (on `get_ticket`, and returned by `claim_ticket`):
  `note` is where the last session left off (state, what is done, next steps, open questions, how
  to resume), with `by` and `at`. `commitsSince` counts commits on the branch since it was written
  and `stale` says the work moved on (new commits or a newer progress post): check the branch and
  the latest posts too. `noHandoff` means it carried over from an earlier day without a note.
- A new ticket starts with its project's default phases as its top-level tasks (`get_project` →
  `defaultPhases`; built in: Implementation, then the hand-off's Pushed, PR, CI, Preview, Hand-off
  post). Tasks go two levels and no more: put the concrete steps of the work under Implementation
  as its subtasks (`add_tasks` with `parentTaskId` = its id; a subtask takes no subtasks). Remove
  or reword a phase that does not fit (`remove_task`, `update_task`); `add_tasks` adds one at the
  end. A lane starts without phases, since its parent carries the hand-off (`defaultPhases: true`
  on `create_ticket` seeds it anyway), and `defaultPhases: false` opts a ticket out.
- No tasks yet (an older ticket, a lane, one opted out) → the phases the same way: `add_tasks` with
  the names from `defaultPhases`, then the steps under the first. The human's progress bar is these
  tasks and subtasks, all counted, and together they are the hand-off's Implementation item.

Creating a top-level ticket (only when the human asks): `create_ticket` with your `projectId` and
`repoId` and, when the human says how much review it gets, `complexity` (`low`, `mid` or `high`;
`mid` when left out); it starts with the default phases, the `tasks` you give as plain texts under
the first.
Lanes of a ticket you are working are yours to create (next section).

## 3. While working

- `set_task_done` as each step finishes, and each hand-off phase as you finish it (Pushed after
  the push, PR once it is open, CI once it is green, Preview once it runs, Hand-off post once it is
  posted); the board ticks none itself. On a rework, untick the phases the new work redoes and tick
  them again as you redo each. A phase with steps is done exactly when all its steps are: ticking
  or unticking a phase does the same to its steps, ticking its last open step ticks it, unticking a
  step unticks it. When the plan changes, `update_task` rewords a task and `remove_task` drops one
  that no longer applies (a phase goes with its steps), so the progress bar stays honest.
- A step that needs the human (a credential, a manual action, a call only they can make): tag
  that task or subtask blocked, `update_task` with `blocked: true` and `blockedReason` saying what
  they must do (or `{text, blocked, blockedReason}` items on `add_tasks`), and keep working on the
  rest. It shows on the task, on the ticket's card (`blockedTasks`) and in the human's Needs you
  (`get_summary` → `needsYou.blockedTasks`). It still counts as open and does not move the ticket.
  Ticking the task done clears the tag; `blocked: false` clears it once resolved. Move the whole
  ticket to `blocked` (or `ask_decision`) only when nothing else can go on.
- Parallel work goes in lanes. When parts of the ticket run at once (subagents, worktrees, another
  agent), `create_ticket` for each part with `parentId` = the ticket, a short title, the part's
  brief as `body` ([Delegating](#delegating)), its own `branch`, `assignee` and `tasks`. Its repo
  and base branch default to the parent's repo and branch, so the lane's PR goes into the parent's
  branch, not `main`. Hand each subagent its lane's `ticketId`: it works the lane like any ticket
  (tasks, updates, thread, review) and may split it into lanes of its own. One-step helpers that
  finish inside your own turn need no lane. Split lanes by files: each file has one owning lane,
  and two lanes never edit the same file (a file both need goes to one of them, or the other waits
  on it with `needs`).
- Tag every lane with `tags` so the human can filter the list: a severity (`Critical`, `High`,
  `Medium`, `Low`, `Cosmetic`), an area or a kind, one or two words in Title Case. Reuse the words
  sibling lanes already carry, and keep them out of the title (no `[High] …`). `update_ticket`
  with `tags` replaces the list; `list_tickets` takes `tag` to filter.
- `add_workspace` for every worktree, sub-branch or sandbox where code runs (name, branch, path),
  on the ticket or lane whose code it holds, as soon as you open it; `remove_workspace` when it is
  gone. No exceptions for short-lived worktrees: the registered workspaces are the cleanup list, and
  a worktree the board does not know about shows up as `untracked` in `cleanup_report`. The
  parent's git panel lists its lanes' workspaces too, tagged with the lane.
- Keeping track of lanes: `get_ticket` on the parent lists them with status, branch, progress and
  their last update; `laneUpdates: true` folds their updates into the feed; `get_ticket_git` shows
  every workspace under the ticket.
- The human's verdict: `approvedAt` / `approvedBy` (approved) or `disapprovedAt` /
  `disapprovedBy` (disapproved, which also moves it to `cancelled`) on a lane or ticket; both null
  means no call yet, and `lanes.approved` / `lanes.disapproved` count them. Read it, never set it:
  an approved lane is settled and a disapproved one is dropped, so ask in its thread before
  touching either.
- The archive: the human takes finished tickets (done or cancelled) off the board, their lanes with
  them; `archivedAt` / `archivedBy` show it. `list_tickets` leaves them out unless `archived` is
  `"include"` (with the rest) or `"only"`; `get_ticket` still opens them. Only the human archives
  and restores.
- `post_update` after each meaningful step, not each keystroke: what changed, what is next. It
  is a post marked as progress; `edit_post` / `delete_post` change what you posted.
  Attach evidence with `files` as absolute paths (screenshots, recordings, logs); Windows paths are
  fine, the board reads them through `/mnt/c/…`.
- **Previews:** when the change can be tried (a page, an API), give the human a preview and
  `post_update` its link with what to try; say that what they post there stays in the copy. Keep
  it running while the ticket is in `review`.
  - A branch of the board itself: the board runs it. `add_workspace` with your worktree's `path`
    and `branch` (a worktree next to the main checkout, `../agent-board-<branch>`), then
    `start_preview` with the `workspaceId`. It returns at once; `get_ticket` shows the workspace's
    `managedPreview` (`building`, `starting`, `running` with its `url`, or `failed` with the last
    log lines and the log paths). Do not run `pnpm dev` in your session for it: that dies with
    your session. `start_preview` with `restart: true` rebuilds after more commits;
    `stop_preview` stops it, and the board stops it by itself once the PR is merged or the
    ticket is done, cancelled, archived or its workspace removed. The human's preview limit (8 by
    default) caps how many the board runs at once; a start beyond it is refused with the limit.
  - Anything else: start your branch from your worktree on a free port, with a copy of the data
    rather than the real one (the project's `instructions` say how), then `set_preview` with the
    `workspaceId` and `previewUrl` once it answers (or `previewUrl` on `add_workspace` when it
    already runs). The ticket page then shows a Preview card with an Open button and whether it
    is running. Stop it once it is merged or dropped, and clear it with `set_preview` and
    `previewUrl: ""` (`remove_workspace` drops it too). Never run it from the checkout or port
    the human uses day to day. The human may stop it from the Previews page when it listens on
    loopback and runs from the workspace's worktree; its link stays, as not running.
- Questions are posts too: `comment` on the ticket; the human answers with a post or a reply
  under yours (`comment` on the post, `parentType: update`, replies there). A choice between clear
  options (an approach, a trade-off, a scope call) is an `ask_decision` instead: the question with
  the context, 2 to 5 options (a label, what it means, at most one `recommended`). The ticket
  blocks until the human picks one; the answer comes as a reply under the card. If you cannot go on
  without the answer, also `update_ticket` → `status: blocked`, and back to `in_progress` once it
  is answered. When only one step waits on the human, tag that task blocked instead and go on. On resuming, and between steps, `list_my_threads` shows what is waiting on you.
- Files the human attaches (screenshots on a post or reply) come with `path` (and
  `windowsPath` when the board runs in WSL): open that file directly. `get_attachment` looks one
  up by id.

### Delegating

Every spawned agent and lane costs time: hand out only what is new, and only what is worth it.

- Before starting or delegating anything, check what is already done or in flight: the ticket's
  lanes with their status, and its posts (`get_ticket`), its workspaces (`get_ticket_git`), and
  `list_review_results` for the branch's head SHA. Do not start or hand out what is already there.
- A lookup of one or two calls (a grep, a file read, one board call) you do yourself; do not spawn
  an agent for it.
- Every brief you hand another agent (a subagent's prompt, a lane's `create_ticket` `body`, a
  project agent's run under [Orchestrating](#orchestrating-the-projects-agents)) has five parts:
  1. Goal: what to achieve.
  2. Focus: the files or dirs to read first, and what to leave alone.
  3. Known: facts already established that it must not re-derive: commands, ports, paths,
     earlier results.
  4. Done when: the condition to stop at.
  5. Return: the exact shape of the answer.

### Watch for feedback

The human should not have to tell you to check comments. While this session has tickets of yours
(or of an agent you answer as) in `in_progress` or `review`, check the inbox every few minutes:

- `check_inbox` with your `projectId` and `since` = the `cursor` from your last call (none the
  first time). It is cheap: `count`, a new `cursor` and, per thread, where it is (`ticketId`,
  `title`, `parentType`, `parentId`), `as`, `lastAuthor` and `lastAt`, no bodies. Nothing new is
  `count: 0`. Keep the new `cursor`, even when you skip a thread; the board stores none for you.
- In Claude Code, run it under `/loop`, e.g.
  `/loop 5m check the board inbox and handle new comments`. Elsewhere, check between steps.
- For each new thread: read it (`list_comments` with its `parentType` and `parentId`), fix what it
  asks in that ticket's worktree the usual way (the checks, commit, push, refresh the preview),
  then reply in the same thread (`comment`, `as` when it is set) with what changed and the commit.
  A question gets an answer; a request you cannot do goes back to the human as a question.
- Stop watching once none of your tickets is in `in_progress` or `review`.

## 4. Hand off

Before `update_ticket` → `status: review`, every item, in order, ticking each hand-off phase of
the ticket as its item is done:

1. Worktree registered (`add_workspace`), Implementation and its steps ticked.
2. Checks green: typecheck, lint, unit tests, and the end-to-end suite when the repo has one (the
   project instructions say how, e.g. `pnpm test:e2e`).
3. Branch pushed: `get_ticket` → `push.state` is `pushed` (a green dot on the board). `ahead`
   (commits only here) or `local-only` (not on origin) is red: push, then check again. (`merged`:
   gone from origin because its PR was merged into the base.)
4. `needs` declared for any unmerged branch it builds on. If your branch is built on another
   ticket's open branch (stacked), or you merged one in to get past a conflict, declare it with
   `update_ticket` → `needs: [<its ticket id>]` (or `needs` on `create_ticket`) instead of only
   writing "builds on …" in the PR. `get_ticket_git` → `includes` lists the open tickets whose
   unmerged work your branch holds: each one belongs in `needs`. The PR queue then marks your PR
   "merge after #<its PR>", and the ticket cannot go to `done` until those branches are merged into
   its base: `update_ticket` to `done` is refused with which one (`get_ticket` → `needs[].merged`).
   Only the human can mark it done anyway.
5. PR open, assigned to the human, `prNumber` set: `gh pr create --assignee <their login>`, or
   `--assignee @me` when you push with their account (GitHub never lets a PR's author be its
   requested reviewer; the PR queue lists the human's own PRs under Waiting on others). Then
   `update_ticket` with the PR's `prNumber`: the PR queue shows the ticket, and `get_ticket` the PR
   with its latest review. (A PR on the ticket's branch links by itself.)
6. **Preview running**: `start_preview` on the workspace, then `get_ticket` until its
   `managedPreview` is `running` (`failed`: read the log lines and fix). For a repo the board cannot
   build, start one the project's way and `set_preview` (see Previews in
   [While working](#3-while-working)). Required whenever the change can be tried; when it cannot
   (docs only, a script), say why in the hand-off post.
7. Hand-off post (`post_update`): the PR link, **the preview link and what to try there**, how it
   was tested, the e2e result (its summary, or its report when something failed) and, for a UI
   change, screenshots of what changed, in `files`. Then tick Hand-off post: a tick is not a
   commit, so the post still counts.
8. Resume note if the ticket stays open past the session (`set_resume_note`, see
   [End of session](#5-end-of-session)).

`update_ticket` → `review` then answers with `handoff.missing`: what the board still sees missing,
each a `code` with a `text`: `tasks_open` (Implementation, the ticket's tasks and subtasks, its
phases and their steps, the hand-off phases included: missing while it has none, or while some of
them, its lanes' included, are open; the other checks still verify each fact themselves), `no_pr`, `not_pushed`, `no_preview`,
`no_handoff_post` (no progress post of yours since the branch's last commit), `checks_unknown` (the
PR's CI is failing or still running). The move goes through anyway: fix each one. `get_ticket` returns the same `handoff` while
the ticket is in review, and its page shows it as a Hand-off card.

After that:

1. `done` is the human's call unless the project instructions say otherwise.
2. A ticket with lanes goes to `review` once its lanes are in `review`, `done` or `cancelled`; the
   board flags a ticket that is further along than its lanes. Say in the hand-off post which lanes
   it covers.
3. Dropping work: `status: cancelled`, with a comment saying why. Cancelled lanes' tasks leave the
   parent's progress.
4. Clean up your lane before it goes to `done` (or when the human moves it there): see
   [Clean up](#6-clean-up) for the rule. A ticket in `review` keeps its branch and worktree.

## 5. End of session

1. **Resume notes.** For every ticket and lane you leave in `in_progress`, `blocked` or `review`,
   `set_resume_note` with this template filled in (`as` when you work it as one of the project's
   agents), concretely enough that another agent can continue without asking:

   ```markdown
   **State:** (one line)

   **Done so far:**

   - …

   **Next steps:**

   1. …

   **Open questions / blockers:**

   - …

   **How to resume:** branch, worktree, commands, preview, gotchas
   ```

   It replaces the ticket's previous note and is posted to its feed as a handoff, so the older ones
   stay readable. The ticket page shows it at the top as "Resume here"; a ticket that carries over
   to the next day without one shows "no handoff".

2. `daily_report` with your `projectId` shows what else happened in the project today.

Then the project's report, if it keeps one: one report per period, due at the end of the project's
shift.

1. `get_report_settings`: `cadence` `off` means no reports; stop here. Otherwise it is `daily` (on
   the `workdays`, ISO 1 Monday to 7 Sunday) or `weekly` (due on `weekday`), at `shiftEnd` (local), as
   `format` `text` or `file`. `prompt` says what the report must say and how (who reads it, tone,
   what to stress, a short text or a PDF); `template` is its shape: a markdown skeleton whose
   headings, in order, are the report's sections.
2. `list_reports`: each recent period with `status` `done`, `missing` (due, nothing posted),
   `upcoming` (not due yet) or `off` (not asked for), newest first, and `current`, the period you
   are in. `reportDue` on `get_summary` and `check_inbox` says when the human expects it (`due` soon,
   or `missing` after the shift's end): offer to write it then.
3. For the current period, and any `missing` one the activity lets you write, with the human's
   go-ahead: write the report as the prompt says, filling the template's headings in order
   (`daily_report` for the days it covers), and `post_report` with `period` (any day of it), `body`,
   and `files` as absolute paths. The board does not make PDFs: when the prompt or `format: file`
   asks for one, make it yourself and attach it. Posting again for a period adds a newer version;
   the old one stays as history.

`set_report_settings` changes the schedule (cadence, weekday, shift, workdays, alert minutes,
format), and the prompt or the template only when the human asked for that change in this
conversation: each such change is kept with the previous version, shows in the project's activity
and stays flagged for the human until they accept or revert it. `post_daily_summary` is an old name
for `post_report` on the current period: use `post_report`.

## 6. Clean up

Finished work leaves worktrees and branches behind. The rule, for every ticket and lane you
worked:

- A **lane** can go once its work is on its parent's branch (a lane's base branch is the parent's
  branch). A **ticket** can go once its branch is in its base (dev, main).
- `get_ticket_git` answers that per branch with `reach`, against the base chain (the lane's
  parent branch, then the parent's base, then the repo's base):
  - `merged`: every commit is there as is. Safe to delete (`git branch -d`).
  - `rebased`: the commits were rebased or cherry-picked, same patches. Safe (`git branch -D`).
  - `edited`: patches differ (squashed, reworded, edited on the way in) but merging the branch
    would change nothing. Safe (`git branch -D`); say so in the update.
  - `unique`: the branch still has work its bases lack; the commits are listed. Do not delete it
    without the human's go-ahead.
- Deleting: `git worktree remove <path>`, then `git branch -d|-D <name>`, then `remove_workspace`
  for each workspace, then **one** `post_update` on the ticket listing every deleted branch with
  its commit hash, as `branch @ sha` (e.g. `lane/47 @ 9ec12e8b`). That line is the only way back:
  `git branch lane/47 9ec12e8b` restores it. Before `git worktree remove`, remove each link in the
  worktree to a folder out of it (a `node_modules` or `data` linked to another checkout's), the link
  alone: on Windows git deletes what a junction leads to.
- Branches on origin: never delete them (git and GitHub stay read-only for you). List the ones
  left for closed tickets in the update, so the human deletes them from the board's Cleanup page.
- A branch `cleanup_report` marks `protected` (a base, the main checkout's branch, origin's default
  branch, in use by a ticket in work or an open PR) stays, whatever its reach.

### `/board cleanup`

When the human asks to clean up (`/board cleanup`, "clean up branches", "clean up worktrees"):

1. `git fetch --prune` in each repo of the project, so origin's branches are current.
2. `cleanup_report` with your `projectId`: every ticket in a done or cancelled stage (or archived)
   that still has workspaces, local or origin branches, or worktrees, each branch with its sha, worktrees,
   `reach` (origin's own as `remoteReach`), `protected` and `restore` command, plus `untracked`
   worktrees no ticket accounts for, and `previews` the board still runs for it (`stop_preview` each
   one).
3. For each `unique` branch, check it yourself before calling it: `git cherry -v <base> <branch>`
   and `git range-diff` or `git diff <base>...<branch>` show whether the listed commits' changes
   landed in another shape (split, squashed with others, moved to another branch). If they did,
   call it `edited` and say where.
4. Show the human one table, grouped as **safe to delete** (merged, rebased), **edited but
   present** and **still has unique work**, with columns: ticket, branch, sha, reach and base,
   worktree path, on origin; `protected` branches go in a **kept** group with the reason. Below
   it, the `untracked` worktrees and the origin branches left for the human, who deletes those from
   the board's Cleanup page.
5. Wait for the human's approval (all, a group, or named rows). Then, per ticket: remove the
   worktrees, delete the branches, `remove_workspace` each registered workspace, and `post_update`
   on the ticket with the deleted `branch @ sha` lines. Finish with a short summary: what was
   removed, what is left and why.

Nothing here touches a ticket in any other stage, even when its branch looks merged.

## The project's agents

`get_project` → `agents`: personas the human defined for this project, each with a `name`,
`instructions` and a picture. They are not connected tools; you work for them.

- A ticket assigned to one is reserved for it (`reserved: true`; `get_ticket` → `agent` has its
  instructions). `claim_ticket` with `as: <its name>`, brief a subagent with the agent's
  instructions plus the ticket's, and post its work with `post_update` and `comment` using
  `as: <its name>`: it shows under the agent's name, via you.
- Never take a reserved ticket as yourself, reassign it, or work it without the agent's
  instructions. Only the human reassigns it.
- `list_my_threads` also returns threads waiting on an agent (someone @mentioned it, or replied
  on its ticket or post), with `as` set: answer with `comment` `as: <its name>`, in its voice.

## Orchestrating the project's agents

Each agent also has **delegation notes** (`agents[].delegation`): when to call it, what to give
it, what it returns and what comes next. They are written for an orchestrator: a connected agent
that does not do the work itself but routes each step to the agent whose notes fit, as a
subagent, and keeps the ticket's feed as the record. An agent without delegation notes is never
delegated to.

The project's Agents page adds a default set, the build and review cycle of the
`/feature-review` and `/review-queue` skills (installed from the same page): **spec** (acceptance
criteria) → **builder** (the code) → **runner** (a `/feature-review` of the branch, whose phases
**env**, **verify**, **hunt**, **refute** and **merge** try to break it) → (a fix pass by the
**builder** on the confirmed findings, each with the project's checks and a new review, for as many
review rounds as the ticket's complexity allows: none for low, one for mid, three for high; round 1 is
the first build and its review, so a mid ticket stops after its review, and a review that does not
survive after the last round goes to a human decision; a high ticket gets two fix passes; a low ticket
has no review, and its checks return the build at most twice) → hand off. `/todo-review` is that
orchestrator for
the To do tickets: one agent per ticket runs the cycle, checks the proof itself (criteria seen
working, no weakened tests, screenshots) and blocks only for what only the human can give.
`/review-queue` reviews the board's PR queue (with `build`, it runs `/todo-review` after).
Without those skills, or for one ticket, orchestrate by hand:

1. `get_project`: read every agent's `delegation` (your routing table) and `instructions` (its
   brief). Claim the ticket (with `as` when it is reserved), open its worktree, `add_workspace`.
2. Per step: pick the agent whose notes match where the ticket is; run it as a subagent whose
   prompt is its `instructions`, the project's `instructions` and a brief in the five parts of
   [Delegating](#delegating): the step's goal from the ticket (`get_ticket`), its focus, what is
   known (the worktree and branch, what earlier steps returned: subagents share nothing else),
   done when (with the checklist from [Hand off](#4-hand-off), as it stands) and what to return;
   post what it returns on the ticket **as that agent** (`post_update` with `as`, `progress: true`,
   its evidence in `files`); tick the tasks it finished; go where its notes say next.
3. A call that is the human's (two valid behaviours, a finding that keeps coming back, ship as is
   or not) → `ask_decision`, and work on something else until it is decided.
4. Hand off as in [Hand off](#4-hand-off), with the last review's summary as the PR's tests. Check
   every item of the checklist yourself before moving the ticket to `review` (`get_ticket`: `push`,
   `pr`, the workspace's `managedPreview` `running`, the hand-off post): a subagent saying it is
   done is not enough.

Never two builders on one branch; when no agent's notes fit a step, ask in a post rather than
doing it yourself.

## Reviews and the PR queue

`list_prs` is the human's PR queue: PRs by others that the human reviews (`waitingOn: me`) and the
human's own (`waitingOn: others`; agents' PRs pushed with their account are theirs on GitHub), open
or merged in the last two weeks. `status` is where the reviews stand: `pending` (approval missing),
`reviewed` (approved: by the human on others' PRs, by every reviewer on theirs), `on_hold` (review
comments or requested changes not yet addressed by a push or a new review request, or a board-side
hold) or `done` (merged). Each PR lists the `tickets` it came from and its `merge` and `ci` state:
conflicts or failed `checks` on a PR from your ticket are yours to fix. Before reviewing a PR,
`list_review_results` with its `prNumber` and head `sha`: if that SHA was already reviewed,
`get_review_result` has the findings. If you review a PR, record it with `post_review_result`
(verdict, markdown summary with findings, how to test, checks, `repoId` when the project has several
repos): the human reads it from its verdict on the PR queue and on the ticket's Branch card. Never post the review to GitHub.

`list_actors` gives every name that signs in to the board (the project's agents are in
`get_project`); use those exact names for `assignee`.

## Style

Plain words, short. Titles under 80 characters. Screenshots beat paragraphs.
