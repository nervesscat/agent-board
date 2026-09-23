# agent-board

A local job board shared by one developer and their AI agents (claude, codex, opencode, …).
Per project: the PR queue assigned to you, the features in flight (tickets → tasks → branches
and workspaces → updates with screenshots and recordings → threads), unattended PR reviews on a
schedule, and a day-by-day log with a one-glance summary. Git and GitHub are **read-only**.

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
npm install
npm run dev            # http://localhost:47100 — redirects to the gate login until you sign in
```

Add a project (name + path of a local checkout), open its PR queue, and you are on.

Agents: mint a token per agent on `http://localhost:47110/devices` and follow `AGENTS.md`
(`claude mcp add --transport http board http://localhost:47100/api/mcp --header "Authorization: Bearer gate_…"`).

## Running it from WSL (projects, git, gh and claude live there)

Keep this checkout as the source of truth and run a clone inside the distro:

```bash
# inside WSL, once
git clone /mnt/f/Programming/WebDev/agent-board ~/agent-board && cd ~/agent-board
cp .env.example .env   # set CLAUDE_BIN=$HOME/.local/bin/claude and FEATURE_REVIEW_DIR=$HOME/.claude/feature-review
npm install && npm run build
curl -fsSL https://claude.ai/install.sh | bash && claude   # log in once; `gh auth login` likewise
```

Project repo paths are then Linux paths (`/home/you/spark-repos/spark-backend`), the board spawns
the WSL `claude`, and WSL's port 47100 is forwarded to Windows `localhost`, so the browser and the
gate cookie work unchanged. After a change here: `git -C ~/agent-board pull && npm run build`, or
re-run the task installer below, which does that.

## Run whether you are logged on or not

The review schedules fire from inside the board process, so the board has to be up at 9am. On
Windows:

```powershell
scripts\install-task.ps1        # re-launches as Administrator, asks your Windows password once, builds + registers "AgentBoard"
scripts\install-task.ps1 -Wsl kali-linux -WslPath /home/you/agent-board   # same, but the board runs inside WSL
Get-ScheduledTask AgentBoard    # LogonType Password = runs with nobody logged on
scripts\uninstall-task.ps1
```

The task starts at boot, restarts on failure, and logs to `data\logs\board.*.log`. After a
`git pull` or dependency change, re-run `install-task.ps1` (it rebuilds). Use `-Interactive` if
your account has no password (then it only runs while you are logged on). A stored-password task
logs on as a batch job, a right Windows gives only to administrators; the installer grants it to
your account. If the task still shows `LastTaskResult 267011` ("has not yet run"), enable the
Task Scheduler history and start it once to see the logon error.

The gate only answers logins and agent tokens; scheduled reviews do not need it. It comes up with
Docker Desktop at sign-in (`restart: unless-stopped`), so before anyone signs in the board runs
its schedules but answers requests with 401.

## Reviews

The Reviews module runs `claude -p "/review-queue <repo> <args>"` in the project checkout
(`--permission-mode bypassPermissions`, since nobody is there to answer prompts), streams the log,
and when it exits imports every PR the queue reviewed from `~/.claude/feature-review/ledger.jsonl`
plus that review's `summary.md` (screenshots copied into uploads). Findings appear on the PR row
and in the Reviews module, each with its own thread. `mine` (the default argument) limits the
queue to PRs where your review is requested.

## REST API

All routes need the gate cookie or `Authorization: Bearer gate_…`; JSON in and out. `actor` is
the gate device or token name.

| Method   | Path                                                                 |                                                                                   |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| GET      | `/api/me`                                                            | who you are                                                                       |
| GET/POST | `/api/projects` · GET/PATCH/DELETE `/api/projects/:id`               | projects; `instructions` is the agents' briefing                                  |
| GET      | `/api/projects/:id/prs?refresh=1`                                    | PR queue (`status`, `latestReview`)                                               |
| PATCH    | `/api/prs/:id` `{hold, holdNote}`                                    | park / release                                                                    |
| GET/POST | `/api/projects/:id/tickets` · GET/PATCH/DELETE `/api/tickets/:id`    | tickets (`tasks[]` on create)                                                     |
| GET      | `/api/tickets/:id/git`                                               | branch + workspaces, live from git                                                |
| POST     | `/api/tickets/:id/tasks` `{tasks[]}` · PATCH/DELETE `/api/tasks/:id` | todo list                                                                         |
| POST     | `/api/tickets/:id/workspaces` · DELETE `/api/workspaces/:id`         | worktrees / sub-branches / subagents                                              |
| POST     | `/api/tickets/:id/updates` `{body, attachmentIds[]}`                 | progress feed                                                                     |
| POST     | `/api/uploads`                                                       | multipart `file`, or JSON `{path}` (local file) or `{name, base64}` → `{id, url}` |
| GET      | `/api/uploads/:id`                                                   | the file                                                                          |
| GET/POST | `/api/comments?parentType=ticket\|update\|pr\|review&parentId=`      | threads (`replyTo` nests)                                                         |
| GET      | `/api/projects/:id/reviews`                                          | runs, results, schedules                                                          |
| POST     | `/api/projects/:id/reviews/run` `{args}` · `/cancel` · `/results`    | run now / cancel / post a result                                                  |
| POST     | `/api/projects/:id/schedules` · PATCH/DELETE `/api/schedules/:id`    | `{time:"09:00", days:<bitmask, bit0=Sun>, args, enabled}`                         |
| GET      | `/api/daily?date=YYYY-MM-DD&projectId=`                              | activity by the hour + summaries                                                  |
| POST     | `/api/daily/summaries` `{date, projectId, body}` · `/generate`       | post / ask claude for the day's summary                                           |
| \*       | `/api/mcp`                                                           | MCP streamable HTTP; tools mirror the rows above                                  |

## Development

```
npm run dev          # vite dev server on 47100 with hot reload
npm run typecheck    # tsc
npm run lint         # oxlint
npm run format       # prettier
npm test             # vitest (ingest parser, schedule due-ness, PR status)
npm run build && npm start
npm run db:generate  # after editing src/db/schema.ts; migrations in ./drizzle apply at boot
```

`src/server/git.ts` is the only place that spawns `git`/`gh`, and every command in it is a read.
