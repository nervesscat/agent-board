import { and, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { HttpError, notFound } from './http'
import { getProject } from './projects'

/**
 * Agent cards: the two things an agent may put in the human's notification center besides the board's
 * own jobs (jobs.ts). A tracked card is one thing the human asked to watch ("show me the progress of…",
 * "let me know when… is done"): it moves while the work runs and ends succeeded or failed. A notice is
 * one plain card for something the human must know and would otherwise miss. Both are rows, so a
 * completion that lands hours later or a notice nobody has read yet survives a restart; neither has a
 * TTL or a cap, and only the human's dismissal removes one.
 *
 * The two guards are here, not only in the tools: `startTracked` refuses without the human's request,
 * `postNotice` without the reason it cannot wait. Only an agent opens, moves and finishes one, and only
 * the human dismisses it. An agent sees and moves the cards it opened, its sub-identities'
 * (`<its name>/…`) included; the human sees and dismisses every card of the project.
 *
 * An agent that goes away leaves a running card behind: six hours after its last move it reads
 * `stale`, in the panel too, and stays as it is (still running, still counted) until someone acts.
 */

export type AgentCardKind = 'tracked' | 'notice'
export type TrackedState = 'running' | 'succeeded' | 'failed'

export interface AgentCardBase {
  id: number
  kind: AgentCardKind
  projectId: number
  /** The agent that opened it, a sub-identity's name included. */
  actor: string
  title: string
  /** Where the result lives: a board path or an absolute http(s) URL. */
  href: string | null
  startedAt: string
  /** The last move; a running tracked card silent for six hours is stale. */
  updatedAt: string
  stale: boolean
}

/** A tracked request: progress, a state, and the human's own words that opened it. */
export interface TrackedCard extends AgentCardBase {
  kind: 'tracked'
  request: string
  total: number
  done: number
  state: TrackedState
  step: string | null
  reason: string | null
  result: string | null
  finishedAt: string | null
}

/** An important notice: no progress and no state to move, one reason it could not wait. */
export interface NoticeCard extends AgentCardBase {
  kind: 'notice'
  body: string
  reason: string
}

export type AgentCard = TrackedCard | NoticeCard

/** How long a running tracked card may stay silent before it reads stale: six hours from its last move. */
export const STALE_MS = 6 * 60 * 60_000

/** Who asks: the human (agent: false) or an agent's name (a sub-identity's included). */
export interface CardCaller {
  name: string
  agent: boolean
}

const TRACKED_ONLY =
  'Only when the human explicitly asked to see the progress of, or to be told about the completion of, one named thing ("show me progress", "let me know when", "notify me when", "tell me once it is ready"). Never for routine work: never to start a ticket, never to run tests in normal work, never for an unasked long build, never for a finished ticket. One request, one card.'
const NOTICE_ONLY =
  'Only for something very important the human must know and would otherwise miss: data lost or at risk, production or the host broken, a secret exposed, the wrong thing done and needing undo, a deadline missed. Never for routine work or a finished ticket, and never for a question (that is a decision or a wait). When in doubt, post on the ticket.'
export { NOTICE_ONLY, TRACKED_ONLY }

const required = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, `${field} is required and cannot be empty`)
  const text = value.trim()
  if (text.length > max) throw new HttpError(400, `${field} is at most ${max} characters`)
  return text
}

const optionalText = (value: unknown, field: string, max: number): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`)
  const text = value.trim()
  if (!text) return null
  if (text.length > max) throw new HttpError(400, `${field} is at most ${max} characters`)
  return text
}

/** A board path (`/projects/12`) or an absolute http(s) URL; anything else (a bare word, `//host`, a
 * `javascript:` URL) is refused, since the panel puts it in a router link or an anchor. */
const hrefOf = (value: unknown): string | null => {
  const raw = optionalText(value, 'href', 2_000)
  if (raw === null) return null
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw
  } catch {
    // Not a URL: the message below says what is accepted.
  }
  throw new HttpError(400, 'href must be a board path starting with / or an absolute http(s) URL')
}

