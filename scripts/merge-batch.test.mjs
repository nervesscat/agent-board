import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  BatchError,
  buildTrain,
  checkTrainName,
  isEntrypoint,
  orderBatch,
  parseArgs,
  pushTrain,
  readBatch,
  trainName,
} from './merge-batch.mjs'

const made = []
afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const journal = (entries) =>
  JSON.stringify({
    version: '7',
    dialect: 'sqlite',
    entries: entries.map(([tag, idx, when]) => ({ idx, version: '6', when, tag, breakpoints: true })),
  })

/**
 * A bare remote with a `dev` branch, and a clone of it (the checkout the batch is built from).
 * `dev` has a base file and a sound migrations folder (one migration, in its journal).
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-batch-test-'))
  made.push(root)
  const remote = path.join(root, 'origin.git')
  git(root, 'init', '--bare', '-q', remote)
  const work = path.join(root, 'work')
  git(root, 'init', '-q', '-b', 'dev', work)
  fs.mkdirSync(path.join(work, 'drizzle', 'meta'), { recursive: true })
  fs.writeFileSync(path.join(work, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(work, 'shared.txt'), 'shared\n')
  fs.writeFileSync(path.join(work, 'drizzle', '0000_init.sql'), 'select 1;\n')
  fs.writeFileSync(path.join(work, 'drizzle', 'meta', '_journal.json'), journal([['0000_init', 0, 1]]))
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '-q', 'origin', 'dev')
  return { work, remote }
}

/** A branch off dev with the given files changed (path -> content, or null to keep it as is). */
function branch(work, name, files) {
  git(work, 'checkout', '-q', '-b', name, 'dev')
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    fs.writeFileSync(path.join(work, file), content)
  }
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', `change ${name}`)
  git(work, 'push', '-q', 'origin', name)
  git(work, 'checkout', '-q', 'dev')
}

describe('orderBatch', () => {
  it('keeps the list order when nothing is needed', () => {
    expect(
      orderBatch([
        { pr: 1, branch: 'a' },
        { pr: 2, branch: 'b' },
      ]).map((e) => e.pr),
    ).toEqual([1, 2])
  })

  it('places an entry after the entries it needs, taking the rest in list order as they become free', () => {
    const batch = [
      { pr: 1, branch: 'a', needs: [3] },
      { pr: 2, branch: 'b' },
      { pr: 3, branch: 'c' },
    ]
    expect(orderBatch(batch).map((e) => e.pr)).toEqual([2, 3, 1])
  })

  it('refuses an empty batch, a repeated PR, a need outside the batch and a cycle', () => {
    expect(() => orderBatch([])).toThrow(BatchError)
    expect(() =>
      orderBatch([
        { pr: 1, branch: 'a' },
        { pr: 1, branch: 'b' },
      ]),
    ).toThrow('listed twice')
    expect(() => orderBatch([{ pr: 1, branch: 'a', needs: [9] }])).toThrow('which is not in the batch')
    expect(() =>
      orderBatch([
        { pr: 1, branch: 'a', needs: [2] },
        { pr: 2, branch: 'b', needs: [1] },
      ]),
    ).toThrow('form a cycle')
  })
})

