import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

import { COMMENT_PARENTS, COMPLEXITIES, FEED_TABS, STALL_MINUTES } from '#/lib/constants'
import type { RunConfigInput } from '#/lib/runs'
import { listActors, noteActor } from './actors'
import * as agentCards from './agentCards'
import { asSubIdentity, type Caller, callerInfo } from './auth'
import { previewBranch } from './branchPreview'
import { linkFor } from './previewProxy'
import { cleanupReport } from './cleanup'
import { AgentDeleteItems, deleteLeftovers } from './cleanupActions'
import { dailyReport, today } from './daily'
import * as features from './features'
import { findProject } from './findProject'
import { galleryShape, listGallery } from './gallery'
import { HttpError } from './http'
import { setInstructions } from './instructionsHistory'
import { getLiveWork } from './liveWork'
import * as needs from './needs'
import { isActive, managedPreview, restartPreview, startPreview, stopPreview } from './managedPreview'
import * as runConfig from './runConfig'
import { removeRunConfig } from './runs'
import * as ticketRuns from './ticketRuns'
import * as prs from './prs'
import * as projects from './projects'
import * as reports from './reports'
import * as reviews from './reviews'
import { getSummary } from './summary'
import * as uploads from './uploads'
import * as work from './workTimeline'

/**
 * The same board, as MCP tools. Stateless streamable HTTP: one server per request, closed over the
 * caller the board signed in (name, whether it is an agent, its role and parent), so every write is
 * attributed to the agent's name and the tools that only an agent, or only an orchestrator, may call can
 * refuse the others. A subagent that shares its orchestrator's connection says who it is with the
 * `agentName` argument every tool takes (`<the orchestrator's name>/<its own>`), read before the server
 * is built (agentNameOf): the call is then that sub-identity, a worker.
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
/** What a kind given as a status means: said once, in the instructions and on every status field. */
const KIND_RULE =
  "a kind means the project's stage of that kind: for open (and todo) the start stage, the last open stage; for active (and in_progress) the stage work starts in, the project's workStage, else the first active stage; for any other kind the first stage of that kind"

