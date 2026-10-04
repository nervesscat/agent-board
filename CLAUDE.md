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

  It prints `Preview: http://localhost:<port>`; post that link on the ticket. Remove the worktree
  (`git worktree remove`) once the branch is merged or dropped.

## Checks

```
pnpm typecheck && pnpm lint && pnpm test
pnpm exec prettier --check --end-of-line auto <changed files>
```

On a Windows checkout two tests fail regardless of the change: `agents.test.ts` (CRLF line endings)
and `cleanup.test.ts` (path separators). Prettier without `--end-of-line auto` flags every CRLF file.

## Database

Edit `src/db/schema.ts`, then `pnpm db:generate`. Give the generated migration a descriptive name
(`drizzle/00NN_what_it_does.sql`) and update its `tag` in `drizzle/meta/_journal.json` to match.
Migrations run when the server starts.
