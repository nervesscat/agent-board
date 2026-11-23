import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError, notFound } from './http'
import { heartbeat } from './workTimeline'

/**
 * Agents that wait for the human's answer on a decision card, held by the board while they wait (the
 * `wait_for_answer` tool). The registry is in memory: a board restart drops it, and an agent whose wait
 * ended asks again and finds the card already answered.
 *
 * One answer is never both delivered and resumed, and never neither. `decide` asks `hasWaiter` through
 * the resume (resume.ts) while the waiters are still registered, and only then calls `answerLanded`,
 * which hands the answer to them. Both run in one synchronous stretch (the database is synchronous), so
 * a wait cannot time out or start between the two: a waiter registered when the answer lands gets it and
 * no process is started; with none registered the resume goes the usual way, and a wait that ended just
 * before finds the card already answered on its next call.
 */

export type Answer = {
  postId: number
  option: number
  label: string
  /** The human's own words: the note they gave, or what was relayed from the chat. Empty when none. */
  text: string
  by: string
  at: string
  /** Set when the answer was relayed from the chat by an agent (its name), '' for the human's own. */
  relayedBy: string
}

export type WaitResult =
  | ({ answered: true } & Answer)
  | { answered: false; timedOut: true; postId: number }
  | { answered: false; aborted: true; postId: number }

type Waiter = { settle: (answer: Answer) => void }

const waiters = new Map<string, Set<Waiter>>()
const keyOf = (ticketId: number, postId: number) => `${ticketId}:${postId}`

/** Whether an agent is waiting for the answer to this decision card of the ticket. */
export function hasWaiter(ticketId: number, postId: number): boolean {
  return (waiters.get(keyOf(ticketId, postId))?.size ?? 0) > 0
}

/** Whether any wait of the ticket is registered, whatever card it waits on. */
export function ticketHasWaiter(ticketId: number): boolean {
  for (const [key, set] of waiters) if (set.size > 0 && key.startsWith(`${ticketId}:`)) return true
  return false
}

/** The note of the lease refresh a wait writes: once the wait has ended it says nothing of an agent. */
export const WAIT_NOTE = 'waiting for an answer'

/** How many waits are registered, for tests: zero means nothing leaked. */
export function waiterCount(): number {
  let n = 0
  for (const set of waiters.values()) n += set.size
  return n
}

function register(ticketId: number, postId: number, waiter: Waiter): () => void {
  const key = keyOf(ticketId, postId)
  const set = waiters.get(key) ?? new Set<Waiter>()
  set.add(waiter)
  waiters.set(key, set)
  return () => {
    set.delete(waiter)
    if (set.size === 0 && waiters.get(key) === set) waiters.delete(key)
  }
}

/** The card's answer as it stands, or null while it is open. */
export function readAnswer(postId: number): Answer | null {
  const post = db.select().from(schema.updates).where(eq(schema.updates.id, postId)).get()
  if (!post || !post.decision || post.decidedAt === null || post.decidedOption === null) return null
  const label = post.decision[post.decidedOption]?.label ?? ''
  let text = post.relayedText
  if (!post.relayedBy) {
    // The human's note is in the board's reply under the card: "Decided: **label**" and the note after it.
    const replies = db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.parentType, 'update'),
          eq(schema.comments.parentId, postId),
          eq(schema.comments.author, post.decidedBy),
        ),
      )
      .orderBy(desc(schema.comments.id))
      .all()
    const reply = replies.find((c) => /^(Decided|Changed the decision to): \*\*/.test(c.body))
    text = reply ? reply.body.split('\n\n').slice(1).join('\n\n').trim() : ''
  }
  return {
    postId,
    option: post.decidedOption,
    label,
    text,
    by: post.decidedBy || post.relayedBy,
    at: post.decidedAt,
    relayedBy: post.relayedBy,
  }
}

/**
 * The card was answered (by the human or relayed): hands the answer to every agent waiting for it.
 * Call it after the resume has been decided (see the top of this file).
 */
export function answerLanded(ticketId: number, postId: number): number {
  const set = waiters.get(keyOf(ticketId, postId))
  if (!set || set.size === 0) return 0
  const answer = readAnswer(postId)
  if (!answer) return 0
  const all = [...set]
  for (const w of all) w.settle(answer)
  // The card says it: an edit of this answer starts no second agent (resume.ts). A relayed one keeps its mark.
  db.update(schema.updates)
    .set({ answerDelivered: 'waiter' })
    .where(and(eq(schema.updates.id, postId), eq(schema.updates.answerDelivered, '')))
    .run()
  return all.length
}

