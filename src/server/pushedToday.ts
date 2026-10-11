import { createHash } from 'node:crypto'

import { and, asc, eq, gte, lt } from 'drizzle-orm'

import { db, schema } from '#/db'
import { localDate } from '#/lib/format'
import { commitsBrought, type CommitLines, type Refs } from './git'
import { getProject } from './projects'
import { fetchRepo, fetchStatus, readRefs } from './push'
import { listRepos } from './repos'

/**
 * What reached origin today on a project's repos: the commits that became reachable from an origin
 * branch today (by the moves of origin's branches the board saw, not by commit dates), each counted
 * once, with the lines they added and removed.
 */

export interface PushedToday {
  /** The local day counted, YYYY-MM-DD. */
  date: string
  commits: number
  added: number
  removed: number
  /** When origin was last fetched into the project's checkouts; null when that is not known. */
  checkedAt: string | null
  repos: {
    repoId: number
    name: string
    commits: number
    added: number
    removed: number
    branches: {
      branch: string
      commits: number
      added: number
      removed: number
      /** The ticket whose branch it is, if one is. */
      ticket: { id: number; title: string } | null
    }[]
  }[]
}

/** Moves older than this are of no use: only a day's are ever counted. */
const KEEP_MOVES_DAYS = 30

/**
 * Called with every fresh listing of a checkout's branches: records, for each repo of the board on
 * that checkout, which of origin's branches moved since the last listing (old sha to new sha; null
 * for a branch that appeared or went away). The first look at a repo only takes note of where
 * origin's branches are: what was there before the board looked was not seen arriving.
 *
 * Which repos the board has looked at is kept (`origin_looks`), since a look can find no branch on
 * origin (a new, empty repo): its first push is then a move like any other. But a checkout that never
 * fetched lists no branch of origin either, whatever origin has, and FETCH_HEAD does not tell the two
 * apart (a failed fetch leaves an empty one too). So a listing without one is a look only when
 * `fetched`: the board's own fetch of the checkout had succeeded before the listing began. Taking
 * the other for a look would count all of origin's history as pushed on the day it is first fetched.
 */
export function noteOriginRefs(
  repoPath: string,
  refs: Refs,
  now = new Date(),
  opts: { fetched?: boolean } = {},
) {
  const repos = db.select().from(schema.repos).where(eq(schema.repos.repoPath, repoPath)).all()
  const seenAt = now.toISOString()
  for (const repo of repos) {
    db.transaction((tx) => {
      const firstLook = !tx
        .select({ repoId: schema.originLooks.repoId })
        .from(schema.originLooks)
        .where(eq(schema.originLooks.repoId, repo.id))
        .get()
      if (firstLook) {
        // Nothing listed and nothing fetched: not a look at origin.
        if (!refs.remote.size && !opts.fetched) return
        tx.insert(schema.originLooks).values({ repoId: repo.id, seenAt }).run()
      }
      const known = new Map(
        tx
          .select()
          .from(schema.originRefs)
          .where(eq(schema.originRefs.repoId, repo.id))
          .all()
          .map((r) => [r.ref, r.sha]),
      )
      // Every branch of origin gone at once is the checkout's copy of origin going away (its remote
      // removed, or renamed and added again), not origin deleting them all: they are kept as they were,
      // so their coming back is no move.
      if (!refs.remote.size && known.size) return
      const moves: (typeof schema.originRefMoves.$inferInsert)[] = []
      for (const [ref, sha] of refs.remote) {
        const old = known.get(ref)
        if (old === sha) continue
        if (!firstLook) moves.push({ repoId: repo.id, ref, oldSha: old ?? null, newSha: sha, seenAt })
        tx.insert(schema.originRefs)
          .values({ repoId: repo.id, ref, sha, seenAt })
          .onConflictDoUpdate({
            target: [schema.originRefs.repoId, schema.originRefs.ref],
            set: { sha, seenAt },
          })
          .run()
      }
      for (const [ref, old] of known) {
        if (refs.remote.has(ref)) continue
        moves.push({ repoId: repo.id, ref, oldSha: old, newSha: null, seenAt })
        tx.delete(schema.originRefs)
          .where(and(eq(schema.originRefs.repoId, repo.id), eq(schema.originRefs.ref, ref)))
          .run()
      }
      if (!moves.length) return
      tx.insert(schema.originRefMoves).values(moves).run()
      const old = new Date(now.getTime() - KEEP_MOVES_DAYS * 86_400_000).toISOString()
      tx.delete(schema.originRefMoves)
        .where(and(eq(schema.originRefMoves.repoId, repo.id), lt(schema.originRefMoves.seenAt, old)))
        .run()
    })
  }
}

/**
 * The commits a move brought and their lines, by the tip it moved to and every tip origin had that day
 * before it: neither ever changes, so a read with no new move asks git nothing. The key is hashed, since
 * it names every branch of origin.
 */
const brought = new Map<string, Promise<CommitLines[]>>()

