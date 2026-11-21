import type { LiveWorkPayload, ProjectSummary } from '#/lib/api'
import { GERUND } from '#/lib/workStatus'

/**
 * The Overview's Agents at work strip, as data: one character per agent on a ticket, from the live
 * work read (who is on which ticket, in what phase, since when it was heard) and the tickets finished
 * today. Pure: the clock is passed in, and nothing here reads the board.
 */

export type PetState = 'working' | 'waiting' | 'asleep' | 'done'

export interface Pet {
  /** One per ticket and agent name. */
  key: string
  ticketId: number
  title: string
  /** "#12 Short title", cut at `TITLE_LIMIT` characters (the number is never cut). */
  short: string
  /** The agent's name; null when the board knows none (a finished ticket nobody held). */
  agent: string | null
  /** A subagent ("parent/child") is drawn smaller, after its parent when that is on the same ticket. */
  size: 'normal' | 'small'
  state: PetState
  /** What it is doing: "Building", "Reviewing round 2", "Waiting: human", "Quiet", "Done today". */
  phase: string
  /** When it was last heard (done: when the ticket was finished); null when never. */
  at: string | null
  /** "last heard 3 min ago", "finished 2 h ago". */
  since: string
  /** The whole line, for a screen reader and the tooltip. */
  label: string
}

export interface Pets {
  pets: Pet[]
  /** Characters beyond `MAX_PETS`, not drawn. */
  more: number
  /** Agents at work or waiting or asleep (not the finished): what the heading counts. */
  live: number
}

export const TITLE_LIMIT = 28
export const MAX_PETS = 12
export const MAX_DONE = 3

const RANK: Record<PetState, number> = { waiting: 0, working: 1, asleep: 2, done: 3 }

type Live = LiveWorkPayload['liveNow'][number] | LiveWorkPayload['recentlyActive'][number]
type Done = ProjectSummary['doneToday']['tickets'][number]

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
  const base = phase === 'ci' ? 'CI' : (GERUND[phase] ?? phase)
  return round ? `${base} round ${round}` : base
}

const small = (name: string | null) => !!name && name.includes('/')
const parentName = (name: string) => name.slice(0, name.lastIndexOf('/'))

export function petsOf(
  work: Pick<LiveWorkPayload, 'liveNow' | 'recentlyActive'> | undefined,
  doneToday: readonly Done[],
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
        size: small(agent) ? 'small' : 'normal',
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
  for (const e of work?.recentlyActive ?? []) if (e.stalled) fromLive(e, 'asleep')
  for (const t of doneToday.slice(0, MAX_DONE)) {
    if (all.some((p) => p.ticketId === t.id)) continue
    const agent = t.assignee || null
    const since = `finished ${text(t.doneAt, now)}`
    add({
      key: `${t.id}:${agent ?? ''}`,
      ticketId: t.id,
      title: t.title,
      short: `#${t.id} ${cut(t.title)}`,
      agent,
      size: 'normal',
      state: 'done',
      phase: 'Done today',
      at: t.doneAt,
      since,
      label: `#${t.id} ${t.title} — ${agent ? `agent ${agent}, ` : ''}done today, ${since}`,
    })
  }

  // Waiting, working, asleep, done; ties by ticket then name. A subagent follows its parent's character
  // on the same ticket; one whose parent is not there is placed as any other.
  const has = new Set(all.map((p) => p.key))
  const child = (p: Pet) => p.size === 'small' && has.has(`${p.ticketId}:${parentName(p.agent!)}`)
  const order = (a: Pet, b: Pet) =>
    RANK[a.state] - RANK[b.state] || a.ticketId - b.ticketId || (a.agent ?? '').localeCompare(b.agent ?? '')
  const kids = all.filter(child)
  const ordered: Pet[] = []
  const place = (p: Pet) => {
    ordered.push(p)
    for (const k of kids
      .filter((k) => k.ticketId === p.ticketId && parentName(k.agent!) === p.agent)
      .sort(order))
      place(k)
  }
  for (const p of all.filter((p) => !child(p)).sort(order)) place(p)
  return {
    pets: ordered.slice(0, MAX_PETS),
    more: Math.max(0, ordered.length - MAX_PETS),
    live: ordered.filter((p) => p.state !== 'done').length,
  }
}
