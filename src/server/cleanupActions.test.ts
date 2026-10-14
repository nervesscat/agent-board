import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { DeleteItem } from './cleanupActions'
import type { PreviewRunner, Proc } from './managedPreview'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
// Test mode: who calls the API is X-Test-Actor, as Playwright and CI drive it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')
process.env.BOARD_ENV = 'test'

// The checkout is named like the board's own, so the board would run a preview of its worktrees.
const code = path.join(tmp, 'code')
const repo = path.join(code, 'agent-board')
const origin = path.join(tmp, 'origin.git')
// Someone else's clone, pushing to origin behind the checkout's back.
const other = path.join(tmp, 'other')
const wt = (name: string) => path.join(code, `agent-board-${name}`)
const LOCK = "lockfileVersion: '9.0'\n"

const gitIn =
  (cwd: string) =>
  (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = gitIn(repo)
const hasRef = (dir: string, ref: string) => {
  try {
    gitIn(dir)('show-ref', '--verify', '--quiet', ref)
    return true
  } catch {
    return false
  }
}
const worktreePaths = () =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice(9)))

let marks = 0
/**
 * A commit adding `<name>.txt` (and `files`, a `link` committed as a symbolic link) on top of main (or
 * `from`) for each branch, in one git process; main then merges them as is unless `unique`. Returns
 * each branch's sha.
 */
function land(
  names: string[],
  opts: { unique?: boolean; from?: string; files?: { path: string; data: string; link?: boolean }[] } = {},
): Record<string, string> {
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}`
  const who = `committer t <t@t> ${Math.floor(Date.now() / 1000)} +0000`
  const first = marks + 1
  const stream = names.map((name) =>
    [
      `commit refs/heads/${name}`,
      `mark :${++marks}`,
      who,
      data(name),
      `from ${opts.from ?? 'refs/heads/main^0'}`,
      `M 100644 inline ${name.replace(/\W/g, '-')}.txt`,
      data(`${name}\n`),
      ...(opts.files ?? []).flatMap((f) => [`M ${f.link ? 120000 : 100644} inline ${f.path}`, data(f.data)]),
      '',
    ].join('\n'),
  )
  if (!opts.unique)
    stream.push(
      [
        'commit refs/heads/main',
        `mark :${++marks}`,
        who,
        data(`merge ${names.join(', ')}`),
        'from refs/heads/main^0',
        ...names.map((_, i) => `merge :${first + i}`),
        '',
      ].join('\n'),
    )
  const file = path.join(tmp, 'marks')
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${file}`], {
    cwd: repo,
    input: stream.join(''),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const shas = new Map(
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' ') as [string, string]),
  )
  return Object.fromEntries(names.map((name, i) => [name, shas.get(`:${first + i}`)!]))
}

// --- previews run by a fake: what the board does, without building anything ---

class FakeRunner implements PreviewRunner {
  /** Each kill, with whether the worktree was still there when it came. */
  killed: { pid: number; worktreeThere: boolean }[] = []
  watch = ''
  /** Whether an install or a build goes on until `release` (a long build), instead of ending at once. */
  hold = false
  private held: (() => void)[] = []
  private pid = 5000
  spawn(_command: string, _args: string[], opts: { log: string; shell?: boolean }): Proc {
    fs.appendFileSync(opts.log, 'ok\n')
    if (opts.shell && this.hold)
      return { pid: ++this.pid, exited: new Promise((r) => this.held.push(() => r(0))) }
    // Install and build finish at once; the server runs until it is killed.
    return { pid: ++this.pid, exited: opts.shell ? Promise.resolve(0) : new Promise(() => {}) }
  }
  release() {
    for (const end of this.held.splice(0)) end()
  }
  async killTree(pid: number) {
    this.killed.push({ pid, worktreeThere: fs.existsSync(this.watch) })
  }
  killTreeSync() {}
  isFree = async () => true
  answers = async () => true
  copyData: PreviewRunner['copyData'] = async () => {}
}

let projectId: number
let repoId: number
let features: typeof import('./features')
let dbm: typeof import('#/db')
let deleteLeftovers: typeof import('./cleanupActions').deleteLeftovers
let cleanupReport: typeof import('./cleanup').cleanupReport

const del = (items: DeleteItem[]) => deleteLeftovers(projectId, items, 'enrique')
const done = (title: string, branch: string, more: { baseBranch?: string; status?: string } = {}) =>
  features.createTicket(projectId, { title, branch, status: 'done', ...more }, 'claude')
const branchOf = async (ticketId: number, name: string) =>
  (await cleanupReport(projectId)).tickets
    .find((t) => t.id === ticketId)
    ?.branches.find((b) => b.name === name)
/** What `promise` answers within `ms`, else 'still waiting'. */
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])
const activity = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.activity)
    .where(eq(dbm.schema.activity.refId, ticketId))
    .all()
    .map((a) => a.text)
    .join('\n')

beforeAll(async () => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
  fs.mkdirSync(repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('remote', 'add', 'origin', origin)
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'agent-board' }))
  fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), LOCK)
  // No trailing slash: with one git ignores only a folder, and a linked node_modules is a link.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\ndata\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  // The other clone commits as well: it needs an identity where none is configured (CI).
  gitIn(other)('config', 'user.email', 't@t')
  gitIn(other)('config', 'user.name', 't')

  dbm = await import('#/db')
  features = await import('./features')
  deleteLeftovers = (await import('./cleanupActions')).deleteLeftovers
  cleanupReport = (await import('./cleanup')).cleanupReport
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'p' }).returning().get().id
  repoId = dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' })
    .returning()
    .get().id
}, 60_000)

afterAll(async () => {
  ;(await import('./managedPreview')).setPreviewRunner(null)
})

describe('deleting a worked local branch', () => {
  it('deletes it here, leaves origin’s copy, records it and answers how to restore it', async () => {
    const { 'feat/b1': sha } = land(['feat/b1'])
    git('push', '-q', 'origin', 'feat/b1')
    const t = done('b1', 'feat/b1')
    expect((await branchOf(t.id, 'feat/b1'))!.can.local).toEqual({ ok: true, reason: null })

    const [r] = await del([{ ticketId: t.id, branch: 'feat/b1', kind: 'local', sha }])
    expect(r).toMatchObject({
      ok: true,
      outcome: 'deleted',
      reason: null,
      restore: [`git branch feat/b1 ${sha}`],
    })
    expect(hasRef(repo, 'refs/heads/feat/b1')).toBe(false)
    expect(hasRef(origin, 'refs/heads/feat/b1')).toBe(true)
    expect(hasRef(repo, 'refs/remotes/origin/feat/b1')).toBe(true)
    expect(activity(t.id)).toContain(`feat/b1 @ ${sha}`)
  })

  it('deletes a branch named like an option as a name', async () => {
    const { 'x--force': sha } = land(['x--force'])
    const t = done('odd', 'x--force')
    const [r] = await del([{ ticketId: t.id, branch: 'x--force', kind: 'local', sha }])
    expect(r!.outcome).toBe('deleted')
    expect(hasRef(repo, 'refs/heads/x--force')).toBe(false)
  })

  it('refuses one that moved since the human looked, and keeps the new commit', async () => {
    const { 'feat/b8': seen } = land(['feat/b8'])
    const t = done('b8', 'feat/b8')
    const now = land(['feat/b8-more'], { unique: true })['feat/b8-more']!
    git('update-ref', 'refs/heads/feat/b8', now)
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b8', kind: 'local', sha: seen }])
    expect(r).toMatchObject({ ok: false, outcome: 'refused', reason: expect.stringMatching(/moved since/) })
    expect(git('rev-parse', 'refs/heads/feat/b8')).toBe(now)
  })

  it('refuses one with work of its own', async () => {
    const { 'feat/b7': sha } = land(['feat/b7'], { unique: true })
    const t = done('b7', 'feat/b7')
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b7', kind: 'local', sha }])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/1 commit of its own/) })
    expect(git('rev-parse', 'refs/heads/feat/b7')).toBe(sha)
  })

  it('reports one deleted meanwhile as gone, also when two asks race', async () => {
    const { 'feat/b14': sha } = land(['feat/b14'])
    const t = done('b14', 'feat/b14')
    const item: DeleteItem = { ticketId: t.id, branch: 'feat/b14', kind: 'local', sha }
    const both = await Promise.all([del([item]), del([item])])
    expect(both.map(([r]) => r!.outcome).sort()).toEqual(['deleted', 'gone'])
    expect(both.every(([r]) => r!.ok)).toBe(true)
    expect(hasRef(repo, 'refs/heads/feat/b14')).toBe(false)
  })

  it('shows on the ticket’s git panel at once', async () => {
    const { 'feat/b16': sha } = land(['feat/b16'])
    const t = done('b16', 'feat/b16')
    // Fetched just now: no background fetch comes to read the checkout afresh meanwhile.
    await (await import('./push')).fetchRepo(repo, { force: true })
    expect((await features.ticketGit(t.id)).info.exists).toBe(true)
    await del([{ ticketId: t.id, branch: 'feat/b16', kind: 'local', sha }])
    expect((await features.ticketGit(t.id)).info.exists).toBe(false)
  })
})

describe('a branch named like a full refname', () => {
  it('is read as itself, not as the branch its name ends in', async () => {
    const { 'refs/heads/f3': own } = land(['refs/heads/f3'], { unique: true })
    git('branch', 'f3', 'main')
    try {
      const t = features.createTicket(
        projectId,
        { title: 'f3', branch: 'refs/heads/f3', status: 'in_progress' },
        'claude',
      )
      // The git panel reads the checkout a few seconds at a time: this read is to see the branches now.
      ;(await import('./push')).dropListings(repo)
      const g = await features.ticketGit(t.id)
      expect(g.info.sha).toBe(own)
      expect(g.info.reach?.state).toBe('unique')
    } finally {
      git('update-ref', '-d', 'refs/heads/refs/heads/f3')
    }
  })
})

describe('deleting a worked branch on origin', () => {
  it('deletes origin’s copy alone, after fetching, and answers how to put it back', async () => {
    const { 'feat/b2': sha } = land(['feat/b2'])
    git('push', '-q', 'origin', 'feat/b2', 'main')
    const t = done('b2', 'feat/b2')
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b2', kind: 'remote', sha }])
    expect(r).toMatchObject({
      ok: true,
      outcome: 'deleted',
      restore: [`git push origin ${sha}:refs/heads/feat/b2`],
    })
    expect(hasRef(origin, 'refs/heads/feat/b2')).toBe(false)
    expect(hasRef(repo, 'refs/remotes/origin/feat/b2')).toBe(false)
    expect(git('rev-parse', 'refs/heads/feat/b2')).toBe(sha)
    expect(activity(t.id)).toContain(`origin's branch feat/b2 @ ${sha}`)
  })

  it('refuses it when someone pushed to it since the human looked', async () => {
    const { 'feat/b2-moved': seen } = land(['feat/b2-moved'])
    git('push', '-q', 'origin', 'feat/b2-moved')
    const t = done('b2 moved', 'feat/b2-moved')
    const them = gitIn(other)
    them('fetch', '-q', 'origin')
    const theirs = them(
      'commit-tree',
      'origin/feat/b2-moved^{tree}',
      '-p',
      'origin/feat/b2-moved',
      '-m',
      'more',
    )
    them('push', '-q', 'origin', `${theirs}:refs/heads/feat/b2-moved`)
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b2-moved', kind: 'remote', sha: seen }])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/moved since/) })
    expect(gitIn(origin)('rev-parse', 'refs/heads/feat/b2-moved')).toBe(theirs)
  })

  it('refuses origin’s copy while only a base here holds it, not origin’s', async () => {
    const { 'feat/b2-here': sha } = land(['feat/b2-here'])
    git('push', '-q', 'origin', 'feat/b2-here')
    const t = done('b2 here', 'feat/b2-here')
    const b = (await branchOf(t.id, 'feat/b2-here'))!
    expect(b.reach?.state).toBe('merged')
    expect(b.remoteReach).toMatchObject({ state: 'unique', into: 'origin/main' })
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b2-here', kind: 'remote', sha }])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/not in origin\/main/) })
    expect(hasRef(origin, 'refs/heads/feat/b2-here')).toBe(true)

    git('push', '-q', 'origin', 'main')
    const [again] = await del([{ ticketId: t.id, branch: 'feat/b2-here', kind: 'remote', sha }])
    expect(again!.outcome).toBe('deleted')
  })

  it('judges origin’s copy by its own commits, and takes a merged PR’s very head', async () => {
    const { 'feat/b7r': sha } = land(['feat/b7r'])
    const extra = land(['feat/b7r-extra'], { unique: true, from: sha })['feat/b7r-extra']!
    git('push', '-q', 'origin', `${extra}:refs/heads/feat/b7r`)
    const t = done('b7 remote', 'feat/b7r')
    const b = (await branchOf(t.id, 'feat/b7r'))!
    expect(b.remoteReach?.state).toBe('unique')
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b7r', kind: 'remote', sha: extra }])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/of its own/) })
    expect(hasRef(origin, 'refs/heads/feat/b7r')).toBe(true)

    // Its PR was merged with that very commit as its head (squashed, say): origin's copy landed.
    const now = new Date().toISOString()
    dbm.db
      .insert(dbm.schema.prs)
      .values({
        projectId,
        repoId,
        number: 41,
        title: 'b7r',
        url: 'https://example.invalid/pr/41',
        author: 'enrique',
        headRef: 'feat/b7r',
        baseRef: 'main',
        headSha: extra,
        updatedAt: now,
        fetchedAt: now,
        open: false,
        mergedAt: now,
      })
      .run()
    expect((await branchOf(t.id, 'feat/b7r'))!.mergedPr).toMatchObject({ number: 41 })
    const [again] = await del([{ ticketId: t.id, branch: 'feat/b7r', kind: 'remote', sha: extra }])
    expect(again!.outcome).toBe('deleted')
    expect(hasRef(origin, 'refs/heads/feat/b7r')).toBe(false)
  })
})