const INSTRUCTIONS = `The board is where the human and every agent coordinate work. You read work from it and report back to it. Git and GitHub are read-only through the board for you, but for closed tickets' landed local branches, which cleanup_delete deletes (worktrees and origin's branches are the human's, from its Cleanup page): never push, merge, approve or comment on GitHub on its behalf.

Work only in the project of the repo you are in, and never read or write another project's tickets, PRs, reviews or daily log. If a board skill or the repo's own instructions name your projectId, use it directly. Only otherwise, call find_project with your checkout's origin (git remote get-url origin), folder name and path (git rev-parse --show-toplevel): it answers with only the project and repo that match, never the list (do not call list_projects to find yours); if it finds none, do not use the board for this repo.

The rhythm:
1. get_project before touching it; its instructions override your defaults. Its stages are the board's columns, in order, each with a key, a name and a kind (open, active, blocked, review, done, cancelled). A ticket's status is a stage key; wherever status is asked for you can also give a stage's name or a kind (${KIND_RULE}). Below, todo, in_progress, blocked, review, done and cancelled mean the stage of that kind.
2. Starting a session, get_summary with your projectId is the picture in one read: what waits on the human, what is in progress and since when, what got done today, what is next, and what carries over from before today. Pick up work from list_tickets (status todo, assignee "" or your name from whoami); read it with get_ticket; then claim_ticket with the branch. Tickets are shared: you may take over one another agent holds (the board logs it), so prefer unassigned ones and take over only what is clearly stalled or handed to you. A ticket with reserved: true belongs to one of the project's agents (see below). Start of a session: before anything else on a ticket you pick up or come back to, read its summary (summary in get_ticket, the one state post) and latest posts: where the last session left off, the next steps and how to resume.
3. A new ticket starts with its project's default phases as its top-level tasks (get_project's defaultPhases; built in: Implementation, then the hand-off's Pushed, PR, CI, Preview, Summary, Merged). Tasks go two levels and no more: the concrete steps of the work go under Implementation as its subtasks (add_tasks with parentTaskId = its id). set_task_done as you finish each step: Implementation and its steps are the ones you tick. The board ticks the phases Pushed, PR, CI, Preview, Summary and Merged itself, from git, GitHub, the previews and the ticket's posts, and unticks one when its fact stops holding: Pushed while the branch is on origin with every local commit (a new commit not pushed unticks it), PR while a PR for the ticket is open or merged, CI while the PR's checks are green on its head or a PR comment whose first line is "CI run locally: green on <sha>" names its head commit (a new push unticks it until it is green again), Preview while one of the ticket's workspaces runs a preview or its link answers, Summary while an agent wrote or updated the summary (set_ticket_summary) after the branch's last commit (a new commit unticks it until the summary is rewritten; a ticket that never had a summary goes by an agent's progress post since then), Merged once the PR or the branch is merged. Nobody ticks those by hand: set_task_done and update_task done on them are refused (get_ticket marks them auto: true). When a phase does not fit, remove_task drops it (its steps go with it), update_task rewords it, and add_tasks adds one (at the end). A lane starts without phases, since its parent carries the hand-off (defaultPhases: true on create_ticket seeds it anyway), and defaultPhases: false opts a ticket out. A ticket with no tasks (an older one, a lane, one opted out) gets its phases the same way: add_tasks with the names from defaultPhases, then its steps under the first. The progress counts tasks and subtasks alike, and the open ones are what update_ticket to review answers with (open). When a step needs the human (a credential, a manual action, a call only they can make), tag that task or subtask blocked: update_task with blocked: true and blockedReason saying what the human must do. It shows on the task, on the ticket's card and in the human's Needs you (get_summary), still counts as open, and does not move the ticket: keep working on the rest. Ticking it done clears the tag; update_task with blocked: false clears it once resolved.
4. Split parallel work into lanes: when a ticket needs several pieces worked at once (subagents, worktrees, other agents), create_ticket with parentId = the ticket for each piece, with its own branch and assignee. A lane is worked like any ticket (tasks, updates, review) and can have lanes of its own. Tag each lane (tags) so the human can filter them: severity, area or kind, the same words across sibling lanes, not in the title. Tag every ticket too with the module it touches, a short name (Auth, Board, MCP): check get_project's tagSuggestions and usedTags (or the tags list_tickets returns) first and reuse an existing tag in its casing rather than a new spelling; set_tag_suggestions replaces the project's suggestions (when the human asks, or to add a module its tickets keep touching). add_workspace registers where code runs (a worktree, a sub-branch, a sandbox): register every worktree you open, since that list is what gets cleaned up later; remove_workspace when it is gone.
5. post_update after each meaningful step: short markdown, what changed and what is next, with screenshots or logs as absolute file paths in files. A ticket's feed of posts has two tabs, and the board puts each post in one (its tab): Agents is your working record (progress posts, which post_update makes and lane summaries and the Daily view pick out; anything posted with as, such as the spec, builder and review phases); Main is the human's and stays short and to the point (their posts with your replies under them, decision cards, your questions to them: comment on the ticket, or post_update with progress: false; and the summary on top). tab on post_update, comment and ask_decision overrides the default, edit_post with tab moves a post; a lane's posts show in its parent's tabs the same way. Every post can have replies (comment on the post's id with parentType update). edit_post and delete_post change what you posted. A PR of the queue that no feature ticket names has a ticket of its own: list_prs names it as ticket. Reviews, findings and progress on that PR are posts there, not on a daily ticket. The board moves that ticket as the PR's status changes, and its questions and threads show in the human's Needs you as PR rows. The summary (set_ticket_summary) is the one post on top of Main: what the change does, where it stands, each review round's verdict in one line, the PR, the preview and what to try there, and the proofs as files. Rewrite it to the current state instead of posting a new hand-off: each write is a new version (change: what changed, one line), the board keeps every earlier one (get_ticket_summary), and each write reaches the human like a new post. A new version replaces the previous one in wording, never in facts: carry forward every section and fact that still holds (what the change does, where it stands, each review round's verdict, the PR, the preview and what to try there, how it was tested); keep the latest screenshots and recordings in files, and older proofs while they still show the current state, never dropping the proofs for a section that still stands. Add what changed this time (change, one line) instead of deleting the rest; if a fact no longer holds, say what replaced it. When the change can be tried (a page, an API), have a preview the human can open before anything is merged. When the ticket's repo has runs (configured per repo, by the human in the project's settings or by you with add_run, update_run and delete_run: previews, which answer on a port and get a link, and jobs, background workers with no link; a checkout of the board has its Preview), the board runs them for you: register your worktree (add_workspace with its path and branch, and repoId for a repo other than the ticket's primary; it must sit next to the repo's main checkout), then list_runs shows every run of every repo of the ticket and start_run starts one by name (or all of them with all: true). The board installs when the lockfile changed, builds, copies the live data when the run asks for it and starts it (a preview on a free port from 47101 with sign-in off, its link set on the workspace once it answers); list_runs and get_ticket follow it (building, starting, running, failed with the last log lines, or stopped). What runs is the run's stored commands, env and port: you name a run to start_run. A repo that lacks the run you need: add it (add_run with its name, type and install, build and start commands), or fix one with update_run and drop one with delete_run; they act on every run of the repo, the human's included, and each change is in the project's activity under your name. Do not run pnpm dev in your session for it: that dies with your session. start_run with restart: true rebuilds it after you push more work; stop_run stops it, and the board stops it by itself when the PR is merged (in that repo), the ticket is done, cancelled or archived, or the workspace is removed. start_preview and stop_preview still work on a workspace's first preview run. A repo with no runs, when you do not add one: start your branch from your worktree on a free port with a copy of the data rather than the real one (the project's instructions say how) and register its link on the workspace (set_preview, or previewUrl on add_workspace). Either way post the link with what to try, say that what they post there stays in the copy, keep it running while the ticket is in review, and stop it once it is merged or dropped (clear a link you set with set_preview "").
6. Ask and answer with comment. When the human posts on a ticket you work, answer under their post (comment with replyTo, or parentType update), never with a new top-level post: first a reply with your plan, then, once done, a reply with the result and its proofs (files, the preview link); a reply brings their post back to the top of Main. When you cannot go on without the human, comment your question on the ticket and update_ticket to blocked; back to in_progress once answered. That is for when nothing else can go on: when only one step waits on the human, tag that task blocked instead (step 3) and keep working. When it is a choice between clear options (an approach, a trade-off, a scope call), ask_decision instead: the human answers with one click, and the ticket blocks and unblocks by itself. When the human answers a card in the chat rather than on the board, record their answer with answer_decision (the option they picked, and their words verbatim): ask them in the chat first, with AskUserQuestion in Claude Code or the client's equivalent, offering the card's options; if no card exists yet, ask_decision first, since it blocks the ticket. Only the session that talks to the human does this: never a delegated subagent, never with as, never in a run with no human to ask. If their answer matches none of the options, do not relay it: comment it on the card and ask again, or leave the card to the board. When you resume, and between steps, list_my_threads shows every ticket feed or reply thread where someone spoke after you; get_ticket shows each post's reply count and last author. Files on posts and replies come with a local path you can open. While you have tickets in progress or review, watch for feedback without being told: every few minutes call check_inbox with the cursor from your last call (in Claude Code, under /loop); for each new thread read it, fix what it asks the usual way (checks, commit, push, preview), reply in the thread with what changed, and keep the new cursor.
7. Hand off: before update_ticket to review, every item, in order (the board ticks Pushed, PR, CI, Preview, Summary and Merged as their facts hold; Implementation and its steps are ticked by hand): (1) worktree registered (add_workspace), Implementation and its steps ticked; (2) checks green: typecheck, lint, unit tests, and the e2e suite when the repo has one; (3) branch pushed: get_ticket's push.state is pushed (green on the board), not ahead or local-only (red); (4) needs declared for any unmerged branch it builds on (below); (5) PR open and assigned to the human (gh pr create --assignee <their login>, or --assignee @me when you push with their account: GitHub never lets a PR's author be its requested reviewer, and the PR queue lists PRs assigned to them), and update_ticket with its prNumber (a PR's own ticket from the queue, if it has one, is then cancelled: this ticket takes the PR over); while GitHub's checks do not run, comment on the PR "CI run locally: green on <sha>" with the head commit your checks passed on (gh pr comment), which ticks CI, and again after each push; (6) preview running: start_run (or start_preview) and wait for running (a repo with no runs configured: start one the project's way and set_preview); when the change cannot be tried (docs only, a script), say why in the summary; (7) the summary up to date (set_ticket_summary, never a new hand-off post): the PR link, the preview link and what to try there, how it was tested, the e2e result, each review round's verdict, and the latest screenshots for a UI change as files, carrying forward every section and fact that still holds and the proofs for a section that still stands (a new version replaces the previous one in wording, never in facts: add what changed this time, say what replaced a fact that no longer holds; never delete the rest); it is the ticket's one state card, so it is also where a session left off. update_ticket to review answers with open: [{taskId, ticketId, text, auto}], every task and subtask still open, the ticket's and its lanes' that are not cancelled, in tree order (Merged aside: merging is the human's); auto: true on a phase the board ticks from its fact (Pushed, PR, CI, Preview, Summary), which you settle by making the fact hold (push, open the PR, get CI green, start the preview, rewrite the summary), never by a tick. Fix each one; open: [] means nothing is left. Briefing a subagent, put the same list in its brief. When your branch is built on another ticket's open branch, or you merged one in (to get past a conflict), declare it with update_ticket needs: [its id] instead of only writing "builds on" in the PR: the PR queue then says which PR to merge first, and the ticket cannot be done until that branch is merged into its base. needs is the enforced rule; the order of the review column is the human's merge plan, top merges first: update_ticket position (1 is the top) sets where a ticket sits, e.g. to say your PR should merge before another, and the board flags a card placed above a ticket it needs. get_ticket_git includes lists the tickets whose unmerged work your branch holds. done is the human's call. cancelled is for work that was dropped: say why in a comment. A ticket with lanes goes to review once its lanes are in review, done or cancelled. The human's verdict on a lane or ticket is approvedAt/approvedBy (approved) or disapprovedAt/disapprovedBy (disapproved, which also cancels it; approving a ticket tagged PR, a PR review, also moves it to done); you can read it, never set it. Treat an approved lane as settled and a disapproved one as dropped: ask in its thread before touching either. Archiving is the human's too: archivedAt set means the ticket (lanes included) is finished and off the board, and list_tickets leaves it out unless you pass archived. You may ask for it: request_archive posts the human one Archive / Keep card for done or cancelled top-level tickets, and only their Archive answer archives them; never archive any other way. Repos are the human's too (each project's Repositories page): when the work needs a repo the project lacks (a new repository you are building), add_repo asks for it with an Add / Don't add card on your ticket, and only their Add adds it; once added, set_ticket_repo moves the ticket onto it (that one is yours: any repo of the ticket's own project, at once).
8. Clean up after yourself: once a lane's work is in its parent's branch (or a ticket's in its base), and before moving it to done, delete its local branch once no worktree holds it, and post_update the deleted branch names with their commit hashes (e.g. lane/47 @ 9ec12e8b) so any of them can be restored. Leave its worktrees, and the workspaces registered at them, to the human, who removes them from the Cleanup page. get_ticket_git says whether each branch's work arrived (reach); cleanup_report lists every leftover in the project, and cleanup_delete deletes closed tickets' landed local branches, the board checking each one again as for the human and answering how to restore it: post those branch @ sha lines on the ticket too. Never delete a branch whose reach is unique without the human's go-ahead, nor one cleanup_report marks protected, and never delete branches on origin nor remove worktrees: list them for the human, who does that from the Cleanup page.
9. Record your work on the ticket's work timeline as you go (the Roadmap and the ticket page draw it; the human sees from it who worked when, who waited on what, and what stalled): heartbeat every few minutes while you work a ticket (in Claude Code under /loop, or between steps), since a ticket in an active stage with no event for longer than its project's stallMinutes (30 by default) reads as stalled in the human's Needs you; start_span when you start a phase (spec, build, review with its round, verify, pr, preview, merge) and end_span when it is done; handoff when you brief a sub-agent (to: its name, the full agentName it passes such as orch/builder-1, and record its own spans with agent: its name) and when it hands back; start_wait with the reason (lock, builder, mcp, human, other) when you cannot go on, with on: the agent you handed the work to when you wait on one you briefed, and end_wait as soon as you can. Each takes projectId and ticketId, and only a ticket of that project. get_ticket's work lists your open spans and waits to close.
10. End of session: for every ticket you leave in progress, blocked or review, its summary up to date (set_ticket_summary): where it stands, what is next, and how to resume (branch, worktree, commands, preview, gotchas), concretely enough that another agent can continue without asking. Then the project's report, if it keeps one (get_report_settings: cadence daily or weekly): one report per period, due at the end of the project's shift. list_reports shows which periods are done, missing, upcoming or off; write the current or a missing one as the prompt says, in the shape of the template (its headings, in order), from daily_report for the days it covers, and post_report it (files as absolute paths). reportDue on get_summary and check_inbox says when the human expects it (due soon, or missing): write it then, with the human's go-ahead.

Notifications: the notification center is not a place to report your work. Open a tracked card (start_tracked_request, tracked_request_progress, finish_tracked_request) only when the human explicitly asked to see the progress of, or to be told about the completion of, one named thing ("show me progress", "let me know when", "notify me when", "tell me once it is ready"): one request, one card, and never for starting a ticket, running tests in normal work, a long build nobody asked about or a finished ticket. Use post_notice only for something very important the human must know and would otherwise miss (data lost or at risk, production or the host broken, a secret exposed, the wrong thing done and needing undo, a deadline missed), never for routine work: when in doubt, post on the ticket.

Who is who: every caller has a name, a role and maybe a parent (whoami). The human is the human. An agent token made by Connect is an orchestrator by default; the human can make it a worker. A subagent you delegate to that shares your connection is your worker: brief it to pass agentName: "<your whoami name>/<its name>" (e.g. orch/builder-1) on every board call, so its posts, claims and comments show under its own name with you as its parent; a worker session configured on its own sends the header X-Agent-Name: <token name>/<its name> instead (or gets its own worker token, the hard boundary). A sub-identity is always a worker. Only the human and an orchestrator change a project's instructions (set_project_instructions), create a project with instructions or move a repo to another project; a worker asks its orchestrator, and every change shows in the human's Needs you until they review it.

The project's agents: get_project lists them (agents: name, instructions, delegation notes, picture). They are personas the human defined on the project's Team page (the roles agents work as in this project), not connected tools; you work for them. A ticket assigned to one (reserved: true; get_ticket's agent has its instructions) is that agent's alone: claim_ticket with as: <its name>, brief a subagent with its instructions (and the ticket's), and post that work with post_update and comment using as: <its name>, so it shows under the agent's name, via you. Never take a reserved ticket as yourself, reassign it, or work it without the agent's instructions; only the human reassigns it. A thread can wait on an agent too: when someone @mentions it, or replies on its ticket or post, list_my_threads returns that thread with as: <its name>; answer it with comment as: <its name>, in that agent's voice and instructions. Orchestrating: each agent's delegation notes say when to call it, what to give it, what it returns and what comes next. With them you can work a ticket as its orchestrator instead of doing the work yourself: run each step as a subagent briefed with that agent's instructions, the project's instructions and the ticket; post what it returns on the ticket as that agent (as: <its name>, progress: true: it goes to the Agents tab), and keep the ticket's summary current with what the human needs from it; go where its notes say next. The default set (spec, builder, runner, and the review phases env, verify, hunt, refute, merge) is the cycle spec → build → review that tries to break it → (a fix pass by the builder on the confirmed findings, each with the project's checks and a new review, for as many review rounds as the ticket's complexity allows: none for low, one for mid, three for high, up to ten for max; round 1 is the first build and its review, so a mid ticket stops after its review, and a review that does not survive after the last round goes to a human decision; a high ticket gets two fix passes, a max ticket nine, for work built from scratch, a feature being at most high however difficult; a low ticket has no review, and its checks return the build at most twice; after the second return, when the checks still fail or a criterion still has no evidence, the human decides (keep going or drop), and the build goes to hand-off only with evidence for every criterion) → hand off; the /review-queue skill runs it (/feature-review is its review). The agents' thinking effort follows the complexity too: low for a low ticket, medium for mid and high, high for max; the orchestrator passes it as the Agent tool's effort on every agent it starts for the ticket (the ticket agent, the spec agent, the builder and the review's phase agents). Ask the human with ask_decision instead of guessing, never run two builders on one branch, never delegate to an agent without delegation notes, and a persona never answers a decision. The board skill has the full routine.

When a project has several repos, pass repoId to create_ticket and post_review_result. A ticket can span several of them: repos on get_ticket lists each with its own branch, base and PR, the first being the primary (the ticket's own repoId, branch, baseBranch, prNumber); repos on create_ticket and update_ticket sets the list, claim_ticket's repos sets each one's branch (its branch is the primary's), add_workspace takes repoId, and get_ticket_git reports every repo. Plain words, titles under 80 characters; the human reads dozens of these a day.

Keep the board out of the repo. The board and any other personal tracking tool are private to the human: never mention them, their tool names, their URLs (localhost:47100) or a board ticket, task or project ("#12", "ticket 12", "per the board") in code comments, docs, READMEs, changelogs, config, commit messages, branch names, PR titles or descriptions, or issues, and never link or screenshot the board there. Describe the change and its reason in the repo's own terms; if the PR needs something from the ticket, restate it instead of pointing at it. Board updates and comments may talk about the repo, branches and PRs freely.`

