import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { AGENT_CLIENTS } from '#/lib/constants'
import type { ReviewSkillsStatus, SkillFileDiff } from './agents'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))
// The user-wide .claude the review skills are checked in: a folder of the test's own, not there at first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-home-'))
process.env.CLAUDE_HOME = path.join(home, '.claude')

let agents: typeof import('./agents')
beforeAll(async () => {
  agents = await import('./agents')
  const { db, schema } = await import('#/db')
  const projectId = db.insert(schema.projects).values({ name: 'Acme | web' }).returning().get().id
  db.insert(schema.repos)
    .values({
      projectId,
      name: 'front',
      repoPath: '/home/me/acme-frontend/',
      githubRepo: 'acme/acme-frontend',
    })
    .run()
})

describe('the board skill', () => {
  it('fills in the board URL and carries no projects or repos', () => {
    const skill = agents.renderSkill('claude')
    expect(skill).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(skill).toMatch(/^---\nname: board\n/)
    expect(skill).not.toContain('acme-frontend')
    expect(skill).not.toContain('Acme | web')
    expect(skill).not.toContain('| projectId | repoId |')
    expect(skill).toContain(
      'claude mcp add --transport http --scope user board http://localhost:47100/api/mcp',
    )
  })

  it('has every CLI find its project with find_project, and never list_projects', () => {
    for (const client of AGENT_CLIENTS) {
      const skill = agents.renderSkill(client)
      const section = skill.slice(skill.indexOf('## 1. Your project'), skill.indexOf('## 2. Pick up work'))
      expect(skill, client).not.toMatch(/\{\{[A-Z_]+\}\}/)
      expect(section, client).toContain('call `find_project` with')
      expect(section, client).toContain('`git remote get-url origin`')
      expect(section, client).toContain('`git rev-parse --show-toplevel`')
      expect(section, client).toContain('Do not call `list_projects`')
      expect(section, client).toContain("never read or\nwrite another project's tickets")
      expect(section, client).toContain('ask which\n  repo')
      expect(section, client).toContain('ask the human which one; do not pick')
      expect(section, client).toContain(
        'say the repo has no board project and stop using the board for it. Do not\n  guess from other projects and do not create one.',
      )
      // Nothing in it can go stale: no table to check the project against, nothing to copy again.
      expect(skill, client).not.toContain('the table')
      expect(skill, client).not.toContain('copy the skill again')
    }
  })

  it('points each CLI at its own MCP setup', () => {
    expect(agents.renderSkill('codex')).toContain('~/.codex/config.toml')
    expect(agents.renderSkill('opencode')).toContain('~/.config/opencode/opencode.json')
  })
})

