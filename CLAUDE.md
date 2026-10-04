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
- **Hot reload while working on the board itself:** run a second copy on another port with its own
  data, so the live board and its database stay untouched. `PORT` must be set: `.env`'s `PORT`
  overrides `--port`.

  ```powershell
  $env:PORT='47101'; $env:BOARD_URL='http://localhost:47101'; $env:DATA_DIR='./data/dev'; pnpm exec vite dev --port 47101 --strictPort
  ```

  Copy `data/board.db` (with `better-sqlite3`'s `backup()`, not a file copy, since it is in WAL mode)
  and `data/uploads` into `data/dev` first for real data. In dev, images under `/api/uploads/*` do
  not load (Vite answers requests with `Sec-Fetch-Dest: image` itself); check those on a built server.

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
