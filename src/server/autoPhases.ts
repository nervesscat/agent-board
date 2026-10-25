import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { type AutoPhase, autoPhaseOf } from '#/lib/autoPhases'
import { logActivity } from './activity'
import { workspacePreviews } from './handoff'
import { managedPreview, type ManagedPreview } from './managedPreview'
import { getProject } from './projects'
import { autoPrRow, ciGreen, prsKnown, prWasMerged } from './prs'
import { type Push, pushStates } from './push'
import { listRepos, ticketRepo } from './repos'
import { kindOf, listStages } from './stages'

/**
 * The hand-off phases the board ticks itself (`#/lib/autoPhases`): each follows a fact of git, GitHub or
 * the previews, ticked while it holds and unticked once a read shows it stopped holding. The facts are
 * read where the board already looks (a ticket's read, the project's push poll, each PR refresh), and
 * only the phases whose tick differs are written, each logged as the board's.
 */

/** What the rules go by; null (or, for the PR, undefined) where it is not known. */
export interface AutoFacts {
  /** The branch's push state; null without a repo, or when git could not tell. */
  push: Pick<Push, 'state'> | null
  /**
   * The ticket's PR as the queue holds it (open, merged or closed): null when it has none, undefined
   * when the board does not know the repo's PRs yet (no refresh, no rows). A row closed with no merge
   * time that GitHub has not called closed (`leftAs`) is not known either: the capped merged searches
   * may have missed its merge.
   */
  pr: Pick<schema.Pr, 'open' | 'mergedAt' | 'leftAs' | 'checks' | 'headSha' | 'localCiSha'> | null | undefined
  /** Whether a preview of one of the ticket's own workspaces runs, or its link answers. */
  preview: boolean
}

/** Each phase's rule: ticked, unticked, or null when its facts are not known (the tick stays). */
export type AutoTicks = Record<AutoPhase, boolean | null>

export function autoPhaseRules(f: AutoFacts): AutoTicks {
  const prMerged = f.pr ? prWasMerged(f.pr) : false
  const pr = f.pr && !f.pr.open && !prMerged && f.pr.leftAs !== 'CLOSED' ? undefined : f.pr
  const live = pr ? pr.open || prMerged : false
  const pushMerged = f.push?.state === 'merged'
  return {
    // Every local commit on origin (origin may be ahead), only origin has it, or it landed and went.
    Pushed: f.push
      ? f.push.state === 'pushed' || f.push.state === 'remote-only' || f.push.state === 'merged'
      : null,
    PR: pr === undefined ? null : live,
    CI: pr === undefined ? null : pr ? live && ciGreen(pr) : false,
    Preview: f.preview,
    // Either fact holding is enough; neither holding counts only when both were read.
    Merged: prMerged || pushMerged ? true : pr === undefined || f.push === null ? null : false,
  }
}

const ticked = (done: boolean) => (done ? { done, blocked: false, blockedReason: '' } : { done })

/** Bump a ticket and its parents, as a manual tick does. */
function touch(ticketId: number) {
  const row = db
    .update(schema.tickets)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(schema.tickets.id, ticketId))
    .returning({ parentId: schema.tickets.parentId })
    .get()
  if (row?.parentId) touch(row.parentId)
}

const topLevelTasks = (ticketId: number) =>
  db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.ticketId, ticketId), isNull(schema.tasks.parentId)))
    .orderBy(asc(schema.tasks.position), asc(schema.tasks.id))
    .all()

/**
 * Merged joined the built-in phases after tickets were seeded without it: a ticket that has the hand-off
 * phases (at least one automatic phase) and no Merged gets it once, at the end (before a Hand-off post
 * task, if one exists), when its project's list in effect has Merged. Each ticket is looked at once (its
 * `mergedPhaseChecked`), so a Merged removed on purpose stays removed. True when it added one.
 */
