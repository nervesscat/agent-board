import fs from 'node:fs'
import path from 'node:path'

import { listRefs, listWorktrees, type Refs, type Worktree } from './git'

/**
 * A checkout's branch and worktree listings, asked of git again only once its ref storage on disk says
 * something may have moved. git never rewrites a ref file in place: a commit, a fetch, a branch made or
 * deleted, `pack-refs`, a worktree switched or added write a new file and rename it over the old one
 * (or delete it), so the file's identity, size or times change. A stamp of every ref file and folder
 * (and of each worktree's HEAD) that matches the one taken before the last listing means that listing
 * still holds: a read sees any change git made before it, and a read with nothing moved spawns no git.
 *
 * The stamp only stats and lists folders, never writes or locks anything in `.git`. Where it cannot be
 * sure (no `.git` it can follow, refs in a reftable, too many loose refs to be cheaper than git) there
 * is no stamp, and every read lists with git as it would without this.
 */

/** Past this many loose ref files, statting them costs about what asking git does. */
const LOOSE_MAX = 500
/** Listings kept, one per repo: the oldest repo out first. */
const REPOS_MAX = 100

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

const fileStamp = (file: string) => {
  const st = fs.statSync(file, { bigint: true, throwIfNoEntry: false })
  return st ? `${file} ${st.ino} ${st.size} ${st.mtimeNs} ${st.ctimeNs}` : `${file} -`
}

/** A folder and every folder under it into `lines`, the files under it into `files`. */
function walk(dir: string, lines: string[], files: string[]) {
  const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false })
  if (!st) return void lines.push(`${dir} -`)
  lines.push(`${dir}/ ${st.ino} ${st.mtimeNs} ${st.ctimeNs}`)
  // A ref folder that is a file (a reftable repo's `refs/heads`) throws: no stamp.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, lines, files)
    else files.push(p)
  }
}

/** What `listRefs` reads: the loose refs of the branches and of origin's, and the packed ones. */
function refsStamp(common: string): string | null {
  if (fs.existsSync(path.join(common, 'reftable'))) return null
  const lines: string[] = []
  const files: string[] = []
  walk(path.join(common, 'refs', 'heads'), lines, files)
  walk(path.join(common, 'refs', 'remotes', 'origin'), lines, files)
  if (files.length > LOOSE_MAX) return null
  for (const f of [path.join(common, 'packed-refs'), ...files]) lines.push(fileStamp(f))
  return lines.join('\n')
}

/**
 * What `listWorktrees` reads besides the refs: the main checkout's HEAD, and each linked worktree's
 * HEAD and where it is (`gitdir`).
 */
function worktreesStamp(common: string): string {
  const lines = [fileStamp(path.join(common, 'HEAD'))]
  const dir = path.join(common, 'worktrees')
  const st = fs.statSync(dir, { bigint: true, throwIfNoEntry: false })
  if (!st) return lines.concat(`${dir} -`).join('\n')
  lines.push(`${dir}/ ${st.ino} ${st.mtimeNs} ${st.ctimeNs}`)
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const tree = path.join(dir, entry.name)
    const at = fs.statSync(tree, { bigint: true })
    lines.push(`${tree}/ ${at.ino} ${at.mtimeNs}`, fileStamp(path.join(tree, 'HEAD')))
    lines.push(fileStamp(path.join(tree, 'gitdir')))
  }
  return lines.join('\n')
}

/** The stamps of a checkout now; null for each that cannot be told. */
function stamps(repoPath: string): { refs: string | null; worktrees: string | null } {
  try {
    const dirs = gitDirs(repoPath)
    const refs = dirs && refsStamp(dirs.common)
    return { refs, worktrees: refs && `${refs}\n${worktreesStamp(dirs!.common)}` }
  } catch {
    return { refs: null, worktrees: null }
  }
}

interface Kept<T> {
  stamp: string
  value: Promise<T | null>
}

const keptRefs = new Map<string, Kept<Refs>>()
const keptWorktrees = new Map<string, Kept<Worktree[]>>()

/**
 * The listing kept for `stamp`, else a new one, kept under it. Null when git could not list: that is
 * not kept, the next read asks git again. Reads at the same time with the same stamp share one listing.
 */
function read<T>(
  kept: Map<string, Kept<T>>,
  repoPath: string,
  stamp: string | null,
  list: (repoPath: string) => Promise<T>,
): Promise<T | null> {
  const hit = kept.get(repoPath)
  if (stamp !== null && hit?.stamp === stamp) return hit.value
  kept.delete(repoPath)
  if (stamp === null) return list(repoPath).catch(() => null)
  const entry: Kept<T> = {
    stamp,
    value: list(repoPath).catch(() => {
      if (kept.get(repoPath) === entry) kept.delete(repoPath)
      return null
    }),
  }
  kept.set(repoPath, entry)
  while (kept.size > REPOS_MAX) kept.delete(kept.keys().next().value!)
  return entry.value
}

/** The checkout's branches and origin's as they are now: listed by git only when something moved. */
export function currentRefs(repoPath: string): Promise<Refs | null> {
  return read(keptRefs, repoPath, stamps(repoPath).refs, listRefs)
}

/** The checkout's branches and origin's, and its worktrees, as they are now (see `currentRefs`). */
export function currentListing(repoPath: string) {
  // Taken at once: the stamp is of the moment the read started.
  const now = stamps(repoPath)
  return Promise.all([
    read(keptRefs, repoPath, now.refs, listRefs),
    read(keptWorktrees, repoPath, now.worktrees, listWorktrees),
  ])
}

/** Forgets the checkout's listings (after a fetch by the board): the next read lists again. */
export function dropListings(repoPath: string) {
  keptRefs.delete(repoPath)
  keptWorktrees.delete(repoPath)
}
