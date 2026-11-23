A review that is done is not run again. Read the branch's head SHA (`git -C <worktree> rev-parse HEAD`)
and `git -C REPO fetch origin BASE`. Skip the review, on a `RETRY` or re-queued run too, only when all of
these hold: the newest review of that SHA, in `~/.claude/feature-review/ledger.jsonl` (its review folder
has the criteria) and on the board (`list_review_results` with `sha`, or the review's posts on the
ticket), survived (the rule below). When this run is one of a round's reviews passed an `agent=` name
(a workflow that reviews a round more than once), only the ledger line that names that same
agent counts (its `path` is that run's own folder, and the board result is the one of that run's own
review): another run's line, or one with no agent, is never this run's review, so the first review's line never makes the second unnecessary; an earlier line of `WORKDIR/depth.md` for that SHA shows it ran at
least the depth the gate picked; `origin/BASE` is already in that SHA
(`git merge-base --is-ancestor origin/BASE <sha>`) or is the base its merge check used; and `RETRY` does
not name that review, its depth or its findings. Then go on with that review.

Otherwise run `/feature-review` through the Skill tool, unattended:
`repo=<REPO> <branch> ticket=<TICKET> round=<n> ports=<PORTS> browser=<BROWSER> effort=<this step's effort>`,
`slots=<SLOTS> build=<WORKDIR/02-build.md> repoId=<REPO_ID>`, `phases=<the phases argument this
workflow gives for the run>` and `agents=<the agents argument it gives for the same run>`, then `scoped`, plus `light` when the depth is `light` and `deep` when it is
`deep` (nothing more for `standard`). With `scoped`, its phases run only the scoped checks, since CI runs
the full suites on the PR. With `slots=`, its verify phase takes a test slot around the end-to-end run
and the full suite and its merge check around a heavy test run; its typecheck, lint and scoped unit runs
and the hunt's and refute's targeted unit and probe tests take none, so hold no slot while you wait for
it. With `build=`, its env phase copies the gate's artifact at the same head instead of building it
again. It reviews the branch's commits in a worktree of its own, posts its phases on the ticket, and
writes `review.md` and `summary.md`. When it would ask a question, it finishes its read-only phases with
the spec's assumption marked unconfirmed; once the card is open you block the ticket and end the run,
never building on that guess. `round=<n>` is the review round this run is (1 for the first, then counting
on{{if intent}}, continuing after an intent return{{end}}): its phase agents put it on their spans and run reports, and the
board counts a phase only when it is there. When it returns, however it ended, release any slot folder
under `SLOTS` whose `holder.txt` names this ticket. Then stop, by process id, every server, test board,
dev server or watcher you or your subagents started for the round (the preview is the one that keeps
running): clean up after each round, not only at the hand-off.

The change **survives** a round when the survival rule this workflow gives for the review holds. A
surviving round ends the cycle: go on to the next step. Otherwise the confirmed and plausible findings,
the failed criteria, and the merge check's conflicts or new failures go back to the builder, then your
gate, then the review again, as the next round, while the budget below allows one.

**The budget** is the `rounds` this workflow lists for the ticket's complexity. A round is one build or
fix pass, your gate and one review. Round 1 is the first build with its gate and its review; every later
round is a fix pass, each followed by the gate and a review, and the rounds are a ceiling, not a quota. Max is
for work built from scratch (a whole site or app, a new product or a standalone service), and a feature in
an existing codebase is never max, however difficult. A surviving round ends the cycle at every level. When a round does not survive and no round is left: post
what is still open, `ask_decision` (ship as is, keep going, drop) and stop: `BLOCKER: decision`. Never
start one more round on your own. The complexity sets the budget at every review depth: a `deep` review
earns no extra round, a `light` one loses none. {{if intent}}An intent return (`does not match`, see the intent step)
is not a gate return and is outside this budget: it gets its own fix pass and one more review, so "never
start one more round on your own" does not apply to it. Where this workflow's review text below says its
round-end intent check counts as a round (Thorough and Maximum), that text replaces this sentence: there
a `does not match` is an ordinary round of the budget.{{end}}

**Who runs each phase.** Each phase of the round is run by the agent its line names: a Team agent of the
project, briefed by `/feature-review` with that agent's `instructions` (`agents=` gives one name per
`phases=` token, in the same order), or a built-in role the Team has no agent for, briefed as the review
skill briefs a phase with no agent of its own. The names are the human's pick on the Workflow page, never
yours. A phase's span, its run report and its `agentName` carry its role (`spec`, `env`, `verify`, `hunt`,
`refute`, `merge`), never the Team agent's name, so the board counts every phase of the round whoever ran
it. The fix pass after a round that did not survive is run by the agent the `Between rounds` line names for it, briefed as
the build step briefs the builder, with the round's findings.

**Every phase this workflow lists for a round runs in every round.** None is skipped because the findings
look obvious, the change looks small or a finding was already reproduced, and each phase posts its
result, so a skipped phase is visible. The board checks it at the hand-off (`missingReviewPhases`: the
phases of this workflow's round that the last round lacks).

**The effort** is this step's effort. Pass it as the Agent tool's `effort` on every subagent you start
for the round, and give it to `/feature-review` as `effort=<level>`, so its phase agents run at it.{{if intent}} The
one exception is the intent agent: it runs at the intent step's effort, `low` unless the human set
another.{{end}}