describe('deleting a worked branch with its worktrees', () => {
  it('removes the worktree, unregisters its workspace, then deletes the branch', async () => {
    const { 'feat/b3': sha } = land(['feat/b3'])
    git('worktree', 'add', '-q', wt('b3'), 'feat/b3')
    // An ignored file does not stand in the way: git removes it with the worktree.
    fs.mkdirSync(path.join(wt('b3'), 'node_modules'))
    fs.writeFileSync(path.join(wt('b3'), 'node_modules', 'x.js'), 'x')
    const t = done('b3', 'feat/b3')
    features.addWorkspace(t.id, { name: 'wt', branch: 'feat/b3', path: wt('b3') }, 'claude')
    const elsewhere = features.addWorkspace(
      t.id,
      { name: 'ui', branch: 'feat/b3', path: wt('b3-ui') },
      'claude',
    )
    const b = (await branchOf(t.id, 'feat/b3'))!
    expect(b.can.worktrees).toEqual({ ok: true, reason: null })
    expect(b.can.local.ok).toBe(false)

    const [r] = await del([
      {
        ticketId: t.id,
        branch: 'feat/b3',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
    expect(r!.removed.map((p) => path.resolve(p))).toEqual([wt('b3')])
    expect(r!.restore[0]).toBe(`git branch feat/b3 ${sha}`)
    expect(r!.restore[1]).toMatch(/^git worktree add \S+agent-board-b3 feat\/b3$/)
    expect(fs.existsSync(wt('b3'))).toBe(false)
    expect(worktreePaths()).not.toContain(wt('b3'))
    expect(hasRef(repo, 'refs/heads/feat/b3')).toBe(false)
    const left = dbm.db
      .select()
      .from(dbm.schema.workspaces)
      .where(eq(dbm.schema.workspaces.ticketId, t.id))
      .all()
    expect(left.map((w) => w.id)).toEqual([elsewhere.id])
    expect(activity(t.id)).toMatch(/closed workspace wt on/)
  })

  it('removes none, and keeps the branch, while one of them has untracked files', async () => {
    const { 'feat/b5': sha } = land(['feat/b5'])
    git('worktree', 'add', '-q', wt('b5a'), 'feat/b5')
    git('worktree', 'add', '-q', '--detach', wt('b5b'), 'feat/b5')
    fs.writeFileSync(path.join(wt('b5b'), 'notes.txt'), 'mine')
    const t = done('b5', 'feat/b5')
    features.addWorkspace(t.id, { name: 'review', branch: 'feat/b5', path: wt('b5b') }, 'claude')
    const b = (await branchOf(t.id, 'feat/b5'))!
    expect(b.worktrees.map((w) => path.resolve(w.path)).sort()).toEqual([wt('b5a'), wt('b5b')])

    const [r] = await del([
      {
        ticketId: t.id,
        branch: 'feat/b5',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
    expect(r!.reason).toMatch(/untracked/)
    expect(r!.reason).toContain('notes.txt')
    expect(fs.existsSync(path.join(wt('b5b'), 'notes.txt'))).toBe(true)
    expect(worktreePaths()).toEqual(expect.arrayContaining([wt('b5a'), wt('b5b')]))
    expect(git('rev-parse', 'refs/heads/feat/b5')).toBe(sha)
  })

  const trees = async (ticketId: number, branch: string, sha: string) => {
    const b = (await branchOf(ticketId, branch))!
    expect(b.can.worktrees).toEqual({ ok: true, reason: null })
    const [r] = await del([
      { ticketId, branch, kind: 'worktrees', sha, worktrees: b.worktrees.map((w) => w.path) },
    ])
    return r!
  }

  it('sees untracked files that the repository’s config hides from git status', async () => {
    const { 'feat/b5u': sha } = land(['feat/b5u'])
    git('worktree', 'add', '-q', wt('b5u'), 'feat/b5u')
    fs.writeFileSync(path.join(wt('b5u'), 'scratch.txt'), 'mine')
    const t = done('b5 untracked hidden', 'feat/b5u')
    git('config', 'status.showUntrackedFiles', 'no')
    try {
      expect(gitIn(wt('b5u'))('status', '--porcelain')).toBe('')
      const r = await trees(t.id, 'feat/b5u', sha)
      expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
      expect(r.reason).toContain('scratch.txt')
    } finally {
      git('config', '--unset', 'status.showUntrackedFiles')
    }
    expect(fs.readFileSync(path.join(wt('b5u'), 'scratch.txt'), 'utf8')).toBe('mine')
    expect(git('rev-parse', 'refs/heads/feat/b5u')).toBe(sha)
  })

  it.each(['skip-worktree', 'assume-unchanged'])(
    'sees edits to a file marked %s, which git status hides',
    async (mark) => {
      const branch = `feat/b5-${mark}`
      const { [branch]: sha } = land([branch], { files: [{ path: 'config.local', data: 'committed\n' }] })
      const tree = wt(`b5-${mark}`)
      git('worktree', 'add', '-q', tree, branch)
      gitIn(tree)('update-index', `--${mark}`, 'config.local')
      fs.writeFileSync(path.join(tree, 'config.local'), 'my settings\n')
      expect(gitIn(tree)('status', '--porcelain')).toBe('')
      const t = done(`b5 ${mark}`, branch)

      const r = await trees(t.id, branch, sha!)
      expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
      expect(r.reason).toContain(`config.local (${mark})`)
      expect(fs.readFileSync(path.join(tree, 'config.local'), 'utf8')).toBe('my settings\n')
      expect(git('rev-parse', `refs/heads/${branch}`)).toBe(sha)
    },
  )

  it('refuses one with more marked files there than it checks, rather than hashing them all', async () => {
    const files = Array.from({ length: 1001 }, (_, i) => ({ path: `m/${i}.txt`, data: `${i}\n` }))
    const { 'feat/b5many': sha } = land(['feat/b5many'], { files })
    git('worktree', 'add', '-q', wt('b5many'), 'feat/b5many')
    const inTree = gitIn(wt('b5many'))
    execFileSync('git', ['update-index', '--assume-unchanged', '-z', '--stdin'], {
      cwd: wt('b5many'),
      input: files.map((f) => `${f.path}\0`).join(''),
    })
    expect(inTree('status', '--porcelain')).toBe('')
    const t = done('b5 many marked', 'feat/b5many')

    const r = await trees(t.id, 'feat/b5many', sha)
    expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
    expect(r.reason).toMatch(/1001 files marked skip-worktree or assume-unchanged, too many/)
    expect(fs.existsSync(wt('b5many'))).toBe(true)
  })

  it('removes one whose marked files are as committed, or not there', async () => {
    const files = [
      { path: 'kept.local', data: 'committed\n' },
      { path: 'sparse/gone.txt', data: 'committed\n' },
      { path: 'gone.local', data: 'committed\n' },
    ]
    const { 'feat/b5m': sha } = land(['feat/b5m'], { files })
    git('worktree', 'add', '-q', wt('b5m'), 'feat/b5m')
    const inTree = gitIn(wt('b5m'))
    inTree('update-index', '--skip-worktree', 'kept.local', 'sparse/gone.txt')
    inTree('update-index', '--assume-unchanged', 'gone.local')
    fs.rmSync(path.join(wt('b5m'), 'sparse'), { recursive: true })
    fs.rmSync(path.join(wt('b5m'), 'gone.local'))
    expect(inTree('status', '--porcelain')).toBe('')
    const t = done('b5 marked', 'feat/b5m')

    const r = await trees(t.id, 'feat/b5m', sha)
    expect(r).toMatchObject({ ok: true, outcome: 'deleted', reason: null })
    expect(fs.existsSync(wt('b5m'))).toBe(false)
    expect(hasRef(repo, 'refs/heads/feat/b5m')).toBe(false)
  })

  /**
   * A landed branch whose worktree has `caf\xE9.local` and `na\xEFve.local` committed: names in
   * Latin-1 bytes, not UTF-8. Linux takes any bytes for a name; Windows and macOS keep names in
   * Unicode, so no name there is anything but UTF-8, and these tests run on Linux alone. (In a folder
   * so named, the worktree is refused anyway: its links cannot be searched there.)
   */
  const bytesBranch = (branch: string) => {
    land([branch], { unique: true })
    const tree = wt(branch.replace(/\W/g, '-'))
    git('worktree', 'add', '-q', tree, branch)
    const at = (name: Buffer) => Buffer.concat([Buffer.from(`${tree}/`), name])
    const file = Buffer.from('caf\xe9.local', 'latin1')
    const other = Buffer.from('na\xefve.local', 'latin1')
    const index = (args: string[], ...names: Buffer[]) =>
      execFileSync('git', ['update-index', ...args, '-z', '--stdin'], {
        cwd: tree,
        input: Buffer.concat(names.flatMap((n) => [n, Buffer.from([0])])),
      })
    fs.writeFileSync(at(file), 'committed\n')
    fs.writeFileSync(at(other), 'committed\n')
    index(['--add'], file, other)
    gitIn(tree)('commit', '-q', '-m', 'names in Latin-1')
    const sha = gitIn(tree)('rev-parse', 'HEAD')
    // Main takes the branch as is.
    git(
      'update-ref',
      'refs/heads/main',
      git('commit-tree', 'main^{tree}', '-p', 'main', '-p', sha, '-m', 'merge'),
    )
    return { tree, sha, at, file, other, index }
  }

  it.runIf(process.platform === 'linux')(
    'sees edits to marked files whose name is not UTF-8, and keeps them',
    async () => {
      const { tree, sha, at, file, other, index } = bytesBranch('feat/b5-bytes')
      index(['--skip-worktree'], file)
      index(['--assume-unchanged'], other)
      fs.writeFileSync(at(file), 'my settings\n')
      fs.writeFileSync(at(other), 'mine too\n')
      expect(gitIn(tree)('status', '--porcelain')).toBe('')
      const t = done('b5 bytes', 'feat/b5-bytes')

      const r = await trees(t.id, 'feat/b5-bytes', sha)
      expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
      expect(r.reason).toContain('"caf\\351.local" (skip-worktree)')
      expect(r.reason).toContain('"na\\357ve.local" (assume-unchanged)')
      expect(fs.readFileSync(at(file), 'utf8')).toBe('my settings\n')
      expect(fs.readFileSync(at(other), 'utf8')).toBe('mine too\n')
      expect(git('rev-parse', 'refs/heads/feat/b5-bytes')).toBe(sha)
    },
  )

  it.runIf(process.platform === 'linux')(
    'refuses one with a changed or an untracked file whose name is not UTF-8',
    async () => {
      const { tree, sha, at, file } = bytesBranch('feat/b5-bytes2')
      fs.writeFileSync(at(file), 'edited\n')
      const t = done('b5 bytes 2', 'feat/b5-bytes2')
      const changed = await trees(t.id, 'feat/b5-bytes2', sha)
      expect(changed).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
      expect(changed.reason).toContain('caf')
      expect(fs.readFileSync(at(file), 'utf8')).toBe('edited\n')

      gitIn(tree)('checkout', '--', '.')
      const untracked = Buffer.from('notes-\xe9.txt', 'latin1')
      fs.writeFileSync(at(untracked), 'mine\n')
      const r = await trees(t.id, 'feat/b5-bytes2', sha)
      expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [] })
      expect(r.reason).toContain('notes-')
      expect(fs.readFileSync(at(untracked), 'utf8')).toBe('mine\n')
      expect(git('rev-parse', 'refs/heads/feat/b5-bytes2')).toBe(sha)
    },
  )

  it('never removes a locked worktree', async () => {
    const { 'feat/b5l': sha } = land(['feat/b5l'])
    git('worktree', 'add', '-q', wt('b5l'), 'feat/b5l')
    git('worktree', 'lock', wt('b5l'))
    const t = done('b5 locked', 'feat/b5l')
    const b = (await branchOf(t.id, 'feat/b5l'))!
    expect(b.worktrees[0]!.protected).toBe('locked')
    const [r] = await del([
      {
        ticketId: t.id,
        branch: 'feat/b5l',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/locked/) })
    expect(fs.existsSync(wt('b5l'))).toBe(true)
  })

  it('refuses a worktree whose folder is gone, rather than reading it clean', async () => {
    const { 'feat/b3g': sha } = land(['feat/b3g'])
    git('worktree', 'add', '-q', wt('b3g'), 'feat/b3g')
    fs.rmSync(wt('b3g'), { recursive: true, force: true })
    const t = done('b3 gone', 'feat/b3g')
    const b = (await branchOf(t.id, 'feat/b3g'))!
    const [r] = await del([
      {
        ticketId: t.id,
        branch: 'feat/b3g',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/is gone/) })
    expect(hasRef(repo, 'refs/heads/feat/b3g')).toBe(true)
  })

  it('never removes a worktree the human was not shown', async () => {
    const { 'feat/b3u': sha } = land(['feat/b3u'])
    git('worktree', 'add', '-q', wt('b3u'), 'feat/b3u')
    const t = done('b3 unseen', 'feat/b3u')
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b3u', kind: 'worktrees', sha, worktrees: [] }])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/came up since/) })
    expect(fs.existsSync(wt('b3u'))).toBe(true)
  })

  it('stops a preview the board runs from the worktree first, and waits for it', async () => {
    const mp = await import('./managedPreview')
    const runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    const { 'feat/b9': sha } = land(['feat/b9'])
    git('worktree', 'add', '-q', wt('b9'), 'feat/b9')
    // Installed already: the preview goes straight to its build.
    fs.mkdirSync(path.join(wt('b9'), 'node_modules', '.pnpm'), { recursive: true })
    fs.writeFileSync(path.join(wt('b9'), 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
    runner.watch = wt('b9')
    const t = features.createTicket(
      projectId,
      { title: 'b9', branch: 'feat/b9', status: 'in_progress' },
      'claude',
    )
    const ws = features.addWorkspace(t.id, { name: 'wt', branch: 'feat/b9', path: wt('b9') }, 'claude')
    mp.startPreview(ws.id, 'enrique')
    await expect.poll(() => mp.managedPreview(ws.id)?.status, { timeout: 10_000 }).toBe('running')
    // Closed behind the board's back: its preview still runs.
    dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, t.id)).run()
    const b = (await branchOf(t.id, 'feat/b9'))!
    expect(b.worktrees[0]!.previews.map((p) => p.workspaceId)).toEqual([ws.id])
    // Its link is that preview's: listed as the preview, not as a server of its own.
    expect(
      dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, ws.id)).get()!
        .previewUrl,
    ).toBe(mp.managedPreview(ws.id)!.url)
    expect(b.worktrees[0]!.linkedPreviews).toEqual([])

    const [r] = await del([
      {
        ticketId: t.id,
        branch: 'feat/b9',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    expect(r!.outcome).toBe('deleted')
    expect(runner.killed).toEqual([{ pid: expect.any(Number), worktreeThere: true }])
    expect(mp.activePreviews().filter((p) => p.workspaceId === ws.id)).toEqual([])
    expect(
      dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, ws.id)).get(),
    ).toBeUndefined()
    expect(fs.existsSync(wt('b9'))).toBe(false)
  })

  it('waits for a stopped preview’s copy of the live data to end before it removes the worktree', async () => {
    const mp = await import('./managedPreview')
    const runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    // The copy writes part of the data, then the rest once the test lets it: a copy of many uploads.
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    /** Each write, with whether the delete had answered by then. */
    const wrote: boolean[] = []
    let answered = false
    let copied = false
    runner.copyData = async (dest: string) => {
      const write = (name: string) => {
        fs.mkdirSync(path.join(dest, 'uploads'), { recursive: true })
        fs.writeFileSync(path.join(dest, 'uploads', name), 'an upload')
        wrote.push(answered)
      }
      write('1')
      await released
      write('2')
      copied = true
    }
    const { 'feat/b9c': sha } = land(['feat/b9c'])
    git('worktree', 'add', '-q', wt('b9c'), 'feat/b9c')
    fs.mkdirSync(path.join(wt('b9c'), 'node_modules', '.pnpm'), { recursive: true })
    fs.writeFileSync(path.join(wt('b9c'), 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
    const t = features.createTicket(
      projectId,
      { title: 'b9c', branch: 'feat/b9c', status: 'in_progress' },
      'claude',
    )
    const ws = features.addWorkspace(t.id, { name: 'wt', branch: 'feat/b9c', path: wt('b9c') }, 'claude')
    mp.startPreview(ws.id, 'enrique')
    await expect.poll(() => wrote.length, { timeout: 10_000 }).toBe(1)
    expect(mp.managedPreview(ws.id)).toMatchObject({ status: 'building', step: 'copy' })
    dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, t.id)).run()
    const b = (await branchOf(t.id, 'feat/b9c'))!

    const deleting = del([
      {
        ticketId: t.id,
        branch: 'feat/b9c',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ]).finally(() => (answered = true))
    // The copy goes on for a while after the stop; it ends sooner only if the delete answers first.
    await Promise.race([deleting, new Promise((r) => setTimeout(r, 1500))])
    release()
    const [r] = await deleting
    await expect.poll(() => copied, { timeout: 10_000 }).toBe(true)

    expect(r).toMatchObject({ outcome: 'deleted', removed: b.worktrees.map((w) => w.path) })
    expect(mp.managedPreview(ws.id)).toBeNull()
    expect(wrote).toEqual([false, false])
    expect(fs.existsSync(wt('b9c'))).toBe(false)
    expect(worktreePaths()).not.toContain(wt('b9c'))
    expect(hasRef(repo, 'refs/heads/feat/b9c')).toBe(false)
  })

  it('removes nothing when a preview the hold missed starts from the worktree while its own is being stopped, nor waits for it', async () => {
    const mp = await import('./managedPreview')
    const runner = new FakeRunner()
    mp.setPreviewRunner(runner)
    const { 'feat/b9l': sha } = land(['feat/b9l'])
    git('worktree', 'add', '-q', wt('b9l'), 'feat/b9l')
    fs.mkdirSync(path.join(wt('b9l'), 'node_modules', '.pnpm'), { recursive: true })
    fs.writeFileSync(path.join(wt('b9l'), 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
    const t = features.createTicket(
      projectId,
      { title: 'b9l', branch: 'feat/b9l', status: 'in_progress' },
      'claude',
    )
    const ws = features.addWorkspace(t.id, { name: 'wt', branch: 'feat/b9l', path: wt('b9l') }, 'claude')
    mp.startPreview(ws.id, 'enrique')
    await expect.poll(() => mp.managedPreview(ws.id)?.status, { timeout: 10_000 }).toBe('running')
    dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, t.id)).run()
    const b = (await branchOf(t.id, 'feat/b9l'))!
    // Killing its process tree takes a while (taskkill, on Windows), and the next build longer still.
    let kill!: () => void
    const killed = new Promise<void>((r) => (kill = r))
    let killing = false
    runner.killTree = async () => {
      killing = true
      await killed
    }
    runner.hold = true
    // The hold refuses such a start (below); left out here, the check after the stops still keeps it.
    const unheld = vi.spyOn(mp, 'holdPreviews').mockReturnValue(() => {})
    const other = features.createTicket(
      projectId,
      { title: 'b9l late', branch: 'feat/b9l-late', status: 'in_progress' },
      'claude',
    )
    let late: { id: number } | undefined

    const deleting = del([
      {
        ticketId: t.id,
        branch: 'feat/b9l',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    try {
      await expect.poll(() => killing, { timeout: 10_000 }).toBe(true)
      // Meanwhile an agent of a ticket in work registers the worktree and starts its preview there.
      late = features.addWorkspace(other.id, { name: 'late', path: wt('b9l') }, 'claude')
      expect(mp.startPreview(late.id, 'claude').status).toBe('building')
      kill()
      expect(await within(deleting, 5000)).toEqual([
        expect.objectContaining({
          outcome: 'refused',
          reason: `a preview started from ${b.worktrees[0]!.path} meanwhile, on #${other.id}`,
          removed: [],
        }),
      ])
      expect(mp.managedPreview(ws.id)!.status).toBe('stopped')
      expect(mp.managedPreview(late.id)!.status).toBe('building')
      expect(fs.existsSync(wt('b9l'))).toBe(true)
      expect(worktreePaths()).toContain(wt('b9l'))
      expect(hasRef(repo, 'refs/heads/feat/b9l')).toBe(true)
      expect(
        dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.id, late.id)).get(),
      ).toBeDefined()
    } finally {
      unheld.mockRestore()
      if (late) await mp.stopPreview(late.id, 'test over', 'enrique')
      kill()
      runner.release()
      await deleting
    }
  })

  it('starts no preview from a worktree while it is being removed, and one once it is', async () => {
    const mp = await import('./managedPreview')
    const g = await import('./git')
    mp.setPreviewRunner(new FakeRunner())
    const { 'feat/b9h': sha } = land(['feat/b9h'])
    git('worktree', 'add', '-q', wt('b9h'), 'feat/b9h')
    const t = done('b9h', 'feat/b9h')
    const b = (await branchOf(t.id, 'feat/b9h'))!
    const other = features.createTicket(
      projectId,
      { title: 'b9h other', branch: 'feat/b9h-other', status: 'in_progress' },
      'claude',
    )
    // git takes a while to remove it.
    const removeWorktree = g.removeWorktree
    let go!: () => void
    const gone = new Promise<void>((r) => (go = r))
    let removing = false
    const slow = vi.spyOn(g, 'removeWorktree').mockImplementation(async (...args) => {
      removing = true
      await gone
      return removeWorktree(...args)
    })
    const deleting = del([
      {
        ticketId: t.id,
        branch: 'feat/b9h',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    try {
      await expect.poll(() => removing, { timeout: 10_000 }).toBe(true)
      // Meanwhile an agent of a ticket in work registers it and starts its preview there.
      const late = features.addWorkspace(other.id, { name: 'late', path: wt('b9h') }, 'claude')
      expect(mp.cannotStart(late.id)).toBe('its worktree is being removed')
      expect(() => mp.startPreview(late.id, 'claude')).toThrow('its worktree is being removed')
      expect(mp.managedPreview(late.id)).toBeNull()
      go()
      expect(await deleting).toEqual([expect.objectContaining({ outcome: 'deleted' })])
    } finally {
      slow.mockRestore()
      go()
      await deleting
    }
    expect(fs.existsSync(wt('b9h'))).toBe(false)

    // Made again at the same path: a preview starts from it.
    git('worktree', 'add', '-q', '-b', 'feat/b9h-again', wt('b9h'), 'main')
    const again = features.addWorkspace(other.id, { name: 'again', path: wt('b9h') }, 'claude')
    expect(mp.startPreview(again.id, 'claude').status).toBe('building')
    await mp.stopPreview(again.id, 'test over', 'enrique')
  })

  it('lets a preview start from a worktree it failed to remove', async () => {
    const mp = await import('./managedPreview')
    const g = await import('./git')
    mp.setPreviewRunner(new FakeRunner())
    const { 'feat/b9f': sha } = land(['feat/b9f'])
    git('worktree', 'add', '-q', wt('b9f'), 'feat/b9f')
    const t = done('b9f', 'feat/b9f')
    const b = (await branchOf(t.id, 'feat/b9f'))!
    const failing = vi.spyOn(g, 'removeWorktree').mockRejectedValue(new Error('the folder is in use'))
    try {
      const [r] = await del([
        {
          ticketId: t.id,
          branch: 'feat/b9f',
          kind: 'worktrees',
          sha,
          worktrees: b.worktrees.map((w) => w.path),
        },
      ])
      expect(r).toMatchObject({ outcome: 'failed', removed: [] })
      expect(r!.reason).toContain('the folder is in use')
    } finally {
      failing.mockRestore()
    }
    expect(fs.existsSync(wt('b9f'))).toBe(true)
    const other = features.createTicket(
      projectId,
      { title: 'b9f other', branch: 'feat/b9f-other', status: 'in_progress' },
      'claude',
    )
    const ws = features.addWorkspace(other.id, { name: 'theirs', path: wt('b9f') }, 'claude')
    expect(mp.startPreview(ws.id, 'claude').status).toBe('building')
    await mp.stopPreview(ws.id, 'test over', 'enrique')
  })

  describe('a server an agent started from the worktree', { timeout: 60_000 }, () => {
    // Listens on 127.0.0.1 and prints its port, as `pnpm dev` would serve a preview.
    const SERVER = `const s = require('node:http').createServer((_q, r) => r.end('dev'))
s.listen(0, '127.0.0.1', () => console.log(s.address().port))`
    const running: ChildProcess[] = []
    const serve = async (script: string, cwd: string) => {
      fs.mkdirSync(path.dirname(script), { recursive: true })
      fs.writeFileSync(script, SERVER)
      const child = spawn(process.execPath, [script], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
      running.push(child)
      const exited = new Promise((resolve) => child.once('exit', resolve))
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString().trim())))
        child.once('exit', (code) => reject(new Error(`the server exited (${code}) before it listened`)))
      })
      return { child, port, exited }
    }
    const answers = (port: number) =>
      fetch(`http://127.0.0.1:${port}`).then(
        (r) => r.ok,
        () => false,
      )
    afterAll(() => {
      for (const child of running) child.kill('SIGKILL')
    })
    // A port free now and out of the range the live board's own previews use: the fake never binds it.
    const free = (): Promise<number> =>
      new Promise((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
          const port = (s.address() as AddressInfo).port
          s.close(() => resolve(port >= 47100 && port <= 47199 ? free() : port))
        })
      })

    it('stops it before the worktree goes, when it runs from there', async () => {
      const { 'feat/g5': sha } = land(['feat/g5'])
      git('worktree', 'add', '-q', wt('g5'), 'feat/g5')
      // In an ignored folder, as a dev server's files are: the worktree stays clean.
      const s = await serve(path.join(wt('g5'), 'data', 'server.js'), wt('g5'))
      const t = done('g5', 'feat/g5')
      const url = `http://127.0.0.1:${s.port}`
      const ws = features.addWorkspace(
        t.id,
        { name: 'dev', branch: 'feat/g5', path: wt('g5'), previewUrl: url },
        'claude',
      )
      expect(await answers(s.port)).toBe(true)
      const b = (await branchOf(t.id, 'feat/g5'))!
      expect(b.worktrees.map((w) => w.linkedPreviews)).toEqual([
        [{ workspaceId: ws.id, ticketId: t.id, url, port: s.port }],
      ])

      const [r] = await del([
        {
          ticketId: t.id,
          branch: 'feat/g5',
          kind: 'worktrees',
          sha,
          worktrees: b.worktrees.map((w) => w.path),
        },
      ])
      expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
      await s.exited
      expect(await answers(s.port)).toBe(false)
      expect(fs.existsSync(wt('g5'))).toBe(false)
      expect(hasRef(repo, 'refs/heads/feat/g5')).toBe(false)
      expect(activity(t.id)).toContain(`stopped the preview on :${s.port}`)
    })

    it('leaves one alone that does not run from it, and removes the worktree all the same', async () => {
      const { 'feat/g5b': sha } = land(['feat/g5b'])
      git('worktree', 'add', '-q', wt('g5b'), 'feat/g5b')
      // Linked on the worktree's workspace, but run from elsewhere: not the worktree's to stop.
      const s = await serve(path.join(tmp, 'elsewhere', 'server.js'), tmp)
      const t = done('g5b', 'feat/g5b')
      features.addWorkspace(
        t.id,
        { name: 'dev', branch: 'feat/g5b', path: wt('g5b'), previewUrl: `http://127.0.0.1:${s.port}` },
        'claude',
      )
      const b = (await branchOf(t.id, 'feat/g5b'))!

      const [r] = await del([
        {
          ticketId: t.id,
          branch: 'feat/g5b',
          kind: 'worktrees',
          sha,
          worktrees: b.worktrees.map((w) => w.path),
        },
      ])
      expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
      expect(fs.existsSync(wt('g5b'))).toBe(false)
      expect(await answers(s.port)).toBe(true)
      expect(s.child.exitCode).toBeNull()
      expect(activity(t.id)).not.toContain('stopped the preview')
    })

    it('asks nothing for one linked at a worktree that is not next to the main checkout', async () => {
      const lp = await import('./linkPreview')
      const asks = vi.spyOn(lp, 'stopLinkPreview')
      try {
        const { 'feat/g5c': sha } = land(['feat/g5c'])
        // A worktree of the repo, somewhere else: the Previews page's Stop never acts on it.
        const far = path.join(tmp, 'away', 'agent-board-g5c')
        git('worktree', 'add', '-q', far, 'feat/g5c')
        // It runs from there (its script is), from a folder that does not hold the worktree.
        const s = await serve(path.join(far, 'data', 'server.js'), tmp)
        const t = done('g5c', 'feat/g5c')
        features.addWorkspace(
          t.id,
          { name: 'dev', branch: 'feat/g5c', path: far, previewUrl: `http://127.0.0.1:${s.port}` },
          'claude',
        )
        const b = (await branchOf(t.id, 'feat/g5c'))!
        expect(b.worktrees.map((w) => w.linkedPreviews)).toEqual([[]])

        const [r] = await del([
          {
            ticketId: t.id,
            branch: 'feat/g5c',
            kind: 'worktrees',
            sha,
            worktrees: b.worktrees.map((w) => w.path),
          },
        ])
        expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
        expect(asks).not.toHaveBeenCalled()
        expect(await answers(s.port)).toBe(true)
        expect(s.child.exitCode).toBeNull()
        expect(fs.existsSync(far)).toBe(false)
      } finally {
        asks.mockRestore()
      }
    })

    it('asks only what the report lists, not a link to the port of the preview it stopped first', async () => {
      const mp = await import('./managedPreview')
      const lp = await import('./linkPreview')
      mp.setPreviewRunner(new FakeRunner())
      const held = await free()
      const ports = { ...mp.PORTS }
      const asks = vi.spyOn(lp, 'stopLinkPreview')
      try {
        const { 'feat/g5d': sha } = land(['feat/g5d'])
        git('worktree', 'add', '-q', wt('g5d'), 'feat/g5d')
        // Installed already: the preview goes straight to its build.
        fs.mkdirSync(path.join(wt('g5d'), 'node_modules', '.pnpm'), { recursive: true })
        fs.writeFileSync(path.join(wt('g5d'), 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
        const t = features.createTicket(
          projectId,
          { title: 'g5d', branch: 'feat/g5d', status: 'in_progress' },
          'claude',
        )
        const managed = features.addWorkspace(
          t.id,
          { name: 'wt', branch: 'feat/g5d', path: wt('g5d') },
          'claude',
        )
        Object.assign(mp.PORTS, { from: held, to: held })
        mp.startPreview(managed.id, 'enrique')
        await expect.poll(() => mp.managedPreview(managed.id)?.status, { timeout: 10_000 }).toBe('running')
        expect(mp.managedPreview(managed.id)!.port).toBe(held)
        // Another workspace at the worktree linking that preview, and one linking a server of its own.
        features.addWorkspace(
          t.id,
          { name: 'copy', branch: 'feat/g5d', path: wt('g5d'), previewUrl: `http://127.0.0.1:${held}` },
          'claude',
        )
        const s = await serve(path.join(wt('g5d'), 'data', 'server.js'), wt('g5d'))
        const url = `http://127.0.0.1:${s.port}`
        const own = features.addWorkspace(
          t.id,
          { name: 'dev', branch: 'feat/g5d', path: wt('g5d'), previewUrl: url },
          'claude',
        )
        // Closed behind the board's back: its preview still runs.
        dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, t.id)).run()
        const b = (await branchOf(t.id, 'feat/g5d'))!
        expect(b.worktrees.map((w) => w.previews.map((p) => p.workspaceId))).toEqual([[managed.id]])
        expect(b.worktrees.map((w) => w.linkedPreviews)).toEqual([
          [{ workspaceId: own.id, ticketId: t.id, url, port: s.port }],
        ])

        const [r] = await del([
          {
            ticketId: t.id,
            branch: 'feat/g5d',
            kind: 'worktrees',
            sha,
            worktrees: b.worktrees.map((w) => w.path),
          },
        ])
        expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
        expect(asks.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([own.id])
        await s.exited
        expect(activity(t.id)).toContain(`stopped the preview on :${s.port}`)
        expect(fs.existsSync(wt('g5d'))).toBe(false)
      } finally {
        asks.mockRestore()
        Object.assign(mp.PORTS, ports)
      }
    })

    it('stops one linked on the workspace whose preview it stopped first, as the report listed it', async () => {
      const mp = await import('./managedPreview')
      const lp = await import('./linkPreview')
      const runner = new FakeRunner()
      mp.setPreviewRunner(runner)
      const held = await free()
      const ports = { ...mp.PORTS }
      const asks = vi.spyOn(lp, 'stopLinkPreview')
      try {
        const { 'feat/g5e': sha } = land(['feat/g5e'])
        git('worktree', 'add', '-q', wt('g5e'), 'feat/g5e')
        // Installed already: the preview goes straight to its build.
        fs.mkdirSync(path.join(wt('g5e'), 'node_modules', '.pnpm'), { recursive: true })
        fs.writeFileSync(path.join(wt('g5e'), 'node_modules', '.pnpm', 'lock.yaml'), LOCK)
        runner.watch = wt('g5e')
        const t = features.createTicket(
          projectId,
          { title: 'g5e', branch: 'feat/g5e', status: 'in_progress' },
          'claude',
        )
        const ws = features.addWorkspace(t.id, { name: 'wt', branch: 'feat/g5e', path: wt('g5e') }, 'claude')
        Object.assign(mp.PORTS, { from: held, to: held })
        mp.startPreview(ws.id, 'enrique')
        await expect.poll(() => mp.managedPreview(ws.id)?.status, { timeout: 10_000 }).toBe('running')
        expect(mp.managedPreview(ws.id)!.port).toBe(held)
        // The agent's own server, from the worktree, linked on that same workspace while its preview runs.
        const s = await serve(path.join(wt('g5e'), 'data', 'server.js'), wt('g5e'))
        expect(s.port).not.toBe(held)
        const url = `http://127.0.0.1:${s.port}`
        features.setWorkspacePreview(ws.id, url, 'claude')
        // Closed behind the board's back: its preview still runs.
        dbm.db.update(dbm.schema.tickets).set({ status: 'done' }).where(eq(dbm.schema.tickets.id, t.id)).run()
        const b = (await branchOf(t.id, 'feat/g5e'))!
        expect(b.worktrees.map((w) => w.previews.map((p) => p.workspaceId))).toEqual([[ws.id]])
        expect(b.worktrees.map((w) => w.linkedPreviews)).toEqual([
          [{ workspaceId: ws.id, ticketId: t.id, url, port: s.port }],
        ])

        const [r] = await del([
          {
            ticketId: t.id,
            branch: 'feat/g5e',
            kind: 'worktrees',
            sha,
            worktrees: b.worktrees.map((w) => w.path),
          },
        ])
        expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
        expect(runner.killed).toEqual([{ pid: expect.any(Number), worktreeThere: true }])
        expect(asks.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([ws.id])
        await s.exited
        expect(await answers(s.port)).toBe(false)
        // Its preview first, then the server.
        const log = activity(t.id)
        expect(log).toContain('stopped the preview (its worktree was removed)')
        expect(log.indexOf(`stopped the preview on :${s.port}`)).toBeGreaterThan(
          log.indexOf('stopped the preview (its worktree was removed)'),
        )
        expect(fs.existsSync(wt('g5e'))).toBe(false)
        expect(hasRef(repo, 'refs/heads/feat/g5e')).toBe(false)
      } finally {
        asks.mockRestore()
        Object.assign(mp.PORTS, ports)
      }
    })
  })

  it('goes on with the next item when one is refused, and answers both', async () => {
    const shas = land(['feat/b13ok', 'feat/b13dirty'])
    git('worktree', 'add', '-q', wt('b13'), 'feat/b13dirty')
    fs.writeFileSync(path.join(wt('b13'), 'base.txt'), 'changed')
    const ok = done('b13 ok', 'feat/b13ok')
    const dirty = done('b13 dirty', 'feat/b13dirty')
    const results = await del([
      {
        ticketId: dirty.id,
        branch: 'feat/b13dirty',
        kind: 'worktrees',
        sha: shas['feat/b13dirty']!,
        worktrees: [wt('b13')],
      },
      { ticketId: ok.id, branch: 'feat/b13ok', kind: 'local', sha: shas['feat/b13ok']! },
    ])
    expect(results.map((r) => [r.branch, r.outcome])).toEqual([
      ['feat/b13dirty', 'refused'],
      ['feat/b13ok', 'deleted'],
    ])
    expect(hasRef(repo, 'refs/heads/feat/b13dirty')).toBe(true)
    expect(hasRef(repo, 'refs/heads/feat/b13ok')).toBe(false)
  })
})

describe('links in a worktree that lead out of it', () => {
  // A directory junction on Windows (what agents link node_modules or data with), a symbolic link
  // elsewhere.
  const made: string[] = []
  const linkDir = (target: string, link: string) => {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    made.push(link)
  }
  /** A folder outside every worktree, holding a file that must outlive their removal. */
  const outside = (name: string) => {
    const dir = path.join(tmp, `outside-${name}`)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'keep.txt'), name)
    return dir
  }
  const kept = (dir: string) => fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')
  /** Moves a worktree's folder outside it, and links it back in its place. */
  const moveOut = (dir: string, name: string) => {
    const target = path.join(tmp, `outside-${name}`)
    fs.cpSync(dir, target, { recursive: true })
    fs.rmSync(dir, { recursive: true })
    linkDir(target, dir)
    return target
  }
  const isLink = (p: string) => {
    try {
      return fs.lstatSync(p).isSymbolicLink()
    } catch {
      return false
    }
  }
  // Symbolic links git checks out need the right to create them (Windows grants it only to admins and
  // developer mode).
  const canSymlink = (() => {
    const probe = path.join(tmp, 'symlink-probe')
    try {
      fs.symlinkSync(path.join(tmp, 'marks'), probe, 'file')
      fs.unlinkSync(probe)
      return true
    } catch {
      return false
    }
  })()
  const delTrees = async (ticketId: number, branch: string, sha: string) => {
    const b = (await branchOf(ticketId, branch))!
    expect(b.can.worktrees).toEqual({ ok: true, reason: null })
    const [r] = await del([
      { ticketId, branch, kind: 'worktrees', sha, worktrees: b.worktrees.map((w) => w.path) },
    ])
    return r!
  }

  afterAll(() => {
    // The links first, never through them: then each outside folder is a plain one.
    for (const link of made.filter(isLink)) {
      try {
        fs.unlinkSync(link)
      } catch {
        fs.rmdirSync(link)
      }
    }
    for (const dir of fs.readdirSync(tmp).filter((d) => d.startsWith('outside-')))
      fs.rmSync(path.join(tmp, dir), { recursive: true })
  })

  it('removes an ignored node_modules linked to another folder as a link, and keeps that folder’s files', async () => {
    const { 'feat/l1': sha } = land(['feat/l1'])
    git('worktree', 'add', '-q', wt('l1'), 'feat/l1')
    const target = outside('l1')
    const link = path.join(wt('l1'), 'node_modules')
    linkDir(target, link)
    // What the walk relies on: the link reads as one, from its folder and by itself.
    expect(isLink(link)).toBe(true)
    expect(
      fs
        .readdirSync(wt('l1'), { withFileTypes: true })
        .find((e) => e.name === 'node_modules')!
        .isSymbolicLink(),
    ).toBe(true)
    expect(gitIn(wt('l1'))('status', '--porcelain')).toBe('')
    const t = done('l1', 'feat/l1')

    const r = await delTrees(t.id, 'feat/l1', sha)
    expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
    expect(fs.existsSync(wt('l1'))).toBe(false)
    expect(kept(target)).toBe('l1')
    expect(r.unlinked.map((l) => [path.resolve(l.path), path.resolve(l.target)])).toEqual([[link, target]])
    expect(hasRef(repo, 'refs/heads/feat/l1')).toBe(false)
    expect(activity(t.id)).toContain(`removed the link ${r.unlinked[0]!.path} to ${r.unlinked[0]!.target}`)
  })

  it('removes one with links within it as pnpm makes them, and follows a chain of them out of it', async () => {
    const { 'feat/l3': sha } = land(['feat/l3'])
    git('worktree', 'add', '-q', wt('l3'), 'feat/l3')
    const modules = path.join(wt('l3'), 'node_modules')
    // pnpm's layout: each package a link into node_modules/.pnpm, which git reaches first.
    fs.mkdirSync(path.join(modules, '.pnpm', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(modules, '.pnpm', 'pkg', 'index.js'), 'x')
    linkDir(path.join(modules, '.pnpm', 'pkg'), path.join(modules, 'pkg'))
    // One that reads as within, but leads to a link out of it.
    const target = outside('l3')
    linkDir(target, path.join(modules, '.pnpm', 'ext'))
    linkDir(path.join(modules, '.pnpm', 'ext'), path.join(modules, 'ext'))
    const t = done('l3', 'feat/l3')

    const r = await delTrees(t.id, 'feat/l3', sha)
    expect(r).toMatchObject({ ok: true, outcome: 'deleted' })
    expect(fs.existsSync(wt('l3'))).toBe(false)
    expect(kept(target)).toBe('l3')
    expect(r.unlinked.map((l) => path.resolve(l.path)).sort()).toEqual(
      [path.join(modules, '.pnpm', 'ext'), path.join(modules, 'ext')].sort(),
    )
  })

  it.skipIf(!canSymlink)('refuses a link out of it that git tracks, and removes nothing', async () => {
    const target = outside('l2')
    const { 'feat/l2': sha } = land(['feat/l2'], {
      files: [{ path: 'vendor', data: target, link: true }],
    })
    git('config', 'core.symlinks', 'true')
    git('worktree', 'add', '-q', wt('l2'), 'feat/l2')
    const link = path.join(wt('l2'), 'vendor')
    made.push(link)
    expect(isLink(link)).toBe(true)
    expect(gitIn(wt('l2'))('status', '--porcelain')).toBe('')
    const t = done('l2', 'feat/l2')

    const r = await delTrees(t.id, 'feat/l2', sha)
    expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [], unlinked: [] })
    expect(r.reason).toContain('vendor')
    expect(r.reason).toMatch(/git tracks/)
    expect(isLink(link)).toBe(true)
    expect(kept(target)).toBe('l2')
    expect(worktreePaths()).toContain(wt('l2'))
    expect(git('rev-parse', 'refs/heads/feat/l2')).toBe(sha)
  })

  it('refuses a link out of it over files git tracks, and removes nothing', async () => {
    const { 'feat/l4': sha } = land(['feat/l4'], { files: [{ path: 'vendor/lib.txt', data: 'lib\n' }] })
    git('worktree', 'add', '-q', wt('l4'), 'feat/l4')
    // The same files, in a folder the worktree links to: git reads them through the link as its own.
    const vendor = path.join(wt('l4'), 'vendor')
    const target = moveOut(vendor, 'l4')
    const t = done('l4', 'feat/l4')

    const r = await delTrees(t.id, 'feat/l4', sha)
    expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [], unlinked: [] })
    expect(r.reason).toContain('vendor')
    expect(isLink(vendor)).toBe(true)
    expect(fs.readFileSync(path.join(target, 'lib.txt'), 'utf8').trim()).toBe('lib')
    expect(worktreePaths()).toContain(wt('l4'))
    expect(git('rev-parse', 'refs/heads/feat/l4')).toBe(sha)
  })

  // Root reads any folder.
  it.skipIf(process.getuid?.() === 0)(
    'refuses one with a folder it cannot read, and removes nothing',
    async () => {
      const { 'feat/l6': sha } = land(['feat/l6'])
      git('worktree', 'add', '-q', wt('l6'), 'feat/l6')
      const modules = path.join(wt('l6'), 'node_modules')
      const sealed = path.join(modules, 'sealed')
      fs.mkdirSync(sealed, { recursive: true })
      const target = outside('l6')
      linkDir(target, path.join(modules, 'ext'))
      // Whatever the unread folder holds is not known, so the worktree is not known to be safe.
      const seal = (on: boolean) =>
        process.platform === 'win32'
          ? execFileSync('icacls', [sealed, on ? '/deny' : '/remove:d', on ? '*S-1-1-0:(RD)' : '*S-1-1-0'], {
              stdio: 'ignore',
            })
          : fs.chmodSync(sealed, on ? 0o000 : 0o755)
      seal(true)
      try {
        expect(() => fs.readdirSync(sealed)).toThrow()
        const t = done('l6', 'feat/l6')
        const r = await delTrees(t.id, 'feat/l6', sha)
        expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [], unlinked: [] })
        expect(r.reason).toMatch(/could not be searched/)
      } finally {
        seal(false)
      }
      expect(isLink(path.join(modules, 'ext'))).toBe(true)
      expect(kept(target)).toBe('l6')
      expect(worktreePaths()).toContain(wt('l6'))
      expect(git('rev-parse', 'refs/heads/feat/l6')).toBe(sha)
    },
  )

  it('removes no worktree and no link while another worktree of the branch is refused', async () => {
    const { 'feat/l5': sha } = land(['feat/l5'], { files: [{ path: 'vendor/lib.txt', data: 'lib\n' }] })
    git('worktree', 'add', '-q', wt('l5a'), 'feat/l5')
    git('worktree', 'add', '-q', '--detach', wt('l5b'), 'feat/l5')
    // The first is fine: an ignored link out of it, removed as a link.
    const modulesTarget = outside('l5a')
    const modules = path.join(wt('l5a'), 'node_modules')
    linkDir(modulesTarget, modules)
    // The second links its tracked vendor folder out of it.
    const vendor = path.join(wt('l5b'), 'vendor')
    const vendorTarget = moveOut(vendor, 'l5b')
    const t = done('l5', 'feat/l5')
    features.addWorkspace(t.id, { name: 'review', branch: 'feat/l5', path: wt('l5b') }, 'claude')
    const b = (await branchOf(t.id, 'feat/l5'))!
    // The fine one comes first: a check made while removing would have removed it already.
    expect(path.resolve(b.worktrees.filter((w) => !w.main)[0]!.path)).toBe(wt('l5a'))

    const r = await delTrees(t.id, 'feat/l5', sha)
    expect(r).toMatchObject({ ok: false, outcome: 'refused', removed: [], unlinked: [] })
    expect(r.reason).toContain('vendor')
    expect(isLink(modules)).toBe(true)
    expect(isLink(vendor)).toBe(true)
    expect(kept(modulesTarget)).toBe('l5a')
    expect(fs.readFileSync(path.join(vendorTarget, 'lib.txt'), 'utf8').trim()).toBe('lib')
    expect(worktreePaths()).toEqual(expect.arrayContaining([wt('l5a'), wt('l5b')]))
    expect(git('rev-parse', 'refs/heads/feat/l5')).toBe(sha)
  })

  it(
    'removes one whose linked folder sits among more tracked files than one call can take',
    { timeout: 300_000 },
    async () => {
      // 130 000 files git tracks under p/, made from one blob in a scratch index: too many to spread
      // into one push, and a listing of them longer than any fixed buffer would take.
      const index = path.join(tmp, 'big-index')
      const scratch = { ...process.env, GIT_INDEX_FILE: index }
      const inScratch = (args: string[], input?: string) =>
        execFileSync('git', args, {
          cwd: repo,
          env: scratch,
          input,
          encoding: 'utf8',
          maxBuffer: 1 << 30,
        }).trim()
      inScratch(['read-tree', 'main'])
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: repo,
        input: 'x\n',
        encoding: 'utf8',
      }).trim()
      const deep = 'a-folder-name-long-enough-to-make-the-listing-big/'.repeat(3)
      let entries = ''
      for (let i = 0; i < 130_000; i++) entries += `100644 ${blob}\tp/${deep}d${i % 500}/file-${i}.txt\n`
      inScratch(['update-index', '--index-info'], entries)
      const sha = git('commit-tree', inScratch(['write-tree']), '-p', 'main', '-m', 'big')
      fs.rmSync(index)
      git('update-ref', 'refs/heads/feat/big', sha)
      // main merges it keeping its own files: the branch landed, and later worktrees stay small.
      git(
        'update-ref',
        'refs/heads/main',
        git('commit-tree', 'main^{tree}', '-p', 'main', '-p', sha, '-m', 'merge big'),
      )
      // Its files are tracked but never written, each marked skip-worktree: the worktree reads clean.
      git('worktree', 'add', '-q', '--no-checkout', wt('big'), 'feat/big')
      const inTree = (args: string[], input?: string) =>
        execFileSync('git', args, { cwd: wt('big'), input, encoding: 'utf8', maxBuffer: 1 << 30 }).trim()
      inTree(['read-tree', 'HEAD'])
      inTree(['update-index', '-z', '--skip-worktree', '--stdin'], inTree(['ls-files', '-z', '--', 'p']))
      inTree(['checkout-index', '-a'])
      expect(inTree(['ls-files', '--', 'p']).split('\n')).toHaveLength(130_000)
      // An ignored node_modules linked out of it, in that same top folder.
      const target = outside('big')
      const link = path.join(wt('big'), 'p', 'node_modules')
      fs.mkdirSync(path.dirname(link), { recursive: true })
      linkDir(target, link)
      expect(inTree(['status', '--porcelain'])).toBe('')
      const t = done('big', 'feat/big')

      const r = await delTrees(t.id, 'feat/big', sha)
      expect(r).toMatchObject({ ok: true, outcome: 'deleted', reason: null })
      expect(r.unlinked.map((l) => path.resolve(l.path))).toEqual([link])
      expect(fs.existsSync(wt('big'))).toBe(false)
      expect(kept(target)).toBe('big')
      expect(hasRef(repo, 'refs/heads/feat/big')).toBe(false)
    },
  )
})

