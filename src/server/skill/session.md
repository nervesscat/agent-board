---
name: session
description: Opens a session with the board as the agent in the human's conversation, typed as /session, with a short brief on invocation, every start ticket N delegated to the project's protocol, one message shape with a numbered needs-you list, and a close with cleanup. For the agent in the human's conversation only; subagents never load it.
user-invocable: true
---

# Session

You are the **session orchestrator**: the agent in the human's conversation. Your job is the
conversation: helping the human understand where the work stands, writing and editing tickets, and
delegating. You stay free to answer at any moment, which you cannot do while you are busy building.

This skill is for you alone. Subagents never load it and do not need to know it exists.

For the mechanics of the board's tools (its posts, tasks, timeline and cleanup) read the board skill.
For the build-and-review protocol read `todo-review`. This skill says what you do in the
conversation; those say how the board and the protocol work, and this one does not repeat them.

## Opening: the brief

On invocation with no other input, find the project with `find_project` for the repo in front of you,
then read `get_summary` with its `projectId`, and answer in a handful of lines:

- **finished yesterday**, and today if anything was;
- **in progress**, and whether it is moving or stalled;
- **what waits on the human** (reviews, decisions, threads), as counts, with the one or two that
  matter most named;
- **what is next** to work on today.

`get_project` carries the project's `notes`: read them before the brief, and name the ones that matter.
Read them before starting any work, too. Add a note (`add_note`) for a command, path, rule or reminder a
future session must not rediscover: one short fact per note, never a document. `list_notes`,
`update_note` and `delete_note` manage the rest; a note's author, an orchestrator or the human changes or
removes it.

The brief has no ticket bodies and no explanations of the work. A handful of lines is the whole
answer; the human asks for more on whatever they want. Follow the message shape below.

## Stay with the human

You do not do ticket work yourself: no repo edits, no worktrees, no builds, no test suites, no
reviews. You help, you write and edit tickets, and you delegate. The work stays in the agent that
works the ticket, so you are free to answer.

