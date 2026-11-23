/**
 * The text an agent reads on a project with no software kind: the server instructions and the tool
 * descriptions, with the tools and the parameters that only make sense for code left out. The tool list
 * belongs to a connection, so a connection says which project it works on (`?project=<id>` on the MCP
 * URL) and gets this text for a project none of whose kinds is software. Every other connection gets the
 * software text, as before. A test keeps the words of code out of what this text offers.
 */

import type { Kind } from '#/lib/kinds'

/**
 * What the work of each non-software kind is, in a sentence or two: what its files are and how the
 * human checks them. The text an agent reads names only the kinds its project lists.
 */
export const KIND_WORK: Readonly<Record<Exclude<Kind, 'software'>, string>> = {
  music:
    'Its work is music and audio: sketches, demos, stems, masters and the notes that go with them, each as an audio file.',
  art: 'Its work is visual art: sketches, studies, finished images and the notes on them, each as an image file.',
  writing:
    'Its work is writing: drafts, chapters, articles and their edits, each as a document or text file.',
  video:
    'Its work is video: cuts, rough edits, stills, scripts and the notes on them, each as a video, image or document file.',
  research:
    'Its work is research: notes, reading lists, datasets, reports and write-ups, as documents, tables and files.',
  lawyer:
    'Its work is legal work product: drafts of letters, memos, briefs and contracts, and the notes on them, as documents. Nothing here is advice given to a client: a lawyer reviews and signs off every document before it leaves the project.',
  accountant:
    'Its work is accounting work product: workpapers, reconciliations, schedules, memos and reports, as spreadsheets and documents. The figures in the files are checked by the human before anything is filed or sent.',
  cybersecurity:
    'Its work is security work: findings, threat notes, reports and runbooks, and the scripts or configuration snippets that go with them, as files. Its files are kept without version control. A team whose work includes code adds the Software kind to the same project, and the tools for that work appear there. Keep sensitive material (credentials, exploit details, customer data) in the files the ticket names, never in a post.',
  life: 'Its work is a personal life project: plans, checklists, notes, budgets, letters and records of what was done, as documents and files, for the person whose project it is.',
}

/** The sentence about the work of the project's non-software kinds, one per kind it lists. */
export function kindWork(kinds: readonly string[] | null | undefined): string {
  const work = (Object.keys(KIND_WORK) as (keyof typeof KIND_WORK)[])
    .filter((k) => (kinds ?? []).includes(k))
    .map((k) => KIND_WORK[k])
  return work.length > 0 ? work.join(' ') : KIND_WORK.research
}

