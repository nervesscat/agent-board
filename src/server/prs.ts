import { and, desc, eq, gt, gte, inArray, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import type { PrCheck } from '#/lib/constants'
import { isClosed } from '#/lib/stages'
import { logActivity } from './activity'
import {
  currentGithubLogin,
  listMyPrs,
  mergeConflicts,
  prMerged,
  prStateOf,
  type GhCheck,
  type GhPr,
} from './git'
import { reconcileProject } from './autoPhases'
import { toolProblem } from './hostTools'
import { HttpError, notFound } from './http'
import { hasPreviews, stopPreviewsFor } from './managedPreview'
import { getProject } from './projects'
import { fetchStatus } from './push'
import {
  featureTicketsOf,
  hasOwnTicket,
  movePrTicket,
  openPrTickets,
  prTicketOf,
  type PrTicketStatus,
} from './prTickets'
import { listRepos, ticketRepo } from './repos'
import { ticketRepoList, ticketRepoRows } from './ticketRepos'
import { kindOf, listStages } from './stages'
import { noteBoardEvent } from './workTimeline'

export type PrStatus = 'pending' | 'reviewed' | 'on_hold' | 'done'
export type ReviewStage = schema.Pr['reviewStage']

/** A merged PR is done, held or not; otherwise a hold wins over where its reviews stand. */
export function prStatus(pr: Pick<schema.Pr, 'mergedAt' | 'hold' | 'reviewStage'>): PrStatus {
  if (pr.mergedAt) return 'done'
  if (pr.hold) return 'on_hold'
  return pr.reviewStage
}

export type PrWaitingOn = schema.Pr['waitingOn']

/**
 * Which side of the queue a PR is on, by its author on GitHub: one I opened (agents' PRs too, since
 * they push with my account) waits on others' reviews; anyone else's waits on mine.
 */
export function prWaitingOn(pr: Pick<GhPr, 'author'>, me: string | null): PrWaitingOn {
  return pr.author.login === me ? 'others' : 'me'
}

type GhReview = GhPr['reviews'][number]

const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'])

/**
 * Each reviewer's standing verdict: their latest approval, request for changes or comment, except
 * that a comment after an approval (a reply in a thread) leaves the approval standing. Unsent and
 * dismissed reviews do not count.
 */
export function standingVerdicts(reviews: GhReview[]): Map<string, GhReview> {
  const verdicts = new Map<string, GhReview>()
  const sent = reviews
    .filter((r) => VERDICTS.has(r.state))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
  for (const r of sent) {
    if (r.state === 'COMMENTED' && verdicts.get(r.author.login)?.state === 'APPROVED') continue
    verdicts.set(r.author.login, r)
  }
  return verdicts
}

type StageInputs = Pick<GhPr, 'author' | 'reviews' | 'reviewRequests' | 'headRefOid' | 'reviewDecision'>

/**
 * Comments or requested changes that still stand: not addressed since, by a push past the commit
 * they were left on or by asking that reviewer for a review again. A review GitHub gives without its
 * commit is addressed by the second alone.
 */
function unaddressed(pr: StageInputs, v: GhReview) {
  if (v.state === 'APPROVED') return false
  const pushedSince = !!v.commit?.oid && v.commit.oid !== pr.headRefOid
  return !pushedSince && !pr.reviewRequests.some((r) => r.login === v.author.login)
}

/**
 * Where an open PR's reviews stand. Someone else's PR, by my reviews alone: approved by me is
 * reviewed, my comments not yet addressed put it on hold, anything else is pending. One of mine, by
 * everyone else's: comments not yet addressed put it on hold; GitHub's approval, or every reviewer
 * approving with no review still asked for, is reviewed; anything else is pending.
 */
export function reviewStage(pr: StageInputs, me: string | null): ReviewStage {
  const verdicts = standingVerdicts(pr.reviews)
  if (prWaitingOn(pr, me) === 'me') {
    const mine = me === null ? undefined : verdicts.get(me)
    if (!mine) return 'pending'
    if (mine.state === 'APPROVED') return 'reviewed'
    return unaddressed(pr, mine) ? 'on_hold' : 'pending'
  }
  const others = [...verdicts.values()].filter((v) => v.author.login !== pr.author.login)
  if (others.some((v) => unaddressed(pr, v))) return 'on_hold'
  if (pr.reviewDecision === 'APPROVED') return 'reviewed'
  const approved = others.length > 0 && others.every((v) => v.state === 'APPROVED')
  return approved && !pr.reviewRequests.length ? 'reviewed' : 'pending'
}

/** Whether GitHub would merge it now; `checking` while GitHub is still working it out after a push. */
export type MergeState = 'clean' | 'conflicts' | 'behind' | 'blocked' | 'checking'

export function mergeState(pr: Pick<schema.Pr, 'mergeable' | 'mergeStateStatus'>): MergeState {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflicts'
  if (pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus === 'UNKNOWN') return 'checking'
  if (pr.mergeStateStatus === 'BEHIND') return 'behind'
  // Branch protection: a required review or check is missing.
  if (pr.mergeStateStatus === 'BLOCKED') return 'blocked'
  return 'clean'
}

const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

function checkState(c: GhCheck): PrCheck['state'] {
  const s = c.__typename === 'CheckRun' ? (c.status === 'COMPLETED' ? c.conclusion : c.status) : c.state
  if (s === 'SUCCESS') return 'pass'
  if (s === 'SKIPPED' || s === 'NEUTRAL') return 'skipped'
  return FAILED.has(s) ? 'fail' : 'pending'
}

/** The head commit's checks, one per name: a re-run lists a check again, and its latest start wins. */
export function prChecks(rollup: GhCheck[] | null): PrCheck[] {
  const latest = new Map<string, GhCheck>()
  for (const c of rollup ?? []) {
    const key = c.__typename === 'CheckRun' ? `run:${c.workflowName ?? ''}/${c.name}` : `status:${c.context}`
    const before = latest.get(key)
    if (!before || (c.startedAt ?? '') >= (before.startedAt ?? '')) latest.set(key, c)
  }
  return [...latest.values()].map((c) =>
    c.__typename === 'CheckRun'
      ? { name: c.name, state: checkState(c), url: c.detailsUrl || null }
      : { name: c.context, state: checkState(c), url: c.targetUrl || null },
  )
}

/** CI at a glance: any failed check fails it, then any still running keeps it pending. */
export type CiState = 'passing' | 'failing' | 'pending' | 'none'

export function ciState(checks: PrCheck[]): CiState {
  if (checks.some((c) => c.state === 'fail')) return 'failing'
  if (checks.some((c) => c.state === 'pending')) return 'pending'
  return checks.some((c) => c.state === 'pass') ? 'passing' : 'none'
}

const LOCAL_GREEN = /^\s*CI run locally:\s*green\b/i
const HEX = /\b[0-9a-f]{7,40}\b/gi

/**
 * The PR's head as a "CI run locally: green" comment names it, or null: a comment whose first line
 * says so and that names a 7 to 40 character prefix of `headSha` (any author: agents comment with the
 * human's account). A comment without a SHA, or naming another commit, does not count: CI ran on what
 * it names, and a push past it needs a new run. While GitHub's own checks do not run, this is how a PR
 * shows green.
 */
export function localGreenSha(comments: Pick<GhPr['comments'][number], 'body'>[], headSha: string) {
  const head = headSha.toLowerCase()
  const named = comments.some(
    (c) =>
      LOCAL_GREEN.test(c.body.split('\n', 1)[0]!) &&
      [...c.body.matchAll(HEX)].some((m) => head.startsWith(m[0].toLowerCase())),
  )
  return named && head ? headSha : null
}

/** CI green on the PR's head: its checks pass, or a "CI run locally: green" comment names the head. */
export const ciGreen = (pr: Pick<schema.Pr, 'checks' | 'headSha' | 'localCiSha'>) =>
  ciState(pr.checks) === 'passing' || (pr.localCiSha !== null && pr.localCiSha === pr.headSha)

/** Where a PR's merge state came from, so a reader can tell how much to trust it. */
export interface MergeCheck {
  /**
   * `local`: merged here, the PR's head into origin's base as the board last saw it, in the repo's
   * checkout (no GitHub call); `github`: GitHub's word as of the last refresh.
   */
  source: 'local' | 'github'
  /** `local`: when origin was last fetched into the checkout; `github`: the refresh that brought it. */
  at: string | null
  /** The base branch, on origin. */
  base: string
  /** The board saw origin's base move after GitHub gave its word: `checking` until asked again. */
  outdated: boolean
}

export interface Merge {
  merge: MergeState
  mergeCheck: MergeCheck
}

type MergeRow = Pick<
  schema.Pr,
  'repoId' | 'open' | 'baseRef' | 'headSha' | 'mergeable' | 'mergeStateStatus' | 'fetchedAt'
>

/** Origin's branch as the board last saw it: its sha, and when the board first saw it there. */
const originRef = (repoId: number | null, ref: string) =>
  repoId === null
    ? undefined
    : db
        .select()
        .from(schema.originRefs)
        .where(and(eq(schema.originRefs.repoId, repoId), eq(schema.originRefs.ref, ref)))
        .get()

/**
 * Whether the board saw origin's branch move after `since`. Only a recorded move counts: a first look
 * at a repo (a new one, or one pointed at another checkout) notes where the branch is without it
 * having moved.
 */
const movedSince = (repoId: number, ref: string, since: string) =>
  !!db
    .select({ id: schema.originRefMoves.id })
    .from(schema.originRefMoves)
    .where(
      and(
        eq(schema.originRefMoves.repoId, repoId),
        eq(schema.originRefMoves.ref, ref),
        gt(schema.originRefMoves.seenAt, since),
      ),
    )
    .get()

/**
 * GitHub's word on an open PR, unless the board saw origin's base move after it was given: that word
 * is about an older base, so the PR is `checking` until a refresh brings a new one.
 */
function githubMerge(pr: MergeRow): Merge {
  const outdated = pr.open && pr.repoId !== null && movedSince(pr.repoId, pr.baseRef, pr.fetchedAt)
  return {
    merge: outdated ? 'checking' : mergeState(pr),
    mergeCheck: { source: 'github', at: pr.fetchedAt, base: pr.baseRef, outdated },
  }
}

/**
 * Local merges per checkout, base sha and head sha: shas never change, so neither does a verdict. One
 * git could not give (a commit missing here) is tried again once origin was fetched again.
 */
const localChecks = new Map<
  string,
  { fetchedAt: string | null; known: boolean; conflicts: Promise<boolean | null> }
>()

function localConflicts(repoPath: string, base: string, head: string, fetchedAt: string | null) {
  const key = `${repoPath}\n${base}\n${head}`
  const kept = localChecks.get(key)
  if (kept && (kept.known || kept.fetchedAt === fetchedAt)) return kept.conflicts
  // Keep the memo from growing without end, as push's are.
  if (localChecks.size > 5000) localChecks.clear()
  const entry = {
    fetchedAt,
    known: false,
    conflicts: mergeConflicts(repoPath, base, head).then((c) => {
      entry.known = c !== null
      return c
    }),
  }
  localChecks.set(key, entry)
  return entry.conflicts
}

/**
 * The merge state the queue and a ticket show of a PR. An open one is first merged here, its head into
 * origin's base as the board last saw it, in the repo's checkout (no GitHub call), so a base that moved
 * on origin since GitHub was asked shows at the next fetch:
 * - conflicts here are conflicts, whatever GitHub said;
 * - a clean merge here is clean, unless GitHub, asked since the board last saw the base move, says it
 *   conflicts, is behind or is blocked (branch protection is GitHub's call);
 * - without a verdict here (a fork's head is not in the checkout, git failed), GitHub's word, as
 *   `githubMerge` reads it.
 */
async function prMerge(pr: MergeRow, repo: schema.Repo | undefined): Promise<Merge> {
  const base = pr.open && repo ? originRef(repo.id, pr.baseRef) : undefined
  const github = githubMerge(pr)
  if (!repo || !base) return github
  const { checkedAt } = fetchStatus(repo.repoPath)
  const conflicts = await localConflicts(repo.repoPath, base.sha, pr.headSha, checkedAt)
  if (conflicts === null) return github
  const local: MergeCheck = {
    source: 'local',
    at: checkedAt ?? base.seenAt,
    base: pr.baseRef,
    outdated: false,
  }
  if (conflicts) return { merge: 'conflicts', mergeCheck: local }
  const said = mergeState(pr)
  if (!github.mergeCheck.outdated && (said === 'conflicts' || said === 'behind' || said === 'blocked'))
    return github
  return { merge: 'clean', mergeCheck: local }
}

/** What the queue and a ticket's PR show of a stored PR's state on GitHub, with its merge state. */
const prState = (pr: schema.Pr, merge: Merge) => ({
  waitingOn: pr.waitingOn,
  isDraft: pr.isDraft,
  reviewDecision: pr.reviewDecision,
  ...merge,
  ci: ciState(pr.checks),
  checks: pr.checks,
})

const REFRESH_MS = 5 * 60_000
const lastRefresh = new Map<number, number>()
/** The repos whose PRs a refresh read from GitHub since the board started. */
const refreshedRepos = new Set<number>()
/** Per project: the last refresh queued, which never rejects, so the next one can wait on it. */
const refreshing = new Map<number, Promise<void>>()
/** Per project: the refresh waiting behind the running one, not started yet, which later requests join. */
const queued = new Map<number, Promise<void>>()

/**
 * Refreshes the project's queue once its previous refresh has finished, whether that succeeded or threw. Two
 * refreshes of one project never overlap, so one's reads and writes are all done before the next one starts:
 * the tickets it moves follow its own reads, and an older read cannot be written after a newer one. At most
 * one refresh waits behind the running one: a request made while one waits joins it, as it reads after them.
 */
export function refreshPrs(projectId: number): Promise<void> {
  const waiting = queued.get(projectId)
  if (waiting) return waiting
  const run = (refreshing.get(projectId) ?? Promise.resolve()).then(() => {
    queued.delete(projectId)
    return runRefresh(projectId)
  })
  queued.set(projectId, run)
  const settled = run.catch(() => undefined)
  refreshing.set(projectId, settled)
  return run
}

/**
 * Every repo of the project, refreshed side by side; the queue is their union. A repo gh cannot see
 * (no GitHub remote) is skipped, and one failing repo does not hide the others' PRs. When every repo
 * fails because gh is missing or signed out, the error says that and the fix, not what the spawn said.
 * Then the PRs' own tickets follow, for every project, one without a GitHub repo included.
 */
async function runRefresh(projectId: number) {
  getProject(projectId)
  const repos = listRepos(projectId).filter((r) => r.githubRepo)
  const results = await Promise.allSettled(repos.map((r) => refreshRepoPrs(r)))
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ repo: repos[i]!, err: r.reason }] : [],
  )
  for (const f of failed) console.error(`PR refresh failed for ${f.repo.name}:`, f.err)
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') refreshedRepos.add(repos[i]!.id)
  })
  if (repos.length && failed.length === repos.length) {
    const gh = toolProblem('gh', failed[0]!.err)
    throw gh ? new HttpError(502, gh) : failed[0]!.err
  }
  await syncPrTickets(
    projectId,
    results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
  )
  lastRefresh.set(projectId, Date.now())
  followUnknowns(projectId)
  // A PR opened, merged or closed, CI turning green or red: the tickets' automatic phases follow.
  await reconcileProject(projectId).catch((err: unknown) =>
    console.error(`ticking the automatic phases of project ${projectId} failed:`, err),
  )
}

