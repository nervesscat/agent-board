import { and, eq, isNull, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import { listCards, type AgentCard } from '../agentCards'
import { listJobs, type JobState } from '../jobs'
import { getProject } from '../projects'
import {
  applies,
  findAlertType,
  snoozeOptionsOf,
  type AlertButton,
  type AlertGroup,
  type AlertSeverity,
} from './registry'

/**
 * The notification feed of one project: the board's jobs, the agent cards (tracked requests and
 * notices) and the active alerts, all as one list of the same item shape, newest first. The old
 * endpoints for jobs and cards stay as they are; this one merges them for the top bar.
 */

export type FeedSource = 'job' | 'tracked' | 'notice' | 'alert'

export interface FeedItem {
  /** Stable across polls: `job-3`, `card-7`, `alert-12`. */
  key: string
  source: FeedSource
  id: number
  /** The alert type, on an alert. */
  type?: string
  severity: AlertSeverity
  title: string
  body?: string
  /** Where the item happened: a board path or an absolute http(s) URL. */
  href?: string
  /** When it started (an alert: when it was raised). */
  at: string
  /** An alert the human has not seen yet; jobs and cards are never "new" in this sense. */
  isNew: boolean
  buttons: AlertButton[]
  progress?: { done: number; total: number }
  /** A job's or tracked card's state; `notice` on a notice. */
  state?: 'running' | 'succeeded' | 'failed' | 'notice'
  /** An alert's group. */
  group?: AlertGroup
  /** Extra lines under an alert's body. */
  details?: string[]
  /** Whether the human can dismiss it (an alert type may refuse). */
  dismissible: boolean
  /** The snooze menu in milliseconds; empty when the item cannot be snoozed. */
  snoozeOptions: number[]
  /** Whether this kind can be muted for the project. */
  mutable: boolean
  /** The alert type's label, for the "mute" item. */
  typeLabel?: string
  /** The job or card itself, for what only they show ("You asked: …", a cleanup's kept items). */
  job?: JobState
  card?: AgentCard
}

export interface FeedCaller {
  /** An agent's name: it sees its own jobs and cards and no alerts; absent for the human. */
  agent?: string | null
}

const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/** Whether an alert row is on show: not resolved, dismissed or snoozed, and its type not muted here. */
export function visibleAlerts(projectId: number, at = Date.now()) {
  const muted = new Set(
    db
      .select()
      .from(schema.alertMutes)
      .where(eq(schema.alertMutes.projectId, projectId))
      .all()
      .map((m) => m.type),
  )
  return db
    .select()
    .from(schema.alerts)
    .where(
      and(
        isNull(schema.alerts.resolvedAt),
        isNull(schema.alerts.dismissedAt),
        or(isNull(schema.alerts.projectId), eq(schema.alerts.projectId, projectId)),
      ),
    )
    .all()
    .filter((row) => !row.snoozedUntil || Date.parse(row.snoozedUntil) <= at)
    .filter((row) => !muted.has(row.type))
    .flatMap((row) => {
      const type = findAlertType(row.type)
      return type && applies(type) ? [{ row, type }] : []
    })
}

export function notificationFeed(projectId: number, caller: FeedCaller = {}, at = Date.now()): FeedItem[] {
  getProject(projectId)
  const agent = caller.agent ?? null
  const items: FeedItem[] = []
  const plain = { buttons: [], isNew: false, dismissible: true, snoozeOptions: [], mutable: false }

  for (const job of listJobs(projectId, { agent })) {
    items.push({
      ...plain,
      key: `job-${job.id}`,
      source: 'job',
      id: job.id,
      severity: job.state === 'failed' ? 'problem' : 'info',
      title: job.title,
      body: job.state === 'failed' ? (job.reason ?? undefined) : (job.step ?? undefined),
      href: job.href ?? undefined,
      at: job.startedAt,
      progress: { done: job.done, total: job.total },
      state: job.state,
      job,
    })
  }
  for (const card of listCards(projectId, { agent })) {
    if (card.kind === 'notice')
      items.push({
        ...plain,
        key: `card-${card.id}`,
        source: 'notice',
        id: card.id,
        severity: 'warning',
        title: card.title,
        body: card.body,
        href: card.href ?? undefined,
        at: card.startedAt,
        state: 'notice',
        card,
      })
    else
      items.push({
        ...plain,
        key: `card-${card.id}`,
        source: 'tracked',
        id: card.id,
        severity: card.state === 'failed' ? 'problem' : card.stale ? 'warning' : 'info',
        title: card.title,
        body: card.state === 'failed' ? (card.reason ?? undefined) : (card.result ?? card.step ?? undefined),
        href: card.href ?? undefined,
        at: card.startedAt,
        progress: card.total > 0 ? { done: card.done, total: card.total } : undefined,
        state: card.state,
        card,
      })
  }
  if (agent === null)
    for (const { row, type } of visibleAlerts(projectId, at)) {
      items.push({
        key: `alert-${row.id}`,
        source: 'alert',
        id: row.id,
        type: row.type,
        severity: row.severity,
        title: row.title,
        body: row.body || undefined,
        at: row.createdAt,
        isNew: row.seenAt === null,
        buttons: parse<AlertButton[]>(row.buttons, []),
        group: type.group,
        details: parse<{ details?: string[] }>(row.data, {}).details ?? [],
        dismissible: type.dismissible ?? true,
        snoozeOptions: snoozeOptionsOf(type),
        mutable: true,
        typeLabel: type.label,
      })
    }
  return items.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
}
