A pass that only writes tests, after the build and before the gate, so the proof is not left to the
author of the code alone.

Start the agent this step names, briefed as for the build step (its Agent line's Team agent and that
agent's `instructions`, the project's `instructions`, the ticket's context, {{if spec}}`WORKDIR/01-spec.md`, {{end}}the worktree and branch, the scoped
check commands, the **Local test flags** and the test slots' rule). {{if !spec}}When the workflow lists the spec step as skipped for the ticket there is no `WORKDIR/01-spec.md`: the
ticket's instructions and the acceptance criteria you wrote from them are the spec, as in the build step.{{end}}
The change to the brief:

- Its job is tests, not product code: for every acceptance criterion and every edge the spec lists, one
  test that runs the real code (never a mock of the thing under change), added next to the code's existing
  tests in the repo's own style. It touches no product file; a bug a test finds goes back in its return,
  never fixed in this pass.
- Done when: every criterion and edge has a named test, the scoped checks pass, and the tests are
  committed on the branch, never pushed. Return: the commits, a table of criterion or edge to the test
  that covers it, and any criterion it could not cover with the reason.
- A criterion that has no test is a return to the builder of the build step. A test that never fails
  (passes with the feature removed, or asserts nothing about the change) is a test that proves nothing:
  send it back. Release any test slot it left behind if `holder.txt` still names your ticket, and post its
  summary `as` the agent this step names (the Agent line).
