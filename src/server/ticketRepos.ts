import { and, asc, eq, inArray, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError } from './http'
import { listRepos, ticketRepo } from './repos'

/**
 * The repos a ticket's work spans, each with its own branch, base and PR. The first is the primary:
 * the ticket's own repoId, branch, baseBranch and prNumber, which every older read and write still
 * uses. The rest live in `ticket_repos` (the primary has its row there too, kept in step).
 */

export interface TicketRepoEntry {
  repoId: number
  name: string
  branch: string
  baseBranch: string
  prNumber: number | null
  primary: boolean
}

/** What a write gives for one repo of the ticket: what it leaves out stays as it was. */
export interface TicketRepoInput {
  repoId: number
  branch?: string
  baseBranch?: string
  prNumber?: number | null
}

type TicketFields = Pick<schema.Ticket, 'id' | 'projectId' | 'repoId' | 'branch' | 'baseBranch' | 'prNumber'>

/**
 * The ticket's repos in order: the primary (from the ticket's own fields, its repo or the project's
 * first), then the others it names, each still a repo of its project.
 */
export function ticketRepoList(ticket: TicketFields): TicketRepoEntry[] {
  const primary = ticketRepo(ticket)
  const repos = new Map(listRepos(ticket.projectId).map((r) => [r.id, r]))
  const rows = db
    .select()
    .from(schema.ticketRepos)
    .where(eq(schema.ticketRepos.ticketId, ticket.id))
    .orderBy(asc(schema.ticketRepos.position), asc(schema.ticketRepos.repoId))
    .all()
  const out: TicketRepoEntry[] = primary
    ? [
        {
          repoId: primary.id,
          name: primary.name,
          branch: ticket.branch,
          baseBranch: ticket.baseBranch,
          prNumber: ticket.prNumber,
          primary: true,
        },
      ]
    : []
  for (const row of rows) {
    const repo = repos.get(row.repoId)
    if (!repo || row.repoId === primary?.id) continue
    out.push({
      repoId: row.repoId,
      name: repo.name,
      branch: row.branch,
      baseBranch: row.baseBranch,
      prNumber: row.prNumber,
      primary: false,
    })
  }
  return out
}

/** The rows naming a repo for these tickets (their other repos, and their primary's): by repo. */
export function ticketRepoRows(ticketIds: number[]) {
  return ticketIds.length
    ? db.select().from(schema.ticketRepos).where(inArray(schema.ticketRepos.ticketId, ticketIds)).all()
    : []
}

/** Put the primary's row in step with the ticket's own fields, after any write to them. */
export function syncPrimaryRow(ticket: TicketFields) {
  const primary = ticketRepo(ticket)
  db.transaction((tx) => {
    // The repo that was primary before a change of repo stops being one of the ticket's repos.
    tx.delete(schema.ticketRepos)
      .where(
        and(
          eq(schema.ticketRepos.ticketId, ticket.id),
          eq(schema.ticketRepos.position, 0),
          ...(primary ? [ne(schema.ticketRepos.repoId, primary.id)] : []),
        ),
      )
      .run()
    if (!primary) return
    const values = {
      branch: ticket.branch,
      baseBranch: ticket.baseBranch,
      prNumber: ticket.prNumber,
      position: 0,
    }
    tx.insert(schema.ticketRepos)
      .values({ ticketId: ticket.id, repoId: primary.id, ...values })
      .onConflictDoUpdate({
        target: [schema.ticketRepos.ticketId, schema.ticketRepos.repoId],
        set: values,
      })
      .run()
  })
}

/**
 * A new list of repos for the ticket, checked: each a repo of its project, none twice, at least one.
 * What an entry leaves out comes from the ticket's current entry for that repo, else the repo's
 * defaults (no branch, its base branch, no PR).
 */
export function resolveTicketRepos(ticket: TicketFields, input: TicketRepoInput[]): TicketRepoEntry[] {
  if (!input.length) throw new HttpError(400, 'repos: a ticket has at least one repo')
  const repos = new Map(listRepos(ticket.projectId).map((r) => [r.id, r]))
  const before = new Map(
    (ticket.id ? ticketRepoList(ticket) : []).map((e) => [e.repoId, e] as [number, TicketRepoEntry]),
  )
  const seen = new Set<number>()
  return input.map((e, i) => {
    const repo = repos.get(e.repoId)
    if (!repo) throw new HttpError(400, `repos: repo ${e.repoId} is not in project ${ticket.projectId}`)
    if (seen.has(e.repoId)) throw new HttpError(400, `repos: repo ${repo.name} is listed twice`)
    seen.add(e.repoId)
    const was = before.get(e.repoId)
    return {
      repoId: repo.id,
      name: repo.name,
      branch: e.branch ?? was?.branch ?? '',
      baseBranch: e.baseBranch || was?.baseBranch || repo.baseBranch,
      prNumber: e.prNumber !== undefined ? e.prNumber : (was?.prNumber ?? null),
      primary: i === 0,
    }
  })
}

/** Store the ticket's other repos (the primary's row is `syncPrimaryRow`'s), replacing the ones it had. */
export function writeOtherRepos(ticketId: number, entries: TicketRepoEntry[]) {
  db.transaction((tx) => {
    tx.delete(schema.ticketRepos)
      .where(and(eq(schema.ticketRepos.ticketId, ticketId), ne(schema.ticketRepos.position, 0)))
      .run()
    const others = entries.filter((e) => !e.primary)
    if (others.length)
      tx.insert(schema.ticketRepos)
        .values(
          others.map((e, i) => ({
            ticketId,
            repoId: e.repoId,
            branch: e.branch,
            baseBranch: e.baseBranch,
            prNumber: e.prNumber,
            position: i + 1,
          })),
        )
        .run()
  })
}

/** The repo of a ticket's workspace: its own, else the ticket's primary. */
export function workspaceRepo(ws: Pick<schema.Workspace, 'repoId'>, ticket: TicketFields) {
  if (ws.repoId) return listRepos(ticket.projectId).find((r) => r.id === ws.repoId) ?? ticketRepo(ticket)
  return ticketRepo(ticket)
}
