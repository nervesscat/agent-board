import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { COMMENT_PARENTS, COMPLEXITIES, FEED_TABS, RESUME_TEMPLATE } from '#/lib/constants'
import { listActors } from './actors'
import { isAgent } from './auth'
import { cleanupReport } from './cleanup'
import { AgentDeleteItems, deleteLeftovers } from './cleanupActions'
import { dailyReport, today } from './daily'
import * as features from './features'
import { galleryShape, listGallery } from './gallery'
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
 * actor the board signed in and whether it is an agent, so every write is attributed to the agent's
 * token name and the tools that only an agent may call can refuse a human.
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
const INSTRUCTIONS = `The board is where the human and every agent coordinate work. You read work from it and report back to it. Git and GitHub are read-only through the board for you, but for closed tickets' landed local branches, which cleanup_delete deletes (worktrees and origin's branches are the human's, from its Cleanup page): never push, merge, approve or comment on GitHub on its behalf.

Work only in the project of the repo you are in, and never read or write another project's tickets, PRs, reviews or daily log. If a board skill or the repo's own instructions name your projectId, use it directly. Only otherwise, call list_projects once and pick the project whose repos include yours (match the GitHub slug from git remote get-url origin, then the folder name; the board may list Linux paths while you are on Windows); if none does, do not use the board for this repo.

The rhythm:
1. get_project before touching it; its instructions override your defaults. Its stages are the board's columns, in order, each with a key, a name and a kind (open, active, blocked, review, done, cancelled). A ticket's status is a stage key; wherever status is asked for you can also give a stage's name or a kind (the first stage of that kind; todo and in_progress mean open and active). Below, todo, in_progress, blocked, review, done and cancelled mean the stage of that kind.
2. Starting a session, get_summary with your projectId is the picture in one read: what waits on the human, what is in progress and since when, what got done today, what is next, and what carries over from before today. Pick up work from list_tickets (status todo, assignee "" or your name from whoami); read it with get_ticket; then claim_ticket with the branch. Tickets are shared: you may take over one another agent holds (the board logs it), so prefer unassigned ones and take over only what is clearly stalled or handed to you. A ticket with reserved: true belongs to one of the project's agents (see below). Start of a session: before anything else on a ticket you pick up or come back to, read its resume note (resume in get_ticket, also returned by claim_ticket): where the last session left off, the next steps and how to resume. resume.commitsSince and resume.stale say whether the work moved on since it was written; resume.noHandoff means it carried over from an earlier day without one, so read the latest posts and the branch instead.
3. A new ticket starts with its project's default phases as its top-level tasks (get_project's defaultPhases; built in: Implementation, then the hand-off's Pushed, PR, CI, Preview, Hand-off post). Tasks go two levels and no more: the concrete steps of the work go under Implementation as its subtasks (add_tasks with parentTaskId = its id). set_task_done as you finish each step, and tick each hand-off phase as you finish it (Pushed after the push, PR once it is open, CI once it is green, Preview once it runs, Hand-off post once the summary is up to date); on a rework, untick the phases the new work redoes and tick them again as you redo each. When a phase does not fit, remove_task drops it (its steps go with it), update_task rewords it, and add_tasks adds one (at the end). A lane starts without phases, since its parent carries the hand-off (defaultPhases: true on create_ticket seeds it anyway), and defaultPhases: false opts a ticket out. A ticket with no tasks (an older one, a lane, one opted out) gets its phases the same way: add_tasks with the names from defaultPhases, then its steps under the first. The progress counts tasks and subtasks alike, and together they are the hand-off's Implementation item. When a step needs the human (a credential, a manual action, a call only they can make), tag that task or subtask blocked: update_task with blocked: true and blockedReason saying what the human must do. It shows on the task, on the ticket's card and in the human's Needs you (get_summary), still counts as open, and does not move the ticket: keep working on the rest. Ticking it done clears the tag; update_task with blocked: false clears it once resolved.
4. Split parallel work into lanes: when a ticket needs several pieces worked at once (subagents, worktrees, other agents), create_ticket with parentId = the ticket for each piece, with its own branch and assignee. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its own. Tag each lane (tags) so the human can filter them: severity, area or kind, the same words across sibling lanes, not in the title. Tag every ticket too with the module it touches, a short name (Auth, Board, MCP): check get_project's tagSuggestions and usedTags (or the tags list_tickets returns) first and reuse an existing tag in its casing rather than a new spelling; set_tag_suggestions replaces the project's suggestions (when the human asks, or to add a module its tickets keep touching). add_workspace registers where code runs (a worktree, a sub-branch, a sandbox): register every worktree you open, since that list is what gets cleaned up later; remove_workspace when it is gone.
5. post_update after each meaningful step: short markdown, what changed and what is next, with screenshots or logs as absolute file paths in files. A ticket's feed of posts has two tabs, and the board puts each post in one (its tab): Agents is your working record (progress posts, which post_update makes and lane summaries and the Daily view pick out; anything posted with as, such as the spec, builder and review phases; the resume note's versions); Main is the human's and stays short and to the point (their posts with your replies under them, decision cards, your questions to them: comment on the ticket, or post_update with progress: false; and the summary on top). tab on post_update, comment and ask_decision overrides the default, edit_post with tab moves a post; a lane's posts show in its parent's tabs the same way. Every post can have replies (comment on the post's id with parentType update). edit_post and delete_post change what you posted. A PR of the queue that no feature ticket names has a ticket of its own: list_prs names it as ticket. Reviews, findings and progress on that PR are posts there, not on a daily ticket. The board moves that ticket as the PR's status changes, and its questions and threads show in the human's Needs you as PR rows. The summary (set_ticket_summary) is the one post on top of Main: what the change does, where it stands, each review round's verdict in one line, the PR, the preview and what to try there, and the proofs as files. Rewrite it to the current state instead of posting a new hand-off: each write is a new version (change: what changed, one line), the board keeps every earlier one (get_ticket_summary), and each write reaches the human like a new post. When the change can be tried (a page, an API), have a preview the human can open before anything is merged. For a branch of the board itself, the board runs it: register your worktree (add_workspace with its path and branch; it must sit next to the repo's main checkout), then start_preview with the workspace's id. The board installs if the lockfile changed, builds, copies the live data and starts the build on a free port with sign-in off; get_ticket shows its state on the workspace (managedPreview: building, starting, running, failed with the last log lines, or stopped), and once it runs the workspace's previewUrl is set. Do not run pnpm dev in your session for it: that dies with your session. start_preview with restart: true rebuilds it after you push more work; stop_preview stops it, and the board stops it by itself when the PR is merged, the ticket is done, cancelled or archived, or the workspace is removed. For anything else, start your branch from your worktree on a free port with a copy of the data rather than the real one (the project's instructions say how) and register its link on the workspace (set_preview, or previewUrl on add_workspace). Either way post the link with what to try, say that what they post there stays in the copy, keep it running while the ticket is in review, and stop it once it is merged or dropped (clear a link you set with set_preview "").
6. Ask and answer with comment. When the human posts on a ticket you work, answer under their post (comment with replyTo, or parentType update), never with a new top-level post: first a reply with your plan, then, once done, a reply with the result and its proofs (files, the preview link); a reply brings their post back to the top of Main. When you cannot go on without the human, comment your question on the ticket and update_ticket to blocked; back to in_progress once answered. That is for when nothing else can go on: when only one step waits on the human, tag that task blocked instead (step 3) and keep working. When it is a choice between clear options (an approach, a trade-off, a scope call), ask_decision instead: the human answers with one click, and the ticket blocks and unblocks by itself. When the human answers a card in the chat rather than on the board, record their answer with answer_decision (the option they picked, and their words verbatim): ask them in the chat first, with AskUserQuestion in Claude Code or the client's equivalent, offering the card's options; if no card exists yet, ask_decision first, since it blocks the ticket. Only the session that talks to the human does this: never a delegated subagent, never with as, never in a run with no human to ask. If their answer matches none of the options, do not relay it: comment it on the card and ask again, or leave the card to the board. When you resume, and between steps, list_my_threads shows every ticket feed or reply thread where someone spoke after you; get_ticket shows each post's reply count and last author. Files on posts and replies come with a local path you can open. While you have tickets in progress or review, watch for feedback without being told: every few minutes call check_inbox with the cursor from your last call (in Claude Code, under /loop); for each new thread read it, fix what it asks the usual way (checks, commit, push, preview), reply in the thread with what changed, and keep the new cursor.
7. Hand off: before update_ticket to review, every item, in order, ticking each hand-off phase of the ticket as its item is done: (1) worktree registered (add_workspace), Implementation and its steps ticked; (2) checks green: typecheck, lint, unit tests, and the e2e suite when the repo has one; (3) branch pushed: get_ticket's push.state is pushed (green on the board), not ahead or local-only (red); (4) needs declared for any unmerged branch it builds on (below); (5) PR open and assigned to the human (gh pr create --assignee <their login>, or --assignee @me when you push with their account: GitHub never lets a PR's author be its requested reviewer, and the PR queue lists PRs assigned to them), and update_ticket with its prNumber (a PR's own ticket from the queue, if it has one, is then cancelled: this ticket takes the PR over); (6) preview running: start_preview on the workspace and wait for running (a repo the board cannot build: start one the project's way and set_preview); when the change cannot be tried (docs only, a script), say why in the summary; (7) the summary up to date (set_ticket_summary, never a new hand-off post): the PR link, the preview link and what to try there, how it was tested, the e2e result, each review round's verdict, and screenshots for a UI change as files, then tick Hand-off post (a tick is not a commit, so the summary still counts); (8) a resume note if the ticket stays open past the session. update_ticket to review answers with handoff.missing: what the board still sees missing (tasks_open: Implementation, the ticket's tasks and subtasks, its phases and their steps, the hand-off phases included: missing while it has none or some of them, its lanes' included, are open; the board ticks nothing itself, and its other checks still verify each fact; no_pr, not_pushed, no_preview, no_handoff_post when no agent wrote the summary since the branch's last commit, checks_unknown when the PR's CI is failing or running); fix each one. Briefing a subagent, put the same list in its brief. When your branch is built on another ticket's open branch, or you merged one in (to get past a conflict), declare it with update_ticket needs: [its id] instead of only writing "builds on" in the PR: the PR queue then says which PR to merge first, and the ticket cannot be done until that branch is merged into its base. get_ticket_git includes lists the tickets whose unmerged work your branch holds. done is the human's call. cancelled is for work that was dropped: say why in a comment. A ticket with lanes goes to review once its lanes are in review, done or cancelled. The human's verdict on a lane or ticket is approvedAt/approvedBy (approved) or disapprovedAt/disapprovedBy (disapproved, which also cancels it; approving a ticket tagged PR, a PR review, also moves it to done); you can read it, never set it. Treat an approved lane as settled and a disapproved one as dropped: ask in its thread before touching either. Archiving is the human's too: archivedAt set means the ticket (lanes included) is finished and off the board, and list_tickets leaves it out unless you pass archived. You may ask for it: request_archive posts the human one Archive / Keep card for done or cancelled top-level tickets, and only their Archive answer archives them; never archive any other way.
8. Clean up after yourself: once a lane's work is in its parent's branch (or a ticket's in its base), and before moving it to done, delete its local branch once no worktree holds it, and post_update the deleted branch names with their commit hashes (e.g. lane/47 @ 9ec12e8b) so any of them can be restored. Leave its worktrees, and the workspaces registered at them, to the human, who removes them from the Cleanup page. get_ticket_git says whether each branch's work arrived (reach); cleanup_report lists every leftover in the project, and cleanup_delete deletes closed tickets' landed local branches, the board checking each one again as for the human and answering how to restore it: post those branch @ sha lines on the ticket too. Never delete a branch whose reach is unique without the human's go-ahead, nor one cleanup_report marks protected, and never delete branches on origin nor remove worktrees: list them for the human, who does that from the Cleanup page.
9. End of session: for every ticket you leave in progress, blocked or review, set_resume_note with its template filled in (state, done so far, next steps, open questions or blockers, how to resume: branch, worktree, commands, preview, gotchas), concretely enough that another agent can continue without asking. Then the project's report, if it keeps one (get_report_settings: cadence daily or weekly): one report per period, due at the end of the project's shift. list_reports shows which periods are done, missing, upcoming or off; write the current or a missing one as the prompt says, in the shape of the template (its headings, in order), from daily_report for the days it covers, and post_report it (files as absolute paths). reportDue on get_summary and check_inbox says when the human expects it (due soon, or missing): write it then, with the human's go-ahead.

The project's agents: get_project lists them (agents: name, instructions, delegation notes, picture). They are personas the human defined, not connected tools; you work for them. A ticket assigned to one (reserved: true; get_ticket's agent has its instructions) is that agent's alone: claim_ticket with as: <its name>, brief a subagent with its instructions (and the ticket's), and post that work with post_update and comment using as: <its name>, so it shows under the agent's name, via you. Never take a reserved ticket as yourself, reassign it, or work it without the agent's instructions; only the human reassigns it. A thread can wait on an agent too: when someone @mentions it, or replies on its ticket or post, list_my_threads returns that thread with as: <its name>; answer it with comment as: <its name>, in that agent's voice and instructions. Orchestrating: each agent's delegation notes say when to call it, what to give it, what it returns and what comes next. With them you can work a ticket as its orchestrator instead of doing the work yourself: run each step as a subagent briefed with that agent's instructions, the project's instructions and the ticket; post what it returns on the ticket as that agent (as: <its name>, progress: true: it goes to the Agents tab), and keep the ticket's summary current with what the human needs from it; go where its notes say next. The default set (spec, builder, runner, and the review phases env, verify, hunt, refute, merge) is the cycle spec → build → review that tries to break it → (a fix pass by the builder on the confirmed findings, each with the project's checks and a new review, for as many review rounds as the ticket's complexity allows: none for low, one for mid, three for high; round 1 is the first build and its review, so a mid ticket stops after its review, and a review that does not survive after the last round goes to a human decision; a high ticket gets two fix passes; a low ticket has no review, and its checks return the build at most twice; after the second return, when the checks still fail or a criterion still has no evidence, the human decides (keep going or drop), and the build goes to hand-off only with evidence for every criterion) → hand off; the /review-queue skill runs it (/feature-review is its review). The agents' thinking effort follows the complexity too: low for a low ticket, medium for mid and high; the orchestrator passes it as the Agent tool's effort on every agent it starts for the ticket (the ticket agent, the spec agent, the builder and the review's phase agents). Ask the human with ask_decision instead of guessing, never run two builders on one branch, never delegate to an agent without delegation notes, and a persona never answers a decision. The board skill has the full routine.

When a project has several repos, pass repoId to create_ticket and post_review_result. Plain words, titles under 80 characters; the human reads dozens of these a day.

Keep the board out of the repo. The board and any other personal tracking tool are private to the human: never mention them, their tool names, their URLs (localhost:47100) or a board ticket, task or project ("#12", "ticket 12", "per the board") in code comments, docs, READMEs, changelogs, config, commit messages, branch names, PR titles or descriptions, or issues, and never link or screenshot the board there. Describe the change and its reason in the repo's own terms; if the PR needs something from the ticket, restate it instead of pointing at it. Board updates and comments may talk about the repo, branches and PRs freely.`

