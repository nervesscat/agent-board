import { and, asc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { StageKind } from '#/lib/constants'
import { logActivity } from './activity'
import { listRepos } from './repos'
import { firstOfKind, kindOf, listStages, startedPatch, startStage, type Stage } from './stages'

/**
 * A PR's own ticket: the ticket the board opens for each open PR of the queue that no feature ticket names,
 * so what is said about the PR (reviews, findings, progress) has one ticket. It is a normal ticket that
 * lives in the PR queue only: the feature lists, counts and summary leave it out.
 *
 * This module imports the ticket and stage helpers, never the PR queue or the features: both of those use it.
 */

/** Where a PR's own ticket stands: the PR's status in the queue, or closed without merging. */
export type PrTicketStatus = 'pending' | 'reviewed' | 'on_hold' | 'done' | 'cancelled'

const STAGE_KIND: Record<Exclude<PrTicketStatus, 'pending'>, StageKind> = {
  reviewed: 'review',
  on_hold: 'blocked',
  done: 'done',
  cancelled: 'cancelled',
}

/**
 * The stage a PR's ticket is in for its status: where new tickets start while the PR is pending (To do, not
 * Backlog), else the project's first stage of the kind the status stands for. Undefined when the project has
 * no stage of that kind.
 */
export function prTicketStage(stages: Stage[], status: PrTicketStatus): Stage | undefined {
  return status === 'pending' ? startStage(stages) : firstOfKind(stages, STAGE_KIND[status])
}

/** The title a PR's ticket starts with: its number and title, cut to 80 characters. */
export const prTicketTitle = (pr: Pick<schema.Pr, 'number' | 'title'>) =>
  `PR #${pr.number}: ${pr.title}`.slice(0, 80)

type Pr = Pick<schema.Pr, 'id' | 'projectId' | 'repoId' | 'number' | 'headRef'>
type Named = Pick<schema.Ticket, 'repoId' | 'prNumber' | 'branch' | 'prId'>

/**
 * The feature tickets that name a PR: by its number, or by its branch when they name no PR, in the PR's repo
 * (a feature ticket that names another PR does not claim this one by its branch). A PR's own ticket is not one.
 */
export function featureTicketsOf<T extends Named>(
  tickets: T[],
  repos: schema.Repo[],
  pr: Pick<Pr, 'repoId' | 'number' | 'headRef'>,
): T[] {
  return tickets.filter(
    (t) =>
      !t.prId &&
      (t.repoId ?? repos[0]?.id) === pr.repoId &&
      (t.prNumber === pr.number || (t.prNumber === null && !!t.branch && t.branch === pr.headRef)),
  )
}

/** The ticket the board opened for a PR of the queue, if it opened one. */
export const prTicketOf = <T extends Pick<schema.Ticket, 'prId'>>(tickets: T[], prId: number) =>
  tickets.find((t) => t.prId === prId)

const projectTicketRows = (projectId: number) =>
  db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()

/** A PR's own ticket, unless a feature ticket names the PR: that one has taken the PR over. */
function ownTicketOf(pr: Pr): schema.Ticket | undefined {
  const tickets = projectTicketRows(pr.projectId)
  const own = prTicketOf(tickets, pr.id)
  return own && !featureTicketsOf(tickets, listRepos(pr.projectId), pr).length ? own : undefined
}

/** Whether a PR has a ticket of its own that a change of its status moves (see `ownTicketOf`). */
export const hasOwnTicket = (pr: Pr) => ownTicketOf(pr) !== undefined

/**
 * Opens a ticket for each open PR of the project that neither a feature ticket nor a ticket of its own covers,
 * in the stage its status (`statusOf`) has then. The check and the insert run in one transaction, so refreshes
 * that overlap cannot open two tickets for one PR.
 */
export function openPrTickets(projectId: number, statusOf: (pr: schema.Pr) => PrTicketStatus) {
  db.transaction((tx) => {
    const open = tx
      .select()
      .from(schema.prs)
      .where(and(eq(schema.prs.projectId, projectId), eq(schema.prs.open, true)))
      .orderBy(asc(schema.prs.id))
      .all()
    if (!open.length) return
    const tickets = tx.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
    const repos = listRepos(projectId)
    const stages = listStages(projectId)
    for (const pr of open) {
      if (prTicketOf(tickets, pr.id) || featureTicketsOf(tickets, repos, pr).length) continue
      const stage = prTicketStage(stages, statusOf(pr)) ?? startStage(stages)
      const row = tx
        .insert(schema.tickets)
        .values({
          projectId,
          repoId: pr.repoId,
          title: prTicketTitle(pr),
          body: pr.url,
          status: stage.key,
          ...startedPatch(stages, null, stage.key),
          prNumber: pr.number,
          prId: pr.id,
          createdBy: 'board',
        })
        .returning()
        .get()
      tickets.push(row)
      logActivity({
        projectId,
        actor: 'board',
        kind: 'pr',
        text: `opened ticket #${row.id} for PR #${pr.number} ${pr.title}`,
        refType: 'ticket',
        refId: row.id,
      })
    }
  })
}

/**
 * A PR's own ticket moves to the stage `status` has. Callers pass a status only when it changed: a stage a
 * person or an agent set holds until then. Nothing moves while a feature ticket names the PR.
 */
export function movePrTicket(pr: Pr, status: PrTicketStatus, actor = 'board') {
  const own = ownTicketOf(pr)
  if (!own) return
  const stages = listStages(pr.projectId)
  const stage = prTicketStage(stages, status)
  if (!stage || stage.key === own.status) return
  db.update(schema.tickets)
    .set({
      status: stage.key,
      ...startedPatch(stages, own.status, stage.key, own.startedAt),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.tickets.id, own.id))
    .run()
  logActivity({
    projectId: pr.projectId,
    actor,
    kind: 'pr',
    text: `moved the ticket of PR #${pr.number} to ${stage.name}`,
    refType: 'ticket',
    refId: own.id,
  })
}

/**
 * A feature ticket that now names PRs (its number, or its branch as their head) takes them over: each of their
 * own tickets that is not done or cancelled is cancelled. Returns those tickets, with their PR numbers, for the
 * caller to say so on them. The board never archives them: that stays the human's.
 */
export function cancelSupersededPrTickets(t: schema.Ticket, actor: string) {
  if (t.prId) return []
  const stages = listStages(t.projectId)
  const cancel = firstOfKind(stages, 'cancelled')
  if (!cancel) return []
  const repos = listRepos(t.projectId)
  const tickets = projectTicketRows(t.projectId)
  const cancelled: { id: number; number: number }[] = []
  for (const pr of db.select().from(schema.prs).where(eq(schema.prs.projectId, t.projectId)).all()) {
    if (!featureTicketsOf([t], repos, pr).length) continue
    const own = prTicketOf(tickets, pr.id)
    const kind = own ? kindOf(stages, own.status) : undefined
    if (!own || kind === 'done' || kind === 'cancelled') continue
    db.update(schema.tickets)
      .set({ status: cancel.key, updatedAt: new Date().toISOString() })
      .where(eq(schema.tickets.id, own.id))
      .run()
    logActivity({
      projectId: t.projectId,
      actor,
      kind: 'pr',
      text: `cancelled the ticket of PR #${pr.number}: ticket #${t.id} ${t.title} now names it`,
      refType: 'ticket',
      refId: own.id,
    })
    cancelled.push({ id: own.id, number: pr.number })
  }
  return cancelled
}

/** The ticket a PR's reviews and progress go on: the feature ticket that names the PR, else the PR's own. */
export function ticketForPr(projectId: number, repoId: number, number: number): schema.Ticket | undefined {
  const tickets = projectTicketRows(projectId)
  const repos = listRepos(projectId)
  const pr = db
    .select()
    .from(schema.prs)
    .where(
      and(eq(schema.prs.projectId, projectId), eq(schema.prs.repoId, repoId), eq(schema.prs.number, number)),
    )
    .get()
  const named = featureTicketsOf(tickets, repos, { repoId, number, headRef: pr?.headRef ?? '' })
  return named.find((t) => t.prNumber === number) ?? named[0] ?? (pr ? prTicketOf(tickets, pr.id) : undefined)
}
