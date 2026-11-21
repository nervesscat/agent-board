import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const repo = path.join(tmp, 'repo')
const origin = path.join(tmp, 'origin.git')

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (file: string, text: string) => {
  fs.writeFileSync(path.join(repo, file), text)
  git('add', file)
  git('commit', '-q', '-m', file)
}
/** A branch from `from` with one commit of its own. */
const branch = (name: string, from: string, file = `${name.replace(/\W/g, '-')}.txt`) => {
  git('checkout', '-q', '-b', name, from)
  commit(file, `${name}\n`)
}
const sha = (ref: string) => git('rev-parse', ref)

let holdsOwnWork: typeof import('./git').holdsOwnWork
let holdsWorkOf: typeof import('./git').holdsWorkOf

/**
 * Whether the branch `a` holds the own work of the branch `b`, as the board asks: b's own refs left out,
 * main the base a is headed for.
 */
const holds = (a: string, b: string) =>
  holdsOwnWork(repo, sha(a), sha(b), [`refs/heads/${b}`, `refs/remotes/origin/${b}`], [sha('main')])

beforeAll(async () => {
  ;({ holdsOwnWork, holdsWorkOf } = await import('./git'))
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  commit('base.txt', 'base\n')
  execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  git('fetch', '-q', 'origin')
})

