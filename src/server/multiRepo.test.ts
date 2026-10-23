import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-')))
process.env.DATA_DIR = path.join(tmp, 'data')

let features: typeof import('./features')
let dbm: typeof import('#/db')
let projectId: number
let otherProject: number
let front: { id: number; path: string }
let back: { id: number; path: string }
let elsewhere: number

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** A checkout with main and a branch one commit ahead of it. */
function checkout(name: string, branch: string) {
  const dir = path.join(tmp, 'code', name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', branch)
  fs.writeFileSync(path.join(dir, 'b.txt'), `${branch}\n`)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', `work on ${branch}`)
  git(dir, 'checkout', '-q', 'main')
  return dir
}

beforeAll(async () => {
  features = await import('./features')
  dbm = await import('#/db')
  projectId = dbm.db.insert(dbm.schema.projects).values({ name: 'shop' }).returning().get().id
  otherProject = dbm.db.insert(dbm.schema.projects).values({ name: 'other' }).returning().get().id
  const repo = (project: number, name: string, dir: string) =>
    dbm.db.insert(dbm.schema.repos).values({ projectId: project, name, repoPath: dir }).returning().get().id
  const frontPath = checkout('front', 'feat/front')
  const backPath = checkout('back', 'feat/back')
  front = { id: repo(projectId, 'front', frontPath), path: frontPath }
  back = { id: repo(projectId, 'back', backPath), path: backPath }
  elsewhere = repo(otherProject, 'elsewhere', path.join(tmp, 'code', 'front'))
}, 60_000)

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  const request = new Request(`http://localhost${pathname}`, {
    method,
    headers: {
      accept: 'application/json, text/event-stream',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(as === 'agent' ? { authorization: 'Bearer token-of-test' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handle({ request, actor: as === 'agent' ? 'claude' : 'enrique' })
  return { status: res.status, body: (await res.json()) as any }
}
async function tool(name: string, args: Record<string, unknown>) {
  const res = await call(
    'POST',
    '/api/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    'agent',
  )
  const { result } = res.body as { result: { isError?: boolean; content: { text: string }[] } }
  return { error: !!result.isError, text: result.content[0]!.text }
}

const ticket = (data: Record<string, unknown> = {}) =>
  call('POST', `/api/projects/${projectId}/tickets`, { title: 'both repos', status: 'todo', ...data })
const repoRows = (ticketId: number) =>
  dbm.db
    .select()
    .from(dbm.schema.ticketRepos)
    .where(eq(dbm.schema.ticketRepos.ticketId, ticketId))
    .all()
    .sort((a, b) => a.position - b.position)
    .map((r) => [r.repoId, r.branch, r.position])

describe("a ticket's repos", () => {
  it('a new ticket has its repo as its one repo', async () => {
    const t = (await ticket({ repoId: back.id, branch: 'feat/back', prNumber: 4 })).body
    const read = (await call('GET', `/api/tickets/${t.id}`)).body
    expect(read.repos).toEqual([
      { repoId: back.id, name: 'back', branch: 'feat/back', baseBranch: 'main', prNumber: 4, primary: true },
    ])
    expect(repoRows(t.id)).toEqual([[back.id, 'feat/back', 0]])
  })

  it('PATCH repos replaces the list; the first is the ticket’s own repo, branch, base and PR', async () => {
    const t = (await ticket({ repoId: front.id })).body
    const res = await call('PATCH', `/api/tickets/${t.id}`, {
      repos: [
        { repoId: back.id, branch: 'feat/back', prNumber: 9 },
        { repoId: front.id, branch: 'feat/front', baseBranch: 'dev' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ repoId: back.id, branch: 'feat/back', prNumber: 9, baseBranch: 'main' })
    const read = (await call('GET', `/api/tickets/${t.id}`)).body
    expect(read.repos).toEqual([
      { repoId: back.id, name: 'back', branch: 'feat/back', baseBranch: 'main', prNumber: 9, primary: true },
      {
        repoId: front.id,
        name: 'front',
        branch: 'feat/front',
        baseBranch: 'dev',
        prNumber: null,
        primary: false,
      },
    ])
    expect(repoRows(t.id)).toEqual([
      [back.id, 'feat/back', 0],
      [front.id, 'feat/front', 1],
    ])

    // Writing the ticket's own fields writes the primary's; the other keeps its own.
    await call('PATCH', `/api/tickets/${t.id}`, { branch: 'feat/back-2' })
    expect(
      (await call('GET', `/api/tickets/${t.id}`)).body.repos.map((r: { branch: string }) => r.branch),
    ).toEqual(['feat/back-2', 'feat/front'])

    // Refused, and nothing changes: a repo of another project, the same repo twice, none at all.
    for (const repos of [[{ repoId: elsewhere }], [{ repoId: back.id }, { repoId: back.id }], []]) {
      const bad = await call('PATCH', `/api/tickets/${t.id}`, { repos })
      expect(bad.status, JSON.stringify(repos)).toBe(400)
    }
    expect(repoRows(t.id)).toEqual([
      [back.id, 'feat/back-2', 0],
      [front.id, 'feat/front', 1],
    ])
  })

  it('a ticket is created with its repos, the first its primary', async () => {
    const res = await ticket({ repos: [{ repoId: front.id, branch: 'feat/front' }, { repoId: back.id }] })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ repoId: front.id, branch: 'feat/front' })
    expect(repoRows(res.body.id)).toEqual([
      [front.id, 'feat/front', 0],
      [back.id, '', 1],
    ])
    const refused = await ticket({ title: 'nope', repos: [{ repoId: elsewhere }] })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(`repo ${elsewhere} is not in project ${projectId}`)
  })
})

describe('over MCP', () => {
  it("claim_ticket's branch is the primary repo's; repos sets each one's, adding one the ticket lacks", async () => {
    const t = (await ticket({ repos: [{ repoId: front.id }, { repoId: back.id, branch: 'keep/me' }] })).body
    const claimed = await tool('claim_ticket', { ticketId: t.id, branch: 'feat/front' })
    expect(claimed.error).toBe(false)
    expect(JSON.parse(claimed.text)).toMatchObject({
      branch: 'feat/front',
      assignee: 'claude',
      repoId: front.id,
    })
    expect(repoRows(t.id)).toEqual([
      [front.id, 'feat/front', 0],
      [back.id, 'keep/me', 1],
    ])

    const solo = (await ticket({ repoId: front.id })).body
    await tool('claim_ticket', { ticketId: solo.id, repos: [{ repoId: back.id, branch: 'feat/back' }] })
    const read = JSON.parse((await tool('get_ticket', { ticketId: solo.id })).text)
    expect(read.repos.map((r: { name: string; branch: string }) => [r.name, r.branch])).toEqual([
      ['front', ''],
      ['back', 'feat/back'],
    ])
    expect(
      await tool('claim_ticket', { ticketId: solo.id, repos: [{ repoId: elsewhere, branch: 'x' }] }),
    ).toMatchObject({
      error: true,
      text: expect.stringMatching(/not in project/),
    })
  })

  it('add_workspace takes the repo of the ticket its worktree is of, and refuses one the ticket lacks', async () => {
    const t = (await ticket({ repos: [{ repoId: front.id }, { repoId: back.id }] })).body
    const ws = await tool('add_workspace', { ticketId: t.id, name: 'back', path: back.path, repoId: back.id })
    expect(JSON.parse(ws.text)).toMatchObject({ repoId: back.id })
    const primary = await tool('add_workspace', { ticketId: t.id, name: 'front' })
    expect(JSON.parse(primary.text)).toMatchObject({ repoId: front.id })
    const solo = (await ticket({ repoId: front.id })).body
    expect(await tool('add_workspace', { ticketId: solo.id, name: 'x', repoId: back.id })).toMatchObject({
      error: true,
      text: expect.stringMatching(new RegExp(`repo ${back.id} is not one of ticket ${solo.id}'s repos`)),
    })
  })

  it('update_ticket and create_ticket take repos', async () => {
    const created = await tool('create_ticket', {
      projectId,
      title: 'from mcp',
      repos: [
        { repoId: back.id, branch: 'feat/back' },
        { repoId: front.id, branch: 'feat/front' },
      ],
    })
    const t = JSON.parse(created.text)
    expect(t).toMatchObject({ repoId: back.id, branch: 'feat/back' })
    await tool('update_ticket', { ticketId: t.id, repos: [{ repoId: front.id, branch: 'feat/front' }] })
    expect(repoRows(t.id)).toEqual([[front.id, 'feat/front', 0]])
  })
})

describe('the git view', () => {
  it('reports every repo of the ticket with its own branch, and each workspace with its repo', async () => {
    const t = (
      await ticket({
        repos: [
          { repoId: front.id, branch: 'feat/front' },
          { repoId: back.id, branch: 'feat/back' },
        ],
      })
    ).body
    await call('POST', `/api/tickets/${t.id}/workspaces`, { name: 'b', branch: 'feat/back', repoId: back.id })
    const view = (await call('GET', `/api/tickets/${t.id}/git`)).body
    expect(view.repo).toEqual({ id: front.id, name: 'front' })
    expect(view.branch).toBe('feat/front')
    expect(
      view.repos.map((r: { repo: { name: string }; branch: string; primary: boolean }) => [
        r.repo.name,
        r.branch,
        r.primary,
      ]),
    ).toEqual([
      ['front', 'feat/front', true],
      ['back', 'feat/back', false],
    ])
    for (const r of view.repos) expect(r.info).toMatchObject({ exists: true, ahead: 1, behind: 0 })
    expect(view.repos[1].info.subject).toBe('work on feat/back')
    expect(view.workspaces).toEqual([
      expect.objectContaining({ name: 'b', repoId: back.id, repo: { id: back.id, name: 'back' } }),
    ])
    expect(view.workspaces[0].info).toMatchObject({ exists: true, subject: 'work on feat/back' })
  }, 60_000)
})