/**
 * Whether the board knows the PRs of a repo: a refresh read them from GitHub since the board started,
 * or the queue has rows of it from before. A repo the refresh skips (no GitHub remote) or whose own
 * read failed is not known for its project's other repos going through. Until then a PR not found is
 * not a PR missing.
 */
export const prsKnown = (repoId: number) =>
  refreshedRepos.has(repoId) ||
  !!db.select({ id: schema.prs.id }).from(schema.prs).where(eq(schema.prs.repoId, repoId)).get()

/** Merged, as the searches found it or as GitHub said when it left them. */
export const prWasMerged = (pr: Pick<schema.Pr, 'mergedAt' | 'leftAs'>) =>
  pr.mergedAt !== null || pr.leftAs === 'MERGED'

/**
 * The queue's row of the PR a ticket was opened as, for its automatic phases: the one it names with
 * `prNumber`, else on its branch, in the ticket's repo, the newest open one, else the newest that left
 * the queue after the ticket was made, merged first. Unlike `prForTicket`, a merged PR found by the
 * branch still counts, but not one from before the ticket: a branch name used again is new work. Null
 * when there is none (a `prNumber` the queue never saw included); a PR closed without merging comes
 * back as it is when named by `prNumber`, and by the branch only while GitHub has not said it closed.
 */
