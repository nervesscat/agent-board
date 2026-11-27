import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import {
  COMMENT_PARENTS,
  DEFAULT_COMPLEXITY,
  EVENT_KINDS,
  STAGE_KINDS,
  WAIT_REASONS,
  type EventKind,
  type CommentParent,
  type Complexity,
  type PrCheck,
  type ReportCadence,
  type ReportFormat,
  type StageColor,
  type StageKind,
  type StageHow,
  type SendBackReason,
  type FeedTab,
} from '#/lib/constants'
import type { AnnotationDoc } from '#/lib/annotations'
import type { SavedLayout } from '#/lib/layout'
import type { ProjectTweaks, WorkflowPresetId } from '#/lib/workflow'
import type { Kind } from '#/lib/kinds'
import type { RunReportDurationSource, RunReportStep, RunReportTime } from '#/lib/runReports'
import type { RunType } from '#/lib/runs'

export { COMMENT_PARENTS, STAGE_KINDS, type CommentParent, type StageColor, type StageKind }

const id = () => integer().primaryKey({ autoIncrement: true })
const now = () =>
  text()
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)

// A project is the unit of work (PR queue, features, reviews, daily); it spans one or more repos.
export const projects = sqliteTable('projects', {
  id: id(),
  name: text().notNull(),
  instructions: text().notNull().default(''),
  createdAt: now(),
  // The top-level phases a new ticket starts with, in order. Null is the built-in list, so a later
  // change to it reaches the project; [] seeds nothing.
  defaultPhases: text('default_phases', { mode: 'json' }).$type<string[]>(),
  // The tags offered under every ticket's tags field, before the ones the project's tickets carry.
  // [] offers none of its own.
  tagSuggestions: text('tag_suggestions', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(['Bug', 'UI', 'Implementation', 'Report']),
  // How many minutes an active ticket may go without a work event before it reads as stalled, 1 to 1440.
  // The migration adds that range as a column CHECK: a table CHECK would have drizzle rebuild projects.
  stallMinutes: integer('stall_minutes').notNull().default(30),
  // Which of the project's menu pages, Overview cards and ticket sections show, and where. Null is
  // the defaults; what is handed out is that merged with the elements there are now (`mergeLayout`).
  layout: text('layout', { mode: 'json' }).$type<SavedLayout>(),
  // The key of the active stage claiming a ticket (and a status given as in_progress or active) puts it
  // in. Null, or a stage that is gone or no longer active, is the first active stage.
  workStage: text('work_stage'),
  // What the project is for (`#/lib/kinds`): one or more kinds. Software is the git side; a project
  // with none of software hides it. The migration gives every existing project software.
  kinds: text('kinds', { mode: 'json' }).$type<Kind[]>().notNull().default(['software']),
  // The workflow its tickets' agents follow (`#/lib/workflow`): the active preset, and what the human changed
  // in each preset (order, switches, efforts, the Team agent of each node, review rounds). Null is no change.
  workflowPreset: text('workflow_preset').$type<WorkflowPresetId>().notNull().default('standard'),
  workflowTweaks: text('workflow_tweaks', { mode: 'json' }).$type<ProjectTweaks>(),
  // The command the board runs, on its own machine, to continue a ticket's work once the human answers a
  // decision card or moves it back to an active stage (src/server/resume.ts). '' is off. Only the
  // signed-in human writes it.
  resumeCommand: text('resume_command').notNull().default(''),
  // How many minutes a resumed run may go on before the board stops it and calls it failed.
  resumeTimeoutMinutes: integer('resume_timeout_minutes').notNull().default(240),
})

// The columns of a project's board, in order. A ticket's status is the key of one of them; the key
// stays when the stage is renamed. The kind is what the board's rules go by.
export const stages = sqliteTable(
  'stages',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    name: text().notNull(),
    kind: text().$type<StageKind>().notNull(),
    color: text().$type<StageColor>().notNull().default('gray'),
    position: integer().notNull().default(0),
  },
  (t) => [uniqueIndex('stages_project_key').on(t.projectId, t.key)],
)

// The project's own agents: a name, a picture and the instructions an orchestrator briefs a subagent
// with. A ticket assigned to one is reserved for it; anything else is shared by every connected agent.
export const agents = sqliteTable(
  'agents',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    // What the agent reads: who it is, how it works, what it never does.
    instructions: text().notNull().default(''),
    // What the orchestrator reads: when to hand work to this agent, what to give it, what comes back
    // and what comes next.
    delegation: text().notNull().default(''),
    // The run report template this agent fills in after each run (src/server/runReports.ts); a new agent
    // starts with the common part every template carries.
    reportTemplate: text('report_template').notNull().default(''),
    avatarId: integer('avatar_id').references((): AnySQLiteColumn => attachments.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by').notNull(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [uniqueIndex('agents_project_name').on(t.projectId, t.name)],
)

// A project's notes: the short facts the human and every agent must not rediscover (a command, a path,
// a rule, a reminder). One fact each; position orders them, a negative one pinning a note above the rest.
export const projectNotes = sqliteTable(
  'project_notes',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // A few words saying why the note is there, at most 60 characters.
    label: text().notNull(),
    // The fact itself, plain text, at most 500 characters.
    body: text().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: now(),
    updatedAt: now(),
    // Ascending order, ties by id; a new note goes last, a pinned one before every unpinned note.
    position: integer().notNull().default(0),
  },
  (t) => [index('project_notes_project').on(t.projectId, t.position)],
)

