**This workflow reviews every round twice, by different agents.** Each round is two complete reviews and
a reconciliation, and the Thorough additions hold in each (the third hunt with the security checklist,
and the intent check at the end of the round).

- Run `/feature-review` twice for the round: the first review and the second review, as two separate runs
  with the `phases=` argument this workflow gives, each under its own agent name (the first review as
  `agent=<your name>/review-first` and the second as `agent=<your name>/review-second`, passed to
  `/feature-review`, so the timeline, the run reports and the phase agents of each stay apart). Neither is shown the other's findings, results or
  folder: the second review must not inherit the first one's reading. They may run at once, but each
  takes its own test slots, one heavy run at a time.
- **The two reviews each carry the round number** (`round=<n>`), so the board counts the phases of both:
  the last round needs twice the runs of one review (`missingReviewPhases` says how many).
- **Reconcile** before deciding the round, yourself: read both reviews' verdicts, findings and failed
  criteria. A finding either review confirmed goes to the builder; a finding only one review reported is
  read against the code and kept when it reproduces. Where the two verdicts differ, the worse one decides
  until the difference is explained: never average them. Write the reconciliation to the round's folder
  (`WORKDIR/round-<n>-reconcile.md`) and post it `progress: true`.
- **The round survives** only when both reviews survive, the reconciliation leaves no finding open and
  the intent check at the end of the round matches. A `does not match` is an ordinary round of the
  budget, as the Thorough review says.
