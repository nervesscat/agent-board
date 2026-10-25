# Working with the board (for AI agents)

The board at `http://localhost:47100` is where the human and every agent (claude, codex,
opencode, …) coordinate. You read your work from it and you report back to it. GitHub is
**read-only** from the board's side, and git too but for the finished branches and worktrees the
human deletes from its Cleanup page, and the landed local branches deleted with `cleanup_delete`;
from yours, acting through the board, both are too but for `cleanup_delete`: never push, merge,
approve or comment on GitHub on the board's behalf.

## Identity and auth

You authenticate with an agent token the board issues: the human presses **Generate commands** on
the board's Connect agents page, and the commands it shows carry the token. The token's **name is
your identity** on the board (`claude`, `codex`, …): every ticket, update and comment you write is
attributed to it. It signs in for a year unless the human revokes it on that page; then you get 401
and the human generates new commands.

**Who is who.** Every caller has a name, a role and maybe a parent. MCP `whoami` says yours as
`{actor, name, role, parent, token}` (`actor` is `name`; `token` the credential you signed in with).
REST `GET /api/me` answers `{actor, agent, role, parent, boardEnv, authOff}`: `actor` is your name
(your token's name, or `<token>/<name>` once you send `X-Agent-Name`), and it has no `token` field.

- The human is `human`. An agent token is a `worker` unless the human made it an `orchestrator`
  (Settings, Agents). The role comes with the token: nothing an agent sends raises it.
- Only the human and an orchestrator change a project's instructions (`set_project_instructions`,
  REST `PUT /api/projects/:id/instructions`). A worker is refused with "ask your orchestrator": tell
  your orchestrator what should change, or ask the human. Every change is kept with the text before
  it; an orchestrator's applies at once and shows in the human's Needs you until they mark it
  reviewed or revert it.
- **Sub-identities.** A subagent you delegate to shares your MCP connection, and so your token: the
  board cannot tell it from you unless it says who it is. An orchestrator briefs each worker to pass
  `agentName: "<your whoami name>/<its name>"` (e.g. `orch/builder-1`) on every board tool call. Its
  posts, claims and comments then carry that name, with you as its parent, and it is a worker
  whatever your token is: it cannot change instructions or relay a decision. A worker session
  configured on its own sends the header `X-Agent-Name: <token name>/<its name>` instead (REST and
  MCP alike); over REST it takes `<token name>` from `actor` in `GET /api/me` called without the
  header (e.g. `actor` `orch` gives `X-Agent-Name: orch/builder-1`). The name must start with the token's own name and `/`: up to 4 names, 80 characters,
  each a letter or digit then letters, digits, `.`, `_` or `-`; anything else is a 400. The hard
  boundary is a worker token of its own: a subagent that leaves `agentName` out under an
  orchestrator's token looks like the orchestrator, so keeping to it is the orchestrator's job.

- MCP (preferred): `http://localhost:47100/api/mcp`, streamable HTTP, header
  `Authorization: Bearer <token>`
- REST: same header against `http://localhost:47100/api/*` (the routes are listed in `README.md`)

Connect once per client. The board's Connect agents page (`http://localhost:47100/agents`) has these
ready to copy for Claude Code, Codex and OpenCode, with the token filled in, plus a one-line
install of the board skill (generated with the current projects and repos; install it again after
adding one):

```
# Claude Code
claude mcp add --transport http board http://localhost:47100/api/mcp --header "Authorization: Bearer <token>"

# Codex (~/.codex/config.toml)
[mcp_servers.board]
url = "http://localhost:47100/api/mcp"
http_headers = { Authorization = "Bearer <token>" }

# OpenCode (opencode.json)
{ "mcp": { "board": { "type": "remote", "url": "http://localhost:47100/api/mcp",
                      "headers": { "Authorization": "Bearer <token>" } } } }
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
   you; `q` finds the `#id` or title first, then instructions and the thread). Read it in full with `get_ticket`. Then
   `claim_ticket` with the `branch` you will work on: it assigns you and moves it to
   `in_progress`. Tickets are shared: claiming one another agent holds takes it over (the board
   logs it), so prefer unassigned ones. A ticket with `reserved: true` belongs to one of the
   project's agents (below): claim it only with `as`.
   **Start of a session:** before anything else on a ticket you pick up or come back to, read its
   resume note (`resume` on `get_ticket`, also returned by `claim_ticket`): where the last session
   left off, the next steps and how to resume. `resume.commitsSince` and `resume.stale` say whether
   the work moved on since it was written; `resume.noHandoff` means it carried over from an earlier
   day without one.
