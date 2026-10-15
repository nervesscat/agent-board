// Shared by the schema, the API validators and the UI; kept dependency-free so the client bundle stays small.

/**
 * What a stage means to the board's rules, whatever the project calls it: `open` waits to be picked up
 * (claiming moves it to the first `active` stage), `blocked` waits on the human, `review` is handed off,
 * `done` and `cancelled` are closed (a cancelled lane's tasks leave the rolled-up progress, and
 * disapproving moves a ticket to the first `cancelled` stage).
 */
export const STAGE_KINDS = ['open', 'active', 'blocked', 'review', 'done', 'cancelled'] as const
export type StageKind = (typeof STAGE_KINDS)[number]

/**
 * How much review a ticket gets: `low` none (the builder verifies itself), `mid` one review round,
 * `high` three. Chosen by the human when the ticket is created, and changeable after.
 */
export const COMPLEXITIES = ['low', 'mid', 'high'] as const
export type Complexity = (typeof COMPLEXITIES)[number]
/** The level of a ticket created without one, and of every ticket stored before levels existed. */
export const DEFAULT_COMPLEXITY: Complexity = 'mid'

export const STAGE_COLORS = [
  'gray',
  'slate',
  'sky',
  'blue',
  'teal',
  'emerald',
  'lime',
  'amber',
  'orange',
  'rose',
  'pink',
  'violet',
] as const
export type StageColor = (typeof STAGE_COLORS)[number]

/** The stages every project starts with; their keys are what tickets stored before stages were editable. */
export const DEFAULT_STAGES: { key: string; name: string; kind: StageKind; color: StageColor }[] = [
  { key: 'backlog', name: 'Backlog', kind: 'open', color: 'slate' },
  { key: 'todo', name: 'To do', kind: 'open', color: 'gray' },
  { key: 'in_progress', name: 'In progress', kind: 'active', color: 'sky' },
  { key: 'blocked', name: 'Blocked', kind: 'blocked', color: 'amber' },
  { key: 'review', name: 'In review', kind: 'review', color: 'violet' },
  { key: 'done', name: 'Done', kind: 'done', color: 'emerald' },
  { key: 'cancelled', name: 'Cancelled', kind: 'cancelled', color: 'slate' },
]

/**
 * How many previews the board builds or runs at once, board-wide: the human's setting (`previewLimit`),
 * within these. Each is a whole board with its own copy of the data, on a port from 47101 to 47199.
 */
export const PREVIEW_LIMIT = { default: 8, min: 1, max: 32 } as const

/** A stored preview limit, or the default for anything that is not a whole number within the range. */
export const readPreviewLimit = (value: unknown): number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= PREVIEW_LIMIT.min &&
  value <= PREVIEW_LIMIT.max
    ? value
    : PREVIEW_LIMIT.default

/** The agent CLIs the Connect agents page has setup for; the first is the default until one is picked. */
export const AGENT_CLIENTS = ['claude', 'codex', 'opencode'] as const
export type AgentClient = (typeof AGENT_CLIENTS)[number]

/**
 * Which copy of the review skills the Agents pages track: the user-wide `~/.claude` on the board's
 * machine (the first, the default until one is picked), or each repo's own `.claude`.
 */
export const SKILLS_TRACKING = ['global', 'repo'] as const
export type SkillsTracking = (typeof SKILLS_TRACKING)[number]

/**
 * The default agents (the build and review cycle of the feature-review, review-queue and todo-review skills), in
 * the order the cycle uses them. Their texts live on the server (defaultAgents.ts).
 */
export const DEFAULT_AGENT_NAMES = [
  'spec',
  'builder',
  'runner',
  'env',
  'verify',
  'hunt',
  'refute',
  'merge',
] as const

export const COMMENT_PARENTS = ['ticket', 'update', 'pr', 'review'] as const
export type CommentParent = (typeof COMMENT_PARENTS)[number]

/** One CI check on a PR's head commit, sorted into the buckets `gh pr checks` uses. */
export type PrCheck = { name: string; state: 'pass' | 'fail' | 'pending' | 'skipped'; url: string | null }

/**
 * Where we left off: each ticket has one current resume note, written at the end of a session for
 * whoever picks the ticket up next (another agent, the same one tomorrow, the human). This is how it
 * reads: the editor starts from it and the MCP tool describes it.
 */
export const RESUME_TEMPLATE = [
  '**State:** (one line)',
  '',
  '**Done so far:**',
  '',
  '- …',
  '',
  '**Next steps:**',
  '',
  '1. …',
  '',
  '**Open questions / blockers:**',
  '',
  '- …',
  '',
  '**How to resume:** branch, worktree, commands, preview, gotchas',
].join('\n')

/** How often a project's report is due: never tracked, every day, or once a week on a set weekday. */
export const REPORT_CADENCES = ['off', 'daily', 'weekly'] as const
export type ReportCadence = (typeof REPORT_CADENCES)[number]
/** What a report is: written on the board, or a file an agent attaches (a PDF, say). */
export const REPORT_FORMATS = ['text', 'file'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]
