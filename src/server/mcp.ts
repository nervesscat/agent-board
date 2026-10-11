import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { COMMENT_PARENTS, RESUME_TEMPLATE } from '#/lib/constants'
import { addSummary } from './activity'
import { listActors } from './actors'
import { cleanupReport } from './cleanup'
import { dailyReport, today } from './daily'
import * as features from './features'
import { HttpError } from './http'
import * as needs from './needs'
import { isActive, managedPreview, restartPreview, startPreview, stopPreview } from './managedPreview'
import * as prs from './prs'
import * as projects from './projects'
import * as reports from './reports'
import { withResume } from './resume'
import * as reviews from './reviews'
import { getSummary } from './summary'
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
const INSTRUCTIONS = `The board is where the human and every agent coordinate work. You read work from it and report back to it. Git and GitHub are read-only through the board for you (only the human deletes finished branches, from its Cleanup page): never push, merge, approve or comment on GitHub on its behalf.

Work only in the project of the repo you are in, and never read or write another project's tickets, PRs, reviews or daily log. If a board skill or the repo's own instructions name your projectId, use it directly. Only otherwise, call list_projects once and pick the project whose repos include yours (match the GitHub slug from git remote get-url origin, then the folder name; the board may list Linux paths while you are on Windows); if none does, do not use the board for this repo.

The rhythm:
1. get_project before touching it; its instructions override your defaults. Its stages are the board's columns, in order, each with a key, a name and a kind (open, active, blocked, review, done, cancelled). A ticket's status is a stage key; wherever status is asked for you can also give a stage's name or a kind (the first stage of that kind; todo and in_progress mean open and active). Below, todo, in_progress, blocked, review, done and cancelled mean the stage of that kind.
2. Starting a session, get_summary with your projectId is the picture in one read: what waits on the human, what is in progress and since when, what got done today, what is next, and what carries over from before today. Pick up work from list_tickets (status todo, assignee "" or your name from whoami); read it with get_ticket; then claim_ticket with the branch. Tickets are shared: you may take over one another agent holds (the board logs it), so prefer unassigned ones and take over only what is clearly stalled or handed to you. A ticket with reserved: true belongs to one of the project's agents (see below). Start of a session: before anything else on a ticket you pick up or come back to, read its resume note (resume in get_ticket, also returned by claim_ticket): where the last session left off, the next steps and how to resume. resume.commitsSince and resume.stale say whether the work moved on since it was written; resume.noHandoff means it carried over from an earlier day without one, so read the latest posts and the branch instead.
3. add_tasks with the concrete steps if the ticket has none; set_task_done as you finish each; update_task or remove_task when the plan changes.
4. Split parallel work into lanes: when a ticket needs several pieces worked at once (subagents, worktrees, other agents), create_ticket with parentId = the ticket for each piece, with its own branch and assignee. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its own. Tag each lane (tags) so the human can filter them: severity, area or kind, the same words across sibling lanes, not in the title. add_workspace registers where code runs (a worktree, a sub-branch, a sandbox): register every worktree you open, since that list is what gets cleaned up later; remove_workspace when it is gone.
5. post_update after each meaningful step: short markdown, what changed and what is next, with screenshots or logs as absolute file paths in files. A ticket has one feed of posts: post_update adds one marked as progress (lane summaries and the Daily view pick those out); questions and answers are posts too (comment on the ticket, or post_update with progress: false). Every post can have replies (comment on the post's id with parentType update). edit_post and delete_post change what you posted. When the change can be tried (a page, an API), have a preview the human can open before anything is merged. For a branch of the board itself, the board runs it: register your worktree (add_workspace with its path and branch; it must sit next to the repo's main checkout), then start_preview with the workspace's id. The board installs if the lockfile changed, builds, copies the live data and starts the build on a free port without the passkey gate; get_ticket shows its state on the workspace (managedPreview: building, starting, running, failed with the last log lines, or stopped), and once it runs the workspace's previewUrl is set. Do not run pnpm dev in your session for it: that dies with your session. start_preview with restart: true rebuilds it after you push more work; stop_preview stops it, and the board stops it by itself when the PR is merged, the ticket is done, cancelled or archived, or the workspace is removed. For anything else, start your branch from your worktree on a free port with a copy of the data rather than the real one (the project's instructions say how) and register its link on the workspace (set_preview, or previewUrl on add_workspace). Either way post the link with what to try, say that what they post there stays in the copy, keep it running while the ticket is in review, and stop it once it is merged or dropped (clear a link you set with set_preview "").
6. Ask and answer with comment. When you cannot go on without the human, comment your question on the ticket and update_ticket to blocked; back to in_progress once answered. When it is a choice between clear options (an approach, a trade-off, a scope call), ask_decision instead: the human answers with one click, and the ticket blocks and unblocks by itself. When you resume, and between steps, list_my_threads shows every ticket feed or reply thread where someone spoke after you; get_ticket shows each post's reply count and last author. Files on posts and replies come with a local path you can open. While you have tickets in progress or review, watch for feedback without being told: every few minutes call check_inbox with the cursor from your last call (in Claude Code, under /loop); for each new thread read it, fix what it asks the usual way (checks, commit, push, preview), reply in the thread with what changed, and keep the new cursor.
7. Hand off: before update_ticket to review, every item, in order: (1) worktree registered (add_workspace), tasks ticked; (2) checks green: typecheck, lint, unit tests, and the e2e suite when the repo has one; (3) branch pushed: get_ticket's push.state is pushed (green on the board), not ahead or local-only (red); (4) needs declared for any unmerged branch it builds on (below); (5) PR open and assigned to the human (gh pr create --assignee <their login>, or --assignee @me when you push with their account: GitHub never lets a PR's author be its requested reviewer, and the PR queue lists PRs assigned to them), and update_ticket with its prNumber; (6) preview running: start_preview on the workspace and wait for running (a repo the board cannot build: start one the project's way and set_preview); when the change cannot be tried (docs only, a script), say why in the hand-off post; (7) hand-off post (post_update): the PR link, the preview link and what to try there, how it was tested, the e2e result, and screenshots for a UI change; (8) a resume note if the ticket stays open past the session. update_ticket to review answers with handoff.missing: what the board still sees missing (no_pr, not_pushed, no_preview, no_handoff_post, checks_unknown when the PR's CI is failing or running); fix each one. Briefing a subagent, put the same list in its brief. When your branch is built on another ticket's open branch, or you merged one in (to get past a conflict), declare it with update_ticket needs: [its id] instead of only writing "builds on" in the PR: the PR queue then says which PR to merge first, and the ticket cannot be done until that branch is merged into its base. get_ticket_git includes lists the tickets whose unmerged work your branch holds. done is the human's call. cancelled is for work that was dropped: say why in a comment. A ticket with lanes goes to review once its lanes are in review, done or cancelled. The human's verdict on a lane or ticket is approvedAt/approvedBy (approved) or disapprovedAt/disapprovedBy (disapproved, which also cancels it; approving a ticket tagged PR, a PR review, also moves it to done); you can read it, never set it. Treat an approved lane as settled and a disapproved one as dropped: ask in its thread before touching either. Archiving is the human's too: archivedAt set means the ticket (lanes included) is finished and off the board, and list_tickets leaves it out unless you pass archived.
8. Clean up after yourself: once a lane's work is in its parent's branch (or a ticket's in its base), and before moving it to done, remove its worktree and delete its local branch, remove_workspace, and post_update the deleted branch names with their commit hashes (e.g. lane/47 @ 9ec12e8b) so any of them can be restored. get_ticket_git says whether each branch's work arrived (reach); cleanup_report lists every leftover in the project. Never delete a branch whose reach is unique without the human's go-ahead, nor one cleanup_report marks protected, and never delete branches on origin: list them for the human, who deletes them from the Cleanup page.
9. End of session: for every ticket you leave in progress, blocked or review, set_resume_note with its template filled in (state, done so far, next steps, open questions or blockers, how to resume: branch, worktree, commands, preview, gotchas), concretely enough that another agent can continue without asking. Then post_daily_summary, at most three short lines. If the project tracks reports (get_report_settings: cadence daily or weekly), list_reports shows which periods are done, missing or upcoming; write the missing or current one exactly as its prompt says (by the hour, sections, a short text or a PDF) and post_report it, files as absolute paths.

The project's agents: get_project lists them (agents: name, instructions, delegation notes, picture). They are personas the human defined, not connected tools; you work for them. A ticket assigned to one (reserved: true; get_ticket's agent has its instructions) is that agent's alone: claim_ticket with as: <its name>, brief a subagent with its instructions (and the ticket's), and post that work with post_update and comment using as: <its name>, so it shows under the agent's name, via you. Never take a reserved ticket as yourself, reassign it, or work it without the agent's instructions; only the human reassigns it. A thread can wait on an agent too: when someone @mentions it, or replies on its ticket or post, list_my_threads returns that thread with as: <its name>; answer it with comment as: <its name>, in that agent's voice and instructions. Orchestrating: each agent's delegation notes say when to call it, what to give it, what it returns and what comes next. With them you can work a ticket as its orchestrator instead of doing the work yourself: run each step as a subagent briefed with that agent's instructions, the project's instructions and the ticket; post what it returns on the ticket as that agent (as: <its name>, progress: true); go where its notes say next. The default set (spec, builder, runner, and the review phases env, verify, hunt, refute, merge) is the cycle spec → build → review that tries to break it → build again with the confirmed findings (at most three rounds) → hand off; the /review-queue skill runs it (/feature-review is its review). Ask the human with ask_decision instead of guessing, never run two builders on one branch, and never delegate to an agent without delegation notes. The board skill has the full routine.

When a project has several repos, pass repoId to create_ticket and post_review_result. Plain words, titles under 80 characters; the human reads dozens of these a day.

Keep the board out of the repo. The board, trazic, habits and any other personal tracking tool are private to the human: never mention them, their tool names, their URLs (localhost:47100, 47110) or a board ticket, task or project ("#12", "ticket 12", "per the board") in code comments, docs, READMEs, changelogs, config, commit messages, branch names, PR titles or descriptions, or issues, and never link or screenshot the board there. Describe the change and its reason in the repo's own terms; if the PR needs something from the ticket, restate it instead of pointing at it. Board updates and comments may talk about the repo, branches and PRs freely.`