describe('holdsOwnWork', () => {
  it('is certain for a branch stacked on another with commits of its own', () => {
    branch('stack/a', 'main')
    branch('stack/b', 'stack/a')
    // b is built on a: b holds a's work, not the other way round.
    return Promise.all([holds('stack/b', 'stack/a'), holds('stack/a', 'stack/b')]).then(([up, down]) => {
      expect(up).toBe(true)
      expect(down).toBe(false)
    })
  })

  it('is certain for a branch that merged another in, and not before it did', async () => {
    branch('merge/a', 'main')
    branch('merge/c', 'main')
    expect(await holds('merge/c', 'merge/a')).toBe(false)
    git('merge', '-q', '--no-ff', '-m', 'merge a', 'merge/a')
    expect(await holds('merge/c', 'merge/a')).toBe(true)
    expect(await holds('merge/a', 'merge/c')).toBe(false)
  })

  it('stays certain with origin copies of both branches, and not with a copy only of the held one below', async () => {
    branch('remote/a', 'main')
    branch('remote/b', 'remote/a')
    git('push', '-q', 'origin', 'remote/a', 'remote/b')
    git('fetch', '-q', 'origin')
    // origin/remote/a is a's own ref, left out; origin/remote/b is above a and says nothing about it.
    expect(await holds('remote/b', 'remote/a')).toBe(true)
    // Another branch (not the ticket's own copy) holding a's commits makes them nobody's own.
    git('branch', 'remote/shared', 'remote/a')
    expect(await holds('remote/b', 'remote/a')).toBe(false)
  })

  it('follows a rebase: onto the other branch’s newer tip it holds it, onto main away from it it does not', async () => {
    branch('rebase/a', 'main')
    branch('rebase/b', 'rebase/a')
    expect(await holds('rebase/b', 'rebase/a')).toBe(true)
    // a gains a commit; b is rebased onto the new tip: still holding it.
    git('checkout', '-q', 'rebase/a')
    commit('rebase-a2.txt', 'more\n')
    git('checkout', '-q', 'rebase/b')
    git('rebase', '-q', 'rebase/a')
    expect(await holds('rebase/b', 'rebase/a')).toBe(true)
    // b rebased onto main, dropping a's commits for good: it no longer holds them.
    git('rebase', '-q', '--onto', 'main', 'rebase/a')
    expect(await holds('rebase/b', 'rebase/a')).toBe(false)
  })

  it('does not follow a force-moved lower branch: the commits it held are not its tip any more', async () => {
    branch('moved/a', 'main')
    branch('moved/b', 'moved/a')
    expect(await holds('moved/b', 'moved/a')).toBe(true)
    // a is rebased (new shas, same patches) while b still holds the old commits.
    commit('moved-b2.txt', 'b2\n')
    git('branch', '-f', 'moved/a', 'main')
    git('checkout', '-q', 'moved/a')
    commit('moved-moved-a.txt', 'moved/a\n')
    expect(await holds('moved/b', 'moved/a')).toBe(false)
  })

  it('is not certain for two branches off the same base', async () => {
    branch('same/a', 'main')
    branch('same/d', 'main')
    expect(await holds('same/a', 'same/d')).toBe(false)
    expect(await holds('same/d', 'same/a')).toBe(false)
    expect(await holdsWorkOf(repo, sha('same/a'), sha('same/d'), [sha('main')], [])).toBe(false)
  })

  it('is not certain for two branches built on a shared integration branch', async () => {
    branch('integration', 'main')
    branch('onint/a', 'integration')
    branch('onint/d', 'integration')
    expect(await holds('onint/a', 'onint/d')).toBe(false)
    expect(await holds('onint/d', 'onint/a')).toBe(false)
    // The integration branch itself is a branch: another branch holding it holds its work, as a branch.
    expect(await holds('onint/a', 'integration')).toBe(true)
  })

  it('is not certain for a branch that took the base in, whatever the base holds', async () => {
    // A landed branch (kept after its merge) and an unrelated branch's commits, both in main.
    branch('dev/landed', 'main')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', 'merge landed', 'dev/landed')
    branch('dev/b', 'main')
    expect(await holds('dev/b', 'dev/landed')).toBe(false)
    // Another branch gets main, with the landed commits, merged in.
    branch('dev/e', 'dev/b')
    git('checkout', '-q', 'dev/e')
    git('merge', '-q', '--no-ff', '-m', 'merge main', 'main')
    expect(await holds('dev/e', 'dev/landed')).toBe(false)
    // A branch of its own work above a landed one that is partly in main still holds the rest.
    branch('dev/g', 'main')
    git('checkout', '-q', '-b', 'dev/h', 'dev/g')
    commit('dev-h.txt', 'h\n')
    expect(await holds('dev/h', 'dev/g')).toBe(true)
  })

  it('is not certain for equal tips, or a branch with no commits of its own', async () => {
    branch('equal/a', 'main')
    git('branch', 'equal/b', 'equal/a')
    expect(await holds('equal/a', 'equal/b')).toBe(false)
    expect(await holds('equal/b', 'equal/a')).toBe(false)
    // Created at main's tip, nothing yet: there is nothing of it to hold.
    git('branch', 'empty/b', 'main')
    expect(await holds('equal/a', 'empty/b')).toBe(false)
  })

  it('is not certain without bases, even where the other tip is an ancestor with commits', async () => {
    branch('nobase/a', 'main')
    branch('nobase/b', 'nobase/a')
    const own = (b: string) => [`refs/heads/${b}`, `refs/remotes/origin/${b}`]
    // With the base known it holds; without one nothing can be told (main itself would count whole).
    expect(await holdsOwnWork(repo, sha('nobase/b'), sha('nobase/a'), own('nobase/a'), [sha('main')])).toBe(
      true,
    )
    expect(await holdsOwnWork(repo, sha('nobase/b'), sha('nobase/a'), own('nobase/a'), [])).toBe(false)
    expect(await holdsOwnWork(repo, sha('nobase/a'), sha('main'), own('main'), [])).toBe(false)
  })

  it('is not certain for a copy of the commits (patch-equivalent), which only the hint can name', async () => {
    branch('copy/a', 'main')
    const a = sha('copy/a')
    // On another parent, so the copy has other shas.
    branch('copy/b', 'main')
    git('cherry-pick', a)
    commit('copy-b.txt', 'b\n')
    expect(await holds('copy/b', 'copy/a')).toBe(false)
  })

  it('leaves a branch stacked on another, which then moved on, to the hint', async () => {
    branch('lower/a', 'main')
    branch('lower/b', 'lower/a')
    git('checkout', '-q', 'lower/a')
    commit('lower-a2.txt', 'a2\n')
    // b holds a's old commit; a's tip is not in b: topology cannot say who owns the shared commit.
    expect(await holds('lower/b', 'lower/a')).toBe(false)
    expect(await holdsWorkOf(repo, sha('lower/b'), sha('lower/a'), [sha('main')], [])).toBe(true)
  })
})
