import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { COMMENT_PARENTS } from '#/lib/constants'
import { addSummary } from './activity'
import { listActors } from './actors'
import { cleanupReport } from './cleanup'
import { dailyReport, today } from './daily'
import * as features from './features'
import { HttpError } from './http'
import * as prs from './prs'
import * as projects from './projects'
import * as reviews from './reviews'
import * as uploads from './uploads'

/**
 * The same board, as MCP tools. Stateless streamable HTTP: one server per request, closed over the
 * actor the gate identified, so every write is attributed to the agent's token name.
 */

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})
const fail = (err: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: err instanceof HttpError ? err.message : 'internal error, see the board log',
    },
  ],
})

/** Sent to every client on connect, so agents in any repo know the rhythm without reading AGENTS.md. */
const INSTRUCTIONS = `The board is where the human and every agent coordinate work. You read work from it and report back to it. Git and GitHub are read-only through the board: never push, merge, approve or comment on GitHub on its behalf.

Work only in the project of the repo you are in, and never read or write another project's tickets, PRs, reviews or daily log. If a board skill or the repo's own instructions name your projectId, use it directly. Only otherwise, call list_projects once and pick the project whose repos include yours (match the GitHub slug from git remote get-url origin, then the folder name; the board may list Linux paths while you are on Windows); if none does, do not use the board for this repo.

The rhythm:
1. get_project before touching it; its instructions override your defaults. Its stages are the board's columns, in order, each with a key, a name and a kind (open, active, blocked, review, done, cancelled). A ticket's status is a stage key; wherever status is asked for you can also give a stage's name or a kind (the first stage of that kind; todo and in_progress mean open and active). Below, todo, in_progress, blocked, review, done and cancelled mean the stage of that kind.
2. Pick up work from list_tickets (status todo, assignee "" or your name from whoami); read it with get_ticket; then claim_ticket with the branch. Tickets are shared: you may take over one another agent holds (the board logs it), so prefer unassigned ones and take over only what is clearly stalled or handed to you. A ticket with reserved: true belongs to one of the project's agents (see below).
3. add_tasks with the concrete steps if the ticket has none; set_task_done as you finish each; update_task or remove_task when the plan changes.
4. Split parallel work into lanes: when a ticket needs several pieces worked at once (subagents, worktrees, other agents), create_ticket with parentId = the ticket for each piece, with its own branch and assignee. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its own. Tag each lane (tags) so the human can filter them: severity, area or kind, the same words across sibling lanes, not in the title. add_workspace registers where code runs (a worktree, a sub-branch, a sandbox): register every worktree you open, since that list is what gets cleaned up later; remove_workspace when it is gone.
5. post_update after each meaningful step: short markdown, what changed and what is next, with screenshots or logs as absolute file paths in files. A ticket has one feed of posts: post_update adds one marked as progress (lane summaries and the Daily view pick those out); questions and answers are posts too (comment on the ticket, or post_update with progress: false). Every post can have replies (comment on the post's id with parentType update). edit_post and delete_post change what you posted. When the change can be tried (a page, an API), start a preview the human can open before anything is merged: your branch, from your worktree, on a free port, with a copy of the data rather than the real one (the project's instructions say how). Post its link (http://localhost:<port>) with what to try and register it on that worktree's workspace (set_preview, or previewUrl on add_workspace): the ticket page then shows it with an Open button and whether it is running. Say that what they post there stays in the copy, keep it running while the ticket is in review, and stop it once it is merged or dropped, clearing it with set_preview "".
6. Ask and answer with comment. When you cannot go on without the human, comment your question on the ticket and update_ticket to blocked; back to in_progress once answered. When it is a choice between clear options (an approach, a trade-off, a scope call), ask_decision instead: the human answers with one click, and the ticket blocks and unblocks by itself. When you resume, and between steps, list_my_threads shows every ticket feed or reply thread where someone spoke after you; get_ticket shows each post's reply count and last author. Files on posts and replies come with a local path you can open.
6. Ask and answer in threads with comment. When you cannot go on without the human, comment your question on the ticket and update_ticket to blocked; back to in_progress once answered. When you resume, and between steps, list_my_threads shows every thread where someone spoke after you; get_ticket shows each thread's comment count and last author. Files in threads and updates come with a local path you can open.
7. Hand off: open the PR assigned to the human (gh pr create --assignee <their login>, or --assignee @me when you push with their account: GitHub never lets a PR's author be its requested reviewer, and the PR queue lists PRs assigned to them), update_ticket with its prNumber (links the ticket and the PR queue both ways), a final post_update with the PR link, then update_ticket to review. done is the human's call. cancelled is for work that was dropped: say why in a comment. A ticket with lanes goes to review once its lanes are in review, done or cancelled. The human's verdict on a lane or ticket is approvedAt/approvedBy (approved) or disapprovedAt/disapprovedBy (disapproved, which also cancels it; approving a ticket tagged PR, a PR review, also moves it to done); you can read it, never set it. Treat an approved lane as settled and a disapproved one as dropped: ask in its thread before touching either. Archiving is the human's too: archivedAt set means the ticket (lanes included) is finished and off the board, and list_tickets leaves it out unless you pass archived.
8. Clean up after yourself: once a lane's work is in its parent's branch (or a ticket's in its base), and before moving it to done, remove its worktree and delete its local branch, remove_workspace, and post_update the deleted branch names with their commit hashes (e.g. lane/47 @ 9ec12e8b) so any of them can be restored. get_ticket_git says whether each branch's work arrived (reach); cleanup_report lists every leftover in the project. Never delete a branch whose reach is unique without the human's go-ahead, and never delete branches on origin: list them for the human.
9. End of session: post_daily_summary, at most three short lines.

The project's agents: get_project lists them (agents: name, instructions, delegation notes, picture). They are personas the human defined, not connected tools; you work for them. A ticket assigned to one (reserved: true; get_ticket's agent has its instructions) is that agent's alone: claim_ticket with as: <its name>, brief a subagent with its instructions (and the ticket's), and post that work with post_update and comment using as: <its name>, so it shows under the agent's name, via you. Never take a reserved ticket as yourself, reassign it, or work it without the agent's instructions; only the human reassigns it. A thread can wait on an agent too: when someone @mentions it, or replies on its ticket or post, list_my_threads returns that thread with as: <its name>; answer it with comment as: <its name>, in that agent's voice and instructions. Orchestrating: each agent's delegation notes say when to call it, what to give it, what it returns and what comes next. With them you can work a ticket as its orchestrator instead of doing the work yourself: run each step as a subagent briefed with that agent's instructions, the project's instructions and the ticket; post what it returns on the ticket as that agent (as: <its name>, progress: true); go where its notes say next. The default set (spec, builder, runner, and the review phases env, verify, hunt, refute, merge) is the cycle spec → build → review that tries to break it → build again with the confirmed findings (at most three rounds) → hand off; the /review-queue skill runs it (/feature-review is its review). Ask the human with ask_decision instead of guessing, never run two builders on one branch, and never delegate to an agent without delegation notes. The board skill has the full routine.

When a project has several repos, pass repoId to create_ticket and post_review_result. Plain words, titles under 80 characters; the human reads dozens of these a day.

Keep the board out of the repo. The board, trazic, habits and any other personal tracking tool are private to the human: never mention them, their tool names, their URLs (localhost:47100, 47110) or a board ticket, task or project ("#12", "ticket 12", "per the board") in code comments, docs, READMEs, changelogs, config, commit messages, branch names, PR titles or descriptions, or issues, and never link or screenshot the board there. Describe the change and its reason in the repo's own terms; if the PR needs something from the ticket, restate it instead of pointing at it. Board updates and comments may talk about the repo, branches and PRs freely.`

