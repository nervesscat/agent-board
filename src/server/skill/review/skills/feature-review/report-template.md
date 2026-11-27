# Feature Review: <target>

**Verdict:** SHIP | SHIP AFTER FIXES | DO NOT SHIP | COULD NOT VERIFY
<one sentence saying why>

## Freshness

- Commit reviewed: `<sha>` (<branch or PR head ref>)
- PR head at start / at end: `<sha>` / `<sha>` (unchanged | moved: review is STALE)
- Worktree: `<path>`
- Dependencies: reused from main checkout (manifests identical) | fresh install (<reason>)
- Services up: <list with ports, all started by this review>
- Services unavailable: <list with reasons> | none
- Refutation: blinded (separate agent) | inline (no blinding)
- Plan: <the phases that ran> (from the phases= argument | the ticket's workflow | no workflow: the six standard phases)
- Hunts: <how many ran: two for the standard plan> (independent)

## Confirmed findings

### F1: <claim> (<severity>)
- Record: id `F1` · title `<claim>` · severity `major|medium|minor` · verdict `confirmed` · origin `original-build|previous-fix|pre-existing` · finder `hunt-a|hunt-b|verify` · round `<n>` · fixedIn `<sha, blank until fixed>`
- Location: `path:line`
- Scenario: <input/state> produces <wrong outcome>
- Evidence: <test output excerpt, or repro command and output>
- Repro: <command or steps>
- Suggested fix: <one line, optional>
- Stability: both hunts | one hunt (deep mode)

## Plausible findings (traced, not reproduced)

### P1: <claim> (<severity>)
- Record: id `P1` · title `<claim>` · severity `major|medium|minor` · verdict `plausible` · origin `original-build|previous-fix|pre-existing` · finder `hunt-a|hunt-b|verify` · round `<n>` · fixedIn `<sha, blank until fixed>`
- Location, Scenario, Evidence as above
- Uncertain step: <which step in the trace could not be executed>

## Verification of acceptance criteria

| # | Criterion | Method | Result | Evidence |
|---|---|---|---|---|

## Checked and clean

- Checklist sections applied: <list>
- Checks answered yes with citation: <count> (full table in `03-hunt-notes.md`)
- Candidates refuted: <count> (reasons in `04-verdicts.md`)
- Test suite: <command>, <pass/fail counts>

## Base compatibility

<the `05-merge.md` content: base SHA, behind count, overlapping files, merge outcome, tests on the merged tree, result>

## Unverified

- <criterion>: <reason it could not be executed or traced>

## Open questions for the author

- <question>. Assumed: <assumption used in this review>.
