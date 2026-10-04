import { and, asc, count, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { DEFAULT_STAGES, STAGE_KINDS, type StageColor, type StageKind } from '#/lib/constants'
import { logActivity } from './activity'
import { HttpError, notFound } from './http'

export type Stage = schema.Stage

/** Asked for by agents with the old fixed names; they mean the first stage of that kind. */
const KIND_ALIASES: Record<string, StageKind> = { todo: 'open', in_progress: 'active' }

/** A project's stages in board order. A project that has none yet gets the defaults. */
export function listStages(projectId: number): Stage[] {
  const read = () =>
    db
      .select()
      .from(schema.stages)
      .where(eq(schema.stages.projectId, projectId))
      .orderBy(asc(schema.stages.position), asc(schema.stages.id))
      .all()
  const rows = read()
  if (rows.length) return rows
  db.insert(schema.stages)
    .values(DEFAULT_STAGES.map((s, position) => ({ ...s, projectId, position })))
    .onConflictDoNothing()
    .run()
  return read()
}

export const firstOfKind = (stages: Stage[], kind: StageKind) => stages.find((s) => s.kind === kind)

/** The stage a ticket is in; a key no stage has any more reads as the first stage. */
export const stageOf = (stages: Stage[], key: string) => stages.find((s) => s.key === key) ?? stages[0]!

export const kindOf = (stages: Stage[], key: string): StageKind => stageOf(stages, key).kind

/**
 * Where a new ticket starts: the last open stage (the one just before work starts, To do rather than
 * Backlog), else the first stage.
 */
export const startStage = (stages: Stage[]) =>
  [...stages].reverse().find((s) => s.kind === 'open') ?? stages[0]!

/** The kinds of stage a ticket is being worked in: in these a ticket carries over from day to day. */
export const WORKING_KINDS: readonly StageKind[] = ['active', 'blocked', 'review']

export const isWorking = (stages: Stage[], key: string) => WORKING_KINDS.includes(kindOf(stages, key))

/**
 * The `startedAt` to write when a ticket moves from `from` (null: it is new) to `to`: now when it enters
 * work from any other kind of stage, or is in work without a start yet; nothing otherwise.
 */
export function startedPatch(
  stages: Stage[],
  from: string | null,
  to: string,
  startedAt: string | null = null,
): { startedAt?: string } {
  if (!isWorking(stages, to)) return {}
  return from === null || !isWorking(stages, from) || !startedAt
    ? { startedAt: new Date().toISOString() }
    : {}
}

/**
 * The stage an agent or the UI named: its key, else its name (any casing), else the first stage of
 * that kind (`review`, `done`, … and the old `todo` / `in_progress`; for open, the start stage).
 */
export function resolveStage(stages: Stage[], value: string): Stage {
  const v = value.trim().toLowerCase()
  const kind = KIND_ALIASES[v] ?? (STAGE_KINDS.includes(v as StageKind) ? (v as StageKind) : null)
  const found =
    stages.find((s) => s.key === value) ??
    stages.find((s) => s.key === v || s.name.toLowerCase() === v) ??
    (kind === 'open' ? startStage(stages) : kind ? firstOfKind(stages, kind) : undefined)
  if (!found)
    throw new HttpError(
      400,
      `no stage "${value}"; this project's stages are ${stages.map((s) => s.key).join(', ')}`,
    )
  return found
}

/**
 * The stage keys a status filter means: each value is a key or name, or else a kind, which takes in
 * every stage of that kind. Values that match nothing match no ticket.
 */
export function matchStages(stages: Stage[], values: string[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) {
    const v = value.trim().toLowerCase()
    const one = stages.find((s) => s.key === value || s.key === v || s.name.toLowerCase() === v)
    if (one) {
      out.add(one.key)
      continue
    }
    const kind = KIND_ALIASES[v] ?? v
    for (const s of stages) if (s.kind === kind) out.add(s.key)
  }
  return out
}

/** `QA review` → `qa_review`, unique in the project (`qa_review_2`, …). */
function newKey(stages: Stage[], name: string) {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'stage'
  const taken = new Set(stages.map((s) => s.key))
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`
  return key
}

function getStage(projectId: number, id: number) {
  const s = db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.id, id), eq(schema.stages.projectId, projectId)))
    .get()
  if (!s) throw notFound('stage')
  return s
}

const log = (projectId: number, actor: string, text: string) =>
  logActivity({ projectId, actor, kind: 'project', text, refType: 'project', refId: projectId })

/** Tickets per stage key, lanes included. */
export function stageCounts(projectId: number): Record<string, number> {
  const rows = db
    .select({ status: schema.tickets.status, n: count() })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .groupBy(schema.tickets.status)
    .all()
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}

export function createStage(
  projectId: number,
  input: { name: string; kind: StageKind; color?: StageColor },
  actor: string,
) {
  const stages = listStages(projectId)
  const row = db
    .insert(schema.stages)
    .values({
      projectId,
      key: newKey(stages, input.name),
      name: input.name.trim(),
      kind: input.kind,
      color: input.color ?? 'gray',
      position: (stages.at(-1)?.position ?? -1) + 1,
    })
    .returning()
    .get()
  log(projectId, actor, `added the stage ${row.name}`)
  return row
}

export function updateStage(
  projectId: number,
  id: number,
  patch: { name?: string; kind?: StageKind; color?: StageColor },
  actor: string,
) {
  const before = getStage(projectId, id)
  const row = db
    .update(schema.stages)
    .set({ ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) })
    .where(eq(schema.stages.id, id))
    .returning()
    .get()!
  const changes: string[] = []
  if (row.name !== before.name) changes.push(`renamed to ${row.name}`)
  if (row.kind !== before.kind) changes.push(`kind ${before.kind} → ${row.kind}`)
  if (row.color !== before.color) changes.push(`color ${row.color}`)
  if (changes.length) log(projectId, actor, `updated the stage ${before.name} (${changes.join(', ')})`)
  return row
}

/** Put the project's stages in this order; `ids` must be all of them. */
export function reorderStages(projectId: number, ids: number[], actor: string) {
  const stages = listStages(projectId)
  const same = ids.length === stages.length && stages.every((s) => ids.includes(s.id))
  if (!same) throw new HttpError(400, 'give every stage of the project, each once')
  db.transaction((tx) => {
    ids.forEach((id, position) =>
      tx.update(schema.stages).set({ position }).where(eq(schema.stages.id, id)).run(),
    )
  })
  log(projectId, actor, 'reordered the stages')
  return listStages(projectId)
}

/**
 * Remove a stage. Its tickets (lanes too) move to `moveTo` first, which is required when there are
 * any; the last stage of a project stays.
 */
export function deleteStage(projectId: number, id: number, opts: { moveTo?: string }, actor: string) {
  const stages = listStages(projectId)
  const stage = getStage(projectId, id)
  if (stages.length === 1) throw new HttpError(409, 'a project needs at least one stage')
  const held = stageCounts(projectId)[stage.key] ?? 0
  let target: Stage | undefined
  if (held) {
    if (!opts.moveTo)
      throw new HttpError(409, `${held} ticket${held === 1 ? '' : 's'} in ${stage.name}; say where they go`)
    target = stages.find((s) => s.key === opts.moveTo && s.id !== id)
    if (!target) throw new HttpError(400, `no other stage "${opts.moveTo}" to move them to`)
  }
  db.transaction((tx) => {
    if (target)
      tx.update(schema.tickets)
        .set({
          status: target.key,
          updatedAt: new Date().toISOString(),
          // Work starts for them when they go from a stage that is not one of work into one that is.
          ...(isWorking(stages, stage.key) ? {} : startedPatch(stages, stage.key, target.key)),
        })
        .where(and(eq(schema.tickets.projectId, projectId), eq(schema.tickets.status, stage.key)))
        .run()
    tx.delete(schema.stages).where(eq(schema.stages.id, id)).run()
  })
  log(
    projectId,
    actor,
    `deleted the stage ${stage.name}${target ? ` (moved ${held} ticket${held === 1 ? '' : 's'} to ${target.name})` : ''}`,
  )
}
