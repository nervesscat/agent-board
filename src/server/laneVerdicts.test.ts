import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-lane-stages-'))
process.env.DATA_DIR = tmp

const HUMAN = 'enrique'
const repoRoot = path.join(import.meta.dirname, '..', '..')
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const flat = (text: string) => text.replace(/\s+/g, ' ')

let dbm: typeof import('#/db')
let features: typeof import('./features')
let needs: typeof import('./needs')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  needs = await import('./needs')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? 'claude' : HUMAN),
  )
  handle = (request) => guarded({ request })
})

function newProject(name: string) {
  const id = dbm.db.insert(dbm.schema.projects).values({ name }).returning().get().id
  dbm.db
    .insert(dbm.schema.repos)
    .values({ projectId: id, name: 'app', repoPath: `/r/${name}` })
    .run()
  return id
}

async function approval(id: number, verdict: string | null) {
  const res = await handle(
    new Request(`http://localhost/api/tickets/${id}/approval`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict }),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

describe('a lane is judged by its stage', () => {
  it('refuses the human’s approval, disapproval and taking a call back, on every path', async () => {
    const pid = newProject('lane-approval')
    const parent = features.createTicket(pid, { title: 'Parent' }, HUMAN)
    const lane = features.createTicket(
      pid,
      { title: 'Lane', parentId: parent.id, status: 'review' },
      'claude',
    )
    const unchanged = () => features.getTicket(lane.id)
    const before = unchanged()

    for (const verdict of ['approved', 'disapproved', null] as const) {
      expect(() => features.setVerdict(lane.id, verdict, HUMAN)).toThrow(/judged by its stage/)
      await expect(needs.judgeTicket(lane.id, verdict, HUMAN)).rejects.toThrow(/judged by its stage/)
      const res = await approval(lane.id, verdict)
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/move it to Approved, Done or Cancelled/)
    }
    expect(unchanged()).toEqual(before)

    // A lane is moved to a stage instead.
    expect(features.updateTicket(lane.id, { status: 'approved' }, HUMAN)).toMatchObject({
      status: 'approved',
      approvedAt: null,
    })
  })

  it('keeps the approval of a PR review, a lane of the review queue tagged PR', async () => {
    const pid = newProject('lane-pr-approval')
    const parent = features.createTicket(pid, { title: 'Parent' }, HUMAN)
    const lane = features.createTicket(
      pid,
      { title: 'Lane', parentId: parent.id, tags: ['PR'], status: 'review' },
      'claude',
    )
    expect((await approval(lane.id, 'approved')).body).toMatchObject({
      status: 'done',
      closedByApproval: true,
    })
    expect((await approval(lane.id, null)).body).toMatchObject({ status: 'review', approvedAt: null })
  })

  it('still lets the human approve and take back a top-level ticket over HTTP', async () => {
    const pid = newProject('ticket-approval')
    const t = features.createTicket(pid, { title: 'Feature', status: 'review' }, 'claude')
    const approved = await approval(t.id, 'approved')
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({ status: 'approved', approvedBy: HUMAN })
    const back = await approval(t.id, null)
    expect(back.body).toMatchObject({ status: 'review', approvedAt: null })
    const rejected = await approval(t.id, 'disapproved')
    expect(rejected.body).toMatchObject({ status: 'cancelled', disapprovedBy: HUMAN })
  })

  it('counts a parent’s lanes by stage only, and its lane entries carry no call', () => {
    const pid = newProject('lane-counts')
    const parent = features.createTicket(pid, { title: 'Parent' }, HUMAN)
    const a = features.createTicket(pid, { title: 'a', parentId: parent.id }, 'claude')
    features.createTicket(pid, { title: 'b', parentId: parent.id, status: 'review' }, 'claude')
    features.updateTicket(a.id, { status: 'cancelled' }, HUMAN)
    const row = features.listTickets(pid, { parentId: null }).find((t) => t.id === parent.id)!
    expect(row.lanes).toEqual({ total: 2, byStage: { cancelled: 1, review: 1 } })
    const lanes = features.getTicketFull(parent.id).lanes
    expect(lanes).toHaveLength(2)
    for (const lane of lanes)
      for (const key of ['approvedAt', 'approvedBy', 'disapprovedAt', 'disapprovedBy'])
        expect(lane).not.toHaveProperty(key)
  })
})

describe('the texts agents read', () => {
  const served = async () => {
    const { handleMcp } = await import('./mcp')
    let id = 0
    const call = async (method: string, params: Record<string, unknown> = {}) => {
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
    const instructions: string = (
      await call('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      })
    )?.instructions
    const tools = (await call('tools/list')).tools as { name: string; description: string }[]
    return { instructions, tools: tools.map((t) => t.description) }
  }

  it('say a lane is judged by its stage, with no lane verdict or lane approval counts', async () => {
    const { instructions, tools } = await served()
    const { renderSkill } = await import('./agents')
    const kindText = read(path.join(import.meta.dirname, 'kindText.ts'))
    const texts: Record<string, string> = {
      'board.md': read(path.join(import.meta.dirname, 'skill', 'board.md')),
      'the rendered skill': renderSkill('claude'),
      'AGENTS.md': read(path.join(repoRoot, 'AGENTS.md')),
      'the MCP instructions': instructions,
      'the MCP tools': tools.join('\n'),
      'kindText.ts': kindText,
    }
    for (const [name, text] of Object.entries(texts)) {
      const one = flat(text)
      expect(one, name).not.toMatch(/lanes\.approved|lanes\.disapproved/)
      expect(one, name).not.toMatch(/an approved lane is settled/i)
      expect(one, name).not.toMatch(/lane counts \(total, approved/)
      expect(one, name).not.toMatch(/lanes with their last progress post and verdict/)
      expect(one, name).not.toMatch(/verdict on a lane or ticket/)
    }
    for (const name of ['board.md', 'AGENTS.md'])
      expect(flat(texts[name]!), name).toContain('A lane has no verdict: its stage is the call')
    // The top-level call is still described.
    for (const name of ['board.md', 'AGENTS.md'])
      expect(flat(texts[name]!), name).toContain('top-level ticket')
  })
})
