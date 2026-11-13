---
name: board
description: Work through the agent board ({{BOARD_URL}}, MCP server "board") - find this repo's project, pick up a ticket, break it into tasks, split parallel work into lanes, post progress with screenshots, answer threads, hand off for review, clean up finished branches and worktrees, and write the project's report. Use when the user says "pick up a ticket", "next ticket", "where did we leave off", "what's on the board", "report to the board", "post an update", "hand this off", "move it to review", "daily summary", "daily report", "weekly report", "board cleanup", "clean up branches" or "clean up worktrees", mentions a board ticket number, or when starting or finishing work in a repo that has a board project.
---

# Working through the agent board

The board is where the human and every agent coordinate. Its tools come from the `board` MCP
server. A session that reaches the board only through a proxy or a network it brings up itself (a
cloud session on the tailnet) starts that server with the `board-mcp` bridge, or takes the REST copy
of this skill ({{BOARD_URL}}/api/agent-setup/skill?transport=rest). If they are missing, or the board answers 401 (the token was revoked or is a year old), say
so and stop: the human presses Generate commands on the board's Connect an agent page
({{BOARD_URL}}/agents), which makes your agent token and fills it into the setup. {{MCP_HINT}} Git
and GitHub stay read-only through the board for you, but for closed tickets' landed local branches,
which `cleanup_delete` deletes (worktrees and origin's branches are the human's, from its Cleanup
page): never push, merge, approve or comment on GitHub on its behalf.

## Keep the board out of the repo

The board and any other personal tracking tool are private to the human. Nothing
you write into the repo or onto GitHub may mention them:

- no code comments, docs, READMEs, changelogs or config that name the board or any such tool,
  their tools (`post_update`, `list_tickets`, …), their URLs (`localhost:47100`), or a
  board ticket, task, update or project (`#12`, "ticket 12", "per the board");
- no commit messages, branch names, PR titles or PR descriptions that do either;
- no links or screenshots of the board in PRs or issues.

Write those as if the board did not exist: describe the change and its reason in the repo's own
terms. If the ticket's text has something the PR needs (the why, how to test), restate it in your
own words instead of pointing at the ticket. Board updates and comments may, of course, talk about
the repo, branches and PRs freely; the rule only runs the other way.

## 1. Your project: ask the board with `find_project`, nowhere else

Work only in the project of the repo you are in. Do not call `list_projects`, and never read or
write another project's tickets, PRs, reviews or daily log.

Find the repo you are in (its origin from `git remote get-url origin`, and its path from
`git rev-parse --show-toplevel`, or the working folder), then call `find_project` with
`githubRepo` (the origin URL or `owner/name`), `folder` (the path's last segment) and `path`. It
answers from the board as it is now with only the project and repo that match (`projectId`,
`repoId`), by the GitHub slug first, then the path, then the folder name; the same repo checked out
on Windows and in WSL, or a worktree of it (e.g. `.wt-pr14`), is found by its slug, or by its path
inside or beside the repo's checkout.

- `match: "repos"`, a folder holding several repos of one project: that is the project; ask which
  repo (or take it from the ticket) before passing a `repoId`.
- `match: "ambiguous"`, repos in several projects: ask the human which one; do not pick.
- `weak: true`: the match may be another repository (its `message` says why); confirm with the human.
- `match: "none"`: say the repo has no board project and stop using the board for it. Do not
  guess from other projects and do not create one.

Then:

1. `whoami`: who the board knows you as: `name` (the agent token's name, or your sub-identity's),
   `role` and `parent`. Use the name as the assignee. An `orchestrator` (the human makes a token one,
   in Settings, Agent tokens) also changes the projects' instructions (`set_project_instructions`), creates
   a project with instructions and moves a repo to another project; a `worker` cannot: tell your
   orchestrator what should change. If you were briefed with an `agentName`
   (`<orchestrator>/<you>`), pass it on **every** board call: it makes your posts, claims and
   comments yours, as a worker under the orchestrator.
2. `get_project` with your `projectId`. Its `instructions` override
   your defaults for every repo in it. Its `stages` are the board's columns, each with a `key`, a
   `name` and a `kind` (`open`, `active`, `blocked`, `review`, `done`, `cancelled`); a ticket's
   `status` is a stage key. Wherever a status is asked for you can also pass a kind, which means
   the project's stage of that kind: for `open` (`todo`) the start stage (the last open stage), for
   `active` (`in_progress`) the stage work starts in (the project's `workStage`, else the first
   active stage), for any other kind the first stage of that kind. Below, `todo`, `in_progress`,
   `blocked`, `review`, `done` and `cancelled` mean exactly that. Its `agents` are the project's own agents (see
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
  marks steps of the work; the rest is discussion), each with `tab` (`main` or `agents`, below)
  and `thread`: how many replies and who spoke last. `summary` is the ticket's summary, the
  hand-off the human reads first. `list_comments` (`parentType: update`, the post's id) reads a post's replies. On a lane,
  `ancestors` names the tickets above it: `get_ticket` the parent too for the bigger picture, but
  the lane's own instructions are your brief.
- `claim_ticket` with the `branch` you will use: it assigns you and moves it to `in_progress`.
  Tickets are shared: claiming one another agent holds takes it over (the board logs it), so prefer
  unassigned ones and take over only what is stalled or handed to you. A ticket with
  `reserved: true` belongs to one of the project's agents: claim it only with `as`, below.
- **Start of a session: read the summary first.** For every ticket you pick up or come back to,
  before anything else, read its `summary` (on `get_ticket`, the one state post at the top of
  Main): where the last session left off, what is done, the next steps, the PR and the preview.
  Read the latest posts and the branch too when the summary is behind them.
- A new ticket starts with its project's default phases as its top-level tasks (`get_project` →
  `defaultPhases`; built in: Implementation, then the hand-off's Pushed, PR, CI, Preview, Summary,
  Merged).
  Tasks go two levels and no more: put the concrete steps of the work under Implementation
  as its subtasks (`add_tasks` with `parentTaskId` = its id; a subtask takes no subtasks). Remove
  or reword a phase that does not fit (`remove_task`, `update_task`); `add_tasks` adds one at the
  end. A lane starts without phases, since its parent carries the hand-off (`defaultPhases: true`
  on `create_ticket` seeds it anyway), and `defaultPhases: false` opts a ticket out.
