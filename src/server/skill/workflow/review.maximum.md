**This workflow reviews every round twice, by different agents.** Each round is two complete reviews and
a reconciliation. {{if roundIntent}}The two additions above hold: the third hunt with the security checklist runs in each
of the two reviews (it is in the `phases=` of both), and the intent check at the end of the round {{if preview}}(with
the preview of the head started first, as described above) {{end}}runs once, after the reconciliation, not once
per review.{{else}}The addition above holds: the third hunt with the security checklist runs in each
of the two reviews (it is in the `phases=` of both).{{end}}

- Run `/feature-review` twice for the round: the first review and the second review, as two separate runs
  with the `phases=` argument this workflow gives, each under its own agent name (the first review as
  `agent=<your name>/review-first` and the second as `agent=<your name>/review-second`, passed to
  `/feature-review`, so the timeline, the run reports and the phase agents of each stay apart).
  `/feature-review` gives each run its own working folder from that name: for target `<branch>` and the
  agent name `<your name>/review-first` the first run's folder is
  `~/.claude/feature-review/<repo-dir>-<branch>-review-first/` (its `review.md`, `summary.md`, verdicts
  and worktree), and the second's is `.../<repo-dir>-<branch>-review-second/`; each has its own claim,
  worktree and ledger line (which names its agent). Neither is shown the other's findings, results or
  folder: the second review must not inherit the first one's reading. They may run at once, but each
  takes its own test slots, one heavy run at a time.
- **The two reviews each carry the round number** (`round=<n>`), so the board counts the phases of both:
  the last round needs twice the runs of one review (`missingReviewPhases` says how many).
- **Reconcile** before deciding the round, yourself: read both reviews' verdicts, findings and failed
  criteria, from each review's own `review.md` in its folder above (the first's and the second's). A finding either review confirmed goes to the builder; a finding only one review reported is
  read against the code and kept when it reproduces. Where the two verdicts differ, the worse one decides
  until the difference is explained: never average them. Write the reconciliation to the round's folder
  (`WORKDIR/round-<n>-reconcile.md`) and post it `progress: true`.
- **The round survives** only when both reviews survive and the reconciliation leaves no finding open{{if roundIntent}}, and
  the intent check at the end of the round matches. A `does not match` is an ordinary round of the
  budget (the budget rule above: it replaces the intent step's rule that it is outside the budget){{end}}.
