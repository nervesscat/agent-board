import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm'

import { db, schema } from '#/db'
import { getProject, listProjects } from '../projects'
import {
  applicableAlertTypes,
  findAlertType,
  type AlertCandidate,
  type AlertContext,
  type AlertType,
} from './registry'

/** A check that takes longer than this is given up on for the run: its alerts stay as they are. */
export const CHECK_TIMEOUT_MS = 10_000

export interface EvaluateOptions {
  /** Only this project's types (the board-wide ones are left out unless `type` names one). */
  projectId?: number
  /** Only this type. */
  type?: string
  /** The clock, for tests; the context's `now` too. */
  now?: () => number
  /** How long a check may take, for tests; default 10 s. */
  timeoutMs?: number
  /** Lets a lane's checks reach their edges (a fake `gh`, a clock) beyond what every check is handed. */
  context?: Partial<AlertContext>
}

export interface AlertRef {
  id: number
  type: string
  projectId: number | null
  subject: string
}

export interface EvaluateResult {
  /** Alerts that started: inserted, or back after resolving. */
  started: AlertRef[]
  updated: AlertRef[]
  resolved: AlertRef[]
  /** The types (with their project) whose check threw or timed out. */
  failed: { type: string; projectId: number | null; error: string }[]
}

const json = (value: unknown) => JSON.stringify(value)

/** A check with a deadline. The check itself cannot be stopped: its late answer is dropped. */
function withTimeout<T>(run: () => T | Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
    timer.unref()
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}

/**
 * Runs the applicable types' checks and reconciles each answer with the rows of its type and project:
 * a new candidate becomes a row (not seen), a known one refreshes its words and buttons and keeps what
 * the human did with it, one that is gone is resolved (and hidden), and one that comes back after being
 * resolved starts again as new, its dismissal and snooze cleared unless the type is sticky.
 * A check that throws or hangs is logged and its alerts are left as they are.
 */
export async function evaluateAlerts(opts: EvaluateOptions = {}): Promise<EvaluateResult> {
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS
  const result: EvaluateResult = { started: [], updated: [], resolved: [], failed: [] }
  const projects = () => listProjects()
  const base = {
    now,
    projects: { list: projects, get: (id: number) => tryProject(id) },
    ...opts.context,
  }

  for (const type of applicableAlertTypes()) {
    if (opts.type && type.type !== opts.type) continue
    let scopes: (number | null)[]
    if (type.scope === 'board') {
      if (opts.projectId !== undefined && !opts.type) continue
      scopes = [null]
    } else {
      scopes = opts.projectId !== undefined ? [opts.projectId] : projects().map((p) => p.id)
    }
    for (const projectId of scopes) {
      if (projectId !== null && !tryProject(projectId)) continue
      const ctx: AlertContext = { ...base, projectId }
      let candidates: AlertCandidate[]
      try {
        candidates = await withTimeout(() => type.check(ctx), timeoutMs, `alert check ${type.type}`)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error(`alerts: ${type.type}${projectId === null ? '' : ` (project ${projectId})`}: ${error}`)
        result.failed.push({ type: type.type, projectId, error })
        continue
      }
      reconcile(type, projectId, candidates, new Date(now()).toISOString(), result)
    }
  }
  pruneResolved(now())
  return result
}

/** How long a resolved row is kept: a condition that comes back within it starts the same row again. */
export const KEEP_RESOLVED_MS = 30 * 24 * 60 * 60_000

/** Deletes rows resolved for longer than that, except a sticky dismissal, which is kept for good. */
function pruneResolved(at: number) {
  const old = db
    .select()
    .from(schema.alerts)
    .where(
      and(
        isNotNull(schema.alerts.resolvedAt),
        lt(schema.alerts.resolvedAt, new Date(at - KEEP_RESOLVED_MS).toISOString()),
      ),
    )
    .all()
  for (const row of old) {
    if (row.dismissedAt && findAlertType(row.type)?.stickyDismiss) continue
    db.delete(schema.alerts).where(eq(schema.alerts.id, row.id)).run()
  }
}

function tryProject(id: number) {
  try {
    return getProject(id)
  } catch {
    return undefined
  }
}

const rowsOf = (type: string, projectId: number | null) =>
  db
    .select()
    .from(schema.alerts)
    .where(
      and(
        eq(schema.alerts.type, type),
        projectId === null ? isNull(schema.alerts.projectId) : eq(schema.alerts.projectId, projectId),
      ),
    )
    .all()

function reconcile(
  type: AlertType,
  projectId: number | null,
  candidates: AlertCandidate[],
  at: string,
  out: EvaluateResult,
) {
  // One candidate per subject: the last of two with the same subject wins.
  const wanted = new Map(candidates.map((c) => [c.subject ?? '', c]))
  const existing = new Map(rowsOf(type.type, projectId).map((row) => [row.subject, row]))
  const ref = (row: { id: number; subject: string }): AlertRef => ({
    id: row.id,
    type: type.type,
    projectId,
    subject: row.subject,
  })

  for (const [subject, c] of wanted) {
    const fields = {
      severity: c.severity,
      title: c.title,
      body: c.body ?? '',
      data: json({ details: c.details ?? [] }),
      buttons: json(c.buttons ?? []),
    }
    const row = existing.get(subject)
    if (!row) {
      const created = db
        .insert(schema.alerts)
        .values({ projectId, type: type.type, subject, ...fields, createdAt: at, updatedAt: at })
        .returning()
        .get()
      out.started.push(ref(created))
    } else if (row.resolvedAt) {
      // Back after resolving: a new alert, unless a sticky type keeps the human's "do not ask again".
      db.update(schema.alerts)
        .set({
          ...fields,
          createdAt: at,
          updatedAt: at,
          resolvedAt: null,
          seenAt: null,
          snoozedUntil: null,
          dismissedAt: type.stickyDismiss ? row.dismissedAt : null,
        })
        .where(eq(schema.alerts.id, row.id))
        .run()
      out.started.push(ref(row))
    } else if (
      row.severity !== fields.severity ||
      row.title !== fields.title ||
      row.body !== fields.body ||
      row.data !== fields.data ||
      row.buttons !== fields.buttons
    ) {
      db.update(schema.alerts)
        .set({ ...fields, updatedAt: at })
        .where(eq(schema.alerts.id, row.id))
        .run()
      out.updated.push(ref(row))
    }
  }

  for (const [subject, row] of existing) {
    if (wanted.has(subject) || row.resolvedAt) continue
    db.update(schema.alerts).set({ resolvedAt: at }).where(eq(schema.alerts.id, row.id)).run()
    out.resolved.push(ref(row))
  }
}

export const EVALUATE_EVERY_MS = 60_000
export const EVALUATE_FIRST_MS = 5_000

/** The background run: shortly after start and then every minute, one at a time. Returns what stops it. */
export function startAlertEvaluator(opts: { every?: number; first?: number } = {}) {
  let busy = false
  const run = () => {
    if (busy) return
    busy = true
    evaluateAlerts()
      .catch((err) => console.error('alerts:', err instanceof Error ? err.message : err))
      .finally(() => {
        busy = false
      })
  }
  let every: NodeJS.Timeout | undefined
  const first = setTimeout(() => {
    run()
    every = setInterval(run, opts.every ?? EVALUATE_EVERY_MS)
    every.unref()
  }, opts.first ?? EVALUATE_FIRST_MS)
  first.unref()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
