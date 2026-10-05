import fs from 'node:fs'
import path from 'node:path'

import { eq } from 'drizzle-orm'

import { db, schema } from '#/db'
import { isClosed } from '#/lib/stages'
import { aheadBehind, fetchOrigin, listRefs, mergedInto, notOnOrigin, type Refs } from './git'
import { getProject } from './projects'
import { listRepos } from './repos'
import { kindOf, listStages } from './stages'

/**
 * Whether a branch is on origin, read from the checkout's copy of origin's branches. That copy is only
 * as fresh as its last fetch, so each repo is fetched in the background at most every few minutes
 * (never while a request waits on it), and on demand. The board never pushes.
 *
 * - `pushed`: origin has the branch and every commit of it (origin may be ahead: `behind`);
 * - `ahead`: the local branch has `ahead` commits origin's lacks;
 * - `local-only`: origin has no such branch; `ahead` commits of it are on no origin branch at all;
 * - `merged`: origin has no such branch (GitHub deletes it once its PR is merged) and it was merged
 *   into origin's copy of its base, `into`;
 * - `remote-only`: only origin has it (no local branch, e.g. after cleanup);
 * - `none`: no branch given, or it exists nowhere.
 */
export type PushState = 'pushed' | 'ahead' | 'local-only' | 'merged' | 'remote-only' | 'none'

export interface Push {
  state: PushState
  ahead: number
  behind: number
  /** The base it was merged into: only on `merged`. */
  into?: string
  /** When origin's branches were last fetched into the checkout; null when that is not known. */
  checkedAt: string | null
}

export const NO_PUSH: Push = { state: 'none', ahead: 0, behind: 0, checkedAt: null }

/** At most one background fetch per repo this often. */
export const FETCH_EVERY = 5 * 60_000
const FETCH_TIMEOUT = 60_000
/** The refs are read again at most this often (a fetch reads them afresh). */
const REFS_TTL = 3_000

interface RepoState {
  /** When the board last started a fetch, whatever came of it. */
  triedAt: number
  /** When a fetch by the board last succeeded. */
  fetchedAt: number | null
  fetching: Promise<void> | null
  error: string | null
  refs: { at: number; value: Promise<Refs | null> } | null
}

const repos = new Map<string, RepoState>()
/** Ahead/behind per pair of shas (and commits on no origin branch per sha): they never change. */
const counts = new Map<string, Promise<[number, number]>>()
/** Whether a sha was merged into a base's sha: never changes either. */
const merges = new Map<string, Promise<boolean>>()

function repoState(repoPath: string): RepoState {
  let s = repos.get(repoPath)
  if (!s) repos.set(repoPath, (s = { triedAt: 0, fetchedAt: null, fetching: null, error: null, refs: null }))
  return s
}

/**
 * The last fetch of anyone (a `git fetch` or `git pull` by hand too), from FETCH_HEAD in the checkout.
 * A failed fetch leaves it empty, so an empty one says nothing.
 */
function fetchHeadTime(repoPath: string): number | null {
  try {
    const st = fs.statSync(path.join(repoPath, '.git', 'FETCH_HEAD'))
    return st.size ? st.mtimeMs : null
  } catch {
    return null
  }
}

function lastFetch(repoPath: string): number | null {
  const ours = repoState(repoPath).fetchedAt
  const any = fetchHeadTime(repoPath)
  return ours === null ? any : any === null ? ours : Math.max(ours, any)
}

/**
 * Fetches origin into the checkout unless it was fetched less than `FETCH_EVERY` ago (`force` skips
 * that check). A fetch already running is joined instead of started again. Returns null when it
 * skipped; the promise never rejects (a failure is kept as the repo's `error`).
 */
export function fetchRepo(repoPath: string, opts: { force?: boolean } = {}): Promise<void> | null {
  const s = repoState(repoPath)
  if (s.fetching) return s.fetching
  const last = Math.max(s.triedAt, lastFetch(repoPath) ?? 0)
  if (!opts.force && Date.now() - last < FETCH_EVERY) return null
  s.triedAt = Date.now()
  s.fetching = fetchOrigin(repoPath, FETCH_TIMEOUT)
    .then(
      () => {
        s.fetchedAt = Date.now()
        s.error = null
      },
      (err: unknown) => {
        s.error = fetchError(err)
      },
    )
    .finally(() => {
      s.fetching = null
      s.refs = null
    })
  return s.fetching
}

/** git's own last word on why a fetch failed (the first line is the command), or the timeout. */
function fetchError(err: unknown): string {
  const e = err as { killed?: boolean; stderr?: string; message?: string }
  if (e.killed) return `git fetch gave up after ${FETCH_TIMEOUT / 1000} s`
  const said = (e.stderr || e.message || String(err)).trim().split('\n').filter(Boolean)
  return said.at(-1) ?? 'git fetch failed'
}

/** Whether origin was fetched into the checkout lately, and how the board's last try went. */
export function fetchStatus(repoPath: string) {
  const s = repoState(repoPath)
  const last = lastFetch(repoPath)
  return {
    checkedAt: last === null ? null : new Date(last).toISOString(),
    fetching: s.fetching !== null,
    error: s.error,
  }
}