export const repos = sqliteTable('repos', {
  id: id(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  repoPath: text('repo_path').notNull(),
  githubRepo: text('github_repo'),
  baseBranch: text('base_branch').notNull().default('main'),
  // Whether the board gave it the default run once (a checkout of the board itself gets its preview):
  // a run the human deleted is not given back.
  runsSeeded: integer('runs_seeded', { mode: 'boolean' }).notNull().default(false),
  createdAt: now(),
})

// A run of a repo, as the human configures it in the project's settings or an agent through MCP: what
// the board starts from a ticket's worktree of the repo (src/server/runs.ts). A preview answers on a
// port, a job has none. createdBy is whoever added it.
export const runConfigs = sqliteTable(
  'run_configs',
  {
    id: id(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    type: text().$type<RunType>().notNull(),
    // Each a whole command line run in the worktree; an empty install or build is skipped.
    install: text().notNull().default(''),
    build: text().notNull().default(''),
    start: text().notNull().default(''),
    // Set on its start command; `{port}` in a value is the port it was given.
    env: text({ mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    // A preview's fixed port (47101 to 47199); null takes the first free one. Always null on a job.
    port: integer(),
    // Where a preview answers once it is up ('' on a job).
    healthPath: text('health_path').notNull().default(''),
    // A fresh copy of the live data in <worktree>/data/preview, as DATA_DIR.
    copyData: integer('copy_data', { mode: 'boolean' }).notNull().default(false),
    position: integer().notNull().default(0),
    createdBy: text('created_by').notNull().default(''),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    uniqueIndex('run_configs_repo_name').on(t.repoId, t.name),
    check('run_configs_type', sql`${t.type} IN ('preview', 'job')`),
  ],
)

export const prs = sqliteTable(
  'prs',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    title: text().notNull(),
    url: text().notNull(),
    author: text().notNull(),
    headRef: text('head_ref').notNull(),
    baseRef: text('base_ref').notNull(),
    headSha: text('head_sha').notNull(),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    reviewDecision: text('review_decision'),
    // The human's standing review verdict (approved / changes_requested / commented), or `none`.
    myReview: text('my_review').notNull().default('none'),
    // GitHub still asks me for a review (its `review-requested:@me` search found it): what the To
    // review switch's Just me as reviewer narrows to. GitHub drops the request once the review is given.
    requested: integer({ mode: 'boolean' }).notNull().default(false),
    // One of the searches for the human's own PRs found it (authored, review requested, reviewed,
    // assigned), as of the last refresh. False: it is open and found only by the repo's plain open
    // list, so it shows under All PRs alone and no other reader counts it.
    involvesMe: integer('involves_me', { mode: 'boolean' }).notNull().default(true),
    // `me`: someone else's PR, for the human to review. `others`: the human authored it.
    waitingOn: text('waiting_on').$type<'me' | 'others'>().notNull().default('me'),
    // Where its reviews stand on GitHub as of the last refresh; a hold or a merge overrides it.
    reviewStage: text('review_stage')
      .$type<'pending' | 'reviewed' | 'on_hold'>()
      .notNull()
      .default('pending'),
    // GitHub's own words: MERGEABLE / CONFLICTING / UNKNOWN, and CLEAN / BEHIND / BLOCKED / DIRTY / …
    mergeable: text().notNull().default('UNKNOWN'),
    mergeStateStatus: text('merge_state_status').notNull().default('UNKNOWN'),
    checks: text({ mode: 'json' })
      .$type<PrCheck[]>()
      .notNull()
      .default(sql`'[]'`),
    updatedAt: text('updated_at').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    open: integer({ mode: 'boolean' }).notNull().default(true),
    // When GitHub merged it; null while open, or when it was closed without merging.
    mergedAt: text('merged_at'),
    // When it left the open queue (merged, closed, or no longer the human's); kept on later refreshes.
    closedAt: text('closed_at'),
    hold: integer({ mode: 'boolean' }).notNull().default(false),
    holdNote: text('hold_note').notNull().default(''),
    // The head SHA a "CI run locally: green" comment on the PR names, as of the last refresh; null when
    // no such comment names the head. The CI phase counts it as green while it equals `headSha`.
    localCiSha: text('local_ci_sha'),
    // What GitHub said of a PR that left every search while open (MERGED or CLOSED), asked once when
    // it left; null while the searches see it, or when GitHub could not say. A row closed here with no
    // merge time and no answer may be a merge the capped searches missed.
    leftAs: text('left_as').$type<'MERGED' | 'CLOSED'>(),
  },
  (t) => [index('prs_project_number').on(t.projectId, t.number), index('prs_repo').on(t.repoId)],
)

export const tickets = sqliteTable(
  'tickets',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // The repo the ticket's branch lives in; null means the project's first repo.
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    // A lane: a parallel piece of the parent ticket, worked like any ticket. Null at the top level.
    parentId: integer('parent_id').references((): AnySQLiteColumn => tickets.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    body: text().notNull().default(''),
    // The key of one of the project's stages.
    status: text().notNull().default('todo'),
    // Where it was placed in its stage's column (its siblings in that stage): placed tickets come first,
    // lowest rank first, then the rest last updated first. Null until placed; any change of stage clears it.
    rank: integer(),
    // How much review the ticket gets: low none, mid one round, high three, max up to ten
    // (COMPLEXITIES).
    complexity: text().$type<Complexity>().notNull().default(DEFAULT_COMPLEXITY),
    // The preset of the workflow this ticket follows instead of its project's; null follows the project's.
    // Checked in code (`#/lib/workflow`), not by a column CHECK: a table CHECK would have drizzle rebuild tickets.
    workflowPreset: text('workflow_preset').$type<WorkflowPresetId>(),
    assignee: text().notNull().default(''),
    branch: text().notNull().default(''),
    baseBranch: text('base_branch').notNull().default('main'),
    // The PR the ticket's branch was opened as, in the ticket's repo; null until there is one.
    prNumber: integer('pr_number'),
    // The PR queue row a PR ticket is for: the ticket the board opened for a PR of the queue, which lives in
    // the queue only (no feature list counts it). Null on every other ticket.
    prId: integer('pr_id').references(() => prs.id, { onDelete: 'set null' }),
    createdBy: text('created_by').notNull(),
    // Free labels the agents choose (severity, area, …); the lanes list filters on them.
    tags: text({ mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    // The human's sign-off (on a lane, usually); null until approved. Agents can read it, not set it.
    approvedAt: text('approved_at'),
    approvedBy: text('approved_by').notNull().default(''),
    // Set when the approval closed the ticket to done (a PR review, or a hand-off): taking it back reopens it.
    closedByApproval: integer('closed_by_approval', { mode: 'boolean' }).notNull().default(false),
    // The opposite call: the human rejected it, which also cancels it. At most one of the two is set.
    disapprovedAt: text('disapproved_at'),
    disapprovedBy: text('disapproved_by').notNull().default(''),
    // When its PR was merged, as GitHub tells it (the latest of its PRs'), once the board has seen the
    // merge; null until then, and on tickets merged before the board kept it.
    mergedAt: text('merged_at'),
    // Put away by the human off the board and the default lists; a lane goes with its ticket. Null while on the board.
    archivedAt: text('archived_at'),
    archivedBy: text('archived_by').notNull().default(''),
    // When work on it last started: it entered an active, blocked or review stage from any other kind.
    // A multi-day ticket counts its days from here.
    startedAt: text('started_at'),
    // Whether the board has looked at the ticket for a missing Merged phase (added once, before its
    // Hand-off post, when it has the hand-off phases): set once looked at, and on a new ticket, so a
    // Merged phase someone removed does not come back.
    mergedPhaseChecked: integer('merged_phase_checked', { mode: 'boolean' }).notNull().default(false),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    index('tickets_parent').on(t.parentId),
    check('tickets_complexity', sql`${t.complexity} IN ('low', 'mid', 'high', 'max')`),
  ],
)

// A ticket's work timeline (src/server/workTimeline.ts): what its agents recorded (spans of a phase,
// hand-offs, waits, heartbeats) and what the board saw (pushes, the PR, the preview, the merge, stage
// moves). Always the server's time; never edited.
export const ticketEvents = sqliteTable(
  'ticket_events',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    // The ticket's project, kept for the project-wide reads.
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text().$type<EventKind>().notNull(),
    // Who did the work: the name the caller gave (a sub-agent's), else the caller; `board` for the board's own.
    agent: text().notNull(),
    // Who recorded it: the token or human name that called.
    by: text().notNull(),
    phase: text().notNull().default(''),
    round: integer(),
    // On span_end and wait_end: the start it closes.
    refId: integer('ref_id'),
    fromAgent: text('from_agent').notNull().default(''),
    toAgent: text('to_agent').notNull().default(''),
    reason: text().notNull().default(''),
    // On wait_start: the agent the work was handed to (a delegated wait counts as working); null otherwise.
    on: text(),
    note: text().notNull().default(''),
    // On stage events: the stage keys it moved from ('' when the ticket was created) and to.
    fromStage: text('from_stage').notNull().default(''),
    toStage: text('to_stage').notNull().default(''),
    // On stage events: who moved it (the human's or the agent's name, `board` for the board's own) and how
    // (STAGE_HOWS). `agent` and `by` stay `board` on them: a move is never an agent's word on the timeline.
    // Both '' on the rows written before the board kept them. Checked in code, not by a CHECK.
    movedBy: text('moved_by').notNull().default(''),
    how: text().$type<StageHow | ''>().notNull().default(''),
    at: now(),
  },
  (t) => [
    index('ticket_events_ticket_at').on(t.ticketId, t.at),
    index('ticket_events_project_at').on(t.projectId, t.at),
    check('ticket_events_kind', sql.raw(`kind IN (${EVENT_KINDS.map((k) => `'${k}'`).join(', ')})`)),
    check('ticket_events_reason', sql.raw(`reason IN ('', ${WAIT_REASONS.map((k) => `'${k}'`).join(', ')})`)),
  ],
)

// The human sending a ticket back from review (a review or approved stage) to an active or open one: one
// row per such move, beside its stage event, with the reason when one was picked or named
// (SEND_BACK_REASONS, '' for none; checked in code). Written by src/server/stageHistory.ts.
export const ticketSendBacks = sqliteTable(
  'ticket_send_backs',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // The stage event of the move; null when that event could not be written.
    eventId: integer('event_id').references(() => ticketEvents.id, { onDelete: 'set null' }),
    fromStage: text('from_stage').notNull(),
    toStage: text('to_stage').notNull(),
    // The human who moved it.
    by: text().notNull(),
    reason: text().$type<SendBackReason | ''>().notNull().default(''),
    // Who gave the reason and when: '' and null while it has none.
    reasonBy: text('reason_by').notNull().default(''),
    reasonAt: text('reason_at'),
    at: now(),
  },
  (t) => [index('ticket_send_backs_ticket').on(t.ticketId, t.at)],
)

// A ticket that cannot be done before another ticket's branch is merged into its base: a stacked
// branch, or one that took in another branch's work. Both ends are tickets of the same project.
export const ticketNeeds = sqliteTable(
  'ticket_needs',
  {
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    needsId: integer('needs_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    // Added by the board because the ticket's branch holds the other's unmerged commits (and dropped by
    // it when that stops holding), not declared by an agent or the human.
    auto: integer('auto', { mode: 'boolean' }).notNull().default(false),
    // The needed branch's tip the board saw inside this ticket's branch when it added or last
    // confirmed an automatic need.
    held: text('held').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.needsId] }), index('ticket_needs_needs').on(t.needsId)],
)

// An automatic need the human removed, with the needed branch's tip it held then: the board does not
// add it again for those commits, only for new work taken in later.
export const ticketNeedDismissals = sqliteTable(
  'ticket_need_dismissals',
  {
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    needsId: integer('needs_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    held: text('held').notNull().default(''),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.needsId] })],
)

// The repos a ticket's work spans, in order, each with its own branch, base and PR. The first is the
// primary: the ticket's own repoId, branch, baseBranch and prNumber always say the same as it does.
export const ticketRepos = sqliteTable(
  'ticket_repos',
  {
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    branch: text().notNull().default(''),
    baseBranch: text('base_branch').notNull().default('main'),
    prNumber: integer('pr_number'),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.repoId] }), index('ticket_repos_repo').on(t.repoId)],
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    // The task this one is a subtask of, on the same ticket and itself top-level (two levels only).
    parentId: integer('parent_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'cascade' }),
    text: text().notNull(),
    done: integer({ mode: 'boolean' }).notNull().default(false),
    position: integer().notNull().default(0),
    // Waiting on the human (a credential, a manual step, a call only they make), with what they must do.
    // Only an open task is blocked: ticking it done clears both.
    blocked: integer({ mode: 'boolean' }).notNull().default(false),
    blockedReason: text('blocked_reason').notNull().default(''),
    // When it was tagged blocked, kept while it stays blocked (a reworded reason does not move it); null when not blocked.
    blockedAt: text('blocked_at'),
  },
  (t) => [index('tasks_parent').on(t.parentId)],
)

