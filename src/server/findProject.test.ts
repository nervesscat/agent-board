import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Found } from './findProject'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-find-project-'))

let dbm: typeof import('#/db')
let handle: (request: Request) => Promise<Response>

/** Every project and repo seeded, by a name only it has, so a response can be checked for what it holds. */
const ids = { project: {} as Record<string, number>, repo: {} as Record<string, number> }

beforeAll(async () => {
  dbm = await import('#/db')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: a bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : 'enrique'),
  )
  handle = (request) => guarded({ request })

  const project = (name: string) =>
    (ids.project[name] = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id)
  const repo = (projectName: string, name: string, repoPath: string, githubRepo: string | null) =>
    (ids.repo[name] = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: ids.project[projectName]!, name, repoPath, githubRepo })
      .returning()
      .get().id)
  project('proj-shop')
  project('proj-tools')
  project('proj-other')
  project('proj-secret')
  repo('proj-shop', 'shop-front', '/home/me/shop/front/', 'Acme/Shop-Front')
  repo('proj-shop', 'shop-back', '/home/me/shop/back', 'acme/shop-back')
  repo('proj-tools', 'tools-cli', 'C:\\Users\\me\\tools-cli', 'acme/tools-cli')
  repo('proj-tools', 'tools-wsl', '/mnt/d/Code/wsl-one/', null)
  repo('proj-other', 'other-front', '/srv/other/front', 'acme/other-front')
  repo('proj-secret', 'secret-repo', '/srv/secret-place', 'acme/secret-repo')
})

let rpcId = 0
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await handle(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer token-of-test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { result: any }).result
}

/** find_project through the board's MCP endpoint, as an agent: its result, and the raw text it came in. */
async function find(args: Record<string, unknown>) {
  const result = (await rpc('tools/call', { name: 'find_project', arguments: args })) as {
    isError?: boolean
    content: { text: string }[]
  }
  const text = result.content[0]!.text
  expect(result.isError, text).toBeFalsy()
  return { found: JSON.parse(text) as Found, text }
}

/** The text names the given repos and their projects, and no other seeded project or repo. */
function onlyMentions(text: string, repos: string[]) {
  const projects = new Set(
    repos.map((r) => {
      const row = dbm.db.select().from(dbm.schema.repos).where(eq(dbm.schema.repos.id, ids.repo[r]!)).get()!
      return dbm.db.select().from(dbm.schema.projects).where(eq(dbm.schema.projects.id, row.projectId)).get()!
        .name
    }),
  )
  for (const name of Object.keys(ids.project))
    if (!projects.has(name)) expect(text, `mentions project ${name}`).not.toContain(name)
  for (const name of Object.keys(ids.repo))
    if (!repos.includes(name)) expect(text, `mentions repo ${name}`).not.toContain(name)
}

const one = (found: Found) => {
  expect(found.match).toBe('one')
  return found as Extract<Found, { match: 'one' }>
}