const countOf = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000)
    throw new HttpError(400, `${field} must be a whole number from 0 to 1000000`)
  return value
}

/** A progress count: any whole number, since the card clamps it into its total (a step back included). */
const movementOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 1_000_000)
    throw new HttpError(400, 'done must be a whole number')
  return value
}

function projectOf(projectId: number) {
  getProject(projectId)
  return projectId
}

/** Whether `name` sees and moves `owner`'s card: its own, or one a sub-identity (`name/…`) opened. */
const owns = (owner: string, name: string) => owner === name || owner.startsWith(`${name}/`)

function rowOf(projectId: number, cardId: number) {
  const row = db
    .select()
    .from(schema.agentCards)
    .where(and(eq(schema.agentCards.id, cardId), eq(schema.agentCards.projectId, projectId)))
    .get()
  if (!row) throw notFound('card')
  return row
}

/** A row as the API and the panel read it: a notice has no state, step, count or result. */
function view(row: schema.AgentCardRow): AgentCard {
  const base = {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    actor: row.actor,
    title: row.title,
    href: row.href,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    stale:
      row.kind === 'tracked' && row.state === 'running' && Date.now() - Date.parse(row.updatedAt) >= STALE_MS,
  }
  if (row.kind === 'notice')
    return { ...base, kind: 'notice', body: row.body, reason: row.reason } as NoticeCard
  return {
    ...base,
    kind: 'tracked',
    request: row.request,
    total: row.total,
    done: row.done,
    state: row.state as TrackedState,
    step: row.step,
    reason: row.reason || null,
    result: row.result,
    finishedAt: row.finishedAt,
  } as TrackedCard
}

export interface ListCardsOptions {
  /** An agent's name: it sees only its own cards and its sub-identities'; absent for the human. */
  agent?: string | null
}

/** The project's cards the caller may see, newest first. */
export function listCards(projectId: number, opts: ListCardsOptions = {}): AgentCard[] {
  projectOf(projectId)
  const agent = opts.agent ?? null
  return db
    .select()
    .from(schema.agentCards)
    .where(eq(schema.agentCards.projectId, projectId))
    .all()
    .filter((row) => agent === null || owns(row.actor, agent))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)
    .map(view)
}

export interface StartTrackedInput {
  title?: unknown
  /** The human's request itself: the guard, quoted or closely paraphrased. */
  request?: unknown
  total?: unknown
  href?: unknown
}

/** Opens a running tracked card for one thing the human asked to watch. */
export function startTracked(caller: CardCaller, projectId: number, input: StartTrackedInput): TrackedCard {
  if (!caller.agent) throw new HttpError(403, 'only an agent opens a tracked request')
  projectOf(projectId)
  const title = required(input.title, 'title', 200)
  const request = required(input.request, "request (the human's request)", 500)
  const total = countOf(input.total, 'total') ?? 0
  const href = hrefOf(input.href)
  const at = new Date().toISOString()
  const row = db
    .insert(schema.agentCards)
    .values({
      projectId,
      kind: 'tracked',
      actor: caller.name,
      title,
      request,
      total,
      done: 0,
      state: 'running',
      step: null,
      result: null,
      href,
      startedAt: at,
      updatedAt: at,
    })
    .returning()
    .get()
  return view(row) as TrackedCard
}

export interface ProgressInput {
  done?: unknown
  /** The current item; left out keeps the last one. */
  step?: unknown
}

