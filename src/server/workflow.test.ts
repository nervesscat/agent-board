import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-'))

const HUMAN = 'tester'
const AGENT = 'claude'

let dbm: typeof import('#/db')
let features: typeof import('./features')
let handle: (request: Request) => Promise<Response>
beforeAll(async () => {
  dbm = await import('#/db')
  features = await import('./features')
  ;(await import('./actors')).noteActor(HUMAN, 'human')
  const { api } = await import('./api')
  const { api: guard } = await import('./http')
  // As the server answers: an HttpError becomes its status with `{error}`. A bearer token is an agent.
  const guarded = guard(({ request }: { request: Request }) =>
    api.handle(request, request.headers.has('authorization') ? AGENT : HUMAN),
  )
  handle = (request) => guarded({ request })
})

async function call(method: string, pathname: string, body?: unknown, as: 'human' | 'agent' = 'human') {
  const res = await handle(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(as === 'agent' ? { authorization: 'Bearer gate_test' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as any }
}

let rpcId = 0
/** An MCP tool call as the agent: its parsed result, or `{error}` with the message of a refused call. */
async function tool(name: string, args: Record<string, unknown>) {
  const { handleMcp } = await import('./mcp')
  const res = await handleMcp(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer gate_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    AGENT,
  )
  const result = ((await res.json()) as { result: any }).result as {
    isError?: boolean
    content: { text: string }[]
  }
  return result.isError ? { error: result.content[0]!.text } : JSON.parse(result.content[0]!.text)
}

let projects = 0
/** A project with one repo (a ticket needs one to be created; the path need not exist). */
const newProject = async (kinds?: string[]) => {
  const id = (await call('POST', '/api/projects', { name: `wf${++projects}`, ...(kinds ? { kinds } : {}) }))
    .body.id as number
  if (!kinds)
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: id, name: 'app', repoPath: `/r/wf${projects}`, githubRepo: 'acme/app' })
      .run()
  return id
}

const ticket = (projectId: number, complexity: 'low' | 'mid' | 'high' | 'max' = 'mid', extra = {}) =>
  features.createTicket(projectId, { title: 'work', complexity, ...extra }, HUMAN)

const STANDARD = [
  'claim',
  'spec',
  'build',
  'gate',
  'review',
  'preview',
  'intent',
  'push',
  'pr',
  'ci',
  'summary',
  'handoff',
]
const ids = (steps: { id: string; skipped: unknown }[]) => steps.filter((s) => !s.skipped).map((s) => s.id)

