// Shared by the schema, the API validators and the UI; kept dependency-free so the client bundle stays small.

/**
 * What a stage means to the board's rules, whatever the project calls it: `open` waits to be picked up
 * (claiming moves it to the first `active` stage), `blocked` waits on the human, `review` is handed off,
 * `done` and `cancelled` are closed (a cancelled lane's tasks leave the rolled-up progress, and
 * disapproving moves a ticket to the first `cancelled` stage).
 */
export const STAGE_KINDS = ['open', 'active', 'blocked', 'review', 'done', 'cancelled'] as const
export type StageKind = (typeof STAGE_KINDS)[number]

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

/** The agent CLIs the Connect agents page has setup for; the first is the default until one is picked. */
export const AGENT_CLIENTS = ['claude', 'codex', 'opencode'] as const
export type AgentClient = (typeof AGENT_CLIENTS)[number]

export const COMMENT_PARENTS = ['ticket', 'update', 'pr', 'review'] as const
export type CommentParent = (typeof COMMENT_PARENTS)[number]
