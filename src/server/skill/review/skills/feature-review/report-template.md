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

## Confirmed findings

### F1: <claim> (<severity>)
- Location: `path:line`
- Scenario: <input/state> produces <wrong outcome>
- Evidence: <test output excerpt, or repro command and output>
- Repro: <command or steps>
- Suggested fix: <one line, optional>
- Stability: both hunts | one hunt (deep mode only)

## Plausible findings (traced, not reproduced)

### P1: <claim> (<severity>)
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
