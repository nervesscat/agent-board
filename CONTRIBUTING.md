# Contributing to CrossBoard

Thanks for helping. Bug reports, ideas and pull requests are all welcome. For a large change, open an
issue first so we can agree on the shape before you build it.

By contributing you agree that your contribution is licensed under the MIT License (`LICENSE`), and to
follow the Code of Conduct (`CODE_OF_CONDUCT.md`). Security issues go through `SECURITY.md`, never a
public issue.

## Prerequisites

- **Node.js 24** (`node --version`).
- **pnpm**, the version in `package.json`'s `packageManager`, through Corepack: `corepack enable pnpm`.
- **git**.
- **gh**, the GitHub CLI, signed in (`gh auth login`): the board reads PRs and CI status through it.
- **claude** (Claude Code), optional: the board runs it to write reports. Everything else works without it.
- For the end-to-end tests, Playwright's Chromium once: `pnpm exec playwright install chromium`.

## Getting the code

```
git clone https://github.com/nervesscat/agent-board.git
cd agent-board
pnpm install
cp .env.example .env
```

Branches start from `dev`, GitHub's default branch, and pull requests go back into **`dev`**. `main`
is what a release is made from.

## Working on a change

If you also use a board from this checkout (`pnpm start`, the "live" board on port 47100 with your
real data in `data/`), keep that checkout on `main` and never edit code in it: `pnpm start` runs it with
hot reload, so what is saved there is live at once. Work in a git worktree instead:

```
git fetch origin
git worktree add ../agent-board-my-change -b my-change origin/dev
cd ../agent-board-my-change
pnpm install
pnpm dev
```

`pnpm dev` runs a copy of the board on the first free port from 47101, with its own data in
`data/dev` (a copy of the main checkout's `data/` on the first run, when it has one, else empty;
`pnpm dev --fresh` copies again), and prints `Preview: http://localhost:<port>`. `AUTH=off pnpm dev` runs it with sign-in
off, every request as the human (README: "Test mode"). `pnpm dev` refuses to run in the main checkout.
Remove the worktree (`git worktree remove`) once the branch is merged or dropped.

`src/routeTree.gen.ts` is generated: after adding or removing a route file, run `pnpm generate-routes`
and commit only what it writes. `pnpm dev` and `pnpm build` rewrite that file with the router plugin's
`declare module '@tanstack/react-start'` block at its end, which stays out of a commit (the tests check
the committed file), so a build's copy in a commit hides what the next regeneration really changes.

`CLAUDE.md` has the project's working rules (storage, authentication files, benchmarks) and `README.md`
the reference for every feature and the REST API.

## Checks

Run all of them before you open a pull request:

```
pnpm typecheck && pnpm lint && pnpm test
pnpm check:migrations
pnpm check:i18n
pnpm test:e2e
pnpm exec prettier --check --end-of-line auto <changed files>
```

- `pnpm test` is vitest (`src/**/*.test.ts`, `scripts/**/*.test.mjs`, `desktop/**/*.test.mjs`).
- `pnpm check:i18n` (also run by `pnpm test`): every text of the interface is in every language file under
  `src/i18n/locales`, and no English is left in a component. A new text goes in `en.json` and in the nineteen
  other files (translated, with the plural forms each language needs, and in `desktop/app/strings/` when it is
  the desktop app's) with a key (README: "Language"; `docs/translating.md`); never hard-code it in JSX.
- `pnpm test:e2e` builds the board into `.output-e2e` and runs the Playwright suite against it in test
  mode, on a free loopback port above 47140 with throwaway data, so it is safe beside a running board.
- Prettier needs `--end-of-line auto`: without it, it flags every file checked out with CRLF line
  endings (Windows).
- A change made for speed comes with numbers: `pnpm bench` before and after, then
  `pnpm bench compare <before.json> <after.json>` (README: "Benchmark").

A change comes with tests for what it changes: a unit test where the logic lives, an e2e test for what
a person does in the browser. Do not skip, delete or loosen a test to make it pass.

## Database changes

Edit `src/db/schema.ts`, then `pnpm db:generate`. It writes `drizzle/YYYYMMDDHHMMSS_slug.sql` (the UTC
time, then a slug such as `add_x`), a journal entry with the same tag and a snapshot in `drizzle/meta/`.
Commit all of them. Do not rename the file or give it a number: the name is what keeps two branches from
picking the same one. `pnpm check:migrations` runs before the PR. It refuses a name that is not that form
(a new `NNNN_` file included), a `when` or `idx` used twice in the journal, a journal entry without its
file or the reverse, and two snapshots that follow the same one. After a merge, keep both entries in journal
order; if they share an `idx`, give the later one the next free integer. Migrations run when the server
starts, each once, in journal order.

If two branches each generated a migration from the same parent, the merge forks the snapshot chain:
`pnpm check:migrations` reports two snapshots that follow one, and `pnpm db:generate` reports a snapshot
collision. To repair it, delete the later branch's migration file, its journal entry and its snapshot (the
one whose journal entry comes last), keep its `schema.ts` change, run `pnpm db:generate` again (it writes the
migration on top of the merged chain under a new name), check, and commit.

The repair is only safe before that migration has run on any database. If a dev or preview data folder
(`data/dev`, `data/preview`) ran it, reset that folder first: `pnpm dev --fresh` copies the board's data
again, without the branch's migration, and `pnpm dev` applies the new one. If the live board has run it, do
not delete it: stop and ask the person who runs the board.

## Pull requests

- Target **`dev`**.
- One change per pull request, with a title that says what it does.
- Say what changed and why, how you tested it (the checks above, and what you tried by hand), and add a
  screenshot for anything visible. The pull request template lists this.
- Commit messages say what changed and why.
- Keep personal data out of the repository: no real names of private projects, local paths, machine or
  tailnet names, tokens or email addresses in code, tests, docs or screenshots.

### Branch protection

`dev` and `main` only take changes through a pull request. A direct push is refused, admins included, and so
are a force-push and a branch deletion. The three checks `check`, `desktop` and `desktop-linux` run on
GitHub's hosted runners, and a pull request merges only when all three are green on its head and its
branch is up to date with its base (`dev` for a normal change, `main` for a release).

Because each pull request must be up to date with its base, pull requests merge one at a time. To merge
one, merge its base into its branch, push, and wait for the three checks to go green again on the new
head; then merge. A pull request that is behind or red cannot merge, so the next one waits its turn.
No approval is required, since pull requests are often pushed with the maintainer's own account: the
checks are the gate.

`dev` is the default branch and everything lands through it, so a change that reaches it with a red CI
leaves every pull request after it to inherit the failure.

Only in an emergency, when `dev` is broken and there is no green way out, may a repository admin turn the
rule off on the branch's protection settings, land the fix through a normal pull request with green
checks, and turn the rule back on at once, saying in that pull request why it was bypassed.

## Releases

Maintainers publish the desktop installers as described in `docs/releasing.md`.