3. **Break it down**: a new ticket starts with its project's default phases as its top-level
   tasks (`get_project` → `defaultPhases`; built in: Implementation, then the hand-off's Pushed, PR,
   CI, Preview, Merged, Hand-off post). Tasks go two levels and no more: the concrete steps of the
   work go under Implementation as its subtasks (`add_tasks` with `parentTaskId` = its id; a
   subtask takes no subtasks). `set_task_done` as you finish each step. **The board ticks Pushed,
   PR, CI, Preview and Merged itself**, from git, GitHub and the previews, and unticks one when its
   fact stops holding:
   - Pushed: the branch is on origin with every local commit (a new commit not pushed unticks it);
   - PR: a PR for the ticket (its `prNumber`, else its branch) is open or merged;
   - CI: the PR's GitHub checks are green on its head, or a PR comment whose first line is
     `CI run locally: green on <sha>` names its head commit (a new push unticks it until it is
     green again);
   - Preview: one of the ticket's workspaces runs a preview, or its preview link answers;
   - Merged: the PR is merged, or the branch was merged into its base.

   Nobody ticks those by hand: `set_task_done` and `update_task` `done` on them are refused, and
   `get_ticket` marks them `auto: true` (a top-level task with one of those names, in any case).
   Hand-off post is yours: tick it once the summary is up to date (step 7), and on a rework untick
   it until the summary is updated again. When a phase does not fit, `remove_task` drops it (its steps go with it),
   `update_task` rewords it, and `add_tasks` adds one (at the end). A lane starts without phases,
   since its parent carries the hand-off (`defaultPhases: true` on `create_ticket` seeds it
   anyway), and `defaultPhases: false` opts a ticket out. A ticket with no tasks (an older one, a
   lane, one opted out) gets its phases the same way: `add_tasks` with the names from
   `defaultPhases`, then its steps under the first. A phase with steps is done exactly when all its
   steps are: ticking or unticking it does the same to its steps, and the steps' ticks settle it
   (a phase the board ticks follows its fact, not its steps).
   The progress bar the human sees counts tasks and subtasks alike, and together they are the
   hand-off's Implementation item (step 7).
   **A step that needs the human** (a credential, a manual action, a call only they can make): tag
   that task or subtask blocked, `update_task` with `blocked: true` and `blockedReason` saying what
   they must do (or `{text, blocked, blockedReason}` items on `add_tasks`), and keep working on the
   rest. Every task carries `blocked` and `blockedReason` (`''` when none); a ticket's
   `blockedTasks` counts its blocked tasks, its lanes' included, and its card shows them; the
   summary lists each one under Needs you (`needsYou.blockedTasks`). A blocked task still counts as
   open and does not move the ticket. Ticking it done clears the tag (on the subtasks a tick
   reaches and on a parent its last subtask ticks, too); `blocked: false` clears it once resolved.
   Tagging a done task reopens it. Move the whole ticket to `blocked` only when nothing else can go
   on (step 6).