describe('never deletes what is protected', () => {
  const refused = async (ticketId: number, branch: string, kind: DeleteItem['kind'], why: RegExp) => {
    const before = git(
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
    )
    const b = (await branchOf(ticketId, branch))!
    const sha = (kind === 'remote' ? b.remote : b.local) ?? null
    const [r] = await del([{ ticketId, branch, kind, sha, worktrees: b.worktrees.map((w) => w.path) }])
    expect(r).toMatchObject({ ok: false, outcome: 'refused' })
    expect(r!.reason).toMatch(why)
    expect(
      git(
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        `refs/heads/${branch}`,
        `refs/remotes/origin/${branch}`,
      ),
    ).toBe(before)
  }

  it('the repo’s base branch, also when a closed ticket worked on it', async () => {
    const t = done('on main', 'main', { baseBranch: 'main' })
    for (const kind of ['local', 'remote', 'worktrees'] as const)
      await refused(t.id, 'main', kind, /base branch/)
  })

  it('a branch a ticket in work stands on, uses, or has a workspace on', async () => {
    land(['feat/b6-base', 'feat/b6-used', 'feat/b6-ws'])
    git('push', '-q', 'origin', 'feat/b6-base', 'feat/b6-used', 'feat/b6-ws')
    const open = features.createTicket(
      projectId,
      { title: 'open', branch: 'feat/b6-open', baseBranch: 'feat/b6-base', status: 'in_progress' },
      'claude',
    )
    features.createTicket(
      projectId,
      { title: 'open too', branch: 'feat/b6-used', status: 'in_progress' },
      'claude',
    )
    features.addWorkspace(open.id, { name: 'ui', branch: 'feat/b6-ws' }, 'claude')
    await refused(
      done('base', 'feat/b6-base').id,
      'feat/b6-base',
      'remote',
      new RegExp(`base of #${open.id}`),
    )
    await refused(done('used', 'feat/b6-used').id, 'feat/b6-used', 'local', /in use by #/)
    await refused(done('ws', 'feat/b6-ws').id, 'feat/b6-ws', 'local', new RegExp(`in use by #${open.id}`))
  })

  it('origin’s default branch, and the head of an open PR', async () => {
    land(['feat/b6-def', 'feat/b6-pr'])
    git('push', '-q', 'origin', 'feat/b6-def')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat/b6-def')
    try {
      await refused(done('def', 'feat/b6-def').id, 'feat/b6-def', 'local', /origin's default branch/)
    } finally {
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    }
    const now = new Date().toISOString()
    dbm.db
      .insert(dbm.schema.prs)
      .values({
        projectId,
        repoId,
        number: 42,
        title: 'pr',
        url: 'https://example.invalid/pr/42',
        author: 'enrique',
        headRef: 'feat/b6-pr',
        baseRef: 'main',
        headSha: git('rev-parse', 'feat/b6-pr'),
        updatedAt: now,
        fetchedAt: now,
      })
      .run()
    await refused(done('pr', 'feat/b6-pr').id, 'feat/b6-pr', 'local', /open PR #42/)
  })

  it('the main checkout and its branch', async () => {
    const shas = land(['feat/b4', 'feat/b4-free'])
    const t = done('b4', 'feat/b4')
    git('symbolic-ref', 'HEAD', 'refs/heads/feat/b4')
    try {
      await refused(t.id, 'feat/b4', 'local', /checked out in the main checkout/)
      await refused(t.id, 'feat/b4', 'worktrees', /checked out in the main checkout/)
    } finally {
      git('symbolic-ref', 'HEAD', 'refs/heads/main')
    }
    // Asked to remove the main checkout along with a branch it does not even hold.
    const free = done('b4 free', 'feat/b4-free')
    const [r] = await del([
      {
        ticketId: free.id,
        branch: 'feat/b4-free',
        kind: 'worktrees',
        sha: shas['feat/b4-free']!,
        worktrees: [repo],
      },
    ])
    expect(r).toMatchObject({ outcome: 'refused', reason: 'the main checkout is never removed' })
    expect(() => git('status', '--porcelain')).not.toThrow()
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true)
    expect(hasRef(repo, 'refs/heads/feat/b4-free')).toBe(true)
  })

  it('the main checkout in the middle of a rebase says so, and keeps its branch', async () => {
    // Another commit beside it adding the same file: the rebase onto it stops on the conflict.
    land(['rb-onto'], { unique: true, files: [{ path: 'feat-rb.txt', data: 'other\n' }] })
    land(['feat/rb'], { unique: true })
    git('checkout', '-q', 'feat/rb')
    try {
      expect(() => git('rebase', 'rb-onto')).toThrow()
      const t = done('rb', 'feat/rb')
      const why = /^checked out in the main checkout \(rebase in progress\)$/
      await refused(t.id, 'feat/rb', 'local', why)
      await refused(t.id, 'feat/rb', 'worktrees', why)
    } finally {
      try {
        git('rebase', '--abort')
      } catch {
        // No rebase was left in progress.
      }
      git('checkout', '-q', 'main')
    }
    expect(hasRef(repo, 'refs/heads/feat/rb')).toBe(true)
  })

  it('a worktree another project reads as its repo', async () => {
    const { 'feat/b4wt': sha } = land(['feat/b4wt'])
    git('worktree', 'add', '-q', wt('b4wt'), 'feat/b4wt')
    const pid = dbm.db.insert(dbm.schema.projects).values({ name: 'reads a worktree' }).returning().get().id
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'wt', repoPath: wt('b4wt'), baseBranch: 'main' })
      .run()
    const t = done('b4 worktree', 'feat/b4wt')
    const b = (await branchOf(t.id, 'feat/b4wt'))!
    expect(b.worktrees[0]!.protected).toBe("a repo's checkout on the board")
    const [r] = await del([
      {
        ticketId: t.id,
        branch: 'feat/b4wt',
        kind: 'worktrees',
        sha,
        worktrees: b.worktrees.map((w) => w.path),
      },
    ])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/checkout on the board/) })
    expect(fs.existsSync(wt('b4wt'))).toBe(true)
    expect(hasRef(repo, 'refs/heads/feat/b4wt')).toBe(true)
  })

  it('a ticket that is not closed any more', async () => {
    const { 'feat/b6-reopened': sha } = land(['feat/b6-reopened'])
    const t = done('reopened', 'feat/b6-reopened')
    features.updateTicket(t.id, { status: 'in_progress' }, 'claude')
    const [r] = await del([{ ticketId: t.id, branch: 'feat/b6-reopened', kind: 'local', sha }])
    expect(r).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/not done, cancelled or archived/),
    })
    expect(hasRef(repo, 'refs/heads/feat/b6-reopened')).toBe(true)
  })
})