describe('find_project', () => {
  it('is listed for an agent with githubRepo, folder and path, and asks for at least one', async () => {
    const tools = (await rpc('tools/list')).tools as { name: string; inputSchema: any }[]
    const tool = tools.find((t) => t.name === 'find_project')
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.inputSchema.properties).sort()).toEqual([
      'agentName',
      'folder',
      'githubRepo',
      'path',
    ])
    expect(tool!.inputSchema.required ?? []).toEqual([])

    for (const args of [{}, { githubRepo: '  ', folder: '', path: '' }]) {
      const result = await rpc('tools/call', { name: 'find_project', arguments: args })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('give at least one of githubRepo')
    }
  })

  it('finds a repo by its GitHub slug, as owner/name or an origin URL, in any casing', async () => {
    for (const githubRepo of [
      'acme/shop-front',
      'ACME/SHOP-FRONT',
      'git@github.com:Acme/Shop-Front.git',
      'https://github.com/acme/shop-front.git',
      'ssh://git@github.com/acme/shop-front',
    ]) {
      const { found, text } = await find({ githubRepo })
      expect(one(found)).toMatchObject({
        by: 'githubRepo',
        projectId: ids.project['proj-shop'],
        projectName: 'proj-shop',
        repoId: ids.repo['shop-front'],
        repo: {
          id: ids.repo['shop-front'],
          name: 'shop-front',
          repoPath: '/home/me/shop/front/',
          githubRepo: 'Acme/Shop-Front',
          baseBranch: 'main',
        },
      })
      onlyMentions(text, ['shop-front'])
    }
  })

  it('takes the slug over the folder and the path', async () => {
    const { found } = await find({
      githubRepo: 'acme/shop-front',
      folder: 'back',
      path: '/home/me/shop/back',
    })
    expect(one(found)).toMatchObject({ by: 'githubRepo', repoId: ids.repo['shop-front'] })
  })

  it('finds a worktree by its slug, whatever its folder and path', async () => {
    const { found, text } = await find({
      githubRepo: 'git@github.com:acme/shop-back.git',
      folder: '.wt-pr14',
      path: '/home/me/shop/.wt-pr14',
    })
    expect(one(found)).toMatchObject({ by: 'githubRepo', repoId: ids.repo['shop-back'] })
    onlyMentions(text, ['shop-back'])
  })

  it('reads owner/name with a trailing .git or slash as the slug it names', async () => {
    for (const githubRepo of ['acme/shop-back.git', 'acme/shop-back/', 'ACME/shop-back.git/']) {
      expect(one((await find({ githubRepo, folder: '.wt-pr14' })).found)).toMatchObject({
        by: 'githubRepo',
        repoId: ids.repo['shop-back'],
      })
      // From the main checkout too, with no warning that it may be another repository.
      const { found } = await find({ githubRepo, folder: 'back' })
      expect(one(found)).toMatchObject({ by: 'githubRepo', repoId: ids.repo['shop-back'] })
      expect(found).not.toHaveProperty('weak')
    }
  })

  it('reads owner/name from an ssh origin on another host, an alias of GitHub, as a weak match', async () => {
    for (const githubRepo of [
      'git@github-work:acme/shop-back.git',
      'git@github.com-work:acme/shop-back',
      'ssh://git@gh-alias:2222/acme/shop-back.git',
    ]) {
      const { found, text } = await find({ githubRepo, folder: '.wt-pr14', path: '/home/me/.wt-pr14' })
      expect(one(found)).toMatchObject({ by: 'githubRepo', repoId: ids.repo['shop-back'], weak: true })
      expect(found.message).toContain('not github.com')
      expect(found.message).toContain('confirm with the human')
      onlyMentions(text, ['shop-back'])
    }
    // Another user at github.com itself is GitHub: a plain match.
    const { found } = await find({ githubRepo: 'org-12@github.com:acme/shop-back.git' })
    expect(one(found)).toMatchObject({ by: 'githubRepo', repoId: ids.repo['shop-back'] })
    expect(found).not.toHaveProperty('weak')
    // An alias whose owner/name is on no repo: no project, saying how the origin was read.
    const none = (await find({ githubRepo: 'git@github-work:acme/nowhere.git', folder: '.wt-x' })).found
    expect(none).toMatchObject({ match: 'none' })
    expect(none.message).toContain('read as acme/nowhere')
  })

  it('finds a worktree nested in a repo’s checkout by its path, also for a repo with no GitHub repo', async () => {
    // tools-wsl has no GitHub repo on the board, so no slug can find its worktrees.
    for (const p of [
      '/mnt/d/Code/wsl-one/.wt-pr14',
      'D:\\Code\\wsl-one\\.wt-pr14\\',
      '/mnt/d/Code/wsl-one/a/b',
    ]) {
      const { found, text } = await find({ path: p })
      expect(one(found)).toMatchObject({ by: 'inside', repoId: ids.repo['tools-wsl'] })
      expect(found).not.toHaveProperty('weak')
      onlyMentions(text, ['tools-wsl'])
    }
    // With a GitHub origin the board cannot confirm, it is found but weak.
    const { found } = await find({
      githubRepo: 'git@github.com:acme/wsl-one.git',
      folder: '.wt-pr14',
      path: '/mnt/d/Code/wsl-one/.wt-pr14',
    })
    expect(one(found)).toMatchObject({ by: 'inside', repoId: ids.repo['tools-wsl'], weak: true })
    expect(found.message).toContain('no GitHub repo')
    // A worktree nested in a repo with a GitHub repo, given that slug, is found by the slug.
    expect(
      one((await find({ githubRepo: 'acme/shop-front', path: '/home/me/shop/front/.wt-pr3' })).found).by,
    ).toBe('githubRepo')
  })

  it('finds a worktree beside a repo’s checkout, named <folder>-<branch>, as a weak match', async () => {
    const { found, text } = await find({ path: '/mnt/d/Code/wsl-one-fix-login' })
    expect(one(found)).toMatchObject({ by: 'beside', repoId: ids.repo['tools-wsl'], weak: true })
    expect(found.message).toContain('beside')
    onlyMentions(text, ['tools-wsl'])
    // Only beside it: the same name in another folder, or a name that merely starts alike, is no match.
    expect((await find({ path: '/mnt/d/Other/wsl-one-fix-login' })).found.match).toBe('none')
    expect((await find({ path: '/mnt/d/Code/wsl-onex' })).found.match).toBe('none')
  })

  it('finds a repo by its folder name without a slug, or when the slug matches nothing', async () => {
    expect(one((await find({ folder: 'tools-cli' })).found)).toMatchObject({
      by: 'folder',
      repoId: ids.repo['tools-cli'],
    })
    // A whole path given as the folder counts by its last segment.
    expect(one((await find({ folder: 'E:\\elsewhere\\tools-cli\\' })).found).repoId).toBe(
      ids.repo['tools-cli'],
    )
    // A repo without a GitHub repo on the board is a plain hit.
    const { found } = await find({ githubRepo: 'acme/nope', folder: 'wsl-one' })
    expect(one(found)).toMatchObject({ by: 'folder', repoId: ids.repo['tools-wsl'] })
    expect(found).not.toHaveProperty('weak')
    // An origin that is not github.com: the folder still finds it.
    expect(
      one((await find({ githubRepo: 'https://gitlab.com/acme/tools-cli.git', folder: 'tools-cli' })).found)
        .repoId,
    ).toBe(ids.repo['tools-cli'])
  })

  it('marks as weak a folder hit on a repo whose GitHub repo is another than the one given', async () => {
    const { found } = await find({ githubRepo: 'acme/a-fork-of-cli', folder: 'tools-cli' })
    expect(one(found)).toMatchObject({ by: 'folder', repoId: ids.repo['tools-cli'], weak: true })
    expect(found.message).toContain('acme/a-fork-of-cli')
    expect(found.message).toContain('confirm with the human')
  })

  it('finds a repo by its path, slashes either way and a trailing one aside', async () => {
    for (const p of [
      '/home/me/shop/back',
      '/home/me/shop/back/',
      '/home/me/shop//back',
      '\\home\\me\\shop\\back',
    ]) {
      expect(one((await find({ path: p })).found)).toMatchObject({
        by: 'path',
        repoId: ids.repo['shop-back'],
      })
    }
    // Off a Windows drive a path's case matters: another casing is no path hit, only its folder's.
    expect(one((await find({ path: '/HOME/ME/shop/back' })).found).by).toBe('folder')
  })

  it('takes a Windows path and its WSL form as the same checkout, either way round, drive in any case', async () => {
    for (const p of ['/mnt/c/Users/me/tools-cli', '/mnt/C/users/ME/tools-cli/', 'c:/users/me/TOOLS-CLI']) {
      expect(one((await find({ path: p, folder: 'not-it' })).found)).toMatchObject({
        by: 'path',
        repoId: ids.repo['tools-cli'],
      })
    }
    for (const p of ['D:\\Code\\wsl-one', 'd:/code/WSL-ONE/', '/mnt/d/Code/wsl-one']) {
      expect(one((await find({ path: p, folder: 'not-it' })).found)).toMatchObject({
        by: 'path',
        repoId: ids.repo['tools-wsl'],
      })
    }
  })

  it('does not pick between repos of several projects that match alike, and lists only those', async () => {
    const { found, text } = await find({ folder: 'front' })
    expect(found).toMatchObject({ match: 'ambiguous', by: 'folder' })
    const { candidates, message } = found as Extract<Found, { match: 'ambiguous' }>
    expect(candidates.map((c) => [c.projectName, c.repo.id]).sort()).toEqual([
      ['proj-other', ids.repo['other-front']],
      ['proj-shop', ids.repo['shop-front']],
    ])
    expect(message).toContain('2 projects')
    expect(message).toContain('ask the human')
    onlyMentions(text, ['shop-front', 'other-front'])
  })

  it('answers a folder holding several repos of one project with that project and those repos', async () => {
    const { found, text } = await find({ path: '/home/me/shop/', folder: 'shop' })
    expect(found).toMatchObject({ match: 'repos', by: 'path', projectId: ids.project['proj-shop'] })
    const { repos, message } = found as Extract<Found, { match: 'repos' }>
    expect(repos.map((r) => r.id).sort()).toEqual([ids.repo['shop-front'], ids.repo['shop-back']].sort())
    expect(message).toContain('ask which repo')
    onlyMentions(text, ['shop-front', 'shop-back'])
  })

  it('answers no match as a plain result that says there is no board project for this repo', async () => {
    const { found, text } = await find({ githubRepo: 'acme/unknown', folder: 'unknown', path: '/x/unknown' })
    expect(found).toEqual({
      match: 'none',
      message: expect.stringContaining('No board project for this repo'),
    })
    expect(found.message).toContain('do not create one')
    onlyMentions(text, [])
  })

  it('finds a project and repo added after the skill was rendered, from that same skill', async () => {
    const { renderSkill } = await import('./agents')
    const skill = renderSkill('claude')
    const late = dbm.db.insert(dbm.schema.projects).values({ name: 'proj-late' }).returning().get().id
    const repo = dbm.db
      .insert(dbm.schema.repos)
      .values({
        projectId: late,
        name: 'late-repo',
        repoPath: '/home/me/late-repo',
        githubRepo: 'acme/late-repo',
      })
      .returning()
      .get().id
    expect(renderSkill('claude')).toBe(skill)
    expect(skill).toContain('find_project')
    expect(one((await find({ githubRepo: 'git@github.com:acme/late-repo.git' })).found)).toMatchObject({
      projectId: late,
      projectName: 'proj-late',
      repoId: repo,
    })
  })

  it('answers with the board as it is now after a repo moves or is renamed, or its project is', async () => {
    const p = dbm.db.insert(dbm.schema.projects).values({ name: 'proj-moving' }).returning().get().id
    const q = dbm.db.insert(dbm.schema.projects).values({ name: 'proj-target' }).returning().get().id
    const r = dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: p, name: 'mover', repoPath: '/home/me/mover', githubRepo: 'acme/mover' })
      .returning()
      .get().id
    expect(one((await find({ folder: 'mover' })).found)).toMatchObject({
      projectId: p,
      projectName: 'proj-moving',
    })

    dbm.db
      .update(dbm.schema.projects)
      .set({ name: 'proj-renamed' })
      .where(eq(dbm.schema.projects.id, p))
      .run()
    dbm.db
      .update(dbm.schema.repos)
      .set({ repoPath: '/home/me/moved-here', name: 'moved' })
      .where(eq(dbm.schema.repos.id, r))
      .run()
    expect((await find({ folder: 'mover' })).found.match).toBe('none')
    expect(one((await find({ path: '/home/me/moved-here' })).found)).toMatchObject({
      projectName: 'proj-renamed',
      repo: { name: 'moved', repoPath: '/home/me/moved-here' },
    })

    dbm.db.update(dbm.schema.repos).set({ projectId: q }).where(eq(dbm.schema.repos.id, r)).run()
    expect(one((await find({ githubRepo: 'acme/mover' })).found)).toMatchObject({
      projectId: q,
      projectName: 'proj-target',
      repoId: r,
    })
  })

  it('narrows a GitHub repo registered twice by the checkout’s path or folder', async () => {
    const p = dbm.db.insert(dbm.schema.projects).values({ name: 'proj-twice' }).returning().get().id
    const add = (name: string, repoPath: string) =>
      dbm.db
        .insert(dbm.schema.repos)
        .values({ projectId: p, name, repoPath, githubRepo: 'acme/twice' })
        .returning()
        .get().id
    const a = add('twice-linux', '/home/me/twice')
    const b = add('twice-win', 'C:\\code\\twice-win')
    expect(one((await find({ githubRepo: 'acme/twice', path: '/mnt/c/code/twice-win' })).found).repoId).toBe(
      b,
    )
    expect(one((await find({ githubRepo: 'acme/twice', folder: 'twice' })).found).repoId).toBe(a)
    const both = (await find({ githubRepo: 'acme/twice', folder: '.wt-x' })).found
    expect(both).toMatchObject({ match: 'repos', projectId: p })
  })
})

describe('the MCP server instructions', () => {
  it('point agents at find_project, not at list_projects, to find their project', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    const instructions = init.instructions as string
    expect(instructions).toContain('call find_project')
    expect(instructions).not.toContain('call list_projects once')
    expect(instructions).toContain('do not call list_projects')
    expect(instructions).toContain('if it finds none, do not use the board for this repo')
  })
})

describe('the served board skill', () => {
  it('tells the agent to call find_project, for every CLI', async () => {
    for (const client of ['claude', 'codex', 'opencode']) {
      const res = await handle(new Request(`http://localhost/api/agent-setup/skill?client=${client}`))
      expect(res.status).toBe(200)
      const skill = await res.text()
      expect(skill).toContain('## 1. Your project: ask the board with `find_project`')
      expect(skill).not.toMatch(/\{\{[A-Z_]+\}\}/)
      // No repo of the board is in it.
      for (const name of Object.keys(ids.repo)) expect(skill).not.toContain(name)
    }
  })
})
