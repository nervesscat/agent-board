**This workflow's review adds two things to every round.**

- **A third hunt with the security checklist.** Besides hunts A and B, one more hunt runs in every round
  (`hunt-security` in `phases=`), briefed to look only at security: authentication and authorisation of
  every route and tool the change touches, injection (SQL, shell, path, template), unsafe or unvalidated
  input, secrets and tokens in code, logs or responses, data exposed to the wrong caller, and a weaker
  default than before. Like the other hunts it is independent (never shown their findings), reports
  candidates with a concrete failure scenario and goes through the refute phase with the rest. The board
  counts it as a `hunt`: the last round needs three.
- **The intent check at the end of every round**, not only before the hand-off. After the round's review
  returns, run the intent step's check on the head as it stands (the preview and screenshots of that head,
  the diff, the human's own words; nothing else). **The preview comes first:** the preview step is later
  in the order, so in a round where no preview runs for this head yet, you start it now, exactly as the
  preview step says to start it (the board's own run, or the artifact), wait for it to run and take the
  screenshots of the changed state. The preview step, when it comes, finds that preview running for the
  same head and reuses it: a head is never built twice for the preview, and a new commit (a fix round) is
  the only thing that starts a new one. When the workflow lists the preview step as skipped, there is no
  preview: brief the check with the review's own screenshots and the diff. A `does not match` makes the
  round not survive: its lines go to the builder as the round's findings, and the next round is an
  ordinary round of the budget. **This is the budget rule in this workflow**: it replaces the intent step's
  rule that a `does not match` is outside the budget (and the review step's sentence about an intent
  return); the intent step's second-`does not match` rule still holds. The round survives only when the
  review's survival rule holds and the intent check matches.
