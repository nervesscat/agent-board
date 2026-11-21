**This workflow's review is one reviewer, not the full cycle.** The review is invoked
`/feature-review ... phases=reviewer`: one phase agent of the project's `hunt` role, briefed with the
ticket's instructions (the human's words and the acceptance criteria you wrote), the diff at the head and
the gate's results. It runs no spec, environment, verify, refute or merge phase and no second hunt, and
it is not shown a spec file or an environment.

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
