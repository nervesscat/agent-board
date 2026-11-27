import crypto from 'node:crypto'

import { and, asc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { SendBackReason } from '#/lib/constants'
import { hasGitSide } from '#/lib/kinds'
import { isClosed } from '#/lib/stages'
import { activityOf } from '#/lib/workTimeline'
import { logActivity } from './activity'
import {
  baseChain,
  baseRefs,
  branchRef,
  gitCache,
  localRef,
  type GitCache,
  type RepoGit,
  memo,
  reachOf,
  refSha,
  refsKey,
} from './cleanup'
import * as features from './features'
import { holdsOwnWork, holdsWorkOf, isAncestor, refsMergedInto, type Reach, type Refs } from './git'
import { type OpenTask, openTasks } from './openTasks'
import { HttpError } from './http'
import { getProject } from './projects'
import { onRefsListed, readRefs } from './push'
import { listRepos } from './repos'
import { missingReports, missingReviewPhases, ticketReports } from './runReports'
import { historyOf } from './stageHistory'
import {
  deleteStage,
  lastOfKind,
  kindOf,
  listStages,
  projectWorkStage,
  resolveStage,
  stageOf,
} from './stages'
import { timelinesFor, workOf } from './workTimeline'

/**
 * What a ticket needs merged before it can be done: other tickets of the project whose branches have
 * to land in its base first (a branch stacked on another, or one that took another branch in to get
 * past a conflict). Declared by agents and the human, checked against git, enforced when a ticket
 * moves to a done stage; only the human can mark it done anyway.
 */

type Ticket = schema.Ticket
/** The ticket a need is checked for: its project, repo and base (a ticket not created yet has no id). */
type Subject = Pick<Ticket, 'projectId' | 'repoId' | 'baseBranch'> & { id: number | null }

export interface Need {
  id: number
  title: string
  branch: string
  prNumber: number | null
  status: string
  /** Its branch is in this ticket's base, or it is done (or archived) and its branch landed. */
  merged: boolean
  /** The branch it has to land in: this ticket's base, or its own when this ticket is built on it. */
  into: string
  /** The board added it, because this ticket's branch holds its unmerged commits; it goes when that stops. */
  auto: boolean
}

export type NeededBy = Pick<Ticket, 'id' | 'title' | 'branch' | 'prNumber' | 'status'>

/** The needs of a ticket the board added. */
function autoIds(ticketId: number | null): Set<number> {
  if (ticketId === null) return new Set()
  return new Set(
    db
      .select({ id: schema.ticketNeeds.needsId })
      .from(schema.ticketNeeds)
      .where(and(eq(schema.ticketNeeds.ticketId, ticketId), eq(schema.ticketNeeds.auto, true)))
      .all()
      .map((r) => r.id),
  )
}

/** The tickets this one needs, by id. */
export function needIds(ticketId: number): number[] {
  return db
    .select({ id: schema.ticketNeeds.needsId })
    .from(schema.ticketNeeds)
    .where(eq(schema.ticketNeeds.ticketId, ticketId))
    .orderBy(asc(schema.ticketNeeds.needsId))
    .all()
    .map((r) => r.id)
}

/**
 * A list of needs for `subject`, checked: each a ticket of the same project, not the ticket itself,
 * and none already needing it (directly or through others), which would make a cycle. Repeats go.
 */
export function checkNeeds(subject: Pick<Subject, 'id' | 'projectId'>, ids: number[]): number[] {
  const wanted = [...new Set(ids)]
  if (subject.id !== null && wanted.includes(subject.id))
    throw new HttpError(400, `a ticket cannot need itself (#${subject.id})`)
  if (!wanted.length) return []
  const found = new Map(
    db
      .select({ id: schema.tickets.id, projectId: schema.tickets.projectId })
      .from(schema.tickets)
      .where(inArray(schema.tickets.id, wanted))
      .all()
      .map((t) => [t.id, t]),
  )
  for (const id of wanted) {
    const t = found.get(id)
    if (!t) throw new HttpError(400, `no ticket #${id}`)
    if (t.projectId !== subject.projectId) throw new HttpError(400, `#${id} is in another project`)
  }
  if (subject.id === null) return wanted
  // Walk what each need needs in turn: reaching this ticket closes a loop.
  const edges = db
    .select()
    .from(schema.ticketNeeds)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketNeeds.ticketId))
    .where(eq(schema.tickets.projectId, subject.projectId))
    .all()
    .map((r) => r.ticket_needs)
  const next = new Map<number, number[]>()
  for (const e of edges) next.set(e.ticketId, [...(next.get(e.ticketId) ?? []), e.needsId])
  for (const id of wanted) {
    const seen = new Set<number>()
    const direct = next.get(id)?.includes(subject.id) ?? false
    for (const queue = [id]; queue.length; ) {
      const at = queue.shift()!
      if (at === subject.id)
        throw new HttpError(
          400,
          `#${id} already needs #${subject.id}${direct ? '' : ' through others'}: that would be a cycle`,
        )
      if (seen.has(at)) continue
      seen.add(at)
      queue.push(...(next.get(at) ?? []))
    }
  }
  return wanted
}

/**
 * Replace what a ticket needs (checked as `checkNeeds` does); `[]` clears it. The needs the board added
 * (`auto`) are its own: a human's list that keeps one leaves its row as it is (the UI sends every id on
 * each edit), an agent's list never removes one, and the human removing any need is remembered
 * (`ticket_need_dismissals`), so the board does not add it again for the same commits. An agent that
 * names a need the board added has declared it: the row stays and is the agent's from then on (not
 * `auto`), so a rebase never drops it. `ids` is what the caller itself named, not merged with the
 * automatic needs. Needs not in the list before are the caller's own (not `auto`).
 */