function addMissingMerged(t: schema.Ticket): boolean {
  if (t.mergedPhaseChecked || t.archivedAt) return false
  const name = getProject(t.projectId).defaultPhases.find((p) => p.trim().toLowerCase() === 'merged')
  const added = db.transaction(
    () => {
      const now = db.select().from(schema.tickets).where(eq(schema.tickets.id, t.id)).get()
      if (!now || now.mergedPhaseChecked) return false
      db.update(schema.tickets).set({ mergedPhaseChecked: true }).where(eq(schema.tickets.id, t.id)).run()
      // A closed ticket's work is over: an open Merged it may never tick would take it off 100%.
      const kind = kindOf(listStages(t.projectId), now.status)
      if (kind === 'done' || kind === 'cancelled') return false
      const tasks = topLevelTasks(t.id)
      const phases = tasks.map((task) => autoPhaseOf(task))
      if (!name || !phases.some(Boolean) || phases.includes('Merged')) return false
      const post = tasks.find((task) => task.text.trim().toLowerCase() === 'hand-off post')
      let position: number
      if (post) {
        position = post.position
        const later = db
          .select({ id: schema.tasks.id, position: schema.tasks.position })
          .from(schema.tasks)
          .where(eq(schema.tasks.ticketId, t.id))
          .all()
          .filter((task) => task.position >= position)
        for (const task of later)
          db.update(schema.tasks)
            .set({ position: task.position + 1 })
            .where(eq(schema.tasks.id, task.id))
            .run()
      } else {
        const last = db
          .select({ position: schema.tasks.position })
          .from(schema.tasks)
          .where(eq(schema.tasks.ticketId, t.id))
          .all()
        position = Math.max(-1, ...last.map((task) => task.position)) + 1
      }
      db.insert(schema.tasks).values({ ticketId: t.id, text: name.trim(), position }).run()
      return true
    },
    { behavior: 'immediate' },
  )
  if (added)
    logActivity({
      projectId: t.projectId,
      actor: 'board',
      kind: 'task',
      text: `added the phase "${name!.trim()}" to #${t.id} ${t.title}`,
      refType: 'ticket',
      refId: t.id,
    })
  return added
}

/**
 * Bring a ticket's automatic phases in line with `rules`: only a phase whose tick differs is written
 * (a tick clears its blocked tag), each change logged as the board's, and the ticket touched. Unknown
 * facts (null) change nothing. Once the work landed (Merged holds or is ticked, or the ticket is in a
 * done stage) phases are only ticked, never unticked: its previews stop, and it must not drop from
 * 100%. Never on an archived ticket or a PR's own ticket. True when it changed a task.
 */
export function reconcileAutoPhases(ticketId: number, rules: AutoTicks): boolean {
  const t = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get()
  if (!t || t.archivedAt || t.prId) return false
  const added = addMissingMerged(t)
  const phases = topLevelTasks(t.id).flatMap((task) => {
    const phase = autoPhaseOf(task)
    return phase ? [{ task, phase }] : []
  })
  if (!phases.length) return added
  const landed =
    rules.Merged === true ||
    phases.some((p) => p.phase === 'Merged' && p.task.done) ||
    kindOf(listStages(t.projectId), t.status) === 'done'
  const changed: { text: string; done: boolean }[] = []
  db.transaction(
    () => {
      for (const { task, phase } of phases) {
        const want = rules[phase]
        if (want === null || (!want && landed)) continue
        // Written against the tick as read: a write in between wins, the next pass looks again.
        const row = db
          .update(schema.tasks)
          .set(ticked(want))
          .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.done, !want)))
          .returning()
          .get()
        if (row) changed.push({ text: row.text, done: want })
      }
    },
    { behavior: 'immediate' },
  )
  if (!changed.length) return added
  touch(t.id)
  for (const c of changed)
    logActivity({
      projectId: t.projectId,
      actor: 'board',
      kind: 'task',
      text: `${c.done ? 'completed' : 'reopened'} "${c.text}" on #${t.id} ${t.title}`,
      refType: 'ticket',
      refId: t.id,
    })
  return true
}

type Workspace = { previewUrl: string; managedPreview: ManagedPreview | null }

