import { and, eq, inArray, lt, max, ne } from 'drizzle-orm'

import { db, schema } from '#/db'
import { localDate } from '#/lib/format'
import { dayBounds } from './activity'
import { memo } from './cleanup'
import { commitsSince, type Refs } from './git'
import { currentRefs } from './listings'
import { ticketRepo } from './repos'
import { type Stage, isWorking, listStages } from './stages'

/**
 * Where we left off: each ticket has one current resume note (`RESUME_TEMPLATE` in `#/lib/constants`
 * is how it reads), written at the end of a session for whoever picks the ticket up next. Every save
 * is also a handoff post in the feed. This module reads it back with what happened since.
 */

/** The ticket columns the resume note lives in; reads hand them out as `resume` instead. */
type ResumeColumn = 'resumeNote' | 'resumeAt' | 'resumeBy' | 'resumeSha'

export type ResumeTicket = Pick<
  schema.Ticket,
  'id' | 'projectId' | 'repoId' | 'status' | 'branch' | 'archivedAt' | 'startedAt' | ResumeColumn
>

export interface Resume {
  /** The note (markdown); '' when nobody wrote one. */
  note: string
  at: string | null
  by: string
  /** The ticket branch's head when the note was written; null when it was not there locally. */
  sha: string | null
  /** Commits on the ticket branch since `sha`; null when that cannot be told. */
  commitsSince: number | null
  /** The work moved on since the note: new commits on the branch, or a newer progress post. */
  stale: boolean
  /**
   * The ticket is being worked (an active, blocked or review stage), was already on a previous day,
   * and no note was written on or after the last day it was worked before today.
   */
  noHandoff: boolean
  /** Which day of work this is (1 on the day it started); null when it is not being worked. */
  day: number | null
}

/** What lists carry: whether there is a note and whether it holds, without the note itself. */
export type ResumeBrief = Pick<Resume, 'at' | 'stale' | 'noHandoff' | 'day'>

const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000)

const dayOf = (iso: string) => localDate(new Date(iso))

/**
 * The resume state of each ticket that needs no git: `noHandoff`, `day`, and whether a progress post
 * came after the note. Days are the server's local calendar days, as in the Daily module. Activity is
 * what the activity log has on the ticket, its handoff notes left out.
 */
export function handoffStates(tickets: ResumeTicket[], now = new Date()) {
  const ids = tickets.map((t) => t.id)
  const todayKey = localDate(now)
  const todayStart = dayBounds(todayKey).from
  // The last thing done on each ticket before today.
  const lastBefore = new Map<number, string>()
  // The newest progress post on each ticket, handoffs aside.
  const lastProgress = new Map<number, string>()
  if (ids.length) {
    for (const a of db
      .select({ id: schema.activity.refId, at: max(schema.activity.createdAt) })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.refType, 'ticket'),
          inArray(schema.activity.refId, ids),
          lt(schema.activity.createdAt, todayStart),
          ne(schema.activity.kind, 'handoff'),
        ),
      )
      .groupBy(schema.activity.refId)
      .all())
      if (a.id !== null && a.at) lastBefore.set(a.id, a.at)
    for (const u of db
      .select({ id: schema.updates.ticketId, at: max(schema.updates.createdAt) })
      .from(schema.updates)
      .where(
        and(
          inArray(schema.updates.ticketId, ids),
          eq(schema.updates.progress, true),
          eq(schema.updates.handoff, false),
        ),
      )
      .groupBy(schema.updates.ticketId)
      .all())
      if (u.at) lastProgress.set(u.id, u.at)
  }
  const stagesOf = new Map<number, Stage[]>()
  const stages = (projectId: number) => {
    if (!stagesOf.has(projectId)) stagesOf.set(projectId, listStages(projectId))
    return stagesOf.get(projectId)!
  }
  const out = new Map<number, { noHandoff: boolean; day: number | null; newerProgress: boolean }>()
  for (const t of tickets) {
    const working = !t.archivedAt && isWorking(stages(t.projectId), t.status)
    const startDay = working && t.startedAt ? dayOf(t.startedAt) : null
    const carried = startDay !== null && startDay < todayKey
    // The last day it was worked before today: at the latest, the day the work started.
    const lastDay = carried
      ? [startDay, lastBefore.has(t.id) ? dayOf(lastBefore.get(t.id)!) : ''].sort().at(-1)!
      : null
    out.set(t.id, {
      noHandoff: lastDay !== null && (!t.resumeAt || dayOf(t.resumeAt) < lastDay),
      day: startDay === null ? null : daysBetween(startDay, todayKey) + 1,
      newerProgress: Boolean(t.resumeAt && (lastProgress.get(t.id) ?? '') > t.resumeAt),
    })
  }
  return out
}

