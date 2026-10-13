# agent-board

A local job board shared by one developer and their AI agents (claude, codex, opencode, …).
Per project (one or more repos): the PR queue of what you review and what you opened, the features
in flight (tickets → lanes for parallel work → tasks → branches and workspaces → updates with
screenshots and recordings → threads), the PR reviews your agents record, and a day-by-day log with
the report each project asks for: one per period (each workday or each week, due at the end of the
project's shift), written by hand, by an agent or by claude from the project's prompt and template,
tracked period by period. Git and GitHub are **read-only**.

- TanStack Start (Router + Query + server routes), shadcn (base-nova), Tailwind 4
- SQLite via Drizzle in `data/board.db`; uploads in `data/uploads/`
- Identity from a local [passkey-gate](../passkey-gate): the browser's passkey session cookie,
  or a `Bearer gate_…` token for agents. The board keeps no users of its own.
- REST under `/api/*` and an MCP server at `/api/mcp` for the agents. `AGENTS.md` is what they read.

Ports are deliberately unusual so nothing collides with a project you are running:
**47100** (board) and **47110** (gate). Both are overridable in `.env`.

## First run

```powershell
# 1. the gate, once (builds ../passkey-gate; prints an enrollment link in the log)
docker compose -f docker-compose.gate.yml up -d --build
docker compose -f docker-compose.gate.yml logs gate
#    open the link, enroll your passkey. Later: /devices to mint agent tokens (name = agent name)

# 2. the board
cp .env.example .env
pnpm start             # starts the board on http://localhost:47100 (hot reload), the gate login first
```

Add a repository (path of a local checkout) and the project it belongs to, pick the project in the
top bar, and you are on. A project can hold several repos; its modules show them all together.

Agents: mint a token per agent on `http://localhost:47110/devices` and follow `AGENTS.md`
(`claude mcp add --transport http board http://localhost:47100/api/mcp --header "Authorization: Bearer gate_…"`).

## Running it from WSL (projects, git, gh and claude live there)

Keep this checkout as the source of truth and run a clone inside the distro:

```bash
# inside WSL, once
git clone /mnt/f/Programming/WebDev/agent-board ~/agent-board && cd ~/agent-board
cp .env.example .env   # set CLAUDE_BIN=$HOME/.local/bin/claude
corepack enable pnpm   # or: npm i -g pnpm
pnpm install
curl -fsSL https://claude.ai/install.sh | bash && claude   # log in once; `gh auth login` likewise
```

Repo paths are then Linux paths (`/home/you/spark-repos/spark-backend`), the board spawns
the WSL `claude`, and WSL's port 47100 is forwarded to Windows `localhost`, so the browser and the
gate cookie work unchanged. `pnpm start` inside WSL starts it; after a change here,
`git -C ~/agent-board pull` puts it live (and `pnpm start` again when dependencies or migrations changed).

## Running the board

```
pnpm start          # stop the board, install, start it in the background with hot reload, wait until it answers
pnpm start --fg     # the same in the foreground; logs to the terminal
pnpm stop           # stop it
```

There is one board, run from the main checkout with `vite dev` on the real data in `data/`, so code
saved there is live at once: `git pull` on `main` is how changes go live. A pull that changes
dependencies or adds a migration needs `pnpm start` again (migrations apply as it starts). Work on
the board itself happens in worktrees, never in the main checkout (Development, below). Logs:
`data/logs/board.out.log`, `board.err.log`.

The gate comes up with Docker Desktop at sign-in (`restart: unless-stopped`); only the board needs
starting after a reboot.

## Test mode

`BOARD_ENV` says what a running board is, and so whether it asks the gate:

| `BOARD_ENV`                | Who calls                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production` (unset too)   | The gate, always, as above. The board (`pnpm start`) always runs this way, whatever the shell says.                                                                                         |
| `development` (`pnpm dev`) | The gate, unless `AUTH=off`: then every request is the human, named `DEV_HUMAN` (by default the human the board last saw sign in, else `human`), with no login redirect.                    |
| `test` (CI, Playwright)    | Nobody asks the gate. A request says who it is with `X-Test-Actor: human:<name>` or `agent:<name>` (REST and `/api/mcp` alike); without it, it is the human `TEST_HUMAN` (default `human`). |

`agent:` callers are agents for every human-only check (403 on the project's agents, stages,
settings, archive, decisions…), so both sides can be tested. To try a branch without the gate:

```
AUTH=off pnpm dev                       # in a worktree: a preview on the first free port from 47101, with a copy of the data
$env:AUTH='off'; pnpm dev               # the same from PowerShell
BOARD_ENV=test HOST=127.0.0.1 PORT=47131 DATA_DIR=<a throwaway dir> node .output/server/index.mjs   # a build, for e2e
```

Guardrails, checked as the server starts (before it accepts a request, under `vite dev` too); any of
them stops it with a clear error and a non-zero exit:

- an unknown `BOARD_ENV`, or `AUTH` other than `on` / `off`, is refused; `AUTH=off` with
  `BOARD_ENV=production` (or unset) is refused;
- with the gate off, the board only listens on loopback (`HOST` 127.0.0.1, ::1 or localhost; the built
  server's default, every interface, is refused) and never on 47100, the live board's port;
- `X-Test-Actor` is only read in test; in production and development it changes nothing;
- `pnpm start` runs the board as production even from a shell with another `BOARD_ENV`;
- with the gate off, the server prints `AUTH OFF: <mode>, signed in as <name>, do not expose this` on
  stderr as it starts, and the top bar shows a red **test mode** / **auth off** badge (`/api/me` says
  `authOff`), so a screenshot is never taken for the live board.

## Previews

The board runs previews of its own branches for the human to try, from the worktree a ticket's
workspace registers (Start on the ticket's Preview card, `POST /api/workspaces/:id/preview/start`,
or `start_preview` over MCP). In the background it:

1. runs `pnpm install --frozen-lockfile --prefer-offline` in the worktree, only when the lockfile
   changed since the last install there, then `pnpm build`;
2. copies the live data into `<worktree>/data/preview` (the database through SQLite's backup, the
   uploads as files), fresh on every start;
3. starts the build (`node .output/server/index.mjs`) with `BOARD_ENV=development AUTH=off`,
   `HOST=127.0.0.1` and the first port from 47101 to 47199 free on both loopbacks, and sets the
   workspace's `previewUrl` once it answers.

Logs: `<worktree>/data/preview/logs/build.log` and `server.log`. The state (`building`, `starting`,
`running`, `failed` with the last log lines, `stopped`) lives in the board's memory; `previews.json` in
the data dir only remembers it across a restart. Stop kills the process tree (`taskkill /T /F` on
Windows, the process group elsewhere), clears `previewUrl` and frees the port; restart is stop, then
build again.

A preview stops by itself when the ticket's PR is merged (the PR queue's refresh notices), the
ticket moves to a done or cancelled stage or is archived, its workspace or ticket is deleted, and
when the board stops; it exits on its own within seconds of the board even when the board is killed.
Nothing is started again when the board starts; the ticket page says it was stopped when the board
restarted. The cleanup report lists previews still running for closed tickets; the project's
Previews page (`GET /api/projects/:id/previews`) lists every preview of its tickets, running or not.

Only a git worktree of the ticket's repo that sits next to its main checkout
(`../agent-board-<branch>`) and is a checkout of the board is run, never the main checkout or the
board's own folder; one preview per workspace and per worktree. A preview board (development) does
not start previews of its own.

**The preview limit.** The board builds or runs at most as many previews at once, across every
project, as the human's preview limit (`previewLimit` in `/api/settings`, 1 to 32, 8 by default; set on
the Previews page or on Settings). A start beyond it, from the page, REST or `start_preview`, is
refused with a 409 that names the limit. Lowering it stops nothing; restarting a preview that runs is
allowed at or over it (it adds none), restarting one that does not is a start.

**Stopping a link.** A link an agent registered for a server it started itself (`pnpm dev` in its
worktree) can be stopped from the Previews page (human only), when the board can tell the server is
that worktree's: the link is on loopback, on a port that is neither the board's nor a preview the
board runs; the workspace's path is a git worktree of the ticket's repo next to its main checkout
(not the main checkout or the board's folder); and every process listening on the port (`netstat -ano`
on Windows, `ss -ltnp` or `lsof` elsewhere) runs from inside that worktree: its executable, an
argument that is a path (Windows, Linux), or its working directory (Linux, macOS) is the worktree or
under it, `..` resolved, case aside on Windows. The board then kills each with its process tree (`taskkill /T /F`, or
its descendants elsewhere), answers once the port is free (`freed`), keeps the link (the row moves to
Not running) and logs it on the ticket. Otherwise the row says why it is not stopped, and the stop
looks again when asked. **Stop all** stops the project's previews the board runs and the links it may
stop; links off this machine or that nothing listens on are left out, the rest are skipped with why.
A preview board (development) stops no link: it runs on a copy of the live data, so its links point at
servers that really run. Its Stop is refused, its rows say why, and Stop all skips them.

## Storing files in MinIO

Attachments (screenshots, recordings, files on posts and instructions, agent pictures) live in
`data/uploads` by default. To keep them in MinIO, or any S3-compatible store, instead:

```powershell
docker compose -f docker-compose.minio.yml up -d   # the board's own MinIO, loopback only (API 47120, console 47121)
```

```
# .env
STORAGE=s3
S3_ENDPOINT=http://127.0.0.1:47120
S3_BUCKET=agent-board
S3_ACCESS_KEY=agent-board
S3_SECRET_KEY=<a long secret; the compose file uses it as MinIO's root password>
```

Then `pnpm move-uploads` copies the existing files into the bucket under the same keys, checking each
one (it skips those already there, so it can run again; `--delete-local` removes each checked local
file, `--dry-run` only says what it would do), and `pnpm start` puts the board on the bucket. The
board creates the bucket on first use.

The bucket stays private: the browser gets files from the board, which streams them from MinIO
(Range requests included, so videos seek). Agents still get a file on this machine to open: new files
are written through to `data/cache`, and any file an agent is handed (MCP, or REST with a token) is
fetched there first if it has gone; copies nobody opened for 30 days leave the cache. While MinIO is
down, uploads fail with a clear error and cached files still open.

## Cleanup

A project's Cleanup page (MCP `cleanup_report`) lists what its finished tickets left behind:
registered workspaces, local and origin branches and worktrees, each branch checked against where its
work should have landed. The board never deletes those; agents do with the human's go-ahead.

It also counts the board's **unattached uploads**: files no post, reply, ticket or agent picture
holds and no text links to (`/api/uploads/<id>`), such as images added to a New ticket window that was
closed without creating, or a file removed from a post before sending. The board deletes those once
they are a day old, every hour in the background (the file from disk or the bucket, its cached copy,
then the row; a file the store cannot delete keeps its row for the next run). Younger files are never
touched: they may be an upload about to be attached. **Delete now** on the Cleanup page runs it at
once. A `pnpm dev` copy on `STORAGE=s3` shares the bucket with the live board, so it deletes nothing.

## Reviews

An agent that reviews a PR records it with `post_review_result` (REST:
`POST /api/projects/:id/reviews/results`): verdict, markdown summary with findings, checks.
The latest verdict shows on the PR's row in the PR queue and on its ticket's Branch card; clicking
it opens the result in full (verdict, SHA, checks, counts, summary) with its own thread. Old
`/projects/:id/reviews?result=` links land on the PR queue with that result open. Nothing is posted
to GitHub.

## REST API

All routes need the gate cookie or `Authorization: Bearer gate_…`; JSON in and out. `actor` is
the gate device or token name.

| Method       | Path                                                                                                          |                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET          | `/api/me`                                                                                                     | who you are `{actor, agent, boardEnv, authOff}`; `authOff` outside production only (see Test mode)                                                                                                                                                                                                        |
| GET          | `/api/agent-setup` · `/api/agent-setup/skill?client=claude\|codex\|opencode`                                  | board and gate URLs for the Connect agents page · the board skill as a SKILL.md with today's projects and repos                                                                                                                                                                                           |
| GET          | `/api/agent-setup/review-skills` · `?list`                                                                    | the feature-review, review-queue and todo-review skills with their agents, as a tar to extract into `~/.claude` · the paths it holds                                                                                                                                                                      |
| GET/PATCH    | `/api/settings` `{defaultAgent, previewLimit}`                                                                | board-wide preferences (PATCH is the human's only); `previewLimit`: how many previews the board runs at once, 1 to 32, 8 by default                                                                                                                                                                       |
| GET/POST     | `/api/projects` · GET/PATCH/DELETE `/api/projects/:id`                                                        | projects with their `repos[]`, `stages[]` and `agents[]`; `instructions` is the agents' briefing                                                                                                                                                                                                          |
| GET/POST     | `/api/projects/:id/agents` · PATCH/DELETE `/api/agents/:id`                                                   | the project's agents `{name, instructions, delegation, avatarId}` (writes are the human's); a ticket assigned to one is reserved                                                                                                                                                                          |
| POST         | `/api/projects/:id/agents/defaults`                                                                           | adds the default agents the project lacks (spec, builder, runner, env, verify, hunt, refute, merge), each with instructions and delegation notes; the human's                                                                                                                                             |
| GET/POST     | `/api/projects/:id/stages` · PATCH/DELETE `/api/projects/:id/stages/:stageId`                                 | board columns `{name, kind, color}`; DELETE takes `?moveTo=<key>` when it has tickets (`&force=1` into a done stage past needs not merged)                                                                                                                                                                |
| PUT          | `/api/projects/:id/stages/order` `{ids[]}`                                                                    | reorder the stages (every id, once); stage writes are the human's only                                                                                                                                                                                                                                    |
| GET/POST     | `/api/repos` · PATCH/DELETE `/api/repos/:id` · GET `/api/repos/:id/branches`                                  | checkouts; POST takes `projectId` or `projectName`, PATCH `projectId` moves it                                                                                                                                                                                                                            |
| GET          | `/api/projects/:id/prs?refresh=1`                                                                             | PR queue, open and merged in the last 14 days (`waitingOn` me: others' PRs you review, others: yours; `status` pending/reviewed/on_hold/done by the reviews; `merge`, `mergeCheck`, `ci` + `checks[]`, `latestReview`, `tickets[]` it came from, `mergeAfter[]`: open PRs its tickets need merged first)  |
| PATCH        | `/api/prs/:id` `{hold, holdNote}`                                                                             | park / release                                                                                                                                                                                                                                                                                            |
| GET/POST     | `/api/projects/:id/tickets` · GET/PATCH/DELETE `/api/tickets/:id`                                             | tickets (`tasks[]`, `attachmentIds[]` on create; `repoId` when the project has several repos)                                                                                                                                                                                                             |
|              | `?parent=root\|<id>` on the list · `parentId` on create                                                       | lanes: a ticket's parallel sub-tickets, nested to any depth                                                                                                                                                                                                                                               |
|              | `?lanes=1` on GET · `?keepLanes=1` on DELETE                                                                  | lanes' updates in the feed · move lanes up a level instead of deleting them                                                                                                                                                                                                                               |
|              | `needs[]` on create and PATCH · `force` on PATCH                                                              | the tickets whose branches must be merged into its base first (same project, no cycles); GET returns `needs[]` with `merged` and `neededBy[]`, the list `needs[]`. A move to a done stage is a 409 (`code: needs`) while one is not merged; `force: true` (the human's only) marks it done anyway, logged |
|              | `resume` on GET `/api/tickets/:id` · on list rows                                                             | the resume note with `at`, `by`, `sha`, `commitsSince`, `stale`, `noHandoff`, `day` · rows: `at`, `stale`, `noHandoff`, `day`                                                                                                                                                                             |
|              | `handoff` on PATCH to a review stage · on GET in one                                                          | what the hand-off still lacks, as warnings (the move goes through): `{missing: [{code, text}], checks: [{code, label, ok, text}]}`; codes `no_pr`, `not_pushed`, `no_preview`, `no_handoff_post`, `checks_unknown` (the PR's CI failing or running); `checks` starts with `not_merged`, never missing     |
| GET          | `/api/projects/:id/tickets?status=todo,blocked&assignee=&q=&tag=&parent=&archived=`                           | filters (`status` takes stage keys, names or kinds; `assignee=` empty for unassigned; `parent=root` for top level; `archived=include` or `only`)                                                                                                                                                          |
| POST         | `/api/tickets/:id/archive` · `/restore` · `/api/projects/:id/tickets/archive` `{status}`                      | archive a done or cancelled top-level ticket, its lanes with it · put it back · archive a whole done or cancelled stage (the human's)                                                                                                                                                                     |
| POST         | `/api/tickets/:id/claim` `{branch?, as?}`                                                                     | assign to the caller (or the project agent it works as) and start it, returning it with `resume`; 409 if reserved for another agent                                                                                                                                                                       |
| PUT          | `/api/tickets/:id/resume` `{note, as?}`                                                                       | the resume note, "Where we left off" (human or agents; `as` agents only); each version is also a handoff post                                                                                                                                                                                             |
| GET          | `/api/tickets/:id/git`                                                                                        | branch + workspaces, live from git, each with `reach` (merged/rebased/edited/unique vs its base chain) and `push`; `includes[]`: open tickets whose unmerged work its branch holds                                                                                                                        |
| GET/POST     | `/api/projects/:id/push` · `/api/projects/:id/push/refresh`                                                   | whether each ticket in work has its branch on origin (`push`: below), one batch of git per repo · fetch origin now, then the same                                                                                                                                                                         |
| GET          | `/api/projects/:id/cleanup?reach=0`                                                                           | closed tickets still holding workspaces, branches, worktrees or running previews; `reach=0` skips the merge checks; `uploads` counts the unattached ones                                                                                                                                                  |
| GET          | `/api/projects/:id/previews`                                                                                  | its tickets' previews (archived aside), running first: `{previews: [{workspace, ticket, url, check, managed, cannotStart, linkStop, running}], inUse, limit}`; `check`: the link answers (null off this machine); `linkStop`: why its server is not stoppable, null if it is; reads only                  |
| POST         | `/api/projects/:id/previews/stop`                                                                             | Stop all, humans only: the previews the board runs and the links it may stop (see Previews): `{stopped: [{workspaceId, ticketId, kind, port, pids?, freed?}], skipped: [{workspaceId, ticketId, reason}]}`                                                                                                |
| DELETE       | `/api/uploads/unattached`                                                                                     | delete the unattached uploads older than a day now `{deleted, bytes, failed}` (the human's)                                                                                                                                                                                                               |
| POST         | `/api/tickets/:id/tasks` `{tasks[]}` · PATCH/DELETE `/api/tasks/:id`                                          | todo list                                                                                                                                                                                                                                                                                                 |
| POST         | `/api/tickets/:id/workspaces` `{name, branch?, path?, agent?, previewUrl?}` · DELETE `/api/workspaces/:id`    | worktrees / sub-branches / subagents                                                                                                                                                                                                                                                                      |
| PATCH/GET    | `/api/workspaces/:id` `{previewUrl}` · `/api/workspaces/:id/preview`                                          | set or clear (`null`, `""`) where the branch runs for the human to try (http/https) · whether it answers: `{running, status?, checkedAt, url}`, localhost only; `managed` (the board's own preview of it) and `cannotStart` (why it would not start one, null when it would)                              |
| POST/GET     | `/api/workspaces/:id/preview/start` · `/stop` · `/restart` · GET `/preview/log?name=build\|server`            | the board builds and runs the workspace's worktree as a preview (see Previews) · stop it · stop and build again · its logs                                                                                                                                                                                |
| POST         | `/api/workspaces/:id/preview/stop-link`                                                                       | stop the server behind the link, humans only, when it runs from the workspace's worktree (see Previews): `{workspaceId, ticketId, kind: 'link', port, pids, freed}`; 400 or 409 with why otherwise                                                                                                        |
| POST         | `/api/tickets/:id/updates` `{body, attachmentIds[], as?, progress?}`                                          | a post on the ticket's feed (`progress` default true); `as` posts under one of the project's agents (agents only)                                                                                                                                                                                         |
| POST/DELETE  | `/api/tickets/:id/attachments` `{attachmentIds}` · `/api/tickets/:id/attachments/:attachmentId`               | files that go with the ticket's instructions (uploads first); `GET /api/tickets/:id` lists them as `attachments`                                                                                                                                                                                          |
| POST/PUT     | `/api/tickets/:id/decisions` `{body, options[], as?, block?}` · `/api/updates/:id/decision` `{option, note?}` | ask the human to decide (2–5 options; blocks the ticket) · the human's answer (humans only; unblocks once none is open)                                                                                                                                                                                   |
| PATCH/DELETE | `/api/updates/:id` `{body?, progress?}` · `/api/comments/:id` `{body}`                                        | edit / delete a post or reply: its author, or the human                                                                                                                                                                                                                                                   |
| POST         | `/api/uploads`                                                                                                | multipart `file`, or JSON `{path}` (local file) or `{name, base64}` → `{id, url}`                                                                                                                                                                                                                         |
| GET          | `/api/uploads/:id` · `/api/uploads/:id/info`                                                                  | the file · its metadata with the local `path` (and `windowsPath` under WSL)                                                                                                                                                                                                                               |
| GET/POST     | `/api/comments?parentType=ticket\|update\|pr\|review&parentId=`                                               | on a ticket: its posts (POST adds one, not progress); else replies (`replyTo` nests; `as`, `@name` as before)                                                                                                                                                                                             |
| GET          | `/api/projects/:id/threads?since=` · `/api/projects/:id/inbox?since=`                                         | `{cursor, threads}` where someone spoke after the caller (with `since`, only newer) · `{count, cursor, threads, reportDue}` without bodies                                                                                                                                                                |
| GET          | `/api/projects/:id/reviews`                                                                                   | results                                                                                                                                                                                                                                                                                                   |
| GET          | `/api/projects/:id/reviews/results?pr=&sha=&repoId=` · `/api/reviews/results/:id`                             | results without summaries · one in full                                                                                                                                                                                                                                                                   |
| POST         | `/api/projects/:id/reviews/results`                                                                           | post a result                                                                                                                                                                                                                                                                                             |
| GET          | `/api/summary?projectId=`                                                                                     | the Home and Overview summary: what waits on the human, in progress, done today, next, carrying over, `reportDue` (every project without `projectId`)                                                                                                                                                     |
| GET          | `/api/daily?date=YYYY-MM-DD&projectId=`                                                                       | the day's activity, every write in order (one project's with `projectId`)                                                                                                                                                                                                                                 |
| GET/PATCH    | `/api/projects/:id/report-settings`                                                                           | how the project's report is made: `prompt`, `template` (headings in order; `""` is the default), `cadence` `off` · `daily` (on `workdays`, ISO 1–7) · `weekly` (on `weekday` 1–7), `shiftStart`–`shiftEnd` (HH:MM; due at the end), `alertMinutes`, `format` `text`/`file`; `pending` agent changes       |
| GET          | `/api/projects/:id/report-settings/changes?field=` · `/api/report-settings/changes/:id`                       | every change of the prompt or template, newest first, with the old and new value and who · one                                                                                                                                                                                                            |
| POST         | `/api/report-settings/changes/:id/accept` · `/revert`                                                         | keep an agent's change · put the field back as it was (humans only)                                                                                                                                                                                                                                       |
| GET/POST     | `/api/projects/:id/reports?from=&to=` · `{period?, body?, attachmentIds[]}`                                   | periods newest first with `status` done/missing/upcoming/off, the latest report, `generating` and `generateError` · post one (a newer version; the old ones are kept)                                                                                                                                     |
| POST         | `/api/projects/:id/reports/generate` `{period?}`                                                              | claude writes the period's report (the current one by default) from the prompt, the template and the activity; 409 while it runs                                                                                                                                                                          |
| GET          | `/api/projects/:id/reports/:period`                                                                           | every version posted for a period, newest first                                                                                                                                                                                                                                                           |
| GET          | `/api/reports/overview?date=` · `/api/report-due`                                                             | every project's report for the period holding `date` · `{items}`: the reports due soon or missing now                                                                                                                                                                                                     |
| GET          | `/api/projects/:id/pushed-today`                                                                              | commits and lines that reached origin today, by repo and branch (and ticket)                                                                                                                                                                                                                              |
| \*           | `/api/mcp`                                                                                                    | MCP streamable HTTP; tools mirror the rows above                                                                                                                                                                                                                                                          |

## Development

```
pnpm dev             # in a worktree: a copy on the first free port from 47101 with its own data (data/dev, a copy of the board's; --fresh copies again); refused in the main checkout
AUTH=off pnpm dev    # the same without the passkey gate: you are the human (Test mode, above)
pnpm typecheck       # tsc
pnpm lint            # oxlint
pnpm format          # prettier
pnpm test            # vitest (path mapping, actors, PR status, …)
pnpm test:e2e        # Playwright against a built board in test mode (Testing, below)
pnpm check:migrations # the drizzle folder and its journal agree
pnpm bench           # in a worktree: the benchmark (Benchmark, below)
pnpm db:generate     # after editing src/db/schema.ts; migrations in ./drizzle apply at boot
```

`src/server/git.ts` is the only place that spawns `git`/`gh`, and every command in it is a read, but
for `git fetch --prune origin`, which only refreshes the checkout's copy of origin's branches.

## Testing

- **Unit** (`pnpm test`): vitest, `src/**/*.test.ts` and `scripts/**/*.test.mjs`. Server tests open
  their own SQLite in a temp folder; the S3 ones run only with `S3_TEST_ENDPOINT` set (CLAUDE.md).
- **End to end** (`pnpm test:e2e`): Playwright, `e2e/`. It builds the board into `.output-e2e`
  (never `.output`, so a preview running from the same worktree is left alone) and starts it in test mode (above) on
  a free loopback port above 47140, with its data and a scratch git repo (a bare repo beside it is
  its origin) in a temp folder. Global setup seeds a project through the REST API; each test makes a
  project of its own. The browser is the human (no `X-Test-Actor`); tests call the API as
  `human:enrique` or `agent:claude` to set things up and to check what agents may do, and make the
  branches they need in the scratch repo. What no API can do, putting a moment in the past (work
  started yesterday, an upload a day old), they write to the run's throwaway database
  (`e2e/db.ts`). A full page load waits for hydration before the test goes on. Failures keep a
  screenshot and a trace under `test-results/`, and `playwright-report/` has the HTML report
  (`pnpm exec playwright show-report`). First run: `pnpm exec playwright install chromium`.
  `E2E_SKIP_BUILD=1` reuses the last build; `E2E_PORT` picks the port.
- **Migrations** (`pnpm check:migrations`): every `drizzle/NNNN_*.sql` has a number of its own and
  a journal entry, every entry its file, `idx` matches, and `when` grows down the journal. Drizzle
  applies only migrations dated after the last one applied, so one merged with an older `when`
  would be skipped on every existing database without an error.
- **CI** (`.github/workflows/ci.yml`, on pull requests and pushes to `main`): install, typecheck,
  lint, migrations, unit tests, build, then the e2e suite on Chromium; when something fails, the
  Playwright report and traces are uploaded as the `playwright-report` artifact.

## Benchmark

`pnpm bench` measures a checkout so a change can be compared before and after on the same machine.
Run it in a worktree: it refuses the main checkout (the live board), as target and as where it runs.

```
pnpm bench                                   # everything, both datasets, 3 runs (about 25 minutes)
pnpm bench --quick                           # one short pass, to see that it works
pnpm bench --sections server,mcp --runs 5    # only what a change touches
pnpm bench --server dev                      # vite dev, as the live board runs, instead of the build
pnpm bench --target ../agent-board-main --label main   # another checkout, e.g. a worktree of main
pnpm bench compare <before.json> <after.json>          # every metric, before and after
pnpm bench --help                            # every flag
```

It builds the target into `.bench/build/<folder>` (never `.output`) and starts the build in test mode
on `127.0.0.1`, on a free port from 47200 (never 47100), with a data folder of its own in
`.bench/work`, once per run so the runs are independent. A server counts as its own only when the
preload in its process reports the health check; when another process holds the port (another bench
run took it between the probe and the start), it starts again on the next free port. Two datasets:
`live-copy`, a backup of the main checkout's `data/board.db` and its uploads (skipped where there is
none; its repos are the real checkouts, so the PR queue calls `gh` and the push state fetches origin,
as the board does), and `generated`, a large board written from a seed (`--scale`, `--seed`: 20
projects, about 2,700 tickets with lanes, 22,000 posts, 20,000 replies, 2,000 attachments and 45,000
activity rows at scale 1) with a git repo and a bare origin for its projects.

The generated dataset gives the same answers at any hour: the board counts by the server's local day
(today's activity, work carried over, reports due) and by whole days of elapsed time (stalled work,
PRs merged in the last 14 days), so its rows are laid out on the local day it is written on, each
day's rows in that day's first minute, with half a day of work today. Within the first minute after
midnight it waits for that minute to pass. Days of a daylight saving change are not 24 h long, so to
keep every row on its calendar day and as many whole days old until midnight, the rows of the days up
to the day the clocks went back go an hour after their midnight, and on the day the clocks go back and
for the 60 days after they go forward it waits until 1:01 to write the dataset. When the day changes during a run, the dataset is
written again for the new day before the next server starts, and a run that went past midnight is run
again (the summary says so). What it cannot keep the
same is a date written out in words, such as a report period's label (`Sun, Oct 4`), and how long ago
today's rows were, so compare runs of different days with that in mind.

Sections (`--sections`): `server` (p50/p95 of the hot endpoints after a warm-up, the first request
apart, SQL statements and child processes per request), `mcp` (size and latency of the main tools'
results, as an agent), `bundle` (JS and CSS each route downloads on a cold load, raw and gzip, sized
from the build), `load` (cold first loads in Chromium: TTFB, DOMContentLoaded, load, hydration, data
shown, requests and bytes), `nav` (client-side navigations until the destination shows), `idle`
(requests per minute of pages left open, per API path) and `memory` (RSS and heap under a steady
request load, once per dataset). The counts per request come from `scripts/bench/preload.mjs`, which
the harness loads into the server it starts (`node --import`); the board has no switch for it. Under
`--server dev` the server code runs in a worker thread out of its reach, so those counts are n/a there,
and there is no bundle section.

Results go to `.bench/results/<time>-<sha>[-label].json` (every run's value of every metric, its
median and range) and `.md` (the summary, also printed), with the machine, the commit and the settings.
`compare` flags a change as beyond noise when the ranges over the runs do not overlap. The server and
browser it started stop when it ends, fails or is interrupted.

## Pushed or not

A branch's `push` (on `GET /api/tickets/:id` for the ticket and its workspaces, on
`/api/tickets/:id/git` for every branch, and per ticket on `/api/projects/:id/push`) is
`{state, ahead, behind, checkedAt}` (`into` on `merged`): `pushed` (green; origin has every commit, `behind` counts what it
has on top), `ahead` (red; `ahead` commits only here), `local-only` (red; no such branch on origin),
`merged` (no such branch on origin, and merged into origin's copy of the ticket's base, `into`: its PR
was merged and the branch deleted; a branch cut from the base and never committed to stays `local-only`),
`remote-only` (only on origin, e.g. after cleanup) or `none` (no branch, or it exists nowhere). It is
read from the checkout's `origin/*` refs, so the board fetches each repo in the background at most
every 5 minutes (never prompting, never holding up a request); `checkedAt` is the last fetch, and
the refresh action fetches at once. The board never pushes.

**Pushed today** (`GET /api/projects/:id/pushed-today`) counts what reached origin on the local day:
each time the board reads a checkout's copy of origin's branches it records which of them moved
(old sha to new sha; the first look at a repo only notes where they are, and one that finds origin
empty after the board's own fetch is a look too, so a new repo's first push counts; a listing where
every branch the board knew is gone at once records nothing, so their coming back is no move). Each of
the day's moves brings the commits that no tip origin had since local midnight reaches: where its
branches stood when the day began and every tip a move set before this one, branches deleted or gone
since included, so a branch deleted and pushed again as it was brings nothing. They count once each,
under the first branch that brought them, whenever they were written. Merge commits do not count.
Lines added and removed are their `git diff --shortstat`. The answer is
`{date, commits, added, removed, checkedAt, repos}`, each repo with its `branches` (and a branch's
`ticket` when it is one's); the Daily page shows it green,
or grey when nothing was pushed, and the project's sidebar on a day something was. What the
commits are is kept by their shas, so reading it again asks git nothing new; pushes made while the
board was not reading the repo count on the day it next does.
