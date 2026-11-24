import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { STAGE_KINDS } from '#/lib/constants'
import { KIND_WORK } from './kindText'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
// Test mode: who calls is X-Test-Actor, as Playwright and CI drive it (human, worker, orchestrator).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-kind-text-'))
process.env.DATA_DIR = tmp
process.env.BOARD_ENV = 'test'

let serve: (request: Request) => Promise<Response>
beforeAll(async () => {
  await import('#/db')
  const { admit, rememberActor } = await import('./auth')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const handle = guard(({ request, actor }: { request: Request; actor: string }) =>
    api.handle(request, actor),
  )
  serve = async (request) => {
    const admission = await admit(request, new URL(request.url).pathname)
    if (admission.kind === 'refuse') return admission.response
    if (admission.kind === 'page') throw new Error('an API call got a page')
    if (admission.kind === 'actor') rememberActor(request, admission.caller)
    return handle({ request, actor: admission.kind === 'actor' ? admission.actor : 'unknown' })
  }
}, 60_000)

async function call(method: string, pathname: string, body?: unknown) {
  const res = await serve(
    new Request(`http://localhost:47101${pathname}`, {
      method,
      headers: {
        host: 'localhost:47101',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-test-actor': 'human:tester',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

let rpcId = 0
/** One MCP call on the connection at `pathname` (`/api/mcp`, with or without `?project=`). */
async function rpc(pathname: string, method: string, params: Record<string, unknown> = {}) {
  const res = await serve(
    new Request(`http://localhost:47101${pathname}`, {
      method: 'POST',
      headers: {
        host: 'localhost:47101',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-test-actor': 'agent:worker',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }),
  )
  return ((await res.json()) as { result: any }).result
}

/** Words of code: what a project with no software kind must not read about. */
const CODE_WORDS =
  /(?<![a-z])(branch(es)?|PRs?|pull requests?|CI|previews?|repos?|repositor(y|ies)|worktrees?|commits?|git|GitHub|merged?|merging|push(ed)?|checkouts?|cleanup|origin|pnpm|gh)(?![a-z])/i

describe('the text a project with no software kind is offered', () => {
  let music: number
  let software: number

  beforeAll(async () => {
    music = (await call('POST', '/api/projects', { name: 'Studio text', kinds: ['music'] })).body.id
    software = (await call('POST', '/api/projects', { name: 'Code text' })).body.id
  })

  it('leaves out the tools that only act on code, and keeps the ticket tools', async () => {
    const tools = ((await rpc(`/api/mcp?project=${music}`, 'tools/list')).tools as { name: string }[]).map(
      (t) => t.name,
    )
    for (const name of ['list_prs', 'add_workspace', 'start_run', 'cleanup_delete', 'set_ticket_repo']) {
      expect(tools).not.toContain(name)
    }
    for (const name of [
      'get_project',
      'create_ticket',
      'update_ticket',
      'post_update',
      'set_ticket_summary',
    ]) {
      expect(tools).toContain(name)
    }
  })

  it('never names code in its instructions or in any tool it offers', async () => {
    const result = await rpc(`/api/mcp?project=${music}`, 'tools/list')
    const init = await rpc(`/api/mcp?project=${music}`, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    // Per tool, so a failure names where the word is.
    const found: Record<string, string[]> = { instructions: [] }
    const scan = (where: string, text: string) => {
      const hits = text.match(new RegExp(CODE_WORDS, 'gi')) ?? []
      if (hits.length) found[where] = [...new Set(hits.map((h) => h.toLowerCase()))]
    }
    scan('instructions', init.instructions ?? '')
    for (const t of result.tools as { name: string; description?: string; inputSchema?: unknown }[]) {
      scan(t.name, `${t.description ?? ''} ${JSON.stringify(t.inputSchema ?? {})}`)
    }
    expect(Object.fromEntries(Object.entries(found).filter(([, v]) => v.length))).toEqual({})
  })

  it('never points at the workflow or its tool: a project with no software kind has no review rounds', async () => {
    const result = await rpc(`/api/mcp?project=${music}`, 'tools/list')
    const tools = result.tools as { name: string; description?: string; inputSchema?: unknown }[]
    expect(tools.map((t) => t.name)).not.toContain('get_workflow')
    const found = tools
      .filter((t) =>
        /get_workflow|workflow/i.test(`${t.description ?? ''} ${JSON.stringify(t.inputSchema ?? {})}`),
      )
      .map((t) => t.name)
    expect(found).toEqual([])
    // The software text still points at the tool, as it must.
    const soft = (await rpc(`/api/mcp?project=${software}`, 'tools/list')).tools as {
      name: string
      inputSchema: any
    }[]
    expect(
      soft.find((t) => t.name === 'create_ticket')!.inputSchema.properties.complexity.description,
    ).toContain('get_workflow')
    // The complexity parameter is still described, for create_ticket and update_ticket.
    for (const name of ['create_ticket', 'update_ticket']) {
      const field = tools.find((t) => t.name === name)!.inputSchema as any
      expect(field.properties.complexity.description, name).toContain('low unless you say otherwise')
    }
  })

  it('tells the agent where its files are', async () => {
    const init = await rpc(`/api/mcp?project=${music}`, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.instructions).toContain('workFolder')
  })

  it('lists every stage kind the board has, as the software text does', async () => {
    const init = await rpc(`/api/mcp?project=${music}`, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.instructions).toContain(`a kind (${STAGE_KINDS.join(', ')})`)
  })

  it('keeps the software text and tools for a software project and for a connection that names none', async () => {
    const named = ((await rpc(`/api/mcp?project=${software}`, 'tools/list')).tools as { name: string }[]).map(
      (t) => t.name,
    )
    const plain = ((await rpc('/api/mcp', 'tools/list')).tools as { name: string }[]).map((t) => t.name)
    for (const tools of [named, plain]) {
      expect(tools).toContain('list_prs')
      expect(tools).toContain('start_run')
    }
  })
})

describe('the default agents depend on the kinds', () => {
  it('a project with no software kind gets its maker, and a software project the review cycle', async () => {
    const music = (await call('POST', '/api/projects', { name: 'Maker', kinds: ['music'] })).body.id
    const soft = (await call('POST', '/api/projects', { name: 'Cycle' })).body.id
    const madeMusic = await call('POST', `/api/projects/${music}/agents/defaults`)
    expect(madeMusic.body.added).toEqual(['maker'])
    const musicAgents = (await call('GET', `/api/projects/${music}`)).body.agents.map(
      (a: { name: string }) => a.name,
    )
    expect(musicAgents).toEqual(['maker'])
    const madeSoft = await call('POST', `/api/projects/${soft}/agents/defaults`)
    expect(madeSoft.body.added).toContain('spec')
    expect(madeSoft.body.added).not.toContain('maker')
  })
})

describe('the professional kinds have their own text and maker', () => {
  const PROFESSIONAL = ['lawyer', 'accountant', 'cybersecurity', 'life'] as const

  it('each one names its own work in its instructions, and only code words are left out where the kind has none', async () => {
    for (const kind of PROFESSIONAL) {
      const id = (await call('POST', '/api/projects', { name: `Kind text ${kind}`, kinds: [kind] })).body.id
      const init = await rpc(`/api/mcp?project=${id}`, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      expect(init.instructions).toContain(KIND_WORK[kind])
      expect(init.instructions).toContain('workFolder')
      // Never the git words: a professional project has no branches to talk about.
      expect(init.instructions.match(new RegExp(CODE_WORDS, 'gi')) ?? []).toEqual([])
    }
  })

  it('names only the kinds the project lists: a mixed project reads both kinds of work', async () => {
    const id = (await call('POST', '/api/projects', { name: 'Mixed text', kinds: ['lawyer', 'music'] })).body
      .id
    const init = await rpc(`/api/mcp?project=${id}`, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.instructions).toContain(KIND_WORK.lawyer)
    expect(init.instructions).toContain(KIND_WORK.music)
    expect(init.instructions).not.toContain(KIND_WORK.cybersecurity)
  })

  it('a cybersecurity project keeps no git side, and says that code comes with the software kind', async () => {
    const id = (await call('POST', '/api/projects', { name: 'Security text', kinds: ['cybersecurity'] })).body
      .id
    const project = (await call('GET', `/api/projects/${id}`)).body
    expect(project.kinds).toEqual(['cybersecurity'])
    const init = await rpc(`/api/mcp?project=${id}`, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.instructions).toContain('the Software kind')
  })

  it('a lawyer project gets a maker whose instructions name the lawyer work', async () => {
    const id = (await call('POST', '/api/projects', { name: 'Lawyer maker', kinds: ['lawyer'] })).body.id
    expect((await call('POST', `/api/projects/${id}/agents/defaults`)).body.added).toEqual(['maker'])
    const agents = (await call('GET', `/api/projects/${id}`)).body.agents as {
      name: string
      instructions: string
    }[]
    const maker = agents.find((a) => a.name === 'maker')
    expect(maker?.instructions).toContain(KIND_WORK.lawyer)
    expect(maker?.instructions).not.toContain(KIND_WORK.music)
  })
})
