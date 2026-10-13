import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import {
  COMMENT_PARENTS,
  STAGE_KINDS,
  type CommentParent,
  type PrCheck,
  type ReportCadence,
  type ReportFormat,
  type StageColor,
  type StageKind,
} from '#/lib/constants'

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
  createdAt: now(),
})

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
    assignee: text().notNull().default(''),
    branch: text().notNull().default(''),
    baseBranch: text('base_branch').notNull().default('main'),
    // The PR the ticket's branch was opened as, in the ticket's repo; null until there is one.
    prNumber: integer('pr_number'),
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
    // Where we left off: the one current resume note (markdown), who wrote it and when, and the ticket
    // branch's head at that moment (null when the branch was not there locally). Each save is also a
    // handoff post in the feed, so the older notes stay readable.
    resumeNote: text('resume_note').notNull().default(''),
    resumeAt: text('resume_at'),
    resumeBy: text('resume_by').notNull().default(''),
    resumeSha: text('resume_sha'),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [index('tickets_parent').on(t.parentId)],
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
  },
  (t) => [index('tasks_parent').on(t.parentId)],
)

export const workspaces = sqliteTable('workspaces', {
  id: id(),
  ticketId: integer('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  branch: text().notNull().default(''),
  path: text().notNull().default(''),
  agent: text().notNull().default(''),
  // Where the branch runs for the human to try (`http://localhost:<port>`); '' when nothing runs.
  previewUrl: text('preview_url').notNull().default(''),
  createdAt: now(),
})

// A post on a ticket: progress (`progress`, what agents report as they go) or discussion. Its replies
// are the comments whose parent is the post (parent_type 'update', the table's historical name).
export const updates = sqliteTable('updates', {
  id: id(),
  ticketId: integer('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  author: text().notNull(),
  // The connected agent that posted it on `author`'s behalf when `author` is one of the project's agents.
  via: text().notNull().default(''),
  body: text().notNull(),
  progress: integer({ mode: 'boolean' }).notNull().default(true),
  // A resume note as it was saved (see tickets.resumeNote): the ticket's handoffs, oldest to newest.
  handoff: integer({ mode: 'boolean' }).notNull().default(false),
  // A decision the human is asked to make: the post's body is the question, these are the answers
  // to pick from. Null on any other post.
  decision: text({ mode: 'json' }).$type<DecisionOption[] | null>(),
  // The human's pick (an index into `decision`), who and when; null until decided.
  decidedOption: integer('decided_option'),
  decidedBy: text('decided_by').notNull().default(''),
  decidedAt: text('decided_at'),
  createdAt: now(),
  editedAt: text('edited_at'),
})

export type DecisionOption = { label: string; detail?: string; recommended?: boolean }

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

// Who each name on the board is, learned from how it signs in: a gate token is an agent, a passkey
// session in the browser is a human. Every author field elsewhere is just the name.
export const actors = sqliteTable('actors', {
  name: text().primaryKey(),
  kind: text().$type<'agent' | 'human'>().notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
})

export type Activity = typeof activity.$inferSelect
export type Project = typeof projects.$inferSelect
export type Agent = typeof agents.$inferSelect
export type Stage = typeof stages.$inferSelect
export type Repo = typeof repos.$inferSelect
export type Pr = typeof prs.$inferSelect
export type Ticket = typeof tickets.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type Update = typeof updates.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type Comment = typeof comments.$inferSelect
export type ReviewResult = typeof reviewResults.$inferSelect
export type ReportSettings = typeof reportSettings.$inferSelect
export type Report = typeof reports.$inferSelect
export type ReportSettingsChange = typeof reportSettingsChanges.$inferSelect
export type OriginRef = typeof originRefs.$inferSelect
export type OriginRefMove = typeof originRefMoves.$inferSelect
