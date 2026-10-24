import { and, asc, desc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'

export type ActorKind = 'agent' | 'human'
/**
 * What a caller may do. The human is the human; an agent token is a worker unless the human made it an
 * orchestrator (Settings > Agents), and a sub-identity `<token>/<name>` is always a worker.
 */
export type ActorRole = 'human' | 'orchestrator' | 'worker'
/** An agent's role, the one an agent token carries. */
export type AgentRole = Exclude<ActorRole, 'human'>
export const AGENT_ROLES = ['orchestrator', 'worker'] as const satisfies readonly AgentRole[]

export interface ActorRow {
  name: string
  kind: ActorKind
  role: ActorRole
  /** The name a sub-identity works under (the part of its name before the last `/`); '' for none. */
  parent: string
  /** When it last signed in, to the minute; null for the board's own name before it wrote anything. */
  lastSeenAt: string | null
}

// The name the board writes as itself: claude, the author of the reports it generates.
const BUILT_IN: Record<string, ActorKind> = { claude: 'agent' }

const known = new Map<string, { key: string; at: number }>()

/**
 * Remember how a name signed in, its role and parent, and when. Written when it is new or changed, and
 * at most once a minute otherwise, not on every request. A human's role is not kept: it reads as human.
 */
export function noteActor(name: string, kind: ActorKind, role: ActorRole = 'worker', parent = '') {
  const stored: AgentRole = role === 'human' ? 'worker' : role
  const key = `${kind}|${stored}|${parent}`
  const last = known.get(name)
  if (last?.key === key && Date.now() - last.at < 60_000) return
  const now = new Date().toISOString()
  db.insert(schema.actors)
    .values({ name, kind, lastSeenAt: now, role: stored, parent })
    .onConflictDoUpdate({ target: schema.actors.name, set: { kind, lastSeenAt: now, role: stored, parent } })
    .run()
  known.set(name, { key, at: Date.now() })
}

/**
 * The role the human gave the agent token `name`, onto its row as last seen (not its sub-identities,
 * which stay workers). Its next request writes it again only if it differs.
 */
export function setActorRole(name: string, role: AgentRole) {
  db.update(schema.actors)
    .set({ role })
    .where(and(eq(schema.actors.name, name), eq(schema.actors.kind, 'agent'), eq(schema.actors.parent, '')))
    .run()
  known.delete(name)
}

export function listActors(): ActorRow[] {
  const rows = db
    .select({
      name: schema.actors.name,
      kind: schema.actors.kind,
      role: schema.actors.role,
      parent: schema.actors.parent,
      lastSeenAt: schema.actors.lastSeenAt,
    })
    .from(schema.actors)
    .orderBy(asc(schema.actors.name))
    .all()
    .map((r): ActorRow => (r.kind === 'human' ? { ...r, role: 'human', parent: '' } : r))
  const names = new Set(rows.map((r) => r.name))
  return [
    ...rows,
    ...Object.entries(BUILT_IN)
      .filter(([n]) => !names.has(n))
      .map(([name, kind]): ActorRow => ({ name, kind, role: 'worker', parent: '', lastSeenAt: null })),
  ]
}

/** Whether `name` signs in as the human (a passkey); a name the board never saw sign in does not. */
export function isHumanName(name: string): boolean {
  return (
    db.select({ kind: schema.actors.kind }).from(schema.actors).where(eq(schema.actors.name, name)).get()
      ?.kind === 'human'
  )
}

/** The human the board saw sign in most recently: who a request is in development with sign-in off. */
export function lastHuman(): string | null {
  return (
    db
      .select({ name: schema.actors.name })
      .from(schema.actors)
      .where(eq(schema.actors.kind, 'human'))
      .orderBy(desc(schema.actors.lastSeenAt))
      .limit(1)
      .get()?.name ?? null
  )
}