describe('buildTrain', () => {
  it('merges each branch in order into a train made from the base, and leaves the checkout alone', () => {
    const { work } = fixture()
    branch(work, 'feature-a', { 'a.txt': 'a\n' })
    branch(work, 'feature-b', { 'b.txt': 'b\n' })
    const devBefore = git(work, 'rev-parse', 'origin/dev')
    const headBefore = git(work, 'rev-parse', 'HEAD')

    const built = buildTrain({
      repo: work,
      entries: [
        { pr: 1, branch: 'feature-a' },
        { pr: 2, branch: 'feature-b' },
      ],
    })

    expect(built.merged.map((m) => m.pr)).toEqual([1, 2])
    const files = git(work, 'ls-tree', '-r', '--name-only', built.head).split('\n').sort()
    expect(files).toEqual([
      'a.txt',
      'b.txt',
      'base.txt',
      'drizzle/0000_init.sql',
      'drizzle/meta/_journal.json',
      'shared.txt',
    ])
    expect(git(work, 'rev-parse', 'origin/dev')).toBe(devBefore)
    expect(git(work, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(
      git(work, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((l) => l.startsWith('worktree ')),
    ).toHaveLength(1)
  })

  it('stops at the first branch that conflicts with the train and names its PR', () => {
    const { work } = fixture()
    branch(work, 'takes-x', { 'shared.txt': 'x\n' })
    branch(work, 'takes-y', { 'shared.txt': 'y\n' })

    let error
    try {
      buildTrain({
        repo: work,
        entries: [
          { pr: 5, branch: 'takes-x' },
          { pr: 6, branch: 'takes-y' },
        ],
      })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(BatchError)
    expect(error.code).toBe('conflict')
    expect(error.pr).toBe(6)
    expect(
      git(work, 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((l) => l.startsWith('worktree ')),
    ).toHaveLength(1)
  })

  it('fails the batch on migrations that do not check, naming the newest PR that adds one', () => {
    const { work } = fixture()
    branch(work, 'adds-migration', { 'drizzle/0001_a.sql': 'select 2;\n' })

    let error
    try {
      buildTrain({ repo: work, entries: [{ pr: 7, branch: 'adds-migration' }] })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(BatchError)
    expect(error.code).toBe('migrations')
    expect(error.pr).toBe(7)
    expect(error.message).toContain('0001_a.sql: no journal entry')
  })

  it('accepts a migration that comes with its journal entry', () => {
    const { work } = fixture()
    branch(work, 'sound-migration', {
      'drizzle/0001_b.sql': 'select 3;\n',
      'drizzle/meta/_journal.json': journal([
        ['0000_init', 0, 1],
        ['0001_b', 1, 2],
      ]),
    })

    const built = buildTrain({ repo: work, entries: [{ pr: 8, branch: 'sound-migration' }] })
    expect(built.merged).toHaveLength(1)
  })
})

describe('pushTrain', () => {
  it('pushes the train under merge-train/ and refuses the base branch', () => {
    const { work, remote } = fixture()
    branch(work, 'feature-c', { 'c.txt': 'c\n' })
    const built = buildTrain({ repo: work, entries: [{ pr: 3, branch: 'feature-c' }] })

    expect(() => pushTrain({ repo: work, train: 'dev', head: built.head })).toThrow('must be merge-train/')
    expect(() => pushTrain({ repo: work, train: 'merge-train/../dev', head: built.head })).toThrow(
      'not a valid branch name',
    )

    pushTrain({ repo: work, train: 'merge-train/prs-3', head: built.head })
    expect(git(remote, 'rev-parse', 'refs/heads/merge-train/prs-3')).toBe(built.head)
  })
})

/** The error a call throws, or undefined when it returns. */
function thrownBy(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return undefined
}

describe('bad input and migrations', () => {
  it('reads an unreadable or malformed batch file, and needs that are not PR numbers, as bad input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-batch-input-'))
    made.push(dir)
    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '[{"pr": 1,')

    expect(thrownBy(() => readBatch(path.join(dir, 'missing.json')))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => readBatch(broken))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => orderBatch([{ pr: 1, branch: 'a', needs: 2 }]))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => orderBatch([{ pr: 1, branch: 'a', needs: ['2'] }]))).toMatchObject({
      code: 'input',
    })
    expect(thrownBy(() => orderBatch([{ pr: 1, branch: 'a', needs: ['2'] }])).message).toContain(
      'needs must be a list',
    )
  })

  it('names the newest PR whose branch deletes a migration, not an empty PR', () => {
    const { work } = fixture()
    git(work, 'checkout', '-q', '-b', 'drops-migration', 'dev')
    fs.rmSync(path.join(work, 'drizzle', '0000_init.sql'))
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'delete the migration file')
    git(work, 'push', '-q', 'origin', 'drops-migration')
    git(work, 'checkout', '-q', 'dev')

    const err = thrownBy(() => buildTrain({ repo: work, entries: [{ pr: 9, branch: 'drops-migration' }] }))
    expect(err).toMatchObject({ code: 'migrations', pr: 9 })
  })
})

