// Shared by the schema, the API validators and the UI; kept dependency-free so the client bundle stays small.
export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const COMMENT_PARENTS = ['ticket', 'update', 'pr', 'review'] as const
export type CommentParent = (typeof COMMENT_PARENTS)[number]