describe('protects the same repository and origin, however a project reaches them', () => {
  const now = new Date().toISOString()
  const openPr = (pid: number, rid: number, number: number, headRef: string) =>
    dbm.db
      .insert(dbm.schema.prs)
      .values({
        projectId: pid,
        repoId: rid,
        number,
        title: headRef,
        url: `https://example.invalid/pr/${number}`,
        author: 'enrique',
        headRef,
        baseRef: 'main',
        headSha: git('rev-parse', headRef),
        updatedAt: now,
        fetchedAt: now,
      })
      .run()
  const projectAt = (name: string, repoPath: string) => {
    const pid = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
    const rid = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name, repoPath, baseBranch: 'main' })
      .returning()
      .get().id
    return { pid, rid }
  }

  it('a branch in use where another project reads the repo through a linked worktree', async () => {
    // A fresh branch on origin: merged, so nothing but the guard keeps it.
    git('branch', 'feat/f1-shared', 'main')
    git('push', '-q', 'origin', 'feat/f1-shared', 'main')
    const open = features.createTicket(
      projectId,
      { title: 'f1 open', branch: 'feat/f1-shared', status: 'in_progress' },
      'claude',
    )
    openPr(projectId, repoId, 51, 'feat/f1-shared')
    git('worktree', 'add', '-q', '--detach', wt('f1b'), 'main')
    const b = projectAt('reads a linked worktree', wt('f1b'))
    const t = features.createTicket(
      b.pid,
      { title: 'f1 done', branch: 'feat/f1-shared', status: 'done' },
      'claude',
    )
    const sha = git('rev-parse', 'feat/f1-shared')
    const results = await deleteLeftovers(
      b.pid,
      [
        { ticketId: t.id, branch: 'feat/f1-shared', kind: 'local', sha },
        { ticketId: t.id, branch: 'feat/f1-shared', kind: 'remote', sha },
      ],
      'enrique',
    )
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['refused', `in use by #${open.id}`],
      ['refused', `in use by #${open.id}`],
    ])
    expect(hasRef(repo, 'refs/heads/feat/f1-shared')).toBe(true)
    expect(hasRef(origin, 'refs/heads/feat/f1-shared')).toBe(true)
  })

  it('one deletion at a time in a repository, whichever worktree each project reads it through', async () => {
    const { 'feat/f1-race': sha } = land(['feat/f1-race'])
    git('worktree', 'add', '-q', '--detach', wt('f1r'), 'main')
    const b = projectAt('races through a worktree', wt('f1r'))
    const here = done('f1 race here', 'feat/f1-race')
    const there = features.createTicket(
      b.pid,
      { title: 'f1 race there', branch: 'feat/f1-race', status: 'done' },
      'claude',
    )
    const both = await Promise.all([
      del([{ ticketId: here.id, branch: 'feat/f1-race', kind: 'local', sha }]),
      deleteLeftovers(b.pid, [{ ticketId: there.id, branch: 'feat/f1-race', kind: 'local', sha }], 'enrique'),
    ])
    expect(both.map(([r]) => r!.outcome).sort()).toEqual(['deleted', 'gone'])
    expect(hasRef(repo, 'refs/heads/feat/f1-race')).toBe(false)
  })

  it('origin’s copy of a branch in use in another clone of the same origin', async () => {
    const { 'feat/f1-clone': sha } = land(['feat/f1-clone'])
    git('push', '-q', 'origin', 'feat/f1-clone', 'main')
    const c = projectAt('another clone', other)
    const open = features.createTicket(
      c.pid,
      { title: 'f1 elsewhere', branch: 'feat/f1-clone', status: 'in_progress' },
      'claude',
    )
    const t = done('f1 clone', 'feat/f1-clone')
    const b = (await branchOf(t.id, 'feat/f1-clone'))!
    // That clone's branches are its own: this one's local branch may go.
    expect(b.can.local.ok).toBe(true)
    expect(b.can.remote).toEqual({ ok: false, reason: `in use by #${open.id} (another clone of origin)` })
    const [r] = await del([{ ticketId: t.id, branch: 'feat/f1-clone', kind: 'remote', sha }])
    expect(r).toMatchObject({ outcome: 'refused', reason: `in use by #${open.id} (another clone of origin)` })
    expect(hasRef(origin, 'refs/heads/feat/f1-clone')).toBe(true)
  })

  it('origin’s copy against origin’s base, never a local branch named like it', async () => {
    // Merged into main here, which origin has not got yet.
    const { 'feat/f2': sha } = land(['feat/f2'])
    git('push', '-q', 'origin', 'feat/f2')
    git('branch', 'origin/main', 'main')
    try {
      const t = done('f2', 'feat/f2')
      const b = (await branchOf(t.id, 'feat/f2'))!
      expect(b.remoteReach).toMatchObject({ state: 'unique', into: 'origin/main' })
      const [r] = await del([{ ticketId: t.id, branch: 'feat/f2', kind: 'remote', sha }])
      expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/not in origin\/main/) })
      expect(hasRef(origin, 'refs/heads/feat/f2')).toBe(true)
    } finally {
      git('update-ref', '-d', 'refs/heads/origin/main')
    }
  })

  it('a detached worktree a ticket in work in another project on the repository claims', async () => {
    // feat/f4a went in squashed, so its own commit is in no base; feat/f4b, in work, is built on it.
    const { 'feat/f4a': c } = land(['feat/f4a'], { unique: true })
    git(
      'update-ref',
      'refs/heads/main',
      git('commit-tree', `${c}^{tree}`, '-p', 'main', '-m', 'f4a, squashed'),
    )
    land(['feat/f4b'], { unique: true, from: c })
    const open = features.createTicket(
      projectId,
      { title: 'f4 open', branch: 'feat/f4b', status: 'in_progress' },
      'claude',
    )
    git('worktree', 'add', '-q', '--detach', wt('f4c'), c)
    git('worktree', 'add', '-q', '--detach', wt('f4view'), 'main')
    const b = projectAt('reads it through a worktree too', wt('f4view'))
    const t = features.createTicket(b.pid, { title: 'f4 done', branch: 'feat/f4a', status: 'done' }, 'claude')
    const branch = (await cleanupReport(b.pid)).tickets
      .find((x) => x.id === t.id)!
      .branches.find((x) => x.name === 'feat/f4a')!
    expect(branch.reach?.state).toMatch(/rebased|edited/)
    expect(branch.worktrees.map((w) => [path.resolve(w.path), w.protected])).toEqual([
      [wt('f4c'), `also at the work of #${open.id}`],
    ])
    const [r] = await deleteLeftovers(
      b.pid,
      [
        {
          ticketId: t.id,
          branch: 'feat/f4a',
          kind: 'worktrees',
          sha: c,
          worktrees: branch.worktrees.map((w) => w.path),
        },
      ],
      'enrique',
    )
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/also at the work of/) })
    expect(fs.existsSync(wt('f4c'))).toBe(true)
  })
})