export function setNeeds(ticketId: number, ids: number[], actor: string, opts: { agent?: boolean } = {}) {
  const t = features.getTicket(ticketId)
  const rows = db.select().from(schema.ticketNeeds).where(eq(schema.ticketNeeds.ticketId, ticketId)).all()
  const named = checkNeeds(t, ids)
  const kept = opts.agent ? rows.filter((r) => r.auto).map((r) => r.needsId) : []
  const declared = opts.agent ? rows.filter((r) => r.auto && named.includes(r.needsId)) : []
  const next = [...new Set([...named, ...kept])]
  const before = rows.map((r) => r.needsId).sort((a, b) => a - b)
  const same = next.length === before.length && next.every((id) => before.includes(id))
  if (same && !declared.length) return before
  db.transaction((tx) => {
    for (const r of declared)
      tx.update(schema.ticketNeeds)
        .set({ auto: false })
        .where(and(eq(schema.ticketNeeds.ticketId, ticketId), eq(schema.ticketNeeds.needsId, r.needsId)))
        .run()
    for (const r of rows.filter((r) => !next.includes(r.needsId))) {
      tx.delete(schema.ticketNeeds)
        .where(and(eq(schema.ticketNeeds.ticketId, ticketId), eq(schema.ticketNeeds.needsId, r.needsId)))
        .run()
      // The human's removal sticks for any need: a manual row has held '' (no commit seen for it yet).
      if (r.auto || !opts.agent)
        tx.insert(schema.ticketNeedDismissals)
          .values({ ticketId, needsId: r.needsId, held: r.held })
          .onConflictDoUpdate({
            target: [schema.ticketNeedDismissals.ticketId, schema.ticketNeedDismissals.needsId],
            set: { held: r.held },
          })
          .run()
    }
    const added = next.filter((id) => !before.includes(id))
    if (added.length) {
      tx.insert(schema.ticketNeeds)
        .values(added.map((needsId) => ({ ticketId, needsId })))
        .run()
      // Taken on by hand: whatever was dismissed before is no longer.
      tx.delete(schema.ticketNeedDismissals)
        .where(
          and(
            eq(schema.ticketNeedDismissals.ticketId, ticketId),
            inArray(schema.ticketNeedDismissals.needsId, added),
          ),
        )
        .run()
    }
  })
  if (same) return needIds(ticketId)
  logActivity({
    projectId: t.projectId,
    actor,
    kind: 'ticket',
    text: next.length
      ? `set #${ticketId} ${t.title} to need ${next.map((id) => `#${id}`).join(', ')} merged first`
      : `cleared what #${ticketId} ${t.title} needs`,
    refType: 'ticket',
    refId: ticketId,
  })
  return needIds(ticketId)
}

// --- whether a need is met, from git ---

/** What the checks of one request share: the project's tickets and stages, one ref listing per repo. */
function context(projectId: number, git: GitCache = gitCache()) {
  const stages = listStages(projectId)
  const all = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
  const repos = listRepos(projectId)
  return {
    stages,
    all,
    repos,
    byId: new Map(all.map((t) => [t.id, t])),
    repoOf: (t: Pick<Ticket, 'repoId'>) =>
      (t.repoId ? repos.find((r) => r.id === t.repoId) : repos[0]) ?? null,
    git,
  }
}
type Context = ReturnType<typeof context>

const landed = (r: Reach | null) => Boolean(r && r.state !== 'unique')

/**
 * Whether `need`'s work is where `subject` needs it: its branch is in the subject's base (merged,
 * rebased or edited in), or it is done (or archived) and its branch reached its own base chain, or was
 * deleted (branches go once they land). A ticket built on the needed branch itself needs that branch
 * to have landed where it was going. A need without a branch is met once it is done.
 */
async function isMet(subject: Subject, need: Ticket, ctx: Context): Promise<boolean> {
  const done = Boolean(need.archivedAt) || kindOf(ctx.stages, need.status) === 'done'
  const repo = ctx.repoOf(need)
  if (!need.branch || !repo) return done
  const { refs } = await ctx.git(repo.repoPath)
  const sameRepo = ctx.repoOf(subject)?.id === repo.id
  const stacked = sameRepo && subject.baseBranch === need.branch
  if (sameRepo && !stacked && landed(await reachOf(repo.repoPath, need.branch, [subject.baseBranch], refs)))
    return true
  if (!done && !stacked) return false
  if (!branchRef(need.branch, refs)) return done
  return landed(await reachOf(repo.repoPath, need.branch, baseChain(need, ctx.byId, repo), refs))
}

async function needsOf(
  subject: Subject,
  ids: number[],
  ctx: Context,
  autos: ReadonlySet<number> = autoIds(subject.id),
): Promise<Need[]> {
  const sameRepo = (n: Ticket) => ctx.repoOf(subject)?.id === ctx.repoOf(n)?.id
  return Promise.all(
    ids
      .map((id) => ctx.byId.get(id))
      .filter((n): n is Ticket => Boolean(n))
      .map(async (n) => ({
        id: n.id,
        title: n.title,
        branch: n.branch,
        prNumber: n.prNumber,
        status: n.status,
        // git failing to answer leaves it not merged: the human can still mark the ticket done.
        merged: await isMet(subject, n, ctx).catch(() => false),
        into: sameRepo(n) && subject.baseBranch !== n.branch ? subject.baseBranch : n.baseBranch,
        auto: autos.has(n.id),
      })),
  )
}