/** The server instructions for a project with no software kind, for the kinds it lists. */
export function filesInstructions(kinds: readonly string[] | null | undefined): string {
  return `The board is where the human and every agent coordinate work: tickets, their stages, their posts and the files attached to them. This project is not software, so nothing is under version control. ${kindWork(kinds)} Its files are kept in the project's work folder (get_project's workFolder). Read get_project first: its instructions override your defaults, its kinds say what the work is, and its workFolder is the plain folder where work in progress lives.

1. get_project before touching the project. Its stages are the board's columns, in order, each with a key, a name and a kind (open, active, blocked, review, approved, done, cancelled). A ticket's status is a stage key; wherever status is asked for you can also give a stage's name or a kind (a kind means the project's stage of that kind). Below, todo, in_progress, blocked, review, approved, done and cancelled mean the stage of that kind.
2. Read a ticket before you work on it: its summary first (where the last session left off), then its posts, every reply the human wrote under them, its attachments and its tasks. Claim it with claim_ticket.
3. A new ticket starts with the project's phases as its top-level tasks: Implementation, then Summary. Put the concrete steps of the work under Implementation as subtasks (add_tasks with parentTaskId = its id), and tick each one with set_task_done as you finish it. The board ticks Summary itself once you have written the summary after your last post.
4. Work in progress goes in the project's work folder (get_project's workFolder): plain files, one sub-folder per ticket if that helps. Attach what you finish to the ticket: post_update with files (absolute paths to open on this machine). Attached files show on the ticket and in the project's Gallery.
5. post_update after each meaningful step: short markdown, what changed and what is next, with the files it shows as absolute paths in files. Your progress goes to the Agents tab. The human's tab, Main, gets the summary, decision cards and your questions: comment on the ticket, or post_update with progress: false.
6. Hand-off: when the work is finished, write the summary (set_ticket_summary: what the work is, where it stands, which files are attached and what the human should look at first), then move the ticket to review (update_ticket with status review). It answers with any tasks still open: finish them first. There are no agent review rounds here: the human approves the ticket (it is then done) or sends it back (it returns to its work stage, with what they wrote on it). Read their reply and go on.
7. ask_decision when only the human can decide between two valid directions for the work, with the options. Never answer a decision yourself. Keep the ticket's work timeline: heartbeat between steps, start_span and end_span for each phase of the work, and close what you opened before you hand off.
8. The project's agents (get_project: name, instructions, delegation notes) are personas the human defined; a ticket reserved for one is that agent's alone. Delegation notes say when to call each one. To work a ticket as its orchestrator, run each step as a subagent briefed with that agent's instructions and the ticket, and post what it returns as that agent (as: its name).
9. Only the human and an orchestrator change a project's instructions (set_project_instructions); a worker asks its orchestrator. Add a note (add_note) for any fact a future session must not rediscover about the project.

Who is who: every caller has a name and a role (whoami). The human is the human. A subagent passes agentName "<its orchestrator's name>/<its own name>" on every board call, so its posts and claims show under its own name.`
}

/** The tools a connection to a project with no software kind is not offered: they only act on code. */
export const FILES_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'find_project',
  'add_repo',
  'update_repo',
  'delete_repo',
  'set_ticket_repo',
  'get_ticket_git',
  'list_prs',
  'set_pr_hold',
  'post_review_result',
  'list_review_results',
  'get_review_result',
  'add_workspace',
  'remove_workspace',
  'set_preview',
  'start_preview',
  'preview_branch',
  'preview_link',
  'stop_preview',
  'list_runs',
  'start_run',
  'stop_run',
  'add_run',
  'update_run',
  'delete_run',
  'cleanup_report',
  'cleanup_delete',
  // run reports record a builder's or reviewer's run on a diff: the work only software has
  'write_run_report',
  'get_run_report',
  'list_run_reports',
])

/** The parameters of a tool that only a git project uses, left out of the tool's schema for these projects. */
export const FILES_OMITTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  create_ticket: ['repoId', 'branch', 'baseBranch', 'repos', 'prNumber', 'needs', 'defaultPhases'],
  update_ticket: ['repoId', 'branch', 'baseBranch', 'repos', 'prNumber', 'needs'],
  claim_ticket: ['branch', 'repos'],
  list_tickets: ['repoId'],
}

/** The descriptions of parameters shared by many tools, where the software text names code. */
export const FILES_KEY_TEXT: Readonly<Record<string, string>> = {
  tasks:
    "Each item is a task, or {text, subtasks} for a task with the subtasks that go under it. Two levels and no more: the top level is the ticket's phases (a new ticket starts with its project's default phases: Implementation, then Summary), and the concrete steps go under a phase as its subtasks.",
  parentId:
    'make this a lane of that ticket: a parallel piece of it, with its own assignee, tasks and posts. A lane starts without phases unless defaultPhases is true.',
  position:
    "1 is the top: the place in its stage's column, after any status change in the same call; the others keep their order.",
}