describe('a repository moved, with a link left at its old path', () => {
  // Git lists a worktree made before the move by its old path, through the link; the board knows it
  // by the real one: a workspace registered there, a preview the board runs from there.
  const before = path.join(tmp, 'moved-from')
  const after = path.join(tmp, 'moved-to')
  const main = path.join(after, 'agent-board')
  const old = (name: string) => path.join(before, `agent-board-${name}`)
  const now = (name: string) => path.join(after, `agent-board-${name}`)
  const there = gitIn(main)
  let pid: number
  let rid: number

  beforeAll(() => {
    const first = path.join(before, 'agent-board')
    fs.mkdirSync(first, { recursive: true })
    const g = gitIn(first)
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    fs.writeFileSync(path.join(first, 'package.json'), JSON.stringify({ name: 'agent-board' }))
    fs.writeFileSync(path.join(first, 'pnpm-lock.yaml'), LOCK)
    fs.writeFileSync(path.join(first, '.gitignore'), 'node_modules\ndata\n')
    g('add', '.')
    g('commit', '-q', '-m', 'base')
    // Each at main's commit: their work landed.
    for (const name of ['s1', 's2', 's4']) {
      g('branch', `feat/${name}`)
      g('worktree', 'add', '-q', old(name), `feat/${name}`)
    }
    fs.renameSync(before, after)
    fs.symlinkSync(after, before, process.platform === 'win32' ? 'junction' : 'dir')
    pid = dbm.db.insert(dbm.schema.projects).values({ name: 'moved' }).returning().get().id
    rid = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'moved', repoPath: main, baseBranch: 'main' })
      .returning()
      .get().id
  })

  const ticket = (title: string, branch: string, status: string) =>
    features.createTicket(pid, { title, branch, status, repoId: rid }, 'claude')
  const branchIn = async (ticketId: number, name: string) =>
    (await cleanupReport(pid)).tickets.find((t) => t.id === ticketId)?.branches.find((b) => b.name === name)
  const listed = () =>
    there('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => path.resolve(l.slice(9)))
  const removeAt = (ticketId: number, name: string, worktrees: string[]) =>
    deleteLeftovers(
      pid,
      [
        {
          ticketId,
          branch: `feat/${name}`,
          kind: 'worktrees',
          sha: there('rev-parse', `feat/${name}`),
          worktrees,
        },
      ],
      'enrique',
    )

  it('lists the worktrees made before the move by their old path', () => {
    expect(listed()).toEqual(expect.arrayContaining([old('s1'), old('s2'), old('s4')]))
  })

  it('never removes a worktree a ticket in work registered by its real path', async () => {
    const t = ticket('s1', 'feat/s1', 'done')
    const open = ticket('s1 other', 'feat/s1-other', 'in_progress')
    features.addWorkspace(open.id, { name: 'theirs', path: now('s1') }, 'claude')
    const b = (await branchIn(t.id, 'feat/s1'))!
    expect(b.worktrees.map((w) => [path.resolve(w.path), w.protected])).toEqual([
      [old('s1'), `registered on #${open.id}`],
    ])
    expect(b.can.worktrees.ok).toBe(false)

    const [r] = await removeAt(
      t.id,
      's1',
      b.worktrees.map((w) => w.path),
    )
    expect(r).toMatchObject({ outcome: 'refused', removed: [] })
    expect(r!.reason).toContain(`registered on #${open.id}`)
    expect(fs.existsSync(path.join(now('s1'), 'package.json'))).toBe(true)
    expect(hasRef(main, 'refs/heads/feat/s1')).toBe(true)
  })

  it('refuses at once, without waiting, while a preview of such a workspace builds there', async () => {
    const mp = await import('./managedPreview')
    const runner = new FakeRunner()
    runner.hold = true
    mp.setPreviewRunner(runner)
    const t = ticket('s2', 'feat/s2', 'done')
    const open = ticket('s2 other', 'feat/s2-other', 'in_progress')
    const ws = features.addWorkspace(open.id, { name: 'theirs', path: now('s2') }, 'claude')
    mp.startPreview(ws.id, 'claude')
    await expect.poll(() => mp.managedPreview(ws.id)?.step, { timeout: 10_000 }).toBe('install')
    try {
      const b = (await branchIn(t.id, 'feat/s2'))!
      expect(b.worktrees[0]!.previews.map((p) => p.workspaceId)).toEqual([ws.id])
      expect(b.worktrees[0]!.protected).toBe(`registered on #${open.id}`)

      const answer = await within(
        removeAt(
          t.id,
          's2',
          b.worktrees.map((w) => w.path),
        ),
        5000,
      )
      expect(answer).toEqual([expect.objectContaining({ outcome: 'refused', removed: [] })])
      expect(mp.managedPreview(ws.id)).toMatchObject({ status: 'building', step: 'install' })
      expect(fs.existsSync(path.join(now('s2'), 'package.json'))).toBe(true)
      expect(hasRef(main, 'refs/heads/feat/s2')).toBe(true)
    } finally {
      await mp.stopPreview(ws.id, 'test over', 'enrique')
      runner.release()
      await mp.previewsSettled(() => true)
    }
  })

  it('forgets the closed ticket’s own workspace registered by the real path once it removes it', async () => {
    const t = ticket('s4', 'feat/s4', 'done')
    features.addWorkspace(t.id, { name: 'mine', branch: 'feat/s4', path: now('s4') }, 'claude')
    const b = (await branchIn(t.id, 'feat/s4'))!
    expect(b.can.worktrees).toEqual({ ok: true, reason: null })

    const [r] = await removeAt(
      t.id,
      's4',
      b.worktrees.map((w) => w.path),
    )
    expect(r).toMatchObject({ outcome: 'deleted' })
    expect(fs.existsSync(now('s4'))).toBe(false)
    expect(
      dbm.db.select().from(dbm.schema.workspaces).where(eq(dbm.schema.workspaces.ticketId, t.id)).all(),
    ).toEqual([])
  })
})