describe('a project that never opened the workflow (B2)', () => {
  it('reads as Standard with no tweaks and no ticket override, as before the columns', async () => {
    const pid = await newProject()
    // Rows written before the columns existed read their defaults: the column default, null and null.
    const row = dbm.db.select().from(dbm.schema.projects).where(eq(dbm.schema.projects.id, pid)).get()!
    expect(row.workflowPreset).toBe('standard')
    expect(row.workflowTweaks).toBeNull()
    const t = ticket(pid)
    expect(t.workflowPreset).toBeNull()
    const effective = (await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`)).body
    expect(effective.preset).toBe('standard')
    expect(effective.source).toBe('project')
    expect(ids(effective.steps)).toEqual(STANDARD)
    expect(effective.rounds).toEqual({ low: 0, mid: 1, high: 3, max: 10 })
  })
})

describe('the project workflow routes (C1 to C5)', () => {
  it('answers the active preset and all four presets with their steps as a tree (C1)', async () => {
    const pid = await newProject()
    const res = await call('GET', `/api/projects/${pid}/workflow`)
    expect(res.status).toBe(200)
    expect(res.body.active).toBe('standard')
    expect(res.body.presets.map((p: { id: string }) => p.id)).toEqual([
      'light',
      'standard',
      'thorough',
      'maximum',
    ])
    for (const p of res.body.presets) {
      expect(p.tweaked).toBe(false)
      expect(p.tweaks).toBeNull()
      expect(p.label).toBeTruthy()
      expect(p.description).toBeTruthy()
    }
    const standard = res.body.presets.find((p: { id: string }) => p.id === 'standard')
    expect(standard.rounds).toEqual({ low: 0, mid: 1, high: 3, max: 10 })
    expect(standard.steps.map((s: { id: string }) => s.id)).toEqual(STANDARD)
    const review = standard.steps.find((s: { id: string }) => s.id === 'review')
    expect(review.review.phases.map((p: { id: string }) => p.id)).toEqual([
      'review.spec',
      'review.env',
      'review.verify',
      'review.hunt-a',
      'review.hunt-b',
      'review.refute',
      'review.merge',
    ])
  })

  it('sets the active preset for the human, refuses an agent and an unknown preset, and shows it in the project (C2)', async () => {
    const pid = await newProject()
    expect((await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'thorough' }, 'agent')).status).toBe(
      403,
    )
    const bad = await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'mega' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('light, standard, thorough, maximum')
    const set = await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'thorough' })
    expect(set.status).toBe(200)
    expect(set.body.active).toBe('thorough')
    expect((await call('GET', `/api/projects/${pid}/workflow`)).body.active).toBe('thorough')
    expect((await call('GET', `/api/projects/${pid}`)).body.workflowPreset).toBe('thorough')
    expect((await tool('get_project', { projectId: pid })).workflowPreset).toBe('thorough')
    expect((await tool('get_project', { projectId: pid })).workflowTweaks).toBeNull()
  })

  it('saves order, switches, efforts, instructions and rounds, and shows them as tweaked (C3)', async () => {
    const pid = await newProject()
    const order = [...STANDARD]
    ;[order[4], order[5]] = [order[5]!, order[4]!]
    const body = {
      order,
      steps: {
        ci: { enabled: false },
        build: { effort: 'high', instructions: 'Hand the diff over.' },
      },
      rounds: { mid: 2 },
    }
    expect((await call('PUT', `/api/projects/${pid}/workflow/standard`, body, 'agent')).status).toBe(403)
    const saved = await call('PUT', `/api/projects/${pid}/workflow/standard`, body)
    expect(saved.status).toBe(200)
    const standard = saved.body.presets.find((p: { id: string }) => p.id === 'standard')
    expect(standard.tweaked).toBe(true)
    expect(standard.tweaks).toEqual(body)
    expect(standard.rounds.mid).toBe(2)
    expect(standard.steps.map((s: { id: string }) => s.id)).toEqual(order)
    const read = (await call('GET', `/api/projects/${pid}/workflow`)).body.presets.find(
      (p: { id: string }) => p.id === 'standard',
    )
    expect(read.tweaks).toEqual(body)
    expect((await tool('get_project', { projectId: pid })).workflowTweaks).toEqual({ standard: body })
    // The others are as shipped.
    expect(
      (await call('GET', `/api/projects/${pid}/workflow`)).body.presets
        .filter((p: { id: string }) => p.id !== 'standard')
        .every((p: { tweaked: boolean }) => !p.tweaked),
    ).toBe(true)
  })

  it.each([
    [
      'a locked step turned off',
      { steps: { push: { enabled: false } } },
      'push is locked: it cannot be turned off',
    ],
    ['an unknown step', { steps: { nope: {} } }, 'steps: unknown step "nope"'],
    [
      'a step the preset does not have',
      { steps: { spec2: {} } },
      'steps: spec2 is not a step of the Standard workflow',
    ],
    [
      'an order that breaks a dependency',
      {
        order: [
          'claim',
          'build',
          'spec',
          'gate',
          'review',
          'preview',
          'intent',
          'push',
          'pr',
          'ci',
          'summary',
          'handoff',
        ],
      },
      'build must come after spec',
    ],
    ['rounds past the limit', { rounds: { mid: 13 } }, 'rounds.mid: a whole number from 0 to 12'],
    [
      'an effort that is not one',
      { steps: { build: { effort: 'max' } } },
      'steps.build.effort: one of auto, low, medium, high',
    ],
    [
      'instructions past the limit',
      { steps: { build: { instructions: 'x'.repeat(4001) } } },
      'steps.build.instructions: at most 4000 characters',
    ],
    ['an unknown key', { colour: 1 }, 'unknown key "colour"'],
  ])('refuses %s with the rule’s words and saves nothing (C3)', async (_, body, message) => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { high: 4 } })
    const res = await call('PUT', `/api/projects/${pid}/workflow/standard`, body)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain(message)
    const standard = (await call('GET', `/api/projects/${pid}/workflow`)).body.presets.find(
      (p: { id: string }) => p.id === 'standard',
    )
    expect(standard.tweaks).toEqual({ rounds: { high: 4 } })
  })

  it('refuses an unknown preset in the path', async () => {
    const pid = await newProject()
    expect((await call('PUT', `/api/projects/${pid}/workflow/mega`, {})).status).toBe(400)
    expect((await call('DELETE', `/api/projects/${pid}/workflow/mega`)).status).toBe(400)
  })

  it('replaces a preset’s tweaks on a second save, and leaves the other presets alone (C4)', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/light`, { rounds: { high: 5 } })
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { mid: 2 } })
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { steps: { ci: { enabled: false } } })
    const presets = (await call('GET', `/api/projects/${pid}/workflow`)).body.presets
    const by = (id: string) => presets.find((p: { id: string }) => p.id === id)
    expect(by('standard').tweaks).toEqual({ steps: { ci: { enabled: false } } })
    expect(by('standard').rounds.mid).toBe(1)
    expect(by('light').tweaks).toEqual({ rounds: { high: 5 } })
  })

  it('keeps nothing of a save that changes nothing', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { mid: 2 } })
    const res = await call('PUT', `/api/projects/${pid}/workflow/standard`, {
      rounds: { mid: 1 },
      order: STANDARD,
    })
    expect(res.body.presets.find((p: { id: string }) => p.id === 'standard').tweaked).toBe(false)
    expect((await call('GET', `/api/projects/${pid}`)).body.workflowTweaks).toBeNull()
  })

  it('resets one preset, is idempotent, and is the human’s (C5)', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { mid: 2 } })
    await call('PUT', `/api/projects/${pid}/workflow/maximum`, { rounds: { mid: 4 } })
    expect((await call('DELETE', `/api/projects/${pid}/workflow/standard`, undefined, 'agent')).status).toBe(
      403,
    )
    for (let i = 0; i < 2; i++) {
      const res = await call('DELETE', `/api/projects/${pid}/workflow/standard`)
      expect(res.status).toBe(200)
      const by = (id: string) => res.body.presets.find((p: { id: string }) => p.id === id)
      expect(by('standard').tweaked).toBe(false)
      expect(by('standard').rounds.mid).toBe(1)
      expect(by('maximum').tweaks).toEqual({ rounds: { mid: 4 } })
    }
  })
})

