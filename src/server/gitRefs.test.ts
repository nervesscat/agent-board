import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { deleteLocalBranch, listRefs, listWorktrees, originSymref } from './git'

// Real git on throwaway repos: the refs and worktrees the Cleanup page reads, and what it deletes.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-refs-')))
const origin = path.join(tmp, 'origin.git')
const repo = path.join(tmp, 'repo')
const wt = (name: string) => path.join(tmp, `wt-${name}`)
const gitIn =
  (cwd: string) =>
  (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = gitIn(repo)
/** Appends `text` to `file` in the checkout at `cwd` and commits it, unsigned. */
const commit = (cwd: string, file: string, text: string) => {
  fs.appendFileSync(path.join(cwd, file), text)
  gitIn(cwd)('add', file)
  gitIn(cwd)(
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '-m',
    text.trim(),
  )
}
const treeAt = async (dir: string) =>
  (await listWorktrees(repo)).find((t) => path.resolve(t.path) === path.resolve(dir))

beforeAll(() => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  commit(repo, 'f.txt', 'base\n')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
}, 60_000)

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the refs the Cleanup page reads and deletes', () => {
  it('names a symbolic ref by the branch it points at, and no other ref', async () => {
    git('branch', 'feat/plain', 'main')
    git('symbolic-ref', 'refs/heads/alias', 'refs/heads/main')
    const refs = await listRefs(repo)
    expect(refs.symrefs).toEqual(new Map([['alias', 'main']]))
    expect(refs.local.get('alias')).toBe(refs.local.get('main'))
    expect(refs.local.has('feat/plain')).toBe(true)
  })

  it('deletes a symbolic ref alone: the branch it points at stays', async () => {
    const sha = git('rev-parse', 'refs/heads/main')
    await deleteLocalBranch(repo, 'alias', sha)
    expect(git('rev-parse', 'refs/heads/main')).toBe(sha)
    expect(() => git('show-ref', '--verify', '--quiet', 'refs/heads/alias')).toThrow()
  })

  it('answers what origin holds a branch as: the branch it is a symbolic ref to, or nothing', async () => {
    git('push', '-q', 'origin', 'main:refs/heads/side')
    gitIn(origin)('symbolic-ref', 'refs/heads/alias-on-origin', 'refs/heads/main')
    expect(await originSymref(repo, 'alias-on-origin', 60_000)).toBe('main')
    expect(await originSymref(repo, 'side', 60_000)).toBeNull()
    expect(await originSymref(repo, 'nowhere', 60_000)).toBeNull()
  })

  it('names the branches a rebase with --update-refs will move, as held in its worktree', async () => {
    // feat/u1 and feat/u2 stacked; onto adds the file feat/u1 adds, so the rebase stops on feat/u1.
    git('checkout', '-q', '-b', 'feat/u1', 'main')
    commit(repo, 'u.txt', 'feat/u1\n')
    git('checkout', '-q', '-b', 'feat/u2')
    commit(repo, 'u2.txt', 'feat/u2\n')
    git('checkout', '-q', '-b', 'onto', 'main')
    commit(repo, 'u.txt', 'onto\n')
    git('checkout', '-q', 'main')
    git('worktree', 'add', '-q', wt('u2'), 'feat/u2')
    expect(() => gitIn(wt('u2'))('rebase', '--update-refs', 'onto')).toThrow()
    try {
      expect(await treeAt(wt('u2'))).toMatchObject({
        branch: 'feat/u2',
        busy: 'rebase in progress',
        updates: ['feat/u1'],
      })
    } finally {
      gitIn(wt('u2'))('rebase', '--abort')
      git('worktree', 'remove', '--force', wt('u2'))
    }
  })

  it('names a branch a bisect started on as git wrote it, when its name starts with refs/', async () => {
    git('worktree', 'add', '-q', '-b', 'refs/b1', wt('b1'), 'main')
    gitIn(wt('b1'))('bisect', 'start', 'feat/u2', 'main')
    try {
      expect(await treeAt(wt('b1'))).toMatchObject({ branch: 'refs/b1', busy: 'bisect in progress' })
    } finally {
      gitIn(wt('b1'))('bisect', 'reset')
      git('worktree', 'remove', '--force', wt('b1'))
      git('update-ref', '-d', 'refs/heads/refs/b1')
    }
  })
})