const STATUS =
  'a stage key from get_project, a stage name, or a kind (open, active, blocked, review, done, cancelled; todo and in_progress also work): the first stage of that kind'
const AS = z
  .string()
  .optional()
  .describe("one of the project's agents (get_project): post under its name, as the work you did for it")
const SINCE = z
  .string()
  .optional()
  .describe('an ISO time, normally the cursor of your last call: only threads with a new word after it')
const PREVIEW_URL =
  'where the branch runs for the human to try, http(s) only: http://localhost:<port> (the board checks whether localhost links are up)'
const NEEDS =
  "ticket ids whose branches must be merged into this ticket's base before it can be done: the branch this one is built on (stacked), or one it merged in to get past a conflict. Same project, not itself, no cycles."
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

  tool(
    'get_summary',
    "Where a project stands, in one read (every project, one block each, without projectId): needsYou (open decisions, PRs waiting on the human's review, threads waiting on the human, tickets in a review stage), inProgress (tickets in active or blocked stages: assignee, task progress, lanes, last progress post, preview, since when, stale when no progress post in 24 hours), doneToday (tickets that reached a done stage today, PRs that left the queue today, today's activity count), next (the head of the first open stage that is not a backlog, with how many are blocked and in the backlog) and carryingOver (tickets in progress since before today, each with resume: its resume note as a short plain-text excerpt with who wrote it when, noHandoff when nobody left one since the last day it was worked, stale when a progress post came after it, and which day of work this is). Today is the board's local day. Read it when starting a session.",
    { projectId: z.number().int().optional() },
    ({ projectId }) => getSummary(projectId, { refreshPrs: true }),
  )

  // PR queue
  tool(
    'list_prs',
    "The human's PRs across all repos of the project: open, and merged in the last 14 days. waitingOn is me (someone else authored it: the human reviews it) or others (the human authored it on GitHub, agents' PRs pushed with their account included). status is where its reviews stand: for waitingOn me, by the human's own reviews (pending: not approved by them, or their comments were addressed by a push or a new review request; reviewed: they approved; on_hold: their comments or requested changes stand at the head); for others, by everyone else's (pending: approvals missing; reviewed: reviewDecision APPROVED, or every reviewer approved and no review is still requested; on_hold: someone's comments or requested changes stand at the head); done: merged. A board-side hold puts an open PR in on_hold. myReview is the human's standing verdict. Also the repo and the latest review verdict. Where it stands on GitHub as of the last refresh: merge (clean | conflicts | behind | blocked | checking), ci (passing | failing | pending | none) with checks[] {name, state pass | fail | pending | skipped, url}, reviewDecision and isDraft. mergeAfter lists the open PRs of tickets its tickets need: merge those first.",
    {
      projectId: z.number().int(),
      refresh: z.boolean().default(false).describe('re-query GitHub before answering'),
    },
    ({ projectId, refresh }) => prs.listPrs(projectId, { refresh }),
  )
  tool(
    'set_pr_hold',
    'Put an open PR on hold with a note (or release it back to its stage). Board-side only; GitHub is never written. A merged PR stays done.',
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
    "Tickets of a project (all its repos) with status, assignee, reserved (assigned to one of the project's agents: only that agent works it), repoId, branch, parentId, tags, task progress (own and rolled up over lanes), lane counts (total, approved, disapproved, byStage: per stage key), and the human's verdict: approvedAt/approvedBy or disapprovedAt/disapprovedBy (a disapproved ticket is moved to the cancelled stage), startedAt (when work on it last started), and resume: whether its resume note holds (at: when it was written, null for none; stale: the work moved on since; noHandoff: it carried over from an earlier day without one; day: which day of work this is). status is a stage key (see get_project). needs lists the tickets it needs merged first, each with merged (see get_ticket). Cancelled lanes' tasks are left out of the rolled-up progress. Archived tickets (finished work the human took off the board, lanes with it; archivedAt/archivedBy) are left out unless archived says otherwise.",
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
    ({ projectId, ...filter }) => needs.ticketRows(projectId, filter),
  )
  tool(
    'get_ticket',
    "A ticket in full: instructions and the files attached to them (attachments, each with a local path), agent (the project agent it is reserved for, with its instructions; null when shared), tasks, workspaces (each with managedPreview: the preview the board builds and runs from it, null when it never ran one; status building | starting | running | failed | stopped, step, port, url, reason, tail: the last log lines when it failed, logs: their paths), its parent chain, its lanes with their last progress post and verdict, the feed of posts (updates: newest first, each with progress true for a step of the work or false for discussion, editedAt, attachments with a local path, and thread: its reply count, last author and time), thread on the ticket (how many posts, who posted last), pr: the PR it was opened as (prNumber, or the open PR on its branch) with its latest review, and push: whether its branch is on origin (state pushed: origin has every commit, behind counts what origin has on top; ahead: ahead commits are only local; local-only: origin has no such branch; merged: origin has no such branch any more and it was merged into the ticket's base, into; remote-only: only origin has it; none: no branch, or it exists nowhere; checkedAt: when origin was last fetched, every few minutes), likewise on each workspace. A ticket goes to review only with its branch pushed. handoff, in a review stage (null otherwise): what the hand-off still lacks, as update_ticket answers it. approvedAt/approvedBy or disapprovedAt/disapprovedBy is the human's verdict (both null: no call yet; disapproved also means cancelled). archivedAt/archivedBy is set when the human archived it (or the ticket it is a lane of): finished, off the board. resume is where the last session left off: note (markdown; '' when none), at, by, sha (the branch head when it was written), commitsSince (commits on the branch since; null when unknown), stale (new commits or a newer progress post since), noHandoff (in progress, blocked or review since an earlier day with no note written since) and day (which day of work this is). Read the note before anything else when you pick the ticket up; handoff: true marks its earlier versions in the feed. needs: the tickets whose branches must be merged into its base before it can be done ({id, title, branch, prNumber, status, merged, into}); neededBy: the tickets that need this one.",
    {
      ticketId: z.number().int(),
      laneUpdates: z.boolean().default(false).describe("include the lanes' posts in the feed"),
    },
    ({ ticketId, laneUpdates }) => needs.ticketView(ticketId, { laneUpdates }),
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
      needs: z.array(z.number().int()).optional().describe(NEEDS),
    },
    ({ projectId, ...rest }) => needs.newTicket(projectId, rest, actor, { agent: true }),
  )
  tool(
    'update_ticket',
    "Change status, assignee, branch, tags, prNumber, title or instructions. Use claim_ticket to pick a ticket up. Changing the assignee of a ticket reserved for one of the project's agents fails: only the human reassigns those. Status blocked means you are waiting on the human: say what for in a comment on the ticket. A move to done is refused while one of its needs is not merged into its base (the error says which); merge order is the human's, so leave it in review. A move to a review stage goes through and answers with handoff: missing [{code, text}] lists what the hand-off still lacks (no_pr: no PR set or open on the branch; not_pushed: the branch is not on origin; no_preview: no preview the board runs or that answers; no_handoff_post: no progress post of yours since the branch's last commit; checks_unknown: the PR's CI is failing or still running), and checks has every item with ok, first not_merged (Merged: the PR merged on GitHub or the branch merged into its base), which is never in missing: merging is the human's. Fix what it lists.",
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
      needs: z.array(z.number().int()).optional().describe(`${NEEDS} Replaces the whole list; [] clears it.`),
    },
    ({ ticketId, ...patch }) => needs.changeTicket(ticketId, patch, actor, { agent: true }),
  )
  tool(
    'claim_ticket',
    "Pick a ticket up: assigns it to you (or, with as, to the project agent you work it as) and moves it from an open or blocked stage to the first active stage, optionally setting the branch. Returns the ticket with resume, its resume note (as in get_ticket): read it before anything else. A shared ticket someone else holds is taken over from them. Fails when the ticket is reserved for one of the project's agents and as is not that agent, or when it is in a done or cancelled stage.",
    {
      ticketId: z.number().int(),
      branch: z.string().optional(),
      as: AS.describe('the project agent you work this ticket as; required when it is reserved for one'),
    },
    ({ ticketId, branch, as }) => withResume(features.claimTicket(ticketId, actor, { branch, as })),
  )
  tool(
    'set_resume_note',
    `Write the ticket's resume note, "Where we left off": the one current note for whoever picks the ticket up next (another agent, you tomorrow, the human), shown at the top of the ticket page. At the end of a session, for every ticket you leave in progress, blocked or review. Markdown, this template filled in concretely enough that another agent can continue without asking:

${RESUME_TEMPLATE}

It replaces the previous note; each new version is also posted to the ticket's feed (handoff: true), so older ones stay readable. The board records the branch head, so commits made after it show as commits since the note.`,
    {
      ticketId: z.number().int(),
      note: z.string().min(1).describe('markdown, the template filled in'),
      as: AS,
    },
    ({ ticketId, note, as }) => features.setResumeNote(ticketId, note, actor, { as }),
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
    'start_preview',
    "Have the board build and run a branch of the board itself as a preview, from the workspace's worktree (its registered path: a git worktree next to the repo's main checkout, never the main checkout). In the background: pnpm install when the lockfile changed, pnpm build, a fresh copy of the live data, then the built server on a free port from 47101 without the passkey gate; once it answers the workspace's previewUrl is set. Returns at once with status building; get_ticket (the workspace's managedPreview) follows it to running, or failed with the last log lines. One per workspace, at most 8 at once. restart: true stops a running one first and builds again.",
    {
      workspaceId: z.number().int(),
      restart: z.boolean().default(false).describe('stop the running preview first and build again'),
    },
    ({ workspaceId, restart }) =>
      restart ? restartPreview(workspaceId, actor) : startPreview(workspaceId, actor),
  )
  tool(
    'stop_preview',
    "Stop the preview the board runs from a workspace (start_preview): its processes are killed, its port freed and the workspace's previewUrl cleared.",
    { workspaceId: z.number().int() },
    async ({ workspaceId }) => {
      if (!isActive(managedPreview(workspaceId)))
        throw new HttpError(409, 'the board runs no preview of this workspace')
      return stopPreview(workspaceId, `stopped by ${actor}`, actor)
    },
  )
  tool(
    'remove_workspace',
    'Remove a workspace you closed (its preview goes with it; a preview the board runs from it is stopped).',
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
    "Read-only git state of the ticket branch and its workspaces, its lanes' included and tagged with the lane (ahead/behind, last commit, worktrees). Each branch's reach says whether its work is already in its base chain (a lane's parent branch, then the parent's base, then the repo's base): merged (as is), rebased (same patches), edited (patches differ but merging would change nothing), unique (still has work of its own, listed). merged, rebased and edited are safe to delete. Each branch's push says whether it is on origin: state pushed (origin has every commit; behind: how many origin has on top), ahead (ahead commits not pushed yet), local-only (not on origin at all), merged (gone from origin, merged into the ticket's base: into), remote-only (only on origin) or none, with checkedAt: when origin was last fetched (the board fetches every few minutes). includes: ids of open tickets whose unmerged work this ticket's branch holds (commits of their branch that are in this one but not in its base): declare them with update_ticket needs, so they are merged first.",
    { ticketId: z.number().int() },
    ({ ticketId }) => needs.ticketGitView(ticketId),
  )
  tool(
    'cleanup_report',
    "What finished work left behind: every ticket in a done or cancelled stage (or archived) that still has a registered workspace, a local or origin branch, or a worktree. previews lists the previews the board still runs from its workspaces (stop_preview). Each branch comes with its local and origin sha, the worktrees holding it, reach against the ticket's base chain (merged, rebased, edited: safe to delete; unique: still has work, commits listed; null: nothing to compare against) and remoteReach, origin's copy judged by its own commits, the commands that restore each copy, protected (why it is never deleted: a base, the main checkout's branch, origin's default branch, in use by a ticket in work or an open PR; leave those) and can (what the human may delete from the Cleanup page, and why not). safe is true only when every branch landed, here and on origin, and nothing is protected. repos says which repo git could not read. untracked lists worktrees no ticket or workspace accounts for. Origin branches are as of the last fetch. Only the human deletes from the Cleanup page; you delete local branches and worktrees yourself with the human's go-ahead, never origin's. uploads counts the board's unattached uploads older than a day (no post, reply, ticket, agent picture or text points at them): the board deletes those by itself every hour, and the human can from the Cleanup page.",
    { projectId: z.number().int() },
    ({ projectId }) => cleanupReport(projectId),
  )

  // threads
  tool(
    'list_my_threads',
    "Threads in a project waiting on you: on a ticket assigned to or opened by you, your update or review, or any thread you spoke in, where someone else spoke last. Also threads waiting on one of the project's agents (it was @mentioned last, or it spoke there, or it is its ticket or post), with as set to that agent: answer those with comment as: <it>. Returns { cursor, threads }: threads newest first, each with its parent (for list_comments and comment), the ticket, how many comments came since you (or the agent) last spoke, and the last one. With since, only the threads whose last word came after it; cursor is the newest one seen (since when nothing new; null until there is one), to pass as since next time.",
    { projectId: z.number().int(), since: SINCE },
    ({ projectId, since }) => features.myThreads(projectId, actor, since),
  )
  tool(
    'check_inbox',
    'The cheap poll for new comments while you work: what list_my_threads with since finds, without bodies. Returns { count, cursor, threads: [{ ticketId, title, parentType, parentId, as, lastAuthor, lastAt }] }. Keep cursor and pass it as since next time; read each thread with list_comments, answer it with comment (as: <it> when as is set).',
    { projectId: z.number().int(), since: SINCE },
    ({ projectId, since }) => features.checkInbox(projectId, actor, since),
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
    "Post the highest-level summary of a day: at most three short lines, what got done and what is open. At the end of a session, set_resume_note first on every ticket you leave in progress, blocked or review. For a project with daily text reports it also counts as that day's report until a report is posted with post_report.",
    {
      date: z.string().default(today()),
      projectId: z.number().int().nullable().default(null),
      body: z.string(),
    },
    ({ date, projectId, body }) => addSummary({ date, projectId, body, author: actor }),
  )

  // reports
  tool(
    'get_report_settings',
    "How the project's reports are made: prompt (markdown: what each report must contain and how: by the hour, sections, audience, tone, a short text or a PDF), cadence (off, daily, or weekly due on weekday 1 Monday to 7 Sunday), dueTime (local HH:MM on the due day; null is by the end of it) and format (text, or file: the report is an attached file such as a PDF). Follow the prompt when you write a report.",
    { projectId: z.number().int() },
    ({ projectId }) => reports.getReportSettings(projectId),
  )
  tool(
    'set_report_settings',
    "Change how the project's reports are made: any of prompt, cadence, weekday, dueTime and format; what you leave out stays. The change shows in the project's activity. Change the prompt only when the human asked for it or agreed.",
    { projectId: z.number().int(), ...reports.reportSettingsShape },
    ({ projectId, ...patch }) => reports.setReportSettings(projectId, patch, actor),
  )
  tool(
    'post_report',
    "Post the project's report for a period: body (markdown, may be a single line) and/or files (absolute paths on this machine, e.g. the PDF you made; the board does not make PDFs). A file-format project needs a file. period is a day, YYYY-MM-DD (for a weekly cadence any day of the week; the week's Monday is kept), by default the current one. Posting again for a period replaces its report (the earlier version stays as history).",
    {
      projectId: z.number().int(),
      period: z.string().optional().describe('YYYY-MM-DD, local; defaults to the current period'),
      body: z.string().optional(),
      files: z.array(z.string()).default([]).describe('absolute paths to attach'),
    },
    ({ projectId, ...input }) => reports.postReport(projectId, input, actor),
  )
  tool(
    'list_reports',
    "The project's report periods, newest first, from from to to (YYYY-MM-DD; by default the last two weeks of a daily cadence or eight weeks of a weekly one, up to today), each with due (when it is due), status (done: it has a report; missing: due and none posted; upcoming: not due yet), its latest report (body, author, attachments with a local path; source summary when a daily summary stands in for a daily text report) and how many versions were posted. Also the schedule and the current period. Periods before tracking began are left out unless they have a report.",
    {
      projectId: z.number().int(),
      from: z.string().optional().describe('YYYY-MM-DD'),
      to: z.string().optional().describe('YYYY-MM-DD'),
    },
    ({ projectId, from, to }) => reports.listReports(projectId, { from, to }),
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
