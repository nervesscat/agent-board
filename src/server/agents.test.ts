import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

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
    expect(agents.getSettings()).toEqual({ defaultAgent: 'claude', previewLimit: 8 })
    expect(agents.updateSettings({ defaultAgent: 'codex' })).toEqual({
      defaultAgent: 'codex',
      previewLimit: 8,
    })
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