/** Commits between a note's sha and a branch head, by the two shas: the count never changes. */
const SINCE_MEMO_MAX = 2000
const sinceMemo = new Map<string, Promise<number>>()

/** A repo's branches and origin's, as one read of the repo shares them; null when git cannot list it. */
export type RefsOf = (repoPath: string) => Promise<Refs | null>

/**
 * The full resume state of each ticket: the note and who wrote it when, the commits on its branch since
 * (git, read-only, local branches only), `stale`, `noHandoff` and `day`. One ref listing per repo, as it
 * is now (`refsOf`, the read's own when it has one); commits are only counted for a branch that moved
 * since its note, once per pair of commits.
 */
export async function resumeStates(tickets: ResumeTicket[], now = new Date(), refsOf: RefsOf = currentRefs) {
  const facts = handoffStates(tickets, now)
  const refs = new Map<string, Promise<Map<string, string>>>()
  const heads = (repoPath: string) => {
    if (!refs.has(repoPath))
      refs.set(
        repoPath,
        refsOf(repoPath).then(
          (r) => r?.local ?? new Map<string, string>(),
          () => new Map<string, string>(),
        ),
      )
    return refs.get(repoPath)!
  }
  const counted = await Promise.all(
    tickets.map(async (t) => {
      if (!t.resumeSha || !t.branch || t.archivedAt) return null
      const repo = ticketRepo(t)
      if (!repo) return null
      const head = (await heads(repo.repoPath)).get(t.branch)
      if (!head) return null
      if (head === t.resumeSha) return 0
      // Counted between the listed head and the note's sha, not the branch as it is by then. A sha that
      // is no commit here reads as unknown, and is asked again next time.
      const sha = t.resumeSha
      return memo(sinceMemo, SINCE_MEMO_MAX, `${repo.repoPath}\0${sha}..${head}`, () =>
        commitsSince(repo.repoPath, sha, head),
      ).catch(() => null)
    }),
  )
  const out = new Map<number, Resume>()
  tickets.forEach((t, i) => {
    const f = facts.get(t.id)!
    const since = counted[i] ?? null
    out.set(t.id, {
      note: t.resumeNote,
      at: t.resumeAt,
      by: t.resumeBy,
      sha: t.resumeSha,
      commitsSince: since,
      stale: Boolean(t.resumeAt) && ((since ?? 0) > 0 || f.newerProgress),
      noHandoff: f.noHandoff,
      day: f.day,
    })
  })
  return out
}

/** One ticket's resume state: see `resumeStates`. `now` decides what "today" is. */
export async function resumeState(ticket: ResumeTicket, now = new Date(), refsOf?: RefsOf): Promise<Resume> {
  return (await resumeStates([ticket], now, refsOf)).get(ticket.id)!
}

/** The ticket without its resume columns. */
export function withoutResume<T extends Partial<Record<ResumeColumn, unknown>>>(t: T): Omit<T, ResumeColumn> {
  const { resumeNote: _note, resumeAt: _at, resumeBy: _by, resumeSha: _sha, ...rest } = t
  return rest
}

export type WithResume<T> = Omit<T, ResumeColumn> & { resume: Resume }

/** A ticket as reads hand it out: its resume note and state under `resume`. */
export async function withResume<T extends ResumeTicket>(
  t: T,
  now = new Date(),
  refsOf?: RefsOf,
): Promise<WithResume<T>> {
  return { ...withoutResume(t), resume: await resumeState(t, now, refsOf) }
}

export type WithResumeBrief<T> = Omit<T, ResumeColumn> & { resume: ResumeBrief }

/** Tickets as lists hand them out: `resume` says whether there is a note and whether it holds. */
export async function withResumeBriefs<T extends ResumeTicket>(
  tickets: T[],
  now = new Date(),
  refsOf?: RefsOf,
): Promise<WithResumeBrief<T>[]> {
  const states = await resumeStates(tickets, now, refsOf)
  return tickets.map((t) => {
    const { at, stale, noHandoff, day } = states.get(t.id)!
    return { ...withoutResume(t), resume: { at, stale, noHandoff, day } }
  })
}