- No tasks yet (an older ticket, a lane, one opted out) → the phases the same way: `add_tasks` with
  the names from `defaultPhases`, then the steps under the first. The human's progress bar is these
  tasks and subtasks, all counted, and the open ones are what a move to review answers with (`open`).

Creating a top-level ticket (only when the human asks): `create_ticket` with your `projectId` and
`repoId` and, when the human says how much review it gets, `complexity` (`low`, `mid`, `high` or
`max`; `mid` when left out); it starts with the default phases, the `tasks` you give as plain texts under
the first.
Lanes of a ticket you are working are yours to create (next section).

## 3. While working

- `set_task_done` as each step finishes. The board ticks the phases Pushed, PR, CI, Preview, Summary
  and Merged itself, from git, GitHub, the previews and the ticket's posts, and unticks one when its
  fact stops holding:
  Pushed while the branch is on origin with every local commit (a new commit not pushed unticks
  it), PR while a PR for the ticket is open or merged, CI while the PR's checks are green on its
  head or a PR comment whose first line is `CI run locally: green on <sha>` names its head commit
  (a new push unticks it until it is green again), Preview while one of the ticket's workspaces
  runs a preview or its link answers, Summary while an agent wrote or updated the summary
  (`set_ticket_summary`) after the branch's last commit (a new commit unticks it until the summary
  is rewritten; a ticket that never had a summary goes by an agent's progress post since then),
  Merged once the PR or the branch is merged. Nobody ticks
  those by hand: `set_task_done` and `update_task` `done` on them are refused (`get_ticket` marks
  them `auto: true`). Implementation and its steps are yours to tick. A phase with steps is done exactly when
  all its steps are: ticking or unticking a phase does the same to its steps, ticking its last open
  step ticks it, unticking a step unticks it (a phase the board ticks follows its fact, not its
  steps). When the plan changes, `update_task` rewords a task and `remove_task` drops one
  that no longer applies (a phase goes with its steps), so the progress bar stays honest.
