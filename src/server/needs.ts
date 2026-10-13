import { asc, eq, inArray } from 'drizzle-orm'

import { db, schema } from '#/db'
import { isClosed } from '#/lib/stages'
import { logActivity } from './activity'
import { baseChain, baseRefs, branchRef, gitCache, type GitCache, memo, reachOf, refSha } from './cleanup'
import * as features from './features'
import { holdsWorkOf, type Reach } from './git'
import { type Handoff, ticketHandoff } from './handoff'
import { HttpError } from './http'
import { getProject } from './projects'
import { listRepos } from './repos'
import { withResume, withResumeBriefs } from './resume'
import { deleteStage, firstOfKind, kindOf, listStages, resolveStage, stageOf } from './stages'

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
}

export type NeededBy = Pick<Ticket, 'id' | 'title' | 'branch' | 'prNumber' | 'status'>

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

/** Replace what a ticket needs (checked as `checkNeeds` does); `[]` clears it. */
export function setNeeds(ticketId: number, ids: number[], actor: string) {
  const t = features.getTicket(ticketId)
  const next = checkNeeds(t, ids)
  const before = needIds(ticketId)
  if (next.length === before.length && next.every((id) => before.includes(id))) return before
  db.transaction((tx) => {
    tx.delete(schema.ticketNeeds).where(eq(schema.ticketNeeds.ticketId, ticketId)).run()
    if (next.length)
      tx.insert(schema.ticketNeeds)
        .values(next.map((needsId) => ({ ticketId, needsId })))
        .run()
  })
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

async function needsOf(subject: Subject, ids: number[], ctx: Context): Promise<Need[]> {
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
      const mine = edges.filter((e) => e.ticketId === t.id).map((e) => e.needsId)
      if (mine.length)
        out.set(
          t.id,
          await needsOf(
            t,
            mine.sort((a, b) => a - b),
            ctx,
          ),
        )
    }),
  )
  return out
}

/**
 * The ticket page's read: `getTicketWithPush` with what it needs (each with `merged`), what needs it, its
 * resume note under `resume`, and in a review stage `handoff`: what the hand-off still lacks.
 */
export async function ticketView(id: number, opts: { laneUpdates?: boolean } = {}) {
  const full = await features.getTicketWithPush(id, opts)
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
  const handoff: Handoff | null =
    kindOf(ctx.stages, full.status) === 'review' ? await ticketHandoff(full) : null
  return withResume({ ...full, needs, neededBy, handoff })
}

/** `listTickets` with each ticket's needs, met or not, and whether its resume note holds (`resume`). */
export async function ticketRows(projectId: number, filter: features.TicketFilter = {}) {
  const rows = features.listTickets(projectId, filter)
  const needs = await needsFor(rows, context(projectId))
  return withResumeBriefs(rows.map((t) => ({ ...t, needs: needs.get(t.id) ?? [] })))
}

// --- what a branch took in from other tickets' branches ---

const INCLUDES_MAX = 40
const includesMemo = new Map<string, Promise<boolean>>()

/**
 * The open tickets (same repo, not this ticket's own parents or lanes) whose unmerged work this
 * ticket's branch holds: commits of their branch that are in this one but in none of its bases. A
 * ticket built on this one does not count. At most the 40 most recently updated are checked, and
 * each answer is kept for the commits it was worked out for.
 */