describe('settings', () => {
  it('default to Claude Code and the global copy of the review skills, and keep what is picked', () => {
    expect(agents.getSettings()).toEqual({
      defaultAgent: 'claude',
      previewLimit: 8,
      skillsTracking: 'global',
    })
    expect(agents.updateSettings({ defaultAgent: 'codex' })).toEqual({
      defaultAgent: 'codex',
      previewLimit: 8,
      skillsTracking: 'global',
    })
    expect(agents.updateSettings({ defaultAgent: 'opencode' }).defaultAgent).toBe('opencode')
    expect(agents.updateSettings({ skillsTracking: 'repo' })).toEqual({
      defaultAgent: 'opencode',
      previewLimit: 8,
      skillsTracking: 'repo',
    })
    expect(agents.updateSettings({ skillsTracking: 'global' }).skillsTracking).toBe('global')
  })

  it('fall back to the defaults for a stored value the board does not know', async () => {
    const { db, schema } = await import('#/db')
    const store = (key: string, value: string) =>
      db
        .insert(schema.settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
        .run()
    store('skillsTracking', 'bogus')
    store('defaultAgent', 'bogus')
    expect(agents.getSettings()).toEqual({
      defaultAgent: 'claude',
      previewLimit: 8,
      skillsTracking: 'global',
    })
    db.delete(schema.settings).run()
    expect(agents.getSettings()).toEqual({
      defaultAgent: 'claude',
      previewLimit: 8,
      skillsTracking: 'global',
    })
  })

  it('are read by anyone, changed by the human only, one key at a time, and checked', async () => {
    const { api } = await import('./api')
    const { db, schema } = await import('#/db')
    db.delete(schema.settings).run()
    const route = 'http://localhost/api/settings'
    const send = (body: unknown, headers: Record<string, string> = {}) =>
      api.handle(
        new Request(route, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
        'enrique',
      )
    const read = async (headers: Record<string, string> = {}) =>
      (await api.handle(new Request(route, { headers }), 'enrique')).json()

    expect(await read()).toEqual({ defaultAgent: 'claude', previewLimit: 8, skillsTracking: 'global' })
    const set = await send({ skillsTracking: 'repo' })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ defaultAgent: 'claude', previewLimit: 8, skillsTracking: 'repo' })
    expect(await (await send({ defaultAgent: 'codex' })).json()).toEqual({
      defaultAgent: 'codex',
      previewLimit: 8,
      skillsTracking: 'repo',
    })
    for (const bad of [{ skillsTracking: 'bogus' }, { skillsTracking: '' }, { skillsTracking: 1 }])
      await expect(send(bad), JSON.stringify(bad)).rejects.toMatchObject({ status: 400 })

    // An agent reads the choice, and cannot change it.
    const agent = { authorization: 'Bearer token-of-agent' }
    expect(await read(agent)).toEqual({ defaultAgent: 'codex', previewLimit: 8, skillsTracking: 'repo' })
    await expect(send({ skillsTracking: 'global' }, agent)).rejects.toMatchObject({
      status: 403,
      message: 'only the human changes the settings',
    })
    expect(agents.getSettings()).toEqual({ defaultAgent: 'codex', previewLimit: 8, skillsTracking: 'repo' })
    db.delete(schema.settings).run()
  })
})

describe('the default agents', () => {
  it('adds the cycle once, each with its brief and delegation notes, and keeps what the project has', async () => {
    const { addDefaultAgents, DEFAULT_AGENTS } = await import('./defaultAgents')
    const { createAgent, listAgents } = await import('./projectAgents')
    const { DEFAULT_AGENT_NAMES } = await import('#/lib/constants')
    const { db, schema } = await import('#/db')
    expect(DEFAULT_AGENTS.map((a) => a.name)).toEqual([...DEFAULT_AGENT_NAMES])

    const pid = db.insert(schema.projects).values({ name: 'Cycle' }).returning().get().id
    createAgent(pid, { name: 'Spec', instructions: 'Mine.' }, 'enrique')
    const first = addDefaultAgents(pid, 'enrique')
    expect(first.kept).toEqual(['spec'])
    expect(first.added).toEqual(DEFAULT_AGENT_NAMES.filter((n) => n !== 'spec'))
    const byName = Object.fromEntries(listAgents(pid).map((a) => [a.name, a]))
    expect(byName.Spec!.instructions).toBe('Mine.')
    // The brief is the agent file without its frontmatter.
    expect(byName.hunt!.instructions).toMatch(/^# Feature Review: Hunt Agent\n/)
    expect(byName.builder!.instructions).toMatch(/^# Builder\n/)
    for (const name of first.added) expect(byName[name]!.delegation).toMatch(/\*\*When:\*\*/)

    expect(addDefaultAgents(pid, 'enrique').added).toEqual([])
    expect(listAgents(pid)).toHaveLength(DEFAULT_AGENT_NAMES.length)
  })
})

describe('the review skills bundle', () => {
  it('is a tar that extracts to both skills and their agents, byte for byte', async () => {
    const { execFileSync } = await import('node:child_process')
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-skills-'))
    const tarFile = path.join(out, 'b.tar')
    fs.writeFileSync(tarFile, agents.reviewBundle())
    execFileSync('tar', ['-xf', 'b.tar'], { cwd: out })
    const paths = agents.reviewBundlePaths()
    expect(paths).toContain('skills/feature-review/SKILL.md')
    expect(paths).toContain('skills/review-queue/build_pdf.py')
    expect(paths).toContain('skills/todo-review/SKILL.md')
    expect(paths).toContain('agents/todo-review-ticket.md')
    expect(paths.filter((p) => p.startsWith('agents/feature-review-'))).toHaveLength(7)
    const src = path.join(import.meta.dirname, 'skill', 'review')
    for (const p of paths)
      expect(fs.readFileSync(path.join(out, p)).equals(fs.readFileSync(path.join(src, p))), p).toBe(true)
  })
})

// --- copies of the review bundle on disk, by path under the folder that holds `.claude` ---

const bundle = () => {
  const src = path.join(import.meta.dirname, 'skill', 'review')
  return Object.fromEntries(
    agents.reviewBundlePaths().map((p) => [`.claude/${p}`, fs.readFileSync(path.join(src, p), 'utf8')]),
  )
}
/** The bundle as served, one file of it with CRLF line endings. */
const synced = () => {
  const files = bundle()
  const checklists = '.claude/skills/feature-review/checklists.md'
  files[checklists] = files[checklists]!.replace(/\n/g, '\r\n')
  return files
}
/** As copies drift in practice: one skill edited, one as served, what came later never added, and a skill of its own. */
const drifted = () => {
  const files: Record<string, string> = { ...bundle(), '.claude/skills/x/SKILL.md': 'Not the bundle.\n' }
  files['.claude/skills/feature-review/SKILL.md'] += '\nAn older line.\n'
  delete files['.claude/skills/todo-review/SKILL.md']
  delete files['.claude/agents/todo-review-ticket.md']
  return files
}
/** Other skills and agents, none of them the bundle's. */
const unrelated = {
  '.claude/skills/add-mixpanel-event/SKILL.md': '---\nname: add-mixpanel-event\n---\n',
  '.claude/agents/mine.md': 'Mine.\n',
}
const writeFiles = (dir: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
    fs.writeFileSync(path.join(dir, p), text)
  }
}
/** Every file and folder under `dir`, with each file's bytes: to show a read left it as it was. */
const tree = (dir: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => path.join(e.parentPath, e.name))
      .sort()
      .map((f) => [f, fs.statSync(f).isFile() ? fs.readFileSync(f, 'base64') : 'folder']),
  )