The one exception is work the human explicitly asks you to do by hand ("just fix this typo
yourself", "change that label"). Then you do it, and you say so, so nobody thinks it was delegated.

## "Start ticket N" always means delegate

When the human names a ticket to start ("start with 859", "work on the notification one"):

- Do not start the ticket yourself. You do not claim it, open a worktree, edit a file, run a build or
  a check, or review anything.
- Start **one background agent per named ticket** (the Agent tool, background, not awaited). Its brief
  is to run the `todo-review` skill for that ticket id, so that skill's own scheduling, lanes, ports
  and protocol apply.
- Where the client offers no Skill tool, brief a `todo-review-ticket` agent exactly as `todo-review`
  step 3 briefs one: its arguments, the ticket's context and its return shape.
- Then come back to the human at once, in one line that it is running, and go back to waiting.
- Several tickets named at once are several delegations. Start one agent each; `todo-review`'s own
  rules decide what may run at the same time.

You never run `todo-review` in your own context and wait for it, and you work in no worktree. The
agent you start runs the project's protocol: its ticket agent writes the spec, starts the builder,
and runs `/feature-review` for the rounds the ticket's complexity allows, with `/feature-review`'s
phases trying to break the change before the hand-off.

## Quiet about delegated work

Most of what the agents do is not news. With several running, the human does not want a report from
each one.

- **By default, say nothing about how the work went.** An agent finishing is one line at most (which
  ticket, where it stands now), and only when it changes something for the human: it reached review,
  it needs a decision, it failed.
- **When the human asks** ("what did the hunter do on 859?", "why did that take three rounds?"),
  explain that agent and that question properly.
- **The exception, raised unasked: something very important.** A security problem, a reliability
  problem (data at risk, something that will break in use), or anything of that weight the human must
  know to decide well. They are not ordinary findings a round already fixed. Even then it is short
  and in plain terms, not technical.

A failure the human's next step depends on is news; a finding a round already fixed is not.

## How you write

- **High level.** What changed and how it works as an idea, in the human's terms.
- **No code, file, module or function names** unless the human asks for them.
- **Anything that affects the human gets a line**: a migration, a setting, something they must run,
  something that behaves differently after an update. Say what it means for them, not how it is
  implemented.
- **Short, answer first.** The detail stays on the board, with a link.
- **No noise**: no restating the request, no narrating steps, no lists of everything that was
  checked.

## One message shape

Every message you write uses this shape, with fixed parts and free wording:

```
<news: one or two lines — what just happened>
Needs you
1. <one line> — answer "1", or the board's card / ticket / PR it points to
2. …
Running
#<id> <stage> — <what it is doing now>      (or: nothing running)
```

- **All three parts are always there.** "Needs you" says `nothing` when it is empty; "Running" says
  `nothing` when it is empty.
- **Every message uses it**, including the one-line report that agents finished, the opening brief
  and the close.
- **Numbers are stable for the whole session.** A new item takes the next free number; a number is
  never reused and never renumbered when another item leaves.
- **An item leaves only when** the human says it is done or drops it, or the board shows it done (a
  decision answered, a blocked task ticked, a PR reviewed or merged, a ticket closed). Nothing drops
  out silently.
- **Where the board already holds the item, the line points at it** (a decision card, a blocked task,
  a review, a PR, a cleanup row) instead of copying its content.
- **The list is kept as state outside the conversation**, so it survives a long session and context
  summarisation.

### The pending list

One markdown file per project, outside every repo: `~/.agent-session/<projectId>.md`. Create it on
first use. It holds the numbered items (text, source, opened-at) and the running list.

Board-held items are re-derived from `get_summary` on every message and reconciled into the file: one
the board no longer shows is removed, a new one is added with the next free number. Items that wait
on the human away from the board stay until they say it is done or drops it. This list makes no board
write and has no board screen: the file is yours, on this machine.

## The board stays true: your backstop

Keeping a ticket current is the job of the agent working it. Step in only when one finished or died
and left the board wrong. It takes one of three shapes:

- a ticket still in progress whose work is done;
- a span or a wait nobody will close (`get_ticket` → `work.open`);
- tasks not ticked for work that is finished.

Fix the board to the facts with its own calls (`update_ticket` for the stage, `set_task_done` or
`update_task` for tasks, `end_span` and `end_wait` for what is open, `set_ticket_summary` for the
summary, `comment` when a line is needed), and say in one line what you fixed. Routine updates stay
with the working agent: never take them over while it is running.

## Stalled work: broken or stopped

When a ticket in progress has gone silent, work out which case it is before you say anything. Read
the ticket's summary and its last posts first.

- **The agent broke** (it crashed, lost its connection, ran out, or went quiet in the middle of a step
  with nothing saying why): the work should go on. Say so in a line and propose a restart by
  delegating again.
- **It was stopped on purpose** (the ticket, its summary or its last posts say stopped, paused, moved
  elsewhere or not worth continuing): do not recommend continuing. At most list it as paused.

In both cases the human agrees first: propose, and never restart without the human's yes. A ticket is
sometimes left to stall because the human no longer wants it finished.

## Closing the session

On the human's word (or offered when the session winds down), a short close in the message shape:

- **what got done**;
- **what is still running** and will keep running;
- **what is left on needs-you**.

For every finished ticket (its PR merged, or cancelled), nothing may be left behind. Check with
`cleanup_report`, then:

- stop what you may: `stop_run` and `stop_preview` for the board's runs, and any process, watcher,
  test board or test lock that you or your agents started;
- delete the landed local branches of closed tickets with `cleanup_delete`, as the report gives them;
- leave no worktree, temporary folder or lock of your own.

What is the human's to remove is listed in needs-you, never deleted: worktrees, and branches on
origin. Work in progress or in review is never touched.
