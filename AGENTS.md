# Working with the board (for AI agents)

The board at `http://localhost:47100` is where the human and every agent (claude, codex,
opencode, …) coordinate. You read your work from it and you report back to it. GitHub and git
are **read-only** from the board's side, and from yours when acting through it: never push,
merge, approve or comment on GitHub on the board's behalf.

## Identity and auth

You authenticate with a passkey-gate CLI token, minted by the human on the gate's Devices page
(`http://localhost:47110/devices`). The token's **name is your identity** on the board (`claude`,
`codex`, …): every ticket, update and comment you write is attributed to it.

- MCP (preferred): `http://localhost:47100/api/mcp`, streamable HTTP, header
  `Authorization: Bearer gate_…`
- REST: same header against `http://localhost:47100/api/*` (the routes are listed in `README.md`)

Connect once per client. The board's Agents page (`http://localhost:47100/agents`) has these
ready to copy for Claude Code, Codex and OpenCode, with your token filled in, plus a one-line
install of the board skill (generated with the current projects and repos; install it again after
adding one):

```
# Claude Code
claude mcp add --transport http board http://localhost:47100/api/mcp --header "Authorization: Bearer gate_…"

# Codex (~/.codex/config.toml)
[mcp_servers.board]
url = "http://localhost:47100/api/mcp"
http_headers = { Authorization = "Bearer gate_…" }

# OpenCode (opencode.json)
{ "mcp": { "board": { "type": "remote", "url": "http://localhost:47100/api/mcp",
                      "headers": { "Authorization": "Bearer gate_…" } } } }
```

## The rhythm

1. **Before touching a project**: `get_project` — its `instructions` are the rules for its repos
   (how to run them, conventions, what never to do). Follow them over any default of yours. A
   project can span several repos (`repos[]`: id, name, checkout path, base branch); when it does,
   give `repoId` to `create_ticket` and `post_review_result` so the board knows which one you mean.
   Its `stages[]` are the board's columns in order, each with a `key`, a `name` and a `kind`
   (`open`, `active`, `blocked`, `review`, `done`, `cancelled`). A ticket's `status` is a stage key;
   wherever a status is asked for you can also give a stage's name or a kind (`todo` and
   `in_progress` mean `open` and `active`). Below, `todo`, `in_progress`, `blocked`, `review`,
   `done` and `cancelled` mean the project's stage of that kind.
2. **Pick up work**: starting a session, `get_summary` with your `projectId` shows where the project
   stands in one read (waiting on the human, in progress, done today, next, carrying over). Take work
   from `list_tickets` (`status: ["todo"]` with `assignee: ""`, or assigned to
   you; `q` searches titles and instructions). Read it in full with `get_ticket`. Then
   `claim_ticket` with the `branch` you will work on: it assigns you and moves it to
   `in_progress`. Tickets are shared: claiming one another agent holds takes it over (the board
   logs it), so prefer unassigned ones. A ticket with `reserved: true` belongs to one of the
   project's agents (below): claim it only with `as`.
   **Start of a session:** before anything else on a ticket you pick up or come back to, read its
   resume note (`resume` on `get_ticket`, also returned by `claim_ticket`): where the last session
   left off, the next steps and how to resume. `resume.commitsSince` and `resume.stale` say whether
   the work moved on since it was written; `resume.noHandoff` means it carried over from an earlier
   day without one.
3. **Break it down**: `add_tasks` with the concrete steps if the ticket does not have them;
   `set_task_done` as you finish each one, `update_task` / `remove_task` when the plan changes.
   The tasks are the implementation, two levels deep and no more: top-level tasks are its steps
   (coding, testing, benchmarks, process…), subtasks are their parts (`add_tasks` with
   `{text, subtasks}` items, or with `parentTaskId` to add under an existing step; a subtask takes
   no subtasks). A step with parts is done exactly when all its parts are: ticking or unticking it
   does the same to its parts, and the parts' ticks settle it. Removing a step removes its parts.
   The progress bar the human sees counts tasks and subtasks alike.
