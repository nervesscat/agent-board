The gate's light checks run with no slot; its heavy runs take the repo's first free test slot (**Shared
with the other tickets of this repo**), taken right before and released right after. Nothing holds a slot
while you read the diff or write `depth.md`, and a gate that sends the change back releases its slot
first.

From the worktree:

1. Run the project's checks on what the change touches (`git diff --name-only origin/BASE...<branch>`),
   and nothing more: the typecheck of the whole project (it cannot be scoped soundly, no slot); lint and
   the formatter on the changed files only (e.g. `prettier --check <files>`, no slot); the migration
   check (e.g. `pnpm check:migrations`) when the schema or a migration changed (no slot); only the unit
   tests related to the changed files, with `--testTimeout=30000` (e.g.
   `vitest related <files> --run --testTimeout=30000`, `jest --findRelatedTests <files>`, the `pytest`
   files that test them; no slot); only the end-to-end spec files for the pages or flows the change
   touches, with `--workers=1` (e.g. `playwright test <spec files> --workers=1`, one test slot), none
   when it touches neither. Use the project's own commands where it has them. Never the full unit or
   end-to-end suite here: GitHub CI runs both on the PR, and CI green on the final head is required
   before hand-off. A failure goes back to the builder with its output. A gate return uses up no review
   round. A run sends the change back at most twice, on every level. After the second return, when the
   checks still fail, or, for a ticket with no review, when a criterion still has no evidence (below),
   post what fails or is unproven, `ask_decision` (keep going or drop) and stop: `BLOCKER: decision`. A
   failure that also happens on `origin/BASE` is pre-existing: confirm it there, note it, go on.
   The end-to-end run is the gate's one build: hold the slot for it (holder `#<TICKET> gate <ISO time>`),
   release it when the run ends, and when it passes write `WORKDIR/02-build.md` with the head SHA
   (`git -C <worktree> rev-parse HEAD`), the artifact path (`<worktree>/.output-e2e`) and the ISO time, so
   `/feature-review` reuses that artifact instead of building the same commit again. A record whose SHA is
   not the head is stale: the gate runs on the next commit and rewrites it. A fix pass reruns the failed
   end-to-end spec file(s), the unit files related to the changed files (`vitest related <changed files>`,
   or the project's equivalent) and the light checks above, never the whole gate. It rewrites
   `WORKDIR/02-build.md` at the new head only when it ran the end-to-end run and so rebuilt
   `.output-e2e`; a fix pass that built nothing deletes the record, and the next review builds once at the
   new head.
2. Read the whole diff: `git diff origin/BASE...<branch>`. Then grep the added lines for `.skip(`,
   `.only(`, `xit(`, `xdescribe(`, `test.todo`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`,
   `oxlint-ignore`, `NODE_ENV`, `process.env.CI`, `vi.mock(`, `jest.mock(`, `|| true`,
   `continue-on-error`, and for tests or snapshots the diff deletes or loosens. Each hit breaks the
   contract unless it is plainly legitimate (say why in the hand-off); otherwise it goes back to the
   builder.
3. When the workflow has a review for this ticket: pick the review depth for this round (**Review
   depth**, in your instructions) and add a line with it, its measure and the head SHA to
   `WORKDIR/depth.md`. A ticket with no review has no review depth: skip this.

**When the workflow has no review for this ticket** (a low ticket, or a review turned off), the change
survives when the gate passed and the builder's evidence covers every criterion: each one shows execution
of the real code (the test or the run its evidence names), or is `UNVERIFIED` only for a reason in
**Escalation** that you could not get past. Run no `/feature-review` and write no line to `depth.md`. A
criterion without that evidence goes back to the builder as a gate return. After the second return, a
criterion that still has no evidence is the decision above, never a hand-off. Only a gate that passed with
that evidence for every criterion may go on.
