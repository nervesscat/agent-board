import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
process.env.DATA_DIR = tmp
const origin = path.join(tmp, 'origin.git')
const repo = path.join(tmp, 'repo')
// Someone else's clone, pushing to origin behind the checkout's back.
const other = path.join(tmp, 'other')

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args: string[]) => gitIn(repo, ...args)
const commit = (cwd: string, file: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`)
  gitIn(cwd, 'add', file)
  gitIn(cwd, 'commit', '-q', '-m', msg)
}

/**
 * origin (bare) and a checkout of it with:
 * - feat/pushed: pushed as is
 * - feat/ahead: pushed, then 2 more commits here
 * - feat/local: never pushed (1 commit)
 * - feat/remote: pushed, then the local branch deleted
 * - feat/behind: pushed 2 commits, then reset back one here
 */
beforeAll(() => {
  fs.mkdirSync(origin)
  gitIn(origin, 'init', '-q', '--bare', '-b', 'main')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('remote', 'add', 'origin', origin)
  commit(repo, 'base.txt', 'base')
  git('push', '-q', 'origin', 'main')

  git('checkout', '-q', '-b', 'feat/pushed')
  commit(repo, 'pushed.txt', 'pushed')
  git('push', '-q', 'origin', 'feat/pushed')

  git('checkout', '-q', '-b', 'feat/ahead', 'main')
  commit(repo, 'ahead.txt', 'ahead 1')
  git('push', '-q', 'origin', 'feat/ahead')
  commit(repo, 'ahead.txt', 'ahead 2')
  commit(repo, 'ahead.txt', 'ahead 3')

  git('checkout', '-q', '-b', 'feat/local', 'main')
  commit(repo, 'local.txt', 'local')

  git('checkout', '-q', '-b', 'feat/remote', 'main')
  commit(repo, 'remote.txt', 'remote')
  git('push', '-q', 'origin', 'feat/remote')

  git('checkout', '-q', '-b', 'feat/behind', 'main')
  commit(repo, 'behind.txt', 'behind 1')
  commit(repo, 'behind.txt', 'behind 2')
  git('push', '-q', 'origin', 'feat/behind')
  git('reset', '-q', '--hard', 'HEAD~1')

  git('checkout', '-q', 'main')
  git('branch', '-q', '-D', 'feat/remote')

  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
  gitIn(other, 'config', 'user.email', 'o@o')
  gitIn(other, 'config', 'user.name', 'o')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pushStates', () => {
  it('tells pushed, ahead, local-only, remote-only, behind and missing branches apart', async () => {
    const { fetchRepo, pushStates } = await import('./push')
    await fetchRepo(repo, { force: true })
    const states = await pushStates(repo, [
      'feat/pushed',
      'feat/ahead',
      'feat/local',
      'feat/remote',
      'feat/behind',
      'feat/nowhere',
      '',
    ])
    const checkedAt = states.get('feat/pushed')!.checkedAt
    expect(checkedAt).toEqual(expect.any(String))
    expect(Date.now() - new Date(checkedAt!).getTime()).toBeLessThan(60_000)
    expect(states.get('feat/pushed')).toMatchObject({ state: 'pushed', ahead: 0, behind: 0 })
    expect(states.get('feat/ahead')).toMatchObject({ state: 'ahead', ahead: 2, behind: 0 })
    expect(states.get('feat/local')).toMatchObject({ state: 'local-only', ahead: 1, behind: 0 })
    expect(states.get('feat/remote')).toMatchObject({ state: 'remote-only', ahead: 0, behind: 0 })
    expect(states.get('feat/behind')).toMatchObject({ state: 'pushed', ahead: 0, behind: 1 })
    expect(states.get('feat/nowhere')).toMatchObject({ state: 'none' })
    expect(states.get('')).toEqual({ state: 'none', ahead: 0, behind: 0, checkedAt: null })
  })

  it('reads a checkout that is not there as none', async () => {
    const { pushStates } = await import('./push')
    const states = await pushStates(path.join(tmp, 'gone'), ['feat/pushed'])
    expect(states.get('feat/pushed')?.state).toBe('none')
  })
})

describe('fetchRepo', () => {
  it('fetches origin at most every few minutes, unless forced', async () => {
    const { FETCH_EVERY, fetchRepo, fetchStatus, pushStates } = await import('./push')
    await fetchRepo(repo, { force: true })
    const state = async (b: string) => (await pushStates(repo, [b])).get(b)!.state

    // Someone pushes a branch: the checkout does not know until it fetches.
    gitIn(other, 'checkout', '-q', '-b', 'feat/theirs')
    commit(other, 'theirs.txt', 'theirs')
    gitIn(other, 'push', '-q', 'origin', 'feat/theirs')
    expect(fetchRepo(repo)).toBeNull()
    expect(await state('feat/theirs')).toBe('none')

    // A few minutes on, the next read starts a fetch in the background.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + FETCH_EVERY + 1000)
    const fetching = fetchRepo(repo)
    expect(fetching).not.toBeNull()
    expect(fetchStatus(repo).fetching).toBe(true)
    // A second ask joins it rather than starting another.
    expect(fetchRepo(repo)).toBe(fetching)
    await fetching
    expect(fetchStatus(repo)).toMatchObject({ fetching: false, error: null })
    expect(await state('feat/theirs')).toBe('remote-only')
    expect(fetchRepo(repo)).toBeNull()

    // A forced fetch goes at once; --prune drops what origin deleted.
    gitIn(other, 'push', '-q', 'origin', '--delete', 'feat/theirs')
    await fetchRepo(repo, { force: true })
    expect(await state('feat/theirs')).toBe('none')
  })

  it('keeps a failed fetch as the error, without throwing', async () => {
    const { fetchRepo, fetchStatus } = await import('./push')
    const lonely = path.join(tmp, 'lonely')
    fs.mkdirSync(lonely)
    gitIn(lonely, 'init', '-q')
    await fetchRepo(lonely, { force: true })
    expect(fetchStatus(lonely)).toMatchObject({ fetching: false, checkedAt: null })
    expect(fetchStatus(lonely).error).toEqual(expect.any(String))
  })
})

describe('the board', () => {
  it('serves every ticket in work with its push state, and the ticket views carry it', async () => {
    const { db, schema } = await import('#/db')
    const features = await import('./features')
    const { api } = await import('./api')
    const projectId = db.insert(schema.projects).values({ name: 'p' }).returning().get().id
    const repoId = db
      .insert(schema.repos)
      .values({ projectId, name: 'repo', repoPath: repo, baseBranch: 'main' })
      .returning()
      .get().id
    const ticket = (title: string, branch: string, status = 'in_progress', parentId?: number) =>
      features.createTicket(projectId, { title, branch, status, parentId }, 'claude')
    const ahead = ticket('ahead', 'feat/ahead')
    const lane = ticket('lane', 'feat/pushed', 'review', ahead.id)
    ticket('done', 'feat/local', 'done')
    ticket('no branch', '')
    const archived = ticket('archived', 'feat/remote', 'done')
    features.archiveTicket(archived.id, 'human')
    features.addWorkspace(ahead.id, { name: 'wt', branch: 'feat/local' }, 'claude')

    const res = await api.handle(new Request(`http://board/api/projects/${projectId}/push`), 'claude')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.repos).toEqual([
      { id: repoId, name: 'repo', checkedAt: expect.any(String), fetching: false, error: null },
    ])
    expect(body.tickets).toHaveLength(2)
    expect(body.tickets).toEqual(
      expect.arrayContaining([
        {
          id: ahead.id,
          repoId,
          branch: 'feat/ahead',
          push: { state: 'ahead', ahead: 2, behind: 0, checkedAt: expect.any(String) },
        },
        {
          id: lane.id,
          repoId,
          branch: 'feat/pushed',
          push: { state: 'pushed', ahead: 0, behind: 0, checkedAt: expect.any(String) },
        },
      ]),
    )

    const refreshed = await api.handle(
      new Request(`http://board/api/projects/${projectId}/push/refresh`, { method: 'POST' }),
      'claude',
    )
    expect((await refreshed.json()).tickets).toHaveLength(2)

    const full = await features.getTicketWithPush(ahead.id)
    expect(full.push).toMatchObject({ state: 'ahead', ahead: 2 })
    expect(full.workspaces[0]!.push).toMatchObject({ state: 'local-only', ahead: 1 })
    const g = await features.ticketGit(ahead.id)
    expect(g.info.push).toMatchObject({ state: 'ahead', ahead: 2 })
    expect(g.workspaces[0]!.info.push.state).toBe('local-only')
  })
})
