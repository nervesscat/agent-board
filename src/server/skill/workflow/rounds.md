The human rounds are the ticket's own conversation with the human about the draft, and this step runs no agent. Each round:

1. Post the draft (the build's and the self-check's result) on the ticket as an update with `progress: true`, saying what it is and what the human should check. Put any file the draft is in on the ticket as an attachment.
2. Wait for the human's reply on the ticket: read the posts and each reply under them (`get_ticket`, `list_comments` with the post's `parentType: update` and id). A reply is one round's words; a reply that asks for nothing more closes the rounds.
3. Take the human's words as they are written. Revise the draft in the build's own working copy only what they ask for, run the self-check again on the changed parts, and post the revision (`progress: true`) with what changed, one line per change.

The rounds end when the human says the draft is done, or when the human's reply asks for the hand-off. A round that the human has not answered is not a reason to start another: post the draft once and leave the ticket in its state until the next reply. Never invent the human's answer, and never choose between two readings the human did not settle: put the question on a decision card (`ask_decision`) and wait for its answer.
