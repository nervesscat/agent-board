import { and, desc, eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { currentGithubLogin, listMyPrs } from './git'
import { notFound } from './http'
import { getProject } from './projects'

export type PrStatus = 'pending' | 'reviewed' | 'on_hold'

export function prStatus(pr: Pick<schema.Pr, 'hold' | 'myReview'>): PrStatus {
  if (pr.hold) return 'on_hold'
  return pr.myReview === 'none' ? 'pending' : 'reviewed'
}

const REFRESH_MS = 5 * 60_000
const lastRefresh = new Map<number, number>()

/** Pull the PRs assigned to me from GitHub and upsert the snapshot; board-side fields (hold) are kept. */
export async function refreshPrs(projectId: number) {
  const project = getProject(projectId)
  const [ghPrs, me] = await Promise.all([listMyPrs(project.repoPath), currentGithubLogin(project.repoPath)])
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
      .where(and(eq(schema.prs.projectId, projectId), eq(schema.prs.number, pr.number)))
      .get()
    if (existing) db.update(schema.prs).set(values).where(eq(schema.prs.id, existing.id)).run()
    else
      db.insert(schema.prs)
        .values({ ...values, projectId, number: pr.number })
        .run()
  }
  // A PR that left both searches was merged, closed, or unassigned: keep the row, mark it closed.
  const open = db
    .select()
    .from(schema.prs)
    .where(and(eq(schema.prs.projectId, projectId), eq(schema.prs.open, true)))
    .all()
  for (const row of open) {
    if (!seen.has(row.number))
      db.update(schema.prs).set({ open: false, fetchedAt }).where(eq(schema.prs.id, row.id)).run()
  }
  lastRefresh.set(projectId, Date.now())
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
  return rows.map((pr) => {
    const r = results.find((x) => x.prNumber === pr.number)
    return {
      ...pr,
      status: prStatus(pr),
      latestReview: r
        ? { id: r.id, verdict: r.verdict, sha: r.sha, fresh: r.sha === pr.headSha, createdAt: r.createdAt }
        : null,
    }
  })
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
