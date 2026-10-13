import fs from 'node:fs'
import path from 'node:path'

import { pathKey } from './cleanup'

/**
 * The links in a worktree, removed as links before it. `git worktree remove` deletes the worktree's
 * folder with all it holds, and on Windows it goes through a directory junction as through a folder:
 * a `node_modules` or `data` linked to another checkout's would be emptied with it. So before a
 * worktree is removed, each of its links is removed first, the link alone, and what one leads to out
 * of the worktree stays as it is. Those within it go too: git deletes what they lead to by its own
 * path, where a junction it reached after its target would stop the removal half-way (pnpm's
 * `node_modules/<package>` into `node_modules/.pnpm`, which comes first).
 */

export interface WorktreeLink {
  /** The link, in the worktree. */
  path: string
  /** Where it says it leads, as the link holds it: what makes it again. */
  target: string
  /** Where it leads in the end, through any links on the way; null when that cannot be told. */
  resolved: string | null
  /** Whether it leads out of the worktree, or nowhere (dangling, or past what can be read). */
  outward: boolean
}

/** How many folders are read, or links handled, at once. */
const WIDTH = 8
const BATCH = 64

/**
 * Every link in the worktree, found without ever going through one: the folder a link within it
 * leads to is read where it is. Also, in the same walk, every folder in it that holds a `.git` of its
 * own (`repos`): a repository or another worktree, of this repository or any other, which git would
 * delete with the worktree. Throws when a folder or a link cannot be read: what is not known is not
 * safe.
 */
export async function worktreeLinks(
  worktreePath: string,
): Promise<{ links: WorktreeLink[]; repos: string[] }> {
  const root = pathKey(await fs.promises.realpath(worktreePath))
  const within = (p: string) => pathKey(p) === root || pathKey(p).startsWith(`${root}/`)
  const found = await findLinks(worktreePath)
  const links = await inBatches(found.links, async (link) => {
    const target = await fs.promises.readlink(link)
    const resolved = await fs.promises.realpath(link).catch(() => null)
    return { path: link, target, resolved, outward: !resolved || !within(resolved) }
  })
  return { links, repos: found.repos }
}

/**
 * Every link under `dir`, each folder read once and none read through a link; and every folder below
 * `dir` that holds a `.git`, whose own git folder is not read.
 */
async function findLinks(dir: string): Promise<{ links: string[]; repos: string[] }> {
  const links: string[] = []
  const repos: string[] = []
  const pending = [dir]
  let reading = 0
  await new Promise<void>((resolve, reject) => {
    let failed = false
    const next = () => {
      if (failed) return
      if (!pending.length && !reading) return resolve()
      while (pending.length && reading < WIDTH) {
        reading++
        const folder = pending.pop()!
        readFolder(folder, folder !== dir)
          .then((found) => {
            if (found.repo) repos.push(folder)
            // One at a time: spread, a folder of some 125 000 entries is too many arguments.
            for (const link of found.links) links.push(link)
            for (const sub of found.folders) pending.push(sub)
            reading--
            next()
          })
          // Whatever throws, here or in the reading, ends the walk: it must never be left unsettled.
          .catch((err: unknown) => {
            failed = true
            reject(err)
          })
      }
    }
    next()
  })
  return { links, repos }
}

/** A folder's links and folders; `nested`, a folder below the worktree's, also whether it holds a `.git`. */
async function readFolder(dir: string, nested: boolean) {
  const links: string[] = []
  const folders: string[] = []
  let repo = false
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    // A file, a folder or a link: a worktree's `.git` is a file, a repository's a folder.
    if (nested && pathKey(e.name) === '.git') {
      repo = true
      continue
    }
    // On Windows a junction reads as a link too, never as a folder.
    if (e.isSymbolicLink()) links.push(p)
    else if (e.isDirectory()) folders.push(p)
    else if (!e.isFile()) {
      // A type the listing did not give: asked of the entry itself.
      const s = await fs.promises.lstat(p)
      if (s.isSymbolicLink()) links.push(p)
      else if (s.isDirectory()) folders.push(p)
    }
  }
  return { links, folders, repo }
}

/** `work` on every item, a batch at a time; the first that throws throws. */
export async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += BATCH)
    out.push(...(await Promise.all(items.slice(i, i + BATCH).map(work))))
  return out
}

/**
 * Removes the link itself, never what it leads to: `unlink`, or `rmdir` for a link to a folder where
 * the system wants that (neither ever deletes a folder that holds anything). Throws unless the link
 * is gone afterwards and what it led to is still there.
 */
export async function removeLink(link: WorktreeLink): Promise<void> {
  if (!(await fs.promises.lstat(link.path)).isSymbolicLink())
    throw new Error(`${link.path} is no link any more`)
  try {
    await fs.promises.unlink(link.path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EISDIR') throw err
    await fs.promises.rmdir(link.path)
  }
  const left = await fs.promises.lstat(link.path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false
      throw err
    },
  )
  if (left) throw new Error(`${link.path} is still there`)
  const there = link.resolved
    ? await fs.promises.access(link.resolved).then(
        () => true,
        () => false,
      )
    : true
  if (!there) throw new Error(`${link.resolved}, where ${link.path} led, is gone`)
}