/** A checkout on disk (a `.git` folder and the files given), for a repo row to point at. */
const checkout = (files: Record<string, string> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo skills '))
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFiles(dir, files)
  return dir
}
/** The test's home holding exactly `files` (paths from the home, so under `.claude`); none: no `.claude`. */
const homeWith = (files?: Record<string, string>) => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home)
  if (files) writeFiles(home, files)
}

describe("the review skills in each repo's .claude", () => {
  const repos: Record<string, { id: number; dir: string }> = {}
  let pid: number
  let other: number
  beforeAll(async () => {
    const { db, schema } = await import('#/db')
    pid = db.insert(schema.projects).values({ name: 'Skills' }).returning().get().id
    other = db.insert(schema.projects).values({ name: 'Skills elsewhere' }).returning().get().id
    const dirs = {
      bare: checkout(),
      unrelated: checkout(unrelated),
      synced: checkout(synced()),
      drifted: checkout(drifted()),
      gone: path.join(os.tmpdir(), 'agent-board-no-such-checkout', 'repo'),
      elsewhere: checkout(),
    }
    for (const [name, dir] of Object.entries(dirs)) {
      const projectId = name === 'elsewhere' ? other : pid
      const row = db.insert(schema.repos).values({ projectId, name, repoPath: dir }).returning().get()
      repos[name] = { id: row.id, dir }
    }
  })

  const byName = async (projectId?: number) =>
    Object.fromEntries((await agents.reviewSkillsStatus(projectId)).repos.map((r) => [r.repoName, r]))

  it('answers the bundle paths and every repo on the board, each with its project and checkout', async () => {
    const { db, schema } = await import('#/db')
    const status = await agents.reviewSkillsStatus()
    expect(status.files).toEqual(agents.reviewBundlePaths())
    const ids = (list: { id: number }[]) => list.map((r) => r.id).sort((a, b) => a - b)
    expect(ids(status.repos.map((r) => ({ id: r.repoId })))).toEqual(
      ids(db.select().from(schema.repos).all()),
    )
    const drifted = status.repos.find((r) => r.repoId === repos.drifted!.id)!
    expect(Object.keys(drifted).sort()).toEqual(
      ['files', 'projectId', 'projectName', 'repoId', 'repoName', 'repoPath', 'status'].sort(),
    )
    expect(drifted).toMatchObject({
      repoName: 'drifted',
      projectId: pid,
      projectName: 'Skills',
      repoPath: repos.drifted!.dir,
    })
    expect(drifted.files.map((f) => f.path)).toEqual(status.files)
  })

  it("keeps to one project's repos when asked, and a project that does not exist is not found", async () => {
    const status = await agents.reviewSkillsStatus(other)
    expect(status.files).toEqual(agents.reviewBundlePaths())
    expect(status.repos.map((r) => r.repoName)).toEqual(['elsewhere'])
    expect(Object.keys(await byName(pid)).sort()).toEqual(['bare', 'drifted', 'gone', 'synced', 'unrelated'])
    await expect(agents.reviewSkillsStatus(999_999)).rejects.toMatchObject({ status: 404 })
  })

  it('calls a repo with no bundle file none, also when its .claude has other skills', async () => {
    const all = await byName()
    for (const name of ['bare', 'unrelated']) {
      expect(all[name]!.status, name).toBe('none')
      expect(all[name]!.files).toHaveLength(agents.reviewBundlePaths().length)
      expect(
        all[name]!.files.every((f) => f.status === 'missing'),
        name,
      ).toBe(true)
    }
  })

  it('calls a full copy current, line endings aside', async () => {
    const synced = (await byName()).synced!
    expect(synced.status).toBe('current')
    expect(synced.files.every((f) => f.status === 'current')).toBe(true)
    const checklists = path.join(repos.synced!.dir, '.claude', 'skills', 'feature-review', 'checklists.md')
    expect(fs.readFileSync(checklists, 'utf8')).toContain('\r\n')
  })

  it('calls a drifted copy outdated, file by file', async () => {
    const drifted = (await byName()).drifted!
    expect(drifted.status).toBe('outdated')
    const files = Object.fromEntries(drifted.files.map((f) => [f.path, f.status]))
    expect(files['skills/feature-review/SKILL.md']).toBe('outdated')
    expect(files['skills/todo-review/SKILL.md']).toBe('missing')
    expect(files['agents/todo-review-ticket.md']).toBe('missing')
    expect(files['skills/review-queue/SKILL.md']).toBe('current')
    expect(files['skills/review-queue/build_pdf.py']).toBe('current')
    expect(drifted.files.filter((f) => f.status !== 'current').map((f) => f.path)).toEqual([
      'agents/todo-review-ticket.md',
      'skills/feature-review/SKILL.md',
      'skills/todo-review/SKILL.md',
    ])
  })

  it('calls a checkout that is gone unreachable, and still answers for the rest', async () => {
    const all = await byName()
    expect(all.gone).toMatchObject({ status: 'unreachable', files: [] })
    expect(all.synced!.status).toBe('current')
    expect(all.drifted!.status).toBe('outdated')
    // A file where the checkout should be is no checkout either.
    const { db, schema } = await import('#/db')
    const file = path.join(checkout(), 'a-file')
    fs.writeFileSync(file, 'x')
    const row = db
      .insert(schema.repos)
      .values({ projectId: other, name: 'file', repoPath: file })
      .returning()
      .get()
    const status = await agents.reviewSkillsStatus(other)
    expect(status.repos.find((r) => r.repoId === row.id)).toMatchObject({ status: 'unreachable', files: [] })
    db.delete(schema.repos).where(eq(schema.repos.id, row.id)).run()
  })

  it('only reads: every checkout is left as it was, and no .claude appears', async () => {
    const dirs = Object.values(repos)
      .map((r) => r.dir)
      .filter((d) => fs.existsSync(d))
    const before = dirs.map(tree)
    await agents.reviewSkillsStatus()
    await agents.reviewSkillsStatus(pid)
    expect(dirs.map(tree)).toEqual(before)
    expect(fs.existsSync(path.join(repos.bare!.dir, '.claude'))).toBe(false)
    expect(fs.existsSync(repos.gone!.dir)).toBe(false)
  })

  it('is served to the human and to agents alike, never cached, and per project with ?projectId', async () => {
    const { api } = await import('./api')
    const route = 'http://localhost/api/agent-setup/review-skills/status'
    for (const headers of [{}, { authorization: 'Bearer token-of-agent' }] as Record<string, string>[]) {
      const res = await api.handle(new Request(route, { headers }), 'claude')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = (await res.json()) as ReviewSkillsStatus
      expect(body.files).toEqual(agents.reviewBundlePaths())
      expect(body.repos.find((r) => r.repoName === 'drifted')!.status).toBe('outdated')
      // The user-wide copy comes with it (none yet: the test's own home has no .claude).
      expect(body.global).toMatchObject({ path: process.env.CLAUDE_HOME, status: 'none' })
    }
    const one = (await (
      await api.handle(new Request(`${route}?projectId=${other}`), 'enrique')
    ).json()) as ReviewSkillsStatus
    expect(one.repos.map((r) => r.repoName)).toEqual(['elsewhere'])
    expect(one.global).toEqual((await agents.reviewSkillsStatus()).global)
    await expect(api.handle(new Request(`${route}?projectId=999999`), 'enrique')).rejects.toMatchObject({
      status: 404,
    })
    await expect(api.handle(new Request(`${route}?projectId=nope`), 'enrique')).rejects.toMatchObject({
      status: 400,
    })
  })
})

