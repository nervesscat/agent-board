# Run report: Merge

You merge the base into the change's branch, check the merged tree, and put the worktree back.

This template is `run-reports/merge.md`: fill it in, with `write_run_report`, before you hand back.

## The rule

Every run of a default agent — `spec`, `builder`, `runner`, `env`, `verify`, `hunt`, `refute`,
`merge` — and of a project's own agent ends with one run report: one report per subagent run, written before it hands back. The
report is part of finishing: a run that hands back without one has not finished. The orchestrator
writes none (nor does a ticket agent that only drives rounds); a ticket with three review rounds has
three reports of an agent, one per round.

Each agent has its own template under `run-reports/` (beside `agents/` in the review bundle), which
carries this whole common part and adds what that agent does. A project agent may have a template of
its own on the board's Team page; a new one starts with this text.

Write it with `write_run_report` (or `POST /api/projects/:id/run-reports`), and read it back with
`get_run_report`; `list_run_reports` lists one kind across tickets. Every value that will be compared
or counted has its own field; only what needs a sentence goes in a section.

## The common part

- **agent**: the kind of run (`agent`), e.g. `hunt`. A ticket with several runs of one agent is told
  apart by its `round`.
- **ticket**: `projectId` and `ticketId`.
- **round**: the review round the run belongs to (`round`); null outside a review.
- **branch and head SHA**: `branch` and `headSha`: the branch worked and the commit it worked at.
- **model and effort**: `model` and `effort` (low, medium or high), as the run used them.
- **who briefed it**: `briefedBy`, the orchestrator or agent that started this run.
- **start and end**: `startedAt` and `endedAt`, the times the run began and ended.
- **duration**: `durationMs`, your own estimate. When a work-timeline span covers this run the board
  reads the measured duration back from it (`durationSource: measured`) and keeps your estimate as
  `reportedDurationMs`; without one, yours stands (`durationSource: self`). Say in `brief` where a
  measured span would not be the whole story.
- **where the time went**: `time`, with `readingMs`, `runningMs`, `waitingMs` (locks, builds, another
  agent), `writingMs` and `otherMs`. They should add up to the duration; where the largest part went
  is worth a line.
- **the brief, and whether it was enough**: section `brief`. What you were given, and what was
  missing, ambiguous or wrong; what you had to find out yourself.
- **what you read and ran**: section `readRan`. Files, commands, tools and servers, in outline.
- **the steps, against your instructions**: `steps`, one `{name, done, note}` per step your
  instructions prescribe. `done: false` with the reason for each you skipped; a step of your own is
  one of yours. This is what makes a skipped step visible.
- **difficulty and confidence**: `difficulty` and `confidence`, 1 to 5. Difficulty is how hard this
  run was for you; confidence is how sure you are of your own result.
- **problems**: section `problems`. Retries, dead ends, flaky tools, environment trouble, contention
  with other tickets.
- **what you could not check, and your assumptions**: section `gaps`.
- **what you would do with more time**: section `moreTime`.
- **what would have made the run better**: section `improvements`. One suggestion about your own
  instructions or the loop, not about the ticket's code.
- **counts**: `counts`, every number the run produced that someone may add up (candidates, findings,
  criteria checked, tests run).

## This agent's part: what a merge's report adds

- **conflicts** (`conflicts`): how the base was merged, each conflict and how it was read, and what the
  merged tree was checked with.
- **counts**: `counts` with `conflicts`, `testsRun` and `newFailures`.

## Where it goes

`write_run_report` stores it on the board against the ticket and this run: the ticket's Agents side
shows it with its agent, round and every section, and the project's Run reports page lists this
agent's reports across tickets. The report is the last thing you do: your hand-off and the result you
return come after it, and the orchestrator checks for it as it checks your result.
