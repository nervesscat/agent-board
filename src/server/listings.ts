import fs from 'node:fs'
import path from 'node:path'

import { listRefs, listWorktrees, type Refs, type Worktree } from './git'

/**
 * A checkout's branch and worktree listings, asked of git again only once its ref storage on disk says
 * something may have moved: a read sees any change git made before it, and a read with nothing moved
 * spawns no git.
 *
 * git never rewrites a ref file in place. A commit, a fetch, a branch made or deleted writes a lock
 * file next to the ref and renames it over the ref (or deletes the ref), so the ref's folder changes;
 * `pack-refs` and a deleted packed ref replace `packed-refs`; a worktree switched or added replaces its
 * HEAD. So a listing holds while every ref folder, `packed-refs` and each worktree's HEAD and `gitdir`
 * are as they were when it was taken.
 *
 * A folder's modification time is only as fine as the file system's clock: two changes within one
 * tick of it can leave the same time. A folder changed in the last `SETTLE_MS` is therefore checked by
 * its files instead (each file's identity, size and times), and only an older one by its own time.
 *
 * All of it only stats and lists folders, never writes or locks anything in `.git`. Where it cannot be
 * sure (no `.git` it can follow, refs in a reftable, more loose refs to check one by one than asking
 * git costs) every read lists with git, as it would without this.
 */

/** A folder changed more recently than this is checked file by file. */
const SETTLE_MS = 2_500
/** Past this many ref files to check one by one, asking git costs about the same. */
const LOOSE_MAX = 500
/** Listings kept, one per repo: the oldest repo out first. */
const REPOS_MAX = 100

/**
 * Now, by the earlier of the wall clock and the process's own: a clock that runs ahead could take a
 * folder for settled too soon, one behind only checks it file by file a little longer.
 */
const clock = () => Math.min(Date.now(), performance.timeOrigin + performance.now())

/** The checkout's git dir and the common dir its worktrees share (the same for a main checkout). */
function gitDirs(repoPath: string): { gitDir: string; common: string } | null {
  const dotGit = path.join(repoPath, '.git')
  const st = fs.statSync(dotGit, { throwIfNoEntry: false })
  if (!st) return null
  let gitDir = dotGit
  if (st.isFile()) {
    // A linked worktree: `.git` is a file naming its git dir.
    const named = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]
    if (!named) return null
    gitDir = path.resolve(repoPath, named)
  }
  const commondir = path.join(gitDir, 'commondir')
  const common = fs.existsSync(commondir)
    ? path.resolve(gitDir, fs.readFileSync(commondir, 'utf8').trim())
    : gitDir
  return { gitDir, common }
}

/** A file as it is on disk: replaced, it has another identity (and mostly other times). */
const fileStamp = (file: string) => {
  const st = fs.statSync(file, { bigint: true, throwIfNoEntry: false })
  return st ? `${st.ino} ${st.size} ${st.mtimeNs} ${st.ctimeNs}` : '-'
}

/** A ref folder as last read. */
interface Folder {
  /** Its identity and times; '-' when there is none. */
  stamp: string
  subfolders: string[]
  /** Each file's stamp while the folder is recent; null once it is settled. */
  files: Map<string, string> | null
}

/** The ref folders and `packed-refs` as one listing was taken under. */
interface RefStore {
  folders: Map<string, Folder>
  packed: string
}

/**
 * Reads the ref folders under `roots` and `packed-refs`, going by `kept` for a settled folder that did
 * not change. `same` says whether nothing changed since `kept`; null when the files to check one by
 * one are too many, or the refs are not in folders (a reftable).
 */
function readRefStore(common: string, kept: RefStore | undefined): { store: RefStore; same: boolean } | null {
  if (fs.existsSync(path.join(common, 'reftable'))) return null
  const now = clock()
  const folders = new Map<string, Folder>()
  const packed = fileStamp(path.join(common, 'packed-refs'))
  let same = kept?.packed === packed
  let checked = 0
  const walk = (dir: string) => {
    const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false })
    const stamp = st ? `${st.ino} ${st.mtimeNs} ${st.ctimeNs}` : '-'
    const before = kept?.folders.get(dir)
    if (before?.stamp !== stamp) same = false
    if (!st) return void folders.set(dir, { stamp, subfolders: [], files: null })
    if (before?.stamp === stamp && before.files === null) {
      // Settled when last read and unchanged since: nothing in it moved.
      folders.set(dir, before)
      return before.subfolders.forEach(walk)
    }
    // A ref folder that is a file (a reftable repo's `refs/heads`) throws here: no stamp.
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const subfolders = entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
    const settled = Number(st.mtimeNs / 1_000_000n) < now - SETTLE_MS
    let files: Map<string, string> | null = null
    // Recent now, or recent when last read and unchanged since (its files say whether it is).
    if (!settled || (before?.files && before.stamp === stamp)) {
      const names = entries.filter((e) => !e.isDirectory()).map((e) => e.name)
      checked += names.length
      if (checked > LOOSE_MAX) throw new TooMany()
      files = new Map(names.map((n) => [n, fileStamp(path.join(dir, n))]))
      if (before?.files && !sameFiles(before.files, files)) same = false
    }
    folders.set(dir, { stamp, subfolders, files: settled ? null : files })
    subfolders.forEach(walk)
  }
  try {
    walk(path.join(common, 'refs', 'heads'))
    walk(path.join(common, 'refs', 'remotes', 'origin'))
  } catch (err) {
    if (err instanceof TooMany) return null
    throw err
  }
  if (kept && folders.size !== kept.folders.size) same = false
  return { store: { folders, packed }, same: Boolean(kept) && same }
}