describe('the effective workflow (C6, C7, C9, D1 to D3)', () => {
  it('is the ticket’s own preset when it names one, else the project’s, for its complexity (C6)', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'thorough' })
    const plain = ticket(pid, 'mid')
    const own = ticket(pid, 'high', { workflowPreset: 'light' })
    const low = ticket(pid, 'low')
    const get = async (id?: number) =>
      (await call('GET', `/api/projects/${pid}/workflow/effective${id ? `?ticketId=${id}` : ''}`)).body
    const a = await get(plain.id)
    expect([a.preset, a.source, a.projectPreset, a.complexity]).toEqual([
      'thorough',
      'project',
      'thorough',
      'mid',
    ])
    expect(a.steps.find((s: { id: string }) => s.id === 'review').review.rounds).toBe(2)
    const b = await get(own.id)
    expect([b.preset, b.source, b.projectPreset, b.complexity, b.ticketId]).toEqual([
      'light',
      'ticket',
      'thorough',
      'high',
      own.id,
    ])
    expect(b.steps.find((s: { id: string }) => s.id === 'review').review.rounds).toBe(2)
    expect(ids(b.steps)).not.toContain('spec')
    const c = await get(low.id)
    expect(c.steps.filter((s: { skipped: unknown }) => s.skipped).map((s: { id: string }) => s.id)).toEqual([
      'spec',
      'tests',
      'review',
    ])
    // No ticket: the project's workflow with the rounds table.
    const d = await get()
    expect([d.preset, d.source, d.complexity, d.ticketId]).toEqual(['thorough', 'project', null, null])
    expect(d.rounds).toEqual({ low: 0, mid: 2, high: 4, max: 11 })
    // A ticket of another project is refused, and so is one that is not there.
    const other = await newProject()
    expect((await call('GET', `/api/projects/${other}/workflow/effective?ticketId=${plain.id}`)).status).toBe(
      403,
    )
    expect((await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=99999`)).status).toBe(404)
  })

  it('carries the tweaks into the structure and the text (C7)', async () => {
    const pid = await newProject()
    const order = [...STANDARD]
    ;[order[4], order[5]] = [order[5]!, order[4]!]
    await call('PUT', `/api/projects/${pid}/workflow/standard`, {
      order,
      steps: {
        ci: { enabled: false },
        build: { effort: 'high', instructions: 'Hand the diff and the criteria table over.' },
      },
      rounds: { mid: 2 },
    })
    const t = ticket(pid, 'mid')
    const w = (await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`)).body
    expect(w.tweaked).toBe(true)
    expect(w.steps.map((s: { id: string }) => s.id)).toEqual(order)
    expect(w.steps.find((s: { id: string }) => s.id === 'ci').skipped.note).toBe(
      'skipped: turned off on the Workflow page',
    )
    expect(w.steps.find((s: { id: string }) => s.id === 'build').effortLevel).toBe('high')
    expect(w.steps.find((s: { id: string }) => s.id === 'review').review.rounds).toBe(2)
    expect(w.text).toContain('Review: up to 2 rounds.')
    expect(w.text).toContain('## 5. Preview - you')
    expect(w.text).toContain('## 6. Review - agent /feature-review')
    expect(w.text).toContain('- CI - skipped: turned off on the Workflow page')
    expect(w.text).toContain('## 3. Build [locked] - agent `builder`, effort high')
    expect(w.text).toContain('Hand-off: Hand the diff and the criteria table over. (set by the human)')
    expect(w.text).not.toContain('gh pr checks')
  })

  it('reads the database on each call: a change shows in the next read (C9)', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'mid')
    const first = await tool('get_workflow', { projectId: pid, ticketId: t.id })
    expect(first.preset).toBe('standard')
    await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'maximum' })
    const second = await tool('get_workflow', { projectId: pid, ticketId: t.id })
    expect(second.preset).toBe('maximum')
    expect(second.text).not.toBe(first.text)
    await call('PATCH', `/api/tickets/${t.id}`, { workflowPreset: 'light' })
    expect((await tool('get_workflow', { projectId: pid, ticketId: t.id })).preset).toBe('light')
    await call('PATCH', `/api/tickets/${t.id}`, { workflowPreset: null })
    expect((await tool('get_workflow', { projectId: pid, ticketId: t.id })).preset).toBe('maximum')
  })

  it('serves the text an agent follows: Standard, a mid ticket (D1, D2)', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'mid')
    const w = await tool('get_workflow', { projectId: pid, ticketId: t.id })
    expect(w.text.startsWith("# Workflow: Standard (the project's workflow)")).toBe(true)
    expect(w.text).toContain('Complexity: mid. Review: up to 1 round.')
    const headings = w.text.match(/^## \d+\. .*$/gm) as string[]
    expect(headings.map((h) => h.replace(/^## (\d+)\. (.*?)(?: \[| - ).*$/, '$1 $2'))).toEqual([
      '1 Read and claim',
      '2 Spec',
      '3 Build',
      '4 Gate',
      '5 Review',
      '6 Preview',
      '7 Intent check',
      '8 Push',
      '9 Pull request',
      '10 CI',
      '11 Summary',
      '12 Hand-off',
    ])
    expect(w.text).toContain('## 1. Read and claim [locked] - you')
    expect(w.text).toContain('## 2. Spec - agent `spec`, effort medium')
    expect(w.text).toContain('## 5. Review - agent /feature-review, effort medium')
    expect(w.text).toContain('## 7. Intent check [locked above low] - agent `intent`, effort low')
    expect(w.text).toContain('rounds: 1. Each round runs these phases, none skipped:')
    for (const phase of [
      '5.1 Spec - `spec`',
      '5.2 Environment - `env`',
      '5.3 Verify - `verify` (in parallel with 5.4, 5.5)',
      '5.4 Hunt A - `hunt`',
      '5.5 Hunt B - `hunt`',
      '5.6 Refute - `refute`',
      '5.7 Merge check - `merge`',
    ])
      expect(w.text).toContain(phase)
    expect(w.text).toContain('Between rounds: fix pass (`builder`) -> gate (you) -> the next round.')
    expect(w.text).toContain('phases=spec,env,verify,hunt,hunt,refute,merge effort=medium round=<n>')
    expect(w.text).toContain('Survives when: the verdict is SHIP')
    // The structured answer carries the same steps.
    expect(w.steps).toHaveLength(12)
    expect(w.steps.find((s: { id: string }) => s.id === 'review').review.rounds).toBe(1)
  })

  it('lists what a low ticket skips as skipped, not as steps (D2)', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'low')
    const w = await tool('get_workflow', { projectId: pid, ticketId: t.id })
    expect(w.text).toContain('Complexity: low. Review: none for this ticket.')
    expect(w.text).toContain('- Spec - skipped: low ticket')
    expect(w.text).toContain('- Review - skipped: low ticket (no review rounds)')
    expect(w.text.match(/^## \d+\. /gm)).toHaveLength(10)
    expect(w.text).toContain('## 3. Gate [locked] - you')
    expect(w.text).toContain('## 5. Intent check [locked above low] - agent `intent`, effort low')
  })

  it('includes each step’s procedure, so the skill can drop it (D3)', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'mid')
    const w = await tool('get_workflow', { projectId: pid, ticketId: t.id })
    for (const phrase of [
      'git -C REPO worktree add',
      'cp -al',
      '01-spec.md',
      '02-build.md',
      'depth.md',
      'gh pr checks',
      'missingReviewPhases',
      'ledger.jsonl',
      'The change **survives** a round when',
      'ONE more full review round',
      'post_review_result',
    ])
      expect(w.text, phrase).toContain(phrase)
    // Each step's "how it runs" comes after its own heading.
    expect(w.text.indexOf('How it runs:')).toBeGreaterThan(w.text.indexOf('## 1. Read and claim'))
  })

  it('serves each preset’s own review text', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'high')
    const text = async (preset: string) => {
      await call('PUT', `/api/projects/${pid}/workflow`, { preset })
      return (await tool('get_workflow', { projectId: pid, ticketId: t.id })).text as string
    }
    const light = await text('light')
    expect(light).toContain('phases=reviewer effort=medium round=<n>')
    expect(light).toContain("This workflow's review is one reviewer")
    expect(light).not.toContain('Hunt B')
    expect(light).not.toContain('Spec - agent `spec`')
    const thorough = await text('thorough')
    expect(thorough).toContain('phases=spec,env,verify,hunt,hunt,hunt-security,refute,merge')
    expect(thorough).toContain('Test-writing pass')
    expect(thorough).toContain('third hunt with the security checklist')
    const maximum = await text('maximum')
    expect(maximum).toContain('Second spec (independent)')
    expect(maximum).toContain('Second review (different agent)')
    expect(maximum).toContain('## 3. Second spec (independent) - agent `spec`, effort high')
    expect(maximum).toContain('agent suffix `second`')
    expect(maximum).toContain('reviews every round twice, by different agents')
  })
})

