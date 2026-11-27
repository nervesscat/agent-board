The ticket's summary (`set_ticket_summary`, not a new hand-off post), the one post the human reads on top
of Main, short and to the point: what the change does and its current state, {{if review}}each review round's verdict
in one line, {{end}}the PR link, {{if preview}}the preview link and exactly what to try there{{else}}what to try (the
preview step is skipped for this ticket, so there is no preview link; the summary says the preview was turned off on the Workflow page){{end}}, how it was tested (the checks
and the e2e summary; {{if review}}the review's verdict and counts{{else}}the builder's evidence per
criterion{{end}}), any fake used at an edge and any contract hit you judged legitimate, and {{if intent}}the intent check's
verdict in one line{{else}}one line saying the intent check was turned off on
the Workflow page{{end}}, with {{if preview}}the screenshots in `files`{{else}}the screenshots of a UI change in `files`, which come from the review's own
run (its `shots/` folder, the verify phase){{if !review}}, if it took any (this ticket has no review){{end}}, since the preview that would take them is turned off{{end}}.{{if review}}

**A fix no review saw.** When the hand-off carries a fix made after the workflow's last review round (the
review step's budget: a round that did not survive, its one fix pass and a gate that passed, with no
review after it), the summary's first line is exactly `Unreviewed fix: <what>, at <sha>`: `<what>` names
the findings that fix addressed and the criteria it fixed (each one that round failed, with the
builder's evidence checked at the gate), in a few words, and `<sha>` is the head commit handed off (its short SHA,
at least 7 characters). The next line is a one-line offer of one more review round, such as "Reply here
asking for one more review round to have it reviewed once more." The human takes it by replying asking
for it, under the summary or in a comment; no decision card is posted for it and the ticket does not
wait on it. A summary with no such fix has no such line, and one written after a round that survived
drops it.{{end}}

"How it was tested" names the level (`low`, `mid`, `high` or `max`) and the workflow's preset. With a
review it also says which review depth ran and why: the depth, and the measure that put the change there
(lines and files, the classes that decided it), or that the human chose it (`DEPTH`). With no review it
names the gate's results and no review depth.

When a summary is already there (an earlier round, a rework), rewrite it to the state now, with `change`
saying in one line what changed; the board keeps the earlier versions. Then the result reply under each of
the human's posts you answered with a plan (the spec step), with its proofs.
