After the last review round passes (a ticket with no review: after its gate and evidence) and before
every hand-off. It runs again after any human comment that sent the ticket back (a `RETRY` or a re-run
that finds one among the ticket's posts, newest last).

It is the project's `intent` agent (its `delegation` notes route it; else `feature-review-intent`),
started with the Agent tool at this step's effort (`low` unless the human set another). Brief it with only
two things:

- the human's own words and attachments: the ticket's instructions and every post and reply by the human,
  newest last, and the human's own answer on each decision card (the option they picked and their words,
  as the human's own reply), the latest comment that sent the ticket back weighing most, with their
  attachments;
- the result: the preview link (from the preview step), its screenshots or recordings, and the diff at
  the current head.

Never give it the builder's plan, the spec, the review's findings or the options an agent put on a card:
it must not inherit their reading. It returns one line per thing the human asked (`done as asked`,
`done differently (how)` or `not done`, with the evidence) and a verdict, `matches` or `does not match`. It
never asks the human, builds and edits nothing, and never answers a decision (`answer_decision`); it
writes its run report like every subagent.

- `matches`: go on. Any commit after a `matches` (a CI fix, a rebase or a merge of the base) changes the
  head, so the intent check runs again on the new head before the hand-off stands.
- Before every re-run of the intent check (after a `does not match` fix round or any new commit) go
  through the preview step again at the head being handed off: the preview for that head runs and fresh
  screenshots of the changed state are taken; brief the check with those, never the old head's.
- `does not match`: back to the builder with the intent check's lines as the brief, then your gate, then
  ONE more full review round (the review's phases all run again; a ticket with no review has only the
  gate), then the intent check again. A `does not match` is not a gate return and is outside the
  complexity's round budget. After the SECOND `does not match` on one ticket, stop and ask the human with
  `ask_decision` (keep going, ship as is, drop), with the intent check's lines and the human's words on
  the card.
- Earlier than that the human is asked only when two readings of their words are both plausible and give
  visibly different results: both readings on the card (`ask_decision`), never otherwise.