describe('the review skills in ~/.claude', () => {
  const claude = process.env.CLAUDE_HOME!
  const global = async () => (await agents.reviewSkillsStatus()).global

  it('answers the configured folder beside the repos, file by file, the same for one project', async () => {
    homeWith(drifted())
    const status = await agents.reviewSkillsStatus()
    expect(Object.keys(status).sort()).toEqual(['files', 'global', 'repos'])
    expect(Object.keys(status.global).sort()).toEqual(['files', 'installTo', 'path', 'status'])
    expect(status.global.path).toBe(claude)
    expect(path.isAbsolute(status.global.path)).toBe(true)
    expect(status.global.files.map((f) => f.path)).toEqual(status.files)
    const { listProjects } = await import('./projects')
    for (const p of listProjects())
      expect((await agents.reviewSkillsStatus(p.id)).global).toEqual(status.global)
  })

  it('calls no .claude at all none, and one with other skills only', async () => {
    for (const files of [undefined, {}, unrelated]) {
      homeWith(files)
      const g = await global()
      expect(g.status, JSON.stringify(files)).toBe('none')
      expect(g.files).toHaveLength(agents.reviewBundlePaths().length)
      expect(g.files.every((f) => f.status === 'missing')).toBe(true)
    }
  })

  it('calls a full copy current, line endings aside', async () => {
    homeWith(synced())
    const g = await global()
    expect(g.status).toBe('current')
    expect(g.files.every((f) => f.status === 'current')).toBe(true)
    expect(fs.readFileSync(path.join(claude, 'skills', 'feature-review', 'checklists.md'), 'utf8')).toContain(
      '\r\n',
    )
  })

  it('calls a drifted copy outdated, file by file, and leaves its own skills out', async () => {
    homeWith(drifted())
    const g = await global()
    expect(g.status).toBe('outdated')
    expect(g.files.filter((f) => f.status !== 'current')).toEqual([
      { path: 'agents/todo-review-ticket.md', status: 'missing' },
      { path: 'skills/feature-review/SKILL.md', status: 'outdated' },
      { path: 'skills/todo-review/SKILL.md', status: 'missing' },
    ])
    expect(g.files.some((f) => f.path.startsWith('skills/x/'))).toBe(false)
  })

  it('calls a .claude that is not a folder unreachable, and still answers for the repos', async () => {
    homeWith({ '.claude': 'not a folder\n' })
    const status = await agents.reviewSkillsStatus()
    expect(status.global).toEqual({ path: claude, installTo: claude, status: 'unreachable', files: [] })
    expect(status.repos.find((r) => r.repoName === 'drifted')!.status).toBe('outdated')
  })

  it('says the install line goes to the folder CLAUDE_HOME names, unless that is ~/.claude', async () => {
    // The test's CLAUDE_HOME is not the ~/.claude of the user it runs as: the line installs into it.
    for (const files of [undefined, drifted(), { '.claude': 'not a folder\n' }]) {
      homeWith(files)
      expect((await global()).installTo, JSON.stringify(files)).toBe(claude)
    }
    homeWith(drifted())
    const { api } = await import('./api')
    const res = await api.handle(
      new Request('http://localhost/api/agent-setup/review-skills/status'),
      'enrique',
    )
    expect(((await res.json()) as ReviewSkillsStatus).global.installTo).toBe(claude)

    // The same folder as the home of the user the board runs as: the line says ~/.claude, as it always has.
    const homedir = vi.spyOn(os, 'homedir')
    try {
      for (const at of process.platform === 'win32' ? [home, home.toUpperCase()] : [home]) {
        homedir.mockReturnValue(at)
        expect(await global(), at).toMatchObject({ path: claude, installTo: null, status: 'outdated' })
      }
    } finally {
      homedir.mockRestore()
    }
    expect((await global()).installTo).toBe(claude)
  })

  it('only reads: the home is left as it was, and no .claude appears', async () => {
    for (const files of [undefined, drifted()]) {
      homeWith(files)
      const before = tree(home)
      await agents.reviewSkillsStatus()
      expect(tree(home)).toEqual(before)
    }
    homeWith()
    await agents.reviewSkillsStatus()
    expect(fs.existsSync(claude)).toBe(false)
  })
})

