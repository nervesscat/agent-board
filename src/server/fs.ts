import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HttpError } from './http'

/**
 * Folders on the machine the board runs on, for the repo path picker. A browser cannot hand a page
 * the real path of a folder it picked, and the board may run inside WSL, so the board lists them.
 * Read-only: names and whether each is a git checkout, nothing else.
 */

export interface DirEntry {
  name: string
  path: string
  isRepo: boolean
}

const isRepo = (dir: string) => fs.existsSync(path.join(dir, '.git'))

export function listDirs(requested?: string) {
  const dir = path.resolve(requested?.trim() || os.homedir())
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, `${dir} is not a folder`)
    if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, `no permission to read ${dir}`)
    throw err
  }
  const entries: DirEntry[] = names
    // Dot folders are tool state (.git, .cache, …); node_modules is never a checkout worth picking.
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), isRepo: isRepo(path.join(dir, d.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 1000)
  const parent = path.dirname(dir)
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    home: os.homedir(),
    isRepo: isRepo(dir),
    entries,
  }
}

export type DirListing = ReturnType<typeof listDirs>
