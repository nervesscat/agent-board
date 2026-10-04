import { get, type TicketRow } from '#/lib/api'

/**
 * A project's ticket lists. Each fetches different tickets, so each has its own query key: under a
 * shared key, whichever page loaded first would fill the cache with its list for the others.
 */
const SCOPES = {
  /** Top-level tickets, archived ones left out: the features board and the stage navigation. */
  root: '?parent=root',
  /** Top-level archived tickets: the features page's Archived tab. */
  archived: '?parent=root&archived=only',
  /** Every ticket not archived, lanes included: the Agents page's reservations. */
  all: '',
} as const

export type TicketsScope = keyof typeof SCOPES

/**
 * The query key of one of a project's ticket lists. Without a scope it is the prefix of them all, so
 * invalidating `ticketsKey(id)` refreshes every list of the project.
 */
export function ticketsKey(projectId: string | number): readonly ['tickets', string]
export function ticketsKey(
  projectId: string | number,
  scope: TicketsScope,
): readonly ['tickets', string, TicketsScope]
export function ticketsKey(projectId: string | number, scope?: TicketsScope) {
  return scope ? (['tickets', String(projectId), scope] as const) : (['tickets', String(projectId)] as const)
}

export const ticketsUrl = (projectId: string | number, scope: TicketsScope) =>
  `/api/projects/${projectId}/tickets${SCOPES[scope]}`

/** Key and fetch of one ticket list together, so they cannot drift apart. Spread it into `useQuery`. */
export const ticketsQuery = (projectId: string | number, scope: TicketsScope) => ({
  queryKey: ticketsKey(projectId, scope),
  queryFn: () => get<TicketRow[]>(ticketsUrl(projectId, scope)),
})