describe('a repo it cannot be sure of', () => {
  it('refuses every item in a repo git cannot read, instead of calling it gone', async () => {
    const dir = path.join(tmp, 'not-a-repo')
    fs.mkdirSync(dir)
    const pid = dbm.db.insert(dbm.schema.projects).values({ name: 'broken' }).returning().get().id
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: pid, name: 'nope', repoPath: dir, baseBranch: 'main' })
      .run()
    const t = features.createTicket(pid, { title: 'x', branch: 'feat/x', status: 'done' }, 'claude')
    const [r] = await deleteLeftovers(
      pid,
      [{ ticketId: t.id, branch: 'feat/x', kind: 'local', sha: null }],
      'enrique',
    )
    expect(r).toMatchObject({
      ok: false,
      outcome: 'refused',
      reason: expect.stringMatching(/git cannot read/),
    })
  })

  it('refuses a ticket that names no repo in a project with several', async () => {
    const { 'feat/b6-norepo': sha } = land(['feat/b6-norepo'])
    const pid = dbm.db.insert(dbm.schema.projects).values({ name: 'two repos' }).returning().get().id
    for (const name of ['a', 'b'])
      dbm.db
        .insert(dbm.schema.repos)
        .values({ projectId: pid, name, repoPath: repo, baseBranch: 'main' })
        .run()
    const t = dbm.db
      .insert(dbm.schema.tickets)
      .values({
        projectId: pid,
        title: 'no repo',
        branch: 'feat/b6-norepo',
        status: 'done',
        baseBranch: 'main',
        createdBy: 'claude',
      })
      .returning()
      .get()
    const [r] = await deleteLeftovers(
      pid,
      [{ ticketId: t.id, branch: 'feat/b6-norepo', kind: 'local', sha }],
      'enrique',
    )
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/names no repo/) })
    expect(hasRef(repo, 'refs/heads/feat/b6-norepo')).toBe(true)
  })

  it('deletes nothing on a preview’s copy of the live data', async () => {
    const { deleteOff } = await import('./cleanup')
    const { readAuthMode } = await import('./config')
    expect(deleteOff(readAuthMode({ BOARD_ENV: 'development', AUTH: 'off' }))).toMatch(/preview/)
    expect(deleteOff(readAuthMode({ BOARD_ENV: 'development' }))).toMatch(/preview/)
    expect(deleteOff(readAuthMode({}))).toBeNull()
    expect(deleteOff(readAuthMode({ BOARD_ENV: 'test' }))).toBeNull()
  })
})

