**This workflow's review is one reviewer, not the full cycle.** The review is invoked
`/feature-review ... phases=reviewer`: one phase agent (the Team agent the reviewer line names; the role is `hunt`), briefed with the
ticket's instructions (the human's words and the acceptance criteria you wrote), the diff at the head and
the gate's results. It runs no spec, environment, verify, refute or merge phase and no second hunt, and
it is not shown a spec file (its only environment file is the small one below).

- There is no environment phase, so `/feature-review` itself prepares the review worktree before the
  reviewer starts: it installs or reuses the dependencies there (a hardlink copy of a prepared
  `node_modules`, never a symlink, or the project's install) and writes a small `00-env.md` with the test
  command and no servers started, and the reviewer is told the test slots' rule for a heavy run. The
  reviewer starts a server only when reproducing a finding needs one or, in round 1 of a UI change with
  the browser flag `yes`, to run the browser probes on the changed pages, from the worktree, on a free port
  it picks, and stops it by its PID before it returns.
- The reviewer reads the diff against the ticket's instructions, runs what it needs to reproduce a
  suspected problem (a probe test, a request, the changed page), and reports each finding in the hunt's
  format with a concrete failure scenario; a finding it could not reproduce is reported as unconfirmed,
  never as a defect. It writes its run report like every subagent.
- **The round survives** when the reviewer reproduced no finding and the builder's evidence covers every
  acceptance criterion (each shows execution of the real code, or is `UNVERIFIED` only for a reason in
  **Escalation**). This replaces the survival rule above: there is no verdict, works check or base check
  in this review. A finding it reproduced goes back to the builder as the next round's fix pass.
- The board's check at the hand-off (`missingReviewPhases`) expects one `hunt` run in the last round and
  nothing else.