class TooMany extends Error {}

const sameFiles = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...a].every(([name, stamp]) => b.get(name) === stamp)

/**
 * What `listWorktrees` reads besides the refs: the main checkout's HEAD, and each linked worktree's
 * HEAD and where it is (`gitdir`).
 */
function worktreesStamp(common: string): string {
  const lines = [fileStamp(path.join(common, 'HEAD'))]
  const dir = path.join(common, 'worktrees')
  const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false })
  if (!st) return lines.concat('-').join('\n')
  lines.push(`${st.ino} ${st.mtimeNs} ${st.ctimeNs}`)
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const tree = path.join(dir, entry.name)
    lines.push(entry.name, fileStamp(path.join(tree, 'HEAD')), fileStamp(path.join(tree, 'gitdir')))
  }
  return lines.join('\n')
}

interface KeptRefs {
  store: RefStore
  /** Which listing this is: the worktrees listed with it go by it. */
  generation: number
  value: Promise<Refs | null>
}

interface KeptWorktrees {
  stamp: string
  value: Promise<Worktree[] | null>
}

const keptRefs = new Map<string, KeptRefs>()
const keptWorktrees = new Map<string, KeptWorktrees>()
let generations = 0

const bounded = <T>(kept: Map<string, T>, repoPath: string, entry: T) => {
  kept.delete(repoPath)
  kept.set(repoPath, entry)
  while (kept.size > REPOS_MAX) kept.delete(kept.keys().next().value!)
}

/** Lists with git; null when git could not, which is not kept: the next read asks git again. */
function list<T>(
  kept: Map<string, { value: Promise<T | null> }>,
  repoPath: string,
  run: (p: string) => Promise<T>,
) {
  const value: Promise<T | null> = run(repoPath).catch(() => {
    if (kept.get(repoPath)?.value === value) kept.delete(repoPath)
    return null
  })
  return value
}

/**
 * The checkout's refs, and the generation of the listing they are from (null when nothing tells when
 * they change, and the listing is not kept). A read that finds nothing moved shares the kept listing,
 * also while it is still being listed.
 */
function refsNow(
  repoPath: string,
  common: string | null,
): { value: Promise<Refs | null>; generation: number | null } {
  const kept = keptRefs.get(repoPath)
  let read: ReturnType<typeof readRefStore> = null
  try {
    read = common === null ? null : readRefStore(common, kept?.store)
  } catch {
    read = null
  }
  if (!read) {
    keptRefs.delete(repoPath)
    return { value: listRefs(repoPath).catch(() => null), generation: null }
  }
  if (kept && read.same) {
    // A recent folder that settled since is from now on checked by its own time.
    kept.store = read.store
    return { value: kept.value, generation: kept.generation }
  }
  const entry: KeptRefs = { store: read.store, generation: ++generations, value: Promise.resolve(null) }
  entry.value = list(keptRefs, repoPath, listRefs)
  bounded(keptRefs, repoPath, entry)
  return { value: entry.value, generation: entry.generation }
}

function commonOf(repoPath: string): string | null {
  try {
    return gitDirs(repoPath)?.common ?? null
  } catch {
    return null
  }
}

/** The checkout's branches and origin's as they are now: listed by git only when something moved. */
export function currentRefs(repoPath: string): Promise<Refs | null> {
  return refsNow(repoPath, commonOf(repoPath)).value
}

/** The checkout's branches and origin's, and its worktrees, as they are now (see `currentRefs`). */
export function currentListing(repoPath: string) {
  const common = commonOf(repoPath)
  const refs = refsNow(repoPath, common)
  let stamp: string | null = null
  try {
    // A worktree on a branch is listed at the branch's commit: its listing goes by the refs' too.
    stamp =
      refs.generation === null || common === null ? null : `${refs.generation}\n${worktreesStamp(common)}`
  } catch {
    stamp = null
  }
  const kept = keptWorktrees.get(repoPath)
  let worktrees: Promise<Worktree[] | null>
  if (stamp !== null && kept?.stamp === stamp) worktrees = kept.value
  else if (stamp === null) {
    keptWorktrees.delete(repoPath)
    worktrees = listWorktrees(repoPath).catch(() => null)
  } else {
    const entry: KeptWorktrees = { stamp, value: Promise.resolve(null) }
    entry.value = list(keptWorktrees, repoPath, listWorktrees)
    bounded(keptWorktrees, repoPath, entry)
    worktrees = entry.value
  }
  return Promise.all([refs.value, worktrees])
}

/** Forgets the checkout's listings (after a fetch by the board): the next read lists again. */
export function dropListings(repoPath: string) {
  keptRefs.delete(repoPath)
  keptWorktrees.delete(repoPath)
}