/** Every need of these tickets, with whether it is met, in one pass over the project. */
async function needsFor(rows: Ticket[], ctx: Context) {
  const ids = rows.map((t) => t.id)
  const edges = ids.length
    ? db.select().from(schema.ticketNeeds).where(inArray(schema.ticketNeeds.ticketId, ids)).all()
    : []
  const out = new Map<number, Need[]>()
  await Promise.all(
    rows.map(async (t) => {
      const own = edges.filter((e) => e.ticketId === t.id)
      const mine = own.map((e) => e.needsId)
      if (mine.length)
        out.set(
          t.id,
          await needsOf(
            t,
            mine.sort((a, b) => a - b),
            ctx,
            new Set(own.filter((e) => e.auto).map((e) => e.needsId)),
          ),
        )
    }),
  )
  return out
}

/**
 * The ticket page's read: `getTicketWithPush` with what it needs (each with `merged`), what needs it,
 * and in a review stage `open`: what its tasks still have open (openTasks).
 */
export async function ticketView(id: number, opts: { laneUpdates?: boolean } = {}) {
  const full = await features.getTicketWithPush(id, opts)
  followBranches(full.projectId)
  const ctx = context(full.projectId)
  const needs = await needsOf(full, needIds(id), ctx)
  const neededBy: NeededBy[] = db
    .select({ id: schema.ticketNeeds.ticketId })
    .from(schema.ticketNeeds)
    .where(eq(schema.ticketNeeds.needsId, id))
    .orderBy(asc(schema.ticketNeeds.ticketId))
    .all()
    .flatMap(({ id }) => {
      const t = ctx.byId.get(id)
      return t ? [{ id: t.id, title: t.title, branch: t.branch, prNumber: t.prNumber, status: t.status }] : []
    })
  // A PR's own ticket has no hand-off: its PR is reviewed on the queue, not handed off.
  const inReview = kindOf(ctx.stages, full.status) === 'review'
  const open: OpenTask[] | null = inReview && !full.prId ? openTasks(full.id) : null
  const { timeline } = timelinesFor([full]).get(full.id)!
  return {
    ...full,
    needs,
    neededBy,
    open,
    // The reports of each subagent run, newest first; in review, the runs the timeline records with none.
    runReports: ticketReports(full.id),
    missingRunReports: inReview && !full.prId ? missingReports(full.id) : [],
    missingReviewPhases: inReview && !full.prId ? missingReviewPhases(full.id) : [],
    stalled: timeline.stalled,
    lastSignalAt: timeline.lastSignalAt,
    liveness: timeline.liveness,
    stage: timeline.stage,
    progressAt: timeline.progressAt,
    waitingOnHuman: timeline.waitingOnHuman,
    work: workOf(timeline),
    // Its moves between stages with who and how, oldest first, and the human's send-backs from review
    // (empty on a ticket with none recorded). mergedAt, on the row, is GitHub's merge time.
    ...historyOf(full.id),
  }
}

/**
 * `listTickets` with each ticket's needs, met or not, whether it reads as stalled with when it was last
 * heard from (the work timeline), and its activity: the spans and waits still open and who was last
 * heard from.
 */
export async function ticketRows(projectId: number, filter: features.TicketFilter = {}) {
  const rows = features.listTickets(projectId, filter)
  followBranches(projectId)
  const needs = await needsFor(rows, context(projectId))
  const timelines = timelinesFor(rows)
  return rows.map((t) => {
    const { timeline } = timelines.get(t.id)!
    return {
      ...t,
      needs: needs.get(t.id) ?? [],
      stalled: timeline.stalled,
      lastSignalAt: timeline.lastSignalAt,
      liveness: timeline.liveness,
      stage: timeline.stage,
      progressAt: timeline.progressAt,
      waitingOnHuman: timeline.waitingOnHuman,
      activity: activityOf(timeline),
    }
  })
}

// --- what a branch took in from other tickets' branches ---

/** Answers kept for the commits they were worked out for (by the branches too, where those matter). */
const MEMO_MAX = 20_000
const includesMemo = new Map<string, Promise<boolean>>()
const mergedMemo = new Map<string, Promise<Set<string>>>()
const ownMemo = new Map<string, Promise<boolean>>()
const includedMemo = new Map<string, Promise<number[]>>()

/**
 * The open tickets this one's branch could hold work of: same repo, not its own parents or lanes, not
 * built on this ticket's branch (that holds this one's work, not the other way round).
 */
function candidatesOf(t: Ticket, ctx: Context, repo: schema.Repo): Ticket[] {
  const family = new Set([t.id, ...features.laneTree(ctx.all, t.id).map((l) => l.id)])
  for (let p = t.parentId; p; p = ctx.byId.get(p)?.parentId ?? null) family.add(p)
  return ctx.all.filter(
    (o) =>
      !family.has(o.id) &&
      o.branch &&
      o.branch !== t.branch &&
      !o.archivedAt &&
      !isClosed(kindOf(ctx.stages, o.status)) &&
      ctx.repoOf(o)?.id === repo.id &&
      !baseChain(o, ctx.byId, repo).includes(t.branch),
  )
}