const STATUS =
  'a stage key from get_project, a stage name, or a kind (open, active, blocked, review, done, cancelled; todo and in_progress also work): the first stage of that kind'
const COMPLEXITY =
  "how much review the ticket gets: low none (the builder verifies itself), mid one review round, high three. Mid when left out; a lane without one copies its parent's."
const AS = z
  .string()
  .optional()
  .describe("one of the project's agents (get_project): post under its name, as the work you did for it")
const TAB = z
  .enum(FEED_TABS)
  .optional()
  .describe(
    "the tab of the ticket's feed it goes to: main (the human's) or agents (your working record). Leave it out and the board picks: progress posts and posts made with as go to agents; the human's posts, decision cards, questions to the human and the summary to main",
  )
const SINCE = z
  .string()
  .optional()
  .describe('an ISO time, normally the cursor of your last call: only threads with a new word after it')
const PREVIEW_URL =
  'where the branch runs for the human to try, http(s) only: http://localhost:<port> (the board checks whether localhost links are up)'
const NEEDS =
  "ticket ids whose branches must be merged into this ticket's base before it can be done: the branch this one is built on (stacked), or one it merged in to get past a conflict. Same project, not itself, no cycles."
const TASKS =
  "Each item is a task, or {text, subtasks} for a task with the subtasks that go under it. Two levels and no more: the top level is the ticket's phases (a new ticket starts with its project's default phases: Implementation, then the hand-off's Pushed, PR, CI, Preview, Hand-off post), and the concrete steps go under a phase as its subtasks, the work's under Implementation."