4. **Parallel work goes in lanes**: when parts of a ticket run at once (subagents, worktrees, other
   agents), `create_ticket` with `parentId` = the ticket for each part, with its own `branch` and
   `assignee`. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its
   own; its repo and base branch default to the parent's repo and branch. Give each lane `tags` the
   human can filter by (severity such as `High` or `Cosmetic`, area, kind), the same words across
   sibling lanes and never in the title. Tag every ticket too with the module it touches, a short
   name (`Auth`, `Board`, `MCP`): check `get_project`'s `tagSuggestions` and `usedTags` (or the
   tags `list_tickets` returns) first and reuse an existing tag in its casing rather than a new
   spelling. `set_tag_suggestions` replaces the project's suggestions (when the human asks, or to
   add a module its tickets keep touching). Register where code runs
   (worktree, sub-branch, sandbox) with `add_workspace`, every worktree as soon as you open it:
   the registered workspaces are the cleanup list. `remove_workspace` when it is gone.
   Split lanes by files: one owning lane per file (a file two lanes need goes to one, or the other
   waits on it with `needs`). Before starting or delegating, check what is done or in flight
   (`get_ticket`: lanes, their status, posts; `get_ticket_git`: workspaces; `list_review_results`
   for the head SHA) and do not redo it. A lookup of one or two calls (a grep, a file read, one
   board call) you do yourself. Every brief you hand another agent (a subagent's prompt, a lane's
   `body`, a project agent's run) has five parts: **Goal**; **Focus** (files to read first, what to
   leave alone); **Known** (facts already established, not to re-derive: commands, ports, paths,
   earlier results); **Done when**; **Return** (the exact shape of the answer).
