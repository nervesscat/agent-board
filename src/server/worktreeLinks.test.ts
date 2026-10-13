import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { worktreeLinks } from './worktreeLinks'

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-links-')))
const worktree = path.join(tmp, 'wt')
const outside = path.join(tmp, 'outside')
const link = path.join(worktree, 'node_modules')

fs.mkdirSync(path.join(worktree, 'data', 'cache'), { recursive: true })
fs.mkdirSync(outside)
// A directory junction on Windows, a symbolic link elsewhere.
fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  // The link first, never through it.
  fs.unlinkSync(link)
  fs.rmSync(tmp, { recursive: true })
})

describe('the links in a worktree', () => {
  it('are all found, and the walk settles, past a folder of more entries than a call takes arguments', async () => {
    // Making that many folders for real takes a minute on Windows: the listing of one says it holds
    // them, and each of those reads empty.
    const cache = path.join(worktree, 'data', 'cache')
    const many = 140_000
    const readdir = fs.promises.readdir.bind(fs.promises)
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, opts?: unknown) => {
      const at = path.resolve(String(dir))
      if (at === cache)
        return Array.from({ length: many }, (_, i) => ({
          name: String(i),
          isSymbolicLink: () => false,
          isDirectory: () => true,
          isFile: () => false,
        }))
      if (path.dirname(at) === cache) return []
      return readdir(dir, opts as { withFileTypes: true })
    }) as typeof fs.promises.readdir)

    let timer: NodeJS.Timeout | undefined
    const found = await Promise.race([
      worktreeLinks(worktree),
      new Promise<'unsettled'>((resolve) => {
        timer = setTimeout(() => resolve('unsettled'), 60_000)
      }),
    ]).finally(() => clearTimeout(timer))

    expect(found).not.toBe('unsettled')
    expect(fs.promises.readdir).toHaveBeenCalledTimes(many + 3)
    expect(found).toEqual([{ path: link, target: expect.any(String), resolved: outside, outward: true }])
  }, 90_000)
})
