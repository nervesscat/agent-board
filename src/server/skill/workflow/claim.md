1. `get_project` (`PROJECT`): its `instructions` win over your defaults; its `agents` are the team, and
   their `delegation` notes say when to call each and their `instructions` are what you brief a step's
   agent with: the workflow names, for each step that runs an agent, the Team agent that runs it (the
   human's pick on the Workflow page, else the Team agent named like the step's role, else the built-in
   role) and its instructions are written on the Team page only. A ticket the workflow gives no spec step
   needs no spec agent; when a step's agent has no instructions and none of the Team's agents fits it, stop
   with `STATUS: error` and say which step had no agent.
2. `get_ticket`: the instructions, the attachments (read each image and file at its local `path`: a
   ticket with an empty body and a screenshot is a bug report), the posts, the answered decisions, and the
   **summary first** when there is one. Read every post and each reply under it (`list_comments` with the
   post's `parentType: update` and id), the human's above all: they are part of the ticket, not
   background. This is the ticket's context, and every brief you write carries it: its instructions, the
   human's posts and replies, the decisions with their answers, and the attachments. Say the subagent may
   read the rest itself with `get_ticket` and `list_comments`. Its `complexity` is this run's level: the
   board's value wins when it differs from `COMPLEXITY`, and `NOTES` says so. You never change a ticket's
   complexity or its workflow preset. On `RETRY`, start from the summary and posts and fix what `RETRY`
   names before anything else.
3. Branch. The ticket's **own** branch is the `branch` that `get_ticket` showed in item 2, before this run
   claimed anything (a `RETRY` or re-queued run finds the one its first run claimed). Without one, choose
   a **new** name: three or four words saying what the change does, kebab-case
   (`align-author-with-text`), with no ticket number in it, that
   `git -C REPO branch -a --list <name> "origin/<name>"` does not list. Another ticket of this repo may be
   choosing a name at the same moment, so a new name is yours only once item 4 has created it.
   `claim_ticket` with it (and `as: AS` when given).
4. Worktree next to the main checkout: `<path>` = `<REPO>/../<repo folder>-<branch>`. Never work in a
   worktree that is not registered in this ticket's `workspaces`: it is someone else's.
   - Own branch: reuse the worktree registered in this ticket's `workspaces` when it is still on disk and
     on that branch (`git -C <its path> rev-parse --abbrev-ref HEAD` prints `<branch>`; a workspace left
     on an earlier branch of the ticket does not count). Else `git -C REPO fetch origin BASE`, then
     `git -C REPO worktree add <path> <branch>` when the branch exists, or
     `git -C REPO worktree add -b <branch> <path> origin/BASE` when it does not. Git refusing because the
     branch is checked out in another worktree, or because the path exists, means someone else works on
     it: return `STATUS: error` with that worktree's path in `NOTES`.
   - New name: reuse nothing, even a branch or worktree of that name that exists by now.
     `git -C REPO fetch origin BASE`, then `git -C REPO worktree add -b <branch> <path> origin/BASE`.
     Creating the branch is what makes the name yours: when it fails because the branch or the path
     already exists, another ticket took the name in the meantime. Choose another new name,
     `claim_ticket` again with it, and create again.

   Both git commands write to the shared checkout's git: a lock error is retried (**Shared with the other
   tickets of this repo**). Install the way the project's instructions say, and keep `node_modules` warm
   by hardlink rather than a symlink: copy the project's prepared copy into a real directory with
   `cp -al <prepared>/node_modules <path>/node_modules` (never a symlink or a junction: a link breaks the
   board's preview install, which cannot purge through one), then `pnpm install --offline` (or the
   project's offline install) only when the lockfile differs from that copy. `add_workspace` with its
   `path` and `branch` at once.