/** Runs `work` over `items` a few at a time, so a busy project does not start dozens of git processes at once. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += 4) out.push(...(await Promise.all(items.slice(i, i + 4).map(work))))
  return out
}

/** The full name of the ref `branchRef` picks for a branch. */
const fullRef = (branch: string, refs: { local: Map<string, string> }) =>
  refs.local.has(branch) ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`

/**
 * The tickets whose unmerged work this ticket's branch certainly holds, each with the commit of its
 * branch seen inside this one: its tip is a strict ancestor of this one's, and it has commits of its own
 * that no branch below it and no base of this ticket holds (`holdsOwnWork`). Null when there is no
 * branch to look at or no listing of the repo; throws when git cannot answer. Every answer is kept for the commits it is about.
 */
async function certainWork(t: Ticket, ctx: Context): Promise<Map<number, string> | null> {
  const repo = ctx.repoOf(t)
  if (!t.branch || !repo) return null
  const { refs, error } = await ctx.git(repo.repoPath)
  // A repo git cannot read says nothing: its tickets keep their needs until it can be read again.
  if (error) return null
  const ref = branchRef(t.branch, refs)
  if (!ref) return null
  const a = refSha(ref, refs)!
  const fingerprint = refsKey(refs)
  const merged = await memo(mergedMemo, MEMO_MAX, [repo.repoPath, a, fingerprint].join('\0'), () =>
    refsMergedInto(repo.repoPath, a),
  )
  const chain = baseChain(t, ctx.byId, repo)
  const found = new Map<number, string>()
  const candidates = candidatesOf(t, ctx, repo).filter(
    (o) => (refs.local.has(o.branch) || refs.remote.has(o.branch)) && merged.has(fullRef(o.branch, refs)),
  )
  await inBatches(candidates, async (o) => {
    const b = refSha(branchRef(o.branch, refs)!, refs)!
    // Built on the other branch by its base: its work counts until it lands below it.
    const bases = baseRefs(
      chain.filter((c) => c !== o.branch),
      refs,
    )
      .filter((r) => r !== ref)
      .map((r) => refSha(r, refs)!)
    const key = [repo.repoPath, a, b, o.branch, ...bases, fingerprint].join('\0')
    const holds = await memo(ownMemo, MEMO_MAX, key, () =>
      holdsOwnWork(repo.repoPath, a, b, [`refs/heads/${o.branch}`, `refs/remotes/origin/${o.branch}`], bases),
    )
    if (holds) found.set(o.id, b)
  })
  return found
}

/**
 * The open tickets whose unmerged work this ticket's branch holds, though the board cannot tell for
 * sure whose it is (so it adds no need): commits of their branch that are in this one but in none of its
 * bases, or a copy of them under other shas (`holdsWorkOf`), as two branches do that took each other's
 * work in (a partial merge-in), stacked and then moved apart, or had commits cherry-picked across. Two
 * branches off the same base are not here. Not those it needs already, nor those it certainly holds
 * (`certainWork`: the board adds those itself), nor those the human removed a need for, nor those that need
 * this ticket (adding one would be a cycle). Every open ticket of
 * the repo is checked. The git answers are kept for the commits they were worked out for, and the whole
 * answer for the state of the project's branches and tickets and this ticket's needs, so a ticket page
 * read again (the page asks every minute) costs a fingerprint until something changes.
 */
async function includedWork(t: Ticket, ctx: Context): Promise<number[]> {
  // The whole answer is kept for the state of the project's branches and tickets it was worked out for
  // (and this ticket's needs), so a ticket page opened again, or by someone else, costs a fingerprint.
  const key = [t.id, needIds(t.id).join(','), await projectState(ctx)].join('\0')
  const found = await memo(includedMemo, 2_000, key, () => scanIncluded(t, ctx))
  // Read as it is now, not kept: what the human removed is not asked about again, and neither is what
  // "Add as a need" would refuse (one that needs this ticket already, directly or through others).
  const removed = new Set(
    db
      .select({ id: schema.ticketNeedDismissals.needsId })
      .from(schema.ticketNeedDismissals)
      .where(eq(schema.ticketNeedDismissals.ticketId, t.id))
      .all()
      .map((r) => r.id),
  )
  return found.filter((id) => {
    if (removed.has(id)) return false
    try {
      checkNeeds(t, [id])
      return true
    } catch {
      return false
    }
  })
}

async function scanIncluded(t: Ticket, ctx: Context): Promise<number[]> {
  const repo = ctx.repoOf(t)
  if (!t.branch || !repo) return []
  const { refs } = await ctx.git(repo.repoPath)
  const ref = branchRef(t.branch, refs)
  if (!ref) return []
  const chain = baseChain(t, ctx.byId, repo)
  // A failure here fails the scan (and is not kept): the ones the board adds are not for the hint.
  const settled = new Set([...needIds(t.id), ...((await certainWork(t, ctx))?.keys() ?? [])])
  const candidates = candidatesOf(t, ctx, repo).filter((o) => !settled.has(o.id))
  // Every branch of the repo, this one's too: what a branch is built on, a shared integration branch
  // included, is not its own work.
  const others = [
    ...new Set([
      ref,
      ...[...refs.local.keys()].map((b) => localRef(b)),
      ...[...refs.remote.keys()].map((b) => `origin/${b}`),
    ]),
  ]
  const at = (r: string) => `${r}@${refSha(r, refs)}`
  const found = await inBatches(candidates, async (o) => {
    const other = branchRef(o.branch, refs)
    if (!other) return null
    // Built on the other branch: its work counts until it lands below it.
    const bases = baseRefs(
      chain.filter((b) => b !== o.branch),
      refs,
    ).filter((b) => b !== ref && b !== other)
    const key = [repo.repoPath, at(ref), at(other), ...bases.map(at), '|', ...others.map(at)].join('\0')
    // On the listed commits the key names, not on the branches as they are now.
    const sha = (r: string) => refSha(r, refs)!
    const holds = await memo(includesMemo, MEMO_MAX, key, () =>
      holdsWorkOf(
        repo.repoPath,
        sha(ref),
        sha(other),
        bases.map(sha),
        // Not the other ticket's own copies: its pushed commits are its own work.
        others.filter((x) => x !== localRef(o.branch) && x !== `origin/${o.branch}`).map(sha),
      ),
    )
    return holds ? o.id : null
  })
  return found.filter((id): id is number => id !== null).sort((a, b) => a - b)
}

/**
 * `get_ticket_git` with `includes` (the HTTP route only with `?includes=1`, which runs the scan): the open tickets whose unmerged work this ticket's branch holds
 * and the board did not add a need for (`includedWork`). Both read the same ref listing, the one every
 * read shares for a few seconds.
 */
export async function ticketGitView(
  id: number,
  opts: { includes?: boolean } = {},
): Promise<Awaited<ReturnType<typeof features.ticketGit>> & { includes?: number[] }> {
  const repoGit = gitCache({ recent: true })
  const git = await features.ticketGit(id, repoGit)
  const t = features.getTicket(id)
  followBranches(t.projectId)
  if (!opts.includes) return git
  return { ...git, includes: await includedWork(t, context(t.projectId, repoGit)).catch(() => []) }
}

// --- needs the board adds itself ---

const ADDED_BY = 'board'
const sweptState = new Map<number, string>()
const sweeping = new Map<number, { again: boolean; listed?: Listed; done: Promise<void> }>()

/**
 * Looks at every open ticket of the project with a branch: adds the need for each ticket whose unmerged
 * work its branch certainly holds (`certainWork`), and drops the needs it added that no longer hold.
 * Idempotent and never throws. One runs per project at a time (a call meanwhile has it run once more,
 * on that call's `listed`, or on the current branches when it has none);
 * a state it already swept (the repos' branches and the tickets' branches, bases and status) costs a
 * fingerprint. A ticket git cannot answer for keeps its needs as they are.
 *
 * - a need that is there is kept: one added by hand is never touched, one the board added only has its
 *   `held` commit brought up to date;
 * - one the human removed is not added again for the commits it was removed with, only for new work;
 * - one that would close a loop is not added;
 * - an automatic need goes when the other ticket was cancelled or archived without landing, or when
 *   the commits held are no longer in the branch (rebased away). The other moving on, or landing, keeps
 *   it: it shows as merged once it is.
 */
export function syncAutoNeeds(projectId: number, listed?: Listed): Promise<void> {
  const running = sweeping.get(projectId)
  if (running) {
    running.again = true
    // The newest call decides what the repeat looks at: a listing, or (none) the repos' current branches.
    running.listed = listed
    return running.done
  }
  const entry: { again: boolean; listed?: Listed; done: Promise<void> } = {
    again: false,
    listed,
    done: Promise.resolve(),
  }
  entry.done = (async () => {
    do {
      entry.again = false
      const look = entry.listed
      await sweep(projectId, look).catch((err: unknown) =>
        console.error(`adding the needs of project ${projectId} failed:`, err),
      )
    } while (entry.again)
  })().finally(() => sweeping.delete(projectId))
  sweeping.set(projectId, entry)
  return entry.done
}

/** A repo's branches as a fresh listing just found them. */
type Listed = { repoPath: string; refs: Refs }

/** `syncAutoNeeds` for a read to start and not wait for. */
function followBranches(projectId: number, listed?: Listed) {
  void syncAutoNeeds(projectId, listed)
}

// A fresh listing of a repo is a look at its branches: the projects with the repo follow them.
onRefsListed((repoPath, refs) => {
  const ids = new Set(
    db
      .select({ projectId: schema.repos.projectId })
      .from(schema.repos)
      .where(eq(schema.repos.repoPath, repoPath))
      .all()
      .map((r) => r.projectId),
  )
  for (const id of ids) followBranches(id, { repoPath, refs })
})

/**
 * A fingerprint of everything the needs of a project are worked out from: the repos' branches (or that git
 * cannot read them), the stages' kinds, and each ticket's branch, status, base, parent and repo. The same
 * fingerprint means the same answers, so a look at it again costs nothing.
 */
async function projectState(ctx: Context): Promise<string> {
  const hash = crypto.createHash('sha1')
  for (const repo of ctx.repos) {
    const { refs, error } = await ctx.git(repo.repoPath)
    hash.update(`${repo.id}\0${error ?? refsKey(refs)}\n`)
  }
  for (const s of ctx.stages) hash.update(`${s.key}\0${s.kind}\n`)
  for (const t of [...ctx.all].sort((a, b) => a.id - b.id))
    hash.update(
      [t.id, t.branch, t.status, t.archivedAt, t.baseBranch, t.parentId, t.repoId].join('\0') + '\n',
    )
  return hash.digest('hex')
}

async function sweep(projectId: number, listed?: Listed) {
  // The branches only (no worktrees), as a listing that was just made found them when there is one.
  const kept = new Map<string, Promise<RepoGit>>()
  const git: GitCache = (repoPath) => {
    if (!kept.has(repoPath))
      kept.set(
        repoPath,
        listed?.repoPath === repoPath
          ? Promise.resolve({ refs: listed.refs, worktrees: [], error: null })
          : readRefs(repoPath).then((refs) =>
              refs
                ? { refs, worktrees: [], error: null }
                : {
                    refs: { local: new Map(), remote: new Map(), symrefs: new Map() },
                    worktrees: [],
                    error: `git cannot read ${repoPath}`,
                  },
            ),
      )
    return kept.get(repoPath)!
  }
  const ctx = context(projectId, git)
  const state = await projectState(ctx)
  if (sweptState.get(projectId) === state) return
  sweptState.delete(projectId)
  let complete = true
  for (const t of ctx.all) {
    if (t.archivedAt || isClosed(kindOf(ctx.stages, t.status))) continue
    try {
      await sweepTicket(t, ctx)
    } catch (err) {
      complete = false
      console.error(`reading what the branch of #${t.id} holds failed:`, err)
    }
  }
  // A listing that failed is tried again by the next look.
  if (complete) sweptState.set(projectId, state)
}

