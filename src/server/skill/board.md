---
name: board
description: Work through the agent board ({{BOARD_URL}}, MCP server "board") - find this repo's project, pick up a ticket, break it into tasks, split parallel work into lanes, post progress with screenshots, answer threads, hand off for review, clean up finished branches and worktrees, post the daily summary. Use when the user says "pick up a ticket", "next ticket", "what's on the board", "report to the board", "post an update", "hand this off", "move it to review", "daily summary", "board cleanup", "clean up branches" or "clean up worktrees", mentions a board ticket number, or when starting or finishing work in a repo that has a board project.
---

# Working through the agent board

The board is where the human and every agent coordinate. Its tools come from the `board` MCP
server. If they are missing, say so and stop: the human connects it with a gate token from the
board's Connect agents page ({{BOARD_URL}}/agents). {{MCP_HINT}} Git and GitHub stay read-only
through the board: never push, merge, approve or comment on GitHub on its behalf.

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

## 2. Pick up work

- First, `list_my_threads` with your `projectId`: threads where the human (or another agent)
  spoke after you. Answer those before starting anything new.
- `list_tickets` with `status: ["todo"]` and `assignee: ""` (unassigned), or `assignee: <you>`, for
  candidates; `q` finds text in titles and instructions. If the human named a ticket, use that one.
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
- No tasks yet → `add_tasks` with the concrete steps. The human's progress bar is these tasks.

Creating a top-level ticket (only when the human asks): `create_ticket` with your `projectId` and
`repoId`. Lanes of a ticket you are working are yours to create (next section).

## 3. While working

- `set_task_done` as each step finishes. When the plan changes, `update_task` rewords a step and
  `remove_task` drops one that no longer applies, so the progress bar stays honest.
- Parallel work goes in lanes. When parts of the ticket run at once (subagents, worktrees, another
  agent), `create_ticket` for each part with `parentId` = the ticket, a short title, the part's
  brief as `body`, its own `branch`, `assignee` and `tasks`. Its repo and base branch default to
  the parent's repo and branch, so the lane's PR goes into the parent's branch, not `main`. Hand
  each subagent its lane's `ticketId`: it works the lane like any ticket (tasks, updates, thread,
  review) and may split it into lanes of its own. One-step helpers that finish inside your own
  turn need no lane.
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
- `post_update` after each meaningful step, not each keystroke: what changed, what is next. It
  is a post marked as progress; `edit_post` / `delete_post` change what you posted.
  Attach evidence with `files` as absolute paths (screenshots, recordings, logs); Windows paths are
  fine, the board reads them through `/mnt/c/…`.
- **Previews:** when the change can be tried (a page, an API), start your branch from your
  worktree on a free port, with a copy of the data rather than the real one (the project's
  `instructions` say how), and `post_update` the link (`http://localhost:<port>`) with what to
  try. Register it on that worktree's workspace too: `set_preview` with the `workspaceId` and
  `previewUrl` once the server answers (or `previewUrl` on `add_workspace` when it already runs).
  The ticket page then shows a Preview card with an Open button and whether it is running. Say
  that what the human posts there stays in the copy. Keep it running while the ticket is in
  `review`; stop it once it is merged or dropped, and clear it with `set_preview` and
  `previewUrl: ""` (`remove_workspace` drops it too). Never run it from the checkout or port the
  human uses day to day.
- Questions are posts too: `comment` on the ticket; the human answers with a post or a reply
  under yours (`comment` on the post, `parentType: update`, replies there). A choice between clear
  options (an approach, a trade-off, a scope call) is an `ask_decision` instead: the question with
  the context, 2 to 5 options (a label, what it means, at most one `recommended`). The ticket
  blocks until the human picks one; the answer comes as a reply under the card. If you cannot go on
  without the answer, also `update_ticket` → `status: blocked`, and back to `in_progress` once it
  is answered. On resuming, and between steps, `list_my_threads` shows what is waiting on you.
- Files the human attaches (screenshots on a post or reply) come with `path` (and
  `windowsPath` when the board runs in WSL): open that file directly. `get_attachment` looks one
  up by id.

## 4. Hand off

1. Open the PR assigned to the human: `gh pr create --assignee <their login>`, or `--assignee @me`
   when you push with their account. GitHub never lets a PR's author be its requested reviewer;
   the PR queue also lists PRs assigned to the human, so this is how it gets there.
