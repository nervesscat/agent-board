import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-'))

const HUMAN = 'tester'
const AGENT = 'claude'

const flat = (text: string) => text.replace(/\s+/g, ' ')

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

/** A Team agent of the project, as the Team page adds one; its id. */
const agent = async (projectId: number, name: string, instructions = `You are ${name}.`) =>
  (await call('POST', `/api/projects/${projectId}/agents`, { name, instructions })).body.id as number
/** The step or phase with this id in a resolved workflow (a step, or a phase of its review). */
const nodeOf = (w: any, id: string) => {
  const all = (list: any[]): any[] => list.flatMap((s) => [s, ...all(s.children ?? [])])
  const review = w.steps.find((s: { id: string }) => s.id === 'review')?.review
  return [...w.steps, ...(review ? all([...review.phases, ...review.between]) : [])].find(
    (s: { id: string }) => s.id === id,
  )
}

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

  it('saves order, switches, efforts, Team agents and rounds, and shows them as tweaked (C3)', async () => {
    const pid = await newProject()
    await agent(pid, 'acme-dev')
    const order = [...STANDARD]
    ;[order[4], order[5]] = [order[5]!, order[4]!]
    const body = {
      order,
      steps: {
        ci: { enabled: false },
        build: { effort: 'high' },
      },
      agents: { build: 'acme-dev' },
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
      "a step's instruction text (A1)",
      { steps: { build: { instructions: 'x' } } },
      'steps.build: unknown key "instructions" (enabled and effort)',
    ],
    ['a coordinate on a step (A2)', { steps: { spec: { x: 1 } } }, 'steps.spec: unknown key "x"'],
    ['a position (A2)', { position: { spec: [1, 2] } }, 'unknown key "position"'],
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
        build: { effort: 'high' },
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
    expect(w.text).toContain('## 6. Review - agent /feature-review, effort')
    expect(w.text).toContain('- CI - skipped: turned off on the Workflow page')
    expect(w.text).toContain('## 3. Build [locked] - built-in `builder`, effort high')
    expect(w.text).toContain(`Hand-off: ${nodeOf(w, 'build').handoff}`)
    expect(w.text).not.toContain('gh pr checks')
  })

  it('shows any preset for any complexity when no ticket is named: the text of a ticket that follows it', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/light`, { rounds: { mid: 2 } })
    const view = async (query: string) => await call('GET', `/api/projects/${pid}/workflow/effective${query}`)
    const light = (await view('?preset=light&complexity=mid')).body
    expect([light.preset, light.source, light.projectPreset, light.complexity]).toEqual([
      'light',
      'ticket',
      'standard',
      'mid',
    ])
    expect(light.steps.find((s: { id: string }) => s.id === 'review').review.rounds).toBe(2)
    expect(light.text).toContain("# Workflow: Light (set on the ticket; the project's workflow is Standard)")
    expect(light.text).toContain('Review: up to 2 rounds.')
    // The project's own preset reads as the project's workflow, exactly as get_workflow serves it.
    const own = (await view('?preset=standard&complexity=low')).body
    expect([own.source, own.complexity]).toEqual(['project', 'low'])
    expect(own.text).toContain("# Workflow: Standard (the project's workflow)")
    const t = ticket(pid, 'low')
    const served = (await view(`?ticketId=${t.id}`)).body
    expect(own.text).toBe(served.text)
    // Neither a preset nor a complexity that does not exist, and not beside a ticket that has its own.
    expect((await view('?preset=huge')).status).toBe(400)
    expect((await view('?complexity=extreme')).status).toBe(400)
    expect((await view(`?ticketId=${t.id}&preset=light`)).status).toBe(400)
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
    expect(w.text).toContain('## 2. Spec - built-in `spec`, effort medium')
    expect(w.text).toContain('## 5. Review - agent /feature-review, effort medium\n')
    // The ticket agent runs the skill itself: no Team agent, no Agent line under this heading.
    const review = w.text.slice(w.text.indexOf('## 5. Review'), w.text.indexOf('## 6.'))
    expect(review).not.toContain('Agent:')
    expect(review).not.toMatch(/run by (built-in|Team agent)/)
    expect(nodeOf(w, 'review').teamAgent).toBeNull()
    expect(w.text).toContain('## 7. Intent check [locked above low] - built-in `intent`, effort low')
    expect(w.text).toContain('rounds: 1. Each round runs these phases, none skipped:')
    for (const phase of [
      '5.1 Spec - built-in `spec`',
      '5.2 Environment - built-in `env`',
      '5.3 Verify - built-in `verify` (in parallel with 5.4, 5.5)',
      '5.4 Hunt A - built-in `hunt`',
      '5.5 Hunt B - built-in `hunt`',
      '5.6 Refute - built-in `refute`',
      '5.7 Merge check - built-in `merge`',
    ])
      expect(w.text).toContain(phase)
    expect(w.text).toContain('Between rounds: fix pass (built-in `builder`) -> gate (you) -> the next round.')
    expect(w.text).toContain(
      'phases=spec,env,verify,hunt,hunt,refute,merge agents=spec,env,verify,hunt,hunt,refute,merge effort=medium round=<n>',
    )
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
    expect(w.text).toContain('## 5. Intent check [locked above low] - built-in `intent`, effort low')
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
    expect(light).toContain('phases=reviewer agents=hunt effort=medium round=<n>')
    expect(light).toContain("This workflow's review is one reviewer")
    expect(light).not.toContain('Hunt B')
    expect(light).not.toContain('Spec - built-in `spec`')
    const thorough = await text('thorough')
    expect(thorough).toContain('phases=spec,env,verify,hunt,hunt,hunt-security,refute,merge')
    expect(thorough).toContain('Test-writing pass')
    expect(thorough).toContain('third hunt with the security checklist')
    const maximum = await text('maximum')
    expect(maximum).toContain('Second spec (independent)')
    expect(maximum).toContain('Second review (different agent)')
    expect(maximum).toContain('## 3. Second spec (independent) - built-in `spec`, effort high')
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

describe('the served step texts of the Thorough and Maximum reviews, and of the switches (fix pass)', () => {
  const effective = async (pid: number, query: string) =>
    (await call('GET', `/api/projects/${pid}/workflow/effective?${query}`)).body.text as string

  it('serves Maximum the whole Thorough review text with its own, so it points at nothing it lacks (C6)', async () => {
    const pid = await newProject()
    const maximum = flat(await effective(pid, 'preset=maximum&complexity=high'))
    const thorough = flat(await effective(pid, 'preset=thorough&complexity=high'))
    const standard = flat(await effective(pid, 'preset=standard&complexity=high'))
    // Thorough's two additions are in Maximum's text, once, ahead of its own.
    expect(maximum).toContain("This workflow's review adds two things to every round.")
    expect(maximum.split('A third hunt with the security checklist').length - 1).toBe(1)
    expect(maximum.indexOf("This workflow's review adds two things")).toBeLessThan(
      maximum.indexOf('This workflow reviews every round twice'),
    )
    expect(maximum).toContain('authorisation of every route and tool the change touches')
    // No reference to a text it is not served.
    expect(maximum).not.toContain('as the Thorough review says')
    expect(maximum).not.toContain('the Thorough additions')
    // Maximum's own text is not served to Thorough, and neither is served to Standard.
    expect(thorough).not.toContain('This workflow reviews every round twice')
    expect(standard).not.toContain('hunt-security')
    expect(standard).not.toContain('adds two things to every round')
  })

  it('states one budget rule for the round-end intent check, and says in the intent step which applies where (C6)', async () => {
    const pid = await newProject()
    for (const preset of ['thorough', 'maximum']) {
      const text = flat(await effective(pid, `preset=${preset}&complexity=mid`))
      expect(text, preset).toContain(
        "**This is the budget rule in this workflow**: it replaces the intent step's rule that a `does not match` is outside the budget",
      )
      expect(text, preset).toContain('the next round is an ordinary round of the budget')
      // The intent step and the review's budget paragraph name when the round-end rule replaces theirs.
      expect(text, preset).toContain(
        'where it says the round-end intent check counts as a round (Thorough and Maximum say so)',
      )
      expect(text, preset).toContain(
        "Where this workflow's review text below says its round-end intent check counts as a round (Thorough and Maximum), that text replaces this sentence",
      )
    }
    const standard = flat(await effective(pid, 'preset=standard&complexity=mid'))
    expect(standard).not.toContain('**This is the budget rule in this workflow**')
    expect(standard).toContain("is outside the complexity's round budget")
  })

  it('has the head start its preview before the round-end intent check, reuses it at the preview step, and keeps the order (C3)', async () => {
    const pid = await newProject()
    for (const preset of ['thorough', 'maximum']) {
      const text = flat(await effective(pid, `preset=${preset}&complexity=mid`))
      // The order is unchanged: review, then preview, then intent.
      const heads = text.match(/## \d+\. [^-]+/g)!.map((h) => h.replace(/^## \d+\. /, '').trim())
      expect(heads.indexOf('Review'), preset).toBeLessThan(heads.indexOf('Preview'))
      expect(heads.indexOf('Preview'), preset).toBeLessThan(heads.indexOf('Intent check [locked above low]'))
      // The review step says the preview of the head comes first, exactly as the preview step starts it.
      expect(text, preset).toContain('**The preview comes first:**')
      expect(text, preset).toContain('you start it now, exactly as the preview step says to start it')
      expect(text, preset).toContain('a head is never built twice for the preview')
      // With the preview step on, nothing says there is none.
      expect(text, preset).not.toContain('there is no preview')
      // The preview step reuses a preview that already runs for the head.
      expect(text, preset).toContain(
        "When a review round's end-of-round intent check already started it for this head",
      )
      expect(text, preset).toContain('reuse it, take only the screenshots still missing and build nothing')
      // The intent step names the same.
      expect(text, preset).toContain(
        "A workflow that checks intent at the end of each review round starts the head's preview before that check, and the preview step then reuses it.",
      )
    }
  })

  it('has a ticket whose review is skipped carry no phases argument, as feature-review’s plan rule expects (C2)', async () => {
    const pid = await newProject()
    const low = await effective(pid, 'preset=standard&complexity=low')
    expect(low).toContain('- Review - skipped')
    expect(low).not.toContain('phases=')
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { mid: 0 } })
    const noRounds = await effective(pid, 'preset=standard&complexity=mid')
    expect(noRounds).toContain('- Review - skipped')
    expect(noRounds).not.toContain('phases=')
    await call('DELETE', `/api/projects/${pid}/workflow/standard`)
    expect(await effective(pid, 'preset=light&complexity=mid')).toContain('phases=reviewer')
  })

  it('lets the Preview and CI switches take effect: the steps are skipped, and the hand-off says it may be open (C7)', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, {
      steps: { ci: { enabled: false }, preview: { enabled: false } },
    })
    const text = flat(await effective(pid, 'preset=standard&complexity=mid'))
    expect(text).toContain('- CI - skipped: turned off on the Workflow page')
    expect(text).toContain('- Preview - skipped: turned off on the Workflow page')
    expect(text).not.toContain('gh pr checks')
    expect(text).not.toContain('Start the preview of this head here')
    expect(text).toContain(
      'This workflow runs no CI step for the ticket (the step is turned off or not part of the workflow): it is not run and not required, its phase may stay open, and the summary says so.',
    )
    expect(text).toContain(
      'This workflow runs no preview step for the ticket (the step is turned off or not part of the workflow): it is not run and not required, its phase may stay open, and the summary says so.',
    )
    expect(text).toContain('The push, the pull request and the summary are never skipped.')
    // The locked steps cannot be turned off.
    for (const step of ['push', 'pr', 'summary']) {
      const res = await call('PUT', `/api/projects/${pid}/workflow/standard`, {
        steps: { [step]: { enabled: false } },
      })
      expect(res.status, step).toBe(400)
    }
    await call('DELETE', `/api/projects/${pid}/workflow/standard`)
  })

  it('makes the push, the hand-off and the summary conditional when the intent check is turned off for a low ticket (C2)', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { steps: { intent: { enabled: false } } })
    const low = flat(await effective(pid, 'preset=standard&complexity=low'))
    // The step is listed as skipped, and every place that asked for its verdict now says it is not required.
    expect(low).toContain('- Intent check - skipped: turned off for low tickets on the Workflow page')
    const skipped =
      'This workflow lists the intent check as skipped for the ticket (a low ticket with the check turned off on the Workflow page): no intent check is run, none is required before the'
    expect(low.split(skipped).length - 1).toBe(2)
    expect(low).toContain('before the push, and the summary says it was turned off on the Workflow page')
    expect(low).toContain('before the hand-off, and the summary says it was turned off on the Workflow page')
    expect(low).toContain('one line saying the intent check was turned off on the Workflow page')
    // The precondition itself is not served for a ticket that has no check.
    expect(low).not.toContain('Only after the intent check returned')
    // Locked above low: the same tweak does not skip it for a mid ticket.
    const mid = flat(await effective(pid, 'preset=standard&complexity=mid'))
    expect(mid).toContain('## 7. Intent check [locked above low] - built-in `intent`, effort low')
    expect(mid).not.toContain('- Intent check - skipped')
    expect(
      mid.split('Only after the intent check returned `matches` on the head being handed off.').length - 1,
    ).toBe(2)
    await call('DELETE', `/api/projects/${pid}/workflow/standard`)
  })

  it('gives Thorough and Maximum an intent hand-off that matches the rule that replaces the default (C6)', async () => {
    const pid = await newProject()
    const outside = 'goes back to the builder, the gate and one more review, outside the round budget'
    const inBudget =
      'Hand-off: Brief it with only the human\'s words and the result, never the plan, the spec or the findings. "matches" goes on to the push; "does not match" goes back to the builder, the gate and the next review round, an ordinary round of the budget in this workflow; a second one asks the human.'
    for (const preset of ['thorough', 'maximum']) {
      const text = flat(await effective(pid, `preset=${preset}&complexity=mid`))
      expect(text, preset).toContain(inBudget)
      expect(text, preset).not.toContain(outside)
    }
    // Light and Standard keep the default, outside the budget, and the order and locks are not touched.
    for (const preset of ['light', 'standard']) {
      const text = flat(await effective(pid, `preset=${preset}&complexity=mid`))
      expect(text, preset).toContain(outside)
      expect(text, preset).not.toContain('an ordinary round of the budget in this workflow')
    }
    const maximum = await call('GET', `/api/projects/${pid}/workflow/effective?preset=maximum&complexity=mid`)
    const steps = maximum.body.steps as { id: string; lock: string }[]
    const ids = steps.map((x) => x.id)
    expect(ids.slice(ids.indexOf('review'))).toEqual([
      'review',
      'preview',
      'intent',
      'push',
      'pr',
      'ci',
      'summary',
      'handoff',
    ])
    expect(steps.find((x) => x.id === 'intent')!.lock).toBe('above-low')
  })

  it('has the gate and the tests step name what to do with CI turned off and the spec step turned off (C9)', async () => {
    const pid = await newProject()
    const text = flat(await effective(pid, 'preset=thorough&complexity=mid'))
    expect(text).toContain('and CI green on the final head is required before hand-off. A failure goes back')
    expect(text).not.toContain('this workflow runs no CI step')
    await call('PUT', `/api/projects/${pid}/workflow/thorough`, { steps: { ci: { enabled: false } } })
    const noCi = flat(await effective(pid, 'preset=thorough&complexity=mid'))
    expect(noCi).toContain(
      'GitHub CI runs both on the PR; this workflow runs no CI step for the ticket, so a CI result is not required before hand-off. A failure goes back',
    )
    expect(noCi).not.toContain('CI green on the final head is required')
    await call('PUT', `/api/projects/${pid}/workflow/thorough`, { steps: { spec: { enabled: false } } })
    const noSpec = flat(await effective(pid, 'preset=thorough&complexity=mid'))
    expect(noSpec).toContain('- Spec - skipped: turned off on the Workflow page')
    expect(noSpec).toContain(
      "When the workflow runs no spec step for the ticket (it is skipped, turned off or not part of it) there is no `WORKDIR/01-spec.md`: the ticket's instructions and the acceptance criteria you wrote from them are the spec, as in the build step.",
    )
    await call('DELETE', `/api/projects/${pid}/workflow/thorough`)
  })

  it('has Light’s reviewer get a prepared worktree and an env file, since it has no env phase (C1)', async () => {
    const pid = await newProject()
    const text = flat(await effective(pid, 'preset=light&complexity=mid'))
    expect(text).toContain('phases=reviewer')
    expect(text).toContain(
      "There is no environment phase, so `/feature-review` itself prepares the review worktree before the reviewer starts: it installs or reuses the dependencies there (a hardlink copy of a prepared `node_modules`, never a symlink, or the project's install) and writes a small `00-env.md` with the test command and no servers started, and the reviewer is told the test slots' rule for a heavy run.",
    )
    expect(text).toContain('on a free port it picks, and stops it by its PID before it returns')
    // Light's other rules stay.
    expect(text).toContain('it is not shown a spec file')
    expect(text).toContain('never as a defect')
    expect(text).toContain('This replaces the survival rule above')
  })
})

describe('the workflow no longer edits a step’s text (A1, A4, A8)', () => {
  const standard = async (pid: number) =>
    (await call('GET', `/api/projects/${pid}/workflow`)).body.presets.find(
      (p: { id: string }) => p.id === 'standard',
    )

  it('refuses an instruction on a step and leaves what was saved as it was (A1)', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, { rounds: { high: 4 } })
    const before = await standard(pid)
    const res = await call('PUT', `/api/projects/${pid}/workflow/standard`, {
      steps: { build: { instructions: 'x' } },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('steps.build: unknown key "instructions"')
    const after = await standard(pid)
    expect(after.tweaks).toEqual(before.tweaks)
    expect(after.tweaked).toBe(before.tweaked)
  })

  it('serves the preset’s hand-off wording for every step, whatever is stored, with no "set by the human" (A4)', async () => {
    const pid = await newProject()
    const t = ticket(pid, 'mid')
    const w = (await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`)).body
    for (const step of w.steps) {
      expect(step.handoff).toBeTruthy()
      expect(Object.keys(step.edited).sort()).toEqual(['agent', 'any', 'effort', 'enabled', 'moved'])
      if (!step.skipped) expect(w.text).toContain(`Hand-off: ${step.handoff}\n`)
    }
    expect(w.text).not.toContain('set by the human')
  })

  it('reads a row written with an instruction as if it had none, and does not throw (A8)', async () => {
    const pid = await newProject()
    dbm.db
      .update(dbm.schema.projects)
      .set({
        workflowTweaks: {
          standard: {
            steps: { build: { instructions: 'legacy text', effort: 'high' }, spec: { instructions: 'y' } },
          },
          light: { steps: { intent: { instructions: 'z' } } },
        } as never,
      })
      .where(eq(dbm.schema.projects.id, pid))
      .run()
    const t = ticket(pid, 'mid')
    const res = await call('GET', `/api/projects/${pid}/workflow`)
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('legacy text')
    expect(JSON.stringify(res.body.presets.map((p: { tweaks: unknown }) => p.tweaks))).not.toContain(
      'instructions',
    )
    expect((await standard(pid)).tweaks).toEqual({ steps: { build: { effort: 'high' } } })
    const served = (await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`)).body
    expect(served.text).not.toContain('legacy text')
  })
})

describe('the Team agent of a node (B1 to B4, B6 to B8, B10, B13)', () => {
  const put = (pid: number, preset: string, body: unknown, as: 'human' | 'agent' = 'human') =>
    call('PUT', `/api/projects/${pid}/workflow/${preset}`, body, as)
  const overview = async (pid: number) => (await call('GET', `/api/projects/${pid}/workflow`)).body
  const preset = async (pid: number, id = 'standard') =>
    (await overview(pid)).presets.find((p: { id: string }) => p.id === id)
  const effective = async (pid: number, query: string) =>
    (await call('GET', `/api/projects/${pid}/workflow/effective?${query}`)).body

  it('saves a pick by name, returns it with the step’s Team agent and keeps it across reads (B1)', async () => {
    const pid = await newProject()
    await agent(pid, 'acme-dev')
    const res = await put(pid, 'standard', { agents: { build: 'acme-dev' } })
    expect(res.status).toBe(200)
    for (const body of [res.body, await overview(pid)]) {
      expect(body.team).toEqual(['acme-dev'])
      const standard = body.presets.find((p: { id: string }) => p.id === 'standard')
      expect(standard.tweaks).toEqual({ agents: { build: 'acme-dev' } })
      expect(standard.tweaked).toBe(true)
      const build = standard.steps.find((s: { id: string }) => s.id === 'build')
      expect(build.agent).toBe('builder')
      expect(build.teamAgent).toEqual({
        name: 'acme-dev',
        source: 'picked',
        picked: 'acme-dev',
        missing: false,
      })
      expect(build.edited.agent).toBe(true)
    }
    expect((await tool('get_project', { projectId: pid })).workflowTweaks).toEqual({
      standard: { agents: { build: 'acme-dev' } },
    })
  })

  it('refuses a name that is not in the Team, a node with no agent, an unknown or absent node and a non-name (B2)', async () => {
    const pid = await newProject()
    await agent(pid, 'acme-dev')
    await put(pid, 'standard', { agents: { build: 'acme-dev' } })
    const refused = async (agents: unknown, message: string, status = 400) => {
      const res = await put(pid, 'standard', { agents })
      expect(res.status, JSON.stringify(agents)).toBe(status)
      expect(res.body.error).toContain(message)
      expect((await preset(pid)).tweaks).toEqual({ agents: { build: 'acme-dev' } })
    }
    await refused({ build: 'nobody' }, '"nobody" is not one of the project\'s Team agents')
    for (const node of [
      'claim',
      'gate',
      'preview',
      'push',
      'pr',
      'ci',
      'summary',
      'handoff',
      'review',
      'review.gate',
    ])
      await refused({ [node]: 'acme-dev' }, `${node} runs no agent of its own`)
    await refused({ 'review.reconcile': 'acme-dev' }, 'review.reconcile')
    await refused({ foo: 'acme-dev' }, 'unknown node "foo"')
    await refused({ 'review.nope': 'acme-dev' }, 'unknown node "review.nope"')
    await refused({ spec2: 'acme-dev' }, 'spec2 is not a step of the Standard workflow')
    await refused({ build: 5 }, 'agents.build')
    await refused({ build: ['acme-dev'] }, 'agents.build')
    await refused('acme-dev', 'agents: an object keyed by node id')
    // An agent token may read the workflow but not change it.
    expect((await put(pid, 'standard', { agents: { build: 'acme-dev' } }, 'agent')).status).toBe(403)
    expect((await call('GET', `/api/projects/${pid}/workflow`, undefined, 'agent')).status).toBe(200)
  })

  it('matches the Team’s names in any casing and stores the Team’s own spelling (B3)', async () => {
    const pid = await newProject()
    await agent(pid, 'acme-dev')
    const res = await put(pid, 'standard', { agents: { build: 'ACME-DEV' } })
    expect(res.status).toBe(200)
    expect((await preset(pid)).tweaks).toEqual({ agents: { build: 'acme-dev' } })
    expect(nodeOf(await preset(pid), 'build').teamAgent.name).toBe('acme-dev')
  })

  it('runs a node as the Team agent named like its role, else the built-in agent of the role (B4)', async () => {
    const pid = await newProject()
    const roles = { spec: 'spec', build: 'builder', intent: 'intent' }
    for (const [id, role] of Object.entries(roles))
      expect(nodeOf(await preset(pid), id).teamAgent, id).toEqual({
        name: role,
        source: 'default',
        picked: null,
        missing: false,
      })
    const phases = {
      'review.env': 'env',
      'review.verify': 'verify',
      'review.hunt-a': 'hunt',
      'review.refute': 'refute',
      'review.merge': 'merge',
      'review.fix': 'builder',
    }
    for (const [id, role] of Object.entries(phases))
      expect(nodeOf(await preset(pid), id).teamAgent.name, id).toBe(role)
    expect(nodeOf(await preset(pid, 'light'), 'review.reviewer').teamAgent.name).toBe('hunt')
    expect(nodeOf(await preset(pid), 'gate').teamAgent ?? null).toBeNull()
    // The review step runs through the Skill in the ticket agent's session: no Team agent, even with one named `runner`.
    expect(nodeOf(await preset(pid), 'review').teamAgent).toBeNull()
    await agent(pid, 'runner')
    expect(nodeOf(await preset(pid), 'review').teamAgent).toBeNull()
    await agent(pid, 'Builder')
    await agent(pid, 'hunt')
    const standard = await preset(pid)
    expect(nodeOf(standard, 'build').teamAgent).toEqual({
      name: 'Builder',
      source: 'role',
      picked: null,
      missing: false,
    })
    expect(nodeOf(standard, 'review.fix').teamAgent.source).toBe('role')
    expect(nodeOf(standard, 'review.hunt-b').teamAgent.name).toBe('hunt')
    expect(nodeOf(standard, 'spec').teamAgent.source).toBe('default')
  })

  it('does not store a pick equal to the default, and the reset clears every pick of the preset only (B6)', async () => {
    const pid = await newProject()
    await agent(pid, 'hunt')
    await agent(pid, 'acme-dev')
    const same = await put(pid, 'standard', { agents: { 'review.hunt-a': 'hunt', 'review.hunt-b': 'HUNT' } })
    expect(same.status).toBe(200)
    expect((await preset(pid)).tweaked).toBe(false)
    expect((await call('GET', `/api/projects/${pid}`)).body.workflowTweaks).toBeNull()
    await put(pid, 'standard', { agents: { build: 'acme-dev' }, rounds: { mid: 2 } })
    await put(pid, 'thorough', { agents: { tests: 'acme-dev' } })
    const reset = await call('DELETE', `/api/projects/${pid}/workflow/standard`)
    expect(reset.status).toBe(200)
    expect(
      nodeOf(
        reset.body.presets.find((p: { id: string }) => p.id === 'standard'),
        'build',
      ).teamAgent.source,
    ).toBe('default')
    expect((await call('GET', `/api/projects/${pid}`)).body.workflowTweaks).toEqual({
      thorough: { agents: { tests: 'acme-dev' } },
    })
    // A body with no pick replaces the saved ones, so it resets them too.
    await put(pid, 'thorough', {})
    expect((await call('GET', `/api/projects/${pid}`)).body.workflowTweaks).toBeNull()
  })

  it('keeps a pick whose agent was renamed or deleted, runs the node as unset and says so, and restores it with the agent (B7)', async () => {
    const pid = await newProject()
    const id = await agent(pid, 'acme-dev')
    await agent(pid, 'builder')
    await put(pid, 'standard', {
      agents: { build: 'acme-dev', 'review.hunt-a': 'acme-dev' },
      rounds: { high: 4 },
    })
    const t = ticket(pid, 'mid')
    const after = async () => {
      const standard = await preset(pid)
      const served = await effective(pid, `ticketId=${t.id}`)
      return { build: nodeOf(standard, 'build'), tweaks: standard.tweaks, served }
    }
    const renamed = await call('PATCH', `/api/agents/${id}`, { name: 'acme-dev2' })
    expect(renamed.status).toBe(200)
    let now = await after()
    expect(now.tweaks).toEqual({
      agents: { build: 'acme-dev', 'review.hunt-a': 'acme-dev' },
      rounds: { high: 4 },
    })
    expect(now.build.teamAgent).toEqual({
      name: 'builder',
      source: 'role',
      picked: 'acme-dev',
      missing: true,
    })
    expect(now.served.text).toContain('[picked `acme-dev` is not in the Team]')
    expect(now.served.text).toContain("the project's Team has no agent of that name")
    expect(nodeOf(now.served, 'review.hunt-a').teamAgent).toMatchObject({ missing: true, picked: 'acme-dev' })
    // Saving the page's other changes back, pick included, is not refused for it.
    const save = await put(pid, 'standard', { ...now.tweaks, steps: { spec: { effort: 'high' } } })
    expect(save.status).toBe(200)
    expect((await preset(pid)).tweaks.agents).toEqual({ build: 'acme-dev', 'review.hunt-a': 'acme-dev' })
    // Renaming back restores it.
    await call('PATCH', `/api/agents/${id}`, { name: 'acme-dev' })
    now = await after()
    expect(now.build.teamAgent).toEqual({
      name: 'acme-dev',
      source: 'picked',
      picked: 'acme-dev',
      missing: false,
    })
    // A delete leaves it missing the same way, and creating the agent again restores it.
    expect((await call('DELETE', `/api/agents/${id}`)).status).toBe(200)
    now = await after()
    expect(now.build.teamAgent.missing).toBe(true)
    expect(now.tweaks.agents.build).toBe('acme-dev')
    expect((await put(pid, 'standard', { agents: { build: 'acme-dev' } })).status).toBe(200)
    await agent(pid, 'Acme-Dev')
    now = await after()
    expect(now.build.teamAgent).toEqual({
      name: 'Acme-Dev',
      source: 'picked',
      picked: 'Acme-Dev',
      missing: false,
    })
  })

  it('serves the Team agent per step and per phase in the structure and in the text, over REST and MCP (B8, B10)', async () => {
    const pid = await newProject()
    await agent(pid, 'acme-dev')
    await agent(pid, 'sec-hunter')
    await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'standard' })
    await put(pid, 'standard', {
      agents: { build: 'acme-dev', 'review.hunt-a': 'sec-hunter', 'review.hunt-b': 'acme-dev' },
    })
    const t = ticket(pid, 'mid')
    const rest = await effective(pid, `ticketId=${t.id}`)
    const mcp = await tool('get_workflow', { projectId: pid, ticketId: t.id })
    expect(mcp).toEqual(rest)
    expect(nodeOf(rest, 'build').teamAgent.name).toBe('acme-dev')
    expect(rest.text).toContain(
      '## 3. Build [locked] - Team agent `acme-dev` (role `builder`), effort medium',
    )
    expect(rest.text).not.toContain('## 3. Build [locked] - built-in')
    expect(rest.text).toContain('5.4 Hunt A - Team agent `sec-hunter` (role `hunt`) (in parallel with')
    expect(rest.text).toContain('5.5 Hunt B - Team agent `acme-dev` (role `hunt`)')
    expect(rest.text).toContain('5.6 Refute - built-in `refute`')
    expect(rest.text).toContain(
      'phases=spec,env,verify,hunt,hunt,refute,merge agents=spec,env,verify,sec-hunter,acme-dev,refute,merge',
    )
    expect(rest.text).toContain('Post its work `as: acme-dev`')
    expect(rest.text).toContain(
      'Name its span, its run report and its `agentName` by the role `builder`, never by `acme-dev`',
    )
    expect(rest.text).toContain(
      "brief its subagent with the instructions of `acme-dev` (`get_project` -> `agents`), the project's `instructions` and the ticket's context",
    )
    // A step that is not bound says which built-in role it runs as, and that it is no Team agent.
    expect(rest.text).toContain(
      'the Team has no agent named `spec`, so this runs as the built-in `spec` role',
    )
    expect(rest.text).toContain('It is no Team agent, so post its work with `progress: true` and no `as`.')
    // The intent agent is briefed with only the human's words and the result, whatever Team agent it is.
    await agent(pid, 'intent')
    const withIntent = await effective(pid, `ticketId=${t.id}`)
    expect(withIntent.text).toContain('besides them, only what the intent step lists')
    // The ticket's own preset carries its own picks.
    await put(pid, 'light', { agents: { build: 'acme-dev' } })
    const own = ticket(pid, 'mid', { workflowPreset: 'light' })
    const light = await effective(pid, `ticketId=${own.id}`)
    expect([light.source, nodeOf(light, 'build').teamAgent.source]).toEqual(['ticket', 'picked'])
    expect(nodeOf(rest, 'build').teamAgent.source).toBe('picked')
  })

  it('takes a pick on each phase of every preset’s review, and none on a group or the ticket agent’s own (B10)', async () => {
    const pid = await newProject()
    await agent(pid, 'sec-hunter')
    const ok = [
      ['standard', 'review.hunt-a'],
      ['standard', 'review.spec'],
      ['standard', 'review.fix'],
      ['light', 'review.reviewer'],
      ['thorough', 'review.intent'],
      ['thorough', 'review.hunt-security'],
      ['maximum', 'review.first.hunt-a'],
      ['maximum', 'review.second.hunt-a'],
      ['maximum', 'review.second.merge'],
      ['maximum', 'spec2'],
    ] as const
    for (const [id, node] of ok) {
      const res = await put(pid, id, { agents: { [node]: 'sec-hunter' } })
      expect(res.status, `${id} ${node}`).toBe(200)
      expect(
        nodeOf(
          res.body.presets.find((p: { id: string }) => p.id === id),
          node,
        ).teamAgent.source,
      ).toBe('picked')
    }
    for (const node of ['review.first', 'review.second', 'review.reconcile', 'review.gate'])
      expect((await put(pid, 'maximum', { agents: { [node]: 'sec-hunter' } })).status, node).toBe(400)
  })

  it('is still refused for a project with no software kind, a pick included (B13)', async () => {
    const pid = await newProject(['music'])
    const res = await put(pid, 'standard', { agents: { build: 'acme-dev' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('the workflow module is for software projects')
  })
})