export function autoPrRow(ticket: Pick<schema.Ticket, 'prNumber' | 'branch' | 'createdAt'>, repoId: number) {
  if (ticket.prNumber)
    return (
      db
        .select()
        .from(schema.prs)
        .where(and(eq(schema.prs.repoId, repoId), eq(schema.prs.number, ticket.prNumber)))
        .get() ?? null
    )
  if (!ticket.branch) return null
  const rows = db
    .select()
    .from(schema.prs)
    .where(and(eq(schema.prs.repoId, repoId), eq(schema.prs.headRef, ticket.branch)))
    .orderBy(desc(schema.prs.updatedAt), desc(schema.prs.id))
    .all()
  const open = rows.find((r) => r.open)
  if (open) return open
  const made = Date.parse(ticket.createdAt)
  const since = rows.filter((r) => Date.parse(r.mergedAt ?? r.closedAt ?? r.updatedAt) >= made)
  return (
    since.find((r) => prWasMerged(r)) ??
    // Left the searches with no answer from GitHub yet: maybe merged, so not "no PR".
    since.find((r) => r.leftAs === null) ??
    null
  )
}

/** A PR row a refresh changed: as it was stored, and as it is now. */
interface RowChange {
  repo: schema.Repo
  before: schema.Pr
  after: schema.Pr
}