async function sweepTicket(t: Ticket, ctx: Context) {
  const certain = await certainWork(t, ctx)
  if (!certain) return
  const repo = ctx.repoOf(t)!
  const { refs } = await ctx.git(repo.repoPath)
  const a = refSha(branchRef(t.branch, refs)!, refs)!
  const text = (id: number) => `#${id}`
  const log = (line: string) =>
    logActivity({
      projectId: t.projectId,
      actor: ADDED_BY,
      kind: 'ticket',
      text: line,
      refType: 'ticket',
      refId: t.id,
    })
  const rows = () => db.select().from(schema.ticketNeeds).where(eq(schema.ticketNeeds.ticketId, t.id)).all()
  const dismissals = () =>
    db.select().from(schema.ticketNeedDismissals).where(eq(schema.ticketNeedDismissals.ticketId, t.id)).all()
  // What git says, before anything is written: the rows are read again as they are written.
  const removed = new Map<number, { held: string; covers: boolean }>()
  for (const [id, b] of certain) {
    const gone = dismissals().find((d) => d.needsId === id)
    // The human removed it with these commits, or with later ones that hold them: not added again.
    if (gone)
      removed.set(id, {
        held: gone.held,
        // Removed before the board had seen a commit for it (a need declared by hand): this tip is the one.
        covers: !gone.held || gone.held === b || (await isAncestor(repo.repoPath, b, gone.held)),
      })
  }
  const drops = new Map<number, string>()
  for (const r of rows().filter((r) => r.auto && !certain.has(r.needsId))) {
    const other = ctx.byId.get(r.needsId)
    if (!other) continue
    const cancelled = kindOf(ctx.stages, other.status) === 'cancelled'
    if ((cancelled || other.archivedAt) && !(await isMet(t, other, ctx).catch(() => true)))
      drops.set(
        r.needsId,
        `${text(t.id)} no longer needs ${text(other.id)}: ${text(other.id)} was ${cancelled ? 'cancelled' : 'archived'} without landing`,
      )
    else if (!(r.held && (await isAncestor(repo.repoPath, r.held, a))))
      drops.set(
        r.needsId,
        `${text(t.id)} no longer needs ${text(other.id)}: its branch no longer holds ${text(other.id)}'s commits`,
      )
  }
  const lines: string[] = []
  db.transaction(
    (tx) => {
      const now = rows()
      for (const [id, b] of certain) {
        const row = now.find((r) => r.needsId === id)
        if (row) {
          if (row.auto && row.held !== b)
            tx.update(schema.ticketNeeds)
              .set({ held: b })
              .where(and(eq(schema.ticketNeeds.ticketId, t.id), eq(schema.ticketNeeds.needsId, id)))
              .run()
          continue
        }
        const gone = dismissals().find((d) => d.needsId === id)
        // Removed by the human for these commits, or removed or changed since it was looked at: not now.
        if (gone?.held !== removed.get(id)?.held) continue
        if (removed.get(id)?.covers) {
          // Removed with no commit seen: the tip seen now is the one it was removed with.
          if (gone && !gone.held)
            tx.update(schema.ticketNeedDismissals)
              .set({ held: b })
              .where(
                and(
                  eq(schema.ticketNeedDismissals.ticketId, t.id),
                  eq(schema.ticketNeedDismissals.needsId, id),
                ),
              )
              .run()
          continue
        }
        try {
          checkNeeds(t, [id])
        } catch {
          continue
        }
        if (gone)
          tx.delete(schema.ticketNeedDismissals)
            .where(
              and(
                eq(schema.ticketNeedDismissals.ticketId, t.id),
                eq(schema.ticketNeedDismissals.needsId, id),
              ),
            )
            .run()
        tx.insert(schema.ticketNeeds).values({ ticketId: t.id, needsId: id, auto: true, held: b }).run()
        lines.push(`${text(t.id)} now needs ${text(id)}: its branch holds ${text(id)}'s unmerged commits`)
      }
      for (const r of now.filter((r) => r.auto && drops.has(r.needsId) && !certain.has(r.needsId))) {
        tx.delete(schema.ticketNeeds)
          .where(and(eq(schema.ticketNeeds.ticketId, t.id), eq(schema.ticketNeeds.needsId, r.needsId)))
          .run()
        lines.push(drops.get(r.needsId)!)
      }
    },
    { behavior: 'immediate' },
  )
  for (const line of lines) log(line)
}

