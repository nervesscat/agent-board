Start a subagent briefed as this step's Agent line says (the Team agent it names, with that agent's `instructions` from `get_project`), the project's `instructions`, and the ticket's context (everything the claim step read: its instructions, the human's posts and replies, the decisions and their answers, the attachments). Focus: the acceptance criteria the ticket states, one by one, as its own list of what the draft must say or show. Done when every criterion is met by the draft and the draft is labelled as a first draft in its first line. Return: the draft, and for each criterion where in the draft it is met.

The draft goes to the human only after the self-check, so the subagent writes only what the ticket asks for: no extra claims, no figures or names the ticket does not give, and nothing that needs a source the human has not supplied. A gap in the ticket is written as a question, not filled in.

On a later round (a return from the self-check, or the human's words in a round) the brief carries the findings or the human's words to act on, each with its place in the draft, and the subagent changes only those places.

Post its summary `as` the agent this step names (the Agent line). Post it with `progress: true`.