/** Where a PR stands for its own ticket: its status in the queue, merged, or left the open queue. */
type QueueState = PrTicketStatus | 'left'
const queueState = (pr: Pick<schema.Pr, 'open' | 'mergedAt' | 'hold' | 'reviewStage'>): QueueState =>
  pr.mergedAt ? 'done' : pr.open ? prStatus(pr) : 'left'

/**
 * The PR tickets after a refresh. Each open PR that neither a feature ticket nor a ticket of its own covers gets
 * one, in its status's stage. A PR whose status changed moves its ticket to the stage the new status has. A PR
 * that left the open queue is asked of GitHub, when it has a ticket of its own: closed without merging is
 * cancelled and merged is done, while a PR that only left the searches keeps its stage.
 */
async function syncPrTickets(projectId: number, changes: RowChange[]) {
  openPrTickets(projectId, prStatus)
  const left: RowChange[] = []
  for (const c of changes) {
    const from = queueState(c.before)
    const to = queueState(c.after)
    if (from === to) continue
    if (to === 'left') left.push(c)
    else movePrTicket(c.after, to)
  }
  const asked = left.filter((c) => hasOwnTicket(c.after))
  const states = await Promise.all(
    asked.map((c) => c.after.leftAs ?? prStateOf(c.repo.repoPath, c.after.number)),
  )
  asked.forEach((c, i) => {
    if (states[i] === 'CLOSED') movePrTicket(c.after, 'cancelled')
    else if (states[i] === 'MERGED') movePrTicket(c.after, 'done')
  })
}