describe('the route', () => {
  const call = async (actor: string, body: unknown) => {
    const { api } = await import('./api')
    const { api: guard } = await import('./http')
    const { callerOf } = await import('./auth')
    const request = new Request(`http://localhost/api/projects/${projectId}/cleanup/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-actor': actor },
      body: JSON.stringify(body),
    })
    const caller = await callerOf(request)
    return guard(({ request: r, actor: a }: { request: Request; actor: string }) => api.handle(r, a))({
      request,
      actor: caller!.name,
    })
  }

  it('answers an agent 403 and deletes nothing; the human gets each item’s outcome', async () => {
    const { 'feat/b11': sha } = land(['feat/b11'])
    const t = done('b11', 'feat/b11')
    const items = [{ ticketId: t.id, branch: 'feat/b11', kind: 'local', sha }]
    const agent = await call('agent:claude', { items })
    expect(agent.status).toBe(403)
    expect(hasRef(repo, 'refs/heads/feat/b11')).toBe(true)

    const bad = await call('human:enrique', { items: [{ ...items[0], sha: 'HEAD' }] })
    expect(bad.status).toBe(400)
    const human = await call('human:enrique', { items })
    expect(human.status).toBe(200)
    expect(await human.json()).toEqual([expect.objectContaining({ branch: 'feat/b11', outcome: 'deleted' })])
    expect(hasRef(repo, 'refs/heads/feat/b11')).toBe(false)
  })

  it('no MCP tool deletes a branch or a worktree', async () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'mcp.ts'), 'utf8')
    expect(source).not.toMatch(
      /cleanupActions|deleteLeftovers|deleteLocalBranch|deleteOriginBranch|removeWorktree/,
    )
  })
})

describe('a repository or another worktree inside the worktree', () => {
  // Kept in an ignored folder of the worktree, as some agents keep their worktrees.
  beforeAll(() => fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.worktrees/\n'))
  const item = (ticketId: number, branch: string, sha: string, worktrees: string[]): DeleteItem => ({
    ticketId,
    branch,
    kind: 'worktrees',
    sha,
    worktrees,
  })

  it('keeps one holding a worktree registered on a ticket in work, and that worktree’s changes', async () => {
    const { 'feat/n1': sha } = land(['feat/n1'])
    git('branch', 'feat/n1-lane', 'main')
    git('worktree', 'add', '-q', wt('n1'), 'feat/n1')
    const lane = path.join(wt('n1'), '.worktrees', 'lane')
    gitIn(wt('n1'))('worktree', 'add', '-q', lane, 'feat/n1-lane')
    fs.writeFileSync(path.join(lane, 'lane-notes.txt'), 'uncommitted\n')
    fs.appendFileSync(path.join(lane, 'package.json'), '\n')
    expect(gitIn(wt('n1'))('status', '--porcelain')).toBe('')
    const t = done('n1', 'feat/n1')
    const open = features.createTicket(
      projectId,
      { title: 'n1 lane', branch: 'feat/n1-lane', status: 'in_progress' },
      'claude',
    )
    features.addWorkspace(open.id, { name: 'lane', branch: 'feat/n1-lane', path: lane }, 'claude')

    const b = (await branchOf(t.id, 'feat/n1'))!
    expect(b.worktrees.map((w) => w.protected)).toEqual([
      expect.stringContaining(`registered on #${open.id}, is in it`),
    ])
    expect(b.can.worktrees.ok).toBe(false)
    const [r] = await del([item(t.id, 'feat/n1', sha, [wt('n1')])])
    expect(r).toMatchObject({ outcome: 'refused', removed: [] })
    expect(r!.reason).toContain(`registered on #${open.id}`)
    expect(fs.readFileSync(path.join(lane, 'lane-notes.txt'), 'utf8')).toBe('uncommitted\n')
    expect(gitIn(lane)('status', '--porcelain')).toContain('package.json')
    expect(git('rev-parse', 'refs/heads/feat/n1')).toBe(sha)
  })

  it('keeps one holding another worktree of the repository, registered nowhere', async () => {
    const { 'feat/n2': sha } = land(['feat/n2'])
    git('worktree', 'add', '-q', wt('n2'), 'feat/n2')
    const inner = path.join(wt('n2'), '.worktrees', 'review')
    git('worktree', 'add', '-q', '--detach', inner, 'main')
    const t = done('n2', 'feat/n2')

    const b = (await branchOf(t.id, 'feat/n2'))!
    expect(b.worktrees[0]!.protected).toMatch(/^the worktree .*review is in it$/)
    const [r] = await del([item(t.id, 'feat/n2', sha, [wt('n2')])])
    expect(r).toMatchObject({ outcome: 'refused', removed: [] })
    expect(fs.existsSync(path.join(inner, 'package.json'))).toBe(true)
  })

  it('keeps one holding a repository of its own, and that repository', async () => {
    const { 'feat/n3': sha } = land(['feat/n3'])
    git('worktree', 'add', '-q', wt('n3'), 'feat/n3')
    const inner = path.join(wt('n3'), '.worktrees', 'scratch')
    fs.mkdirSync(inner, { recursive: true })
    const g = gitIn(inner)
    g('init', '-q')
    fs.writeFileSync(path.join(inner, 'only-here.txt'), 'only here\n')
    g('add', '.')
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'only here')
    const head = g('rev-parse', 'HEAD')
    const t = done('n3', 'feat/n3')

    const b = (await branchOf(t.id, 'feat/n3'))!
    const [r] = await del([
      item(
        t.id,
        'feat/n3',
        sha,
        b.worktrees.map((w) => w.path),
      ),
    ])
    expect(r).toMatchObject({ outcome: 'refused', removed: [], unlinked: [] })
    expect(r!.reason).toContain(path.join('.worktrees', 'scratch'))
    expect(r!.reason).toMatch(/a git repository or worktree .*\(a \.git of its own\)/)
    expect(g('rev-parse', 'HEAD')).toBe(head)
    expect(fs.readFileSync(path.join(inner, 'only-here.txt'), 'utf8')).toBe('only here\n')
    expect(git('rev-parse', 'refs/heads/feat/n3')).toBe(sha)
  })

  it('keeps one holding a worktree of another repository', async () => {
    const { 'feat/n4': sha } = land(['feat/n4'])
    git('worktree', 'add', '-q', wt('n4'), 'feat/n4')
    const elsewhere = path.join(tmp, 'n4-elsewhere')
    fs.mkdirSync(elsewhere)
    const e = gitIn(elsewhere)
    e('init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(elsewhere, 'a.txt'), 'a\n')
    e('add', '.')
    e('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
    const side = path.join(wt('n4'), '.worktrees', 'side')
    e('worktree', 'add', '-q', '-b', 'side', side)
    fs.writeFileSync(path.join(side, 'a.txt'), 'edited\n')
    const t = done('n4', 'feat/n4')

    const b = (await branchOf(t.id, 'feat/n4'))!
    const [r] = await del([
      item(
        t.id,
        'feat/n4',
        sha,
        b.worktrees.map((w) => w.path),
      ),
    ])
    expect(r).toMatchObject({ outcome: 'refused', removed: [] })
    expect(r!.reason).toContain(path.join('.worktrees', 'side'))
    expect(fs.readFileSync(path.join(side, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(git('rev-parse', 'refs/heads/feat/n4')).toBe(sha)
  })

  it('keeps one holding a bare clone of its own, and the clone', async () => {
    const { 'feat/n5': sha } = land(['feat/n5'])
    git('worktree', 'add', '-q', wt('n5'), 'feat/n5')
    const inner = path.join(wt('n5'), '.worktrees', 'mirror.git')
    execFileSync('git', ['clone', '-q', '--bare', repo, inner], { stdio: 'ignore' })
    const t = done('n5', 'feat/n5')

    const b = (await branchOf(t.id, 'feat/n5'))!
    const [r] = await del([
      item(
        t.id,
        'feat/n5',
        sha,
        b.worktrees.map((w) => w.path),
      ),
    ])
    expect(r).toMatchObject({ outcome: 'refused', removed: [], unlinked: [] })
    expect(r!.reason).toContain(path.join('.worktrees', 'mirror.git'))
    expect(r!.reason).toMatch(
      /a git repository or worktree .*\(a bare repository, with no \.git of its own\)/,
    )
    expect(fs.existsSync(path.join(inner, 'HEAD'))).toBe(true)
    expect(git('rev-parse', 'refs/heads/feat/n5')).toBe(sha)
  })
})

describe('a branch whose patches are in the base but its content is not', () => {
  // Made by git itself, in a worktree of its own: the repo has main checked out.
  const scratch = path.join(tmp, 'rebased-scratch')
  const s = gitIn(scratch)
  const write = (file: string, text: string) => fs.writeFileSync(path.join(scratch, file), text)
  const commit = (message: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) write(file, text)
    s('add', '--', ...Object.keys(files))
    s('commit', '-q', '-m', message)
    return s('rev-parse', 'HEAD')
  }
  /** Starts `branch` at main, in the scratch worktree. */
  const branchOff = (branch: string) => s('checkout', '-q', '-b', branch, 'main')
  /** Main moves to what the scratch worktree has checked out, which then leaves its branch. */
  const mainHere = () => {
    git('update-ref', 'refs/heads/main', s('rev-parse', 'HEAD'))
    s('checkout', '-q', '--detach', 'main')
  }
  const why = (base: string) => `its patches match ${base} but its content does not`

  beforeAll(() => git('worktree', 'add', '-q', '--detach', scratch, 'main'))
  afterAll(() => git('worktree', 'remove', '--force', scratch))

  it('keeps one whose fix was made in a merge commit the base never took, here and on origin', async () => {
    branchOff('feat/r1')
    const work = commit('r1 work', { 'r1.txt': 'work\n' })
    s('checkout', '-q', '--detach', 'main')
    commit('r1 meanwhile on main', { 'r1-main.txt': 'main\n' })
    mainHere()
    s('checkout', '-q', 'feat/r1')
    s('merge', '-q', '--no-commit', 'main')
    write('r1-fix.txt', 'the fix, made in the merge\n')
    s('add', 'r1-fix.txt')
    s('commit', '-q', '-m', 'merge main, fixing the build')
    const sha = s('rev-parse', 'HEAD')
    // Main takes the branch's commit alone (cherry-picked, or a rebase merge): the merge's fix stays out.
    s('checkout', '-q', '--detach', 'main')
    s('cherry-pick', work)
    mainHere()
    git('push', '-q', 'origin', 'main', 'feat/r1')
    expect(git('diff', 'main', 'feat/r1', '--name-only')).toBe('r1-fix.txt')
    const t = done('r1', 'feat/r1')

    const b = (await branchOf(t.id, 'feat/r1'))!
    expect(b.reach?.state).toBe('rebased')
    expect(b.remoteReach?.state).toBe('rebased')
    expect(b.can.local).toEqual({ ok: false, reason: expect.stringContaining(why('main')) })
    expect(b.can.remote).toEqual({ ok: false, reason: expect.stringContaining(why('origin/main')) })
    const [local, remote] = await del([
      { ticketId: t.id, branch: 'feat/r1', kind: 'local', sha },
      { ticketId: t.id, branch: 'feat/r1', kind: 'remote', sha },
    ])
    expect(local).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(why('main')) })
    expect(remote).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(why('origin/main')) })
    expect(git('rev-parse', 'refs/heads/feat/r1')).toBe(sha)
    expect(hasRef(origin, 'refs/heads/feat/r1')).toBe(true)

    git('worktree', 'add', '-q', wt('r1'), 'feat/r1')
    const withTree = (await branchOf(t.id, 'feat/r1'))!
    expect(withTree.can.worktrees).toEqual({ ok: false, reason: expect.stringContaining(why('main')) })
    const [trees] = await del([
      { ticketId: t.id, branch: 'feat/r1', kind: 'worktrees', sha, worktrees: [wt('r1')] },
    ])
    expect(trees).toMatchObject({ outcome: 'refused', removed: [] })
    expect(fs.existsSync(wt('r1'))).toBe(true)
    expect(git('rev-parse', 'refs/heads/feat/r1')).toBe(sha)
  })

  it('keeps one amended in whitespace alone after the base took its commit', async () => {
    branchOff('feat/r2')
    const work = commit('r2 add g', { 'r2.py': 'def g(x):\n    if x:\n        pass\n    return 1\n' })
    s('checkout', '-q', '--detach', 'main')
    s('cherry-pick', work)
    mainHere()
    s('checkout', '-q', 'feat/r2')
    // Indentation alone, which patch ids do not see: in Python, another program.
    write('r2.py', 'def g(x):\n    if x:\n        pass\n        return 1\n')
    s('commit', '-q', '--amend', '-a', '-m', 'r2 add g')
    const sha = s('rev-parse', 'HEAD')
    s('checkout', '-q', '--detach', 'main')
    const t = done('r2', 'feat/r2')

    const b = (await branchOf(t.id, 'feat/r2'))!
    expect(b.reach?.state).toBe('rebased')
    expect(b.can.local).toEqual({ ok: false, reason: expect.stringContaining(why('main')) })
    const [r] = await del([{ ticketId: t.id, branch: 'feat/r2', kind: 'local', sha }])
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(why('main')) })
    expect(git('rev-parse', 'refs/heads/feat/r2')).toBe(sha)
  })

  it('still deletes one whose commits the base took with the same content', async () => {
    branchOff('feat/r3')
    const work = commit('r3 work', { 'r3.txt': 'work\n' })
    s('checkout', '-q', '--detach', 'main')
    commit('r3 meanwhile on main', { 'r3-main.txt': 'main\n' })
    s('cherry-pick', work)
    mainHere()
    const t = done('r3', 'feat/r3')

    const b = (await branchOf(t.id, 'feat/r3'))!
    expect(b.reach?.state).toBe('rebased')
    expect(b.can.local).toEqual({ ok: true, reason: null })
    const [r] = await del([{ ticketId: t.id, branch: 'feat/r3', kind: 'local', sha: work }])
    expect(r).toMatchObject({ outcome: 'deleted' })
    expect(hasRef(repo, 'refs/heads/feat/r3')).toBe(false)
  })
})

