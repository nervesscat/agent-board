import type { LiveWorkPayload } from '#/lib/api'
import { GERUND } from '#/lib/workStatus'

/**
 * The Overview's Agents at work card, as data: one character per agent on a ticket, from the live
 * work read (who is on which ticket, in what phase, since when it was heard). A ticket in Done,
 * Approved or Cancelled has no one at work, so none of its agents is drawn. Pure: the clock is passed
 * in, and nothing here reads the board.
 */

export type PetState = 'working' | 'waiting' | 'asleep'

export interface Pet {
  /** One per ticket and agent name. */
  key: string
  ticketId: number
  title: string
  /** "#12 Short title", cut at `TITLE_LIMIT` characters (the number is never cut). */
  short: string
  /** The agent's name; null when the board knows none. */
  agent: string | null
  /** A subagent ("parent/child" whose parent is another character on the same ticket) is drawn smaller, after its parent. */
  size: 'normal' | 'small'
  state: PetState
  /** What it is doing: "Building", "Reviewing round 2", "Waiting: human", "Building, quiet". */
  phase: string
  /** When it was last heard. */
  at: string
  /** "last heard 3 min ago". */
  since: string
  /** The whole line, for a screen reader and the tooltip. */
  label: string
}

export interface Pets {
  pets: Pet[]
  /** Characters beyond `MAX_PETS`, not drawn. */
  more: number
  /** Every agent at work, waiting or asleep: what the heading counts. */
  live: number
}

export const TITLE_LIMIT = 28
export const MAX_PETS = 24

const RANK: Record<PetState, number> = { waiting: 0, working: 1, asleep: 2 }

type Live = LiveWorkPayload['liveNow'][number] | LiveWorkPayload['recentlyActive'][number]

const cut = (title: string) =>
  title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : title

/** "just now", "3 min", "2 h", "4 d": the time from `iso` to `now`. */
export function elapsed(iso: string, now: number): string {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min`
  if (m < 60 * 24) return `${Math.floor(m / 60)} h`
  return `${Math.floor(m / 1440)} d`
}
const text = (iso: string, now: number) => {
  const e = elapsed(iso, now)
  return e === 'just now' ? e : `${e} ago`
}

/** "Building", "Reviewing round 2", "CI": the open span's phase; the raw phase when it is none of those. */
export function phaseLabel(phase: string | null, round: number | null): string {
  if (!phase) return ''
  const base = phase === 'ci' ? 'CI' : Object.hasOwn(GERUND, phase) ? GERUND[phase] : phase
  return round ? `${base} round ${round}` : base
}

/** The stages whose tickets show no agent: Done, Cancelled and Approved (the human's go-ahead to merge). */
export const hiddenStage = (stage: Live['stage']): boolean =>
  stage.kind === 'done' || stage.kind === 'cancelled' || stage.kind === 'approved'

export function petsOf(
  work: Pick<LiveWorkPayload, 'liveNow' | 'recentlyActive'> | undefined,
  now: number,
): Pets {
  const all: Pet[] = []
  const seen = new Set<string>()
  const add = (pet: Pet) => {
    if (seen.has(pet.key)) return
    seen.add(pet.key)
    all.push(pet)
  }
  const fromLive = (e: Live, state: PetState) => {
    if (hiddenStage(e.stage)) return
    const phase =
      state === 'waiting' && 'waitingFor' in e && e.waitingFor
        ? `Waiting: ${e.waitingFor.note || e.waitingFor.reason}`
        : state === 'waiting'
          ? 'Blocked'
          : state === 'asleep'
            ? [phaseLabel(e.phase, e.round), 'quiet'].filter(Boolean).join(', ')
            : phaseLabel(e.phase, e.round) || 'Working'
    for (const agent of e.agents.length ? e.agents : [null]) {
      const heard = text(e.lastHeardAt, now)
      const since = `last heard ${heard}`
      add({
        key: `${e.ticketId}:${agent ?? ''}`,
        ticketId: e.ticketId,
        title: e.title,
        short: `#${e.ticketId} ${cut(e.title)}`,
        agent,
        size: 'normal',
        state,
        phase,
        at: e.lastHeardAt,
        since,
        label: `#${e.ticketId} ${e.title} — ${agent ? `agent ${agent}, ` : ''}${phase}, ${since}, ${state}`,
      })
    }
  }
  // The stage kind is a wait on the human too, whatever the timeline says.
  for (const e of work?.liveNow ?? [])
    fromLive(e, e.waitingFor || e.stage.kind === 'blocked' ? 'waiting' : 'working')
  // Quiet but not live: stalled, or lost contact (an open span whose lease ran out: stalled is false but the
  // phase is that of the open span). One with no open span is not an agent at work and draws nothing.
  for (const e of work?.recentlyActive ?? []) if (e.stalled || e.phase !== null) fromLive(e, 'asleep')

  // A pet is small only when its nearest ancestor ("a/b/c" -> "a/b", then "a") is another pet on the same
  // ticket; a "a/b" whose "a" is not there is drawn as any other.
  const names = new Set(all.map((p) => p.key))
  const parents = new Map<Pet, string>()
  for (const p of all) {
    for (let n = p.agent; n && n.includes('/'); ) {
      n = n.slice(0, n.lastIndexOf('/'))
      if (names.has(`${p.ticketId}:${n}`)) {
        parents.set(p, n)
        p.size = 'small'
        break
      }
    }
  }

  // Waiting, working, asleep; ties by ticket then name. A subagent follows its parent's character.
  const order = (a: Pet, b: Pet) =>
    RANK[a.state] - RANK[b.state] || a.ticketId - b.ticketId || (a.agent ?? '').localeCompare(b.agent ?? '')
  const kids = all.filter((p) => parents.has(p))
  const ordered: Pet[] = []
  const place = (p: Pet) => {
    ordered.push(p)
    for (const k of kids.filter((k) => k.ticketId === p.ticketId && parents.get(k) === p.agent).sort(order))
      place(k)
  }
  for (const p of all.filter((p) => !parents.has(p)).sort(order)) place(p)
  return {
    pets: ordered.slice(0, MAX_PETS),
    more: Math.max(0, ordered.length - MAX_PETS),
    live: ordered.length,
  }
}
