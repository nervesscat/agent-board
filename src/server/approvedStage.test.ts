import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-approved-'))
process.env.DATA_DIR = tmp

const repo = path.join(import.meta.dirname, '..', '..')
// Read as the repo holds them, with the line endings folded to \n; a sentence a line break splits still matches.
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const flat = (text: string) => text.replace(/\s+/g, ' ')

const boardSkill = read(path.join(import.meta.dirname, 'skill', 'board.md'))
const agentsDoc = read(path.join(repo, 'AGENTS.md'))

/** A JSON-RPC call to the MCP server, answered as its result. */
let call: (method: string, params?: Record<string, unknown>) => Promise<any>
beforeAll(async () => {
  const { handleMcp } = await import('./mcp')
  let id = 0
  call = async (method, params = {}) => {
    const res = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      }),
      'claude',
    )
    return ((await res.json()) as { result?: any }).result
  }
})

const INIT = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
}

/** The instructions a client gets when it connects to the MCP server. */
const served = async (): Promise<string> => (await call('initialize', INIT))?.instructions ?? ''

/** The description of one MCP tool, as a client gets it. */
const descriptionOf = async (name: string): Promise<string> =>
  ((await call('tools/list')).tools as { name: string; description: string }[]).find((t) => t.name === name)!
    .description

describe('Approved, in the texts agents read', () => {
  /** Every text that states the merge rule, by name. */
  const texts = async () => {
    const { DEFAULT_AGENTS } = await import('./defaultAgents')
    return {
      'board.md': boardSkill,
      'AGENTS.md': agentsDoc,
      'the MCP instructions': await served(),
      'the merge agent notes': DEFAULT_AGENTS.find((a) => a.name === 'merge')!.delegation,
    }
  }

  it("says merging is the human's except in Approved, where an orchestrator asks first and may merge after a yes", async () => {
    const rule =
      "merging is the human's everywhere except on a ticket in approved, where an orchestrator may merge its pr(s) after the human says yes"
    for (const [name, text] of Object.entries(await texts()))
      expect(flat(text).toLowerCase(), name).toContain(rule)
  })

  it('gives the routine: work finished, ask (without blocking the ticket), merge (the base in and CI green first when it conflicts), then move to done', async () => {
    for (const [name, text] of Object.entries(await texts())) {
      const flatText = flat(text).toLowerCase()
      for (const phrase of [
        'ask_decision',
        'block: false',
        'on silence',
        'merge the base in',
        'wait for ci green',
        'move the ticket to done',
        'naming the pr and the merge commit',
      ])
        expect(flatText, `${name}: ${phrase}`).toContain(phrase)
    }
  })

  it('carries the exception in the served update_ticket description too, not only in the instructions', async () => {
    const description = flat(await descriptionOf('update_ticket')).toLowerCase()
    expect(description).toContain(
      "merge order is the human's, so leave it in review, except on a ticket in approved, where an orchestrator may merge its pr(s) after the human says yes",
    )
    expect(description).toContain(
      "(merging is the human's everywhere except on a ticket in approved, where an orchestrator may merge its pr(s) after the human says yes)",
    )
    // The two claims the exception replaced, so they cannot creep back in beside it.
    expect(description).not.toContain('so leave it in review. a move')
    expect(description).not.toContain("(merging is the human's)")
  })

  it('has no code path that merges a PR: the board reads the queue, an agent merges', async () => {
    const files = fs
      .readdirSync(path.join(repo, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    expect(
      files.filter((f) => /\bgh pr merge\b|mergePullRequest|mergePR\(/.test(read(path.join(repo, 'src', f)))),
    ).toEqual([])
    for (const text of [boardSkill, agentsDoc])
      expect(flat(text).toLowerCase()).toContain('the board never merges a pr itself')
  })
})
