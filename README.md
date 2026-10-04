# agent-board

A local job board shared by one developer and their AI agents (claude, codex, opencode, …).
Per project (one or more repos): the PR queue assigned to you, the features in flight (tickets →
lanes for parallel work → tasks → branches and workspaces → updates with screenshots and recordings →
threads), the PR reviews your agents record, and a day-by-day log with a one-glance summary. Git and GitHub are **read-only**.

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
pnpm redeploy          # builds and starts the board on http://localhost:47100, the gate login first
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
pnpm install && pnpm build
curl -fsSL https://claude.ai/install.sh | bash && claude   # log in once; `gh auth login` likewise
```

Repo paths are then Linux paths (`/home/you/spark-repos/spark-backend`), the board spawns
the WSL `claude`, and WSL's port 47100 is forwarded to Windows `localhost`, so the browser and the
gate cookie work unchanged. After a change here: `git -C ~/agent-board pull && pnpm install`, then
`scripts/start.sh --build` inside WSL rebuilds and restarts it.

## Running the built board

```
pnpm redeploy                 # install, stop the board, build, start it in the background, wait until it answers
pnpm build && pnpm start      # Windows or Linux, in the foreground; logs to the terminal
scripts/start.sh              # Linux/WSL: build if stale, (re)start in the background, logs in data/logs
```

The built board does not reload on its own: after `git pull`, `pnpm redeploy` puts the new code live
(migrations apply as it starts). On Windows the board is down while it builds, since the build
cannot replace `.output` under a running server; if the build fails, the previous one is started
again. Logs: `data/logs/build.log`, `board.out.log`, `board.err.log`.

The gate comes up with Docker Desktop at sign-in (`restart: unless-stopped`); only the board needs
starting after a reboot.

## Reviews

An agent that reviews a PR records it with `post_review_result` (REST:
`POST /api/projects/:id/reviews/results`): verdict, markdown summary with findings, checks.
Findings appear on the PR row and in the Reviews module, each with its own thread. Nothing is
posted to GitHub.

## REST API

All routes need the gate cookie or `Authorization: Bearer gate_…`; JSON in and out. `actor` is
the gate device or token name.

| Method       | Path                                                                              |                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET          | `/api/me`                                                                         | who you are                                                                                                          |
| GET          | `/api/agent-setup` · `/api/agent-setup/skill?client=claude\|codex\|opencode`      | board and gate URLs for the Connect agents page · the board skill as a SKILL.md with today's projects and repos      |
| GET/PATCH    | `/api/settings` `{defaultAgent}`                                                  | board-wide preferences (PATCH is the human's only)                                                                   |
| GET/POST     | `/api/projects` · GET/PATCH/DELETE `/api/projects/:id`                            | projects with their `repos[]`, `stages[]` and `agents[]`; `instructions` is the agents' briefing                     |
| GET/POST     | `/api/projects/:id/agents` · PATCH/DELETE `/api/agents/:id`                       | the project's agents `{name, instructions, avatarId}` (writes are the human's); a ticket assigned to one is reserved |
| GET/POST     | `/api/projects/:id/stages` · PATCH/DELETE `/api/projects/:id/stages/:stageId`     | board columns `{name, kind, color}`; DELETE takes `?moveTo=<key>` when it has tickets                                |
| PUT          | `/api/projects/:id/stages/order` `{ids[]}`                                        | reorder the stages (every id, once); stage writes are the human's only                                               |
| GET/POST     | `/api/repos` · PATCH/DELETE `/api/repos/:id` · GET `/api/repos/:id/branches`      | checkouts; POST takes `projectId` or `projectName`, PATCH `projectId` moves it                                       |
| GET          | `/api/projects/:id/prs?refresh=1`                                                 | PR queue (`status`, `latestReview`, `tickets[]` it came from)                                                        |
| PATCH        | `/api/prs/:id` `{hold, holdNote}`                                                 | park / release                                                                                                       |
| GET/POST     | `/api/projects/:id/tickets` · GET/PATCH/DELETE `/api/tickets/:id`                 | tickets (`tasks[]` on create; `repoId` when the project has several repos)                                           |
|              | `?parent=root\|<id>` on the list · `parentId` on create                           | lanes: a ticket's parallel sub-tickets, nested to any depth                                                          |
|              | `?lanes=1` on GET · `?keepLanes=1` on DELETE                                      | lanes' updates in the feed · move lanes up a level instead of deleting them                                          |
| GET          | `/api/projects/:id/tickets?status=todo,blocked&assignee=&q=&tag=&parent=`         | filters (`status` takes stage keys, names or kinds; `assignee=` empty for unassigned; `parent=root` for top level)   |
| POST         | `/api/tickets/:id/claim` `{branch?, as?}`                                         | assign to the caller (or the project agent it works as) and start it; 409 if reserved for another agent              |
| GET          | `/api/tickets/:id/git`                                                            | branch + workspaces, live from git, each with `reach` (merged/rebased/edited/unique vs its base chain)               |
| GET          | `/api/projects/:id/cleanup?reach=0`                                               | closed tickets still holding workspaces, branches or worktrees; `reach=0` skips the merge checks                     |
| POST         | `/api/tickets/:id/tasks` `{tasks[]}` · PATCH/DELETE `/api/tasks/:id`              | todo list                                                                                                            |
| POST         | `/api/tickets/:id/workspaces` · DELETE `/api/workspaces/:id`                      | worktrees / sub-branches / subagents                                                                                 |
| POST         | `/api/tickets/:id/updates` `{body, attachmentIds[], as?, progress?}`              | a post on the ticket's feed (`progress` default true); `as` posts under one of the project's agents (agents only)    |
| PATCH/DELETE | `/api/updates/:id` `{body?, progress?}` · `/api/comments/:id` `{body}`            | edit / delete a post or reply: its author, or the human                                                              |
| POST         | `/api/uploads`                                                                    | multipart `file`, or JSON `{path}` (local file) or `{name, base64}` → `{id, url}`                                    |
| GET          | `/api/uploads/:id` · `/api/uploads/:id/info`                                      | the file · its metadata with the local `path` (and `windowsPath` under WSL)                                          |
| GET/POST     | `/api/comments?parentType=ticket\|update\|pr\|review&parentId=`                   | on a ticket: its posts (POST adds one, not progress); else replies (`replyTo` nests; `as`, `@name` as before)        |
| GET          | `/api/projects/:id/threads`                                                       | threads where someone spoke after the caller                                                                         |
| GET          | `/api/projects/:id/reviews`                                                       | results                                                                                                              |
| GET          | `/api/projects/:id/reviews/results?pr=&sha=&repoId=` · `/api/reviews/results/:id` | results without summaries · one in full                                                                              |
| POST         | `/api/projects/:id/reviews/results`                                               | post a result                                                                                                        |
| GET          | `/api/daily?date=YYYY-MM-DD&projectId=`                                           | activity by the hour + summaries                                                                                     |
| POST         | `/api/daily/summaries` `{date, projectId, body}` · `/generate`                    | post / ask claude for the day's summary                                                                              |
| \*           | `/api/mcp`                                                                        | MCP streamable HTTP; tools mirror the rows above                                                                     |

## Development

```
pnpm dev             # hot-reload copy on the first free port from 47101, with its own data (data/dev, a copy of the live data; --fresh copies again)
pnpm typecheck       # tsc
pnpm lint            # oxlint
pnpm format          # prettier
pnpm test            # vitest (path mapping, actors, PR status, …)
pnpm redeploy        # put this checkout live on the built board
pnpm db:generate     # after editing src/db/schema.ts; migrations in ./drizzle apply at boot
```

`src/server/git.ts` is the only place that spawns `git`/`gh`, and every command in it is a read.