// --- the rule: not done while a need is not merged ---

const unmetText = (unmet: Need[]) =>
  unmet
    .map((n) => (n.branch ? `#${n.id} (branch ${n.branch}) merged into ${n.into}` : `#${n.id} done`))
    .join(' and ')

/**
 * Refuse moving `subject` (now in `from`, if it exists) to the stage `to` when that stage is done and
 * one of `ids` is not merged: a 409 saying which. `force` is the human's way past it (an agent's
 * `force` is refused outright); the needs it went past come back, for the caller to log.
 */
export async function guardDone(
  subject: Subject & { from?: string },
  to: string,
  ids: number[],
  opts: { force?: boolean; agent: boolean },
): Promise<Need[]> {
  if (opts.force && opts.agent)
    throw new HttpError(403, 'only the human marks a ticket done before what it needs is merged')
  const stages = listStages(subject.projectId)
  if (stageOf(stages, to).kind !== 'done' || !ids.length) return []
  if (subject.from && kindOf(stages, subject.from) === 'done') return []
  const ctx = context(subject.projectId)
  const unmet = (await needsOf(subject, ids, ctx)).filter((n) => !n.merged)
  if (unmet.length && !opts.force)
    throw new HttpError(
      409,
      `${subject.id ? `#${subject.id}` : 'this ticket'} needs ${unmetText(unmet)} first`,
      'needs',
    )
  return unmet
}