describe('a branch a rebase or a bisect in its worktree is on', () => {
  // `git rebase -i` stops at its first commit, as with `edit` typed in the editor.
  const editor = path.join(tmp, 'edit-first.cjs')
  fs.writeFileSync(
    editor,
    "const fs = require('fs')\nconst f = process.argv[2]\nfs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^pick /, 'edit '))\n",
  )
  const fwd = (p: string) => p.replace(/\\/g, '/')
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_SEQUENCE_EDITOR: `"${fwd(process.execPath)}" "${fwd(editor)}"`,
        GIT_EDITOR: 'true',
      },
    }).trim()
  /** What the Cleanup page offers for it, and what each delete answers; the branch is kept. */
  const refusedWhile = async (branch: string, tree: string, busy: string) => {
    const t = done(branch, branch)
    const sha = git('rev-parse', `refs/heads/${branch}`)
    const b = (await branchOf(t.id, branch))!
    expect(b.worktrees.map((w) => [path.resolve(w.path), w.protected])).toEqual([[tree, busy]])
    expect(b.can.local).toEqual({ ok: false, reason: `checked out in ${b.worktrees[0]!.path} (${busy})` })
    expect(b.can.worktrees.ok).toBe(false)
    const [local, trees] = await del([
      { ticketId: t.id, branch, kind: 'local', sha },
      { ticketId: t.id, branch, kind: 'worktrees', sha, worktrees: [tree] },
    ])
    expect(local).toMatchObject({ outcome: 'refused', reason: expect.stringContaining(busy) })
    expect(trees).toMatchObject({ outcome: 'refused', removed: [] })
    expect(git('rev-parse', `refs/heads/${branch}`)).toBe(sha)
    expect(fs.existsSync(tree)).toBe(true)
  }

  it('keeps one stopped on a conflict, and the rebase goes on afterwards', async () => {
    // Another commit beside it adding the same file: the rebase onto it stops on the conflict.
    land(['q1-onto'], { unique: true, files: [{ path: 'feat-q1.txt', data: 'other\n' }] })
    land(['feat/q1'])
    git('worktree', 'add', '-q', wt('q1'), 'feat/q1')
    expect(() => run(wt('q1'), 'rebase', 'q1-onto')).toThrow()
    expect(git('worktree', 'list', '--porcelain')).toMatch(/agent-board-q1\nHEAD \w+\ndetached/)

    await refusedWhile('feat/q1', wt('q1'), 'rebase in progress')
    fs.writeFileSync(path.join(wt('q1'), 'feat-q1.txt'), 'resolved\n')
    run(wt('q1'), 'add', 'feat-q1.txt')
    run(wt('q1'), 'rebase', '--continue')
    expect(run(wt('q1'), 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat/q1')
  })

  it('keeps one stopped at an edit of rebase -i, and the rebase goes on afterwards', async () => {
    const { 'feat/q2': sha } = land(['feat/q2'])
    git('worktree', 'add', '-q', wt('q2'), 'feat/q2')
    run(wt('q2'), 'rebase', '-i', `${sha}~1`)
    expect(run(wt('q2'), 'rev-parse', 'HEAD')).toBe(sha)
    expect(git('worktree', 'list', '--porcelain')).toMatch(/agent-board-q2\nHEAD \w+\ndetached/)

    await refusedWhile('feat/q2', wt('q2'), 'rebase in progress')
    run(wt('q2'), 'rebase', '--continue')
    expect(run(wt('q2'), 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat/q2')
  })

  it('keeps one a bisect started on', async () => {
    for (const n of [1, 2, 3]) land([`feat/q3-${n}`])
    const { 'feat/q3': sha } = land(['feat/q3'])
    git('worktree', 'add', '-q', wt('q3'), 'feat/q3')
    run(wt('q3'), 'bisect', 'start', sha, `${sha}~4`)
    expect(git('worktree', 'list', '--porcelain')).toMatch(/agent-board-q3\nHEAD \w+\ndetached/)

    await refusedWhile('feat/q3', wt('q3'), 'bisect in progress')
    run(wt('q3'), 'bisect', 'reset')
    expect(run(wt('q3'), 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat/q3')
  })

  it('keeps one named refs/… that a bisect started on, as git names it', async () => {
    for (const n of [1, 2, 3]) land([`feat/q5-${n}`])
    const { 'refs/q5': sha } = land(['refs/q5'])
    // Named without `heads/`: a full refname would make git add the worktree detached.
    git('worktree', 'add', '-q', wt('q5'), 'refs/q5')
    expect(run(wt('q5'), 'symbolic-ref', 'HEAD')).toBe('refs/heads/refs/q5')
    run(wt('q5'), 'bisect', 'start', sha, `${sha}~4`)
    expect(git('worktree', 'list', '--porcelain')).toMatch(/agent-board-q5\nHEAD \w+\ndetached/)

    await refusedWhile('refs/q5', wt('q5'), 'bisect in progress')
    run(wt('q5'), 'bisect', 'reset')
    expect(run(wt('q5'), 'symbolic-ref', 'HEAD')).toBe('refs/heads/refs/q5')
  })

  it('keeps one a rebase with --update-refs will move, and the rebase goes on afterwards', async () => {
    // feat/q4-base changes a file another commit beside it changes too, so the rebase stops on it. It
    // is not the branch the rebase is on: feat/q4, stacked on it, is, and the rebase moves both.
    land(['q4-onto'], { unique: true, files: [{ path: 'feat-q4-base.txt', data: 'other\n' }] })
    land(['feat/q4-base'], { unique: true })
    land(['feat/q4'], { unique: true, from: 'refs/heads/feat/q4-base' })
    git('worktree', 'add', '-q', wt('q4'), 'feat/q4')
    expect(() => run(wt('q4'), 'rebase', '--update-refs', 'q4-onto')).toThrow()

    await refusedWhile('feat/q4-base', wt('q4'), 'rebase in progress')
    fs.writeFileSync(path.join(wt('q4'), 'feat-q4-base.txt'), 'resolved\n')
    run(wt('q4'), 'add', 'feat-q4-base.txt')
    run(wt('q4'), 'rebase', '--continue')
    expect(run(wt('q4'), 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat/q4')
  })
})

describe('a symbolic ref, a branch that is an alias of another', () => {
  it('is kept, and deleting it never deletes the branch it points at', async () => {
    const sha = git('rev-parse', 'refs/heads/main')
    git('symbolic-ref', 'refs/heads/alias-main', 'refs/heads/main')
    try {
      const t = done('alias', 'alias-main')
      const b = (await branchOf(t.id, 'alias-main'))!
      expect(b.protected).toBe('a symbolic ref to main')
      expect(b.can.local).toEqual({ ok: false, reason: 'a symbolic ref to main' })
      const [r] = await del([{ ticketId: t.id, branch: 'alias-main', kind: 'local', sha }])
      expect(r).toMatchObject({ outcome: 'refused', reason: 'a symbolic ref to main' })
      expect(git('rev-parse', 'refs/heads/main')).toBe(sha)
      expect(hasRef(repo, 'refs/heads/alias-main')).toBe(true)
    } finally {
      git('update-ref', '--no-deref', '-d', 'refs/heads/alias-main')
    }
  })

  it('on origin is refused before the push, and the branch it points at stays', async () => {
    const { 'feat/y2': sha } = land(['feat/y2'])
    git('push', '-q', 'origin', 'main', 'feat/y2:refs/heads/y2-target')
    gitIn(origin)('symbolic-ref', 'refs/heads/alias-y2', 'refs/heads/y2-target')
    git('fetch', '-q', 'origin')
    try {
      const t = done('alias on origin', 'alias-y2')
      const b = (await branchOf(t.id, 'alias-y2'))!
      expect(b.remote).toBe(sha)
      const [r] = await del([{ ticketId: t.id, branch: 'alias-y2', kind: 'remote', sha }])
      expect(r).toMatchObject({ outcome: 'refused', removed: [] })
      expect(r!.reason).toContain('a symbolic ref to y2-target')
      expect(gitIn(origin)('rev-parse', 'refs/heads/y2-target')).toBe(sha)
      expect(gitIn(origin)('symbolic-ref', 'refs/heads/alias-y2')).toBe('refs/heads/y2-target')
    } finally {
      gitIn(origin)('update-ref', '--no-deref', '-d', 'refs/heads/alias-y2')
      gitIn(origin)('update-ref', '-d', 'refs/heads/y2-target')
      git('update-ref', '-d', 'refs/remotes/origin/alias-y2')
    }
  })
})

// Last: it loads the module afresh, as a hot reload of the board's server code does.
describe('a hot reload of the server code', () => {
  it('still takes the deletions in one repository one after the other', async () => {
    const shas = land(['feat/hr1', 'feat/hr2', 'feat/hr3'])
    const items = Object.entries(shas).map(([branch, sha]): DeleteItem => {
      const t = done(branch, branch)
      return { ticketId: t.id, branch, kind: 'local', sha }
    })
    vi.resetModules()
    const reloaded = (await import('./cleanupActions')).deleteLeftovers
    for (const item of items) {
      const both = await Promise.all([del([item]), reloaded(projectId, [item], 'enrique')])
      expect(both.map(([r]) => r!.outcome).sort()).toEqual(['deleted', 'gone'])
      expect(hasRef(repo, `refs/heads/${item.branch}`)).toBe(false)
    }
  })
})