/** The facts for a ticket, given its branch's push state as just read (null when there is no repo). */
async function factsOf(
  t: Pick<schema.Ticket, 'projectId' | 'repoId' | 'prNumber' | 'branch' | 'createdAt'>,
  push: Push | null,
  workspaces: Workspace[],
): Promise<AutoFacts> {
  const repo = ticketRepo(t)
  const previews = await workspacePreviews(workspaces)
  return {
    push: repo && push && !push.unknown ? push : null,
    pr: !repo
      ? undefined
      : !t.prNumber && !t.branch
        ? null
        : prsKnown(repo.id)
          ? autoPrRow(t, repo.id)
          : undefined,
    preview: previews.some((p) => p.running),
  }
}

/**
 * A ticket's automatic phases, from its read: its branch's push state (null without a repo) and its own
 * workspaces with their previews. True when a task changed.
 */
export async function reconcileTicket(
  t: Pick<
    schema.Ticket,
    'id' | 'projectId' | 'repoId' | 'prNumber' | 'branch' | 'createdAt' | 'archivedAt' | 'prId'
  >,
  push: Push | null,
  workspaces: Workspace[],
): Promise<boolean> {
  if (t.archivedAt || t.prId) return false
  return reconcileAutoPhases(t.id, autoPhaseRules(await factsOf(t, push, workspaces)))
}

/**
 * The automatic phases of a project's tickets, without anyone reading them: after a PR refresh, and on
 * the push poll (which hands over the push states it read, and its tickets in `only`). Archived,
 * cancelled and PR tickets are left out, and so are tickets without an automatic phase that were
 * already looked at for Merged.
 */
export async function reconcileProject(
  projectId: number,
  opts: { only?: number[]; pushes?: ReadonlyMap<number, Push> } = {},
) {
  const stages = listStages(projectId)
  const tickets = db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .all()
    .filter(
      (t) =>
        !t.archivedAt &&
        !t.prId &&
        kindOf(stages, t.status) !== 'cancelled' &&
        (!opts.only || opts.only.includes(t.id)),
    )
  if (!tickets.length) return
  const ids = tickets.map((t) => t.id)
  const tasks = db
    .select()
    .from(schema.tasks)
    .where(and(inArray(schema.tasks.ticketId, ids), isNull(schema.tasks.parentId)))
    .all()
  const auto = new Set(tasks.filter((task) => autoPhaseOf(task)).map((task) => task.ticketId))
  const due = tickets.filter((t) => auto.has(t.id))
  // Looked at once for Merged, even with nothing to tick.
  for (const t of tickets) if (!auto.has(t.id) && !t.mergedPhaseChecked) addMissingMerged(t)
  if (!due.length) return
  const repos = listRepos(projectId)
  const repoOf = (t: schema.Ticket) => (t.repoId ? repos.find((r) => r.id === t.repoId) : repos[0]) ?? null
  const pushes = new Map(opts.pushes)
  await Promise.all(
    repos.map(async (r) => {
      const mine = due.filter((t) => repoOf(t)?.id === r.id && !pushes.has(t.id))
      if (!mine.length) return
      const states = await pushStates(
        r.repoPath,
        mine.map((t) => t.branch),
        new Map(mine.map((t) => [t.branch, t.baseBranch])),
      )
      for (const t of mine) pushes.set(t.id, states.get(t.branch)!)
    }),
  )
  const workspaces = db.select().from(schema.workspaces).where(inArray(schema.workspaces.ticketId, ids)).all()
  await Promise.all(
    due.map(async (t) => {
      try {
        await reconcileTicket(
          t,
          repoOf(t) ? (pushes.get(t.id) ?? null) : null,
          workspaces
            .filter((w) => w.ticketId === t.id)
            .map((w) => ({ previewUrl: w.previewUrl, managedPreview: managedPreview(w.id) })),
        )
      } catch (err) {
        console.error(`ticking the automatic phases of #${t.id} failed:`, err)
      }
    }),
  )
}