export const workspaces = sqliteTable('workspaces', {
  id: id(),
  ticketId: integer('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  // The repo of the ticket its worktree is of; null is the ticket's primary repo.
  repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
  branch: text().notNull().default(''),
  path: text().notNull().default(''),
  agent: text().notNull().default(''),
  // Where the branch runs for the human to try (`http://localhost:<port>`); '' when nothing runs.
  previewUrl: text('preview_url').notNull().default(''),
  createdAt: now(),
})

// A post on a ticket: progress (`progress`, what agents report as they go) or discussion. Its replies
// are the comments whose parent is the post (parent_type 'update', the table's historical name).
export const updates = sqliteTable(
  'updates',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    author: text().notNull(),
    // The connected agent that posted it on `author`'s behalf when `author` is one of the project's agents.
    via: text().notNull().default(''),
    body: text().notNull(),
    progress: integer({ mode: 'boolean' }).notNull().default(true),
    // A decision the human is asked to make: the post's body is the question, these are the answers
    // to pick from. Null on any other post.
    decision: text({ mode: 'json' }).$type<DecisionOption[] | null>(),
    // The human's pick (an index into `decision`), who and when; null until decided.
    decidedOption: integer('decided_option'),
    decidedBy: text('decided_by').notNull().default(''),
    decidedAt: text('decided_at'),
    // Set when the orchestrator recorded the human's answer from the chat: the connected agent that relayed
    // it, and the words as the human gave them. Both '' on a decision the human made on the board.
    relayedBy: text('relayed_by').notNull().default(''),
    relayedText: text('relayed_text').notNull().default(''),
    // Who has the answer on this card already, so an edit of it starts no second agent: 'chat' (relayed to the
    // session that asked), 'waiter' (handed to an agent waiting on it) or 'resume' (a process the board
    // started was given it); '' until one did. A skipped start never sets it, and an edit never clears it.
    answerDelivered: text('answer_delivered')
      .$type<'' | 'chat' | 'waiter' | 'resume'>()
      .notNull()
      .default(''),
    // On a decision an agent posted to have tickets archived (features.requestArchive): the top-level tickets
    // it names. Answering its Archive option archives those still finished then. Null on any other post.
    archiveTickets: text('archive_tickets', { mode: 'json' }).$type<number[] | null>(),
    // On a decision an agent posted to have a repo added to the project (agents add repos at once now; an
    // older card still works): the repo its Add option creates, once checked again. Null on any other post.
    repoRequest: text('repo_request', { mode: 'json' }).$type<RepoRequest | null>(),
    // The tab of the ticket's feed it shows in (FEED_TABS): picked when it is posted, moved only on purpose.
    tab: text().$type<FeedTab>().notNull().default('main'),
    // A version of the ticket's summary: the newest is the summary, the older ones its history. Never a
    // progress post. `summaryChange` is what that version changed, in one line.
    summary: integer({ mode: 'boolean' }).notNull().default(false),
    summaryChange: text('summary_change').notNull().default(''),
    createdAt: now(),
    editedAt: text('edited_at'),
  },
  (t) => [check('updates_tab', sql`${t.tab} IN ('main', 'agents')`)],
)

