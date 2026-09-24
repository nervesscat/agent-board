import { sql } from 'drizzle-orm'
import { type AnySQLiteColumn, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { COMMENT_PARENTS, TICKET_STATUSES, type CommentParent, type TicketStatus } from '#/lib/constants'

export { COMMENT_PARENTS, TICKET_STATUSES, type CommentParent, type TicketStatus }

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
})

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
    myReview: text('my_review').notNull().default('none'),
    updatedAt: text('updated_at').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    open: integer({ mode: 'boolean' }).notNull().default(true),
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
    status: text().$type<TicketStatus>().notNull().default('todo'),
    assignee: text().notNull().default(''),
    branch: text().notNull().default(''),
    baseBranch: text('base_branch').notNull().default('main'),
    createdBy: text('created_by').notNull(),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [index('tickets_parent').on(t.parentId)],
)

export const tasks = sqliteTable('tasks', {
  id: id(),
  ticketId: integer('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  text: text().notNull(),
  done: integer({ mode: 'boolean' }).notNull().default(false),
  position: integer().notNull().default(0),
})

export const workspaces = sqliteTable('workspaces', {
  id: id(),
  ticketId: integer('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  branch: text().notNull().default(''),
  path: text().notNull().default(''),
  agent: text().notNull().default(''),
  createdAt: now(),
})

export const updates = sqliteTable('updates', {
  id: id(),
  ticketId: integer('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  author: text().notNull(),
  body: text().notNull(),
  createdAt: now(),
})

export const comments = sqliteTable(
  'comments',
  {
    id: id(),
    parentType: text('parent_type').$type<CommentParent>().notNull(),
    parentId: integer('parent_id').notNull(),
    replyTo: integer('reply_to'),
    author: text().notNull(),
    body: text().notNull(),
    createdAt: now(),
  },
  (t) => [index('comments_parent').on(t.parentType, t.parentId)],
)

// An attachment belongs to an update or a comment; unattached rows are uploads waiting to be referenced.
export const attachments = sqliteTable('attachments', {
  id: id(),
  updateId: integer('update_id').references(() => updates.id, { onDelete: 'cascade' }),
  commentId: integer('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  storedAs: text('stored_as').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: now(),
})

export const reviewSchedules = sqliteTable('review_schedules', {
  id: id(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  time: text().notNull(),
  // Bit i set = runs on weekday i (0 = Sunday). Default: Monday to Friday.
  days: integer().notNull().default(0b0111110),
  args: text().notNull().default('mine'),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  lastRunAt: text('last_run_at'),
})

export const reviewRuns = sqliteTable('review_runs', {
  id: id(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  scheduleId: integer('schedule_id'),
  args: text().notNull(),
  startedBy: text('started_by').notNull(),
  startedAt: now(),
  finishedAt: text('finished_at'),
  status: text().$type<'running' | 'done' | 'error' | 'cancelled'>().notNull().default('running'),
  exitCode: integer('exit_code'),
  queueDir: text('queue_dir'),
  log: text().notNull().default(''),
})

export const reviewResults = sqliteTable(
  'review_results',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: integer('run_id').references(() => reviewRuns.id, { onDelete: 'set null' }),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    prNumber: integer('pr_number').notNull(),
    sha: text().notNull(),
    verdict: text().notNull(),
    checks: text({ mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    counts: text({ mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    summaryMd: text('summary_md').notNull().default(''),
    reviewPath: text('review_path').notNull().default(''),
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

// The highest-level line for a day: what got done, in a sentence or three.
export const dailySummaries = sqliteTable(
  'daily_summaries',
  {
    id: id(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    date: text().notNull(),
    author: text().notNull(),
    body: text().notNull(),
    createdAt: now(),
  },
  (t) => [index('daily_summaries_date').on(t.date)],
)

// Who each name on the board is, learned from how it signs in: a gate token is an agent, a passkey
// session in the browser is a human. Every author field elsewhere is just the name.
export const actors = sqliteTable('actors', {
  name: text().primaryKey(),
  kind: text().$type<'agent' | 'human'>().notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
})

export type Activity = typeof activity.$inferSelect
export type DailySummary = typeof dailySummaries.$inferSelect
export type Project = typeof projects.$inferSelect
export type Repo = typeof repos.$inferSelect
export type Pr = typeof prs.$inferSelect
export type Ticket = typeof tickets.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type Update = typeof updates.$inferSelect
export type Attachment = typeof attachments.$inferSelect
export type Comment = typeof comments.$inferSelect
export type ReviewSchedule = typeof reviewSchedules.$inferSelect
export type ReviewRun = typeof reviewRuns.$inferSelect
export type ReviewResult = typeof reviewResults.$inferSelect