async function includedWork(t: Ticket, ctx: Context): Promise<number[]> {
  const repo = ctx.repoOf(t)
  if (!t.branch || !repo) return []
  const { refs } = await ctx.git(repo.repoPath)
  const ref = branchRef(t.branch, refs)
  if (!ref) return []
  const chain = baseChain(t, ctx.byId, repo)
  const family = new Set([t.id, ...features.laneTree(ctx.all, t.id).map((l) => l.id)])
  for (let p = t.parentId; p; p = ctx.byId.get(p)?.parentId ?? null) family.add(p)
  const candidates = ctx.all
    .filter(
      (o) =>
        !family.has(o.id) &&
        o.branch &&
        o.branch !== t.branch &&
        !o.archivedAt &&
        !isClosed(kindOf(ctx.stages, o.status)) &&
        ctx.repoOf(o)?.id === repo.id &&
        // Built on this ticket's branch: it holds this one's work, not the other way round.
        !baseChain(o, ctx.byId, repo).includes(t.branch),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, INCLUDES_MAX)
  // Every ticket's branch in the repo, this one's too: what a branch is built on is not its own work.
  const others = [
    ...new Set([
      ref,
      ...ctx.all.flatMap(
        (o) => (o.branch && ctx.repoOf(o)?.id === repo.id && branchRef(o.branch, refs)) || [],
      ),
    ]),
  ]
  const at = (r: string) => `${r}@${refSha(r, refs)}`
  const found: number[] = []
  // A few at a time, so a busy project does not start dozens of git processes at once.
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = await Promise.all(
      candidates.slice(i, i + 4).map(async (o) => {
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
        const holds = await memo(includesMemo, 2000, key, () =>
          holdsWorkOf(
            repo.repoPath,
            sha(ref),
            sha(other),
            bases.map(sha),
            others.filter((x) => x !== other).map(sha),
          ),
        )
        return holds ? o.id : null
      }),
    )
    for (const id of batch) if (id !== null) found.push(id)
  }
  return found.sort((a, b) => a - b)
}

/**
 * `get_ticket_git` with `includes`: the open tickets whose unmerged work this ticket's branch holds.
 * Both read the same ref listing, the one every read shares for a few seconds.
 */
export async function ticketGitView(id: number) {
  const repoGit = gitCache({ recent: true })
  const git = await features.ticketGit(id, repoGit)
  const t = features.getTicket(id)
  return { ...git, includes: await includedWork(t, context(t.projectId, repoGit)).catch(() => []) }
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

type Patch = Parameters<typeof features.updateTicket>[1]

/**
 * `updateTicket` with the needs rule: `needs` replaces what the ticket needs, and a move to a done stage
 * is refused while one is not merged, unless the human sends `force` (logged). A move to a review stage
 * answers with `handoff` too: what the hand-off still lacks, as warnings.
 */
export async function changeTicket(
  id: number,
  input: Patch & { needs?: number[]; force?: boolean },
  actor: string,
  opts: { agent: boolean },
) {
  const { needs, force, ...patch } = input
  const before = features.getTicket(id)
  const ids = needs !== undefined ? checkNeeds(before, needs) : needIds(id)
  const subject = {
    ...before,
    repoId: patch.repoId ?? before.repoId,
    baseBranch: patch.baseBranch || before.baseBranch,
    from: before.status,
  }
  const to = patch.status ? resolveStage(listStages(before.projectId), patch.status).key : before.status
  const unmet = await guardDone(subject, to, ids, { force, agent: opts.agent })
  if (needs !== undefined) setNeeds(id, ids, actor)
  const row = Object.keys(patch).length
    ? features.updateTicket(id, patch, actor, opts)
    : features.getTicket(id)
  logOverride(row, unmet, actor)
  if (patch.status && kindOf(listStages(row.projectId), row.status) === 'review')
    return { ...row, handoff: await ticketHandoff(await features.getTicketWithPush(id)) }
  return row
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
  const ids = checkNeeds({ id: null, projectId }, needs)
  if (ids.length && rest.status) {
    const { repo, baseBranch } = features.placement(projectId, rest)
    const to = resolveStage(listStages(projectId), rest.status).key
    await guardDone({ id: null, projectId, repoId: repo.id, baseBranch }, to, ids, opts)
  }
  const seeded = defaultPhases ?? !rest.parentId
  const tasks = seeded ? phasedTasks(getProject(projectId).defaultPhases, rest.tasks ?? []) : rest.tasks
  const row = features.createTicket(projectId, { ...rest, tasks }, actor)
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
  const stages = listStages(t.projectId)
  const pr = t.tags.some((tag) => tag.toLowerCase() === 'pr')
  const to =
    verdict === 'approved' && pr
      ? firstOfKind(stages, 'done')?.key
      : verdict === null && opts.reopenTo
        ? resolveStage(stages, opts.reopenTo).key
        : undefined
  const unmet =
    to && features.verdictOf(t) !== verdict
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
