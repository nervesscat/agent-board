# agent-board

What it is and its API: `README.md`. How agents work through a running board: `AGENTS.md`.

## Running it

The board in daily use is the **built** server (`pnpm start`, port 47100 from `.env`). It has no hot
reload: code reaches it only through a build.

- **Put changes live:** after they are on `main` here (`git pull`), run `pnpm redeploy`. It installs,
  stops the board, builds, starts it in the background and waits until it answers; migrations apply
  as it starts. If the build fails it starts the previous build again and exits non-zero. Logs:
  `data/logs/build.log`, `board.out.log`, `board.err.log`.
- **Never `pnpm build` while the board runs on Windows.** The running server holds the SQLite driver
  in `.output` open, so the build fails halfway and leaves `.output` wiped under the live board. Use
  `pnpm redeploy`, or build in a separate worktree to check that it builds.
- **Hot reload while working on the board itself:** `pnpm dev` runs a second copy on the first
  free port from 47101 (`DEV_PORT` to choose) with its own data in `data/dev`, so the live board
  and its database stay untouched. The first run copies the live database and uploads there (from
  the main checkout when run in a worktree); `pnpm dev --fresh` copies them again. Do not run
  `vite dev` on 47100 by hand: the built board holds `127.0.0.1:47100` and Vite would quietly take
  `[::1]:47100`, so `localhost` would reach one or the other depending on the client.
- **Previews of a branch:** work in a worktree, never by switching branches in the main checkout
  (a running preview or the human's own `pnpm dev` would change code underneath them):

  ```
  git worktree add ../agent-board-<branch> <branch>
  cd ../agent-board-<branch> && pnpm install && pnpm dev
  ```

  It prints `Preview: http://localhost:<port>`. For the human, let the board run the preview
  instead: register the worktree as the ticket's workspace and press Start on the ticket's Preview
  card (or `start_preview`). The board builds the worktree and runs the build there
  (`BOARD_ENV=development AUTH=off`, loopback, a free port from 47101, a fresh copy of the live
  data in `data/preview`, logs in `data/preview/logs`), and stops it when the PR is merged, the
  ticket is closed or archived, or the board stops (`src/server/managedPreview.ts`). Remove the
  worktree (`git worktree remove`) once the branch is merged or dropped.

- **Without the passkey gate (outside production only):** `AUTH=off pnpm dev` runs the preview with
  every request as the human; `BOARD_ENV=test` runs a board with no gate where `X-Test-Actor:
human:<name>` or `agent:<name>` says who calls (CI, Playwright). The server refuses to start without
  the gate in production, off loopback or on 47100, and shows an AUTH OFF banner and a top-bar badge
  while it is off; `pnpm start` and `pnpm redeploy` always run production. README: "Test mode". This
  is authentication: change `src/server/config.ts`, `auth.ts`, `startup.ts` and their tests together.

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