describe('the ticket’s own workflow (C8, G3)', () => {
  it('is set on create and update with a preset id or null, and anything else is a 400 (C8)', async () => {
    const pid = await newProject()
    const made = await call('POST', `/api/projects/${pid}/tickets`, { title: 'a', workflowPreset: 'maximum' })
    expect(made.status).toBe(201)
    expect(made.body.workflowPreset).toBe('maximum')
    expect((await call('GET', `/api/tickets/${made.body.id}`)).body.workflowPreset).toBe('maximum')
    const plain = (await call('POST', `/api/projects/${pid}/tickets`, { title: 'b' })).body
    expect(plain.workflowPreset).toBeNull()
    const patched = await call('PATCH', `/api/tickets/${plain.id}`, { workflowPreset: 'light' })
    expect(patched.body.workflowPreset).toBe('light')
    expect(
      (await call('PATCH', `/api/tickets/${plain.id}`, { workflowPreset: null })).body.workflowPreset,
    ).toBeNull()
    for (const bad of ['mega', 3, '']) {
      expect((await call('PATCH', `/api/tickets/${plain.id}`, { workflowPreset: bad })).status).toBe(400)
      expect(
        (await call('POST', `/api/projects/${pid}/tickets`, { title: 'c', workflowPreset: bad })).status,
      ).toBe(400)
    }
    // An agent may set it on a ticket, as it may the complexity.
    const viaMcp = await tool('update_ticket', { ticketId: plain.id, workflowPreset: 'thorough' })
    expect(viaMcp.workflowPreset).toBe('thorough')
    const created = await tool('create_ticket', { projectId: pid, title: 'd', workflowPreset: 'light' })
    expect(created.workflowPreset).toBe('light')
    expect((await tool('update_ticket', { ticketId: plain.id, workflowPreset: 'mega' })).error).toBeTruthy()
  })

  it('is copied by a lane created without one, and not by one that names its own (C8)', async () => {
    const pid = await newProject()
    const parent = ticket(pid, 'mid', { workflowPreset: 'thorough' })
    const lane = (await call('POST', `/api/projects/${pid}/tickets`, { title: 'lane', parentId: parent.id }))
      .body
    expect(lane.workflowPreset).toBe('thorough')
    const own = (
      await call('POST', `/api/projects/${pid}/tickets`, {
        title: 'lane 2',
        parentId: parent.id,
        workflowPreset: 'light',
      })
    ).body
    expect(own.workflowPreset).toBe('light')
    // A later change to the parent does not reach the lane.
    await call('PATCH', `/api/tickets/${parent.id}`, { workflowPreset: null })
    expect((await call('GET', `/api/tickets/${lane.id}`)).body.workflowPreset).toBe('thorough')
  })

  it('does not move when the project’s workflow changes, and follows it again once cleared (G3)', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'mid', { workflowPreset: 'light' })
    const preset = async () => (await tool('get_workflow', { projectId: pid, ticketId: t.id })).preset
    expect(await preset()).toBe('light')
    await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'maximum' })
    expect(await preset()).toBe('light')
    await call('PATCH', `/api/tickets/${t.id}`, { workflowPreset: null })
    expect(await preset()).toBe('maximum')
  })
})

