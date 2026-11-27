import { and, desc, eq, isNull, like, or } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '#/db'
import { logActivity } from './activity'
import { postUpdate } from './features'
import { HttpError, notFound } from './http'
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

// The finding a caller posts: every field but fixedIn, which starts null and is set later.
const findingInput = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  severity: z.enum(['major', 'medium', 'minor']),
  verdict: z.enum(['confirmed', 'plausible']),
  origin: z.enum(['original-build', 'previous-fix', 'pre-existing']),
  finder: z.enum(['hunt-a', 'hunt-b', 'verify']),
  round: z.number().int().min(1).optional(),
})

/** A finding's fixing commit: 7 to 40 hex characters (not checked against git). */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i

/** Checks the round and findings of a posted result and gives each finding its stored shape. */
function findingsFor(round: number | null, findings: unknown[]): schema.ReviewFinding[] {
  if (round !== null && (!Number.isInteger(round) || round < 1))
    throw new HttpError(400, 'round must be 1 or more')
  if (findings.length && round === null)
    throw new HttpError(400, 'a result with findings must carry its round')
  const parsed = z.array(findingInput).safeParse(findings)
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error))
  const ids = new Set<string>()
  return parsed.data.map((f) => {
    if (ids.has(f.id)) throw new HttpError(400, `finding id ${f.id} repeats within this result`)
    ids.add(f.id)
    if (f.round !== undefined && f.round !== round) {
      throw new HttpError(400, `finding ${f.id} is round ${f.round}, but its result is round ${round}`)
    }
    return { ...f, round: round!, fixedIn: null }
  })
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
    round?: number | null
    findings?: unknown[]
  },
  actor: string,
) {
  getProject(projectId)
  const repo = resolveRepo(projectId, input.repoId)
  const round = input.round ?? null
  const findings = findingsFor(round, input.findings ?? [])
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
      round,
      findings,
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

/** Sets one finding's fixing commit (or clears it) and returns the result with the change. */
export function setFindingFixed(
  projectId: number,
  resultId: number,
  findingId: string,
  fixedIn: string | null,
) {
  if (fixedIn !== null && !SHA_PATTERN.test(fixedIn))
    throw new HttpError(400, 'fixedIn must be a commit SHA or null')
  const r = getResult(resultId)
  if (r.projectId !== projectId) throw notFound('review result')
  if (!r.findings.some((f) => f.id === findingId)) throw notFound('finding')
  const findings = r.findings.map((f) => (f.id === findingId ? { ...f, fixedIn } : f))
  return db
    .update(schema.reviewResults)
    .set({ findings })
    .where(eq(schema.reviewResults.id, resultId))
    .returning()
    .get()
}

/**
 * A PR's results grouped by review round, rounds ascending; each result keeps its findings and loses its
 * summary. Results posted without a round are in no round.
 */
export function roundsOf(results: schema.ReviewResult[]) {
  const byRound = new Map<number, Omit<schema.ReviewResult, 'summaryMd'>[]>()
  for (const { summaryMd: _summary, ...r } of results) {
    if (r.round === null) continue
    byRound.set(r.round, [...(byRound.get(r.round) ?? []), r])
  }
  return [...byRound.keys()].sort((a, b) => a - b).map((round) => ({ round, results: byRound.get(round)! }))
}

/** The PR's review rounds (roundsOf over its results, in the repo rule of listResults). */
export function listRounds(projectId: number, prNumber: number, repoId?: number) {
  return roundsOf(listResults(projectId, 1000, { prNumber, repoId }))
}