/** The descriptions of the tools whose software text names code, for these projects. */
export const FILES_DESCRIPTIONS: Readonly<Record<string, string>> = {
  edit_post:
    'Change a post you made on a ticket (its body, whether it is progress, or its tab of the feed: tab main or agents moves it), or a reply (kind reply: its body). Edits show as edited. A version of the summary is never edited: write a new one with set_ticket_summary. Nor is the body of a request_archive card: ask again instead.',
  get_project:
    "One project with its stages in board order (key, name, kind), its agents (name, instructions, delegation notes, picture; tickets can be reserved for them), notes (the project's short shared facts, each {id, label, body, createdBy, createdAt, updatedAt, position}, a pinned one first: read them before starting and add one for anything a future session must not rediscover), defaultPhases (the top-level phases every new ticket starts with: Implementation, then Summary, unless the project changed them), tagSuggestions, usedTags (the tags its tickets carry, most used first, each in the casing to reuse), kinds (what the work is; a project with no software kind works with files), workFolder (the plain folder where its work in progress and its files are kept), stallMinutes (how many minutes an active ticket may go without a work-timeline event before it reads as stalled), workStage (the key of the active stage claim_ticket goes to), and the instructions agents must follow when working on it (only the human and an orchestrator change them: set_project_instructions). Read this before touching a project.",
  answer_decision:
    "Record the human's answer to a decision card, given in the chat, as the orchestrator. Call it only in the session that talks to the human, after you asked them the card's question in the chat and they answered there. postId: the card's post (get_ticket, or needsYou.decisions in get_summary). option: the index of the option they picked, as the card lists them. words: their answer as they gave it, verbatim. The card is recorded as decided by the human, relayed by you, with their words; the ticket goes back to in progress once nothing else is open. Refused: a human caller; a sub-identity (a call with agentName: a delegated worker); any call with as (one of the project's agents); empty words; an option the card does not have; a post that is not a decision; a card already decided (the human changes it on the board).",
  get_attachment:
    'A file someone attached to a post or reply: name, type, size and the absolute path to open it on this machine. A picture drawn on before it was attached is the flattened picture on disk, and its annotations come with it: the shapes and their numbered notes (items[*].note, in the order the picture numbers them), the document the upload carried. annotations is null for a file nobody drew on. Always read the notes: they say what the marks mean.',
  get_summary:
    "Where a project stands, in one read (without projectId: every project, one block each). needsYou (the tickets being worked in an active, blocked or review stage, the open decisions, the waits on the human, the threads waiting on the human and the tickets in a review stage, and the stalled ones: silent past the project's stallMinutes with nothing open), doneToday (tickets that reached a done stage today and today's activity count), next (the head of the first open stage, with how many are blocked), and carryingOver (tickets in progress since before today, with since, days, lastPost and stale). Today is the board's local day. Read it when starting a session.",
  get_ticket:
    "A ticket in full: its instructions and the files attached to them (each with a local path to open; annotations when the picture was drawn on before attaching, see get_attachment), complexity (how much review it gets: low means none, the human's approval is the review), agent (the project agent it is reserved for, with its instructions; null when shared), tasks (one flat list in tree order: each top-level task followed by its subtasks; parentId is null on a top-level task, else the task it is a subtask of; blocked: true when it waits on the human, blockedReason: what they must do; auto: true on the Summary phase the board ticks itself, which nobody ticks by hand), blockedTasks, its parent chain, its lanes with their last progress post, the feed of posts (updates: newest first, each with tab: main or agents, progress true for a step of the work or false for discussion, summary true on a version of the summary, editedAt, attachments with a local path, and thread: its reply count, last author and time), summary (the one at the top of Main: body, change, at, by, attachments, postId, versions: how many were written, get_ticket_summary has them; fallback: true when none was written yet and the newest agent progress post stands in; null when there is neither), thread on the ticket, on a top-level ticket the human's call (approvedAt/approvedBy or disapprovedAt/disapprovedBy; both null: no call yet; disapproved also means cancelled; a lane never has one), archivedAt/archivedBy, stalled and lastSignalAt as in list_tickets, and work: its work timeline in short (totals, liveness, the spans and waits still open to close with end_span and end_wait, lastHeard). A decision post also carries decidedOption and decidedBy. The summary is where the last session left off; read it before anything else when you pick the ticket up.",
  list_projects: 'All projects on the board, each with its kinds (what its work is) and its id and name.',
  list_tickets:
    "Tickets of a project with status, assignee, reserved (assigned to one of the project's agents: only that agent works it), parentId, complexity (low, mid, high or max: how much review it gets), tags, task progress (own and rolled up over lanes), blockedTasks (its open tasks and subtasks tagged blocked on the human) and blockedNext (true when the next step to work in the ticket, or in a lane it counts, is blocked: when its card badge shows, and Needs you lists that step while the ticket it is on is being worked), lane counts (total, byStage: per stage key), the human's call: approvedAt/approvedBy or disapprovedAt/disapprovedBy (a disapproved ticket is moved to the cancelled stage), startedAt (when work on it last started), lastSignalAt (the latest of its work-timeline events, its agents' posts, startedAt and createdAt), lastWordAt (the latest agent event or agent post), and liveness (its state and the per-agent facts: {state: waiting | working | lost | stalled | idle, agent, phase, since, lastSignalAt, lastWordAt, silentMinutes, spans}; null outside an active stage). Filter with status, tags, parentId or a text to find.",
  create_ticket:
    "Create a ticket (a piece of work) with optional initial tasks. A top-level ticket starts with its project's default phases (get_project's defaultPhases: Implementation, then Summary unless the project changed them): tasks given as plain texts become the steps under the first phase, and {text, subtasks} items are phases of yours that go right after it. With parentId it is a lane of that ticket: a parallel piece of it with its own assignee, tasks and posts, which starts without phases unless defaultPhases is true. defaultPhases false stores the tasks exactly as given. complexity sets how much review the ticket gets (low, mid, high or max: low none, mid one review round, high three, max up to ten for work built from scratch; a ticket of a project with no software kind is low unless you say otherwise, and a lane without one copies its parent's).",
  update_ticket:
    "Change a ticket's status, assignee, tags, title, instructions or complexity (the review level, low, mid, high or max), or where it sits in its board column (position). Use claim_ticket to pick a ticket up. Changing the assignee of a ticket reserved for one of the project's agents fails: only the human reassigns those. Status blocked means you are waiting on the human: say what for in a comment on the ticket. A move to a review stage goes through and answers with open: [{taskId, ticketId, text, auto}], every task and subtask still open, in tree order (the Summary phase included when no summary was written since your last post); fix what it lists. position puts the ticket at that place (1 is the top) in its stage's column, after any status change in the same call; in a review stage the column's order is the order the human reads them in, top first.",
  claim_ticket:
    "Pick a ticket up: assigns it to you (or, with as, to the project agent you work it as) and moves it from an open or blocked stage to the stage work starts in (get_project's workStage, else the first active stage). Returns the ticket row; read its summary with get_ticket before anything else. A shared ticket someone else holds is taken over from them. Fails when the ticket is reserved for one of the project's agents and as is not that agent, or when it is in a done or cancelled stage.",
  add_tasks:
    "Append tasks to a ticket. Each item is a task, or {text, subtasks} for a task with the subtasks that go under it. Two levels and no more: the top level is the ticket's phases (a new ticket starts with its project's default phases: Implementation, then Summary), and the concrete steps go under a phase as its subtasks, the work's under Implementation. With parentTaskId (a top-level task of this ticket, such as Implementation) they are added as subtasks of it: the way to put the steps under a phase. Without parentTaskId they are phases, appended at the end. An item given as an object can also come tagged blocked: {text, blocked: true, blockedReason} (its subtasks stay plain texts; tag those with update_task). blocked: true tags the task as waiting on the human (a call only they can make, a manual action), blockedReason says what they must do.",
  set_task_done:
    "Tick or untick a task or a subtask. A task with subtasks is done exactly when all of them are: ticking or unticking it does the same to its subtasks, ticking its last open subtask ticks it, and unticking one of them unticks it. A done task waits on nobody: ticking clears its blocked tag, and that of every task the tick reaches; unticking does not bring a tag back. Summary at the top level (auto: true on get_ticket) is ticked by the board from the ticket's posts: ticking or unticking it is refused.",
  update_task:
    'Reword a task or a subtask, tick / untick it (ticks keep a task and its subtasks in step, as set_task_done says), or tag it blocked on the human and clear that. When a step needs the human (a call only they can make, a manual action), set blocked: true with blockedReason saying what they must do, and keep working on the rest; blocked: false clears the tag and its reason once resolved (ticking it done clears it too). Tagging a done task reopens it, as unticking would. The Summary phase (auto: true on get_ticket) takes no done here. The tag is for one step that needs a human action that is not a question; a question to the human blocks the whole ticket right after it is posted (update_ticket to blocked, or an ask_decision card), and the work ends.',
  set_ticket_summary:
    "Write the ticket's summary: the one post at the top of the feed's Main tab, for the human, and the hand-off (the board ticks the Summary phase while an agent's version is newer than the ticket's last post). Short and to the point: what the work is, where it stands now, the files attached and what to look at first, and the proofs as files. Rewrite it to the current state instead of posting a new hand-off: each write replaces it, and the board keeps every earlier version as its history. A new version replaces the previous one in wording, never in facts: carry forward every section and fact that still holds, keep the attached files that still show the current state, and add what changed this time (change, one line) instead of deleting the rest; if a fact no longer holds, say what replaced it. change says in one line what changed since the last version (required from the second version on), shown as \"updated <time>: <change>\". Like a new post, every write bumps the ticket and reaches the human's Needs you and the inboxes. Returns the summary as get_ticket shows it.",
  start_span:
    "Start a span of work on a ticket: a phase of the work (for example draft, build, verify, or any other words; the stored name is lower case), with round for a review round (1 to 20). Start one at the beginning of each phase and end it (end_span) when the phase is done; it shows as a segment of the ticket's work timeline on the Roadmap and the ticket page, and counts as working time. Returns spanId.",
  get_live_work:
    "What is happening on a project right now, in one read, for a session that is starting: liveNow (the tickets and lanes with an open span or wait, or an agent event such as a heartbeat inside the window: each with ticketId, title, status, stage, parent, agents (names), phase and round of the open span, lastHeardAt and lastHeardBy, silentMinutes, waitingFor ({reason, note, agent, on, since} or null) and stalled), recentlyActive (the rest that were heard from, nothing running now, newest first, at most 10), waitingOnHuman (open decision cards, next-step tasks tagged blocked, and tickets in a blocked stage: one line each, postId or taskId, a ticket listed once), inReview (tickets in a review stage: the latest recorded call and the time they reached review), recentPosts (the last 10 posts across the project, newest first: author, ticket, time, first line), and totals. now is the clock every duration was measured against, windowMinutes the window used (the project's stallMinutes unless windowMinutes is given), stallMinutes the project's threshold.",
  list_gallery:
    "The project's files, newest first unless sort says otherwise (oldest, name, name-desc, largest, smallest, type): every file on its tickets' posts, on the replies under those posts and with their instructions, each with name, type, kind, size, who uploaded it and when, the absolute path to open it on this machine, its annotations when the picture was drawn on before attaching (see get_attachment), its ticket (id, title: for a lane's file, the top-level ticket), lane (id, title of the lane that holds it, or null), where it is (source: post, reply or instructions, with postId and commentId) and anchor (the #hash of the ticket page's link to that post or reply). Files of archived tickets only with archived: include. A page at a time: pass next back as cursor for the next one, null after the last.",
}
