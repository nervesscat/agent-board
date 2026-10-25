import { and, eq, inArray, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { autoPhaseOf } from '#/lib/autoPhases'
import { listActors } from './actors'
import { type getTicketWithPush, summaryStandIn } from './features'
import { lastCommitAt } from './git'
import type { ManagedPreview } from './managedPreview'
import { isLocalUrl, previewState } from './preview'
import type { CiState } from './prs'
import type { Push } from './push'
import { ticketRepo } from './repos'
import { kindOf, listStages } from './stages'

/**
 * What a ticket handed to review still lacks: the parts of the hand-off the board can see for itself
 * (the implementation's tasks all done, a PR, the branch on origin, a preview that runs, the ticket's
 * summary written after the last commit, CI that is not red). Warnings only: moving to review is never refused for them.
 * Above them, whether the branch is merged yet: merging is the human's step, so it is listed but never
 * missing.
 */

/** Stable codes, for agents to act on; the text is for people. */
export type HandoffCode =
  | 'not_merged'
  | 'tasks_open'
  | 'no_pr'
  | 'not_pushed'
  | 'no_preview'
  | 'no_handoff_post'
  | 'checks_unknown'

export interface HandoffCheck {
  code: HandoffCode
  /** The item as the ticket page's checklist names it. */
  label: string
  ok: boolean
  /** What was found, or what is missing. */
  text: string
}

export interface Handoff {
  /** The checks that failed, in checklist order; never `not_merged`, which waits on the human. */
  missing: { code: HandoffCode; text: string }[]
  /** Every item, met or not, Merged first; CI only when the PR has checks. */
  checks: HandoffCheck[]
}

/** What the checks go by, gathered from the ticket, git, the previews and the PR queue. */
export interface HandoffFacts {
  branch: string
  /**
   * The implementation's tasks and subtasks, with those of its lanes that are not cancelled: its rollup,
   * without the Merged phases (merging is the human's step, done after the hand-off).
   */
  tasks: { done: number; total: number }
  /**
   * The PR it was opened as (by prNumber or its branch), with CI from the PR queue when it is there,
   * and whether the queue saw it merged on GitHub. `localCi`: a "CI run locally: green" comment names
   * its head, which counts as CI passing whatever GitHub's checks say.
   */
  pr: { number: number; ci: CiState | null; merged: boolean; localCi?: boolean } | null
  push: Pick<Push, 'state' | 'ahead' | 'into'>
  /** Each workspace's preview: its link, and whether the board runs it or it answers. */
  previews: { url: string; running: boolean }[]
  /** When the branch's last commit was made; null without a branch, or when git cannot tell. */
  lastCommitAt: string | null
  /** What the summary must come after when there is no commit to go by: when work last started. */
  since: string
  /** The ticket's own posts; `summary` marks the versions of its summary. */
  posts: { author: string; progress: boolean; handoff: boolean; summary: boolean; createdAt: string }[]
  /** The names the human signs in under: what they write is not a hand-off. */
  humans: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const time = (iso: string) => Date.parse(iso)

/** The checklist for a ticket, from what is known about it. */
export function handoffOf(f: HandoffFacts): Handoff {
  const checks: HandoffCheck[] = []
  const check = (code: HandoffCode, label: string, ok: boolean, text: string) =>
    checks.push({ code, label, ok, text })

  const p = f.push
  check(
    'not_merged',
    'Merged',
    Boolean(f.pr?.merged) || p.state === 'merged',
    f.pr?.merged
      ? `PR #${f.pr.number} merged`
      : p.state === 'merged'
        ? `Merged into ${p.into ?? 'its base'}`
        : 'Not merged yet',
  )

  const { done, total } = f.tasks
  check(
    'tasks_open',
    'Implementation',
    total > 0 && done === total,
    total
      ? `${done} of ${plural(total, 'task')} done`
      : 'No tasks: add the default phases (Implementation, then Pushed, PR, CI, Preview, Merged), put the steps under Implementation, and tick each step as you finish it (the board ticks Pushed, PR, CI, Preview and Merged itself)',
  )

  check(
    'no_pr',
    'PR',
    Boolean(f.pr),
    f.pr ? `PR #${f.pr.number}` : 'No PR: none set and none open on the branch',
  )

  check(
    'not_pushed',
    'Pushed',
    p.state === 'pushed' || p.state === 'merged' || p.state === 'remote-only',
    p.state === 'pushed'
      ? 'Branch pushed'
      : p.state === 'merged'
        ? `Merged into ${p.into ?? 'its base'}`
        : p.state === 'remote-only'
          ? 'On origin (no local branch)'
          : p.state === 'ahead'
            ? `${plural(p.ahead, 'commit')} not pushed`
            : p.state === 'local-only'
              ? 'Branch not on origin'
              : f.branch
                ? `Branch ${f.branch} not found`
                : 'No branch set',
  )

  const running = f.previews.find((v) => v.running)
  check(
    'no_preview',
    'Preview',
    Boolean(running),
    running
      ? `Running at ${running.url}`
      : f.previews.length
        ? 'Preview not running'
        : 'No preview: none started, or say in the summary why it cannot be tried',
  )

  const after = f.lastCommitAt ?? f.since
  const since = f.lastCommitAt ? 'the last commit' : 'work started'
  const handoff = handoffPost(f, after)
  check(
    'no_handoff_post',
    'Summary',
    Boolean(handoff),
    handoff
      ? handoff.summary
        ? `Summary updated by ${handoff.author} after ${since}`
        : `No summary yet; progress post by ${handoff.author} after ${since}`
      : `No summary since ${since}`,
  )

  const ci = f.pr?.localCi ? 'passing' : f.pr?.ci
  if (ci === 'failing' || ci === 'pending')
    check(
      'checks_unknown',
      'CI',
      false,
      ci === 'failing' ? "The PR's CI is failing" : "The PR's CI is still running",
    )
  else if (ci === 'passing')
    check(
      'checks_unknown',
      'CI',
      true,
      f.pr?.localCi ? 'CI run locally: green on the head' : "The PR's CI passed",
    )

  // Merging is the human's step: a branch not merged yet is pending, not something the hand-off lacks.
  const missing = checks.filter((c) => !c.ok && c.code !== 'not_merged')
  return { missing: missing.map(({ code, text }) => ({ code, text })), checks }
}

/**
 * What hands the ticket off after `after`: a version of its summary written by an agent then. A ticket
 * whose summary was never written goes by what stood for one before there were summaries (the post
 * summaryStandIn picks): any progress post by an agent after `after`, a resume note's versions aside.
 * Once a summary exists only the summary counts.
 */
function handoffPost(f: HandoffFacts, after: string) {
  const fresh = (u: HandoffFacts['posts'][number]) =>
    !f.humans.includes(u.author) && time(u.createdAt) >= time(after)
  if (f.posts.some((u) => u.summary)) return f.posts.find((u) => u.summary && fresh(u))
  return summaryStandIn(f.posts.filter(fresh), f.humans)
}

type TicketWithPush = Awaited<ReturnType<typeof getTicketWithPush>>

/** Every running preview counts: one the board runs, or a link that answers (one off this machine is taken on trust). */
export async function workspacePreviews(
  workspaces: { previewUrl: string; managedPreview: ManagedPreview | null }[],
): Promise<HandoffFacts['previews']> {
  return Promise.all(
    workspaces
      .filter((w) => w.previewUrl || w.managedPreview?.status === 'running')
      .map(async (w) => {
        const url = w.managedPreview?.url ?? w.previewUrl
        if (w.managedPreview?.status === 'running') return { url, running: true }
        if (!isLocalUrl(w.previewUrl)) return { url, running: true }
        return { url, running: (await previewState(w.previewUrl)).running }
      }),
  )
}

/**
 * The ticket's rollup without the Merged phases of it and of its lanes that are not cancelled (the
 * rollup's scope): the hand-off's Implementation item.
 */
function handoffTasks(t: TicketWithPush): HandoffFacts['tasks'] {
  const stages = listStages(t.projectId)
  const all = db
    .select({ id: schema.tickets.id, parentId: schema.tickets.parentId, status: schema.tickets.status })
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, t.projectId))
    .all()
  const ids: number[] = []
  for (const queue = [t.id]; queue.length; ) {
    const id = queue.shift()!
    ids.push(id)
    for (const lane of all)
      if (lane.parentId === id && kindOf(stages, lane.status) !== 'cancelled') queue.push(lane.id)
  }
  const merged = db
    .select()
    .from(schema.tasks)
    .where(and(inArray(schema.tasks.ticketId, ids), isNull(schema.tasks.parentId)))
    .all()
    .filter((task) => autoPhaseOf(task) === 'Merged')
  return {
    done: t.rollup.done - merged.filter((task) => task.done).length,
    total: t.rollup.total - merged.length,
  }
}

/** The checklist for a ticket read with `getTicketWithPush` (its feed, workspaces, PR and push state). */
export async function ticketHandoff(t: TicketWithPush): Promise<Handoff> {
  const repo = ticketRepo(t)
  const [previews, last] = await Promise.all([
    workspacePreviews(t.workspaces),
    repo && t.branch ? lastCommitAt(repo.repoPath, t.branch).catch(() => null) : null,
  ])
  return handoffOf({
    branch: t.branch,
    tasks: handoffTasks(t),
    pr: t.pr
      ? {
          number: t.pr.number,
          ci: t.pr.queue?.ci ?? null,
          merged: t.pr.queue?.status === 'done',
          localCi: t.pr.queue?.localCi ?? false,
        }
      : null,
    push: t.push,
    previews,
    lastCommitAt: last,
    since: t.startedAt ?? t.createdAt,
    posts: t.updates.filter((u) => u.ticketId === t.id),
    humans: listActors().flatMap((a) => (a.kind === 'human' ? [a.name] : [])),
  })
}