/** The ticket's newest open decision card, or null. */
function newestOpenCard(ticketId: number) {
  return db
    .select({ id: schema.updates.id })
    .from(schema.updates)
    .where(
      and(
        eq(schema.updates.ticketId, ticketId),
        isNotNull(schema.updates.decision),
        isNull(schema.updates.decidedAt),
      ),
    )
    .orderBy(desc(schema.updates.id))
    .get()
}

export type WaitOptions = {
  ticketId: number
  /** The decision card; left out, the ticket's newest open one. */
  postId?: number
  timeoutMs: number
  /** How often `onHeartbeat` runs while waiting (the lease and progress of the caller). */
  heartbeatMs: number
  signal?: AbortSignal
  /** Runs when the wait starts and every `heartbeatMs` after; a failure in it never ends the wait. */
  onHeartbeat?: () => void | Promise<void>
}

/**
 * Waits for the human's answer on a decision card: the answer at once when the card is already answered,
 * else when it lands, else `timedOut` after `timeoutMs` (the caller asks again) or `aborted` when the
 * request ends. Throws an HttpError for a ticket or card that does not exist, or no open card to wait on.
 * Its timers and its registry entry are gone whichever way it ends.
 */
export function waitForAnswer(opts: WaitOptions): Promise<WaitResult> {
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, opts.ticketId)).get()
  if (!ticket) throw notFound('ticket')
  let postId = opts.postId
  if (postId === undefined) {
    const open = newestOpenCard(ticket.id)
    if (!open)
      throw new HttpError(
        409,
        `#${ticket.id} has no open decision card to wait for: ask one first (ask_decision), or pass postId for a card already answered`,
      )
    postId = open.id
  }
  const post = db.select().from(schema.updates).where(eq(schema.updates.id, postId)).get()
  if (!post || post.ticketId !== ticket.id || !post.decision)
    throw new HttpError(404, `post ${postId} is not a decision card of #${ticket.id}`)
  const done = readAnswer(postId)
  if (done) return Promise.resolve({ answered: true, ...done })
  if (opts.signal?.aborted) return Promise.resolve({ answered: false, aborted: true, postId })

  const card = postId
  return new Promise<WaitResult>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let beat: ReturnType<typeof setInterval> | undefined
    let unregister = () => {}
    const onAbort = () => finish({ answered: false, aborted: true, postId: card })
    function finish(result: WaitResult) {
      clearTimeout(timeout)
      clearInterval(beat)
      unregister()
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const pulse = () => {
      if (!opts.onHeartbeat) return
      try {
        void Promise.resolve(opts.onHeartbeat()).catch(() => {})
      } catch {
        // A lease that could not be refreshed does not end the wait.
      }
    }
    unregister = register(ticket.id, card, { settle: (a) => finish({ answered: true, ...a }) })
    timeout = setTimeout(() => finish({ answered: false, timedOut: true, postId: card }), opts.timeoutMs)
    beat = setInterval(pulse, opts.heartbeatMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    pulse()
  })
}

/** How often a wait refreshes the ticket's lease and sends progress. */
export const WAIT_HEARTBEAT_MS = 20_000
export const WAIT_DEFAULT_SECONDS = 300
export const WAIT_MAX_SECONDS = 1800

/**
 * What the MCP tool and its REST twin do: wait for the answer, keeping the ticket's lease alive as the
 * `heartbeat` tool does (attributed to `actor`), and say the result plainly to the agent. `onBeat` runs
 * after each lease refresh (the MCP progress notification).
 */
export async function waitAndReport(opts: {
  ticketId: number
  postId?: number
  timeoutSeconds?: number
  signal?: AbortSignal
  actor: string
  onBeat?: () => void | Promise<void>
}) {
  const result = await waitForAnswer({
    ticketId: opts.ticketId,
    postId: opts.postId,
    timeoutMs: (opts.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
    heartbeatMs: WAIT_HEARTBEAT_MS,
    signal: opts.signal,
    onHeartbeat: async () => {
      const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, opts.ticketId)).get()
      if (ticket) heartbeat(ticket.projectId, ticket.id, { note: WAIT_NOTE }, opts.actor)
      await opts.onBeat?.()
    },
  })
  if (result.answered) {
    const { relayedBy: _relayedBy, ...answer } = result
    return {
      ...answer,
      message: `Answered: option ${answer.option} (${answer.label})${answer.text ? `: ${answer.text}` : ''}`,
    }
  }
  return { ...result, message: `No answer yet: call wait_for_answer again with postId ${result.postId}.` }
}
