import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import type { ReviewSkillsStatus } from './agents'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-test-'))

let agents: typeof import('./agents')
beforeAll(async () => {
  agents = await import('./agents')
  const { db, schema } = await import('#/db')
  const projectId = db.insert(schema.projects).values({ name: 'Spark | web' }).returning().get().id
  db.insert(schema.repos)
    .values({
      projectId,
      name: 'front',
      repoPath: '/home/me/spark-frontend/',
      githubRepo: 'acme/spark-frontend',
    })
    .run()
})

describe('the board skill', () => {
  it('fills in the board URL and a table of every repo', () => {
    const skill = agents.renderSkill('claude')
    expect(skill).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(skill).toMatch(/^---\nname: board\n/)
    expect(skill).toContain('| Folder | GitHub | Checkout | Project | projectId | repoId |')
    expect(skill).toContain(
      '| `spark-frontend` | `acme/spark-frontend` | `/home/me/spark-frontend/` | `Spark \\| web` | 1 | 1 |',
    )
    expect(skill).toContain(
      'claude mcp add --transport http --scope user board http://localhost:47100/api/mcp',
    )
  })

  it('points each CLI at its own MCP setup', () => {
    expect(agents.renderSkill('codex')).toContain('~/.codex/config.toml')
    expect(agents.renderSkill('opencode')).toContain('~/.config/opencode/opencode.json')
  })
})

describe('settings', () => {
  it('default to Claude Code and keep what is picked', () => {
    expect(agents.getSettings()).toEqual({ defaultAgent: 'claude' })
    expect(agents.updateSettings({ defaultAgent: 'codex' })).toEqual({ defaultAgent: 'codex' })
    expect(agents.updateSettings({ defaultAgent: 'opencode' }).defaultAgent).toBe('opencode')
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

describe("the review skills in each repo's .claude", () => {
  const src = path.join(import.meta.dirname, 'skill', 'review')
  const bundle = () =>
    Object.fromEntries(
      agents.reviewBundlePaths().map((p) => [`.claude/${p}`, fs.readFileSync(path.join(src, p), 'utf8')]),
    )
  /** A checkout on disk (a `.git` folder and the files given), for a repo row to point at. */
  const checkout = (files: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo skills '))
    fs.mkdirSync(path.join(dir, '.git'))
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    for (const [p, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
      fs.writeFileSync(path.join(dir, p), text)
    }
    return dir
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

  const repos: Record<string, { id: number; dir: string }> = {}
  let pid: number
  let other: number
  beforeAll(async () => {
    const { db, schema } = await import('#/db')
    pid = db.insert(schema.projects).values({ name: 'Skills' }).returning().get().id
    other = db.insert(schema.projects).values({ name: 'Skills elsewhere' }).returning().get().id
    const synced = bundle()
    const checklists = '.claude/skills/feature-review/checklists.md'
    synced[checklists] = synced[checklists]!.replace(/\n/g, '\r\n')
    // As copies drift in practice: one skill edited, one as served, and what came later never added.
    const drifted: Record<string, string> = { ...bundle(), '.claude/skills/x/SKILL.md': 'Not the bundle.\n' }
    drifted['.claude/skills/feature-review/SKILL.md'] += '\nAn older line.\n'
    delete drifted['.claude/skills/todo-review/SKILL.md']
    delete drifted['.claude/agents/todo-review-ticket.md']
    const dirs = {
      bare: checkout(),
      unrelated: checkout({
        '.claude/skills/add-mixpanel-event/SKILL.md': '---\nname: add-mixpanel-event\n---\n',
        '.claude/agents/mine.md': 'Mine.\n',
      }),
      synced: checkout(synced),
      drifted: checkout(drifted),
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
    for (const headers of [{}, { authorization: 'Bearer gate_agent' }] as Record<string, string>[]) {
      const res = await api.handle(new Request(route, { headers }), 'claude')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = (await res.json()) as ReviewSkillsStatus
      expect(body.files).toEqual(agents.reviewBundlePaths())
      expect(body.repos.find((r) => r.repoName === 'drifted')!.status).toBe('outdated')
    }
    const one = (await (
      await api.handle(new Request(`${route}?projectId=${other}`), 'enrique')
    ).json()) as ReviewSkillsStatus
    expect(one.repos.map((r) => r.repoName)).toEqual(['elsewhere'])
    await expect(api.handle(new Request(`${route}?projectId=999999`), 'enrique')).rejects.toMatchObject({
      status: 404,
    })
    await expect(api.handle(new Request(`${route}?projectId=nope`), 'enrique')).rejects.toMatchObject({
      status: 400,
    })
  })
})
