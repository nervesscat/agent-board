Start the preview of this head here: it is the one build of this head for the preview, and it keeps
running. When a review round's end-of-round intent check already started it for this head (the review
step's text says when it does), it runs: reuse it, take only the screenshots still missing and build
nothing. The review's `shots/` folder has the verify phase's screenshots. For a UI change you also need
one of the finished thing in that preview at the state the ticket is about. A ticket with no review has no
review folder, so its screenshots come from the preview. The intent check is given this preview, these
screenshots and the diff. With `BROWSER=no` and a UI change, do everything else, leave the ticket in
progress with its summary saying where you stopped, and return `STATUS: needs-browser`: the orchestrator
runs you again with the browser.

The preview comes before the move to review, never after it: start it first whenever the project has a
preview setup and the change can be previewed; when it cannot (no preview setup, or nothing to try), the
hand-off says why.

The preview, from at most one build of this head for the preview, reused wherever it is needed and not
built again; build only when none runs for this head (a new commit since changes the head). Prefer the
board's own preview run: `start_run` it (or `start_preview` on the workspace), wait for `running` (on
`failed`, read its log tail and fix). Its build is the preview's one build for this head, it carries the
preview base the board serves under, it lives on after your session, and the board stops it when the PR is
merged. When the artifact was built for the base the preview is served under — a repo with no proxied
preview base (`/p/<workspaceId>/<runId>/`), where an artifact built for `/` is also served at `/` — make
the run serve it instead of building: `update_run` its build command for this start to one that only
checks the artifact (`test -d .output-e2e`, or `true`) and its start command to
`node .output-e2e/server/index.mjs` with the repo's preview environment (a free loopback port from
`PORTS` as `PORT` and `NITRO_PORT`, `HOST=127.0.0.1`, `DATA_DIR` a copy of the data (never the live one),
`BOARD_ENV=development`, `AUTH=off`, `STORAGE=local`, `BOARD_URL=http://127.0.0.1:<port>`), then
`start_run` it and wait for `running`; once it runs, put back the run's original build and start
commands — the running process keeps serving the artifact. A checkout served under the board's preview
base (the board's own case) builds its own: the artifact is built for `/`, so its assets and client routes
would not match that link. Either way, never build the head twice for the preview; the gate's artifact is
the review's build, not the preview's, so a commit is built twice overall where the preview must build.

A repo with no preview run the board can start: start it from the artifact by hand in the worktree with
the repo's preview environment (a free loopback port from `PORTS` as `PORT` and `NITRO_PORT`,
`HOST=127.0.0.1`, `DATA_DIR` a copy of the data (never the live one), `BOARD_ENV=development`,
`AUTH=off`, `STORAGE=local`, `BOARD_URL=http://127.0.0.1:<port>`), `node .output-e2e/server/index.mjs`,
and `set_preview` with the URL it answers on. That preview lives in your session, so it stops when the
session ends, and the human can stop it meanwhile from the project's Previews page — say that in the
summary. In the summary say which of the three ran (the artifact through the board's run, the board's own
build, or a hand start) and how many times this head was built. Keep the preview running while the ticket
is in review; once it is merged or dropped, stop a hand-started process and clear the link
(`set_preview` with `""`), and the board stops its own. When the change cannot be tried (the project has
no preview setup, or the change has nothing to try: docs, a script), say why in the summary instead.

A preview build you start is a heavy run, in a test slot like any other (holder
`#<TICKET> preview <ISO time>`): take the first free one before the start and release it once the
preview runs or has failed. The board ticks Preview once it runs; when the change cannot be tried, remove
the Preview phase instead.

Before every re-run of the intent check (after a `does not match` fix round or any new commit) come back
here at the head being handed off: the preview for that head runs (build it only when none runs for this
head) and fresh screenshots of the changed state are taken.
