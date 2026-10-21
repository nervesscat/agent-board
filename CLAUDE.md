# agent-board

What it is and its API: `README.md`. How agents work through a running board: `AGENTS.md`.

## Running it

There is one board: `pnpm start` runs it from this main checkout on port 47100 (from `.env`), with
hot reload (`vite dev`) on the real data in `data/`, in the background, and waits until it answers.
`pnpm start --fg` runs it in the foreground, `pnpm stop` stops it. It always runs as production, so it
always requires sign-in (its own passkeys; README: "Signing in"). Logs: `data/logs/board.out.log`,
`board.err.log`.

- **Put changes live:** `git pull` on `main` here; the board reloads by itself. A pull that changes
  dependencies (`package.json`, `pnpm-lock.yaml`) or adds a migration needs `pnpm start` again: it
  stops the board, installs, and starts it; migrations apply as it starts. A broken commit on `main`
  breaks the board at once, so only merged, checked work goes there.
- **Never edit code in the main checkout, or switch its branch:** whatever is saved there is live
  within a second. Work in a worktree (below).
- **No second board:** `pnpm dev` refuses in the main checkout. Do not run `vite dev` by hand on
  47100 next to the board either: Vite would quietly take `[::1]:47100`, so `localhost` would reach
  one or the other depending on the client.
- **Previews of a branch:** work in a worktree, never by switching branches in the main checkout
  (the board would run that branch on the real data):

  ```
  git worktree add ../agent-board-<branch> <branch>
  cd ../agent-board-<branch> && pnpm install && pnpm dev
  ```

  It runs a copy on the first free port from 47101 (`DEV_PORT` to choose) with its own data in the
  worktree's `data/dev`, copied from the board's on the first run (`pnpm dev --fresh` copies again),
  and prints `Preview: http://localhost:<port>`. For the human, let the board run the preview
  instead: register the worktree as the ticket's workspace and press Start on the ticket's Preview
  card (or `start_preview`). The board builds the worktree and runs the build there
  (`BOARD_ENV=development AUTH=off`, loopback, a free port from 47101, a fresh copy of the live
  data in `data/preview`, logs in `data/preview/logs`), and stops it when the PR is merged, the
  ticket is closed or archived, or the board stops (`src/server/managedPreview.ts`). Remove the
  worktree (`git worktree remove`) once the branch is merged or dropped.

- **With sign-in off (outside production only):** `AUTH=off pnpm dev` runs the preview with
  every request as the human; `BOARD_ENV=test` runs a board where nobody signs in and `X-Test-Actor:
human:<name>` or `agent:<name>` says who calls (CI, Playwright). The server refuses to start with
  sign-in off in production, off loopback or on 47100, and shows an AUTH OFF banner and a top-bar badge
  while it is off; `pnpm start` always runs production. README: "Test mode". This
  is authentication: change `src/server/config.ts`, `auth.ts`, `passkeys.ts`, `credentials.ts`,
  `entrance.ts`, `devEntrance.ts`, `startup.ts` and their tests together.

## Checks

```
pnpm typecheck && pnpm lint && pnpm test
pnpm check:migrations
pnpm test:e2e
pnpm exec prettier --check --end-of-line auto <changed files>
```

`pnpm test:e2e` (Playwright, `e2e/`) builds into `.output-e2e` and starts that build in test mode on a
free loopback port above 47140 with throwaway data, so it is safe beside the live board, in the main
checkout too. CI (`.github/workflows/ci.yml`) runs all of these on every pull request. Prettier
without `--end-of-line auto` flags every CRLF file.

A change made for speed comes with numbers: `pnpm bench` in a worktree before and after it, then
`pnpm bench compare <before.json> <after.json>` (README: "Benchmark"). It never runs against :47100
or the live `data/`.

## Files

All attachment bytes go through `src/server/storage.ts` (`fileStore`: local `data/uploads`, or S3 with
`STORAGE=s3`). Never read or write `data/uploads` directly. A path handed to an agent must exist:
MCP tool results and agents' REST reads pass through `ensureLocalFiles`. The S3 tests in
`storage.test.ts` run against a real MinIO when `S3_TEST_ENDPOINT` (with `S3_TEST_ACCESS_KEY`,
`S3_TEST_SECRET_KEY`) is set, e.g. `docker compose -f docker-compose.minio.yml up -d` and
`http://127.0.0.1:47120`.
Unattached uploads older than a day are deleted hourly: a new reference to an upload goes in `src/server/unattached.ts`.

## Database

Edit `src/db/schema.ts`, then `pnpm db:generate`. Give the generated migration a descriptive name
(`drizzle/00NN_what_it_does.sql`) and update its `tag` in `drizzle/meta/_journal.json` to match.
Migrations run when the server starts.