function logOverride(t: Ticket, unmet: Need[], actor: string) {
  if (!unmet.length) return
  logActivity({
    projectId: t.projectId,
    actor,
    kind: 'ticket',
    text: `marked #${t.id} ${t.title} done anyway, without ${unmetText(unmet)}`,
    refType: 'ticket',
    refId: t.id,
  })
}

/**
 * Refuses an agent's move or create into an approved-kind stage (Approved): only the human's verdict or a move puts a ticket
 * there. In a project with no software kind the human's approval also closes the work, so an agent
 * never moves a ticket to done there either.
 */
function refuseAgentApproved(projectId: number, status: string | undefined, from?: string) {
  if (status === undefined) return
  const to = resolveStage(listStages(projectId), status)
  if (to.kind === 'approved')
    throw new HttpError(
      403,
      'only the human puts a ticket in Approved: a verdict or a move by the human does',
    )
  refuseAgentDone(projectId, status, from)
}

/**
 * An agent never closes the work of a project with no software kind: the human's approval does. A
 * ticket already in that done stage (`from`) is not closed by it again, so an agent's other edits to
 * it still go through.
 */
function refuseAgentDone(projectId: number, status: string | undefined, from?: string) {
  if (status === undefined) return
  const to = resolveStage(listStages(projectId), status)
  if (to.kind === 'done' && to.key !== from && !hasGitSide(getProject(projectId).kinds))
    throw new HttpError(403, 'only the human closes work in a project with no software kind: by approving it')
}

type Patch = Parameters<typeof features.updateTicket>[1]

/**
 * `updateTicket` with the needs rule: `needs` replaces what the ticket needs, and a move to a done stage
 * is refused while one is not merged, unless the human sends `force` (logged). A move to a review stage
 * answers with `open` too: what its tasks still have open (openTasks). Never refused for them.
 * `position` places it in its column (`placeTicket`) once the rest is written: with `status`, in the
 * new stage's column. A bad one is refused before anything is written.
 */
export async function changeTicket(
  id: number,
  input: Patch & {
    needs?: number[]
    force?: boolean
    position?: number
    /** The human's reason when the move sends the ticket back from review (`updateTicket`). */
    sendBackReason?: SendBackReason
  },
  actor: string,
  opts: { agent: boolean },
) {
  const { needs, force, position, sendBackReason, ...patch } = input
  const before = features.getTicket(id)
  if (position !== undefined) features.checkPlacement(before, position)
  // An agent never puts a ticket in Approved: the orchestrator reads that stage as the human's go-ahead.
  if (opts.agent && kindOf(listStages(before.projectId), before.status) !== 'approved')
    refuseAgentApproved(before.projectId, patch.status, before.status)
  // From Approved an agent may still not close the work of a project with no software kind.
  if (opts.agent) refuseAgentDone(before.projectId, patch.status, before.status)
  // An agent's list leaves the needs the board added as they are: they count for the move too.
  const named = needs !== undefined ? checkNeeds(before, needs) : undefined
  const ids = named !== undefined ? [...new Set([...named, ...(opts.agent ? autoIds(id) : [])])] : needIds(id)
  // Judged against the primary the write produces: a swap or a reordered list brings that repo's base.
  const { repos, ...fields } = patch
  const primary = features.plannedPrimary(before, repos, fields).patch
  const subject = {
    ...before,
    repoId: primary.repoId ?? before.repoId,
    baseBranch: primary.baseBranch || before.baseBranch,
    from: before.status,
  }
  const stages = listStages(before.projectId)
  const to = patch.status
    ? resolveStage(stages, patch.status, projectWorkStage(before.projectId, stages)).key
    : before.status
  const unmet = await guardDone(subject, to, ids, { force, agent: opts.agent })
  // The needs, the update and the placement land together: an update that is refused leaves the needs
  // as they were.
  const row = db.transaction(
    () => {
      if (needs !== undefined) setNeeds(id, named ?? ids, actor, { agent: opts.agent })
      if (sendBackReason && patch.status === undefined)
        throw new HttpError(
          400,
          'sendBackReason goes with a move (status); a send-back on the ticket takes its own',
        )
      const changed = Object.keys(patch).length
        ? features.updateTicket(id, patch, actor, { ...opts, sendBackReason })
        : features.getTicket(id)
      return position !== undefined ? features.placeTicket(id, position, actor) : changed
    },
    { behavior: 'immediate' },
  )
  logOverride(row, unmet, actor)
  if (patch.status !== undefined) followBranches(row.projectId)
  // Into review: the phases the board ticks are read first, so what is still open is up to date. The
  // subagent runs the timeline records with no run report are flagged here, never refused.
  if (patch.status && !row.prId && kindOf(listStages(row.projectId), row.status) === 'review') {
    await features.getTicketWithPush(id)
    return {
      ...row,
      open: openTasks(id),
      missingRunReports: missingReports(id),
      missingReviewPhases: missingReviewPhases(id),
    }
  }
  return { ...row, missingRunReports: [], missingReviewPhases: [] }
}

