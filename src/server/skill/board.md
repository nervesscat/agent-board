---
name: board
description: Work through the agent board ({{BOARD_URL}}, MCP server "board") - find this repo's project, pick up a ticket, break it into tasks, split parallel work into lanes, post progress with screenshots, answer threads, hand off for review, post the daily summary. Use when the user says "pick up a ticket", "next ticket", "what's on the board", "report to the board", "post an update", "hand this off", "move it to review", "daily summary", mentions a board ticket number, or when starting or finishing work in a repo that has a board project.
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
   `cancelled` mean exactly that.

## 2. Pick up work

- First, `list_my_threads` with your `projectId`: threads where the human (or another agent)
  spoke after you. Answer those before starting anything new.
- `list_tickets` with `status: ["todo"]` and `assignee: ""` (unassigned), or `assignee: <you>`, for
  candidates; `q` finds text in titles and instructions. If the human named a ticket, use that one.
  The list includes lanes (`parentId` set); `parentId: null` narrows it to top-level tickets,
  `parentId: <id>` to one ticket's lanes.
- `get_ticket` and read it in full. `thread` on the ticket and on each update says how many
  comments it has and who spoke last: `list_comments` on any with comments. On a lane,
  `ancestors` names the tickets above it: `get_ticket` the parent too for the bigger picture, but
  the lane's own instructions are your brief.
- `claim_ticket` with the `branch` you will use: it assigns you and moves it to `in_progress`. It
  fails when someone else holds the ticket: pick another one, do not take it over.
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
  on the ticket or lane whose code it holds; `remove_workspace` when it is gone. The parent's git
  panel lists its lanes' workspaces too, tagged with the lane.
- Keeping track of lanes: `get_ticket` on the parent lists them with status, branch, progress and
  their last update; `laneUpdates: true` folds their updates into the feed; `get_ticket_git` shows
  every workspace under the ticket.
- The human's verdict: `approvedAt` / `approvedBy` (approved) or `disapprovedAt` /
  `disapprovedBy` (disapproved, which also moves it to `cancelled`) on a lane or ticket; both null
  means no call yet, and `lanes.approved` / `lanes.disapproved` count them. Read it, never set it:
  an approved lane is settled and a disapproved one is dropped, so ask in its thread before
  touching either.
- `post_update` after each meaningful step, not each keystroke: what changed, what is next.
  Attach evidence with `files` as absolute paths (screenshots, recordings, logs); Windows paths are
  fine, the board reads them through `/mnt/c/…`.
- Questions go in the ticket thread with `comment`; the human answers there. If you cannot go on
  without the answer, also `update_ticket` → `status: blocked`, and back to `in_progress` once it
  is answered. On resuming, and between steps, `list_my_threads` shows what is waiting on you.
- Files the human attaches (screenshots in a thread or update) come with `path` (and
  `windowsPath` when the board runs in WSL): open that file directly. `get_attachment` looks one
  up by id.

## 4. Hand off

1. `update_ticket` with the PR's `prNumber`: the PR queue then shows the ticket, and `get_ticket`
   shows the PR with its latest review. (A PR on the ticket's branch links by itself.)
2. Final `post_update` with the PR link and how to test.
3. `update_ticket` → `status: review`. `done` is the human's call unless the project instructions
   say otherwise.
4. A ticket with lanes goes to `review` once its lanes are in `review`, `done` or `cancelled`; the
   board flags a ticket that is further along than its lanes. Say in the final update which lanes
   it covers.
5. Dropping work: `status: cancelled`, with a comment saying why. Cancelled lanes' tasks leave the
   parent's progress.

## 5. End of session

`post_daily_summary` with your `projectId`: at most three short lines, highest level: what got
done, what is open. `daily_report` with your `projectId` shows what else happened in the project
today.

## Reviews and the PR queue

`list_prs` is the human's review queue; each PR lists the `tickets` it came from. Before
reviewing a PR, `list_review_results` with its `prNumber` and head `sha`: if that SHA was already
reviewed, `get_review_result` has the findings. If you review a PR, record it with
`post_review_result` (verdict, markdown summary with findings, how to test, checks, `repoId` when
the project has several repos). Never post the review to GitHub.

`list_actors` gives every name the board knows; use those exact names for `assignee`.

## Style

Plain words, short. Titles under 80 characters. Screenshots beat paragraphs.
