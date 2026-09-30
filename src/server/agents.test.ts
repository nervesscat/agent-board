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
    expect(agents.getSettings()).toEqual({ defaultAgent: 'claude' })
    expect(agents.updateSettings({ defaultAgent: 'codex' })).toEqual({ defaultAgent: 'codex' })
    expect(agents.updateSettings({ defaultAgent: 'opencode' }).defaultAgent).toBe('opencode')
  })
})
