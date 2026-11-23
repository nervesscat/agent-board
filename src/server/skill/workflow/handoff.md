{{if intent}}Only after the intent check returned `matches` on the head being handed off.{{else}}This workflow lists the intent check as skipped for the ticket (a low ticket with the check turned off on the
Workflow page): no intent check is run, none is required before the hand-off, and the summary says it was
turned off on the Workflow page.{{end}} Every item, in order, as the board skill's hand-off checklist says. The board ticks the phases Pushed, PR, CI, Preview, Summary and
Merged itself as their facts hold (a tick by hand is refused); you tick Implementation and its steps
(`set_task_done`).

1. Implementation and its subtasks ticked (`set_task_done`); the workspace registered.
2. `update_ticket` to `review`, and read its answer: `missingRunReports` names each subagent run the
   timeline recorded without its report — a span, a hand-off, or one run too many for the reports of that
   agent and round — so get those reports written before the hand-off stands. The phase agents write
   theirs; you write none of your own. {{if review}}Also read `missingReviewPhases`: each entry is a review phase the last round lacks (`round`, `phase`, `expected`, `found`;
   `expected` is how many runs of that phase this workflow's round needs). Run each missing phase, with a
   fix round through the builder if it needs code, and write its report, before the hand-off stands, while
   the ticket stays in review: moving it out of a review stage, to any other stage, restarts the count
   (only runs after the move count, from round 1). It is a flag, never a refusal, and `[]` is the answer
   when every phase ran. Exception: when the flag names phases of a round that the review step skipped
   because the head SHA's review had already survived (a send-back with no new commit), do not run it
   again: say in the summary which head SHA and which review it reuses, and go on; any other missing phase
   is run.{{end}}
3. Then `open`: fix every task it lists and check again (Summary open: no summary written since the last
   commit). An open Preview may stay only when the summary says why (no preview setup, nothing to try{{if !preview}}, or
   the preview step turned off or not part of this workflow{{end}}). {{if !ci}}This workflow runs no CI step for the ticket (the step is turned off or not part of
   the workflow): it is not run and not required, its phase may stay open, and the summary says so. {{end}}{{if !preview}}This workflow runs no preview step for the ticket (the step is turned off or not part of
   the workflow): it is not run and not required, its phase may stay open, and the summary says so. {{if review}}With no preview, the screenshots of a UI
   change are the review's own (`shots/`, the verify phase); none are
   required when the review took none.{{else}}With no preview and no review, no screenshots are required.{{end}} {{end}}The push, the pull request and the summary are never
   skipped.