const STATUS =
  'a stage key from get_project, a stage name, or a kind (open, active, blocked, review, done, cancelled; todo and in_progress also work): the first stage of that kind'
const AS = z
  .string()
  .optional()
  .describe("one of the project's agents (get_project): post under its name, as the work you did for it")
const PREVIEW_URL =
  'where the branch runs for the human to try, http(s) only: http://localhost:<port> (the board checks whether localhost links are up)'
const TAGS =
  'Short labels the human filters lanes by: a severity (Critical, High, Medium, Low, Cosmetic), an area (API, UI, Forms…) or a kind (Bug, Refactor…). One or two words each, Title Case; reuse the tags sibling lanes already use, and keep them out of the title (no "[High] …").'

function buildServer(actor: string) {
  const server = new McpServer({ name: 'agent-board', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => unknown,
  ) => {
    const cb = (async (args: unknown) => {
      try {
        // Every file handed to an agent is on this machine to open (with STORAGE=s3, fetched if needed).
        return text(await uploads.ensureLocalFiles(await run(args as z.infer<z.ZodObject<S>>)))
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(`mcp ${name} failed:`, err)
        return fail(err)
      }
    }) as ToolCallback<S>
    server.registerTool(name, { description, inputSchema: shape }, cb)
  }

  tool('whoami', 'The name the board knows you by (your gate token name).', {}, () => ({ actor }))

  // projects
  tool(
    'list_projects',
    'All projects on the board, each with its repos (id, name, checkout path, GitHub slug, base branch).',
    {},
    () => projects.listProjects(),
  )
  tool(
    'get_project',
    "One project with its repos, its stages (the board's columns in order: key, name, kind), its agents (personas with a name, instructions, delegation notes saying when the orchestrator should call them, and a picture; tickets can be reserved for them) and the instructions agents must follow when working on it. Read this before touching a project.",
    { projectId: z.number().int() },
    ({ projectId }) => projects.getProjectFull(projectId),
  )

  // PR queue
  tool(
    'list_prs',
    'Open PRs assigned to the human for review across all repos of the project, with status pending | reviewed | on_hold, the repo, and the latest review verdict. waitingOn is me (review requested from the human, or assigned to them and not reviewed by them at its head) or others. Where it stands on GitHub as of the last refresh: merge (clean | conflicts | behind | blocked | checking), ci (passing | failing | pending | none) with checks[] {name, state pass | fail | pending | skipped, url}, reviewDecision and isDraft.',
    {
      projectId: z.number().int(),
      refresh: z.boolean().default(false).describe('re-query GitHub before answering'),
    },
    ({ projectId, refresh }) => prs.listPrs(projectId, { refresh }),
  )
  tool(
    'set_pr_hold',
    'Put a PR on hold with a note (or release it). Board-side only; GitHub is never written.',
    { prId: z.number().int(), hold: z.boolean(), note: z.string().default('') },
    ({ prId, hold, note }) => prs.setPrHold(prId, hold, note, actor),
  )
  tool(
    'post_review_result',
    "Record the outcome of a PR review you performed: verdict plus a markdown summary (findings, how to test, checks). The human reads it from its verdict on the PR queue and on the ticket's Branch card.",
    {
      projectId: z.number().int(),
      prNumber: z.number().int(),
      sha: z.string().describe('head SHA that was reviewed'),
      verdict: z.string().describe('e.g. SHIP, FIX FIRST, COULD NOT VERIFY'),
      summaryMd: z.string(),
      checks: z.record(z.string(), z.string()).optional(),
      counts: z.record(z.string(), z.number()).optional(),
      repoId: z.number().int().optional().describe('required when the project has more than one repo'),
    },
    ({ projectId, ...rest }) => reviews.postResult(projectId, rest, actor),
  )
  tool(
    'list_review_results',
    'Review results recorded for a project, newest first, without their summary (get_review_result has it). Filter by prNumber, sha (short or full) and repoId to check whether a head SHA was already reviewed.',
    {
      projectId: z.number().int(),
      prNumber: z.number().int().optional(),
      sha: z.string().optional(),
      repoId: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    ({ projectId, limit, ...filter }) =>
      reviews.listResults(projectId, limit, filter).map(({ summaryMd: _summary, ...r }) => r),
  )
  tool(
    'get_review_result',
    'One review result in full: verdict, markdown summary, checks and counts.',
    { resultId: z.number().int() },
    ({ resultId }) => reviews.getResult(resultId),
  )

  // ongoing features
  tool(
    'list_tickets',
    "Tickets of a project (all its repos) with status, assignee, reserved (assigned to one of the project's agents: only that agent works it), repoId, branch, parentId, tags, task progress (own and rolled up over lanes), lane counts (total, approved, disapproved, byStage: per stage key), and the human's verdict: approvedAt/approvedBy or disapprovedAt/disapprovedBy (a disapproved ticket is moved to the cancelled stage). status is a stage key (see get_project). Cancelled lanes' tasks are left out of the rolled-up progress. Archived tickets (finished work the human took off the board, lanes with it; archivedAt/archivedBy) are left out unless archived says otherwise.",
    {
      projectId: z.number().int(),
      parentId: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("a ticket's id for its lanes, null for top-level tickets only; omit for all"),
      tag: z.string().optional().describe('only tickets carrying this tag (any casing)'),
      status: z
        .array(z.string())
        .optional()
        .describe('only tickets in these stages: keys, names, or kinds (a kind takes in every stage of it)'),
      assignee: z.string().optional().describe('only tickets assigned to this name; "" for unassigned'),
      q: z.string().optional().describe('text to find in the title or instructions (any casing)'),
      archived: z
        .enum(['include', 'only'])
        .optional()
        .describe('include: archived tickets too; only: just the archived ones. Omit to leave them out'),
    },
    ({ projectId, ...filter }) => features.listTickets(projectId, filter),
  )
  tool(
    'get_ticket',
    "A ticket in full: instructions and the files attached to them (attachments, each with a local path), agent (the project agent it is reserved for, with its instructions; null when shared), tasks, workspaces, its parent chain, its lanes with their last progress post and verdict, the feed of posts (updates: newest first, each with progress true for a step of the work or false for discussion, editedAt, attachments with a local path, and thread: its reply count, last author and time), thread on the ticket (how many posts, who posted last), and pr: the PR it was opened as (prNumber, or the open PR on its branch) with its latest review. approvedAt/approvedBy or disapprovedAt/disapprovedBy is the human's verdict (both null: no call yet; disapproved also means cancelled). archivedAt/archivedBy is set when the human archived it (or the ticket it is a lane of): finished, off the board.",
    {
      ticketId: z.number().int(),
      laneUpdates: z.boolean().default(false).describe("include the lanes' posts in the feed"),
    },
    ({ ticketId, laneUpdates }) => features.getTicketFull(ticketId, { laneUpdates }),
  )
  tool(
    'create_ticket',
    'Create a ticket (a feature or piece of work) with optional initial tasks. With parentId it is a lane of that ticket: a parallel piece of it with its own assignee, branch, tasks and updates.',
    {
      projectId: z.number().int(),
      title: z.string(),
      body: z.string().default('').describe('markdown instructions'),
      status: z
        .string()
        .optional()
        .describe(`${STATUS}. Defaults to the last open stage (To do rather than Backlog)`),
      assignee: z.string().default(''),
      branch: z.string().default(''),
      baseBranch: z.string().optional().describe("defaults to the repo's base branch"),
      repoId: z
        .number()
        .int()
        .optional()
        .describe('the repo the branch lives in; required when the project has more than one repo'),
      parentId: z
        .number()
        .int()
        .optional()
        .describe(
          "make this a lane of that ticket; repo and base branch default to the parent's repo and branch",
        ),
      tags: z.array(z.string()).default([]).describe(TAGS),
      tasks: z.array(z.string()).default([]),
      prNumber: z.number().int().optional().describe("the PR opened from this ticket's branch"),
    },
    ({ projectId, ...rest }) => features.createTicket(projectId, rest, actor),
  )
  tool(
    'update_ticket',
    "Change status, assignee, branch, tags, prNumber, title or instructions. Use claim_ticket to pick a ticket up. Changing the assignee of a ticket reserved for one of the project's agents fails: only the human reassigns those. Status blocked means you are waiting on the human: say what for in a comment on the ticket.",
    {
      ticketId: z.number().int(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.string().optional().describe(STATUS),
      assignee: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoId: z.number().int().optional(),
      tags: z.array(z.string()).optional().describe(`replaces the whole list. ${TAGS}`),
      prNumber: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("the PR opened from this ticket's branch, in the ticket's repo; null unlinks it"),
    },
    ({ ticketId, ...patch }) => features.updateTicket(ticketId, patch, actor, { agent: true }),
  )
  tool(
    'claim_ticket',
    "Pick a ticket up: assigns it to you (or, with as, to the project agent you work it as) and moves it from an open or blocked stage to the first active stage, optionally setting the branch. A shared ticket someone else holds is taken over from them. Fails when the ticket is reserved for one of the project's agents and as is not that agent, or when it is in a done or cancelled stage.",
    {
      ticketId: z.number().int(),
      branch: z.string().optional(),
      as: AS.describe('the project agent you work this ticket as; required when it is reserved for one'),
    },
    ({ ticketId, branch, as }) => features.claimTicket(ticketId, actor, { branch, as }),
  )
  tool(
    'add_tasks',
    'Append todo items to a ticket.',
    { ticketId: z.number().int(), tasks: z.array(z.string()).min(1) },
    ({ ticketId, tasks }) => features.addTasks(ticketId, tasks, actor),
  )
  tool(
    'set_task_done',
    'Tick or untick a task.',
    { taskId: z.number().int(), done: z.boolean().default(true) },
    ({ taskId, done }) => features.updateTask(taskId, { done }, actor),
  )
  tool(
    'update_task',
    'Reword a task, or tick / untick it.',
    { taskId: z.number().int(), text: z.string().min(1).optional(), done: z.boolean().optional() },
    ({ taskId, ...patch }) => features.updateTask(taskId, patch, actor),
  )
  tool(
    'remove_task',
    'Remove a task that is no longer part of the plan, so it stops counting in the progress bar.',
    { taskId: z.number().int() },
    ({ taskId }) => {
      features.deleteTask(taskId, actor)
      return { ok: true }
    },
  )
  tool(
    'add_workspace',
    'Register a worktree / sub-branch / subagent sandbox you opened for a ticket, so the board can show it. previewUrl is where its branch runs for the human to try, if it does already (set_preview sets it later).',
    {
      ticketId: z.number().int(),
      name: z.string(),
      branch: z.string().default(''),
      path: z.string().default(''),
      agent: z.string().optional(),
      previewUrl: z.string().optional().describe(PREVIEW_URL),
    },
    ({ ticketId, ...rest }) => features.addWorkspace(ticketId, rest, actor),
  )
  tool(
    'set_preview',
    'Set the link where a workspace\'s branch runs for the human to try (after you start its server), or clear it with "" once you stop the server. The ticket page shows it as a Preview card with an Open button and whether it is running.',
    {
      workspaceId: z.number().int(),
      previewUrl: z.string().describe(`${PREVIEW_URL}; "" clears it`),
    },
    ({ workspaceId, previewUrl }) => features.setWorkspacePreview(workspaceId, previewUrl, actor),
  )
  tool(
    'remove_workspace',
    'Remove a workspace you closed (its preview goes with it).',
    { workspaceId: z.number().int() },
    ({ workspaceId }) => {
      features.deleteWorkspace(workspaceId, actor)
      return { ok: true }
    },
  )
  tool(
    'post_update',
    'Post on a ticket: markdown plus optional files (screenshots, recordings) given as absolute paths on this machine. progress (default true) marks it as a step of the work; false makes it discussion, like comment on the ticket.',
    {
      ticketId: z.number().int(),
      body: z.string(),
      files: z.array(z.string()).default([]).describe('absolute paths to attach'),
      as: AS,
      progress: z.boolean().default(true),
    },
    async ({ ticketId, body, files, as, progress }) => {
      const ids = (await Promise.all(files.map((f) => uploads.saveFromPath(f, actor)))).map((a) => a.id)
      return features.postUpdate(ticketId, body, ids, actor, { as, progress })
    },
  )
  tool(
    'ask_decision',
    'Ask the human to make a call you should not make alone, as a decision card on the ticket: body is the question (markdown: the context, what each choice means for the work), options are 2 to 5 answers, each a short label with an optional detail; mark at most one recommended. The ticket moves to blocked (block: false to keep it where it is) and goes back to in progress once decided. The answer arrives as a reply under the card (list_my_threads); get_ticket shows decision and decidedOption on the post.',
    {
      ticketId: z.number().int(),
      body: z.string().describe('the question, with the context needed to answer it'),
      options: z
        .array(
          z.object({
            label: z.string(),
            detail: z.string().optional().describe('what choosing it means'),
            recommended: z.boolean().optional(),
          }),
        )
        .min(2)
        .max(5),
      as: AS,
      block: z.boolean().default(true),
    },
    ({ ticketId, ...input }) => features.askDecision(ticketId, input, actor),
  )
  tool(
    'edit_post',
    'Change a post you made on a ticket (its body, or whether it is progress), or a reply (kind reply: its body). Edits show as edited.',
    {
      kind: z.enum(['post', 'reply']).default('post'),
      id: z
        .number()
        .int()
        .describe('the post id (from get_ticket updates) or the reply id (from list_comments)'),
      body: z.string().min(1).optional(),
      progress: z.boolean().optional().describe('posts only'),
    },
    ({ kind, id, body, progress }) => {
      if (kind === 'post') return features.editPost(id, { body, progress }, actor)
      if (body === undefined) throw new HttpError(400, 'give the new body')
      return features.editComment(id, body, actor)
    },
  )
  tool(
    'delete_post',
    'Delete a post you made on a ticket (its replies and files go with it), or a reply (kind reply).',
    { kind: z.enum(['post', 'reply']).default('post'), id: z.number().int() },
    ({ kind, id }) => {
      if (kind === 'post') features.deletePost(id, actor)
      else features.deleteComment(id, actor)
      return { ok: true }
    },
  )
  tool(
    'get_ticket_git',
    "Read-only git state of the ticket branch and its workspaces, its lanes' included and tagged with the lane (ahead/behind, last commit, worktrees). Each branch's reach says whether its work is already in its base chain (a lane's parent branch, then the parent's base, then the repo's base): merged (as is), rebased (same patches), edited (patches differ but merging would change nothing), unique (still has work of its own, listed). merged, rebased and edited are safe to delete.",
    { ticketId: z.number().int() },
    ({ ticketId }) => features.ticketGit(ticketId),
  )
  tool(
    'cleanup_report',
    "What finished work left behind: every ticket in a done or cancelled stage (or archived) that still has a registered workspace, a local or origin branch, or a worktree. Each branch comes with its local and origin sha, the worktrees holding it, reach against the ticket's base chain (merged, rebased, edited: safe to delete; unique: still has work, commits listed) and the command that restores it. untracked lists worktrees no ticket or workspace accounts for. Origin branches are as of the last fetch; the board never deletes anything.",
    { projectId: z.number().int() },
    ({ projectId }) => cleanupReport(projectId),
  )

  // threads
  tool(
    'list_my_threads',
    "Threads in a project waiting on you: on a ticket assigned to or opened by you, your update or review, or any thread you spoke in, where someone else spoke last. Also threads waiting on one of the project's agents (it was @mentioned last, or it spoke there, or it is its ticket or post), with as set to that agent: answer those with comment as: <it>. Newest first, each with its parent (for list_comments and comment), the ticket, how many comments came since you (or the agent) last spoke, and the last one.",
    { projectId: z.number().int() },
    ({ projectId }) => features.listOpenThreads(projectId, actor),
  )
  tool(
    'list_comments',
    "A conversation, oldest first: on a ticket, its posts (with progress); under a post (parentType update, the post's id), its replies; under a PR (board id, not number) or a review result, its comments. Attachments come with a local path you can open.",
    { parentType: z.enum(COMMENT_PARENTS), parentId: z.number().int() },
    ({ parentType, parentId }) => features.listComments(parentType, parentId),
  )
  tool(
    'comment',
    "Say something. On a ticket it becomes a post in its feed (not progress); with replyTo it is a reply under that post instead. Under a post (parentType update, the post's id), a PR or a review result it is a reply; replyTo nests it under another reply. @name mentions one of the project's agents, which puts the thread in list_my_threads for whoever answers as it.",
    {
      parentType: z.enum(COMMENT_PARENTS),
      parentId: z.number().int(),
      body: z.string(),
      replyTo: z.number().int().optional(),
      files: z.array(z.string()).default([]),
      as: AS,
    },
    async ({ files, ...rest }) =>
      features.addComment(
        {
          ...rest,
          attachmentIds: (await Promise.all(files.map((f) => uploads.saveFromPath(f, actor)))).map(
            (a) => a.id,
          ),
        },
        actor,
      ),
  )

  tool(
    'get_attachment',
    'A file someone attached to a post or reply: name, type, size and the absolute path to open it on this machine (windowsPath too when the board runs in WSL).',
    { attachmentId: z.number().int() },
    ({ attachmentId }) => uploads.attachmentView(uploads.getAttachment(attachmentId)),
  )
  tool(
    'list_actors',
    "Every name that signs in to the board (connected agents by token name, the human by passkey). The project's own agents are in get_project. Use these exact names for assignee.",
    {},
    () => listActors(),
  )

  // daily
  tool(
    'daily_report',
    "A day's activity (every write anyone made, in order) and the summaries posted for it.",
    {
      date: z.string().default(today()).describe('YYYY-MM-DD, local'),
      projectId: z.number().int().optional(),
    },
    ({ date, projectId }) => dailyReport(date, projectId),
  )
  tool(
    'post_daily_summary',
    'Post the highest-level summary of a day: at most three short lines, what got done and what is open.',
    {
      date: z.string().default(today()),
      projectId: z.number().int().nullable().default(null),
      body: z.string(),
    },
    ({ date, projectId, body }) => addSummary({ date, projectId, body, author: actor }),
  )

  return server
}

export async function handleMcp(request: Request, actor: string): Promise<Response> {
  // Stateless and JSON-only: each POST is fully answered before the response is returned, nothing outlives the request.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await buildServer(actor).connect(transport)
  return transport.handleRequest(request)
}