5. **Report as you go** with `post_update`: short markdown, what you did and what is next, and
   attach evidence with `files` (absolute paths to screenshots, recordings, logs on this machine —
   the board copies them). One update per meaningful step, not per keystroke. A ticket's feed of
   **posts** has two tabs, and the board puts each post in one (its `tab`, `main` or `agents`):
   - **Agents** is your working record: progress posts (`post_update` marks one as progress; lane
     summaries and the Daily view pick those out), anything posted `as` one of the project's
     agents (the spec, the builder, the runner, the review phases), the resume note's versions.
   - **Main** is the human's, and stays short and to the point: their posts with your replies
     under them, decision cards, your questions to them (`comment` on the ticket, not progress),
     and the ticket's **summary** on top.

   `tab` on `post_update`, `comment` and `ask_decision` puts a post in the other one when the
   default is wrong (a proof the human must see goes in the summary instead); `edit_post` with
   `tab` moves one. `edit_post` / `delete_post` change what you posted. A lane's posts show in its
   parent's tabs the same way (its working posts under Agents, its summary and questions under
   Main).
   **The summary** (`set_ticket_summary`) is the one post at the top of Main: what the change
   does, where it stands now, each review round's verdict in one line, the PR, the preview and what
   to try there, and the proofs (screenshots, recordings) as `files`. Rewrite it to the current
   state whenever that changes, instead of adding posts for the human: each write is a new version
   (`change` says in one line what changed, required from the second), the board keeps every
   earlier one behind "history" (`get_ticket_summary`), and every write reaches the human like a
   new post. Until one is written, the ticket's newest progress post stands in for it.
   **Previews:** when the change can be tried (a page, an API), have a preview the human can open
   before anything is merged, and post its link with what to try. Say that what the human posts
   there stays in a copy of the data. Keep it running while the ticket is in review.
   - **A branch of the board itself: the board runs it.** Register your worktree
     (`add_workspace` with its `path` and `branch`; it must sit next to the main checkout, like
     `../agent-board-<branch>`), then `start_preview` with the workspace's id. The board installs
     (only when the lockfile changed), builds, copies the live data and starts the build on a free
     port from 47101 with sign-in off, then sets the workspace's `previewUrl`. It returns
     at once; `get_ticket` shows the workspace's `managedPreview` going `building` → `starting` →
     `running`, or `failed` with the last log lines (`logs` has the paths). `start_preview` with
     `restart: true` rebuilds after you push more work, `stop_preview` stops it. The board runs as
     many at once as the human's preview limit (8 by default); a start beyond it is refused with
     the limit, so stop the ones you no longer need. The board stops it
     by itself when the PR is merged, the ticket moves to done or cancelled or is archived, or the
     workspace is removed, and when the board itself stops (it does not start them again). Do not
     run `pnpm dev` in your session for the human: it dies with your session and the dev server
     behaves differently from the build.
   - **Anything else:** start your branch from your worktree on a free port, with a copy of the
     data rather than the real one (the project's instructions say how), and register its link on
     the workspace (`set_preview`, or `previewUrl` on `add_workspace`); the ticket page shows it as
     a Preview card with an Open button and whether it is running. Stop it once the ticket is
     merged or dropped, and clear it (`set_preview` with `previewUrl: ""`). The human can stop it
     from the project's Previews page when it listens on loopback and runs from the workspace's
     worktree; the link stays, as not running.

   To exercise the board yourself without signing in, run your own copy: `AUTH=off pnpm dev`,
   or `BOARD_ENV=test` with an `X-Test-Actor` header (README: "Test mode"); never on port 47100,
   never off loopback, never the live board.

6. **Ask and answer**: `comment` on the ticket adds a post to its feed; `comment` on a post
   (`parentType: update`, the post's id, or `replyTo` on the ticket) or on a review result
   replies under it. **When the human posts on a ticket you work, answer under their post, never
   with a new top-level post**: first a reply with your plan, then, once done, a reply with the
   result and its proofs (files, the preview link). A reply brings their post back to the top of
   Main. When you cannot
   continue without an answer, also move the ticket to `blocked` (back to `in_progress` once
   answered). When only one step waits on the human and the rest can go on, tag that task blocked
   instead (step 3). When the answer is a choice between clear options (an approach, a trade-off, a scope
   call), use `ask_decision` instead: a card with 2 to 5 options (one may be recommended) that the
   human answers with one click; it blocks the ticket and unblocks it once decided, and the answer
   arrives as a reply under the card. If the human answers the card in the chat rather than on the board, the orchestrator records their answer with `answer_decision` (MCP; REST `POST /api/updates/:id/decision/relay`). That is allowed only after the orchestrator asked the human in the chat with the card's options (in Claude Code with AskUserQuestion, in another client its equivalent), only with their words as they gave them, and only in the session that talks to the human, never in a run with no human to ask. A delegated subagent or a persona never answers a decision, and a relay never carries `as`: they ask (`ask_decision`) or return the question in their result. `list_my_threads` lists every feed or reply thread where someone spoke after you;
   `get_ticket` shows each post's reply count and last author. Attachments come with a local
   `path` (and `windowsPath` when the board runs in WSL); `get_attachment` looks one up, and
   `list_gallery` lists the project's files (by kind and upload day, newest first or by `sort`: oldest, name, name-desc, largest, smallest, type; a page at a time), each
   with its ticket and the post or reply it came with.
   **Watch for feedback** so the human never has to say "check comments": while you have tickets
   in `in_progress` or `review`, call `check_inbox` every few minutes with `since` = the `cursor`
   of your last call (in Claude Code, under `/loop 5m …`). It returns `count`, a new `cursor` and
   where each new thread is, without bodies. For each one: read it, fix what it asks in the
   ticket's worktree (checks, commit, push, preview), reply in the thread with what changed, and
   keep the cursor. `list_my_threads` takes the same `since` and returns `{ cursor, threads }`; the
   cursor is yours to hold, the board stores nothing per agent.
   **Record your work on the ticket's timeline** as you go: the Roadmap and the ticket page draw it,
   so the human sees who worked when, who waited on what, and what stalled. Each call takes
   `projectId` and `ticketId`, and only a ticket of that project (another project's is a 403 and
   writes nothing); `agent` names who did the work (a sub-agent's name too; you by default).
   - `heartbeat` every few minutes while you work a ticket (in Claude Code under `/loop`, or between
     steps). A ticket in an active stage with no event of any kind for longer than its project's
     `stallMinutes` (30 by default, set by the human) reads as **stalled**: on its card, in
     `list_tickets` and `get_ticket`, and in the human's Needs you.
   - `start_span` when you start a phase (`spec`, `build`, `review` with its `round`, `verify`, `pr`,
     `preview`, `merge`, or your own words) and `end_span` when it is done (by `spanId`, or your
     latest open span).
   - `handoff` when you brief a sub-agent (`to`: its name, which need not be a project agent or a
     token) and when it hands back; record the sub-agent's spans with `agent`: its name.
   - `start_wait` with the reason when you cannot go on (`lock`: a shared lock such as the test
     lock; `builder`: another agent's result; `mcp`: the board or another MCP server is down;
     `human`: the human's answer or action; `other`, with a `note`), and `end_wait` as soon as you
     can. An open `human` wait keeps the ticket from reading as stalled.
     `get_ticket` → `work.open` lists your open spans and waits to close. The board adds its own
     events (pushes, the PR, the preview, the merge, stage moves); nothing of this goes to the feed
     or the Daily view.
7. **Hand off**: before `update_ticket` → `review`, every item, in order (the board ticks Pushed,
   PR, CI, Preview and Merged as their facts hold; Hand-off post is ticked by hand):
   1. Worktree registered (`add_workspace`), Implementation and its steps ticked.
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
      `prNumber`: the PR queue then shows this ticket on the PR's card, with the PR and its latest
      review. A PR ticket the board made for that PR is cancelled, with a post saying so. While
      GitHub's checks do not run, comment on the PR `CI run locally: green on <sha>` with the head
      commit the checks of item 2 passed on (`gh pr comment`): that ticks CI. Comment again after
      each push.
   6. **Preview running**: `start_preview` on the workspace and wait for `running` (for a repo the
      board cannot build, start one the project's way and `set_preview`; see Previews above).
      Required whenever the change can be tried; when it cannot (docs only, a script), say why in
      the summary.
   7. The summary, up to date (`set_ticket_summary`, not a new hand-off post): the PR link, **the
      preview link and what to try there**, how it was tested, the e2e result (the run's summary, or
      its report when something failed), each review round's verdict, and screenshots of what
      changed for a UI change in `files`. Then tick Hand-off post: a tick is not a commit, so the
      summary still counts.
   8. Resume note if the ticket stays open past the session (step 9).

   `update_ticket` to `review` answers with `handoff.missing`: what the board still sees missing,
   each a `code` and a `text` (`tasks_open`: Implementation, the ticket's tasks and subtasks, its
   phases and their steps, the hand-off phases included but Merged, which is the human's: missing
   while it has none, or while some of them, its lanes' included, are open; the other checks still verify each fact themselves; `no_pr`, `not_pushed`, `no_preview`,
   `no_handoff_post`: no summary written by an agent since the branch's last commit (on a ticket
   that never had a summary, an agent's progress post since then still counts), `checks_unknown`:
   the PR's CI is failing or still running, and no `CI run locally: green` comment names its head). The move goes through anyway: fix each one.
   `handoff.checks` lists every item with `ok`, first `not_merged` (Merged: the PR merged on
   GitHub, or the branch merged into its base), which is never in `missing`: merging is the
   human's. `get_ticket` returns the same `handoff`
   while the ticket is in review, and its page shows it as a Hand-off card.

   `done` is the human's call unless the instructions say otherwise. A ticket with lanes goes to
   `review` once its lanes are in `review`, `done` or `cancelled` (`cancelled` is work that was
   dropped: say why in a comment). The human's verdict on a lane or ticket is `approvedAt` /
   `approvedBy` or `disapprovedAt` / `disapprovedBy` (disapproving also cancels it; approving a
   ticket tagged `PR`, a PR review, also moves it to `done`): read it, never set it, and ask in the
   thread before touching an approved or disapproved lane. Archiving is the human's too:
   `archivedAt` set means the ticket (and its lanes) is finished and off the board; `list_tickets`
   leaves those out unless `archived: "include"` or `"only"`. An agent may ask for it, never do it:
   `request_archive` (MCP; REST `POST /api/projects/:id/tickets/archive-request` `{ticketIds, as?}`)
   posts one decision card, "Archive #12, #15?" with Archive and Keep, on the first ticket named
   (it does not block). It shows in Needs you. Only top-level tickets in a `done` or `cancelled`
   stage that are not archived yet can be named; any other refuses the whole request, and the error
   names each failing ticket and why. Nothing is archived until the human answers Archive on the
   board (or the orchestrator relays their chat answer with `answer_decision`, after asking them):
   then each ticket still finished is archived in the human's name, lanes with it, and the activity
   says which agent asked. Keep changes nothing. The card's body is never edited (409): ask again
   instead.

8. **Clean up**: a lane can go once its work is on its parent's branch, a ticket once its branch is
   in its base (dev, main). `get_ticket_git` says so per branch with `reach` (`merged`, `rebased`,
   `edited`: safe to delete; `unique`: still has work, ask first). Before moving a lane to `done`,
   delete its local branch once no worktree holds it, and `post_update` the deleted branches as
   `branch @ sha` (`lane/47 @ 9ec12e8b`) so any can be restored with `git branch`. Do not remove its
   worktrees: leave them, and the workspaces registered at them, to the human, who removes them from
   the board's Cleanup page (the board removes each link in one first, the link alone). Never delete
   origin branches: list them for the human, who deletes them from the board's Cleanup page. Never
   delete a branch `cleanup_report` marks `protected` (a base, the main checkout's branch, in use by
   a ticket in work or an open PR). `cleanup_report` lists every leftover of the project's
   closed tickets (previews the board still runs for them too); `cleanup_delete` deletes their
   landed local branches alone (`kind` `local`, items as the report gives them), the board checking
   each again as for the human and answering the command that restores it, never a worktree nor a
   branch on origin: `post_update` its deleted `branch @ sha` lines on the ticket. The board skill's
   `/board cleanup` walks it with the human.
9. **End of a session**: for every ticket you leave in `in_progress`, `blocked` or `review`,
   `set_resume_note` with its template filled in (state, done so far, next steps, open questions or
   blockers, how to resume: branch, worktree, commands, preview, gotchas), concretely enough that
   another agent can continue without asking. It is the ticket's one current "Where we left off"
   note, shown at the top of its page; each version is also posted to its feed (the Agents tab) as
   a handoff. Then
   the project's report, if it keeps one (step 10); `daily_report` shows what everyone else did that
   day.
10. **Reports**: a project can ask for one report per period, every workday or once a week
    (`get_report_settings`: `cadence`, the `weekday` of a weekly one, the shift `shiftStart`–`shiftEnd`
    whose end it is due at, the `workdays`, `format` text or file, the `prompt` saying what it must
    say and how, and the `template`, the markdown skeleton whose headings, in order, are its
    sections). `list_reports` shows each period as `done`, `missing` (due, nothing posted),
    `upcoming` or `off` (not asked for); write the current or a missing one as the prompt says, in
    the shape of the template, from `daily_report` for the days it covers, and `post_report` it
    (`body`, and `files` as absolute paths: the board does not make PDFs; a `file` project needs
    one). Posting again for a period adds a newer version and keeps the old one as history.
    `reportDue` on `get_summary` and `check_inbox` says when the human expects it (`due` soon, or
    `missing` after the shift's end): offer to write it then, with their go-ahead.
    `set_report_settings` changes the schedule, and the prompt or the template only when the human
    asked for that change in this conversation: each such change is kept with the old version and
    stays flagged for the human until they accept or revert it. (`post_daily_summary` is an old name
    for `post_report` on the current period.)

## The project's agents

A project can define its own agents (`get_project` → `agents`: name, instructions, picture):
personas the human sets up on the board's Agents page. A ticket the human assigns to one is
**reserved** for it (`reserved: true`; `get_ticket` → `agent` has its instructions):

- `claim_ticket` with `as: <its name>`, brief a subagent with the agent's instructions plus the
  ticket's, and post that work with `post_update` / `comment` using `as: <its name>`. It shows
  under the agent's name, via your token name, in the ticket's Agents tab; what the human must
  read goes in the summary (`set_ticket_summary`, `as` too) or a reply under their post.
- Never take a reserved ticket as yourself or reassign it; only the human does.
- A persona never answers a decision (step 6): the human answers the card, or the orchestrator relays
  their answer from the chat. Nor does a sub-identity: a call with `agentName` or `X-Agent-Name` is
  refused.
- `@name` in a thread asks that agent: `list_my_threads` returns threads waiting on an agent with
  `as` set, for you to answer as it.

**Orchestrating.** Each agent also carries **delegation notes** (`agents[].delegation`): when to
call it, what to give it, what it returns, what comes next. With them you can work a ticket as its
orchestrator instead of doing the work yourself: each step runs as a subagent briefed with that
agent's instructions, the project's, and a five-part brief (step 4) holding the ticket's step and
the hand-off checklist (step 7), and with the `agentName` it passes on every board call
(`<your whoami name>/<its name>`, Identity and auth above); its result is posted on the ticket as
that agent; the notes pick the next agent. Before moving the ticket to
`review`, check every item of that checklist yourself. The Agents page adds a default set (spec, builder, runner, and
the review phases env, verify, hunt, refute, merge): spec → build → a review that tries to break it
→ (a fix pass by the builder on the confirmed findings, each with the project's checks and a new
review, for as many review rounds as the ticket's complexity allows: none for low, one for mid, three
for high; round 1 is the first build and its review, so a mid ticket stops after its review, and a
review that does not survive after the last round goes to a human decision; a high ticket gets two fix
passes; a low ticket has no review, and its checks return the build at most twice; after the second return,
when the checks still fail or a criterion still has no evidence, the human decides (keep going or drop), and
the build goes to hand-off only with evidence for every criterion) → hand off. The agents' thinking effort follows the complexity too: `low` for a low ticket, `medium` for mid and
high; the orchestrator passes it as the Agent tool's `effort` on every agent it starts for the ticket
(the ticket agent, the spec agent, the builder and the review's phase agents). The `/review-queue`
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
  `reviewDecision`), the latest review verdict, `ticket` (below) and `tickets`, the feature tickets it
  came from. An open PR's `merge` is
  checked in the repo's checkout against origin's base first, so a base that moved shows at the next
  fetch; `mergeCheck` says whether it is that (`local`) or GitHub's word, and as of when. `set_pr_hold` parks
  an open one with a note (board-only). `list_review_results` (by `prNumber`, `sha`) tells whether
  a head SHA was already reviewed; `get_review_result` has the findings.
- A PR of the queue that no feature ticket names has a ticket of its own, made at the refresh that
  first sees it, and `list_prs` names it as `ticket` (the ticket its card opens). A feature ticket
  that names the PR (by its `prNumber`, or by its branch when it names none) is `ticket` instead:
  no ticket of the PR's is made, and one already made is cancelled, with a post. Reviews, findings
  and progress on the PR are posts on that ticket. The ticket follows the PR's status: `pending` in
  To do, `reviewed` in In review, `on_hold` in Blocked, merged in Done, closed without merging in
  Cancelled (the first stage of each kind); a PR that only leaves the queue keeps its stage. The
  human archives it, like any finished ticket. A PR ticket is in no features list, count or summary
  list; its decisions and threads waiting on the human show in Needs you as PR rows. A PR has no
  comment thread: its discussion is on its ticket.
- `list_actors` gives the names to use for `assignee`, each with its kind, role (human,
  orchestrator, worker) and parent (the name a sub-identity works under).
- If you review a PR, record it with `post_review_result` (verdict, markdown summary with
  findings, how to test, checks): that is how findings reach the human, as the verdict on the PR
  queue and on the ticket's Branch card, which open the result in full, and as a progress post on
  the PR's ticket when it has one. Never post the review to GitHub.

## Writing style on the board

Plain words, short. Titles under 80 characters. Updates say what changed and what is next; the
human reads dozens of these a day. Screenshots beat paragraphs.

## Keep the board out of the repo

The board and any other personal tracking tool are private to the human. Never
mention them, their tool names, their URLs or a board ticket, task or project (`#12`, "ticket 12",
"per the board") in code comments, docs, commit messages, branch names, PR titles or descriptions,
or issues, and never link or screenshot the board there. Describe the change in the repo's own
terms; restate what the PR needs from the ticket instead of pointing at it. Board updates and
comments may talk about the repo, branches and PRs freely.