const BLOCKED =
  "blocked: true tags the task as waiting on the human (a credential, a manual action, a call only they can make), blockedReason says what they must do (only with blocked; up to 500 characters). A blocked task still counts as open and does not move the ticket; it shows on the ticket's card and in the human's Needs you."
const BLOCKED_REASON = z
  .string()
  .max(500)
  .optional()
  .describe('what the human must do, shown with the tag; only with blocked: true')
const DEFAULT_PHASES =
  "start with the project's default phases (get_project's defaultPhases) as the top-level tasks. Left out: a top-level ticket does, a lane does not (its parent carries the hand-off). false: the tasks exactly as given, no phases; true: a lane gets them too."
const NEW_TASKS = z.array(
  z.union([
    z.string(),
    z.object({
      text: z.string(),
      subtasks: z.array(z.string()).optional(),
      blocked: z.boolean().optional(),
      blockedReason: BLOCKED_REASON,
    }),
  ]),
)
const TAGS = `Short labels the human filters tickets and lanes by: the module the ticket touches (a short name such as Auth, Board, MCP), a kind (Bug, UI, Implementation, Report…) or a severity (Critical, High, Medium, Low, Cosmetic). One or two words each; before tagging, read get_project's tagSuggestions and usedTags (or the tags list_tickets returns) and reuse a tag already there in its exact casing rather than a new spelling; keep them out of the title (no "[High] …").`