function readRefs(repoPath: string): Promise<Refs | null> {
  const s = repoState(repoPath)
  if (!s.refs || Date.now() - s.refs.at > REFS_TTL)
    s.refs = { at: Date.now(), value: listRefs(repoPath).catch(() => null) }
  return s.refs.value
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, work: () => Promise<T>) {
  if (!cache.has(key)) {
    // Shas are forever, but branches move: keep the memo from growing without end.
    if (cache.size > 5000) cache.clear()
    cache.set(
      key,
      work().catch((err: unknown) => {
        cache.delete(key)
        throw err
      }),
    )
  }
  return cache.get(key)!
}

/**
 * The push state of each branch in one checkout: one `for-each-ref` for all of them (cached a few
 * seconds), then a `rev-list` only for a branch whose local and origin shas differ (cached per pair).
 * `bases` gives a branch's base (its ticket's): a branch gone from origin that was merged into
 * origin's copy of it is `merged`. Starts a background fetch when origin's copy is stale; never waits
 * for it.
 */
export async function pushStates(
  repoPath: string,
  branches: string[],
  bases: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, Push>> {
  fetchRepo(repoPath)
  const refs = await readRefs(repoPath)
  const { checkedAt } = fetchStatus(repoPath)
  const out = new Map<string, Push>()
  await Promise.all(
    [...new Set(branches)].map(async (branch) => {
      out.set(
        branch,
        refs && branch ? await pushOf(repoPath, branch, bases.get(branch), refs, checkedAt) : NO_PUSH,
      )
    }),
  )
  return out
}

async function pushOf(
  repoPath: string,
  branch: string,
  base: string | undefined,
  refs: Refs,
  checkedAt: string | null,
): Promise<Push> {
  const local = refs.local.get(branch)
  const remote = refs.remote.get(branch)
  const at = { checkedAt }
  try {
    if (local && remote) {
      if (local === remote) return { state: 'pushed', ahead: 0, behind: 0, ...at }
      const [ahead, behind] = await memo(counts, `${local}...${remote}`, () =>
        aheadBehind(repoPath, local, remote),
      )
      return { state: ahead ? 'ahead' : 'pushed', ahead, behind, ...at }
    }
    if (local) {
      const [ahead] = await memo(counts, local, async () => [await notOnOrigin(repoPath, local), 0])
      // Every commit is on origin somewhere: perhaps in its base, its PR merged and the branch deleted.
      const onBase = base && base !== branch ? refs.remote.get(base) : undefined
      if (!ahead && onBase) {
        const merged = await memo(merges, `${local}>${onBase}`, () =>
          mergedInto(repoPath, local, `origin/${base}`),
        )
        if (merged) return { state: 'merged', ahead: 0, behind: 0, into: base, ...at }
      }
      return { state: 'local-only', ahead, behind: 0, ...at }
    }
  } catch {
    return { ...NO_PUSH, ...at }
  }
  if (remote) return { state: 'remote-only', ahead: 0, behind: 0, ...at }
  return { ...NO_PUSH, ...at }
}

/** Not pushed: the human should hear about these (a merged branch is not one of them). */
export const unpushed = (p: Pick<Push, 'state'>) => p.state === 'ahead' || p.state === 'local-only'

export interface ProjectPush {
  /** Each repo of the project: when origin was last fetched into it, and the board's last try. */
  repos: { id: number; name: string; checkedAt: string | null; fetching: boolean; error: string | null }[]
  /** Every ticket and lane with a branch that is still in work (not done, cancelled or archived). */
  tickets: { id: number; repoId: number | null; branch: string; push: Push }[]
}

/**
 * The push state of every branch the project's tickets in work hold: one batch of git per repo, so a
 * board can colour all its cards with one request.
 */
export async function projectPush(projectId: number): Promise<ProjectPush> {
  getProject(projectId)
  const stages = listStages(projectId)
  const list = listRepos(projectId)
  const byId = new Map(list.map((r) => [r.id, r]))
  const tickets = db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.projectId, projectId))
    .all()
    .filter((t) => t.branch && !t.archivedAt && !isClosed(kindOf(stages, t.status)))
    .map((t) => ({ t, repo: (t.repoId ? byId.get(t.repoId) : list[0]) ?? null }))
  const states = new Map(
    await Promise.all(
      list.map(
        async (r) =>
          [
            r.id,
            await pushStates(
              r.repoPath,
              tickets.filter(({ repo }) => repo?.id === r.id).map(({ t }) => t.branch),
              new Map(
                tickets.filter(({ repo }) => repo?.id === r.id).map(({ t }) => [t.branch, t.baseBranch]),
              ),
            ),
          ] as const,
      ),
    ),
  )
  return {
    repos: list.map((r) => ({ id: r.id, name: r.name, ...fetchStatus(r.repoPath) })),
    tickets: tickets.map(({ t, repo }) => ({
      id: t.id,
      repoId: repo?.id ?? null,
      branch: t.branch,
      push: (repo && states.get(repo.id)?.get(t.branch)) ?? NO_PUSH,
    })),
  }
}

/** Fetches every repo of the project now (waiting for it), then answers as `projectPush`. */
export async function refreshProjectPush(projectId: number): Promise<ProjectPush> {
  getProject(projectId)
  await Promise.all(listRepos(projectId).map((r) => fetchRepo(r.repoPath, { force: true })))
  return projectPush(projectId)
}
