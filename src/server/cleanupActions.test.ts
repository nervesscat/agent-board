import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
 * A commit adding `<name>.txt` on top of main (or `from`) for each branch, in one git process; main
 * then merges them as is unless `unique`. Returns each branch's sha.
 */
function land(names: string[], opts: { unique?: boolean; from?: string } = {}): Record<string, string> {
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
  private pid = 5000
  spawn(_command: string, _args: string[], opts: { log: string; shell?: boolean }): Proc {
    fs.appendFileSync(opts.log, 'ok\n')
    // Install and build finish at once; the server runs until it is killed.
    return { pid: ++this.pid, exited: opts.shell ? Promise.resolve(0) : new Promise(() => {}) }
  }
  async killTree(pid: number) {
    this.killed.push({ pid, worktreeThere: fs.existsSync(this.watch) })
  }
  killTreeSync() {}
  isFree = async () => true
  answers = async () => true
  copyData = async () => {}
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
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndata/\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })

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

describe('deleting a worked branch on origin', () => {
  it('deletes origin’s copy alone, after fetching, and answers how to put it back', async () => {
    const { 'feat/b2': sha } = land(['feat/b2'])
    git('push', '-q', 'origin', 'feat/b2')
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
    expect(r!.restore[1]).toMatch(/^git worktree add ".+agent-board-b3" feat\/b3$/)
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
