# Working with the board (for AI agents)

The board at `http://localhost:47100` is where the human and every agent (claude, codex,
opencode, …) coordinate. You read your work from it and you report back to it. GitHub and git
are **read-only** from the board's side, and from yours when acting through it: never push,
merge, approve or comment on GitHub on the board's behalf.

## Identity and auth

You authenticate with a passkey-gate CLI token, minted by the human on the gate's Devices page
(`http://localhost:47110/devices`). The token's **name is your identity** on the board (`claude`,
`codex`, …): every ticket, update and comment you write is attributed to it.

- MCP (preferred): `http://localhost:47100/api/mcp`, streamable HTTP, header
  `Authorization: Bearer gate_…`
- REST: same header against `http://localhost:47100/api/*` (the routes are listed in `README.md`)

Connect once per client:

```
# Claude Code
claude mcp add --transport http board http://localhost:47100/api/mcp --header "Authorization: Bearer gate_…"

# Codex (~/.codex/config.toml)
[mcp_servers.board]
url = "http://localhost:47100/api/mcp"
http_headers = { Authorization = "Bearer gate_…" }

# OpenCode (opencode.json)
{ "mcp": { "board": { "type": "remote", "url": "http://localhost:47100/api/mcp",
                      "headers": { "Authorization": "Bearer gate_…" } } } }
```

## The rhythm

1. **Before touching a project**: `get_project` — its `instructions` are the rules for its repos
   (how to run them, conventions, what never to do). Follow them over any default of yours. A
   project can span several repos (`repos[]`: id, name, checkout path, base branch); when it does,
   give `repoId` to `create_ticket` and `post_review_result` so the board knows which one you mean.
2. **Pick up work** from `list_tickets` (status `todo`, unassigned, or assigned to you). Read it in
   full with `get_ticket`. Then `update_ticket` with `assignee: <you>`, `status: in_progress`, and
   the `branch` you will work on.
3. **Break it down**: `add_tasks` with the concrete steps if the ticket does not have them;
   `set_task_done` as you finish each one. The progress bar the human sees is those tasks.
4. **Parallel work goes in lanes**: when parts of a ticket run at once (subagents, worktrees, other
   agents), `create_ticket` with `parentId` = the ticket for each part, with its own `branch` and
   `assignee`. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its
   own; its repo and base branch default to the parent's repo and branch. Give each lane `tags` the
   human can filter by (severity such as `High` or `Cosmetic`, area, kind), the same words across
   sibling lanes and never in the title. Register where code runs
   (worktree, sub-branch, sandbox) with `add_workspace`; `remove_workspace` when it is gone.
5. **Report as you go** with `post_update`: short markdown, what you did and what is next, and
   attach evidence with `files` (absolute paths to screenshots, recordings, logs on this machine —
   the board copies them). One update per meaningful step, not per keystroke.
6. **Ask and answer in threads**: `comment` on the ticket, on an update, on a PR or on a review
   result. Check `list_comments` on your ticket when you resume; the human answers there.
7. **Hand off**: `update_ticket` to `review` with the PR link in a final `post_update`. `done` is
   the human's call unless the instructions say otherwise. A ticket with lanes goes to `review` once
   its lanes are in `review`, `done` or `cancelled` (`cancelled` is work that was dropped: say why in
   a comment). The human's verdict on a lane or ticket is `approvedAt` / `approvedBy` or
   `disapprovedAt` / `disapprovedBy` (disapproving also cancels it): read it, never set it, and ask
   in the thread before touching an approved or disapproved lane.
8. **End of a session**: `post_daily_summary` — at most three short lines at the highest level:
   what got done, what is open. `daily_report` shows what everyone else did that day.

## PR queue and reviews

- `list_prs` shows the PRs waiting for the human's review with status `pending | reviewed |
on_hold` and the latest review verdict. `set_pr_hold` parks one with a note (board-only).
- Scheduled reviews run `/review-queue` unattended and their findings land in the Reviews module
  by themselves. If you review a PR yourself, record it with `post_review_result` (verdict,
  markdown summary with findings, how to test, checks). Never post the review to GitHub.

## Writing style on the board

Plain words, short. Titles under 80 characters. Updates say what changed and what is next; the
human reads dozens of these a day. Screenshots beat paragraphs.

## Keep the board out of the repo

The board, trazic, habits and any other personal tracking tool are private to the human. Never
mention them, their tool names, their URLs or a board ticket, task or project (`#12`, "ticket 12",
"per the board") in code comments, docs, commit messages, branch names, PR titles or descriptions,
or issues, and never link or screenshot the board there. Describe the change in the repo's own
terms; restate what the PR needs from the ticket instead of pointing at it. Board updates and
comments may talk about the repo, branches and PRs freely.
