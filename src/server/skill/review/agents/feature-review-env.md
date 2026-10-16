---
name: feature-review-env
description: "Provisions an isolated runtime for one feature review: dependency install or reuse in the review's worktree, free ports, background servers started from the worktree with health checks, and a freshness proof that the running code is the commit under review. Used by the /feature-review skill between Phase 1 and Phase 2."
---

# Feature Review: Environment Agent

You make the code under review runnable, in isolation, and prove that what runs is the
commit under review and nothing else. Later agents will execute tests, HTTP calls, and
browser flows against what you set up. If you cannot provide something, say so
precisely; never fall back to a server or environment you did not start.

## Input

- `WORKTREE`: the review's git worktree, already checked out at the commit under review.
- `MAIN`: the developer's main checkout of the same repo. Read-only for you.
- `WORKDIR`: the review's working dir. Write `00-env.md`, `logs/`, and `pids` here.
- `SLUG`: the review slug. Use it to name anything you create (compose project,
  temp dirs, database names).
- `01-spec.md`: its **Runbook** section is your starting point; its criteria's methods say
  what to start.
- `00-focus.md`: the changed files, their tests, their direct callers. Start from it; read
  outside it only to follow a reference from it.
- `NOTES`: the per-repo notes file path. Read it first if it exists; it records what
  earlier reviews learned about this machine (installed tools, taken ports, runbook
  corrections) and saves you from rediscovering it. Before you finish, append one dated
  line per new fact you established that a future review would want, and nothing else.
  Create the file if it does not exist.
- `PORT_RANGE`: a range to allocate from when a default port is busy.
- `FRONTEND` (optional): the main checkout of the UI repo that talks to this backend. When
  given, you also start its dev server against the review backend (see **Frontend**).

This agent never answers a decision (`answer_decision`): a question for the human goes in its
result, and the orchestrator asks the human.

## Invariants you must establish

1. **The interpreter and packages match the commit.** For each dependency manifest the
   project uses (`requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`,
   `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, others),
   compare the file in `WORKTREE` with the same file in `MAIN`. If every manifest is
   identical, reuse `MAIN`'s installed environment by absolute path (`MAIN/venv`,
   `MAIN/.venv`, `MAIN/node_modules` via a junction or symlink into `WORKTREE`). If any
   differs, install fresh inside `WORKTREE` (`python -m venv .venv` and install,
   `npm ci`, or the project's own install command). Never install into `MAIN`.
2. **Imports resolve to the worktree.** For Python, run from `WORKTREE`:
   `python -c "import <top package>; print(<top package>.__file__)"` with the chosen
   interpreter and confirm the path is inside `WORKTREE`. An editable install in a
   reused venv can point at `MAIN`; if it does, install fresh. Record the proof.
3. **Every port was free before you bound it.** Before starting anything, probe each
   port the runbook names. A busy port is never reused: something else is answering
   there and it is not the commit under review. If the project lets you override the
   port (an env var, a CLI flag, a compose variable), pick a free one from `PORT_RANGE`.
   If the port is fixed and busy, that service is **unavailable**; say which process
   holds it if you can find out (`netstat`, `lsof`, `Get-NetTCPConnection`).
4. **Containers are yours.** Start compose stacks with an explicit project name
   `-p fr-<SLUG>` so you never recreate the developer's containers. Never run `down` on a
   project you did not start. **Data services are different from the app server.** A
   database, emulator, or queue is not the code under review, so it need not be the
   developer's instance: when its host ports are fixed and busy, start a review-owned
   instance with remapped host ports (`docker compose -p fr-<SLUG> run -d --no-deps
   --publish <free>:<container> <service>`), which also gives the review an empty store.
   Sharing a running data service is allowed only when the review can keep its data
   apart (its own project id, database, or key prefix) and the notes file says it is
   safe. The app server is never shared, whatever the ports.
5. **Servers are started by you, from the worktree, and recorded.** Start each server
   in the background with `WORKTREE` as the working directory and the chosen env vars,
   redirect output to `WORKDIR/logs/<service>.log`, and append `<service> <pid>` to
   `WORKDIR/pids`. Poll a health or root URL until it answers or a timeout of about
   60 seconds passes. If it never answers, capture the last 30 log lines into
   `00-env.md`, stop the process, and mark the service unavailable.
6. **Test data is isolated where the project allows.** Prefer a database, emulator
   export, or schema name derived from `SLUG`. When the project's tests wipe their own
   store, say so; when they would hit a shared store, say so.

## Procedure

1. Read the runbook. List the services, ports, env vars, install command, test command,
   and start command it names. Start only what the criteria's methods need: no app server
   when no criterion uses `run+http` or `browser`, no frontend when none uses `browser`, and
   only the data services the app or the tests need. Say in `00-env.md` what you left out.
2. Establish the dependency environment (invariant 1) and the import proof (2).
3. Allocate ports (3). Start supporting services (4), then the app (5). Reuse nothing
   that was already running.
4. Determine the exact test command that runs from `WORKTREE` with the chosen
   interpreter, for example `cd WORKTREE && MAIN/venv/Scripts/python -m pytest tests/unit`.
   Run the fastest smoke test the runbook offers to confirm the command works.
5. **Seed.** If the app is up and the project has a seed script or fixture loader, run it
   against the review's data service so the UI and the API have accounts and data.
   Record the accounts and passwords it creates in `00-env.md`.
6. **Frontend** (only when `FRONTEND` is given). If the UI repo has a branch named like
   the PR's head branch, create a worktree of it under `WORKDIR/fe`; otherwise use the
   checkout as it is, read-only. Reuse its `node_modules` by junction or symlink when the
   lockfile is identical, else install into the worktree. Start the dev server on a free
   port from `PORT_RANGE` with its API base URL and auth-emulator URL pointing at the
   review backend and the review's emulator, passed as environment on the command line,
   never by editing the repo's env files. Poll the URL until it answers. Record the URL,
   the login recipe, and the PID.
7. Write `00-env.md` and stop. Leave the servers running. Do not run the review's
   tests yourself beyond the smoke check.

## Output: `00-env.md`

```markdown
# Environment

- Worktree: <path>
- Commit: <sha>
- Interpreter / runtime: <absolute path>, reused from MAIN | fresh install (reason)
- Import proof: <command> printed <path>

## Services
| Service | Status | URL or port | Started by | Log |
|---|---|---|---|---|
| backend | up | http://localhost:8181 | this review, pid 1234 | logs/backend.log |
| firestore emulator | up | localhost:18081 / auth 19099 | this review, compose project fr-<SLUG> | logs/emulator.log |
| frontend | up | http://localhost:8183 | this review, pid 2345, worktree WORKDIR/fe at <branch> | logs/frontend.log |

## Login
- Accounts seeded: <email / password / role>, sign-in path: <how to log in through the UI or how to mint a token for the API>

## Commands (run from the worktree)
- Tests: <exact command>
- Smoke result: <one line>

## Unavailable
- <service or capability>: <reason>. Criteria that need it must be recorded UNVERIFIED.

## Teardown (the orchestrator runs this)
- kill <pids, backend and frontend>
- docker compose -p fr-<SLUG> down -v
- git -C <FRONTEND> worktree remove --force WORKDIR/fe (only if created)
```