2. `update_ticket` with the PR's `prNumber`: the PR queue then shows the ticket, and `get_ticket`
   shows the PR with its latest review. (A PR on the ticket's branch links by itself.)
3. Final `post_update` with the PR link, how to test, and the preview link if there is one.
4. `update_ticket` → `status: review`. `done` is the human's call unless the project instructions
   say otherwise.
5. A ticket with lanes goes to `review` once its lanes are in `review`, `done` or `cancelled`; the
   board flags a ticket that is further along than its lanes. Say in the final update which lanes
   it covers.
6. Dropping work: `status: cancelled`, with a comment saying why. Cancelled lanes' tasks leave the
   parent's progress.
7. Clean up your lane before it goes to `done` (or when the human moves it there): see
   [Clean up](#6-clean-up) for the rule. A ticket in `review` keeps its branch and worktree.

## 5. End of session

`post_daily_summary` with your `projectId`: at most three short lines, highest level: what got
done, what is open. `daily_report` with your `projectId` shows what else happened in the project
today.

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
  `git branch lane/47 9ec12e8b` restores it.
- Branches on origin: never delete them (git and GitHub stay read-only for you). List the ones
  left for closed tickets in the update, so the human deletes them.

### `/board cleanup`

When the human asks to clean up (`/board cleanup`, "clean up branches", "clean up worktrees"):

1. `git fetch --prune` in each repo of the project, so origin's branches are current.
2. `cleanup_report` with your `projectId`: every ticket in a done or cancelled stage that still
   has workspaces, local or origin branches, or worktrees, each branch with its sha, worktrees,
   `reach` and `restore` command, plus `untracked` worktrees no ticket accounts for.
3. For each `unique` branch, check it yourself before calling it: `git cherry -v <base> <branch>`
   and `git range-diff` or `git diff <base>...<branch>` show whether the listed commits' changes
   landed in another shape (split, squashed with others, moved to another branch). If they did,
   call it `edited` and say where.
4. Show the human one table, grouped as **safe to delete** (merged, rebased), **edited but
   present** and **still has unique work**, with columns: ticket, branch, sha, reach and base,
   worktree path, on origin. Below it, the `untracked` worktrees and the origin branches left for
   the human to delete (`git push origin --delete …` is theirs to run).
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
**env**, **verify**, **hunt**, **refute** and **merge** try to break it) → back to **builder** with
the confirmed findings, at most three rounds → hand off. `/review-queue` is that orchestrator: it
reviews the board's PR queue, and with `build` it also works the To do tickets through the cycle.
Without those skills, or for one ticket, orchestrate by hand:

1. `get_project`: read every agent's `delegation` (your routing table) and `instructions` (its
   brief). Claim the ticket (with `as` when it is reserved), open its worktree, `add_workspace`.
2. Per step: pick the agent whose notes match where the ticket is; run it as a subagent whose
   prompt is its `instructions`, the project's `instructions`, the ticket (`get_ticket`), the
   worktree and branch, and what the previous step returned (subagents share nothing else); post
   what it returns on the ticket **as that agent** (`post_update` with `as`, `progress: true`, its
   evidence in `files`); tick the tasks it finished; go where its notes say next.
3. A call that is the human's (two valid behaviours, a finding that keeps coming back, ship as is
   or not) → `ask_decision`, and work on something else until it is decided.
4. Hand off as in [Hand off](#4-hand-off), with the last review's summary as the PR's tests.

Never two builders on one branch; when no agent's notes fit a step, ask in a post rather than
doing it yourself.

## Reviews and the PR queue

`list_prs` is the human's review queue; each PR lists the `tickets` it came from, whether it
waits on the human (`waitingOn`), and its `merge` and `ci` state: conflicts or failed `checks` on
a PR from your ticket are yours to fix. Before reviewing a PR, `list_review_results` with its
`prNumber` and head `sha`: if that SHA was already
reviewed, `get_review_result` has the findings. If you review a PR, record it with
`post_review_result` (verdict, markdown summary with findings, how to test, checks, `repoId` when
the project has several repos): the human reads it from its verdict on the PR queue and on the
ticket's Branch card. Never post the review to GitHub.

`list_actors` gives every name that signs in to the board (the project's agents are in
`get_project`); use those exact names for `assignee`.

## Style

Plain words, short. Titles under 80 characters. Screenshots beat paragraphs.
