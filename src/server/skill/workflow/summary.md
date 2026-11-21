The ticket's summary (`set_ticket_summary`, not a new hand-off post), the one post the human reads on top
of Main, short and to the point: what the change does and its current state, {{if review}}each review round's verdict
in one line, {{end}}the PR link, {{if preview}}the preview link and exactly what to try there{{else}}what to try (the
preview step is skipped for this ticket, so there is no preview link){{end}}, how it was tested (the checks
and the e2e summary; {{if review}}the review's verdict and counts{{else}}the builder's evidence per
criterion{{end}}), any fake used at an edge and any contract hit you judged legitimate, and {{if intent}}the intent check's
verdict in one line{{else}}one line saying the intent check was turned off on
the Workflow page{{end}}, with the screenshots in `files`.

"How it was tested" names the level (`low`, `mid`, `high` or `max`) and the workflow's preset. With a
review it also says which review depth ran and why: the depth, and the measure that put the change there
(lines and files, the classes that decided it), or that the human chose it (`DEPTH`). With no review it
names the gate's results and no review depth.

When a summary is already there (an earlier round, a rework), rewrite it to the state now, with `change`
saying in one line what changed; the board keeps the earlier versions. Then the result reply under each of
the human's posts you answered with a plan (the spec step), with its proofs.