function buildServer(actor: string, agent: boolean) {
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

  tool('whoami', 'The name the board knows you by (your agent token name).', {}, () => ({ actor }))

  // projects
  tool(
    'list_projects',
    'All projects on the board, each with its repos (id, name, checkout path, GitHub slug, base branch).',
    {},
    () => projects.listProjects(),
  )
  tool(
    'get_project',
    "One project with its repos, its stages (the board's columns in order: key, name, kind), its agents (personas with a name, instructions, delegation notes saying when the orchestrator should call them, and a picture; tickets can be reserved for them), defaultPhases (the top-level phases every new ticket starts with, in order; built in: Implementation, Pushed, PR, CI, Preview, Hand-off post; [] when the project seeds none; only the human changes the list), tagSuggestions (the tags the human offers for tickets; built in: Bug, UI, Implementation, Report), usedTags (the tags its tickets carry, most used first, each in the casing to reuse), hostTools (the board's last check of the tools on its machine: checkedAt, and for each of git, gh, claude, node and pnpm its name, found, version, signedIn for gh and ok; one not ok also says what it breaks, the problem and the fix: a feature that needs it fails until the human fixes it; null before the first check ends) and the instructions agents must follow when working on it. Read this before touching a project.",
    { projectId: z.number().int() },
    ({ projectId }) => projects.getProjectFull(projectId),
  )
  tool(
    'set_tag_suggestions',
    "Replace the project's tag suggestions (get_project's tagSuggestions): the tags offered under every ticket's tags field. Each is trimmed, at most 40 characters and without a comma; repeats in any casing are dropped, at most 50; [] offers none. Change them when the human asks, or to add the name of a module the project's tickets keep touching. Returns the saved tagSuggestions and usedTags.",
    { projectId: z.number().int(), tags: projects.TagSuggestions },
    ({ projectId, tags }) => {
      projects.updateProject(projectId, { tagSuggestions: tags }, actor)
      const { tagSuggestions, usedTags } = projects.getProjectFull(projectId)
      return { tagSuggestions, usedTags }
    },
  )

  tool(
    'get_summary',
    "Where a project stands, in one read (every project, one block each, without projectId): reportDue (the project's report while the board is reminding about it: { projectId, project, cadence, period, label, dueAt, alertAt, state due or missing, minutesLeft, negative once overdue }, null otherwise), needsYou (open decisions, PRs waiting on the human's review, threads waiting on the human, tickets in a review stage, and blockedTasks: each task or subtask tagged blocked on a ticket still being worked, not done, cancelled or archived nor under one that is: taskId, text, reason, parentTask (the text of the task it is a step of, null for a top-level one), ticketId, ticketTitle, status, parent (the ticket it is a lane of); total counts them all), inProgress (tickets in active or blocked stages: assignee, task progress, blockedTasks, lanes, last progress post, preview, since when, stale when no progress post in 24 hours), doneToday (tickets that reached a done stage today, PRs that left the queue today, today's activity count), next (the head of the first open stage that is not a backlog, with how many are blocked and in the backlog) and carryingOver (tickets in progress since before today, each with resume: its resume note as a short plain-text excerpt with who wrote it when, noHandoff when nobody left one since the last day it was worked, stale when a progress post came after it, and which day of work this is). A PR's own ticket is in none of these lists: its decisions and threads waiting on the human are in needsYou as PR rows (prTicket true). Today is the board's local day. Read it when starting a session.",
    { projectId: z.number().int().optional() },
    ({ projectId }) => getSummary(projectId, { refreshPrs: true }),
  )

  // PR queue
  tool(
    'list_prs',
    "The human's PRs across all repos of the project: open, and merged in the last 14 days. waitingOn is me (someone else authored it: the human reviews it) or others (the human authored it on GitHub, agents' PRs pushed with their account included). status is where its reviews stand: for waitingOn me, by the human's own reviews (pending: not approved by them, or their comments were addressed by a push or a new review request; reviewed: they approved; on_hold: their comments or requested changes stand at the head); for others, by everyone else's (pending: approvals missing; reviewed: reviewDecision APPROVED, or every reviewer approved and no review is still requested; on_hold: someone's comments or requested changes stand at the head); done: merged. A board-side hold puts an open PR in on_hold. myReview is the human's standing verdict. Also the repo and the latest review verdict. Where it stands on GitHub as of the last refresh: merge (clean | conflicts | behind | blocked | checking; an open PR's is first checked in the repo's checkout against origin's base, so a base that moved shows at the next fetch, and mergeCheck {source local | github, at, base, outdated} says which and as of when), ci (passing | failing | pending | none) with checks[] {name, state pass | fail | pending | skipped, url}, reviewDecision and isDraft. ticket is the ticket its card opens: the feature ticket that names the PR (by its prNumber, or by its branch when it names no PR), else the PR's own ticket the board opened for it, or null; tickets lists the feature tickets only. mergeAfter lists the open PRs of tickets its tickets need: merge those first.",
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
    "Record the outcome of a PR review you performed: verdict plus a markdown summary (findings, how to test, checks). The human reads it from its verdict on the PR queue. It is also posted as a progress post on the PR's ticket (list_prs ticket) when the PR has one.",
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
    "Tickets of a project (all its repos; a PR's own ticket, which the board opens for a PR of the queue, is left out: list_prs names it as ticket) with status, assignee, reserved (assigned to one of the project's agents: only that agent works it), repoId, branch, parentId, complexity (low, mid or high: how much review it gets), tags, task progress (own and rolled up over lanes), blockedTasks (its open tasks and subtasks tagged blocked on the human, over the same lanes as the rolled-up progress), lane counts (total, approved, disapproved, byStage: per stage key), and the human's verdict: approvedAt/approvedBy or disapprovedAt/disapprovedBy (a disapproved ticket is moved to the cancelled stage), startedAt (when work on it last started), and resume: whether its resume note holds (at: when it was written, null for none; stale: the work moved on since; noHandoff: it carried over from an earlier day without one; day: which day of work this is). status is a stage key (see get_project). needs lists the tickets it needs merged first, each with merged (see get_ticket). Cancelled lanes' tasks are left out of the rolled-up progress. Archived tickets (finished work the human took off the board, lanes with it; archivedAt/archivedBy) are left out unless archived says otherwise.",
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
      q: z
        .string()
        .optional()
        .describe(
          "text to find (any casing) in the ticket's #id (#12 or 12), title, instructions or thread (its posts and the replies under them). Tickets found by name (#id, title) come first, then the rest; each row says where in match (id, title, body, post, reply) with snippet: the words around a hit in the content",
        ),
      archived: z
        .enum(['include', 'only'])
        .optional()
        .describe('include: archived tickets too; only: just the archived ones. Omit to leave them out'),
    },
    ({ projectId, ...filter }) => needs.ticketRows(projectId, filter),
  )
  tool(
    'get_ticket',
    "A ticket in full: instructions and the files attached to them (attachments, each with a local path), complexity (low, mid or high: how much review it gets), agent (the project agent it is reserved for, with its instructions; null when shared), tasks (one flat list in tree order: each top-level task followed by its subtasks; parentId is null on a top-level task, else the task it is a subtask of; blocked: true when it waits on the human, blockedReason: what they must do, '' when none), blockedTasks (how many of its open tasks and subtasks are blocked, its lanes' included as in rollup), workspaces (each with managedPreview: the preview the board builds and runs from it, null when it never ran one; status building | starting | running | failed | stopped, step, port, url, reason, tail: the last log lines when it failed, logs: their paths), its parent chain, its lanes with their last progress post and verdict, the feed of posts (updates: newest first, each with tab: main or agents, the tab of the feed it shows in; progress true for a step of the work or false for discussion; summary true on a version of the summary; editedAt, attachments with a local path, and thread: its reply count, last author and time), summary (the one at the top of Main: body, change, at, by, via, attachments, postId, versions: how many were written, get_ticket_summary has them; fallback: true when none was written yet and the newest agent progress post stands in; null when there is neither), thread on the ticket (how many posts, who posted last), pr: the PR it was opened as (prNumber, or the open PR on its branch) with its latest review, and push: whether its branch is on origin (state pushed: origin has every commit, behind counts what origin has on top; ahead: ahead commits are only local; local-only: origin has no such branch; merged: origin has no such branch any more and it was merged into the ticket's base, into; remote-only: only origin has it; none: no branch, or it exists nowhere; checkedAt: when origin was last fetched, every few minutes), likewise on each workspace. A ticket goes to review only with its branch pushed. handoff, in a review stage (null otherwise): what the hand-off still lacks, as update_ticket answers it. approvedAt/approvedBy or disapprovedAt/disapprovedBy is the human's verdict (both null: no call yet; disapproved also means cancelled). archivedAt/archivedBy is set when the human archived it (or the ticket it is a lane of): finished, off the board. resume is where the last session left off: note (markdown; '' when none), at, by, sha (the branch head when it was written), commitsSince (commits on the branch since; null when unknown), stale (new commits or a newer progress post since), noHandoff (in progress, blocked or review since an earlier day with no note written since) and day (which day of work this is). Read the note before anything else when you pick the ticket up; handoff: true marks its earlier versions in the feed. needs: the tickets whose branches must be merged into its base before it can be done ({id, title, branch, prNumber, status, merged, into}); neededBy: the tickets that need this one. A decision post (decision: its options) also carries decidedOption and decidedBy, and relayedBy and relayedText when the orchestrator relayed the human's answer from the chat (decidedBy is '' then; both relay fields are '' when the human answered on the board).",
    {
      ticketId: z.number().int(),
      laneUpdates: z.boolean().default(false).describe("include the lanes' posts in the feed"),
    },
    ({ ticketId, laneUpdates }) => needs.ticketView(ticketId, { laneUpdates }),
  )
  tool(
    'create_ticket',
    "Create a ticket (a feature or piece of work) with optional initial tasks. A top-level ticket starts with its project's default phases (get_project's defaultPhases: Implementation, Pushed, PR, CI, Preview, Hand-off post unless the project changed them): tasks given as plain texts become the steps under the first phase, and {text, subtasks} items are phases of yours that go right after it. With parentId it is a lane of that ticket: a parallel piece of it with its own assignee, branch, tasks and updates, which starts without phases unless defaultPhases is true. defaultPhases false stores the tasks exactly as given. complexity sets how much review the ticket gets (low, mid or high; mid by default, and a lane without one copies its parent's).",
    {
      projectId: z.number().int(),
      title: z.string(),
      body: z.string().default('').describe('markdown instructions'),
      status: z
        .string()
        .optional()
        .describe(`${STATUS}. Defaults to the last open stage (To do rather than Backlog)`),
      complexity: z.enum(COMPLEXITIES).optional().describe(COMPLEXITY),
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
      tasks: NEW_TASKS.default([]).describe(
        `${TASKS} With the default phases, plain texts go under the first phase and {text, subtasks} items right after it.`,
      ),
      defaultPhases: z.boolean().optional().describe(DEFAULT_PHASES),
      prNumber: z
        .number()
        .int()
        .optional()
        .describe(
          "the PR opened from this ticket's branch; a PR of the queue that had its own ticket has it cancelled, and this ticket takes the PR over",
        ),
      needs: z.array(z.number().int()).optional().describe(NEEDS),
    },
    ({ projectId, ...rest }) => needs.newTicket(projectId, rest, actor, { agent: true }),
  )
  tool(
    'update_ticket',
    "Change status, assignee, branch, tags, prNumber, title, instructions or complexity (the review level, low, mid or high). Use claim_ticket to pick a ticket up. Changing the assignee of a ticket reserved for one of the project's agents fails: only the human reassigns those. Status blocked means you are waiting on the human: say what for in a comment on the ticket. A move to done is refused while one of its needs is not merged into its base (the error says which); merge order is the human's, so leave it in review. A move to a review stage goes through and answers with handoff: missing [{code, text}] lists what the hand-off still lacks (tasks_open: Implementation, the ticket's tasks and subtasks, its phases and their steps, the hand-off phases included: missing while it has none or some of them, its lanes' included, are open; no_pr: no PR set or open on the branch; not_pushed: the branch is not on origin; no_preview: no preview the board runs or that answers; no_handoff_post: no summary written by an agent (set_ticket_summary) since the branch's last commit, or since work started without one; a ticket that never had a summary still passes with an agent's progress post since then; checks_unknown: the PR's CI is failing or still running), and checks has every item with ok, first not_merged (Merged: the PR merged on GitHub or the branch merged into its base), which is never in missing: merging is the human's. Fix what it lists.",
    {
      ticketId: z.number().int(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.string().optional().describe(STATUS),
      complexity: z.enum(COMPLEXITIES).optional().describe(COMPLEXITY),
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
        .describe(
          "the PR opened from this ticket's branch, in the ticket's repo; null unlinks it. A PR of the queue that had its own ticket has it cancelled, and this ticket takes the PR over",
        ),
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

It replaces the previous note; each new version is also posted to the ticket's feed (handoff: true, in the Agents tab), so older ones stay readable. It is for whoever works the ticket next, not the human's hand-off: that is the summary (set_ticket_summary). The board records the branch head, so commits made after it show as commits since the note.`,
    {
      ticketId: z.number().int(),
      note: z.string().min(1).describe('markdown, the template filled in'),
      as: AS,
    },
    ({ ticketId, note, as }) => features.setResumeNote(ticketId, note, actor, { as }),
  )
  tool(
    'add_tasks',
    `Append tasks to a ticket. ${TASKS} With parentTaskId (a top-level task of this ticket, such as Implementation) they are added as subtasks of it: the way to put the steps under a phase. A subtask cannot have subtasks, so a third level is refused and nothing is added. Without parentTaskId they are phases, appended at the end; a ticket with no tasks gets its phases this way (the names from get_project's defaultPhases, the steps under the first). Tasks and subtasks all count in the progress, and they are the hand-off's Implementation item (tasks_open), met once the ticket has tasks and every one, its lanes' included and the hand-off phases too, is done. An item given as an object can also come tagged blocked: {text, blocked: true, blockedReason} (its subtasks stay plain texts; tag those with update_task). ${BLOCKED}`,
    {
      ticketId: z.number().int(),
      tasks: NEW_TASKS.min(1),
      parentTaskId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('add the tasks as subtasks of this top-level task of the ticket'),
    },
    ({ ticketId, tasks, parentTaskId }) => features.addTasks(ticketId, tasks, actor, { parentTaskId }),
  )
  tool(
    'set_task_done',
    'Tick or untick a task or a subtask. A task with subtasks is done exactly when all of them are: ticking or unticking it does the same to its subtasks, ticking its last open subtask ticks it, and unticking one of them unticks it. A done task waits on nobody: ticking clears its blocked tag, and that of every task the tick reaches (its subtasks, a parent its last subtask ticks); unticking does not bring a tag back.',
    { taskId: z.number().int(), done: z.boolean().default(true) },
    ({ taskId, done }) => features.updateTask(taskId, { done }, actor),
  )
  tool(
    'update_task',
    `Reword a task or a subtask, tick / untick it (ticks keep a task and its subtasks in step, as set_task_done says), or tag it blocked on the human and clear that. When a step needs the human (a credential, a manual action, a call only they can make), set blocked: true with blockedReason saying what they must do, and keep working on the rest; blocked: false clears the tag and its reason once resolved (ticking it done clears it too). A reason alone rewrites the reason of a blocked task. Tagging a done task reopens it, as unticking would; done: true with blocked: true is refused. The tag is for one step: move the whole ticket to blocked (update_ticket) or ask_decision only when nothing else can go on. ${BLOCKED}`,
    {
      taskId: z.number().int(),
      text: z.string().min(1).optional(),
      done: z.boolean().optional(),
      blocked: z.boolean().optional().describe('true: waiting on the human; false: clear the tag'),
      blockedReason: BLOCKED_REASON,
    },
    ({ taskId, ...patch }) => features.updateTask(taskId, patch, actor),
  )
  tool(
    'remove_task',
    'Remove a task or subtask that is no longer part of the plan, so it stops counting in the progress bar. Removing a task removes its subtasks.',
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
    "Have the board build and run a branch of the board itself as a preview, from the workspace's worktree (its registered path: a git worktree next to the repo's main checkout, never the main checkout). In the background: pnpm install when the lockfile changed, pnpm build, a fresh copy of the live data, then the built server on a free port from 47101 with sign-in off; once it answers the workspace's previewUrl is set. Returns at once with status building; get_ticket (the workspace's managedPreview) follows it to running, or failed with the last log lines. One per workspace; at most as many at once, board-wide, as the human's preview limit allows (8 by default): a start beyond it is refused with the limit, a restart of a running one is not. restart: true stops a running one first and builds again.",
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
    "Post on a ticket: markdown plus optional files (screenshots, recordings) given as absolute paths on this machine. progress (default true) marks it as a step of the work; false makes it discussion, like comment on the ticket. A progress post, and any post made with as, goes to the feed's Agents tab, out of the human's way; the hand-off is the summary (set_ticket_summary), not a post, and an answer to the human's post is a reply under it (comment with replyTo), not a new post. tab says otherwise.",
    {
      ticketId: z.number().int(),
      body: z.string(),
      files: z.array(z.string()).default([]).describe('absolute paths to attach'),
      as: AS,
      progress: z.boolean().default(true),
      tab: TAB,
    },
    async ({ ticketId, body, files, as, progress, tab }) => {
      const ids = (await Promise.all(files.map((f) => uploads.saveFromPath(f, actor)))).map((a) => a.id)
      return features.postUpdate(ticketId, body, ids, actor, { as, progress, tab })
    },
  )
  tool(
    'set_ticket_summary',
    "Write the ticket's summary: the one post at the top of the feed's Main tab, for the human, and the hand-off (no_handoff_post reads it). Short and to the point: what the change does, where it stands now, each review round's verdict in one line, the PR, the preview and what to try there, and the proofs (screenshots, recordings) as files. Rewrite it to the current state instead of posting a new hand-off: each write replaces it, and the board keeps every earlier version as its history. change says in one line what changed since the last version (required from the second version on), shown as \"updated <time>: <change>\". Like a new post, every write bumps the ticket and reaches the human's Needs you and the inboxes. Returns the summary as get_ticket shows it.",
    {
      ticketId: z.number().int(),
      body: z.string().describe('markdown: the whole summary as it stands now'),
      change: z
        .string()
        .max(features.MAX_SUMMARY_CHANGE)
        .optional()
        .describe('what changed since the last version, one line; required from the second version on'),
      files: z.array(z.string()).default([]).describe('absolute paths to attach: the proofs'),
      as: AS,
    },
    async ({ ticketId, body, change, files, as }) => {
      const ids = (await Promise.all(files.map((f) => uploads.saveFromPath(f, actor)))).map((a) => a.id)
      return features.setSummary(ticketId, { body, change, attachmentIds: ids, as }, actor)
    },
  )
  tool(
    'get_ticket_summary',
    "A ticket's summary with its history: summary as get_ticket shows it, and versions, every version written, newest first, each with postId, body, change, at, by, via and attachments (local paths). Nothing is ever deleted from it.",
    { ticketId: z.number().int() },
    ({ ticketId }) => ({
      summary: features.getTicketFull(ticketId).summary,
      versions: features.summaryHistory(ticketId),
    }),
  )
  tool(
    'ask_decision',
    'Ask the human to make a call you should not make alone, as a decision card on the ticket: body is the question (markdown: the context, what each choice means for the work), options are 2 to 5 answers, each a short label with an optional detail; mark at most one recommended. The card goes to the Main tab of the feed, also when made with as. The ticket moves to blocked (block: false to keep it where it is) and goes back to in progress once decided. The answer arrives as a reply under the card (list_my_threads); get_ticket shows decision and decidedOption on the post. When the human answers in the chat instead, the orchestrator records it with answer_decision.',
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
      tab: TAB.describe("the tab of the ticket's feed it goes to; main, the human's, when left out"),
    },
    ({ ticketId, ...input }) => features.askDecision(ticketId, input, actor),
  )
  tool(
    'request_archive',
    "Ask the human to archive finished tickets: one decision card, \"Archive #12, #15?\" with Archive and Keep, on the first ticket named (Main tab; it does not block or move any ticket). It shows in the human's Needs you. Nothing is archived until the human answers Archive on the board, or you relay their chat answer with answer_decision after asking them; then each ticket that is still finished is archived as the human's own archive does it (archivedBy the human, lanes with it), and Keep changes nothing. You can never archive directly. Each ticket must be in this one project, top-level (a lane goes with its ticket), in a done or cancelled stage, and not archived yet: one that is not refuses the whole request, the error naming each failing ticket and why, and no card is posted. Returns the card's post (its id is the postId answer_decision takes).",
    {
      ticketIds: z
        .union([z.number().int(), z.array(z.number().int()).min(1).max(features.MAX_ARCHIVE_REQUEST)])
        .describe('the ticket to archive, or a list of them (up to 50)'),
      as: AS,
    },
    ({ ticketIds, as }) => {
      if (!agent) throw new HttpError(403, 'the human archives tickets directly; agents ask here')
      return features.requestArchive(Array.isArray(ticketIds) ? ticketIds : [ticketIds], { as }, actor)
    },
  )
  tool(
    'answer_decision',
    "Record the human's answer to a decision card, given in the chat, as the orchestrator. Call it only in the session that talks to the human, after you asked them the card's question in the chat (AskUserQuestion in Claude Code, or the client's equivalent) and they answered there. postId: the card's post (get_ticket, or needsYou.decisions in get_summary). option: the index of the option they picked, as the card lists them. words: their answer as they gave it, verbatim. The card is recorded as decided by the human, relayed by you, with their words; the ticket goes back to in progress once nothing else is open. On a request_archive card, Archive then archives its tickets in the human's name. Refused: a human caller; any call with as (one of the project's agents); empty words; an option the card does not have; a post that is not a decision; a card already decided (the human changes it on the board). A delegated subagent never answers a decision either, and the server cannot tell one that calls without as from you: keeping to this is your job.",
    {
      postId: z.number().int().describe("the decision card's post id"),
      option: z
        .number()
        .int()
        .min(0)
        .describe('the index of the option the human picked, as the card lists them'),
      words: z.string().describe("the human's answer as they gave it, verbatim (1 to 5000 characters)"),
      as: z
        .string()
        .optional()
        .describe(
          'leave it out: a call that sets it is refused, since the orchestrator relays a decision itself',
        ),
    },
    (args) => features.relayDecision(args.postId, args, actor, { agent }),
  )
  tool(
    'edit_post',
    'Change a post you made on a ticket (its body, whether it is progress, or its tab of the feed: tab main or agents moves it), or a reply (kind reply: its body). Edits show as edited. A version of the summary is never edited: write a new one with set_ticket_summary. Nor is the body of a request_archive card: ask again instead.',
    {
      kind: z.enum(['post', 'reply']).default('post'),
      id: z
        .number()
        .int()
        .describe('the post id (from get_ticket updates) or the reply id (from list_comments)'),
      body: z.string().min(1).optional(),
      progress: z.boolean().optional().describe('posts only'),
      tab: z
        .enum(FEED_TABS)
        .optional()
        .describe("posts only: move it to that tab of the ticket's feed (main or agents)"),
    },
    ({ kind, id, body, progress, tab }) => {
      if (kind === 'post') return features.editPost(id, { body, progress, tab }, actor)
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
    "What finished work left behind: every ticket in a done or cancelled stage (or archived) that still has a registered workspace, a local or origin branch, or a worktree. previews lists the previews the board still runs from its workspaces (stop_preview). Each branch comes with its local and origin sha, the worktrees holding it, reach against the ticket's base chain (merged, rebased, edited: safe to delete; unique: still has work, commits listed; null: nothing to compare against) and remoteReach, origin's copy judged by its own commits against origin's copies of the bases, the commands that restore each copy, protected (why it is never deleted: a base, the main checkout's branch, origin's default branch, in use by a ticket in work or an open PR; leave those) and can (what may be deleted, and why not: local by you with cleanup_delete, or by the human; worktrees and remote by the human alone, from the Cleanup page). safe is true only when every branch landed, here and on origin, and nothing is protected. repos says which repo git could not read. untracked lists worktrees no ticket or workspace accounts for. Origin branches are as of the last fetch. Never delete origin's branches nor remove worktrees: list them for the human. uploads counts the board's unattached uploads older than a day (no post, reply, ticket, agent picture or text points at them): the board deletes those by itself every hour, and the human can from the Cleanup page.",
    { projectId: z.number().int() },
    ({ projectId }) => cleanupReport(projectId),
  )
  tool(
    'cleanup_delete',
    "Delete closed tickets' (done, cancelled or archived) landed local branches, as cleanup_report lists them (kind local). Each item as the report gives it: ticketId, branch, kind local and sha (the branch's local sha you read there, null when it had none; one that moved since is not deleted). The board checks each item again first, as for the human on the Cleanup page: the ticket is still closed, the work landed (reach merged, rebased or edited, never unique), the branch is not protected, and no worktree has it checked out. Never a worktree, never origin: removing worktrees and deleting branches on origin are the human's, from the Cleanup page; list them for them. Returns each item, in the order asked, with ok, outcome (deleted; gone: it was gone already; refused or failed, with the reason; one refused does not stop the next) and restore: the command that puts the branch back (git branch <name> <sha>). Post the deleted branch @ sha lines on the ticket (post_update).",
    { projectId: z.number().int(), items: AgentDeleteItems },
    ({ projectId, items }) => deleteLeftovers(projectId, items, actor, { agent: true }),
  )

  // threads
  tool(
    'list_my_threads',
    "Threads in a project waiting on you: on a ticket assigned to or opened by you, your update or review, or any thread you spoke in, where someone else spoke last. Also threads waiting on one of the project's agents (it was @mentioned last, or it spoke there, or it is its ticket or post), with as set to that agent: answer those with comment as: <it>. Returns { cursor, threads }: threads newest first, each with its parent (for list_comments and comment), the ticket, tab (the tab of the ticket's feed the post is in, main or agents; null off a ticket), how many comments came since you (or the agent) last spoke, and the last one. With since, only the threads whose last word came after it; cursor is the newest one seen (since when nothing new; null until there is one), to pass as since next time.",
    { projectId: z.number().int(), since: SINCE },
    ({ projectId, since }) => features.myThreads(projectId, actor, since),
  )
  tool(
    'check_inbox',
    "The cheap poll for new comments while you work: what list_my_threads with since finds, without bodies. Returns { count, cursor, threads: [{ ticketId, title, parentType, parentId, as, lastAuthor, lastAt }], reportDue }. Keep cursor and pass it as since next time; read each thread with list_comments, answer it with comment (as: <it> when as is set). reportDue is the project's report while the board is reminding about it ({ projectId, project, cadence, period, label, dueAt, alertAt, state due or missing, minutesLeft, negative once overdue }; null otherwise): the human expects it, so offer to write it (post_report).",
    { projectId: z.number().int(), since: SINCE },
    ({ projectId, since }) => features.checkInbox(projectId, actor, since),
  )
  tool(
    'list_comments',
    "A conversation, oldest first: on a ticket, its posts (with progress, tab: main or agents, and summary on the summary's versions); under a post (parentType update, the post's id), its replies; under a review result, its comments. Attachments come with a local path you can open.",
    { parentType: z.enum(COMMENT_PARENTS), parentId: z.number().int() },
    ({ parentType, parentId }) => features.listComments(parentType, parentId),
  )
  tool(
    'comment',
    "Say something. On a ticket it becomes a post in its feed (not progress): in Main, the human's tab, unless made with as (Agents); with replyTo it is a reply under that post instead. Answering the human's post, reply under it (a plan first, then the result with its proofs), never with a new post. Under a post (parentType update, the post's id) or a review result it is a reply; replyTo nests it under another reply. @name mentions one of the project's agents, which puts the thread in list_my_threads for whoever answers as it.",
    {
      parentType: z.enum(COMMENT_PARENTS),
      parentId: z.number().int(),
      body: z.string(),
      replyTo: z.number().int().optional(),
      files: z.array(z.string()).default([]),
      as: AS,
      tab: TAB.describe(
        "on a ticket without replyTo: the tab of its feed the post goes to. Left out: main, or agents when posted with as. A reply goes under its post, in that post's tab",
      ),
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
    'list_gallery',
    "The project's files, newest first unless sort says otherwise (oldest, name, name-desc, largest, smallest, type): every file on its tickets' posts, on the replies under those posts and with their instructions (not on a PR's own ticket, its discussion), each with name, type, kind, size, who uploaded it and when, the absolute path to open it on this machine (windowsPath too when the board runs in WSL), its ticket (id, title: for a lane's file, the top-level ticket, whose page shows the lane's posts too), lane (id, title of the lane that holds it, or null), where it is (source: post, reply or instructions, with postId and commentId) and anchor (the #hash of the ticket page's link to that post or reply). Files of archived tickets only with archived: include. A page at a time: pass next back as cursor for the next one, null after the last.",
    { projectId: z.number().int(), ...galleryShape },
    ({ projectId, ...filters }) => listGallery(projectId, filters),
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
    "A day's activity: every write anyone made, in order, each with its project.",
    {
      date: z.string().default(today()).describe('YYYY-MM-DD, local'),
      projectId: z.number().int().optional(),
    },
    ({ date, projectId }) => dailyReport(date, projectId),
  )
  tool(
    'post_daily_summary',
    "The same as post_report for the project's current period, kept for older instructions: use post_report. Stores body as a new version of the current period's report and answers with it.",
    { projectId: z.number().int(), body: z.string() },
    ({ projectId, body }) => reports.postReport(projectId, { body }, actor),
  )

  // reports
  tool(
    'get_report_settings',
    "How the project's reports are made: prompt (markdown: what each report must say and how: audience, tone, what to stress, a short text or a PDF), template (the markdown skeleton a report fills: its headings, in order, are the report's sections; templateIsDefault when the project never set one), cadence (off, daily on the workdays, or weekly due on weekday 1 Monday to 7 Sunday), shiftStart and shiftEnd (local HH:MM; the report is due at the shift's end), workdays (ISO weekdays 1 to 7), alertMinutes (how long before the shift's end the board starts reminding) and format (text, or file: the report is an attached file such as a PDF). pending lists agents' changes of the prompt or template the human has not accepted or reverted yet. Follow the prompt and the template when you write a report.",
    { projectId: z.number().int() },
    ({ projectId }) => reports.getReportSettings(projectId),
  )
  tool(
    'set_report_settings',
    "Change how the project's reports are made: any of prompt, template, cadence, weekday, shiftStart, shiftEnd, workdays, alertMinutes and format; what you leave out stays. Change prompt or template only when the human asked for that change in this conversation; each change is kept with the previous version, shows in the project's activity, and stays flagged for the human until they accept or revert it.",
    { projectId: z.number().int(), ...reports.reportSettingsShape },
    ({ projectId, ...patch }) => reports.setReportSettings(projectId, patch, actor, { agent: true }),
  )
  tool(
    'post_report',
    "Post the project's report for a period: body (markdown, may be a single line; when the project has a template, fill its headings in order) and/or files (absolute paths on this machine, e.g. the PDF you made; the board does not make PDFs). A file-format project needs a file. period is a day, YYYY-MM-DD (for a weekly cadence any day of the week; the week's Monday is kept), by default the current one. Posting again for a period adds a newer version, which becomes its report; the earlier ones stay as history.",
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
    "The project's report periods, newest first, from from to to (YYYY-MM-DD, a whole month at once if you like; by default the last two weeks of a daily cadence or eight weeks of a weekly one, up to today), each with due (the shift's end on its day), status (done: it has a report; missing: due and none posted; upcoming: not due yet; off: not asked for, a day outside the workdays or before tracking began), its latest report (body, author, attachments with a local path) and how many versions were posted. Also the schedule, the current period, generating (the period claude is writing the report of right now, or null) and generateError (why the last generation failed). Periods before tracking began are left out unless they have a report.",
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
  // Whether the caller is an agent comes with the request: the tools that only the orchestrator may call check it.
  await buildServer(actor, isAgent(request)).connect(transport)
  return transport.handleRequest(request)
}
