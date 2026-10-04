import { asc } from 'drizzle-orm'

import { db, schema } from '#/db'

export type ActorKind = 'agent' | 'human'

// The name the board writes as itself: claude's generated daily summaries.
const BUILT_IN: Record<string, ActorKind> = { claude: 'agent' }

const known = new Map<string, ActorKind>()

/** Remember how a name signed in. Written only when it is new or changed, not on every request. */
export function noteActor(name: string, kind: ActorKind) {
  if (known.get(name) === kind) return
  const now = new Date().toISOString()
  db.insert(schema.actors)
    .values({ name, kind, lastSeenAt: now })
    .onConflictDoUpdate({ target: schema.actors.name, set: { kind, lastSeenAt: now } })
    .run()
  known.set(name, kind)
}

export function listActors(): { name: string; kind: ActorKind }[] {
  const rows = db
    .select({ name: schema.actors.name, kind: schema.actors.kind })
    .from(schema.actors)
    .orderBy(asc(schema.actors.name))
    .all()
  const names = new Set(rows.map((r) => r.name))
  return [
    ...rows,
    ...Object.entries(BUILT_IN)
      .filter(([n]) => !names.has(n))
      .map(([name, kind]) => ({ name, kind })),
  ]
}
