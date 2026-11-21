import type { Project } from '#/db/schema'
import {
  ALERT_GROUPS,
  ALERT_GROUP_LABELS,
  ALERT_SEVERITIES,
  type AlertGroup,
  type AlertSeverity,
} from '#/lib/alerts'

import { alertTypes as housekeeping } from './housekeeping'
import { alertTypes as machine } from './machine'
import { alertTypes as setup } from './setup'
import { alertTypes as work } from './work'

/**
 * The alert registry: every kind of alert the board can raise is one `AlertType`, kept in the file of
 * its group (`setup.ts`, `work.ts`, `machine.ts`, `housekeeping.ts`). A type only says what is wrong
 * right now (`check`); the evaluator (evaluate.ts) turns that into rows that remember what the human did
 * with them (seen, dismissed, snoozed), and the notification feed (feed.ts) shows the rows.
 */

export { ALERT_GROUPS, ALERT_GROUP_LABELS, ALERT_SEVERITIES, type AlertGroup, type AlertSeverity }

/** A button on an alert. Snooze and Dismiss are not buttons: every alert has them. */
export type AlertButton =
  /** Opens a board path (`/projects/3/cleanup`). */
  | { id: string; label: string; kind: 'link'; href: string }
  /** Copies `text` (a command to run) to the clipboard. */
  | { id: string; label: string; kind: 'copy'; text: string }
  /** Runs the type's handler of the same id on the server. */
  | { id: string; label: string; kind: 'action'; primary?: boolean }

/** What one `check` found wrong right now. One candidate per `subject` of its type and project. */
export interface AlertCandidate {
  /** What the alert is about inside its type; leave out when the type raises at most one. */
  subject?: string
  severity: AlertSeverity
  title: string
  body?: string
  /** Extra lines under the body. */
  details?: string[]
  buttons?: AlertButton[]
}

/** What a check (and an action) is handed. Lanes may need more: it is passed in by the evaluator's caller. */
export interface AlertContext {
  /** The project being checked; null for a board-wide type, which is checked once. */
  projectId: number | null
  /** The clock: injected in tests. */
  now: () => number
  projects: {
    list: () => Project[]
    get: (id: number) => Project | undefined
  }
}

export interface AlertActionContext extends AlertContext {
  alert: {
    id: number
    type: string
    subject: string
    projectId: number | null
    data: Record<string, unknown>
  }
}

/** What an action handler answers: a message for the toast, and whether the alert is done. */
export interface AlertActionResult {
  /** False when the action did not do what the button promises: the message is then shown as a failure. */
  ok?: boolean
  message?: string
  resolve?: boolean
}

export interface AlertType {
  /** Kebab-case id, unique across the registry. */
  type: string
  /** The number of the idea it implements. */
  idea: number
  group: AlertGroup
  /** The short name in the mute list. */
  label: string
  /** One line saying when it is raised, for the mute list. */
  description: string
  /** `project`: checked once per project. `board`: checked once, and shown in every project. */
  scope: 'project' | 'board'
  /** Whether this board can ever raise it (a remote-only alert says no on a local board); default yes. */
  applies?: () => boolean
  /** The alerts that hold right now. A check that throws or takes over 10 s leaves its alerts as they are. */
  check: (ctx: AlertContext) => AlertCandidate[] | Promise<AlertCandidate[]>
  /** Handlers of the buttons of kind `action`, by button id. */
  actions?: Record<
    string,
    (ctx: AlertActionContext) => AlertActionResult | void | Promise<AlertActionResult | void>
  >
  /** The snooze menu in milliseconds; default an hour, a day and a week. */
  snoozeOptions?: number[]
  /** Whether the alert can be dismissed; default yes. */
  dismissible?: boolean
  /** A dismissal survives the alert resolving and coming back: "do not ask again". */
  stickyDismiss?: boolean
}

export const HOUR_MS = 60 * 60_000
export const DEFAULT_SNOOZE_OPTIONS = [HOUR_MS, 24 * HOUR_MS, 7 * 24 * HOUR_MS]

const added: AlertType[] = []

/** Every registered type, in group order and then the order they were declared. */
export function allAlertTypes(): AlertType[] {
  const all = [...setup, ...work, ...machine, ...housekeeping, ...added]
  return ALERT_GROUPS.flatMap((group) => all.filter((t) => t.group === group))
}

/** The types this board can raise. */
export const applicableAlertTypes = () => allAlertTypes().filter(applies)

export const applies = (t: AlertType) => (t.applies ? t.applies() : true)

export const findAlertType = (type: string) => allAlertTypes().find((t) => t.type === type)

export const snoozeOptionsOf = (t: AlertType) => t.snoozeOptions ?? DEFAULT_SNOOZE_OPTIONS

/** Adds a type for the length of a test (or a test-mode board); the returned function removes it again. */
export function registerForTest(type: AlertType): () => void {
  if (findAlertType(type.type)) throw new Error(`alert type ${type.type} is already registered`)
  added.push(type)
  return () => {
    const at = added.indexOf(type)
    if (at >= 0) added.splice(at, 1)
  }
}