describe('a project with no software kind (D5)', () => {
  it('is refused with a plain message by every workflow route and by get_workflow', async () => {
    const pid = await newProject(['music'])
    const t = ticket(pid, 'low')
    const message = 'the workflow module is for software projects'
    for (const [method, route, body] of [
      ['GET', `/api/projects/${pid}/workflow`, undefined],
      ['GET', `/api/projects/${pid}/workflow/effective`, undefined],
      ['GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`, undefined],
      ['PUT', `/api/projects/${pid}/workflow`, { preset: 'light' }],
      ['PUT', `/api/projects/${pid}/workflow/light`, {}],
      ['DELETE', `/api/projects/${pid}/workflow/light`, undefined],
    ] as const) {
      const res = await call(method, route, body)
      expect(res.status, route).toBe(400)
      expect(res.body.error).toContain(message)
    }
    expect((await tool('get_workflow', { projectId: pid })).error).toContain(message)
  })

  it('is not offered get_workflow or workflowPreset on a connection that names it', async () => {
    const pid = await newProject(['music'])
    const { handleMcp } = await import('./mcp')
    const res = await handleMcp(
      new Request(`http://localhost/api/mcp?project=${pid}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      AGENT,
    )
    const tools = ((await res.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } })
      .result.tools
    expect(tools.map((t) => t.name)).not.toContain('get_workflow')
    expect(JSON.stringify(tools.find((t) => t.name === 'create_ticket')!.inputSchema)).not.toContain(
      'workflowPreset',
    )
    expect(JSON.stringify(tools.find((t) => t.name === 'update_ticket')!.inputSchema)).not.toContain(
      'workflowPreset',
    )
  })
})

describe('the tool and its route (D1, D4)', () => {
  it('is listed with a route, and the software tools take workflowPreset', async () => {
    const { TOOL_ROUTES } = await import('./skill/rest')
    expect(TOOL_ROUTES.get_workflow).toBe('GET /api/projects/:id/workflow/effective?ticketId=')
    const { handleMcp } = await import('./mcp')
    const res = await handleMcp(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer gate_test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      AGENT,
    )
    const tools = (
      (await res.json()) as {
        result: { tools: { name: string; description: string; inputSchema: unknown }[] }
      }
    ).result.tools
    const by = (name: string) => tools.find((t) => t.name === name)!
    expect(by('get_workflow').description).toContain('Run exactly those steps in that order')
    expect(by('get_project').description).toContain('workflowPreset')
    expect(by('get_project').description).toContain('get_workflow')
    for (const name of ['create_ticket', 'update_ticket'])
      expect(JSON.stringify(by(name).inputSchema)).toContain('workflowPreset')
  })

  it('answers the same structure over MCP and REST', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'high')
    const rest = (await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`)).body
    expect(await tool('get_workflow', { projectId: pid, ticketId: t.id })).toEqual(rest)
  })
})