/** Moves a running tracked card along; `done` is clamped into [0, total]. */
export function progressTracked(
  caller: CardCaller,
  projectId: number,
  cardId: number,
  update: ProgressInput,
): TrackedCard {
  if (!caller.agent) throw new HttpError(403, 'only an agent moves a tracked request')
  projectOf(projectId)
  const row = rowOf(projectId, cardId)
  if (!owns(row.actor, caller.name)) throw notFound('card')
  if (row.kind !== 'tracked') throw new HttpError(409, 'this card is a notice: it has no progress to move')
  if (row.state !== 'running') throw new HttpError(409, 'this tracked card has ended: the first finish wins')
  const done = movementOf(update.done)
  const step = update.step === undefined ? undefined : optionalText(update.step, 'step', 500)
  const next = {
    ...row,
    done: done === undefined ? row.done : Math.min(Math.max(0, done), row.total),
    step: step === undefined ? row.step : step,
    updatedAt: new Date().toISOString(),
  }
  db.update(schema.agentCards)
    .set({ done: next.done, step: next.step, updatedAt: next.updatedAt })
    .where(eq(schema.agentCards.id, cardId))
    .run()
  return view(next) as TrackedCard
}

export interface FinishInput {
  /** succeeded or failed. */
  state?: unknown
  /** The one-line result, required when it succeeded. */
  result?: unknown
  /** Why it failed, required when it failed. */
  reason?: unknown
}

/** Ends a running tracked card: succeeded with its one-line result, or failed with its reason. */
export function finishTracked(
  caller: CardCaller,
  projectId: number,
  cardId: number,
  outcome: FinishInput,
): TrackedCard {
  if (!caller.agent) throw new HttpError(403, 'only an agent finishes a tracked request')
  projectOf(projectId)
  const row = rowOf(projectId, cardId)
  if (!owns(row.actor, caller.name)) throw notFound('card')
  if (row.kind !== 'tracked')
    throw new HttpError(409, 'this card is a notice: it is delivered once and has nothing to finish')
  if (row.state !== 'running') throw new HttpError(409, 'this tracked card has ended: the first finish wins')
  if (outcome.state !== 'succeeded' && outcome.state !== 'failed')
    throw new HttpError(400, 'state must be succeeded or failed')
  const result =
    outcome.state === 'succeeded'
      ? required(outcome.result, 'result (the one-line result of a succeeded card)', 500)
      : null
  const reason =
    outcome.state === 'failed' ? required(outcome.reason, 'reason (why the tracked card failed)', 500) : null
  const at = new Date().toISOString()
  const state: TrackedState = outcome.state
  const next = {
    ...row,
    state,
    done: state === 'succeeded' ? row.total : row.done,
    step: null,
    result,
    reason: reason ?? '',
    updatedAt: at,
    finishedAt: at,
  }
  db.update(schema.agentCards)
    .set({
      state: next.state,
      done: next.done,
      step: next.step,
      result: next.result,
      reason: next.reason,
      updatedAt: next.updatedAt,
      finishedAt: next.finishedAt,
    })
    .where(eq(schema.agentCards.id, cardId))
    .run()
  return view(next) as TrackedCard
}

export interface NoticeInput {
  title?: unknown
  body?: unknown
  /** Why it cannot wait: the guard. */
  reason?: unknown
  href?: unknown
}

/** Posts one important notice; it is delivered once and has no state to move afterwards. */
export function postNotice(caller: CardCaller, projectId: number, input: NoticeInput): NoticeCard {
  if (!caller.agent) throw new HttpError(403, 'only an agent posts a notice')
  projectOf(projectId)
  const title = required(input.title, 'title', 200)
  const body = required(input.body, 'body (what happened and what the human should do)', 2_000)
  const reason = required(input.reason, 'reason (why this notice cannot wait)', 500)
  const href = hrefOf(input.href)
  const at = new Date().toISOString()
  const row = db
    .insert(schema.agentCards)
    .values({
      projectId,
      kind: 'notice',
      actor: caller.name,
      title,
      body,
      reason,
      state: 'notice',
      href,
      startedAt: at,
      updatedAt: at,
    })
    .returning()
    .get()
  return view(row) as NoticeCard
}

/** Dismisses one card for everybody, the human's read receipt: gone from every list and the badge. */
export function dismissCard(caller: CardCaller, projectId: number, cardId: number): void {
  if (caller.agent) throw new HttpError(403, 'only the human dismisses a notification')
  projectOf(projectId)
  rowOf(projectId, cardId)
  db.delete(schema.agentCards).where(eq(schema.agentCards.id, cardId)).run()
}