export type DecisionOption = { label: string; detail?: string; recommended?: boolean }
/** What a repo request's Add creates: a repo of `projectId`, as the agent asked for it and the board checked. */
export type RepoRequest = {
  projectId: number
  name: string
  repoPath: string
  githubRepo: string
  baseBranch: string
}

export const comments = sqliteTable(
  'comments',
  {
    id: id(),
    parentType: text('parent_type').$type<CommentParent>().notNull(),
    parentId: integer('parent_id').notNull(),
    replyTo: integer('reply_to'),
    author: text().notNull(),
    via: text().notNull().default(''),
    body: text().notNull(),
    createdAt: now(),
    editedAt: text('edited_at'),
  },
  (t) => [index('comments_parent').on(t.parentType, t.parentId)],
)

// An attachment belongs to a post, a reply, a ticket's instructions or a report; unattached rows are
// uploads waiting to be referenced.
export const attachments = sqliteTable('attachments', {
  id: id(),
  updateId: integer('update_id').references(() => updates.id, { onDelete: 'cascade' }),
  commentId: integer('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  reportId: integer('report_id').references((): AnySQLiteColumn => reports.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  storedAs: text('stored_as').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: now(),
  // What was drawn on the picture before it was attached: the shapes and their notes, the file itself
  // being the flattened picture. Null when nothing was drawn on it (an agent's upload included).
  annotations: text({ mode: 'json' }).$type<AnnotationDoc>(),
})

export const reviewResults = sqliteTable(
  'review_results',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    prNumber: integer('pr_number').notNull(),
    sha: text().notNull(),
    verdict: text().notNull(),
    checks: text({ mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    counts: text({ mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    summaryMd: text('summary_md').notNull().default(''),
    author: text().notNull(),
    createdAt: now(),
  },
  (t) => [index('review_results_pr').on(t.projectId, t.prNumber)],
)

// One run report: how one execution of a subagent went — its identity, its measured or self-reported
// time, the steps of its instructions it did and skipped, its ratings, and named prose sections
// (src/server/runReports.ts). One row per run: a ticket with three rounds has three hunt reports, each
// with its round. Numbers are columns (json where they come in groups) instead of prose, so a run's
// agent, round, duration and counts can be listed and added up without parsing text.
export const runReports = sqliteTable(
  'run_reports',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    // The kind of run: spec, builder, runner, env, verify, hunt, refute, merge, or a project agent's name.
    agent: text().notNull(),
    round: integer(),
    branch: text().notNull().default(''),
    headSha: text('head_sha').notNull().default(''),
    model: text().notNull().default(''),
    effort: text().notNull().default(''),
    briefedBy: text('briefed_by').notNull().default(''),
    // When the run started and ended (the measured span's when one covers it), or null when unknown.
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    // The duration read back: the work timeline's span when one covers the run, else the agent's estimate.
    durationMs: integer('duration_ms').notNull().default(0),
    durationSource: text('duration_source').$type<RunReportDurationSource>().notNull().default('self'),
    // The agent's own estimate, kept beside a measured duration so its account stands.
    reportedDurationMs: integer('reported_duration_ms'),
    // Where the time went: readingMs, runningMs, waitingMs, writingMs, otherMs.
    time: text({ mode: 'json' })
      .$type<RunReportTime>()
      .notNull()
      .default(sql`'{}'`),
    // The agent's own ratings, 1 (easy, no confidence) to 5 (hard, full confidence); null when unrated.
    difficulty: integer(),
    confidence: integer(),
    // One entry per step of its instructions: {name, done, note}.
    steps: text({ mode: 'json' })
      .$type<RunReportStep[]>()
      .notNull()
      .default(sql`'[]'`),
    counts: text({ mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    // The prose, one named field per section (RUN_REPORT_SECTIONS, then the agent's own).
    sections: text({ mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    author: text().notNull(),
    createdAt: now(),
  },
  (t) => [
    index('run_reports_project_agent').on(t.projectId, t.agent, t.createdAt),
    index('run_reports_ticket').on(t.ticketId, t.agent),
  ],
)

// One row per write anyone makes; the Daily module groups these by hour.
export const activity = sqliteTable(
  'activity',
  {
    id: id(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    actor: text().notNull(),
    kind: text().notNull(),
    refType: text('ref_type').notNull().default(''),
    refId: integer('ref_id'),
    text: text().notNull(),
    createdAt: now(),
  },
  (t) => [index('activity_created').on(t.createdAt)],
)

// What a project's report must say and how (the prompt, markdown), the shape it takes (the template),
// and when one is due: at the end of the project's shift. The human edits it on the Daily page; agents
// read it, and may change it, through the API (a prompt or template change stays flagged for the human).
export const reportSettings = sqliteTable('report_settings', {
  projectId: integer('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prompt: text().notNull().default(''),
  // The markdown skeleton a generated report must fill (its headings, in order); '' is the default one.
  template: text().notNull().default(''),
  cadence: text().$type<ReportCadence>().notNull().default('off'),
  // The day a weekly report is due, 1 (Monday) to 7 (Sunday).
  weekday: integer().notNull().default(5),
  // The project's working hours, local `HH:MM`; the report is due at the shift's end.
  shiftStart: text('shift_start').notNull().default('09:00'),
  shiftEnd: text('shift_end').notNull().default('17:00'),
  // The days a daily report is asked for, ISO weekdays 1 (Monday) to 7 (Sunday).
  workdays: text({ mode: 'json' })
    .$type<number[]>()
    .notNull()
    .default(sql`'[1,2,3,4,5]'`),
  // How long before the shift's end the board starts reminding that the report is due.
  alertMinutes: integer('alert_minutes').notNull().default(30),
  format: text().$type<ReportFormat>().notNull().default('text'),
  // The first period tracked (YYYY-MM-DD), set when the cadence changes: earlier periods without a
  // report are not counted as missing.
  since: text().notNull().default(''),
  updatedBy: text('updated_by').notNull().default(''),
  updatedAt: now(),
})

// Every change of a project's report prompt or template, with the value before it, so any can be
// undone. An agent's change is pending until the human accepts or reverts it.
export const reportSettingsChanges = sqliteTable(
  'report_settings_changes',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    field: text().$type<'prompt' | 'template'>().notNull(),
    oldValue: text('old_value').notNull().default(''),
    newValue: text('new_value').notNull().default(''),
    changedBy: text('changed_by').notNull(),
    byAgent: integer('by_agent', { mode: 'boolean' }).notNull().default(false),
    state: text().$type<'accepted' | 'pending' | 'reverted'>().notNull().default('accepted'),
    resolvedBy: text('resolved_by').notNull().default(''),
    resolvedAt: text('resolved_at'),
    // The change a revert undid, on the change the revert records; null on any other change.
    revertOf: integer('revert_of'),
    createdAt: now(),
  },
  (t) => [index('report_settings_changes_project').on(t.projectId, t.createdAt)],
)

// The history of a project's instructions: every change with the text before and after it, who made it
// (the full name, a sub-identity's included) and their role. The human's own change is accepted at once;
// an orchestrator's applies at once too but stays pending until the human marks it reviewed or reverts
// it. A revert is itself a change, pointing at the one it undid.
export const projectInstructionChanges = sqliteTable(
  'project_instruction_changes',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    oldValue: text('old_value').notNull().default(''),
    newValue: text('new_value').notNull().default(''),
    changedBy: text('changed_by').notNull(),
    role: text().$type<'human' | 'orchestrator'>().notNull(),
    state: text().$type<'accepted' | 'pending' | 'reverted'>().notNull().default('accepted'),
    resolvedBy: text('resolved_by').notNull().default(''),
    resolvedAt: text('resolved_at'),
    // The change a revert undid, on the change the revert records; null on any other change.
    revertOf: integer('revert_of'),
    createdAt: now(),
  },
  (t) => [index('project_instruction_changes_project').on(t.projectId, t.createdAt)],
)

// A report for one period of a project: the day (YYYY-MM-DD) or, for a weekly cadence, the Monday of the
// week. Posting again for the same period adds a newer version; the latest is the report.
export const reports = sqliteTable(
  'reports',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cadence: text().$type<Exclude<ReportCadence, 'off'>>().notNull(),
    period: text().notNull(),
    body: text().notNull().default(''),
    author: text().notNull(),
    createdAt: now(),
  },
  (t) => [index('reports_project_period').on(t.projectId, t.period)],
)

// One resume: the board continuing a ticket's work by running the project's resume command (see
// src/server/resume.ts). A skipped row is the board saying why it did not start one.
export const ticketResumes = sqliteTable(
  'ticket_resumes',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    // The decision card whose answer set it off; null for a stage move or a retry of one.
    postId: integer('post_id').references(() => updates.id, { onDelete: 'set null' }),
    // What set it off: the human's answer, the human's stage move, or the Resume / Retry button.
    trigger: text().$type<'answer' | 'move' | 'retry'>().notNull(),
    state: text().$type<'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'>().notNull(),
    // The process, while it runs and after (the board that restarted looks it up by this).
    pid: integer(),
    // The process's start time as the OS reports it, to tell it from a later process that got the same pid
    // (null where the OS gives none).
    pidIdentity: text('pid_identity'),
    // The command's name as shown (its first word); the command itself is the project's setting.
    command: text().notNull().default(''),
    exitCode: integer('exit_code'),
    // Why it was skipped or failed, or what is unknown about how it ended.
    reason: text().notNull().default(''),
    // Where its output goes, under the board's logs folder.
    logPath: text('log_path').notNull().default(''),
    createdAt: now(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (t) => [
    index('ticket_resumes_ticket').on(t.ticketId),
    check('ticket_resumes_state', sql`${t.state} IN ('queued', 'running', 'succeeded', 'failed', 'skipped')`),
  ],
)
export type TicketResume = typeof ticketResumes.$inferSelect

// A card an agent opened for the human's notification center (src/server/agentCards.ts): a tracked
// request the human asked to watch, or an important notice. It is not a board job: it survives a
// restart and stays until the human dismisses it.
export const agentCards = sqliteTable(
  'agent_cards',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text().$type<'tracked' | 'notice'>().notNull(),
    // Who opened it: the agent's name, a sub-identity's included.
    actor: text().notNull(),
    title: text().notNull(),
    // The human's own request, on a tracked card ('' on a notice).
    request: text().notNull().default(''),
    // A notice's body: what happened and what the human should do ('' on a tracked card).
    body: text().notNull().default(''),
    // A notice's reason it cannot wait, or a tracked card's failure reason ('' until one is given).
    reason: text().notNull().default(''),
    total: integer().notNull().default(0),
    done: integer().notNull().default(0),
    // A tracked card's state; a notice has no progress, so it reads notice.
    state: text().$type<'running' | 'succeeded' | 'failed' | 'notice'>().notNull().default('running'),
    // The item being worked on now, on a running tracked card.
    step: text(),
    // A tracked card's one-line success result.
    result: text(),
    // Where the result lives: a board path or an absolute http(s) URL.
    href: text(),
    startedAt: now(),
    updatedAt: now(),
    finishedAt: text(),
  },
  (t) => [
    index('agent_cards_project').on(t.projectId),
    check('agent_cards_kind', sql`${t.kind} IN ('tracked', 'notice')`),
    check('agent_cards_state', sql`${t.state} IN ('running', 'succeeded', 'failed', 'notice')`),
  ],
)

// An alert the board raised for the human (src/server/alerts): one row per (project, type, subject), kept
// while its condition holds. A null project is board-wide and shows in every project. The evaluator
// inserts, updates and resolves rows; the human sees, snoozes and dismisses them.
export const alerts = sqliteTable(
  'alerts',
  {
    id: id(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    // What the alert is about inside its type ('' when the type raises at most one).
    subject: text().notNull().default(''),
    severity: text().$type<'info' | 'warning' | 'problem'>().notNull(),
    title: text().notNull(),
    body: text().notNull().default(''),
    // JSON text: the details lines and whatever the type keeps with the row.
    data: text().notNull().default('{}'),
    // JSON text: the buttons the card shows.
    buttons: text().notNull().default('[]'),
    createdAt: now(),
    updatedAt: now(),
    seenAt: text(),
    dismissedAt: text(),
    snoozedUntil: text(),
    // Set when the condition ended; the row is hidden until it comes back.
    resolvedAt: text(),
  },
  (t) => [
    // SQLite treats nulls as distinct in a unique index: a board-wide alert has an index of its own.
    uniqueIndex('alerts_project_type_subject')
      .on(t.projectId, t.type, t.subject)
      .where(sql`${t.projectId} IS NOT NULL`),
    uniqueIndex('alerts_board_type_subject')
      .on(t.type, t.subject)
      .where(sql`${t.projectId} IS NULL`),
    index('alerts_project').on(t.projectId),
    check('alerts_severity', sql`${t.severity} IN ('info', 'warning', 'problem')`),
  ],
)

// A project's muted alert types: the evaluator still runs them, the feed hides them.
export const alertMutes = sqliteTable(
  'alert_mutes',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.type] })],
)

// Origin's branches of a repo as the board last saw them, and each move it saw since (a branch that
// appeared, moved or went away): what reached origin on a given day.
export const originRefs = sqliteTable(
  'origin_refs',
  {
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    // The branch's name on origin, e.g. `main`.
    ref: text().notNull(),
    sha: text().notNull(),
    seenAt: now(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.ref] })],
)

export const originRefMoves = sqliteTable(
  'origin_ref_moves',
  {
    id: id(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    ref: text().notNull(),
    // Null: the branch appeared.
    oldSha: text('old_sha'),
    // Null: the branch went away.
    newSha: text('new_sha'),
    seenAt: now(),
  },
  (t) => [index('origin_ref_moves_repo_seen').on(t.repoId, t.seenAt)],
)

// The repos the board has looked at origin's branches of, since when: a look that found none counts,
// so the first branch pushed after it is a move, not the starting point.
export const originLooks = sqliteTable('origin_looks', {
  repoId: integer('repo_id')
    .primaryKey()
    .references(() => repos.id, { onDelete: 'cascade' }),
  seenAt: now(),
})

// Board-wide preferences the human sets in Settings, one row per key (the value is JSON).
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text({ mode: 'json' }).notNull(),
})

