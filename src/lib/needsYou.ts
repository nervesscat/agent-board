import { useCallback, useEffect, useState } from 'react'

import type { ProjectSummary } from '#/lib/api'

/**
 * The Needs you entries this browser has already opened, so what the human has seen stops asking for
 * them: the smallest sound place for it, beside the board's other client-only choices (onboarding.ts,
 * HostToolsBanner.tsx). It is kept in localStorage per actor (another human signed in on the same
 * browser keeps their own) and per entry, never by list position.
 *
 * A key names the entry and the fact it showed (`thread:<parent>:<last post>`, `stalled:<ticket>:<silent
 * since>`): the same fact stays hidden across reloads and pages, and a changed one (a new reply, another
 * decision, a fresh stall) is a new key that shows again. Nothing is hidden but what was clicked.
 */

export type NeedsYou = ProjectSummary['needsYou']
type Decision = NeedsYou['decisions'][number]
type PrToReview = NeedsYou['prs'][number]
type Thread = NeedsYou['threads'][number]
type Review = NeedsYou['reviews'][number]
type BlockedTask = NeedsYou['blockedTasks'][number]
type InstructionChange = NeedsYou['instructionChanges'][number]
type Stalled = NeedsYou['stalled'][number]

/**
 * One key per entry: what it is, plus the fact it shows where the fact can change on its own. A review
 * and a blocked step are keyed by the ticket and the step (their update leaves the list or ticks the
 * step); a stall by when silence began, so the next stall asks again.
 */
export const needKeys = {
  decision: (d: Decision) => `decision:${d.postId}`,
  pr: (pr: PrToReview) => `pr:${pr.id}:${pr.updatedAt}`,
  thread: (th: Thread) => `thread:${th.parentType}:${th.parentId}:${th.last.id}`,
  review: (t: Review) => `review:${t.id}:${t.updatedAt}`,
  blockedTask: (task: BlockedTask) => `blocked:${task.taskId}`,
  instructionChange: (c: InstructionChange) => `instruction:${c.changeId}`,
  stalled: (s: Stalled) => `stalled:${s.ticketId}:${s.lastSignalAt}`,
}

/**
 * The project's summary with the entries already opened filed away, and `needsYou.total` counting what
 * is left, so the card, its count and Home's headline agree. The same summary object when nothing is
 * dismissed.
 */
export function undismissed(p: ProjectSummary, dismissed: ReadonlySet<string>): ProjectSummary {
  if (!dismissed.size) return p
  const n = p.needsYou
  const decisions = n.decisions.filter((d) => !dismissed.has(needKeys.decision(d)))
  const prs = n.prs.filter((pr) => !dismissed.has(needKeys.pr(pr)))
  const threads = n.threads.filter((th) => !dismissed.has(needKeys.thread(th)))
  const reviews = n.reviews.filter((t) => !dismissed.has(needKeys.review(t)))
  const blockedTasks = n.blockedTasks.filter((task) => !dismissed.has(needKeys.blockedTask(task)))
  const instructionChanges = n.instructionChanges.filter((c) => !dismissed.has(needKeys.instructionChange(c)))
  const stalled = n.stalled.filter((s) => !dismissed.has(needKeys.stalled(s)))
  const total =
    decisions.length +
    prs.length +
    threads.length +
    reviews.length +
    blockedTasks.length +
    instructionChanges.length +
    stalled.length
  if (total === n.total) return p
  return {
    ...p,
    needsYou: { decisions, prs, threads, reviews, blockedTasks, instructionChanges, stalled, total },
  }
}

/** How many entries the browser remembers per actor; the oldest go first. */
const KEPT = 200

const storageKey = (actor: string) => `needs-you-dismissed:${actor}`

function read(actor: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(actor)) ?? '[]')
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** The entries this browser has already opened for `actor`. */
export function recallDismissed(actor: string): ReadonlySet<string> {
  return new Set(read(actor))
}

/** Remembers `key` as opened for `actor`, and returns every key now: in memory alone when storage fails. */
export function rememberDismissed(actor: string, key: string): ReadonlySet<string> {
  const keys = read(actor).filter((k) => k !== key)
  keys.push(key)
  const kept = keys.slice(-KEPT)
  try {
    localStorage.setItem(storageKey(actor), JSON.stringify(kept))
  } catch {
    // Kept in memory, for this page only.
  }
  return new Set(kept)
}

const NOTHING: ReadonlySet<string> = new Set()

/**
 * What this browser remembers as opened for the actor signed in, in state so a click redraws at once.
 * Read after mount only: read while rendering, the browser's first render would disagree with the
 * server's (which has no storage), exactly as onboarding.ts does it.
 */
export function useDismissedNeeds(actor: string | undefined) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(NOTHING)
  useEffect(() => {
    setDismissed(actor ? recallDismissed(actor) : NOTHING)
  }, [actor])
  const dismiss = useCallback(
    (key: string) => {
      if (actor) setDismissed(rememberDismissed(actor, key))
    },
    [actor],
  )
  return [dismissed, dismiss] as const
}
