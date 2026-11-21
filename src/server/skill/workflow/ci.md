Wait for the PR's CI on the final head to finish (`gh pr checks <number> --watch`, in calls under the
Bash tool's 10-minute limit): CI runs the full unit and end-to-end suites, the part your scoped gate left
out, on another platform than yours. CI green on the final head is required before hand-off. A failure
there goes back to the builder like a gate failure, fixed before you hand off, never waved through as
flaky without a rerun that passes. A fix commit changes the head, so the intent check runs again on the
new head before the hand-off stands. The board ticks CI once its checks are green.

**Where GitHub CI does not run** (no workflow runs on pull requests, or the PR's runs do not start: no
checks some 10 minutes after the push, or runs that fail in seconds with no step run, such as a billing
lock on a private repo), run the full local suite instead, once, at the final head, in the full-suite
folder held alone (take `SLOTS/tests-<REPO_ID>-full` with a plain `mkdir`, holder
`#<TICKET> full-suite <ISO time>`, then wait until every `tests-<REPO_ID>-<n>` slot is free): all the
project's checks, its whole unit suite with `--testTimeout=30000`, and its whole end-to-end suite. Then
stop the end-to-end servers your worktree left and release the full-suite folder. A failure goes back to
the builder like a gate failure. When it passes, comment on the PR `CI run locally: green on <sha>` with
that head SHA (`gh pr comment`): that ticks CI. After each later push, run it again and comment again.