const backgroundRefresh = (projectId: number) =>
  refreshPrs(projectId).catch((err) => console.error(`PR refresh failed for project ${projectId}:`, err))

/** A move of origin's branches has a project's PRs refreshed at most this often. */
const MOVE_EVERY = 60_000
/** While GitHub has not worked out whether an open PR merges, it is asked again after each of these. */
const UNKNOWN_FOLLOW_UPS = [30_000, 60_000, 120_000, 240_000]

/** Per project: when a move last had its PRs refreshed, and the refresh due when that window ends. */
const moveRefresh = new Map<number, { at: number; due: NodeJS.Timeout | null }>()
/** Per project: how many follow-ups GitHub's unknowns had since the last move, and the one due. */
const followUps = new Map<number, { step: number; due: NodeJS.Timeout | null }>()

/**
 * Called with the moves of origin's branches the board just recorded: a project with an open PR on a
 * branch that moved (its base or its head) has its PRs refreshed in the background, however recent its
 * last refresh, since GitHub's merge state of them may have changed. At most one such refresh per
 * project every `MOVE_EVERY`: a move within it gets one when it ends. A failure is logged, never thrown
 * at the read that saw the move.
 */
export function recheckMovedPrs(moves: { repoId: number; ref: string }[]) {
  if (!moves.length) return
  try {
    const open = db
      .select()
      .from(schema.prs)
      .where(
        and(inArray(schema.prs.repoId, [...new Set(moves.map((m) => m.repoId))]), eq(schema.prs.open, true)),
      )
      .all()
    const projects = new Set(
      open
        .filter((pr) =>
          moves.some((m) => m.repoId === pr.repoId && (m.ref === pr.baseRef || m.ref === pr.headRef)),
        )
        .map((pr) => pr.projectId),
    )
    for (const projectId of projects) refreshOnMove(projectId)
  } catch (err) {
    console.error('refreshing the PRs of branches that moved on origin failed:', err)
  }
}

function refreshOnMove(projectId: number) {
  const s = moveRefresh.get(projectId) ?? { at: 0, due: null }
  moveRefresh.set(projectId, s)
  if (s.due) return
  const run = () => {
    s.due = null
    s.at = Date.now()
    // A move starts the follow-ups on GitHub's unknowns over.
    stopFollowUps(projectId)
    void backgroundRefresh(projectId)
  }
  const wait = s.at + MOVE_EVERY - Date.now()
  if (wait <= 0) return run()
  s.due = setTimeout(run, wait)
  s.due.unref()
}

/**
 * After a refresh: while an open PR's mergeability is still unknown to GitHub (it works it out after a
 * push or a move of the base), GitHub is asked again a little later, each time later still, at most
 * `UNKNOWN_FOLLOW_UPS.length` times until the next move. Stops once no open PR is unknown.
 */
function followUnknowns(projectId: number) {
  const unknown = db
    .select({ id: schema.prs.id })
    .from(schema.prs)
    .where(
      and(
        eq(schema.prs.projectId, projectId),
        eq(schema.prs.open, true),
        eq(schema.prs.mergeable, 'UNKNOWN'),
      ),
    )
    .get()
  if (!unknown) return stopFollowUps(projectId)
  const f = followUps.get(projectId) ?? { step: 0, due: null }
  followUps.set(projectId, f)
  if (f.due || f.step >= UNKNOWN_FOLLOW_UPS.length) return
  f.due = setTimeout(() => {
    f.due = null
    void backgroundRefresh(projectId)
  }, UNKNOWN_FOLLOW_UPS[f.step++])
  f.due.unref()
}

function stopFollowUps(projectId: number) {
  const f = followUps.get(projectId)
  if (f?.due) clearTimeout(f.due)
  followUps.delete(projectId)
}

/** Drops every refresh due and what each throttle remembers, as a board that just started has none. */
export function resetPrRefreshes() {
  for (const s of moveRefresh.values()) if (s.due) clearTimeout(s.due)
  for (const f of followUps.values()) if (f.due) clearTimeout(f.due)
  moveRefresh.clear()
  followUps.clear()
  lastRefresh.clear()
  refreshedRepos.clear()
  refreshing.clear()
  queued.clear()
  lastTry.clear()
}

const lastTry = new Map<number, number>()

/**
 * Refresh the project's queue in the background when it is as stale as `listPrs` would refresh it,
 * for readers that answer from the stored rows at once (the summary). At most one attempt per
 * project every refresh interval, so a GitHub that keeps failing is not asked on every read.
 */
