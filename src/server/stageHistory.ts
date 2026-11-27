import { and, asc, desc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { SEND_BACK_REASONS, type SendBackReason, type StageHow } from '#/lib/constants'
import { logActivity } from './activity'
import { HttpError, notFound } from './http'
import { kindOf, type Stage } from './stages'

/**
 * A ticket's stage history as `get_ticket` and the ticket page read it: each move between stages with
 * who made it and how (the stage events of the work timeline, src/server/workTimeline.ts), and the
 * human's send-backs from review with their reason. Old tickets have no rows, or stage rows written
 * before who and how were kept: those read with `by` and `how` null, never as invented history.
 */

/** One move between stages, oldest first. `from` null: the ticket was created in `to`. */
export type StageChange = {
  id: number
  at: string
  from: string | null
  to: string
  /** The human's or the agent's name, `board` for the board's own; null on a move recorded before it was kept. */
  by: string | null
  how: StageHow | null
}

/** The human sending the ticket back from review to work, with the reason when there is one. */
export type SendBack = {
  id: number
  /** The stage event of the move, in stageHistory; null when it could not be written. */
  eventId: number | null
  at: string
  from: string
  to: string
  by: string
  reason: SendBackReason | null
  reasonBy: string
  reasonAt: string | null
}

/**
 * A move that sends a ticket back from review: from a review or approved stage to an active or open
 * one. Only the human's such move is a send-back; an agent's or the board's is not (callers decide).
 */
export function isSendBack(stages: Stage[], from: string, to: string) {
  const was = kindOf(stages, from)
  const is = kindOf(stages, to)
  return (was === 'review' || was === 'approved') && (is === 'active' || is === 'open')
}

/** Record the human's send-back of `ticket` from `from` to `to`, beside its stage event (when written). */
export function recordSendBack(
  ticket: Pick<schema.Ticket, 'id' | 'projectId'>,
  move: { eventId: number | null; from: string; to: string; by: string; reason?: SendBackReason },
) {
  const at = new Date().toISOString()
  return db
    .insert(schema.ticketSendBacks)
    .values({
      ticketId: ticket.id,
      projectId: ticket.projectId,
      eventId: move.eventId,
      fromStage: move.from,
      toStage: move.to,
      by: move.by,
      reason: move.reason ?? '',
      reasonBy: move.reason ? move.by : '',
      reasonAt: move.reason ? at : null,
      at,
    })
    .returning()
    .get()
}

const asSendBack = (r: schema.TicketSendBack): SendBack => ({
  id: r.id,
  eventId: r.eventId,
  at: r.at,
  from: r.fromStage,
  to: r.toStage,
  by: r.by,
  reason: r.reason || null,
  reasonBy: r.reasonBy,
  reasonAt: r.reasonAt,
})

/**
 * Set (or with null, clear) the reason of one of a ticket's send-backs: the human's pick on the ticket
 * page, which replaces any earlier one. Callers make sure the actor is the human.
 */
export function setSendBackReason(
  ticketId: number,
  sendBackId: number,
  reason: SendBackReason | null,
  actor: string,
): SendBack {
  const row = db
    .select()
    .from(schema.ticketSendBacks)
    .where(and(eq(schema.ticketSendBacks.id, sendBackId), eq(schema.ticketSendBacks.ticketId, ticketId)))
    .get()
  if (!row) throw notFound('send-back')
  const updated = db
    .update(schema.ticketSendBacks)
    .set({
      reason: reason ?? '',
      reasonBy: reason ? actor : '',
      reasonAt: reason ? new Date().toISOString() : null,
    })
    .where(eq(schema.ticketSendBacks.id, row.id))
    .returning()
    .get()!
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (ticket)
    logActivity({
      projectId: ticket.projectId,
      actor,
      kind: 'ticket',
      text: reason
        ? `gave the send-back of #${ticketId} ${ticket.title} the reason ${reason}`
        : `cleared the reason of the send-back of #${ticketId} ${ticket.title}`,
      refType: 'ticket',
      refId: ticketId,
    })
  return asSendBack(updated)
}

/** The reason values a text names as words (any casing), each once. */
export function reasonsNamed(text: string): SendBackReason[] {
  const found = new Set<SendBackReason>()
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_-])(defect|changed-mind|new-ask)(?![\p{L}\p{N}_-])/giu))
    found.add(m[1]!.toLowerCase() as SendBackReason)
  return SEND_BACK_REASONS.filter((r) => found.has(r))
}

/**
 * The human's comment on a ticket fills the reason of its latest send-back, when that one has none yet
 * and the comment names exactly one reason value as a word. A pick (`setSendBackReason`, or the reason
 * given with the move) is never replaced by a comment. Callers make sure the commenter is the human.
 * Answers the send-back it filled, else null.
 */
export function reasonFromComment(ticketId: number, body: string, actor: string): SendBack | null {
  const named = reasonsNamed(body)
  if (named.length !== 1) return null
  const latest = db
    .select()
    .from(schema.ticketSendBacks)
    .where(eq(schema.ticketSendBacks.ticketId, ticketId))
    .orderBy(desc(schema.ticketSendBacks.at), desc(schema.ticketSendBacks.id))
    .get()
  if (!latest || latest.reason) return null
  return setSendBackReason(ticketId, latest.id, named[0]!, actor)
}

/** The ticket's moves between stages, oldest first; an empty list for a ticket with none recorded. */
export function stageHistoryOf(ticketId: number): StageChange[] {
  return db
    .select()
    .from(schema.ticketEvents)
    .where(and(eq(schema.ticketEvents.ticketId, ticketId), eq(schema.ticketEvents.kind, 'stage')))
    .orderBy(asc(schema.ticketEvents.at), asc(schema.ticketEvents.id))
    .all()
    .map((e) => ({
      id: e.id,
      at: e.at,
      from: e.fromStage || null,
      to: e.toStage,
      by: e.movedBy || null,
      how: e.how || null,
    }))
}

/** The ticket's send-backs, oldest first. */
export function sendBacksOf(ticketId: number): SendBack[] {
  return db
    .select()
    .from(schema.ticketSendBacks)
    .where(eq(schema.ticketSendBacks.ticketId, ticketId))
    .orderBy(asc(schema.ticketSendBacks.at), asc(schema.ticketSendBacks.id))
    .all()
    .map(asSendBack)
}

/** What `get_ticket` carries of the history: the moves, the send-backs and how many there were. */
export function historyOf(ticketId: number) {
  const sendBacks = sendBacksOf(ticketId)
  return { stageHistory: stageHistoryOf(ticketId), sendBacks, sendBackCount: sendBacks.length }
}

/** A reason that is not one of the values is refused; '' and null are none. */
export function sendBackReason(value: string | null | undefined): SendBackReason | undefined {
  if (!value) return undefined
  if ((SEND_BACK_REASONS as readonly string[]).includes(value)) return value as SendBackReason
  throw new HttpError(400, `a send-back's reason is one of ${SEND_BACK_REASONS.join(', ')}`)
}
