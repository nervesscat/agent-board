import type { ActorRole, ActorRow } from '#/server/actors'

/** Who a name is: how it signs in, its role and the name it works under ('' for none). */
export type Who = Pick<ActorRow, 'kind' | 'role' | 'parent'>

const AGENTS = ['claude', 'codex', 'opencode', 'gemini', 'cursor', 'agent', 'bot']

/**
 * Who `name` is, from the board's actors (`/api/actors`, as each name was last seen): an agent token is
 * an agent (an orchestrator or a worker), the browser's passkey session is the human. A name it never
 * saw that has a `/` is a worker sub-identity under the name before the last `/`; any other is a guess
 * by the name (history from before the board kept track).
 */
export function whoOf(name: string, actors: ReadonlyMap<string, Who>): Who {
  const known = actors.get(name)
  if (known) return { kind: known.kind, role: known.role, parent: known.parent }
  const slash = name.lastIndexOf('/')
  if (slash > 0) return { kind: 'agent', role: 'worker', parent: name.slice(0, slash) }
  const agent = AGENTS.some((a) => name.toLowerCase().includes(a))
  return agent ? { kind: 'agent', role: 'worker', parent: '' } : { kind: 'human', role: 'human', parent: '' }
}

/** What each role's badge says: a worker is just an agent. */
export const ROLE_LABEL: Record<ActorRole, string> = {
  human: 'Human',
  orchestrator: 'Orchestrator',
  worker: 'Agent',
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