// Who each name on the board is, learned from how it signs in: an agent token is an agent, a passkey
// session in the browser is a human. Every author field elsewhere is just the name. An agent's role is
// the one it was last seen with (its token's, or worker for a sub-identity `<token>/<name>`, whose
// parent is the name before the last `/`); a human's role reads as human whatever the column says.
export const actors = sqliteTable('actors', {
  name: text().primaryKey(),
  kind: text().$type<'agent' | 'human'>().notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  role: text().$type<'orchestrator' | 'worker'>().notNull().default('worker'),
  parent: text().notNull().default(''),
})

// --- signing in (src/server/passkeys.ts, credentials.ts; README: "Signing in") ---

// The human who signs in to the board: one row, created by /setup on this machine at first boot.
// userHandle is the WebAuthn user id every passkey of the account is registered under.
export const account = sqliteTable(
  'account',
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    userHandle: text('user_handle').notNull(),
    createdAt: now(),
  },
  (t) => [check('account_one_row', sql`${t.id} = 1`)],
)

// The account's passkeys. A passkey is bound to the RP ID it was made on: localhost on this machine,
// the tailnet name through the entrance; it signs in there and nowhere else. The public key is the
// COSE key, base64url.
export const passkeys = sqliteTable('passkeys', {
  id: id(),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer().notNull().default(0),
  transports: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
  rpId: text('rp_id').notNull(),
  name: text().notNull(),
  createdAt: now(),
  lastUsedAt: text('last_used_at'),
})

