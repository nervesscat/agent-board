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
  the diff, the human's own words; nothing else). A `does not match` makes the round not survive: its
  lines go to the builder as the round's findings, and the next round is an ordinary round of the budget
  (this replaces the intent step's rule that a `does not match` is outside the budget; the intent step's
  second-`does not match` rule still holds). The round survives only when the review's survival rule holds
  and the intent check matches.