- Record your work on the ticket's timeline (the Roadmap and the ticket page draw it; the human
  sees from it who worked when, who waited on what, and what is going on now). Each call takes
  `projectId` and `ticketId`, and only a ticket of that project:
  - `heartbeat` every few minutes while you work the ticket: in Claude Code under `/loop` (the same
    loop as [Watch for feedback](#watch-for-feedback)), elsewhere between steps. A heartbeat, a
    post, a span, a hand-off — or the board's own push, PR or preview event — refreshes the ticket's
    lease, and the lease lasts ten minutes. Within it the ticket reads **Working**. Needs you is the
    human's turn: an open span never puts a ticket there.
  - The four states: **Waiting on you** (a `human` wait, an undecided decision card, or a blocked
    task that is the ticket's next step — or a lane's own next step, rolled up), **Working** (a span
    open and a live lease or a young span; nothing open, a live lease and silence inside
    `stallMinutes`), **Lost contact** (the lease ran out with a span still open: the agent is gone,
    which is not Waiting on you and not Stalled) and **Stalled** (nothing open, silence past the
    project's `stallMinutes`, 30 by default; the silence decides before the lease does, so a
    threshold under ten minutes takes effect at once). An open span alone never keeps a dead run
    reading as Working: Lost contact shows within the lease.
  - **Beat during long calls without remembering.** Save the beater from
    `{{BOARD_URL}}/api/agent-setup/board-beat` as `board-beat.mjs` and run it around the heavy
    commands, or wire it as an OpenCode plugin's tool-start/tool-end hook:
    `node board-beat.mjs --project <id> --ticket <id> -- pnpm exec playwright test …` beats when the
    tool starts, every two minutes while it runs and once when it ends (`BOARD_URL` and
    `BOARD_TOKEN` are its environment; `--once` posts a single beat for a hook). Reliance on a
    heartbeat you must remember fails exactly when a phase runs long, so let the runtime beat.
  - `start_span` when a phase starts (`spec`, `build`, `review` with its `round`, `verify`, `pr`,
    `preview`, `merge`) and `end_span` when it is done.
  - `start_wait` with the reason when you cannot go on (`lock`, `builder`, `mcp`, `human`, `other`
    with a `note`), and `end_wait` as soon as you can. A wait counts as waiting only while no span
    is open on the ticket: your wait on a sub-agent whose span runs reads as working. A `human` wait
    counts as blocked on the human, span or not. When you wait on an agent you briefed, pass `on`:
    the agent the work was handed to (its full name, such as `orch/builder-1`). A wait with `on` is
    delegated work and counts as working, not waiting; `on` is 1 to 60 characters.
  - `handoff` when you brief a sub-agent and when it hands back ([Delegating](#delegating)).
    `get_ticket` → `work.open` lists your open spans and waits to close.
- **The board is part of the work**, not a report on it: post as you go, `set_task_done` each step,
  close your spans and waits, and rewrite the summary when you stop or hand off. You are not
  finished while the board is behind what you did. If you stop a ticket before the end, at the
  human's word or your own, record on the ticket that it was stopped and why (a `comment` and a line
  in the summary), so the next reader can tell a stop from a failure. When the work ends, clean up
  what you started: processes, temporary files, locks, and any scratch worktree of your own. A
  ticket's worktrees and origin branches are the human's: list them and never delete them.
- A step that needs the human (a credential, a manual action, a call only they can make): tag
  that task or subtask blocked, `update_task` with `blocked: true` and `blockedReason` saying what
  they must do (or `{text, blocked, blockedReason}` items on `add_tasks`), and keep working on the
  rest. It shows on the task and the ticket page; the ticket's card and the human's Needs you
  (`get_summary` → `needsYou.blockedTasks`) show it only while it is the ticket's next step to work
  (the first open task with no open subtask; a lane's own next step counts for its parent too) —
  `blockedNext` on the ticket says whether one of them is, while `blockedTasks` stays the full count
  of blocked steps. It still counts as open and does not move the ticket. A blocked step further
  down the order surfaces once the steps before it are done.
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
- Tag every ticket too with the module it touches, a short name (`Auth`, `Board`, `MCP`). Check
  `get_project`'s `tagSuggestions` and `usedTags` (or the tags `list_tickets` returns) first and
  reuse an existing tag in its casing rather than a new spelling. `set_tag_suggestions`
  (`projectId`, `tags`) replaces the project's suggestions, when the human asks or to add a module
  its tickets keep touching.
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
  and restores. You may ask: `request_archive` with one ticket id or a list posts the human one
  decision card ("Archive #12, #15?", Archive / Keep) on the first ticket, without blocking it, and
  it shows in their Needs you. Each ticket must be top-level, in a done or cancelled stage and not
  archived yet, or the whole request is refused with each failing ticket and why. Only the human's
  Archive answer archives them (in their name, lanes included; or yours relayed with
  `answer_decision` after asking them in the chat); Keep leaves them. The card is never edited:
  ask again instead. Never try to archive any
  other way.
- Repos: only the human adds, changes and removes them, on each project's Repositories page (an orchestrator also moves one to another
  project). When the work needs a repo the project
  lacks (a new repository you are building), `add_repo` with your ticket, the repo's name, its
  checkout's absolute path, its GitHub `owner/name` (what `git remote get-url origin` points at)
  and its base branch posts the human one Add / Don't add card on that ticket, without blocking
  it; it is checked first (a git checkout whose origin is that GitHub repo, a name and a path no
  repo has yet), and the error says what failed. Only their Add adds it, to that ticket's project.
  Then `set_ticket_repo` moves your ticket onto it (any repo of the ticket's own project, at once).
- `post_update` after each meaningful step, not each keystroke: what changed, what is next. It
  is a post marked as progress; `edit_post` / `delete_post` change what you posted.
  Attach evidence with `files` as absolute paths (screenshots, recordings, logs); Windows paths are
  fine, the board reads them through `/mnt/c/…`.
- **Where posts go.** A ticket's feed has two tabs, and the board puts each post in one (`tab`):
  - **Agents**, your working record: progress posts, anything posted `as` one of the project's
    agents (spec, builder, runner, the review phases).
  - **Main**, the human's: their posts with your replies under them, decision cards, your
    questions to them (`comment` on the ticket, not progress), and the summary on top.

  Keep Main short and to the point: the human reads it, the working record stays in Agents.
  `tab` on `post_update`, `comment` or `ask_decision` overrides the default; `edit_post` with
  `tab` moves a post. A lane's posts go to its parent's tabs the same way.

- **The summary** (`set_ticket_summary`): the one post at the top of Main, for the human. What the
  change does, where it stands now, each review round's verdict in one line, the PR, the preview
  and what to try there, and the proofs (screenshots, recordings) in `files`. Rewrite it to the
  current state whenever that changes, never a new hand-off post: each write is a new version
  (the board keeps every earlier one behind "history", `get_ticket_summary`) and reaches the human
  like a new post. A new version replaces the previous one in wording, never in facts: carry
  forward every section and fact that still holds (what the change does, where it stands, each
  review round's verdict, the PR, the preview and what to try there, how it was tested); keep the
  latest screenshots and recordings in `files`, and older proofs while they still show the current
  state, never dropping the proofs for a section that still stands. Add what changed this time
  (`change`, one line, required from the second version on); do not delete the rest. If a fact no
  longer holds, say what replaced it rather than silently removing the line. Until one is written,
  the newest agent progress post stands in for it.
- **Answering the human's post:** reply under it (`comment` with `replyTo` = its id), never with a
  new top-level post: first a reply with your plan, then, once done, a reply with the result and
  its proofs. A reply brings their post back to the top of Main.
- **Previews:** when the change can be tried (a page, an API), give the human a preview and put
  its link with what to try in the summary; say that what they post there stays in the copy. Keep
  it running while the ticket is in `review`.
  - A repo with runs (configured per repo, by the human in the project's settings or by you with
    `add_run` / `update_run` / `delete_run`: previews with a link, jobs without; a checkout of the
    board has its `Preview`): the board runs them. `add_workspace` with your worktree's `path` and
    `branch` (a worktree next to the main checkout, `../<repo>-<branch>`; `repoId` for a repo other
    than the ticket's primary), then `list_runs` and `start_run` by name (`all: true` for every
    run). It returns at once; `list_runs` shows each run (`building`, `starting`, `running` with its
    `url`, or `failed` with the last log lines and the log paths). `start_run` takes a run's name,
    never a command: what runs is the run's stored config. A repo that lacks the run you need:
    `add_run` it (its `repoId`, name, type and commands), or fix one with `update_run` and drop one
    with `delete_run` (it stops first); each change is in the project's activity under your name. Do
    not run `pnpm dev` in your session for it: that dies with your session. `start_run` with
    `restart: true` rebuilds after more commits; `stop_run` stops it, and the board stops it by
    itself once the PR is merged or the ticket is done, cancelled, archived or its workspace
    removed. `start_preview` / `stop_preview` still act on the first preview run. The human's
    preview limit (8 by default) caps how many runs the board runs at once; a start beyond it is
    refused with the limit.
    A running preview also has a `proxyUrl`: `/p/<workspaceId>/<runId>/` on the board's own origin
    (the human's `remoteUrl`, when set, is the same path on the tailnet name). Open it, and screenshot
    it, with your token in a header, not in a URL: a headless browser (Playwright) sends
    `Authorization: Bearer <token>` as its context's extra HTTP headers, from your environment; then
    `goto` the board's origin plus that path, and the page, its assets, API calls and event stream load
    through the board. Attach the screenshot to your summary. A browser that cannot send headers takes
    a link from `preview_link` (REST `POST /api/workspaces/:id/preview/link`): its `url` works for anyone
    who holds it for five minutes (send it only to the person meant to open it) and sets a cookie for the
    preview's path, good for 15 minutes. Another project's token gets 403
    there. Being in the cloud does not block the Preview task: a running preview ticks it.
  - A repo with no runs: start your branch from your worktree on a free port, with a copy of the data
    rather than the real one (the project's `instructions` say how), then `set_preview` with the
    `workspaceId` and `previewUrl` once it answers (or `previewUrl` on `add_workspace` when it
    already runs). The ticket page then shows it on its Runs card with an Open button and whether
    it is running. Stop it once it is merged or dropped, and clear it with `set_preview` and
    `previewUrl: ""` (`remove_workspace` drops it too). Never run it from the checkout or port
    the human uses day to day. The human may stop it from the Previews page when it listens on
    loopback and runs from the workspace's worktree; its link stays, as not running.
- Questions are posts too: `comment` on the ticket; the human answers with a post or a reply
  under yours (`comment` on the post, `parentType: update`, replies there). A choice between clear
  options (an approach, a trade-off, a scope call) is an `ask_decision` instead: the question with
  the context, 2 to 5 options (a label, what it means, at most one `recommended`). The ticket
  blocks until the human picks one; the answer comes as a reply under the card. If the human
  answers the card in the chat instead, the session that talks to the human asks them there first
  (AskUserQuestion in Claude Code, or the client's equivalent, with the card's options), then
  `answer_decision` records their answer on the card: the option's index and their words as they
  gave them. Only that session does it, never a subagent, never with `as`, never unattended. A
  relay is refused on a card already decided, by the human or an earlier relay: the human changes
  it on the card. If you cannot go on
  without the answer, also `update_ticket` → `status: blocked`, and back to `in_progress` once it
  is answered. When only one step waits on the human, tag that task blocked instead and go on. On resuming, and between steps, `list_my_threads` shows what is waiting on you.
- Files the human attaches (screenshots on a post or reply) come with `path` (and
  `windowsPath` when the board runs in WSL): open that file directly. `get_attachment` looks one
  up by id. To find a file again, `list_gallery` lists the project's files (posts, replies under
  them, instructions), filtered by `type` and the upload days `from`/`to`, newest first or by `sort` (`oldest`,
  `name`, `name-desc`, `largest`, `smallest`, `type`), a page at a time (`next` back as `cursor`), each with its ticket and the post or reply it came with.

### Delegating

Every spawned agent and lane costs time: hand out only what is new, and only what is worth it.

- Before starting or delegating anything, check what is already done or in flight: the ticket's
  lanes with their status, and its posts (`get_ticket`), its workspaces (`get_ticket_git`), and
  `list_review_results` for the branch's head SHA. Do not start or hand out what is already there.
- A lookup of one or two calls (a grep, a file read, one board call) you do yourself; do not spawn
  an agent for it.
- A brief carries the ticket's context, not just its title: `get_ticket` first, then put in the
  brief its instructions (the body), the human's posts and replies in full (the Main tab's threads,
  `list_comments` on each post), the decisions with their answers, and the attachments (their local
  `path`s). Say the subagent may read the rest itself with `get_ticket` and `list_comments`.
- Every brief you hand another agent (a subagent's prompt, a lane's `create_ticket` `body`, a
  project agent's run under [Orchestrating](#orchestrating-the-projects-agents)) has five parts:
  1. Goal: what to achieve.
  2. Focus: the files or dirs to read first, and what to leave alone.
  3. Known: facts already established that it must not re-derive: commands, ports, paths,
     earlier results.
  4. Done when: the condition to stop at.
  5. Return: the exact shape of the answer.
- Name every subagent on the board: its brief says to pass `agentName: "<your whoami name>/<its
name>"` (e.g. `orch/builder-1`) on every board tool call, so what it posts is filed under it, a
  worker with you as its parent, instead of under you. A worker session started on its own sends
  the header `X-Agent-Name: <token name>/<its name>` instead (over REST the token name is `actor`
  in `GET /api/me`; there is no `token` field there), or gets a worker token of its own.
- A subagent never answers a decision (`answer_decision`), and one that passes `agentName` is
  refused. If its work needs the human's answer, it asks (`ask_decision`) or returns the question in
  its result; you ask the human in the chat and answer the card yourself.
- Put the hand-off on the ticket's timeline: `handoff` with `to` the sub-agent's name (its full
  `agentName`, e.g. `orch/builder-1`, so the timeline matches its posts; it need not be a project agent) when you brief it, and `from` that name when it returns. A sub-agent
  that cannot reach the board has you record its spans, with `agent` its name. Put the work timeline
  in its brief too: the `projectId` and `ticketId`, a `heartbeat` every few minutes, `start_span` /
  `end_span` around its phase, `start_wait` / `end_wait` with the reason while it waits (a lock,
  the builder, the MCP server down).

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

Before `update_ticket` → `status: review`, every item, in order (the board ticks Pushed, PR, CI,
Preview, Summary and Merged as their facts hold; Implementation and its steps are ticked by hand):

1. Worktree registered (`add_workspace`), Implementation and its steps ticked.
2. Checks green locally, on what the change touches: the typecheck of the whole project (it
   cannot be scoped soundly); lint and the formatter on the changed files only; only the unit
   tests related to the changed files (e.g. `vitest related <files> --run`,
   `jest --findRelatedTests <files>`, the `pytest` files that test them); only the end-to-end spec
   files covering the changed pages or server routes (e.g. `playwright test <spec files>`), none
   when the diff touches neither. The project instructions say which commands. The full suite runs
   in CI: its checks green on the head are still required (`checks_unknown`, below), and a
   failure CI finds after the push is fixed like a local one. A repo with no CI that runs the full
   suite on pull requests keeps the full local run: all its checks, and its end-to-end tests when
   it has them (e.g. `pnpm test:e2e`).
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
   `needs` is the enforced rule; the review column's order is the merge order the agents propose,
   read top to bottom (top merges first). Moving your ticket to review, place it with
   `update_ticket` → `position` (1 is the top of its stage's column; with `status`, in the new
   stage): below every open ticket it `needs`, otherwise where it should merge relative to the
   others. The board flags a card placed above a ticket it needs ("merge after #<id>"). Any move
   to another stage clears the place, and edits never move it.
5. PR open, assigned to the human, `prNumber` set: `gh pr create --assignee <their login>`, or
   `--assignee @me` when you push with their account (GitHub never lets a PR's author be its
   requested reviewer; the PR queue lists the human's own PRs under Waiting on others). Then
   `update_ticket` with the PR's `prNumber`: the PR queue shows this ticket on the PR's card, and
   `get_ticket` the PR with its latest review. A PR ticket the board made for that PR is cancelled,
   with a post, and this ticket takes the PR over. (A PR on the ticket's branch links by itself.)
   While GitHub's checks do not run, comment on the PR `CI run locally: green on <sha>` with the
   head commit the checks of item 2 passed on (`gh pr comment`): that ticks CI. Comment again after
   each push.
6. **Preview running**: `start_run` (or `start_preview`), then `list_runs` until it is `running`
   (`failed`: read the log lines and fix). For a repo with no runs configured, start one the
   project's way and `set_preview` (see Previews in
   [While working](#3-while-working)). Required whenever the change can be tried; when it cannot
   (docs only, a script), say why in the summary.
7. The summary, up to date (`set_ticket_summary`, never a new hand-off post): the PR link, **the
   preview link and what to try there**, how it was tested, the e2e result (its summary, or its
   report when something failed), each review round's verdict and, for a UI change, the latest
   screenshots of what changed, in `files`. A new version replaces the previous one in wording,
   never in facts: carry forward every section and fact that still holds (what the change does,
   where it stands, each review round's verdict, the PR, the preview and what to try there, how it
   was tested); keep the latest screenshots and recordings in `files`, and older proofs while they
   still show the current state, never dropping the proofs for a section that still stands. Add
   what changed this time (`change`, one line); do not delete the rest. If a fact no longer holds,
   say what replaced it rather than silently removing the line. It is the ticket's one state card:
   the end of a session updates it rather than leaving a separate note.

`update_ticket` → `review` then answers with `open`: every task and subtask still open, the
ticket's and its lanes' that are not cancelled, in tree order, each `{taskId, ticketId, text, auto}`.
Merged is left out: merging is the human's. `auto: true` marks a phase the board ticks from its fact
(Pushed, PR, CI, Preview, Summary): settle it by making the fact hold (push, open the PR, get CI
green, start the preview, rewrite the summary after your last commit), never by a tick. The move goes
through anyway: fix each one; `open: []` means nothing is left. `get_ticket` returns the same `open`
while the ticket is in review, and its page shows them on the Tasks card.

After that:

1. `done` is the human's call unless the project instructions say otherwise.
2. A ticket with lanes goes to `review` once its lanes are in `review`, `done` or `cancelled`; the
   board flags a ticket that is further along than its lanes. Say in the summary which lanes it
   covers.
3. Dropping work: `status: cancelled`, with a comment saying why. Cancelled lanes' tasks leave the
   parent's progress.
4. Clean up your lane before it goes to `done` (or when the human moves it there): see
   [Clean up](#6-clean-up) for the rule. A ticket in `review` keeps its branch and worktree.

## 5. End of session

1. **The summary up to date.** For every ticket and lane you leave in `in_progress`, `blocked` or
   `review`, `set_ticket_summary` with where it stands, what is next and how to resume (branch,
   worktree, commands, preview, gotchas), concretely enough that another agent can continue without
   asking. It is the ticket's one current state card, rewritten to the current state (`change` says
   in one line what changed); the board keeps every earlier version.

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

- What you started goes too: stop the processes you or your agents started (previews, dev servers,
  test boards, watchers), remove your temporary files and folders, and release any test lock you
  hold. The review's own scratch worktree under `~/.claude/feature-review/` may go; the ticket's
  worktrees and origin branches stay the human's, listed below.

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
- Deleting a branch: `git branch -d|-D <name>` once no worktree holds it, then **one**
  `post_update` on the ticket listing every deleted branch with its commit hash, as `branch @ sha`
  (e.g. `lane/47 @ 9ec12e8b`). That line is the only way back: `git branch lane/47 9ec12e8b`
  restores it.
- Worktrees: do not remove them. Leave each, and the workspaces registered at it, to the human, who
  removes it from the board's Cleanup page with the branch it holds (the board removes each link in
  it first, the link alone).
- A closed ticket's (done, cancelled or archived) landed local branches: `cleanup_delete` deletes
  them, items as `cleanup_report` gives them (`kind` `local`, the `sha` it shows). The board checks
  each one again first, as for the human (landed, not protected, not moved since, held by no
  worktree) and answers each with its `restore` command; post those `branch @ sha` lines as above.
  It takes no worktree and no branch on origin.
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
   it, the `untracked` worktrees, and what is left for the human: the worktrees (with the branches
   they hold) and the origin branches, which they remove and delete from the board's Cleanup page.
5. Wait for the human's approval (all, a group, or named rows). Then, per ticket: `cleanup_delete`
   the approved local branches that no worktree holds (`kind` `local`), and `remove_workspace` each
   of its workspaces that is no worktree; the board checks each branch again, and what it refuses
   stays, with its reason. Worktrees, and the branches they hold, stay for the human to remove from
   the board's Cleanup page: list them. Then `post_update` on the ticket with the deleted
   `branch @ sha` lines. Finish with a short summary: what was removed, what is left and why.

Nothing here touches a ticket in any other stage, even when its branch looks merged.

## The project's agents

`get_project` → `agents`: personas the human defined for this project, each with a `name`,
`instructions` and a picture. They are not connected tools; you work for them.

- A ticket assigned to one is reserved for it (`reserved: true`; `get_ticket` → `agent` has its
  instructions). `claim_ticket` with `as: <its name>`, brief a subagent with the agent's
  instructions plus the ticket's, and post its work with `post_update` and `comment` using
  `as: <its name>`: it shows under the agent's name, via you, in the Agents tab. What the human
  must read goes in the summary (`set_ticket_summary`, `as` too) or in a reply under their post.
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

The project's Team page adds a default set, the build and review cycle of the
`/feature-review` and `/review-queue` skills (installed from the same page): **spec** (acceptance
criteria) → **builder** (the code) → **runner** (a `/feature-review` of the branch, whose phases
**env**, **verify**, **hunt**, **refute** and **merge** try to break it) → (a fix pass by the
**builder** on the confirmed findings, each with the project's checks and a new review, for as many
review rounds as the ticket's complexity allows: none for low, one for mid, three for high, up to ten
for max (for work built from scratch: a whole site or app, a new product or standalone service; a
feature in an existing codebase is at most high, however difficult); round 1 is the first build and
its review, so a mid ticket stops after its review, and a review that does not survive after the last
round goes to a human decision; a high ticket gets two fix passes and a max ticket nine; a low ticket
has no review, and its checks return the build at most twice; after the second return, when the checks
still fail or a criterion still has no evidence, the human decides (keep going or drop), and the build goes
to hand-off only with evidence for every criterion) → hand off. The agents' thinking effort follows the complexity too: `low` for a low ticket, `medium` for mid and
high, `high` for max; the orchestrator passes it as the Agent tool's `effort` on every agent it starts for the ticket
(the ticket agent, the spec agent, the builder and the review's phase agents). `/todo-review` is that
orchestrator for
the To do tickets: one agent per ticket runs the cycle, checks the proof itself (criteria seen
working, no weakened tests, screenshots) and blocks only for what only the human can give.
`/review-queue` reviews the board's PR queue (with `build`, it runs `/todo-review` after).
Without those skills, or for one ticket, orchestrate by hand:

1. `get_project`: read every agent's `delegation` (your routing table) and `instructions` (its
   brief). Claim the ticket (with `as` when it is reserved), open its worktree, `add_workspace`.
2. Per step: pick the agent whose notes match where the ticket is; run it as a subagent whose
   prompt is its `instructions`, the project's `instructions`, the ticket's context (`get_ticket`:
   its instructions, the human's posts and replies, the decisions and their answers, the attachments;
   the subagent may read the rest itself) and a brief in the five parts of
   [Delegating](#delegating): the step's goal from the ticket (`get_ticket`), its focus, what is
   known (the worktree and branch, what earlier steps returned, the `agentName` it passes on every
   board call: subagents share nothing else),
   done when (with the checklist from [Hand off](#4-hand-off), as it stands) and what to return;
   post what it returns on the ticket **as that agent** (`post_update` with `as`, `progress: true`,
   its evidence in `files`: it goes to the Agents tab); when it changes where the ticket stands for
   the human (a review round's verdict, the PR, the preview), rewrite the summary; tick the tasks
   it finished; go where its notes say next.
3. A call that is the human's (two valid behaviours, a finding that keeps coming back, ship as is
   or not) → `ask_decision`. In a session with the human, ask them in the chat as well, with the
   card's options (AskUserQuestion in Claude Code, or the client's equivalent); once they answer
   there, `answer_decision` records it on the card with their words, and work on something else
   until then. An unattended run has no human to ask: it leaves the card open and skips the
   ticket, and never answers a decision.
4. Hand off as in [Hand off](#4-hand-off), with the last review's summary as the PR's tests. Check
   every item of the checklist yourself before moving the ticket to `review` (`get_ticket`: `push`,
   `pr`, the workspace's `managedPreview` `running`, the `summary` up to date): a subagent saying it is
   done is not enough.

Never two builders on one branch; when no agent's notes fit a step, ask in a post rather than
doing it yourself.

## Reviews and the PR queue

`list_prs` is the human's PR queue: PRs by others that the human reviews (`waitingOn: me`) and the
human's own (`waitingOn: others`; agents' PRs pushed with their account are theirs on GitHub), open
or merged in the last two weeks. `status` is where the reviews stand: `pending` (approval missing),
`reviewed` (approved: by the human on others' PRs, by every reviewer on theirs), `on_hold` (review
comments or requested changes not yet addressed by a push or a new review request, or a board-side
hold) or `done` (merged). Each PR lists `ticket`, the ticket its card opens: the feature ticket that
names the PR, else the PR's own ticket, which the board made when the PR first showed in the queue.
It also lists `tickets`, the feature tickets it came from, and its `merge` and `ci` state:
conflicts or failed `checks` on a PR from your ticket are yours to fix. A PR's findings and progress
are posted on its `ticket`, not on a daily ticket; the board moves a PR's own ticket with the PR's
status (To do, In review, Blocked, Done when merged, Cancelled when closed without merging), and the
human archives it. Before reviewing a PR, `list_review_results` with its `prNumber` and head `sha`:
if that SHA was already reviewed, `get_review_result` has the findings. If you review a PR, record
it with `post_review_result` (verdict, markdown summary with findings, how to test, checks, `repoId`
when the project has several repos): the human reads it from its verdict on the PR queue and on the
ticket's Branch card, and the summary is also a progress post on the PR's ticket. Never post the
review to GitHub.

`list_actors` gives every name that signs in to the board, with its `role` (human, orchestrator,
worker) and `parent` (the name a sub-identity works under); the project's agents are in
`get_project`. Use those exact names for `assignee`.

## Notifications: tracked requests and important notices

The top bar's notification center is **not** a place to report your work: the work timeline,
heartbeats, spans, progress posts and the ticket summary already cover that.

- **A tracked card only when the human explicitly asked** to see the progress of, or to be told
  about the completion of, one named thing: "show me progress", "let me know when", "notify me
  when", "tell me once it is ready". One request, one card, about the thing they named.
  `start_tracked_request` takes the human's request itself (`request`, required: a call without it
  is refused), `tracked_request_progress` moves it, and `finish_tracked_request` ends it succeeded
  with a one-line result or failed with the reason.
- **A notice only for something very important the human must know** and would otherwise miss:
  data lost or at risk, production or the host broken, a secret exposed, the wrong thing done and
  needing undo, a deadline missed. `post_notice` takes the reason it cannot wait (`reason`,
  required: a notice without it is refused). It has no progress and no state to update afterwards.
- **Never** for routine work: never to start a ticket, never to run tests in normal work, never for
  an unasked long build, never for a finished ticket. A question for the human is a decision or a
  wait, not a notice; when in doubt, post on the ticket.
- Cards and notices stay until the human dismisses them (`dismiss_notification`, the human's only).
  An agent sees and moves its own and its sub-identities' (`<its name>/…`), never another agent's,
  and nothing crosses projects.

## Style

Plain words, short. Titles under 80 characters. Screenshots beat paragraphs.