describe('train names and reruns', () => {
  it('names the train after its PR numbers and the base head it was built on', () => {
    const { work } = fixture()
    branch(work, 'feature-d', { 'd.txt': 'd\n' })
    const built = buildTrain({ repo: work, entries: [{ pr: 4, branch: 'feature-d' }] })
    expect(trainName(orderBatch([{ pr: 4, branch: 'feature-d' }]), built.base)).toBe(
      `merge-train/prs-4-${built.base.slice(0, 7)}`,
    )
  })

  it('rebuilt after the base moved, the train gets a new name and pushes without a rejection', () => {
    const { work, remote } = fixture()
    branch(work, 'feature-e', { 'e.txt': 'e\n' })
    const entries = [{ pr: 10, branch: 'feature-e' }]
    const first = buildTrain({ repo: work, entries })
    const firstName = trainName(orderBatch(entries), first.base)
    pushTrain({ repo: work, train: firstName, head: first.head })

    fs.writeFileSync(path.join(work, 'moved.txt'), 'moved\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'base moves on')
    git(work, 'push', '-q', 'origin', 'dev')

    const second = buildTrain({ repo: work, entries })
    const secondName = trainName(orderBatch(entries), second.base)
    expect(secondName).not.toBe(firstName)
    pushTrain({ repo: work, train: secondName, head: second.head })
    expect(git(remote, 'rev-parse', `refs/heads/${secondName}`)).toBe(second.head)
  })
})

describe('entrypoint', () => {
  it('recognises this module through a symbolic link, and nothing else', () => {
    const moduleUrl = new URL('./merge-batch.mjs', import.meta.url)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-batch-link-'))
    made.push(dir)
    const link = path.join(dir, 'merge-batch-link.mjs')
    fs.symlinkSync(fileURLToPath(moduleUrl), link)
    expect(isEntrypoint(link, moduleUrl)).toBe(true)
    expect(isEntrypoint(path.join(dir, 'missing.mjs'), moduleUrl)).toBe(false)
    expect(isEntrypoint(undefined, moduleUrl)).toBe(false)
  })
})

describe('command line', () => {
  it('reads each flag with its value, and refuses a flag with no value or a flag taken as one', () => {
    expect(
      parseArgs(['batch.json', '--remote', 'up', '--base', 'main', '--train', 'merge-train/x', '--push']),
    ).toMatchObject({
      file: 'batch.json',
      remote: 'up',
      base: 'main',
      train: 'merge-train/x',
      push: true,
    })
    expect(thrownBy(() => parseArgs(['batch.json', '--remote']))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => parseArgs(['batch.json', '--train', '--push']))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => parseArgs(['batch.json', '--base', '--push']))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => parseArgs([]))).toMatchObject({ code: 'input' })
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

describe('pushes never replace a train', () => {
  it('refuses to push a train name that is already on the remote, and says what to do', () => {
    const { work } = fixture()
    branch(work, 'feature-f', { 'f.txt': 'f\n' })
    const built = buildTrain({ repo: work, entries: [{ pr: 11, branch: 'feature-f' }] })
    pushTrain({ repo: work, train: 'merge-train/prs-11-x', head: built.head })

    const err = thrownBy(() => pushTrain({ repo: work, train: 'merge-train/prs-11-x', head: built.head }))
    expect(err).toMatchObject({ code: 'input' })
    expect(err.message).toContain('is already on origin')
  })

  it('names the PR to drop in the migrations refusal', () => {
    const { work } = fixture()
    branch(work, 'adds-bad-migration', { 'drizzle/0001_c.sql': 'select 4;\n' })
    const err = thrownBy(() =>
      buildTrain({ repo: work, entries: [{ pr: 12, branch: 'adds-bad-migration' }] }),
    )
    expect(err.message).toContain('drop PR #12 (adds-bad-migration)')
  })

  it('names no entry to drop when the base itself fails its migration check', () => {
    const { work } = fixture()
    fs.writeFileSync(path.join(work, 'drizzle', '0001_base.sql'), 'select 3;\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'dev adds a migration with no journal entry')
    git(work, 'push', '-q', 'origin', 'dev')
    branch(work, 'adds-migration', { 'drizzle/0002_a.sql': 'select 2;\n' })

    const err = thrownBy(() => buildTrain({ repo: work, entries: [{ pr: 13, branch: 'adds-migration' }] }))
    expect(err).toMatchObject({ code: 'migrations' })
    expect(err.pr).toBeUndefined()
    expect(err.message).toContain('dev itself does not check')
    expect(err.message).toContain('0001_base.sql: no journal entry')
    expect(err.message).not.toContain('drop PR')
  })

  it('accepts a batch whose migrations repair a base that does not check', () => {
    const { work } = fixture()
    fs.writeFileSync(path.join(work, 'drizzle', '0001_base.sql'), 'select 3;\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'dev adds a migration with no journal entry')
    git(work, 'push', '-q', 'origin', 'dev')
    branch(work, 'journals-base-migration', {
      'drizzle/meta/_journal.json': journal([
        ['0000_init', 0, 1],
        ['0001_base', 1, 2],
      ]),
    })

    const built = buildTrain({ repo: work, entries: [{ pr: 14, branch: 'journals-base-migration' }] })
    expect(built.merged).toEqual([expect.objectContaining({ pr: 14 })])
  })
})

describe('train names and unrelated histories', () => {
  it('refuses a train name git would reject, before anything is built or pushed', () => {
    const { work } = fixture()
    for (const bad of [
      'merge-train/x/',
      'merge-train//y',
      'merge-train/a/.b',
      'merge-train/',
      'dev',
      'merge-train/a..b',
    ]) {
      expect(
        thrownBy(() => checkTrainName(work, bad)),
        bad,
      ).toMatchObject({ code: 'input' })
    }
    expect(() => checkTrainName(work, 'merge-train/prs-1-abc1234')).not.toThrow()
  })

  it('reports a branch with unrelated history as git reported it, not as a conflict', () => {
    const { work } = fixture()
    git(work, 'checkout', '-q', '--orphan', 'unrelated')
    git(work, 'rm', '-rq', '--cached', '.')
    fs.writeFileSync(path.join(work, 'island.txt'), 'island\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'an unrelated history')
    git(work, 'push', '-q', 'origin', 'unrelated')
    git(work, 'checkout', '-q', 'dev')

    const err = thrownBy(() => buildTrain({ repo: work, entries: [{ pr: 13, branch: 'unrelated' }] }))
    expect(err).toBeDefined()
    expect(err).not.toBeInstanceOf(BatchError)
    expect(String(err.message) + String(err.stderr ?? '')).toContain('unrelated histories')
  })
})

describe('hardening', () => {
  it('refuses a branch name that starts with a dash, which git would read as an option', () => {
    expect(thrownBy(() => orderBatch([{ pr: 1, branch: '--upload-pack=touch /tmp/x' }]))).toMatchObject({
      code: 'input',
    })
    expect(thrownBy(() => orderBatch([{ pr: 1, branch: '-x' }]))).toMatchObject({ code: 'input' })
    expect(thrownBy(() => parseArgs(['batch.json', '--remote', '-x']))).toMatchObject({ code: 'input' })
  })

  it('accepts the branch names git accepts that a branch commonly has, such as + @ # and %', () => {
    const names = ['feat+x', 'x@y', 'fix#1', 'a%b', 'fix/x', 'dependabot/npm_and_yarn/x']
    const ordered = orderBatch(names.map((branch, i) => ({ pr: i + 1, branch })))
    expect(ordered.map((e) => e.branch)).toEqual(names)
  })

  it('merges a branch whose name carries a + into the train', () => {
    const { work } = fixture()
    branch(work, 'feat+x', { 'plus.txt': 'x\n' })
    const built = buildTrain({ repo: work, entries: [{ pr: 15, branch: 'feat+x' }] })
    expect(built.merged).toEqual([expect.objectContaining({ pr: 15, branch: 'feat+x' })])
  })
})
