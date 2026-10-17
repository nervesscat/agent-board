import { and, desc, eq, isNull, like, or } from 'drizzle-orm'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { postUpdate } from './features'
import { notFound } from './http'
import { ticketForPr } from './prTickets'
import { getProject } from './projects'
import { resolveRepo } from './repos'

export function listResults(
  projectId: number,
  limit = 100,
  filter: { prNumber?: number; sha?: string; repoId?: number } = {},
) {
  return db
    .select()
    .from(schema.reviewResults)
    .where(
      and(
        eq(schema.reviewResults.projectId, projectId),
        filter.prNumber === undefined ? undefined : eq(schema.reviewResults.prNumber, filter.prNumber),
        // A result posted without a repo counts for every repo, as in the PR queue.
        filter.repoId === undefined
          ? undefined
          : or(eq(schema.reviewResults.repoId, filter.repoId), isNull(schema.reviewResults.repoId)),
        // Short and full SHAs both match.
        filter.sha ? like(schema.reviewResults.sha, `${filter.sha.slice(0, 7)}%`) : undefined,
      ),
    )
    .orderBy(desc(schema.reviewResults.createdAt))
    .limit(limit)
    .all()
    .filter((r) => !filter.sha || r.sha.startsWith(filter.sha) || filter.sha.startsWith(r.sha))
}

export function getResult(id: number) {
  const r = db.select().from(schema.reviewResults).where(eq(schema.reviewResults.id, id)).get()
  if (!r) throw notFound('review result')
  return r
}

/** An agent that reviewed by hand (or any other tool) posts its result here. */
export function postResult(
  projectId: number,
  input: {
    prNumber: number
    sha: string
    verdict: string
    summaryMd: string
    checks?: Record<string, string>
    counts?: Record<string, number>
    repoId?: number | null
  },
  actor: string,
) {
  getProject(projectId)
  const repo = resolveRepo(projectId, input.repoId)
  const row = db
    .insert(schema.reviewResults)
    .values({
      projectId,
      repoId: repo.id,
      prNumber: input.prNumber,
      sha: input.sha,
      verdict: input.verdict,
      summaryMd: input.summaryMd,
      checks: input.checks ?? {},
      counts: input.counts ?? {},
      author: actor,
    })
    .returning()
    .get()
  logActivity({
    projectId,
    actor,
    kind: 'review',
    text: `posted a review of PR #${input.prNumber}: ${input.verdict}`,
    refType: 'review',
    refId: row.id,
  })
  // The PR's ticket (the feature ticket that names it, else its own) gets the verdict and the summary, as a post.
  const ticket = ticketForPr(projectId, repo.id, input.prNumber)
  if (ticket) {
    const verdict = `Review of PR #${input.prNumber} at ${input.sha.slice(0, 7)}: ${input.verdict}`
    postUpdate(ticket.id, [verdict, input.summaryMd.trim()].filter(Boolean).join('\n\n'), [], actor)
  }
  return row
}
