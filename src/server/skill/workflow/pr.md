The PR, the project's way (its instructions say how it is assigned), titled and described in the repo's
own terms (no ticket numbers or board links where the repo forbids them), and `update_ticket` with its
`prNumber`. The board ticks PR once it is open.

{{if review}}When a review ran and the PR's head SHA is the SHA whose review survived, record that review on the PR's
ticket so the review queue does not run it again: `post_review_result` with its verdict, its `summary.md`
as `summaryMd`, the `sha`, its checks and counts, and `repoId` when the project has several repos. It
also posts the summary there as a progress post, on the PR's ticket (`ticket` in `list_prs`). Right
before, check `list_review_results` (with `sha`) and the ledger for a newer review of that SHA: post only
when there is none. A newer one that did not survive is not posted over: the change did not survive, and
its findings go back to the builder (the review step).{{end}}
