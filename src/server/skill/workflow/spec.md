A `RETRY` or re-queued run keeps the `WORKDIR/01-spec.md` its first run wrote and posted, unless `RETRY`
names it. A lane of a split ticket whose body carries its part of the parent's spec (**Escalation**)
writes all of that part, Intent and Classification included, to `WORKDIR/01-spec.md`. Otherwise start a
subagent briefed as this step's Agent line says (the Team agent it names, with that agent's `instructions`
from `get_project`), the project's `instructions`, the ticket's context (everything the claim step read:
its instructions, the human's posts and replies, the decisions and their answers, the attachments), and a
brief in four parts, so it reads only what matters. Focus: the
files the ticket names or its words point to, and the repo's rule files (`AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md`). Known (facts it does not rediscover): the worktree and branch, the project's check
commands, `PORTS`, and the repo's rule on what it may mention. Return: the spec's path and its open
questions. Done when: the spec is written to `WORKDIR/01-spec.md` (there is no diff yet). Then:

- `add_tasks` with the acceptance criteria, unless the ticket's tasks already cover them, as the subtasks
  of the ticket's Implementation phase (`parentTaskId` = its id). A ticket with no tasks gets the
  project's default phases first (`add_tasks` with the names from `get_project` → `defaultPhases`).
- Post its result on the ticket `as` the agent this step names (the Agent line; `post_update`, `progress: true`): the intent, the criteria,
  the open questions. Posts made `as` one of the project's agents go to the ticket's Agents tab, the
  agents' working record; the human's tab, Main, gets only the summary, decision cards, your questions to
  them and your replies under their posts. Keep it that way.
- When the ticket has posts by the human that ask for something, answer each under that post (`comment`
  with `replyTo` = its id), never with a new top-level post: a reply with the plan now, and a reply with
  the result and its proofs once it is built (the summary step).
- A **decisive** open question (the answer changes what counts as correct): `ask_decision` with the
  readings as options and the spec's assumption recommended. The card blocks the ticket: move it to
  `blocked` and end the run (`BLOCKER: decision`), never building on the assumption past the open card.
  The card is the human's: this agent never answers it (`answer_decision`), and the BLOCKER line names the
  question. A question that is not decisive takes the spec's assumption, noted in the hand-off.