// A browser signed in with a passkey: only the hash of its cookie is kept. Revoking the passkey ends it.
export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    passkeyId: integer('passkey_id')
      .notNull()
      .references(() => passkeys.id, { onDelete: 'cascade' }),
    createdAt: now(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (t) => [index('sessions_passkey').on(t.passkeyId)],
)

// One-time links the signed-in human makes to enrol another device's passkey: hashed, short-lived,
// used once.
export const enrolCodes = sqliteTable('enrol_codes', {
  id: id(),
  codeHash: text('code_hash').notNull().unique(),
  createdAt: now(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
})

// The short-lived credentials an install line carries (skillTokens.ts): only the hash is kept, and they
// reach the two skill downloads and nothing else (credentials.ts, auth.ts `admit`). Expired rows are
// deleted when the next one is made.
export const skillTokens = sqliteTable('skill_tokens', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: now(),
  expiresAt: text('expires_at').notNull(),
})

// The tokens agents sign in with (`Authorization: Bearer <token>`): only the hash is kept, and the
// name is the agent's name on the board. The role is the human's call (Settings > Agents): an
// orchestrator also changes the projects' instructions; every token starts as a worker.
export const agentTokens = sqliteTable('agent_tokens', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  name: text().notNull(),
  createdAt: now(),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  role: text().$type<'orchestrator' | 'worker'>().notNull().default('worker'),
})