const STATUS = `a stage key from get_project, a stage name, or a kind (open, active, blocked, review, done, cancelled; todo and in_progress also work): ${KIND_RULE}`
const COMPLEXITY =
  "how much review the ticket gets: low none (the builder verifies itself), mid one review round, high three, max up to ten for work built from scratch (a whole site or app, a new product or standalone service; a feature in an existing codebase is never max, however difficult). Mid when left out; a lane without one copies its parent's."
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
  "Each item is a task, or {text, subtasks} for a task with the subtasks that go under it. Two levels and no more: the top level is the ticket's phases (a new ticket starts with its project's default phases: Implementation, then the hand-off's Pushed, PR, CI, Preview, Summary, Merged; the board ticks Pushed, PR, CI, Preview, Summary and Merged itself), and the concrete steps go under a phase as its subtasks, the work's under Implementation."
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
const REPOS = z.array(
  z.object({
    repoId: z.number().int(),
    branch: z.string().optional(),
    baseBranch: z.string().optional(),
    prNumber: z.number().int().nullable().optional(),
  }),
)
const REPOS_TEXT =
  "The repos the ticket's work spans, each a repo of the project with its own branch, baseBranch and prNumber; at least one, none twice. The first is the primary: the ticket's repoId, branch, baseBranch and prNumber are its."
const TAGS = `Short labels the human filters tickets and lanes by: the module the ticket touches (a short name such as Auth, Board, MCP), a kind (Bug, UI, Implementation, Report…) or a severity (Critical, High, Medium, Low, Cosmetic). One or two words each; before tagging, read get_project's tagSuggestions and usedTags (or the tags list_tickets returns) and reuse a tag already there in its exact casing rather than a new spelling; keep them out of the title (no "[High] …").`

const AGENT_NAME = z
  .string()
  .optional()
  .describe(
    'who makes this call, when you are a subagent (a worker) on your orchestrator\'s connection: "<the orchestrator\'s whoami name>/<your name>", e.g. orch/builder-1 (each name a letter or digit, then letters, digits, ".", "_" or "-"; up to 4 names, 80 characters). Your posts, claims and comments then carry that name, and you are a worker whatever the token is. Leave it out when you are the orchestrator itself or work on your own token; with an X-Agent-Name header it must name the same.',
  )

