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
  type FeedTab,
} from '#/lib/constants'
import type { SavedLayout } from '#/lib/layout'
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
    avatarId: integer('avatar_id').references((): AnySQLiteColumn => attachments.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by').notNull(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [uniqueIndex('agents_project_name').on(t.projectId, t.name)],
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
    // The opposite call: the human rejected it, which also cancels it. At most one of the two is set.
    disapprovedAt: text('disapproved_at'),
    disapprovedBy: text('disapproved_by').notNull().default(''),
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
    at: now(),
  },
  (t) => [
    index('ticket_events_ticket_at').on(t.ticketId, t.at),
    index('ticket_events_project_at').on(t.projectId, t.at),
    check('ticket_events_kind', sql.raw(`kind IN (${EVENT_KINDS.map((k) => `'${k}'`).join(', ')})`)),
    check('ticket_events_reason', sql.raw(`reason IN ('', ${WAIT_REASONS.map((k) => `'${k}'`).join(', ')})`)),
  ],
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
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.needsId] }), index('ticket_needs_needs').on(t.needsId)],
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
    // On a decision an agent posted to have tickets archived (features.requestArchive): the top-level tickets
    // it names. Answering its Archive option archives those still finished then. Null on any other post.
    archiveTickets: text('archive_tickets', { mode: 'json' }).$type<number[] | null>(),
    // On a decision an agent posted to have a repo added to the project (features.requestRepo): the repo its
    // Add option creates, once checked again. Null on any other post.
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
export type Stage = typeof stages.$inferSelect
export type Repo = typeof repos.$inferSelect
export type RunConfig = typeof runConfigs.$inferSelect
export type TicketRepo = typeof ticketRepos.$inferSelect
export type Pr = typeof prs.$inferSelect
export type Ticket = typeof tickets.$inferSelect
export type TicketEvent = typeof ticketEvents.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type Update = typeof updates.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type Comment = typeof comments.$inferSelect
export type ReviewResult = typeof reviewResults.$inferSelect
export type ReportSettings = typeof reportSettings.$inferSelect
export type Report = typeof reports.$inferSelect
export type ReportSettingsChange = typeof reportSettingsChanges.$inferSelect
export type ProjectInstructionChange = typeof projectInstructionChanges.$inferSelect
export type OriginRef = typeof originRefs.$inferSelect
export type OriginRefMove = typeof originRefMoves.$inferSelect
export type Passkey = typeof passkeys.$inferSelect
export type Session = typeof sessions.$inferSelect
export type AgentToken = typeof agentTokens.$inferSelect
