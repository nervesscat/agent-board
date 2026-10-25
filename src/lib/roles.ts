import type { ActorKind, ActorRole } from '#/server/actors'

/** A role as a badge shows it: an actor's, or the board's own for what the board records itself. */
export type WhoRole = ActorRole | 'board'

/**
 * Who a name is: how it signs in (`board`: nobody signs in, the board wrote it), its role and the name
 * it works under ('' for none).
 */
export type Who = { kind: ActorKind | 'board'; role: WhoRole; parent: string }

/** The name the board's own records carry (stage moves, pushes, merges, phases it ticks). */
export const BOARD_NAME = 'board'

/**
 * How a record shows who made it, from the name it claims (`name`, which may be free text such as a
 * sub-agent's label) and who recorded it as signed in (`by`). A role badge goes only on a signed-in
 * identity: when `by` is someone else it is a claim ('claimed': the name as plain text, then who
 * recorded it); when they are the same, or `by` is unknown (an older record), it is that actor.
 */
export const claimedShape = (name: string, by: string | null | undefined): 'actor' | 'claimed' =>
  !by || by === name ? 'actor' : 'claimed'

/**
 * Whether the board recorded this event itself: it carries the board's name and the board recorded it
 * (`by` 'board', or empty for older events). An event someone else recorded under the name 'board' is
 * a claim like any other: a worker's activity, never the board's.
 */
export const isBoardRecord = (agent: string, by: string | null | undefined): boolean =>
  agent === BOARD_NAME && claimedShape(agent, by) === 'actor'

const BOARD: Who = { kind: 'board', role: 'board', parent: '' }

const AGENTS = ['claude', 'codex', 'opencode', 'gemini', 'cursor', 'agent', 'bot']

/**
 * Who `name` is, from the board's actors (`/api/actors`, as each name was last seen): an agent token is
 * an agent (an orchestrator or a worker), the browser's passkey session is the human. A name it never
 * saw that has a `/` is a worker sub-identity under the name before the last `/`; any other is a guess
 * by the name (history from before the board kept track). `board` is the board itself, whatever
 * else carries that name: never a human.
 */
export function whoOf(name: string, actors: ReadonlyMap<string, Who>): Who {
  if (name === BOARD_NAME) return BOARD
  const known = actors.get(name)
  if (known) return { kind: known.kind, role: known.role, parent: known.parent }
  const slash = name.lastIndexOf('/')
  if (slash > 0) return { kind: 'agent', role: 'worker', parent: name.slice(0, slash) }
  const agent = AGENTS.some((a) => name.toLowerCase().includes(a))
  return agent ? { kind: 'agent', role: 'worker', parent: '' } : { kind: 'human', role: 'human', parent: '' }
}

/** What each role's badge says: a worker is just an agent. */
export const ROLE_LABEL: Record<WhoRole, string> = {
  human: 'Human',
  orchestrator: 'Orchestrator',
  worker: 'Agent',
  board: 'Board',
}

/** A name and every name above it, nearest first: `orch/worker-2 (Agent) ← orch (Orchestrator)`. */
export function chainOf(name: string, who: (name: string) => Who): string {
  const links: string[] = []
  const seen = new Set<string>()
  for (let at = name; at && !seen.has(at) && links.length < 6; at = who(at).parent) {
    seen.add(at)
    links.push(`${at} (${ROLE_LABEL[who(at).role]})`)
  }
  return links.join(' ← ')
}
