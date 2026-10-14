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
    expect(found).toEqual({
      links: [{ path: link, target: expect.any(String), resolved: outside, outward: true }],
      repos: [],
    })
  }, 90_000)
})

describe('the repositories in a worktree', () => {
  it('are a folder with a .git of its own, and a bare one: HEAD, objects and refs, with no .git', async () => {
    const dir = path.join(tmp, 'repos-1')
    const bare = path.join(dir, 'bare.git')
    fs.mkdirSync(path.join(dir, 'with-git', '.git'), { recursive: true })
    fs.mkdirSync(path.join(bare, 'objects', 'pack'), { recursive: true })
    fs.mkdirSync(path.join(bare, 'refs', 'heads'), { recursive: true })
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n')
    // Not one: no HEAD, and no refs.
    fs.mkdirSync(path.join(dir, 'no-head', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'no-head', 'refs'))
    fs.mkdirSync(path.join(dir, 'no-refs', 'objects'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'no-refs', 'HEAD'), 'ref: refs/heads/main\n')
    try {
      const { repos } = await worktreeLinks(dir)
      expect(repos).toHaveLength(2)
      expect(repos).toEqual(
        expect.arrayContaining([
          { path: path.join(dir, 'with-git'), bare: false },
          { path: bare, bare: true },
        ]),
      )
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('is not read beyond its listing: a link inside a bare one is no link of the worktree', async () => {
    const dir = path.join(tmp, 'repos-2')
    const bare = path.join(dir, 'bare.git')
    const outside = path.join(tmp, 'repos-2-outside')
    fs.mkdirSync(path.join(bare, 'objects'), { recursive: true })
    fs.mkdirSync(path.join(bare, 'refs'))
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n')
    fs.mkdirSync(outside)
    const inside = path.join(bare, 'refs', 'linked')
    fs.symlinkSync(outside, inside, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(await worktreeLinks(dir)).toEqual({ links: [], repos: [{ path: bare, bare: true }] })
    } finally {
      // The link first, never through it.
      fs.unlinkSync(inside)
      fs.rmSync(dir, { recursive: true })
      fs.rmSync(outside, { recursive: true })
    }
  })
})