function commitsOf(repoPath: string, tip: string, before: string[]) {
  const shas = [...new Set(before)].sort()
  const key = createHash('sha1')
    .update(`${repoPath}\n${tip}\n${shas.join('\n')}`)
    .digest('hex')
  if (!brought.has(key)) {
    // Keep the memo from growing without end, as push's are.
    if (brought.size > 5000) brought.clear()
    brought.set(
      key,
      commitsBrought(repoPath, tip, shas).catch((err: unknown) => {
        brought.delete(key)
        throw err
      }),
    )
  }
  return brought.get(key)!
}

/** The local day of `now`, from its midnight to the next, as the instants moves are stored with. */
function dayOf(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { date: localDate(now), start: start.toISOString(), end: end.toISOString() }
}

interface Totals {
  commits: number
  added: number
  removed: number
}

const count = (into: Totals, c: CommitLines) => {
  into.commits += 1
  into.added += c.added
  into.removed += c.removed
}

type RepoPushed = PushedToday['repos'][number]
type BranchPushed = RepoPushed['branches'][number]

/**
 * What reached origin on the local day of `now` in each of the project's repos. Each repo's branches
 * are read as `pushStates` reads them (which records any move), starting a background fetch when
 * origin's copy is stale and never waiting for it. A commit counts under the first branch whose move
 * that day brought it, and once in the repo's and the project's totals; one that a branch of origin
 * had when the day began or at any point of it before the move does not count, nor does a merge
 * commit.
 */
export async function pushedToday(projectId: number, now = new Date()): Promise<PushedToday> {
  getProject(projectId)
  const day = dayOf(now)
  const repos = listRepos(projectId)
  const tickets = db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .orderBy(asc(schema.tickets.id))
    .all()
    .filter((t) => t.branch)
  const counted = new Set<string>()
  const out: PushedToday = { date: day.date, commits: 0, added: 0, removed: 0, checkedAt: null, repos: [] }

  for (const repo of repos) {
    fetchRepo(repo.repoPath)
    await readRefs(repo.repoPath)
    const { checkedAt } = fetchStatus(repo.repoPath)
    // The oldest look at origin among the repos: everything counted is at least that fresh.
    if (checkedAt && (!out.checkedAt || checkedAt < out.checkedAt)) out.checkedAt = checkedAt

    const moves = db
      .select()
      .from(schema.originRefMoves)
      .where(and(eq(schema.originRefMoves.repoId, repo.id), gte(schema.originRefMoves.seenAt, day.start)))
      .orderBy(asc(schema.originRefMoves.id))
      .all()
    if (!moves.some((m) => m.newSha && m.seenAt < day.end)) continue

    // Origin's branches as they were when the day began: where they are now, every later move undone.
    const state = new Map(
      db
        .select()
        .from(schema.originRefs)
        .where(eq(schema.originRefs.repoId, repo.id))
        .all()
        .map((r) => [r.ref, r.sha]),
    )
    for (const m of [...moves].reverse()) {
      if (m.oldSha) state.set(m.ref, m.oldSha)
      else state.delete(m.ref)
    }

    const entry: RepoPushed = {
      repoId: repo.id,
      name: repo.name,
      commits: 0,
      added: 0,
      removed: 0,
      branches: [],
    }
    const byBranch = new Map<string, BranchPushed>()
    // Then the day's moves again, in order: each brings what no tip origin had since the day began
    // reaches, a branch deleted since included (a branch that goes away and comes back brings nothing).
    const had = new Set(state.values())
    for (const m of moves) {
      if (m.seenAt >= day.end) break
      if (!m.newSha) continue
      const before = [...had]
      had.add(m.newSha)
      const commits = await commitsOf(repo.repoPath, m.newSha, before).catch((err: unknown) => {
        console.error(`reading what ${m.ref} brought to origin in ${repo.repoPath} failed:`, err)
        return []
      })
      for (const c of commits) {
        if (counted.has(c.sha)) continue
        counted.add(c.sha)
        let branch = byBranch.get(m.ref)
        if (!branch) {
          byBranch.set(m.ref, (branch = { branch: m.ref, commits: 0, added: 0, removed: 0, ticket: null }))
          entry.branches.push(branch)
        }
        count(branch, c)
        count(entry, c)
        count(out, c)
      }
    }
    if (!entry.commits) continue
    for (const b of entry.branches) b.ticket = ticketOf(tickets, repos, repo.id, b.branch)
    out.repos.push(entry)
  }
  return out
}

/**
 * The ticket whose branch it is in that repo (a ticket without a repo is on the project's first): one
 * still on the board before an archived one, the latest of each.
 */
function ticketOf(
  tickets: schema.Ticket[],
  repos: schema.Repo[],
  repoId: number,
  branch: string,
): { id: number; title: string } | null {
  const mine = tickets.filter((t) => t.branch === branch && (t.repoId ?? repos[0]?.id) === repoId)
  const t = mine.filter((x) => !x.archivedAt).at(-1) ?? mine.at(-1)
  return t ? { id: t.id, title: t.title } : null
}