export function refreshPrsInBackground(projectId: number) {
  const now = Date.now()
  const since = Math.max(lastRefresh.get(projectId) ?? 0, lastTry.get(projectId) ?? 0)
  if (now - since <= REFRESH_MS) return
  lastTry.set(projectId, now)
  void backgroundRefresh(projectId)
}

/** How long a merged PR stays in the queue, under Done. */
const MERGED_DAYS = 14
const mergedSince = () => new Date(Date.now() - MERGED_DAYS * 86_400_000).toISOString()

/**
 * Pull my PRs from GitHub, open and recently merged, and upsert the snapshot; board-side fields (hold)
 * are kept. Returns the rows that were stored before and changed.
 */
async function refreshRepoPrs(repo: schema.Repo): Promise<RowChange[]> {
  const { projectId } = repo
  const [ghPrs, me] = await Promise.all([
    listMyPrs(repo.repoPath, { mergedSince: mergedSince().slice(0, 10) }),
    currentGithubLogin(repo.repoPath),
  ])
  const fetchedAt = new Date().toISOString()
  const seen = new Set<number>()
  // The rows that leave the open queue now.
  const left: schema.Pr[] = []
  const changes: RowChange[] = []
  for (const pr of ghPrs) {
    seen.add(pr.number)
    const existing = db
      .select()
      .from(schema.prs)
      .where(and(eq(schema.prs.repoId, repo.id), eq(schema.prs.number, pr.number)))
      .get()
    const open = !pr.mergedAt
    const mine = me === null ? undefined : standingVerdicts(pr.reviews).get(me)
    const values = {
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      headSha: pr.headRefOid,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision || null,
      myReview: mine ? mine.state.toLowerCase() : 'none',
      waitingOn: prWaitingOn(pr, me),
      reviewStage: reviewStage(pr, me),
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      checks: prChecks(pr.statusCheckRollup),
      localCiSha: localGreenSha(pr.comments, pr.headRefOid),
      leftAs: null,
      updatedAt: pr.updatedAt,
      fetchedAt,
      open,
      mergedAt: pr.mergedAt || null,
      // When it left the open queue, once: now if the queue had it open, else when it was merged. A
      // later refresh that finds it merged again keeps it.
      closedAt: open ? null : (existing?.closedAt ?? (existing?.open ? fetchedAt : pr.mergedAt)),
    }
    if (existing) {
      const row = db
        .update(schema.prs)
        .set({ ...values, projectId })
        .where(eq(schema.prs.id, existing.id))
        .returning()
        .get()!
      changes.push({ repo, before: existing, after: row })
      if (existing.open && !open) left.push(row)
      if (!existing.mergedAt && row.mergedAt) noteMerge(repo, row)
    } else
      db.insert(schema.prs)
        .values({ ...values, projectId, repoId: repo.id, number: pr.number })
        .run()
  }
  // A PR that left every search was closed, unassigned, or merged out of the merged searches' reach:
  // keep the row, mark it closed, and keep what GitHub says it became (null when it cannot say).
  const goneOpen = db
    .select()
    .from(schema.prs)
    .where(and(eq(schema.prs.repoId, repo.id), eq(schema.prs.open, true)))
    .all()
    .filter((row) => !seen.has(row.number))
  const states = await Promise.all(goneOpen.map((row) => prStateOf(repo.repoPath, row.number)))
  const gone = goneOpen.map((row, i) => {
    const state = states[i]
    const set = {
      open: false,
      closedAt: fetchedAt,
      fetchedAt,
      leftAs: state === 'MERGED' || state === 'CLOSED' ? state : null,
    }
    db.update(schema.prs).set(set).where(eq(schema.prs.id, row.id)).run()
    const after = { ...row, ...set }
    changes.push({ repo, before: row, after })
    return after
  })
  left.push(...gone)
  if (left.length) await stopMergedPreviews(repo, left)
  return changes
}

/** A merge the board saw first now, on the work timeline of the PR's tickets and of its own ticket. */
function noteMerge(repo: schema.Repo, pr: schema.Pr) {
  const tickets = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, repo.projectId)).all()
  const ids = featureTicketsOf(tickets, listRepos(repo.projectId), pr).map((t) => t.id)
  const own = prTicketOf(tickets, pr.id)
  for (const id of own ? [...ids, own.id] : ids)
    noteBoardEvent(id, 'merge', { note: `PR #${pr.number} merged` })
}

/**
 * The runs of a merged PR's tickets (and their lanes) have nothing left to show: stop them, in the
 * PR's repo only for a ticket that spans several. A ticket names the PR in its primary repo (its own
 * prNumber or branch) or in another of its repos. A PR that left the queue without the searches
 * finding it merged may also have been closed: GitHub is asked about it, only when it has a run going.
 */