describe('one review skills file as installed, against the copy served', () => {
  const claude = process.env.CLAUDE_HOME!
  const feature = 'skills/feature-review/SKILL.md'
  const served = (p: string) => bundle()[`.claude/${p}`]!
  const changes = (d: SkillFileDiff) => d.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context')
  const texts = (d: SkillFileDiff, kind: 'add' | 'del') =>
    d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === kind).map((l) => l.text))

  let repo: { id: number; dir: string }
  let gone: number
  // The status of the user-wide copy and of this describe's own repos only: the others are not read.
  let projectId: number
  const status = () => agents.reviewSkillsStatus(projectId)
  beforeAll(async () => {
    const { db, schema } = await import('#/db')
    projectId = db.insert(schema.projects).values({ name: 'Diffs' }).returning().get().id
    const dir = checkout(drifted())
    const row = (name: string, repoPath: string) =>
      db.insert(schema.repos).values({ projectId, name, repoPath }).returning().get().id
    repo = { id: row('diffed', dir), dir }
    gone = row('gone for good', path.join(os.tmpdir(), 'agent-board-no-such-checkout', 'diffed'))
  })

  it('shows the installed copy as the old side and the served one as the new: an extra line is removed', async () => {
    homeWith(drifted())
    const d = await agents.reviewSkillDiff(feature)
    const installed = path.join(claude, 'skills', 'feature-review', 'SKILL.md')
    expect(d).toMatchObject({ path: feature, status: 'outdated', installed, unreadable: null })
    expect(d.header).toEqual([
      `--- a/${installed.replace(/^\/+/, '')}`,
      `+++ b/${feature} (served by the board)`,
    ])
    expect(texts(d, 'del')).toEqual(['', 'An older line.'])
    expect(texts(d, 'add')).toEqual([])
    // One hunk at the end of the file, with three lines of context: not the whole file.
    const lines = served(feature).split('\n').length - 1
    expect(d.hunks).toHaveLength(1)
    expect(d.hunks[0]).toMatchObject({ oldStart: lines - 2, oldLines: 5, newStart: lines - 2, newLines: 3 })
    expect(d.hunks[0]!.header).toBe(`@@ -${lines - 2},5 +${lines - 2},3 @@`)
    expect(d.hunks[0]!.lines.map((l) => l.kind)).toEqual(['context', 'context', 'context', 'del', 'del'])
  })

  it('shows a missing file as all added, from /dev/null', async () => {
    homeWith(drifted())
    for (const p of ['skills/todo-review/SKILL.md', 'agents/todo-review-ticket.md']) {
      const d = await agents.reviewSkillDiff(p)
      expect(d.status, p).toBe('missing')
      expect(d.header[0]).toBe('--- /dev/null')
      expect(d.unreadable).toBeNull()
      const count = served(p).replace(/\r\n/g, '\n').split('\n').length - 1
      expect(d.hunks.map((h) => h.header)).toEqual([`@@ -0,0 +1,${count} @@`])
      expect(texts(d, 'add')).toHaveLength(count)
      expect(texts(d, 'del')).toEqual([])
    }
    // No .claude at all: the same.
    homeWith()
    expect((await agents.reviewSkillDiff(feature)).status).toBe('missing')
  })

  it('leaves line endings out: a CRLF copy is current with no hunks, an edit in one is one line each way', async () => {
    homeWith(synced())
    const same = await agents.reviewSkillDiff('skills/feature-review/checklists.md')
    expect(same).toMatchObject({ status: 'current', hunks: [] })

    const crlf = served(feature).replace(/\n/g, '\r\n')
    const target = crlf.split('\r\n').find((l) => l.trim().length > 20)!
    writeFiles(home, { [`.claude/${feature}`]: crlf.replace(target, `${target} (edited)`) })
    const d = await agents.reviewSkillDiff(feature)
    expect(d.status).toBe('outdated')
    expect(changes(d).map((l) => [l.kind, l.text])).toEqual([
      ['del', `${target} (edited)`],
      ['add', target],
    ])
    for (const l of d.hunks.flatMap((h) => h.lines)) expect(l.text).not.toContain('\r')
  })

  it('agrees with the status: what it calls outdated always has a change to show', async () => {
    const text = served(feature)
    const firstLine = text.split('\n')[0]!
    const cases: [string, string][] = [
      ['one edited line', text.replace(firstLine, `${firstLine} edited`)],
      ['one line more', `${text}One more.\n`],
      ['no newline at the end', text.trimEnd()],
    ]
    for (const [name, installed] of cases) {
      homeWith({ ...bundle(), [`.claude/${feature}`]: installed })
      const listed = (await status()).global.files.find((f) => f.path === feature)!
      const d = await agents.reviewSkillDiff(feature)
      expect(listed.status, name).toBe('outdated')
      expect(d.status, name).toBe('outdated')
      expect(changes(d).length, name).toBeGreaterThan(0)
    }

    // Every bundle path, in the user-wide copy and in a repo's, gets the status the status gives it.
    homeWith(drifted())
    const read = await status()
    const copies: [{ path: string; status: string }[], number | undefined][] = [
      [read.global.files, undefined],
      [read.repos.find((r) => r.repoId === repo.id)!.files, repo.id],
    ]
    for (const [files, repoId] of copies) {
      expect(files).toHaveLength(agents.reviewBundlePaths().length)
      for (const f of files) {
        const d = await agents.reviewSkillDiff(f.path, repoId)
        expect(d.status, `${repoId} ${f.path}`).toBe(f.status)
        expect(d.hunks.length > 0, `${repoId} ${f.path}`).toBe(f.status !== 'current')
      }
    }
  })

  it('says so when the installed copy cannot be read as text, and calls it outdated as the status does', async () => {
    const checklists = 'skills/feature-review/checklists.md'
    const files = drifted()
    delete files[`.claude/${checklists}`]
    homeWith(files)
    fs.mkdirSync(path.join(claude, ...checklists.split('/')))
    const listed = (await status()).global.files.find((f) => f.path === checklists)!
    expect(listed.status).toBe('outdated')

    const { api } = await import('./api')
    const route = `http://localhost/api/agent-setup/review-skills/diff?path=${encodeURIComponent(checklists)}`
    const res = await api.handle(new Request(route), 'enrique')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      path: checklists,
      status: 'outdated',
      unreadable: 'a folder is in its place',
      hunks: [],
    })
  })

  it('reads in the repo given, from its own .claude, and not in one the board does not have', async () => {
    homeWith()
    const d = await agents.reviewSkillDiff(feature, repo.id)
    expect(d.installed).toBe(path.join(repo.dir, '.claude', 'skills', 'feature-review', 'SKILL.md'))
    expect(d.status).toBe('outdated')
    expect(texts(d, 'del')).toEqual(['', 'An older line.'])
    expect((await agents.reviewSkillDiff('skills/todo-review/SKILL.md', repo.id)).status).toBe('missing')
    await expect(agents.reviewSkillDiff(feature, 999_999)).rejects.toMatchObject({ status: 404 })
    // A checkout that is gone is a refusal, not a failure.
    await expect(agents.reviewSkillDiff(feature, gone)).rejects.toMatchObject({ status: 409 })
    // A .claude that is not a folder, in the home: the same.
    homeWith({ '.claude': 'not a folder\n' })
    await expect(agents.reviewSkillDiff(feature)).rejects.toMatchObject({ status: 409 })
  })

  it('is served to the human and to agents alike, never cached, per repo with ?repoId', async () => {
    homeWith(drifted())
    const { api } = await import('./api')
    const route = `http://localhost/api/agent-setup/review-skills/diff?path=${encodeURIComponent(feature)}`
    const read = async (url: string) =>
      (await (await api.handle(new Request(url), 'enrique')).json()) as SkillFileDiff
    for (const headers of [{}, { authorization: 'Bearer token-of-agent' }] as Record<string, string>[]) {
      const res = await api.handle(new Request(route, { headers }), 'claude')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(((await res.json()) as SkillFileDiff).installed.startsWith(claude)).toBe(true)
    }
    expect(
      (await read(`${route}&repoId=${repo.id}`)).installed.startsWith(path.join(repo.dir, '.claude')),
    ).toBe(true)
    // There is no way to name a folder: anything else in the query is left alone.
    expect((await read(`${route}&dir=${encodeURIComponent(repo.dir)}`)).installed.startsWith(claude)).toBe(
      true,
    )
    const bad: [string, number][] = [
      ['repoId=999999', 404],
      ['repoId=nope', 400],
      ['repoId=', 400],
      ['repoId=-1', 400],
    ]
    for (const [query, status] of bad)
      await expect(api.handle(new Request(`${route}&${query}`), 'enrique'), query).rejects.toMatchObject({
        status,
      })
  })

  it('refuses any path that is not one of the bundle, before reading anything, and never writes', async () => {
    const { api } = await import('./api')
    const sentinel = 'SENTINEL settings, never to be read'
    homeWith({ ...drifted(), '.claude/settings.json': sentinel })
    const before = { home: tree(home), repo: tree(repo.dir) }
    const route = 'http://localhost/api/agent-setup/review-skills/diff'
    const refused = [
      '../../etc/passwd',
      '../settings.json',
      'settings.json',
      'skills/x/SKILL.md',
      'skills/feature-review/../../settings.json',
      './skills/feature-review/SKILL.md',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      path.join(claude, 'settings.json'),
      'skills\\feature-review\\SKILL.md',
      'skills/feature-review/SKILL.md/',
      '.',
      ' ',
    ]
    const queries = [
      ...refused.flatMap((p) => [
        `path=${encodeURIComponent(p)}`,
        `path=${encodeURIComponent(p)}&repoId=${repo.id}`,
      ]),
      'path=..%2F..%2Fsettings.json',
      'path=..%252F..%252Fsettings.json',
      'path=',
      '',
    ]
    for (const query of queries) {
      const refusal = await api.handle(new Request(`${route}?${query}`), 'enrique').then(
        (res) => ({ status: res.status, message: 'answered' }),
        (err: { status: number; message: string }) => err,
      )
      expect([400, 404], query).toContain(refusal.status)
      expect(refusal.message, query).not.toContain('SENTINEL')
    }
    // Every bundle path as well, in the home and in the checkout: both left as they were.
    for (const p of agents.reviewBundlePaths()) {
      for (const repoId of [undefined, repo.id]) {
        const res = await api.handle(
          new Request(`${route}?path=${encodeURIComponent(p)}${repoId ? `&repoId=${repoId}` : ''}`),
          'enrique',
        )
        expect(res.status, p).toBe(200)
        expect(await res.text()).not.toContain('SENTINEL')
      }
    }
    expect({ home: tree(home), repo: tree(repo.dir) }).toEqual(before)

    // No .claude: none appears.
    homeWith()
    for (const p of agents.reviewBundlePaths()) await agents.reviewSkillDiff(p)
    expect(fs.existsSync(claude)).toBe(false)
  })
})