export type Activity = typeof activity.$inferSelect
export type Project = typeof projects.$inferSelect
export type Agent = typeof agents.$inferSelect
export type ProjectNote = typeof projectNotes.$inferSelect
export type Stage = typeof stages.$inferSelect
export type Repo = typeof repos.$inferSelect
export type RunConfig = typeof runConfigs.$inferSelect
export type TicketRepo = typeof ticketRepos.$inferSelect
export type Pr = typeof prs.$inferSelect
export type Ticket = typeof tickets.$inferSelect
export type TicketEvent = typeof ticketEvents.$inferSelect
export type TicketSendBack = typeof ticketSendBacks.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type Update = typeof updates.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type Comment = typeof comments.$inferSelect
export type ReviewResult = typeof reviewResults.$inferSelect
export type RunReportRecord = typeof runReports.$inferSelect
export type ReportSettings = typeof reportSettings.$inferSelect
export type Report = typeof reports.$inferSelect
export type AgentCardRow = typeof agentCards.$inferSelect
export type AlertRow = typeof alerts.$inferSelect
export type AlertMute = typeof alertMutes.$inferSelect
export type ReportSettingsChange = typeof reportSettingsChanges.$inferSelect
export type ProjectInstructionChange = typeof projectInstructionChanges.$inferSelect
export type OriginRef = typeof originRefs.$inferSelect
export type OriginRefMove = typeof originRefMoves.$inferSelect
export type Passkey = typeof passkeys.$inferSelect
export type Session = typeof sessions.$inferSelect
export type AgentToken = typeof agentTokens.$inferSelect
