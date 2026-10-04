import { and, desc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { currentGithubLogin, listMyPrs } from './git'
import { notFound } from './http'
import { getProject } from './projects'
import { listRepos, ticketRepo } from './repos'

export type PrStatus = 'pending' | 'reviewed' | 'on_hold'

export function prStatus(pr: Pick<schema.Pr, 'hold' | 'myReview'>): PrStatus {
  if (pr.hold) return 'on_hold'
  return pr.myReview === 'none' ? 'pending' : 'reviewed'
}

const REFRESH_MS = 5 * 60_000
const lastRefresh = new Map<number, number>()

/**
 * Every repo of the project, refreshed side by side; the queue is their union. A repo gh cannot see
 * (no GitHub remote) is skipped, and one failing repo does not hide the others' PRs.
 */
export async function refreshPrs(projectId: number) {
  getProject(projectId)
  const repos = listRepos(projectId).filter((r) => r.githubRepo)
  const results = await Promise.allSettled(repos.map((r) => refreshRepoPrs(r)))
  const failed = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ repo: repos[i]!, err: r.reason }] : [],
  )
  for (const f of failed) console.error(`PR refresh failed for ${f.repo.name}:`, f.err)
  if (repos.length && failed.length === repos.length) throw failed[0]!.err
  lastRefresh.set(projectId, Date.now())
}

/** Pull the PRs assigned to me from GitHub and upsert the snapshot; board-side fields (hold) are kept. */
async function refreshRepoPrs(repo: schema.Repo) {
  const { projectId } = repo
  const [ghPrs, me] = await Promise.all([listMyPrs(repo.repoPath), currentGithubLogin(repo.repoPath)])
  const fetchedAt = new Date().toISOString()
  const seen = new Set<number>()
  for (const pr of ghPrs) {
    seen.add(pr.number)
    const mine = pr.reviews
      .filter((r) => r.author.login === me)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    const myReview = mine[0] ? mine[0].state.toLowerCase() : 'none'
    const values = {
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      headSha: pr.headRefOid,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision || null,
      myReview,
      updatedAt: pr.updatedAt,
      fetchedAt,
      open: true,
    }
    const existing = db
      .select({ id: schema.prs.id })
      .from(schema.prs)
      .where(and(eq(schema.prs.repoId, repo.id), eq(schema.prs.number, pr.number)))
      .get()
    if (existing)
      db.update(schema.prs)
        .set({ ...values, projectId })
        .where(eq(schema.prs.id, existing.id))
        .run()
    else
      db.insert(schema.prs)
        .values({ ...values, projectId, repoId: repo.id, number: pr.number })
        .run()
  }
  // A PR that left every search was merged, closed, or unassigned: keep the row, mark it closed.
  const open = db
    .select()
    .from(schema.prs)
    .where(and(eq(schema.prs.repoId, repo.id), eq(schema.prs.open, true)))
    .all()
  for (const row of open) {
    if (!seen.has(row.number))
      db.update(schema.prs).set({ open: false, fetchedAt }).where(eq(schema.prs.id, row.id)).run()
  }
}

export async function listPrs(projectId: number, opts: { refresh?: boolean } = {}) {
  getProject(projectId)
  const stale = Date.now() - (lastRefresh.get(projectId) ?? 0) > REFRESH_MS
  if (opts.refresh || stale) await refreshPrs(projectId)
  const rows = db
    .select()
    .from(schema.prs)
    .where(and(eq(schema.prs.projectId, projectId), eq(schema.prs.open, true)))
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
  return rows.map((pr) => {
    const r = latestResult(results, pr.number, pr.repoId)
    return {
      ...pr,
      repo: repos.find((x) => x.id === pr.repoId)?.name ?? null,
      status: prStatus(pr),
      latestReview: r
        ? { id: r.id, verdict: r.verdict, sha: r.sha, fresh: r.sha === pr.headSha, createdAt: r.createdAt }
        : null,
      // The tickets this PR came from: named by their PR number, or on its head branch when they name none.
      tickets: tickets
        .filter(
          (t) =>
            (t.repoId ?? repos[0]?.id) === pr.repoId &&
            (t.prNumber === pr.number || (t.prNumber === null && !!t.branch && t.branch === pr.headRef)),
        )
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee: t.assignee,
          parentId: t.parentId,
        })),
    }
  })
}

// PR numbers repeat across repos; an agent-posted result without a repo counts for any of them.
const latestResult = (results: schema.ReviewResult[], prNumber: number, repoId: number | null) =>
  results.find((x) => x.prNumber === prNumber && (x.repoId ?? repoId) === repoId)

/**
 * The PR a ticket was opened as: the one it names with `prNumber`, else the open one on its branch,
 * in the ticket's repo. A PR outside the review queue (not assigned to the human) still comes back
 * with its number and GitHub link, without the queue's fields.
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
    // Set when the PR is in the review queue: its board id (for threads and holds), title and state.
    queue: row
      ? { id: row.id, title: row.title, open: row.open, status: prStatus(row), headSha: row.headSha }
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
  return { ...row, status: prStatus(row) }
}