function buildServer(caller: Caller, refused: HttpError | null, request: Request) {
  const actor = caller.name
  const agent = caller.kind === 'agent'
  const server = new McpServer({ name: 'agent-board', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => unknown,
  ) => {
    const cb = (async ({ agentName: _agentName, ...args }: { agentName?: string }) => {
      try {
        // The request's agentName was refused before the server was built: no tool runs under it.
        if (refused) throw refused
        // Every file handed to an agent is on this machine to open (with STORAGE=s3, fetched if needed).
        return text(await uploads.ensureLocalFiles(await run(args as z.infer<z.ZodObject<S>>)))
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(`mcp ${name} failed:`, err)
        return fail(err)
      }
    }) as unknown as ToolCallback<S & { agentName: typeof AGENT_NAME }>
    server.registerTool(name, { description, inputSchema: { ...shape, agentName: AGENT_NAME } }, cb)
  }

  tool(
    'whoami',
    "Who the board knows you as: name (your agent token's name, or your sub-identity <token name>/<name> when you pass agentName or send X-Agent-Name), role (orchestrator: also changes the projects' instructions; worker: every other agent, a sub-identity always; human for the human), parent (the name a sub-identity works under, '' otherwise) and token (the name of the credential you signed in with). actor is name, for older callers. An orchestrator hands its name to its subagents: each passes agentName \"<name>/<its own>\" on every call.",
    {},
    () => ({ actor, name: actor, role: caller.role, parent: caller.parent, token: caller.token }),
  )

  // projects
  tool(
    'list_projects',
    'All projects on the board, each with its repos (id, name, checkout path, GitHub slug, base branch).',
    {},
    () => projects.listProjects(),
  )
  tool(
    'find_project',
    "The project and repo of the checkout you are in, from the board as it is now: give githubRepo (your origin URL as git remote get-url origin prints it, or owner/name), folder (the checkout's folder name) and path (git rev-parse --show-toplevel), at least one. Matched by the GitHub slug (any casing) first, then the path (slashes either way, a trailing one, and C:\\… the same as /mnt/c/…; a path inside a repo's checkout, such as a worktree nested in it, counts as that repo), then the folder name, then a folder beside a checkout named like it (<folder>-<branch>); a worktree is found by its slug, and an ssh origin on another host (an ssh-config alias of GitHub) is read for its owner/name. Returns only what matched, never other projects: match 'one' (projectId, projectName, repoId, repo), 'repos' (several repos of one project: ask which, or take it from the ticket), 'ambiguous' (candidates in several projects: ask the human, do not pick) or 'none' (no board project for this repo: stop using the board for it, do not guess or create one); by says what matched (githubRepo, path, inside, folder or beside), message what to do, and weak: true marks a hit that may be another repository (a slug read from a host that is not github.com, a repo whose GitHub repo is another than yours, a path that only holds a repo's checkout, a folder beside a checkout): confirm with the human.",
    {
      githubRepo: z
        .string()
        .max(2_000)
        .optional()
        .describe('your origin URL (git remote get-url origin), or owner/name'),
      folder: z.string().max(4_000).optional().describe("the checkout's folder name"),
      path: z.string().max(4_000).optional().describe("the checkout's path (git rev-parse --show-toplevel)"),
    },
    (where) => findProject(where),
  )
  tool(
    'get_project',
    "One project with its repos, its stages (the board's columns in order: key, name, kind), its agents (personas with a name, instructions, delegation notes saying when the orchestrator should call them, and a picture; tickets can be reserved for them), defaultPhases (the top-level phases every new ticket starts with, in order; built in: Implementation, Pushed, PR, CI, Preview, Summary, Merged; [] when the project seeds none; only the human changes the list; a top-level task named Pushed, PR, CI, Preview, Summary or Merged is ticked by the board, never by hand), tagSuggestions (the tags the human offers for tickets; built in: Bug, UI, Implementation, Report), usedTags (the tags its tickets carry, most used first, each in the casing to reuse), stallMinutes (how many minutes an active ticket may go without a work-timeline event before it reads as stalled; only the human changes it), workStage (the key of the active stage claim_ticket and a status of in_progress or active go to; null for the first active stage; only the human changes it), hostTools (the board's last check of the tools on its machine: checkedAt, and for each of git, gh, claude, node and pnpm its name, found, version, signedIn for gh, ok and optional; one not ok also says what it breaks, the problem and the fix: a feature that needs it fails until the human fixes it; optional is true for claude, which only the board's own report generation needs, never ticket or project agents; null before the first check ends) and the instructions agents must follow when working on it (only the human and an orchestrator change them: set_project_instructions; a worker asks its orchestrator). Read this before touching a project.",
    { projectId: z.number().int() },
    ({ projectId }) => projects.getProjectFull(projectId),
  )
  tool(
    'set_project_instructions',
    "Replace the project's instructions (get_project's instructions: what every agent follows on it) with instructions, at once. Only an orchestrator (or the human) may: a worker, any sub-identity included, is refused (ask your orchestrator). Change them when the human asked for it or the project's way of working changed, never to get around a rule. Every change is kept with the text before it, your name and role, shows in the project's activity, and waits in the human's Needs you as \"changed by <you>\" until they mark it reviewed or revert it. Returns {instructions, change}: change is null when the text was already that.",
    {
      projectId: z.number().int(),
      instructions: z.string().max(50_000).describe('the whole new text, markdown'),
    },
    ({ projectId, instructions }) => setInstructions(projectId, instructions, caller),
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
    "Where a project stands, in one read (every project, one block each, without projectId): reportDue (the project's report while the board is reminding about it: { projectId, project, cadence, period, label, dueAt, alertAt, state due or missing, minutesLeft, negative once overdue }, null otherwise), needsYou (open decisions, humanWaits: each open wait on the human on an active ticket ({waitId, ticketId, ticketTitle, status, assignee, parent, agent, note, since}; none when the ticket already has an open decision card), PRs waiting on the human's review, threads waiting on the human, tickets in a review stage, stalled: each ticket or lane in an active stage nobody recorded a work-timeline event on for longer than the project's stallMinutes, oldest signal first ({ticketId, title, status, assignee, parent, lastSignalAt, lastAgent, lastBy, lastFrom}; lastAgent is the name the latest event claims, or the assignee when no agent's event names one, lastBy who recorded it as signed in, '' when unknown, lastFrom 'event' or 'assignee': where lastAgent came from; how long it has been silent is generatedAt minus lastSignalAt), instructionChanges (an orchestrator's changes of the project's instructions the human has not reviewed or reverted yet: changeId, projectId, changedBy, role, createdAt, excerpt of the new text, revertable), and blockedTasks: each task or subtask tagged blocked that is the next step to work in its ticket or lane (the first open task in tree order with no open subtask), on a ticket still being worked, not done, cancelled or archived nor under one that is: taskId, text, reason, parentTask (the text of the task it is a step of, null for a top-level one), ticketId, ticketTitle, status, parent (the ticket it is a lane of); a blocked step further down that order is left out here but still counted in its ticket's blockedTasks (blockedNext says whether a next step is blocked); total counts the listed ones), inProgress (tickets in active or blocked stages: assignee, task progress, blockedTasks, lanes, last progress post, preview, since when, stale when no progress post in 24 hours, stalled when silent on the work timeline past the project's stallMinutes, activity: the open spans ({phase, agent, since}), the open waits ({reason, agent, on, since}: on is the agent a delegated wait hands the work to, null when none), lastHeard and lastClosedSpan (the span that ended last, {phase, agent, start, end}, null when none)), doneToday (tickets that reached a done stage today, PRs that left the queue today, today's activity count), next (the head of the first open stage that is not a backlog, with how many are blocked and in the backlog) and carryingOver (tickets in progress since before today, each with since, days, lastPost and stale). A PR's own ticket is in none of these lists: its decisions and threads waiting on the human are in needsYou as PR rows (prTicket true). Today is the board's local day. Read it when starting a session.",
    { projectId: z.number().int().optional() },
    ({ projectId }) => getSummary(projectId, { refreshPrs: true }),
  )
  tool(
    'get_live_work',
    "What is happening on a project right now, in one read, for a session that is starting: liveNow (the tickets and lanes with an open span or wait, or an agent event such as a heartbeat inside the window: each with ticketId, title, status, stage, parent, agents (names), phase and round of the open span, lastHeardAt and lastHeardBy, silentMinutes, waitingFor ({reason, note, agent, on, since} or null) and stalled), recentlyActive (the rest that were heard from, nothing running now, newest first, at most 10: the same fields, plus lastSignalAt, state (its one-line summary or newest progress post), and the same agents, phase and round of any open span, so a stalled ticket is here rather than under liveNow and still names who was on it), waitingOnHuman (open decision cards, next-step tasks tagged blocked, and tickets in a blocked stage: kind decision, blocked-task or blocked-ticket, one line each, postId or taskId, a ticket listed once), inReview (tickets in a review stage with a PR: prNumber, prUrl, reviewStage, the latest recorded verdict, and the preview link when one is registered), recentPosts (the last 10 posts across the project, newest first: author, ticket, time, first line), and totals. now is the clock every duration was measured against, windowMinutes the window used (the project's stallMinutes unless windowMinutes is given), stallMinutes the project's threshold. Scoped to one project, another project's tickets, posts and PRs never appear; an unknown project is refused. Silence is not idleness: lastHeardAt and silentMinutes say how long a ticket has been quiet, and a quiet ticket is not proof that nobody is working (agents keep the timeline by their own spans and heartbeats, so an agent that records nothing stays invisible). Do not take or duplicate a live ticket; pick up what nobody holds.",
    {
      projectId: z.number().int(),
      windowMinutes: z
        .number()
        .int()
        .min(STALL_MINUTES.min)
        .max(STALL_MINUTES.max)
        .optional()
        .describe(
          "how many minutes back count as live now; the project's stallMinutes by default. The answer names the window it used",
        ),
    },
    ({ projectId, windowMinutes }) => getLiveWork(projectId, { windowMinutes }),
  )

  // notifications: tracked requests and important notices an agent opens for the human
  tool(
    'list_notifications',
    "The project's agent cards: tracked requests (kind tracked: the human's request, progress, state and result) and important notices (kind notice: body and the reason it cannot wait), newest first. The human sees every card of the project, an agent only the ones it opened and its sub-identities' (<its name>/…). It does not list the board's own jobs; the notification center shows both.",
    { projectId: z.number().int() },
    ({ projectId }) => agentCards.listCards(projectId, { agent: caller.kind === 'human' ? null : actor }),
  )
  tool(
    'start_tracked_request',
    `Open the one notification card for a thing the human asked to watch. ${agentCards.TRACKED_ONLY} request is the human's own words, quoted or closely paraphrased: a call without it is refused. total makes a determinate bar ("3 of 12"); without one the card sits running (indeterminate) until you finish it. href is where the result will live: a board path such as /projects/12 or an absolute http(s) URL.`,
    {
      projectId: z.number().int(),
      title: z.string().max(200).optional().describe('what the human asked to be told about, in their terms'),
      request: z
        .string()
        .max(500)
        .optional()
        .describe(
          "the human's request itself, quoted or closely paraphrased: what they asked to be shown or told. Required: a start without it is refused",
        ),
      total: z
        .number()
        .int()
        .min(0)
        .max(1_000_000)
        .optional()
        .describe('how many countable steps the work has, when the human asked to see progress'),
      href: z
        .string()
        .max(2_000)
        .optional()
        .describe('where the result will live: a board path (/projects/12) or an absolute http(s) URL'),
    },
    ({ projectId, ...input }) => agentCards.startTracked({ name: actor, agent }, projectId, input),
  )
  tool(
    'tracked_request_progress',
    `Move a running tracked card. ${agentCards.TRACKED_ONLY} done is clamped into the card's total, step is the item being worked on now (left out keeps the last one). A card that already ended, another agent's card or a notice is refused.`,
    {
      projectId: z.number().int(),
      cardId: z.number().int(),
      done: z.number().int().optional().describe("how many steps are done; clamped into the card's total"),
      step: z.string().max(500).nullable().optional().describe('the item being worked on now'),
    },
    ({ projectId, cardId, ...update }) =>
      agentCards.progressTracked({ name: actor, agent }, projectId, cardId, update),
  )
  tool(
    'finish_tracked_request',
    `End a running tracked card. ${agentCards.TRACKED_ONLY} state succeeded needs the one-line result, state failed needs the reason; the card flips to done (or failed) and the notification center raises its toast when the panel is closed. A card that already ended, another agent's card or a notice is refused.`,
    {
      projectId: z.number().int(),
      cardId: z.number().int(),
      state: z.enum(['succeeded', 'failed']),
      result: z.string().max(500).optional().describe('the one-line result, required when it succeeded'),
      reason: z.string().max(500).optional().describe('why it failed, required when it failed'),
    },
    ({ projectId, cardId, ...outcome }) =>
      agentCards.finishTracked({ name: actor, agent }, projectId, cardId, outcome),
  )
  tool(
    'post_notice',
    `Post one important notice for the human. ${agentCards.NOTICE_ONLY} title, body (what happened and what the human should do) and reason (why it cannot wait) are required: a notice without its reason is refused. href is where to look: a board path or an absolute http(s) URL. It is delivered once and has no progress to update.`,
    {
      projectId: z.number().int(),
      title: z.string().max(200).optional(),
      body: z
        .string()
        .max(2_000)
        .optional()
        .describe('what happened and what the human should do, a sentence or two'),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe('why it cannot wait: required, a notice without it is refused'),
      href: z
        .string()
        .max(2_000)
        .optional()
        .describe('where to look: a board path (/projects/12) or an absolute http(s) URL'),
    },
    ({ projectId, ...input }) => agentCards.postNotice({ name: actor, agent }, projectId, input),
  )
  tool(
    'dismiss_notification',
    'Dismiss one tracked card or notice for everybody: the human only, the read receipt that removes it from the panel and the badge. An agent is refused; one it opened by mistake finishes it as failed with the reason instead. Returns { ok: true }; an unknown card, one of another project or one already dismissed is a 404.',
    { projectId: z.number().int(), cardId: z.number().int() },
    ({ projectId, cardId }) => {
      agentCards.dismissCard({ name: actor, agent }, projectId, cardId)
      return { ok: true }
    },
  )

  // PR queue
  tool(
    'list_prs',
    "The human's PRs across all repos of the project: open, and merged in the last 14 days. waitingOn is me (someone else authored it: the human reviews it) or others (the human authored it on GitHub, agents' PRs pushed with their account included). status is where its reviews stand: for waitingOn me, by the human's own reviews (pending: not approved by them, or their comments were addressed by a push or a new review request; reviewed: they approved; on_hold: their comments or requested changes stand at the head); for others, by everyone else's (pending: approvals missing; reviewed: reviewDecision APPROVED, or every reviewer approved and no review is still requested; on_hold: someone's comments or requested changes stand at the head); done: merged. A board-side hold puts an open PR in on_hold. myReview is the human's standing verdict. requested is true while GitHub still asks the human to review it (its review-requested:@me search found it: the PR queue's Just me as reviewer switch shows those); the queue's To review and Waiting on others counters count their pending and on hold rows. Also the repo and the latest review verdict. Where it stands on GitHub as of the last refresh: merge (clean | conflicts | behind | blocked | checking; an open PR's is first checked in the repo's checkout against origin's base, so a base that moved shows at the next fetch, and mergeCheck {source local | github, at, base, outdated} says which and as of when), ci (passing | failing | pending | none) with checks[] {name, state pass | fail | pending | skipped, url}, reviewDecision and isDraft. ticket is the ticket its card opens: the feature ticket that names the PR (by its prNumber, or by its branch when it names no PR), else the PR's own ticket the board opened for it, or null; tickets lists the feature tickets only. mergeAfter lists the open PRs of tickets its tickets need: merge those first.",
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
    "Tickets of a project (all its repos; a PR's own ticket, which the board opens for a PR of the queue, is left out: list_prs names it as ticket) with status, assignee, reserved (assigned to one of the project's agents: only that agent works it), repoId, branch, parentId, complexity (low, mid, high or max: how much review it gets), tags, task progress (own and rolled up over lanes), blockedTasks (its open tasks and subtasks tagged blocked on the human, over the same lanes as the rolled-up progress) and blockedNext (true when the next step to work in the ticket, or in a lane of it, is blocked: when its card badge shows and Needs you lists that step), lane counts (total, approved, disapproved, byStage: per stage key), and the human's verdict: approvedAt/approvedBy or disapprovedAt/disapprovedBy (a disapproved ticket is moved to the cancelled stage), startedAt (when work on it last started), lastSignalAt (the latest of its work-timeline events of any kind, startedAt and createdAt) and stalled ({since, minutes, lastAgent, lastBy, lastFrom} when it is in an active stage, not waiting on the human, and silent for longer than the project's stallMinutes; null otherwise), activity ({spans: the open spans as {phase, agent, since}, waits: the open waits as {reason, agent, on, since}, on being the agent a delegated wait hands the work to, null when none; lastHeard: the latest agent event as {at, agent, by, kind, phase, reason, note}, heartbeats included, null when none; lastClosedSpan: the span that ended last as {phase, agent, start, end}, null when none}). status is a stage key (see get_project). needs lists the tickets it needs merged first, each with merged (see get_ticket). Cancelled lanes' tasks are left out of the rolled-up progress. Archived tickets (finished work the human took off the board, lanes with it; archivedAt/archivedBy) are left out unless archived says otherwise. Last updated first, except that the tickets of one stage (with the same parent) come in their board column's order: the ones placed there first, by rank (null: not placed; update_ticket position places one), then the rest last updated first. So status: [review] with parentId: null reads the merge queue top to bottom.",
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
    "A ticket in full: instructions and the files attached to them (attachments, each with a local path and, when the picture was drawn on before attaching, its annotations: the shapes drawn on it and their numbered notes, the notes saying what each mark means; see get_attachment; a running preview's workspace also carries managedPreview.proxyUrl, its link through the board's origin, see preview_link), complexity (low, mid, high or max: how much review it gets), agent (the project agent it is reserved for, with its instructions; null when shared), tasks (one flat list in tree order: each top-level task followed by its subtasks; parentId is null on a top-level task, else the task it is a subtask of; blocked: true when it waits on the human, blockedReason: what they must do, '' when none; auto: true on a phase the board ticks itself, Pushed, PR, CI, Preview, Summary or Merged at the top level, which nobody ticks by hand), blockedTasks (how many of its open tasks and subtasks are blocked, its lanes' included as in rollup), repos (the repos its work spans, in order, each {repoId, name, branch, baseBranch, prNumber, primary}: the first is the primary, whose values the ticket's own repoId, branch, baseBranch and prNumber always are), workspaces (each with repoId: the repo it is a worktree of, null for the primary; managedPreview: its first preview run as the board runs it from it, null when it never ran one (list_runs has every run); status building | starting | running | failed | stopped, step, port, url, reason, tail: the last log lines when it failed, logs: their paths), its parent chain, its lanes with their last progress post and verdict, the feed of posts (updates: newest first, each with tab: main or agents, the tab of the feed it shows in; progress true for a step of the work or false for discussion; summary true on a version of the summary; editedAt, attachments with a local path, and thread: its reply count, last author and time), summary (the one at the top of Main: body, change, at, by, via, attachments, postId, versions: how many were written, get_ticket_summary has them; fallback: true when none was written yet and the newest agent progress post stands in; null when there is neither), thread on the ticket (how many posts, who posted last), pr: the PR it was opened as (prNumber, or the open PR on its branch) with its latest review, and push: whether its branch is on origin (state pushed: origin has every commit, behind counts what origin has on top; ahead: ahead commits are only local; local-only: origin has no such branch; merged: origin has no such branch any more and it was merged into the ticket's base, into; remote-only: only origin has it; none: no branch, or it exists nowhere; checkedAt: when origin was last fetched, every few minutes), likewise on each workspace. A ticket goes to review only with its branch pushed. open, in a review stage (null otherwise): the tasks still open, as update_ticket answers it. approvedAt/approvedBy or disapprovedAt/disapprovedBy is the human's verdict (both null: no call yet; disapproved also means cancelled). archivedAt/archivedBy is set when the human archived it (or the ticket it is a lane of): finished, off the board. The summary is where the last session left off; read it before anything else when you pick the ticket up. needs: the tickets whose branches must be merged into its base before it can be done ({id, title, branch, prNumber, status, merged, into}); neededBy: the tickets that need this one. stalled and lastSignalAt as in list_tickets, and work: its work timeline in short (totals: workingMs, waitingMs, blockedOnHumanMs, disjoint: blocked on the human is the human waits and the time in a blocked stage, working the spans outside that, waiting the other waits outside every span and outside that; stalled; lastSignalAt; open: the spans and waits still open, each with its id, to close with end_span and end_wait; lastHeard: the latest agent event as activity's, null when none). A decision post (decision: its options) also carries decidedOption and decidedBy, and relayedBy and relayedText when the orchestrator relayed the human's answer from the chat (decidedBy is '' then; both relay fields are '' when the human answered on the board).",
    {
      ticketId: z.number().int(),
      laneUpdates: z.boolean().default(false).describe("include the lanes' posts in the feed"),
    },
    ({ ticketId, laneUpdates }) => needs.ticketView(ticketId, { laneUpdates }),
  )
  tool(
    'create_ticket',
    "Create a ticket (a feature or piece of work) with optional initial tasks. A top-level ticket starts with its project's default phases (get_project's defaultPhases: Implementation, Pushed, PR, CI, Preview, Summary, Merged unless the project changed them): tasks given as plain texts become the steps under the first phase, and {text, subtasks} items are phases of yours that go right after it. With parentId it is a lane of that ticket: a parallel piece of it with its own assignee, branch, tasks and updates, which starts without phases unless defaultPhases is true. defaultPhases false stores the tasks exactly as given. complexity sets how much review the ticket gets (low, mid, high or max: low none, mid one review round, high three, max up to ten for work built from scratch; mid by default, and a lane without one copies its parent's).",
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
      repos: REPOS.optional().describe(
        `${REPOS_TEXT} The first replaces repoId, branch, baseBranch and prNumber when those are left out.`,
      ),
    },
    ({ projectId, ...rest }) => needs.newTicket(projectId, rest, actor, { agent: true }),
  )
  tool(
    'update_ticket',
    "Change status, assignee, branch, tags, prNumber, title, instructions or complexity (the review level, low, mid, high or max), or where it sits in its board column (position). Use claim_ticket to pick a ticket up. Changing the assignee of a ticket reserved for one of the project's agents fails: only the human reassigns those. Status blocked means you are waiting on the human: say what for in a comment on the ticket. A move to done is refused while one of its needs is not merged into its base (the error says which); merge order is the human's, so leave it in review. A move to a review stage goes through and answers with open: [{taskId, ticketId, text, auto}], every task and subtask still open, of the ticket and of its lanes that are not cancelled, in tree order, without the Merged phase (merging is the human's); auto: true on a phase the board ticks from its fact (Pushed, PR, CI, Preview, Summary: the branch on origin, a PR, CI green, a preview running, an agent's summary written after the branch's last commit), [] when nothing is left. Fix what it lists. position puts the ticket at that place (1 is the top) in its stage's column, after any status change in the same call (so with status: review, position: 1 it goes to the top of review); the others keep their order. In a review stage the column's order is the merge order, top merges first: set it to say which PR should merge first. It is not enforced (needs is), and any move to another stage clears it.",
    {
      ticketId: z.number().int(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.string().optional().describe(STATUS),
      complexity: z.enum(COMPLEXITIES).optional().describe(COMPLEXITY),
      assignee: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoId: z
        .number()
        .int()
        .optional()
        .describe(
          "the primary repo. One of the ticket's other repos becomes the primary with its own branch, baseBranch and prNumber, the old primary staying among its repos with its own; any other repo of the project replaces the primary's repo, keeping the ticket's branch. With repos, it picks the primary from that list.",
        ),
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
      repos: REPOS.optional().describe(
        `${REPOS_TEXT} Replaces the whole list; what an entry leaves out stays as it was for that repo. A repo removed from the list has its runs for the ticket stopped.`,
      ),
      position: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "1-based place in its stage's column (its siblings in that stage; the board's column at the top level), 1 the top; past the end puts it last. With status, in the new stage. In a review stage: the merge order, top first",
        ),
    },
    ({ ticketId, ...patch }) => needs.changeTicket(ticketId, patch, actor, { agent: true }),
  )
  tool(
    'claim_ticket',
    "Pick a ticket up: assigns it to you (or, with as, to the project agent you work it as) and moves it from an open or blocked stage to the stage work starts in (get_project's workStage, else the first active stage), optionally setting the branch (the primary repo's) and, with repos, each repo's branch. Returns the ticket row; read its summary with get_ticket before anything else. A shared ticket someone else holds is taken over from them. Fails when the ticket is reserved for one of the project's agents and as is not that agent, or when it is in a done or cancelled stage.",
    {
      ticketId: z.number().int(),
      branch: z.string().optional().describe("the branch in the ticket's primary repo"),
      as: AS.describe('the project agent you work this ticket as; required when it is reserved for one'),
      repos: z
        .array(z.object({ repoId: z.number().int(), branch: z.string() }))
        .optional()
        .describe(
          "each repo's branch (get_project lists the repos); a repo of the project the ticket does not span yet is added to it. branch, when given, wins for the primary repo",
        ),
    },
    ({ ticketId, branch, as, repos }) => features.claimTicket(ticketId, actor, { branch, as, repos }),
  )
  tool(
    'add_tasks',
    `Append tasks to a ticket. ${TASKS} With parentTaskId (a top-level task of this ticket, such as Implementation) they are added as subtasks of it: the way to put the steps under a phase. A subtask cannot have subtasks, so a third level is refused and nothing is added. Without parentTaskId they are phases, appended at the end; a ticket with no tasks gets its phases this way (the names from get_project's defaultPhases, the steps under the first). Tasks and subtasks all count in the progress, and the open ones, its lanes' included and the hand-off phases too (Merged aside), are what update_ticket to review answers with (open). An item given as an object can also come tagged blocked: {text, blocked: true, blockedReason} (its subtasks stay plain texts; tag those with update_task). ${BLOCKED}`,
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
    "Tick or untick a task or a subtask. A task with subtasks is done exactly when all of them are: ticking or unticking it does the same to its subtasks, ticking its last open subtask ticks it, and unticking one of them unticks it. A done task waits on nobody: ticking clears its blocked tag, and that of every task the tick reaches (its subtasks, a parent its last subtask ticks); unticking does not bring a tag back. Pushed, PR, CI, Preview, Summary and Merged at the top level (auto: true on get_ticket) are ticked by the board from git, GitHub, the previews and the ticket's posts: ticking or unticking one is refused.",
    { taskId: z.number().int(), done: z.boolean().default(true) },
    ({ taskId, done }) => features.updateTask(taskId, { done }, actor),
  )
  tool(
    'update_task',
    `Reword a task or a subtask, tick / untick it (ticks keep a task and its subtasks in step, as set_task_done says), or tag it blocked on the human and clear that. When a step needs the human (a credential, a manual action, a call only they can make), set blocked: true with blockedReason saying what they must do, and keep working on the rest; blocked: false clears the tag and its reason once resolved (ticking it done clears it too). A reason alone rewrites the reason of a blocked task. Tagging a done task reopens it, as unticking would; done: true with blocked: true is refused. A phase the board ticks (auto: true on get_ticket: Pushed, PR, CI, Preview, Summary, Merged at the top level) takes no done here, nor a blocked tag while done; rewording, removing, or tagging it blocked while open still work. The tag is for one step: move the whole ticket to blocked (update_ticket) or ask_decision only when nothing else can go on. ${BLOCKED}`,
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
    "Register a worktree / sub-branch / subagent sandbox you opened for a ticket, so the board can show it. previewUrl is where its branch runs for the human to try, if it does already (set_preview sets it later). repoId is the repo it is a worktree of, one of the ticket's repos (get_ticket's repos); the ticket's primary repo when left out. A repo's runs run from its worktree.",
    {
      ticketId: z.number().int(),
      name: z.string(),
      branch: z.string().default(''),
      path: z.string().default(''),
      agent: z.string().optional(),
      previewUrl: z.string().optional().describe(PREVIEW_URL),
      repoId: z
        .number()
        .int()
        .optional()
        .describe("the ticket's repo this is a worktree of; the primary repo when left out"),
    },
    ({ ticketId, ...rest }) => features.addWorkspace(ticketId, rest, actor),
  )
  tool(
    'set_preview',
    'Set the link where a workspace\'s branch runs for the human to try (after you start its server), or clear it with "" once you stop the server. The ticket page shows it on its Runs card with an Open button and whether it is running.',
    {
      workspaceId: z.number().int(),
      previewUrl: z.string().describe(`${PREVIEW_URL}; "" clears it`),
    },
    ({ workspaceId, previewUrl }) => features.setWorkspacePreview(workspaceId, previewUrl, actor),
  )
  tool(
    'start_preview',
    "start_run for the first preview run of the workspace's repo (on a checkout of the board, its Preview), kept for older instructions; a repo with no preview run configured is refused. The board builds and runs it from the workspace's worktree (its registered path: a git worktree next to the repo's main checkout, never the main checkout). In the background, for the board's Preview: pnpm install when the lockfile changed, pnpm build, a fresh copy of the live data, then the built server on a free port from 47101 with sign-in off; once it answers the workspace's previewUrl is set. Returns at once with status building; get_ticket (the workspace's managedPreview) follows it to running, or failed with the last log lines. One per workspace; at most as many at once, board-wide, as the human's preview limit allows (8 by default): a start beyond it is refused with the limit, a restart of a running one is not. restart: true stops a running one first and builds again.",
    {
      workspaceId: z.number().int(),
      restart: z.boolean().default(false).describe('stop the running preview first and build again'),
    },
    ({ workspaceId, restart }) =>
      restart ? restartPreview(workspaceId, actor) : startPreview(workspaceId, actor),
  )
  tool(
    'preview_branch',
    "A board-run preview of a branch this machine has no worktree of, such as one pushed from a cloud session or another computer (its proxyUrl, once running, is the link through the board's origin: preview_link): the board fetches branch from the repo's origin into a detached worktree of its own next to the repo's main checkout (<checkout>-preview-<branch>), registers it as a workspace of the ticket (repoId: one of its repos, the primary when left out) and starts the repo's preview run from it, as start_preview does. branch defaults to the ticket's branch for that repo. Call it again after a new push: the same worktree moves to the branch's new head and the preview builds again. Returns {workspace, branch, sha, path, preview}; get_ticket (the workspace's managedPreview) follows it to running. Refused when origin has no such branch, or when that folder exists but is not the board's clean, detached worktree of the repo.",
    {
      ticketId: z.number().int(),
      branch: z
        .string()
        .max(255)
        .optional()
        .describe("the branch on origin; the ticket's branch when left out"),
      repoId: z.number().int().optional().describe("the ticket's repo; the primary when left out"),
    },
    ({ ticketId, ...rest }) => previewBranch(ticketId, rest, actor),
  )
  tool(
    'preview_link',
    "A link to the workspace's running preview through the board's own origin (its proxyUrl, from list_runs, start_run or get_ticket), for a browser that cannot send an Authorization header: the board returns url (/p/<workspaceId>/<runId>/?pl=...: it works for anyone who holds it until expiresAt, five minutes after it is returned, so send it only to the person meant to open it; not single-use. Opening it sets a cookie for the preview's path, valid for 15 minutes, and redirects to the path without the link) and expiresAt. A link is for that one run and this caller only; the caller's own token is never in it. With a Bearer header (what an agent's HTTP client and headless browser send), no link is needed: send the header with each request. The workspace's preview run must be running: start_run first.",
    { workspaceId: z.number().int() },
    ({ workspaceId }) => linkFor(request, workspaceId),
  )
  tool(
    'stop_preview',
    "Stop the first preview run of the workspace's repo (start_preview), kept for older instructions (stop_run stops any run): its processes are killed, its port freed and the workspace's previewUrl cleared.",
    { workspaceId: z.number().int() },
    async ({ workspaceId }) => {
      if (!isActive(managedPreview(workspaceId)))
        throw new HttpError(409, 'the board runs no preview of this workspace')
      return stopPreview(workspaceId, `stopped by ${actor}`, actor)
    },
  )
  tool(
    'list_runs',
    "Every run of every repo of the ticket, grouped by repo in the ticket's order (the primary first): repos [{repoId, name, branch, primary, workspace (the ticket's worktree of that repo the runs use: on the repo's branch first, else the newest; null when the ticket has none), workspaceProblem (why there is none), runs [{id, name, type preview | job, install, build, start, env, port (null: auto), healthPath, copyData, workspaceId, state (null when it never ran there; status building | starting | running | failed | stopped, step, port, url (a preview's, once it answers), proxyUrl (a running preview's path on the board's own origin, /p/<workspaceId>/<runId>/, signed-in only: the link a cloud agent or another device opens; with the board's tailnet entrance, remoteUrl is the same path on that origin), reason, tail: the last log lines, logs: their paths), cannotStart (why a start would be refused, null when it would start)}]}], orphaned [{repoId, repoName, runId, name, type, workspace, state, reason}]: runs started from the ticket's workspaces that still go for a repo the ticket no longer spans (stop_run stops them; they cannot start again), alsoRunning [the same shape]: runs of the ticket's repos going from another of its workspaces than the one their row shows (stop_run stops them with the rest of that run), and inUse and limit: the runs going board-wide and the human's preview limit. add_run, update_run and delete_run change a repo's runs.",
    { ticketId: z.number().int() },
    ({ ticketId }) => ticketRuns.ticketRuns(ticketId),
  )
  tool(
    'start_run',
    "Have the board start one of the ticket's runs (list_runs), by its id or name, from the ticket's worktree of its repo (register it with add_workspace first). repoId picks the repo when a name is in several (the error lists them). In the background: install when the lockfile changed, build, a copy of the live data when the run takes one, then its start command; a preview gets a free port from 47101 (or its fixed one), and once its health path answers the workspace's previewUrl is set; a job runs once started. Returns at once with status building (a running preview also returns proxyUrl: its link through the board's origin, see preview_link); list_runs follows it to running, or failed with the last log lines. With all: true (or no run) it starts every run of the ticket's repos (of repoId's only, given) that does not run yet and answers results, each with ok and reason: one refused does not stop the rest. At most as many runs at once, board-wide, as the human's preview limit allows: a start beyond it is refused, a restart of a running one is not. restart: true stops a running one first and starts it again. What runs is the run's stored commands, env and port (add_run and update_run set them), never what a start request carries.",
    {
      ticketId: z.number().int(),
      run: z.union([z.number().int(), z.string()]).optional().describe("the run's id or name (list_runs)"),
      repoId: z.number().int().optional().describe("the ticket's repo the run is of"),
      restart: z.boolean().default(false).describe('stop it first if it runs, and start it again'),
      all: z.boolean().default(false).describe("every run of the ticket's repos (repoId's only, given)"),
    },
    ({ ticketId, run, repoId, restart, all }) =>
      all || run === undefined
        ? ticketRuns.startTicketRuns(ticketId, actor, { repoId })
        : ticketRuns.startTicketRun(ticketId, run, actor, { repoId, restart }),
  )
  tool(
    'stop_run',
    "Stop one of the ticket's runs that builds or runs (by id or name, as start_run takes it): its processes are killed, its port freed and a preview's link cleared. With all: true (or no run), every run of the ticket (of repoId's only, given) that builds or runs, answering results. A run is stopped from every workspace of the ticket it goes from; its orphaned runs (list_runs) are stopped too, by name or with all.",
    {
      ticketId: z.number().int(),
      run: z.union([z.number().int(), z.string()]).optional().describe("the run's id or name (list_runs)"),
      repoId: z.number().int().optional().describe("the ticket's repo the run is of"),
      all: z.boolean().default(false).describe("every run of the ticket's repos (repoId's only, given)"),
    },
    ({ ticketId, run, repoId, all }) =>
      all || run === undefined
        ? ticketRuns.stopTicketRuns(ticketId, actor, { repoId })
        : ticketRuns.stopTicketRun(ticketId, run, actor, { repoId }),
  )
  // A run's fields, as POST /api/repos/:id/runs takes them; runConfigProblem (src/lib/runs.ts) checks the rest.
  const runFields = {
    name: z.string().max(200).describe('unique in its repo, any casing; at most 60 characters'),
    type: z.string().max(20).describe('preview (answers on a port, gets a link) or job (no port, no link)'),
    install: z
      .string()
      .max(5_000)
      .optional()
      .describe('run through the shell in the worktree when the lockfile changed; "" skips it'),
    build: z.string().max(5_000).optional().describe('run through the shell in the worktree; "" skips it'),
    start: z
      .string()
      .max(5_000)
      .describe('the command that starts it, run through the shell in the worktree'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'variables for the start command; never PORT, HOST or PREVIEW_PARENT_PID (DATA_DIR with copyData)',
      ),
    port: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("a preview's fixed port from 47101 to 47199; null (auto) for a free one, always for a job"),
    healthPath: z
      .string()
      .max(1_000)
      .optional()
      .describe('the path a preview answers on, starting with / (/ when left out); "" for a job'),
    copyData: z
      .boolean()
      .optional()
      .describe("copy the live board's data into <worktree>/data/preview, as DATA_DIR, before it starts"),
  }
  const RUN_WRITE =
    "Each change is in the project's activity under your name, and the human sees it in the project's settings (Runs). Refused, with the field: a name the repo already has (any casing), a type other than preview or job, an empty start, an env key that is not a variable name or one the board sets, a port outside 47101-47199, a job with a port or a health path, a health path without a leading /."
  tool(
    'add_run',
    `Add a run to one of the project's repos (get_project or list_runs give its repoId): what the board starts from a ticket's worktree of the repo with start_run. A preview gets a free port from 47101 unless it names one, and its link once its health path answers; a job is a background worker with no port nor link. It goes last in the repo's runs. ${RUN_WRITE} Returns the stored run (its id is the runId update_run and delete_run take).`,
    { repoId: z.number().int(), ...runFields },
    ({ repoId, ...input }) => runConfig.createRunConfig(repoId, input as Partial<RunConfigInput>, actor),
  )
  tool(
    'update_run',
    `Change any run of a repo, one the human made too (runId: its id from list_runs or add_run): only the fields you give change. A change of type sets the port and health path to the new type's own unless you give them; the env is kept. It applies at the run's next start (start_run with restart: true for one that runs). ${RUN_WRITE} Returns the stored run.`,
    {
      runId: z.number().int(),
      name: runFields.name.optional(),
      type: runFields.type.optional(),
      install: runFields.install,
      build: runFields.build,
      start: runFields.start.optional(),
      env: runFields.env,
      port: runFields.port,
      healthPath: runFields.healthPath,
      copyData: runFields.copyData,
    },
    ({ runId, ...patch }) => runConfig.updateRunConfig(runId, patch as Partial<RunConfigInput>, actor),
  )
  tool(
    'delete_run',
    "Delete any run of a repo, one the human made too (runId: its id from list_runs or add_run). Whatever builds or runs of it, from any worktree, is stopped first. In the project's activity under your name. Returns the deleted run.",
    { runId: z.number().int() },
    ({ runId }) => removeRunConfig(runId, actor),
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
  // the work timeline: what you record as you work a ticket (workTimeline.ts)
  const SCOPE =
    "projectId and ticketId name the ticket: it must be a ticket of that project (another project's is refused with 403 and nothing is written; an archived ticket with 409). agent is who did the work (1 to 60 characters, a sub-agent's name too; you when left out: your whoami name, <token>/<name> for a sub-identity); the board also records you as by. note: up to 500 characters. The board takes the time itself. Nothing goes to the feed or the Daily view, and the ticket is not bumped."
  const scoped = { projectId: z.number().int(), ticketId: z.number().int(), ...work.eventBase }
  tool(
    'start_span',
    `Start a span of work on a ticket: a phase (spec, build, review, verify, pr, preview, merge, or any other words; the known ones are stored lowercased), with round for a review round (1 to 20). Start one at the beginning of each phase and end it (end_span) when the phase is done; it shows as a segment of the ticket's work timeline on the Roadmap and the ticket page, and counts as working time. Returns spanId. ${SCOPE}`,
    { ...scoped, ...work.eventFields.span_start },
    ({ projectId, ticketId, ...input }) => work.startSpan(projectId, ticketId, input, actor),
  )
  tool(
    'end_span',
    `End a span you started: by spanId, or else the latest open span on the ticket by agent (of phase, when given). Refused with 409 when there is no such open span, or it already ended. Returns the span's start, end and durationMs. get_ticket's work.open.spans lists the open ones. ${SCOPE}`,
    { ...scoped, ...work.eventFields.span_end },
    ({ projectId, ticketId, ...input }) => work.endSpan(projectId, ticketId, input, actor),
  )
  tool(
    'handoff',
    `Record that work on a ticket passes from one agent to another: when you brief a sub-agent (to: its name, which need not be one of the project's agents or a token), or hand back to the orchestrator. from defaults to agent. It shows as a marker on the timeline. ${SCOPE}`,
    { ...scoped, ...work.eventFields.handoff },
    ({ projectId, ticketId, ...input }) => work.handoff(projectId, ticketId, input, actor),
  )
  tool(
    'start_wait',
    `Start a wait on a ticket, with its reason: lock (a shared lock, such as the test lock), builder (waiting on the builder or another agent's result), mcp (the board or another MCP server is down), human (waiting on the human's answer or action) or other (say what in note). End it with end_wait as soon as you can go on. A wait shows hatched on the timeline and counts as waiting time only while no span is open on the ticket (a sub-agent's span under your wait on it counts as working), or as blocked on the human for reason human, span or not; an open human wait keeps the ticket from reading as stalled. Pass on: the agent the work was handed to (a sub-agent you briefed, its full agentName such as orch/builder-1, or the name it works under) when you wait on an agent you briefed: such a delegated wait counts as working, not waiting, and shows who has the ticket. Left out, the wait reads as before. Returns waitId. ${SCOPE}`,
    { ...scoped, ...work.eventFields.wait_start },
    ({ projectId, ticketId, ...input }) => work.startWait(projectId, ticketId, input, actor),
  )
  tool(
    'end_wait',
    `End a wait: by waitId, or else the latest open wait on the ticket by agent. Refused with 409 when there is no such open wait, or it already ended. ${SCOPE}`,
    { ...scoped, ...work.eventFields.wait_end },
    ({ projectId, ticketId, ...input }) => work.endWait(projectId, ticketId, input, actor),
  )
  tool(
    'heartbeat',
    `Say you are still working a ticket. Send one every few minutes while you work it (in Claude Code under /loop, or between steps): a ticket in an active stage with no event of any kind for longer than its project's stallMinutes (30 by default) reads as stalled, on its card, in list_tickets, get_ticket and the human's Needs you. Returns at and lastSignalAt. ${SCOPE}`,
    { ...scoped },
    ({ projectId, ticketId, ...input }) => work.heartbeat(projectId, ticketId, input, actor),
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
    "Write the ticket's summary: the one post at the top of the feed's Main tab, for the human, and the hand-off (the board ticks the Summary phase while an agent's version is newer than the branch's last commit). Short and to the point: what the change does, where it stands now, each review round's verdict in one line, the PR, the preview and what to try there, and the proofs (screenshots, recordings) as files. Rewrite it to the current state instead of posting a new hand-off: each write replaces it, and the board keeps every earlier version as its history. A new version replaces the previous one in wording, never in facts: carry forward every section and fact that still holds (what the change does, where it stands, each review round's verdict, the PR, the preview and what to try there, how it was tested); keep the latest screenshots and recordings in files, and older proofs while they still show the current state, never dropping the proofs for a section that still stands. Add what changed this time (change, one line) instead of deleting the rest; if a fact no longer holds, say what replaced it. change says in one line what changed since the last version (required from the second version on), shown as \"updated <time>: <change>\". Like a new post, every write bumps the ticket and reaches the human's Needs you and the inboxes. Returns the summary as get_ticket shows it.",
    {
      ticketId: z.number().int(),
      body: z
        .string()
        .describe(
          'markdown: the whole summary as it stands now, carrying forward every section and fact that still holds and keeping the latest proofs as files',
        ),
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
    'add_repo',
    "Ask the human to add a repo to your project: one decision card, \"Add repo <name>?\" with Add and Don't add, on the ticket you name (Main tab; it does not block or move it), naming the repo's name, GitHub repo, path and base branch. It shows in the human's Needs you. The repo goes to that ticket's project: never another one, and no project is made. Nothing is added until the human answers Add on the board, or you relay their chat answer with answer_decision after asking them; Add checks it all again and adds the repo in the human's name, and Don't add changes nothing. You can never add, change or remove a repo directly. Checked first, and no card is posted when one fails (the error says which): repoPath is an absolute path to an existing git checkout (a worktree too); its origin remote is github.com's githubRepo (owner/name, any casing; only the URL is compared); the project has no repo of that name (any casing); and no repo of the board is registered at that path. Returns the card's post (its id is the postId answer_decision takes). Once it is added, move the ticket onto it with set_ticket_repo.",
    {
      ticketId: z.number().int().describe('the ticket you work on; the repo goes to its project'),
      name: z.string().min(1).max(100).describe("the repo's name on the board, unique in the project"),
      repoPath: z.string().min(1).max(1000).describe("the checkout's absolute path on the board's machine"),
      githubRepo: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'the GitHub owner/name its origin remote points at, like acme/shop (git remote get-url origin)',
        ),
      baseBranch: z.string().max(200).optional().describe('the branch work merges into; main when left out'),
      as: AS,
    },
    ({ ticketId, ...input }) => {
      if (!agent) throw new HttpError(403, 'the human adds repos directly; agents ask here')
      return features.requestRepo(ticketId, input, actor)
    },
  )
  tool(
    'set_ticket_repo',
    "Move a ticket onto another repo of its own project, at once (no card), as its primary repo: the board then looks for its branch in that checkout, and its base branch becomes that repo's (baseBranch to give another). A repo the ticket already spans (its repos) becomes the primary with its own branch, base and PR, the old primary staying among its repos. Logged in the ticket's activity. Refused: a repo of another project (a ticket never moves across projects), a PR's own ticket (it belongs to its PR's repo), an unknown ticket or repo. Its lanes keep their own repos. Returns the ticket.",
    {
      ticketId: z.number().int(),
      repoId: z.number().int().describe("one of the project's repos (get_project lists them)"),
      baseBranch: z
        .string()
        .max(200)
        .optional()
        .describe("the ticket's base branch there; the repo's when left out"),
    },
    ({ ticketId, ...input }) => features.setTicketRepo(ticketId, input, actor, { agent: true }),
  )
  tool(
    'answer_decision',
    "Record the human's answer to a decision card, given in the chat, as the orchestrator. Call it only in the session that talks to the human, after you asked them the card's question in the chat (AskUserQuestion in Claude Code, or the client's equivalent) and they answered there. postId: the card's post (get_ticket, or needsYou.decisions in get_summary). option: the index of the option they picked, as the card lists them. words: their answer as they gave it, verbatim. The card is recorded as decided by the human, relayed by you, with their words; the ticket goes back to in progress once nothing else is open. On a request_archive card, Archive then archives its tickets in the human's name; on an add_repo card, Add then adds the repo in the human's name, once it passes add_repo's checks again (repo in the answer: added, already, or refused with why). Refused: a human caller; a sub-identity (a call with agentName or X-Agent-Name: a delegated worker); any call with as (one of the project's agents); empty words; an option the card does not have; a post that is not a decision; a card already decided (the human changes it on the board). A delegated subagent never answers a decision either; one that passes agentName is refused, and the server cannot tell one that leaves it out from you: keeping to this is your job.",
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
    async (args) =>
      features.relayDecision(args.postId, args, actor, {
        agent,
        delegated: caller.parent !== '',
        origin: await features.answerOrigin(args.postId, args.option),
      }),
  )
  tool(
    'edit_post',
    'Change a post you made on a ticket (its body, whether it is progress, or its tab of the feed: tab main or agents moves it), or a reply (kind reply: its body). Edits show as edited. A version of the summary is never edited: write a new one with set_ticket_summary. Nor is the body of a request_archive or add_repo card: ask again instead.',
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
    "Read-only git state of the ticket branch and its workspaces, its lanes' included and tagged with the lane (ahead/behind, last commit, worktrees). repos has every repo the ticket spans, the primary first, each {repo, primary, branch, baseBranch, info (the same state for that repo's branch), pr}; the top-level repo, branch and info are the primary's, and each workspace says its repo. Each branch's reach says whether its work is already in its base chain (a lane's parent branch, then the parent's base, then the repo's base): merged (as is), rebased (same patches), edited (patches differ but merging would change nothing), unique (still has work of its own, listed). merged, rebased and edited are safe to delete. Each branch's push says whether it is on origin: state pushed (origin has every commit; behind: how many origin has on top), ahead (ahead commits not pushed yet), local-only (not on origin at all), merged (gone from origin, merged into the ticket's base: into), remote-only (only on origin) or none, with checkedAt: when origin was last fetched (the board fetches every few minutes). includes: ids of open tickets whose unmerged work this ticket's branch holds (commits of their branch that are in this one but not in its base): declare them with update_ticket needs, so they are merged first.",
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
    'A file someone attached to a post or reply: name, type, size and the absolute path to open it on this machine (windowsPath too when the board runs in WSL). A picture drawn on before it was attached is the flattened picture on disk, and its annotations come with it: the shapes and their numbered notes (items[*].note, in the order the picture numbers them), the document the upload carried. annotations is null for a file nobody drew on. Always read the notes: they say what the marks mean.',
    { attachmentId: z.number().int() },
    ({ attachmentId }) => uploads.attachmentView(uploads.getAttachment(attachmentId)),
  )
  tool(
    'list_gallery',
    "The project's files, newest first unless sort says otherwise (oldest, name, name-desc, largest, smallest, type): every file on its tickets' posts, on the replies under those posts and with their instructions (not on a PR's own ticket, its discussion), each with name, type, kind, size, who uploaded it and when, the absolute path to open it on this machine (windowsPath too when the board runs in WSL), its annotations when the picture was drawn on before attaching (the shapes and their numbered notes, see get_attachment), its ticket (id, title: for a lane's file, the top-level ticket, whose page shows the lane's posts too), lane (id, title of the lane that holds it, or null), where it is (source: post, reply or instructions, with postId and commentId) and anchor (the #hash of the ticket page's link to that post or reply). Files of archived tickets only with archived: include. A page at a time: pass next back as cursor for the next one, null after the last.",
    { projectId: z.number().int(), ...galleryShape },
    ({ projectId, ...filters }) => listGallery(projectId, filters),
  )
  tool(
    'list_actors',
    "Every name that signs in to the board: {name, kind (agent or human), role (human; orchestrator or worker for an agent, as last seen), parent (the name a sub-identity <token name>/<name> works under, '' otherwise)}. Connected agents by token name and their sub-identities, the human by passkey. The project's own agents are in get_project. Use these exact names for assignee.",
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

/**
 * The tool calls' `agentName` in the request's body: undefined for a call without one. A request is one
 * call in practice; a batch whose calls name different callers is refused whole.
 */
async function agentNamesOf(request: Request): Promise<unknown[]> {
  if (request.method !== 'POST') return []
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return []
  }
  type Message = { method?: unknown; params?: { arguments?: Record<string, unknown> } }
  return (Array.isArray(body) ? body : [body])
    .filter(
      (m): m is Message => typeof m === 'object' && m !== null && (m as Message).method === 'tools/call',
    )
    .map((m) => m.params?.arguments?.agentName)
}

/**
 * Who the request's tool calls run as: the signed-in caller, or the sub-identity their agentName names
 * (asSubIdentity's rules). With X-Agent-Name already making the request a sub-identity, agentName must
 * name that same one. A human's call is the human's whatever it says.
 */
export async function agentNameOf(request: Request, caller: Caller): Promise<Caller> {
  if (caller.kind === 'human') return caller
  const names = [...new Set(await agentNamesOf(request))]
  if (names.length > 1)
    throw new HttpError(400, 'agentName: every tool call of one request is made by the same caller')
  const name = names[0]
  if (typeof name !== 'string') return caller
  if (caller.parent) {
    if (name.trim() === caller.name) return caller
    throw new HttpError(
      400,
      `agentName ${name} and X-Agent-Name ${caller.name} disagree: give one of them, or the same name in both`,
    )
  }
  return asSubIdentity(caller, name, 'agentName')
}

export async function handleMcp(request: Request, actor: string): Promise<Response> {
  // Stateless and JSON-only: each POST is fully answered before the response is returned, nothing outlives the request.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  // Who calls comes with the request, its agentName included: the tools that only an agent, or only an
  // orchestrator, may call check it.
  let caller = callerInfo(request, actor)
  let refused: HttpError | null = null
  try {
    const named = await agentNameOf(request, caller)
    if (named !== caller) noteActor(named.name, named.kind, named.role, named.parent)
    caller = named
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    refused = err
  }
  await buildServer(caller, refused, request).connect(transport)
  return transport.handleRequest(request)
}
