{{if firstSpec}}A second spec, written by a second, independent spec agent, so a reading the first one missed is caught
before anything is built.

- Start it the way the spec step starts the first, with the same brief (the **spec** agent's
  `instructions`, the project's `instructions`, the ticket's context, Focus, Known, Return, Done when),
  but with its own file, `WORKDIR/01-spec-2.md`, and **never show it the first spec** or its open
  questions: it must not inherit that reading. The two may run one after the other or at once; neither
  waits on the other's result.
- Reconcile them yourself, once both are written: the spec the builder gets is `WORKDIR/01-spec.md`,
  rewritten as the union of the two sets of criteria, the stricter reading kept where they differ, with a
  line under each criterion that only one spec had saying which. A criterion both wrote differently is not
  averaged: take the one that is testable, and say why.
- Where the two readings lead to different products (the answer changes what counts as correct), that is
  a decisive open question: `ask_decision` with both readings as options, the more cautious one
  recommended; the card blocks the ticket as the spec step says. Where they differ only in detail, take
  the stricter one and note it in the hand-off.
- `add_tasks` and the post `as: spec` come once, from the reconciled spec, not from each. Post the
  reconciliation too (what each spec added), `as: spec`.{{else}}The spec step is skipped for this ticket, so this is the only spec: there is no first spec to reconcile
with, and the spec the builder gets is this one, written to `WORKDIR/01-spec.md`.

- Start a subagent briefed with the **spec** agent's `instructions`, the project's `instructions`, the
  ticket's context (everything the claim step read: its instructions, the human's posts and replies, the
  decisions and their answers, the attachments), and a brief in four parts: Focus (the files the ticket
  names or its words point to, and the repo's rule files), Known (the worktree and branch, the project's
  check commands, `PORTS`, the repo's rule on what it may mention), Return (the spec's path and its open
  questions) and Done when (the spec is written to `WORKDIR/01-spec.md`; there is no diff yet).
- Then `add_tasks` with its acceptance criteria as the subtasks of the ticket's Implementation phase
  (`parentTaskId` = its id), unless the ticket's tasks already cover them, and post its result `as: spec`
  (`post_update`, `progress: true`): the intent, the criteria, the open questions.
- A **decisive** open question (the answer changes what counts as correct): `ask_decision` with the
  readings as options and the spec's assumption recommended; the card blocks the ticket (`BLOCKER:
  decision`), and this agent never answers it. A question that is not decisive takes the spec's assumption,
  noted in the hand-off.{{end}}