async function stopMergedPreviews(repo: schema.Repo, left: schema.Pr[]) {
  const repos = listRepos(repo.projectId)
  const tickets = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, repo.projectId)).all()
  const rows = ticketRepoRows(tickets.map((t) => t.id)).filter((r) => r.repoId === repo.id && r.position > 0)
  for (const pr of left) {
    const named = new Set(featureTicketsOf(tickets, repos, pr).map((t) => t.id))
    for (const r of rows)
      if (r.prNumber === pr.number || (r.prNumber === null && !!r.branch && r.branch === pr.headRef))
        named.add(r.ticketId)
    // A ticket that spans several repos stops only the runs of this one; any other, all of them.
    const stops = tickets
      .filter((t) => named.has(t.id) && !t.prId)
      .map((t) => ({ id: t.id, only: ticketRepoList(t).length > 1 ? { repoId: repo.id } : {} }))
    if (
      stops.some((s) => hasPreviews([s.id], s.only)) &&
      (prWasMerged(pr) || (pr.leftAs === null && (await prMerged(repo.repoPath, pr.number))))
    )
      for (const s of stops) stopPreviewsFor([s.id], `PR #${pr.number} was merged`, 'board', s.only)
  }
}

export async function listPrs(projectId: number, opts: { refresh?: boolean } = {}) {
  getProject(projectId)
  const stale = Date.now() - (lastRefresh.get(projectId) ?? 0) > REFRESH_MS
  if (opts.refresh || stale) await refreshPrs(projectId)
  // Open PRs, and the ones merged within the window; a PR closed without merging is in no stage.
  const rows = db
    .select()
    .from(schema.prs)
    .where(
      and(
        eq(schema.prs.projectId, projectId),
        or(eq(schema.prs.open, true), gte(schema.prs.mergedAt, mergedSince())),
      ),
    )
    .orderBy(desc(schema.prs.updatedAt))
    .all()
  const results = db
    .select()
    .from(schema.reviewResults)
    .where(eq(schema.reviewResults.projectId, projectId))
    .orderBy(desc(schema.reviewResults.createdAt))
    .all()
  const repos = listRepos(projectId)
  const tickets = db.select().from(schema.tickets).where(eq(schema.tickets.projectId, projectId)).all()
  const mergeAfter = mergeOrder(projectId, tickets, repos)
  const merges = await Promise.all(
    rows.map((pr) =>
      prMerge(
        pr,
        repos.find((x) => x.id === pr.repoId),
      ),
    ),
  )
  return rows.map((pr, i) => {
    const r = latestResult(results, pr.number, pr.repoId)
    const from = featureTicketsOf(tickets, repos, pr)
    // The ticket the card opens: the feature ticket that names the PR, else the PR's own ticket.
    const opens = from.find((t) => t.prNumber === pr.number) ?? from[0] ?? prTicketOf(tickets, pr.id)
    return {
      ...pr,
      ...prState(pr, merges[i]!),
      repo: repos.find((x) => x.id === pr.repoId)?.name ?? null,
      status: prStatus(pr),
      latestReview: r
        ? { id: r.id, verdict: r.verdict, sha: r.sha, fresh: r.sha === pr.headSha, createdAt: r.createdAt }
        : null,
      ticket: opens ? { id: opens.id, title: opens.title, status: opens.status } : null,
      // The feature tickets that name this PR: by its number, or on its head branch when they name none.
      tickets: from.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee,
        parentId: t.parentId,
      })),
      // Open PRs of the tickets these tickets need: merge those first.
      mergeAfter: [
        ...new Map(
          from
            .flatMap((t) => mergeAfter(t.id))
            .filter((p) => !(p.number === pr.number && p.repoId === pr.repoId))
            .map((p) => [`${p.repoId}:${p.number}`, p]),
        ).values(),
      ],
    }
  })
}

export interface MergeAfter {
  /** The needed ticket. */
  ticketId: number
  title: string
  repoId: number | null
  number: number
  url: string | null
}

/**
 * For each ticket, the open PRs of the tickets it needs merged first. A PR the queue holds counts while
 * it is open there; one outside the queue (named by `prNumber`) while its ticket is not finished.
 */
function mergeOrder(projectId: number, tickets: schema.Ticket[], repos: schema.Repo[]) {
  const ids = tickets.map((t) => t.id)
  const edges = ids.length
    ? db.select().from(schema.ticketNeeds).where(inArray(schema.ticketNeeds.ticketId, ids)).all()
    : []
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const stages = listStages(projectId)
  const rows = edges.length
    ? db.select().from(schema.prs).where(eq(schema.prs.projectId, projectId)).all()
    : []
  const openPr = (n: schema.Ticket): MergeAfter | null => {
    const repo = repos.find((r) => r.id === n.repoId) ?? repos[0]
    if (!repo) return null
    const row = n.prNumber
      ? rows.find((p) => p.repoId === repo.id && p.number === n.prNumber)
      : rows.find((p) => p.repoId === repo.id && p.open && !!n.branch && p.headRef === n.branch)
    const number = n.prNumber ?? row?.number
    const finished = Boolean(n.archivedAt) || isClosed(kindOf(stages, n.status))
    if (!number || (row ? !row.open : finished)) return null
    const url = row?.url ?? (repo.githubRepo ? `https://github.com/${repo.githubRepo}/pull/${number}` : null)
    return { ticketId: n.id, title: n.title, repoId: repo.id, number, url }
  }
  return (ticketId: number) =>
    edges
      .filter((e) => e.ticketId === ticketId)
      .flatMap((e) => {
        const n = byId.get(e.needsId)
        const p = n ? openPr(n) : null
        return p ? [p] : []
      })
}

