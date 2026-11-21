{{if !spec}}**When the workflow lists no spec step for this ticket** (a low ticket, or a workflow without one), there
is no spec and no spec agent: write its acceptance criteria yourself from its instructions. `add_tasks`
with them as the subtasks of its Implementation phase (`parentTaskId` = its id), unless its tasks already
cover them (a ticket with no tasks gets the default phases first). The builder's brief then uses the
ticket's instructions as its spec. An unclear point follows **Escalation**: take the assumption, note it
in the hand-off, and `ask_decision` only when the readings lead to different products.

{{end}}
Start a subagent briefed with the **builder** agent's `instructions`, the project's `instructions`, the
ticket's context (everything the claim step read: its instructions, the human's posts and replies, the
decisions and their answers, the attachments), {{if spec}}`WORKDIR/01-spec.md`, {{end}}and a brief in the
same four parts. Focus: {{if spec}}the spec's Surfaces and their tests{{else}}the acceptance criteria and the files they touch{{end}}. Known: the worktree and branch, the
project's check commands scoped as the gate runs them, with the **Local test flags**, never the full unit
or end-to-end suite (GitHub CI runs those on the PR), `PORTS`, the repo's rule on what it may mention,
and the test slots' rule as written in **Shared with the other tickets of this repo** (the `SLOTS`
folder, the holder line `#<TICKET> builder <ISO time>`, the first free slot before each heavy run,
released right after it). Done when: every criterion has its check, the scoped checks pass, and the work
is committed on the branch, never pushed. Return: the commits, what changed per criterion or finding, the
checks run with their results.

On a later round the brief carries the findings and failed criteria to fix, each with its scenario, and
the Focus is only their `path:line` and their tests: the builder does not re-read or rework the rest of
the change. A fix pass reruns only what its findings touch: the failed end-to-end spec file(s) and the
unit files related to the changed files (`vitest related <changed files>`, or the project's equivalent),
not the whole gate; the full unit and end-to-end suites stay in CI, where CI runs them. When it returns,
release any slot it left behind if `holder.txt` still names your ticket. Post its summary `as: builder`.

{{if !spec}}**With no spec: the builder codes and verifies itself.** Its brief is the same, with the ticket's
instructions in place of `WORKDIR/01-spec.md` and its criteria in place of the spec's Surfaces. It is done
when every criterion is checked by a test that runs the real code (not a mock) or by running the real
code, and the scoped checks pass; the work is committed on the branch. Its return gives the evidence per
criterion: the test's name, or the command and what it showed.{{end}}
