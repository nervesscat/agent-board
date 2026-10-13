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
 * The query key of one of a project's ticket lists, with `q` of a search in it. Without a scope it is
 * the prefix of them all, so invalidating `ticketsKey(id)` refreshes every list of the project, and a
 * list's key is the prefix of its searches.
 */
export function ticketsKey(projectId: string | number): readonly ['tickets', string]
export function ticketsKey(
  projectId: string | number,
  scope: TicketsScope,
): readonly ['tickets', string, TicketsScope]
export function ticketsKey(
  projectId: string | number,
  scope: TicketsScope,
  q: string,
): readonly ['tickets', string, TicketsScope, string]
export function ticketsKey(projectId: string | number, scope?: TicketsScope, q?: string) {
  if (!scope) return ['tickets', String(projectId)] as const
  return q
    ? (['tickets', String(projectId), scope, q] as const)
    : (['tickets', String(projectId), scope] as const)
}

/** The list's URL; with `q`, the tickets the server finds it in, those found by name first. */
export function ticketsUrl(projectId: string | number, scope: TicketsScope, q = '') {
  const url = `/api/projects/${projectId}/tickets${SCOPES[scope]}`
  return q ? `${url}${SCOPES[scope] ? '&' : '?'}q=${encodeURIComponent(q)}` : url
}

/**
 * Key and fetch of one ticket list together, so they cannot drift apart. Spread it into `useQuery`.
 * A non-empty `q` searches the list (`searchTickets` on the server).
 */
export const ticketsQuery = (projectId: string | number, scope: TicketsScope, q = '') => ({
  queryKey: q ? ticketsKey(projectId, scope, q) : ticketsKey(projectId, scope),
  queryFn: () => get<TicketRow[]>(ticketsUrl(projectId, scope, q)),
})

/** A search's rows in the order to show them: found by name, then found in the content. */
export const nameFirst = (t: Pick<TicketRow, 'match'>) =>
  t.match === 'body' || t.match === 'post' || t.match === 'reply' ? 1 : 0