// PR numbers repeat across repos; an agent-posted result without a repo counts for any of them.
const latestResult = (results: schema.ReviewResult[], prNumber: number, repoId: number | null) =>
  results.find((x) => x.prNumber === prNumber && (x.repoId ?? repoId) === repoId)

/**
 * The PR a ticket was opened as: the one it names with `prNumber`, else the open one on its branch,
 * in the ticket's repo. A PR outside the review queue (the human neither opened nor reviews it) still
 * comes back with its number and GitHub link, without the queue's fields.
 */
export function prForTicket(ticket: schema.Ticket) {
  const repo = ticketRepo(ticket)
  if (!repo || (!ticket.prNumber && !ticket.branch)) return null
  const row = ticket.prNumber
    ? db
        .select()
        .from(schema.prs)
        .where(and(eq(schema.prs.repoId, repo.id), eq(schema.prs.number, ticket.prNumber)))
        .get()
    : db
        .select()
        .from(schema.prs)
        .where(
          and(
            eq(schema.prs.repoId, repo.id),
            eq(schema.prs.headRef, ticket.branch),
            eq(schema.prs.open, true),
          ),
        )
        .orderBy(desc(schema.prs.updatedAt))
        .get()
  const number = ticket.prNumber ?? row?.number
  if (!number) return null
  const results = db
    .select()
    .from(schema.reviewResults)
    .where(
      and(eq(schema.reviewResults.projectId, ticket.projectId), eq(schema.reviewResults.prNumber, number)),
    )
    .orderBy(desc(schema.reviewResults.createdAt))
    .all()
  const r = latestResult(results, number, repo.id)
  return {
    number,
    linkedBy: ticket.prNumber ? ('prNumber' as const) : ('branch' as const),
    url: row?.url ?? (repo.githubRepo ? `https://github.com/${repo.githubRepo}/pull/${number}` : null),
    // Set when the PR is in the review queue: its board id (for threads and holds), title, stage, and
    // where it stands on GitHub (which side of the queue, merge state, CI) as of the last refresh. The
    // merge state is GitHub's word here; `withMergeCheck` checks it in the checkout as the queue does.
    queue: row
      ? {
          id: row.id,
          title: row.title,
          open: row.open,
          status: prStatus(row),
          headSha: row.headSha,
          ...prState(row, githubMerge(row)),
          // A "CI run locally: green" comment names the head: green, whatever GitHub's checks say.
          localCi: row.localCiSha !== null && row.localCiSha === row.headSha,
        }
      : null,
    latestReview: r
      ? {
          id: r.id,
          verdict: r.verdict,
          sha: r.sha,
          fresh: row ? r.sha === row.headSha : null,
          createdAt: r.createdAt,
        }
      : null,
  }
}

export type TicketPr = ReturnType<typeof prForTicket>

/** A ticket's PR (`prForTicket`) with its merge state checked in the repo's checkout, as the queue's is. */
export async function withMergeCheck(pr: TicketPr): Promise<TicketPr> {
  if (!pr?.queue?.open) return pr
  const row = db.select().from(schema.prs).where(eq(schema.prs.id, pr.queue.id)).get()
  if (!row) return pr
  const repo = row.repoId === null ? undefined : listRepos(row.projectId).find((r) => r.id === row.repoId)
  return { ...pr, queue: { ...pr.queue, ...(await prMerge(row, repo)) } }
}

export type PrRow = Awaited<ReturnType<typeof listPrs>>[number]

export function getPr(id: number) {
  const pr = db.select().from(schema.prs).where(eq(schema.prs.id, id)).get()
  if (!pr) throw notFound('PR')
  return pr
}

export function setPrHold(id: number, hold: boolean, holdNote: string, actor: string) {
  const pr = getPr(id)
  const row = db.update(schema.prs).set({ hold, holdNote }).where(eq(schema.prs.id, id)).returning().get()!
  logActivity({
    projectId: pr.projectId,
    actor,
    kind: 'pr',
    text: hold
      ? `put PR #${pr.number} on hold${holdNote ? `: ${holdNote}` : ''}`
      : `released PR #${pr.number} from hold`,
    refType: 'pr',
    refId: id,
  })
  // A hold or its release changes the status, and the PR's ticket follows it.
  const to = queueState(row)
  if (to !== 'left' && to !== queueState(pr)) movePrTicket(row, to, actor)
  return { ...row, status: prStatus(row) }
}