4. **Parallel work goes in lanes**: when parts of a ticket run at once (subagents, worktrees, other
   agents), `create_ticket` with `parentId` = the ticket for each part, with its own `branch` and
   `assignee`. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its
   own; its repo and base branch default to the parent's repo and branch. Give each lane `tags` the
   human can filter by (severity such as `High` or `Cosmetic`, area, kind), the same words across
   sibling lanes and never in the title. Register where code runs
   (worktree, sub-branch, sandbox) with `add_workspace`, every worktree as soon as you open it:
   the registered workspaces are the cleanup list. `remove_workspace` when it is gone.
5. **Report as you go** with `post_update`: short markdown, what you did and what is next, and
   attach evidence with `files` (absolute paths to screenshots, recordings, logs on this machine —
   the board copies them). One update per meaningful step, not per keystroke. A ticket has one
   feed of **posts**: `post_update` adds one marked as progress (lane summaries and the Daily view
   pick those out); questions and answers are posts too, not marked. `edit_post` / `delete_post`
   change what you posted.
   **Previews:** when the change can be tried (a page, an API), have a preview the human can open
   before anything is merged, and post its link with what to try. Say that what the human posts
   there stays in a copy of the data. Keep it running while the ticket is in review.
   - **A branch of the board itself: the board runs it.** Register your worktree
     (`add_workspace` with its `path` and `branch`; it must sit next to the main checkout, like
     `../agent-board-<branch>`), then `start_preview` with the workspace's id. The board installs
     (only when the lockfile changed), builds, copies the live data and starts the build on a free
     port from 47101 without the passkey gate, then sets the workspace's `previewUrl`. It returns
     at once; `get_ticket` shows the workspace's `managedPreview` going `building` → `starting` →
     `running`, or `failed` with the last log lines (`logs` has the paths). `start_preview` with
     `restart: true` rebuilds after you push more work, `stop_preview` stops it. The board stops it
     by itself when the PR is merged, the ticket moves to done or cancelled or is archived, or the
     workspace is removed, and when the board itself stops (it does not start them again). Do not
     run `pnpm dev` in your session for the human: it dies with your session and the dev server
     behaves differently from the build.
   - **Anything else:** start your branch from your worktree on a free port, with a copy of the
     data rather than the real one (the project's instructions say how), and register its link on
     the workspace (`set_preview`, or `previewUrl` on `add_workspace`); the ticket page shows it as
     a Preview card with an Open button and whether it is running. Stop it once the ticket is
     merged or dropped, and clear it (`set_preview` with `previewUrl: ""`).

   To exercise the board yourself without the passkey gate, run your own copy: `AUTH=off pnpm dev`,
   or `BOARD_ENV=test` with an `X-Test-Actor` header (README: "Test mode"); never on port 47100,
   never off loopback, never the live board.

6. **Ask and answer**: `comment` on the ticket adds a post to its feed; `comment` on a post
   (`parentType: update`, the post's id), a PR or a review result replies under it. When you cannot
   continue without an answer, also move the ticket to `blocked` (back to `in_progress` once
   answered). When the answer is a choice between clear options (an approach, a trade-off, a scope
   call), use `ask_decision` instead: a card with 2 to 5 options (one may be recommended) that the
   human answers with one click; it blocks the ticket and unblocks it once decided, and the answer
   arrives as a reply under the card. `list_my_threads` lists every feed or reply thread where someone spoke after you;
   `get_ticket` shows each post's reply count and last author. Attachments come with a local
   `path` (and `windowsPath` when the board runs in WSL); `get_attachment` looks one up.
   **Watch for feedback** so the human never has to say "check comments": while you have tickets
   in `in_progress` or `review`, call `check_inbox` every few minutes with `since` = the `cursor`
   of your last call (in Claude Code, under `/loop 5m …`). It returns `count`, a new `cursor` and
   where each new thread is, without bodies. For each one: read it, fix what it asks in the
   ticket's worktree (checks, commit, push, preview), reply in the thread with what changed, and
   keep the cursor. `list_my_threads` takes the same `since` and returns `{ cursor, threads }`; the
   cursor is yours to hold, the board stores nothing per agent.
7. **Hand off**: before `update_ticket` → `review`, every item, in order:
   1. Worktree registered (`add_workspace`), tasks and subtasks ticked.
   2. Checks green: typecheck, lint, unit tests, and the end-to-end suite when the repo has one (the
      project's instructions say how; here `pnpm test:e2e`).
   3. Branch pushed: `get_ticket` → `push.state` is `pushed` (green on the board), not `ahead` or
      `local-only` (red; `ahead` counts the commits only you have). `get_ticket_git` gives the same
      `push` for every workspace's branch. (`merged`: gone from origin because its PR was merged
      into the base.)
   4. `needs` declared for any unmerged branch it builds on: when your branch is built on another
      ticket's open branch (stacked), or you merged one in to get past a conflict, `update_ticket`
      with `needs: [<its ticket id>]` (or `needs` on `create_ticket`), instead of only writing
      "builds on …" in the PR. The PR queue then marks your PR "merge after #<its PR>", and the
      ticket cannot move to `done` until that branch is merged into its base (the refusal says
      which; only the human can mark it done anyway). `get_ticket_git` → `includes` lists the open
      tickets whose unmerged work your branch already holds; `get_ticket` → `needs` says whether
      each is `merged`.
   5. PR open, assigned to the human (`gh pr create --assignee <their login>`, or `--assignee @me`
      when you push with their account; GitHub never lets a PR's author be its requested reviewer,
      and the PR queue lists their own PRs under Waiting on others), and `update_ticket` with its
      `prNumber` (the PR queue then shows the ticket, and the ticket its PR and latest review).
   6. **Preview running**: `start_preview` on the workspace and wait for `running` (for a repo the
      board cannot build, start one the project's way and `set_preview`; see Previews above).
      Required whenever the change can be tried; when it cannot (docs only, a script), say why in
      the hand-off post.
   7. Hand-off post (`post_update`): the PR link, **the preview link and what to try there**, how it
      was tested, the e2e result (the run's summary, or its report when something failed) and
      screenshots of what changed for a UI change.
   8. Resume note if the ticket stays open past the session (step 9).

   `update_ticket` to `review` answers with `handoff.missing`: what the board still sees missing,
   each a `code` and a `text` (`tasks_open`: Implementation, the ticket has no tasks or some of
   its tasks and subtasks, its lanes' included, are open; `no_pr`, `not_pushed`, `no_preview`,
   `no_handoff_post`: no progress post of yours since the branch's last commit, `checks_unknown`:
   the PR's CI is failing or still running). The move goes through anyway: fix each one. `get_ticket` returns the same `handoff`
   while the ticket is in review, and its page shows it as a Hand-off card.

   `done` is the human's call unless the instructions say otherwise. A ticket with lanes goes to
   `review` once its lanes are in `review`, `done` or `cancelled` (`cancelled` is work that was
   dropped: say why in a comment). The human's verdict on a lane or ticket is `approvedAt` /
   `approvedBy` or `disapprovedAt` / `disapprovedBy` (disapproving also cancels it; approving a
   ticket tagged `PR`, a PR review, also moves it to `done`): read it, never set it, and ask in the
   thread before touching an approved or disapproved lane. Archiving is the human's too:
   `archivedAt` set means the ticket (and its lanes) is finished and off the board; `list_tickets`
   leaves those out unless `archived: "include"` or `"only"`.

8. **Clean up**: a lane can go once its work is on its parent's branch, a ticket once its branch is
   in its base (dev, main). `get_ticket_git` says so per branch with `reach` (`merged`, `rebased`,
   `edited`: safe to delete; `unique`: still has work, ask first). Before moving a lane to `done`,
   remove its worktree and local branch, `remove_workspace`, and `post_update` the deleted branches
   as `branch @ sha` (`lane/47 @ 9ec12e8b`) so any can be restored with `git branch`. Never delete
   origin branches: list them for the human. `cleanup_report` lists every leftover of the project's
   closed tickets (previews the board still runs for them too); the board skill's `/board cleanup` walks it with the human.
9. **End of a session**: for every ticket you leave in `in_progress`, `blocked` or `review`,
   `set_resume_note` with its template filled in (state, done so far, next steps, open questions or
   blockers, how to resume: branch, worktree, commands, preview, gotchas), concretely enough that
   another agent can continue without asking. It is the ticket's one current "Where we left off"
   note, shown at the top of its page; each version is also posted to its feed as a handoff. Then
   `post_daily_summary` — at most three short lines at the highest level: what got done, what is
   open. `daily_report` shows what everyone else did that day.
10. **Reports**: a project can ask for a report every day or once a week (`get_report_settings`:
    `cadence`, the `weekday` and `dueTime` it is due by, `format` text or file, and the `prompt`
    saying what it must contain and how: by the hour, sections, audience, a short text or a PDF).
    At the end of a session, `list_reports` shows each recent period as `done`, `missing` (due,
    nothing posted) or `upcoming`; write the current or missing one exactly as the prompt says and
    `post_report` it (`body`, and `files` as absolute paths: the board does not make PDFs; a `file`
    project needs one). Posting again for a period replaces its report and keeps the old one as
    history. For a daily text project the day's summary counts as its report until one is posted.
    `set_report_settings` changes the prompt or schedule; do that only when the human asks.

## The project's agents

A project can define its own agents (`get_project` → `agents`: name, instructions, picture):
personas the human sets up on the board's Agents page. A ticket the human assigns to one is
**reserved** for it (`reserved: true`; `get_ticket` → `agent` has its instructions):

- `claim_ticket` with `as: <its name>`, brief a subagent with the agent's instructions plus the
  ticket's, and post that work with `post_update` / `comment` using `as: <its name>`. It shows
  under the agent's name, via your token name.
- Never take a reserved ticket as yourself or reassign it; only the human does.
- `@name` in a thread asks that agent: `list_my_threads` returns threads waiting on an agent with
  `as` set, for you to answer as it.

**Orchestrating.** Each agent also carries **delegation notes** (`agents[].delegation`): when to
call it, what to give it, what it returns, what comes next. With them you can work a ticket as its
orchestrator instead of doing the work yourself: each step runs as a subagent briefed with that
agent's instructions, the project's and the ticket's, and the hand-off checklist (step 7); its result
is posted on the ticket as that agent; the notes pick the next agent. Before moving the ticket to
`review`, check every item of that checklist yourself. The Agents page adds a default set (spec, builder, runner, and
the review phases env, verify, hunt, refute, merge): spec → build → a review that tries to break it
→ build again with the confirmed findings (at most three rounds) → hand off. The `/review-queue`
skill is that orchestrator and `/feature-review` its review; the same page installs both. Ask with
`ask_decision` instead of guessing; never two builders on one branch. The board skill has the full
routine.

## PR queue and reviews

- `list_prs` shows the human's PRs, open and merged in the last two weeks: `waitingOn` is `me` for
  PRs by others that the human reviews, `others` for the human's own (agents' PRs pushed with their
  account included). `status` is where the reviews stand: `pending` (approval missing), `reviewed`
  (approved: by the human on others' PRs, by every reviewer on theirs), `on_hold` (review comments
  or requested changes not yet addressed by a push or a new review request, or a board-side hold)
  or `done` (merged). Each also has where it stands on GitHub (`merge`, `ci` with its `checks`,
  `reviewDecision`), the latest review verdict and the tickets it came from. `set_pr_hold` parks
  an open one with a note (board-only). `list_review_results` (by `prNumber`, `sha`) tells whether
  a head SHA was already reviewed; `get_review_result` has the findings.
- `list_actors` gives the names to use for `assignee`.
- If you review a PR, record it with `post_review_result` (verdict, markdown summary with
  findings, how to test, checks): that is how findings reach the human, as the verdict on the PR
  queue and on the ticket's Branch card, which open the result in full. Never post the review to
  GitHub.

## Writing style on the board

Plain words, short. Titles under 80 characters. Updates say what changed and what is next; the
human reads dozens of these a day. Screenshots beat paragraphs.

## Keep the board out of the repo

The board, trazic, habits and any other personal tracking tool are private to the human. Never
mention them, their tool names, their URLs or a board ticket, task or project (`#12`, "ticket 12",
"per the board") in code comments, docs, commit messages, branch names, PR titles or descriptions,
or issues, and never link or screenshot the board there. Describe the change in the repo's own
terms; restate what the PR needs from the ticket instead of pointing at it. Board updates and
comments may talk about the repo, branches and PRs freely.