/**
 * A new ticket's tasks under its project's default phases: the given plain texts become the steps of
 * the first phase, the given `{text, subtasks}` items are phases of the caller's that come right after
 * it, then the rest of the defaults. Without default phases the tasks stay as given.
 */
function phasedTasks(phases: string[], tasks: features.NewTask[]): features.NewTask[] {
  const [first, ...rest] = phases
  if (first === undefined) return tasks
  const steps = tasks.filter((t) => typeof t === 'string')
  const added = tasks.filter((t) => typeof t !== 'string')
  return [{ text: first, subtasks: steps }, ...added, ...rest]
}

/**
 * `createTicket` with `needs`; a ticket created straight into a done stage is held to them too. A
 * top-level ticket starts with its project's default phases, a lane does not (its parent carries the
 * hand-off); `defaultPhases` true or false says otherwise.
 */
export async function newTicket(
  projectId: number,
  input: Parameters<typeof features.createTicket>[1] & { needs?: number[]; defaultPhases?: boolean },
  actor: string,
  opts: { agent: boolean },
) {
  const { needs = [], defaultPhases, ...rest } = input
  if (opts.agent) refuseAgentApproved(projectId, rest.status)
  const ids = checkNeeds({ id: null, projectId }, needs)
  if (ids.length && rest.status) {
    // Judged against the repo and base the ticket is created with.
    const { repo, baseBranch } = features.placement(projectId, features.newTicketPrimary(rest))
    const stages = listStages(projectId)
    const to = resolveStage(stages, rest.status, projectWorkStage(projectId, stages)).key
    await guardDone({ id: null, projectId, repoId: repo?.id ?? null, baseBranch }, to, ids, opts)
  }
  const seeded = defaultPhases ?? !rest.parentId
  const tasks = seeded ? phasedTasks(getProject(projectId).defaultPhases, rest.tasks ?? []) : rest.tasks
  const row = features.createTicket(projectId, { ...rest, tasks }, actor, opts)
  if (ids.length) setNeeds(row.id, ids, actor)
  return row
}

/**
 * `setVerdict` with the needs rule, where the verdict moves the ticket: approving a PR review takes it
 * to done, and taking back a disapproval can return it to a done stage. The human's, so `force` works.
 */
export async function judgeTicket(
  id: number,
  verdict: features.Verdict,
  actor: string,
  opts: { reopenTo?: string; force?: boolean } = {},
) {
  const t = features.getTicket(id)
  features.refuseLaneVerdict(t)
  const stages = listStages(t.projectId)
  const to =
    verdict === 'approved' && features.approvalCloses(t, stages)
      ? lastOfKind(stages, 'done')?.key
      : verdict === null && opts.reopenTo
        ? resolveStage(stages, opts.reopenTo, projectWorkStage(t.projectId, stages)).key
        : undefined
  // A ticket still open or in review is moved to done by a second approval even when its verdict is
  // already approved, so its needs are checked then too.
  const unmet =
    to && (features.verdictOf(t) !== verdict || kindOf(stages, t.status) !== 'done')
      ? await guardDone({ ...t, from: t.status }, to, needIds(id), { force: opts.force, agent: false })
      : []
  const row = features.setVerdict(id, verdict, actor, { reopenTo: opts.reopenTo })
  if (kindOf(stages, row.status) === 'done') logOverride(row, unmet, actor)
  return row
}

/**
 * `deleteStage` with the needs rule: moving a stage's tickets into a done stage is refused while one of
 * them has a need not merged, unless the human sends `force` (logged per ticket).
 */
export async function removeStage(
  projectId: number,
  stageId: number,
  opts: { moveTo?: string; force?: boolean },
  actor: string,
) {
  const stages = listStages(projectId)
  const stage = stages.find((s) => s.id === stageId)
  const target = opts.moveTo ? stages.find((s) => s.key === opts.moveTo) : undefined
  const overrides: [Ticket, Need[]][] = []
  if (stage && target && target.kind === 'done' && stage.kind !== 'done') {
    const moving = db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.projectId, projectId))
      .all()
      .filter((t) => t.status === stage.key)
    const refusals: string[] = []
    for (const t of moving) {
      try {
        const unmet = await guardDone({ ...t, from: t.status }, target.key, needIds(t.id), {
          force: opts.force,
          agent: false,
        })
        if (unmet.length) overrides.push([t, unmet])
      } catch (err) {
        if (!(err instanceof HttpError) || err.code !== 'needs') throw err
        refusals.push(err.message)
      }
    }
    if (refusals.length)
      throw new HttpError(409, `${target.name} is a done stage: ${refusals.join('; ')}`, 'needs')
  }
  deleteStage(projectId, stageId, { moveTo: opts.moveTo }, actor)
  for (const [t, unmet] of overrides) logOverride(t, unmet, actor)
}

export type TicketView = Awaited<ReturnType<typeof ticketView>>
export type TicketListRow = Awaited<ReturnType<typeof ticketRows>>[number]
