import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// The db module opens SQLite at import; point it at a throwaway directory before anything loads it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-custom-'))

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
const newProject = async (kinds?: string[]) => {
  const id = (await call('POST', '/api/projects', { name: `wc${++projects}`, ...(kinds ? { kinds } : {}) }))
    .body.id as number
  if (!kinds)
    dbm.db
      .insert(dbm.schema.repos)
      .values({ projectId: id, name: 'app', repoPath: `/r/wc${projects}`, githubRepo: 'acme/app' })
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
const entry = (overview: any, id: string) => overview.presets.find((p: { id: string }) => p.id === id)

/** Duplicates a workflow into a new custom one over REST; its id. */
async function duplicate(pid: number, name: string, from = 'standard') {
  const res = await call('POST', `/api/projects/${pid}/workflow/custom`, { name, from })
  expect(res.status).toBe(201)
  return res.body.created as string
}
/** The custom workflow's saved step list. */
const orderOf = async (pid: number, id: string) =>
  entry((await call('GET', `/api/projects/${pid}/workflow`)).body, id).order as string[]
const effective = async (pid: string | number, query = '') =>
  (await call('GET', `/api/projects/${pid}/workflow/effective${query}`)).body

describe('making, renaming and deleting a custom workflow', () => {
  it('duplicates a preset into a new workflow listed after the four presets, and the human only', async () => {
    const pid = await newProject()
    const before = (await call('GET', `/api/projects/${pid}/workflow`)).body
    expect(before.presets.map((p: { id: string }) => p.id)).toEqual([
      'light',
      'standard',
      'thorough',
      'maximum',
    ])
    expect(before.presets.every((p: { custom: unknown }) => p.custom === null)).toBe(true)

    const made = await call('POST', `/api/projects/${pid}/workflow/custom`, {
      name: '  Ours  ',
      from: 'light',
    })
    expect(made.status).toBe(201)
    expect(made.body.presets.map((p: { id: string }) => p.id).slice(0, 4)).toEqual([
      'light',
      'standard',
      'thorough',
      'maximum',
    ])
    expect(made.body.presets).toHaveLength(5)
    const mine = made.body.presets[4]
    expect(mine.id).toBe(made.body.created)
    expect(mine.id).toMatch(/^custom-[a-z0-9]{10}$/)
    expect([mine.label, mine.custom, mine.tweaked]).toEqual(['Ours', { base: 'light' }, false])
    expect(mine.order).toEqual(entry(before, 'light').order)
    expect(mine.rounds).toEqual(entry(before, 'light').rounds)
    expect(mine.steps.map((s: { id: string }) => s.id)).toEqual(
      entry(before, 'light').steps.map((s: { id: string }) => s.id),
    )
    // Another project has none of it.
    const other = await newProject()
    expect((await call('GET', `/api/projects/${other}/workflow`)).body.presets).toHaveLength(4)
    // An agent reads but does not write.
    for (const [method, url, body] of [
      ['POST', `/api/projects/${pid}/workflow/custom`, { name: 'Agent', from: 'light' }],
      ['PATCH', `/api/projects/${pid}/workflow/custom/${mine.id}`, { name: 'Agent' }],
      ['DELETE', `/api/projects/${pid}/workflow/custom/${mine.id}`, undefined],
    ] as const)
      expect((await call(method, url, body, 'agent')).status).toBe(403)
    expect((await call('GET', `/api/projects/${pid}/workflow`, undefined, 'agent')).status).toBe(200)
  })

  it('copies what the page shows: a preset with the project’s tweaks on it, and another custom workflow', async () => {
    const pid = await newProject()
    await call('PUT', `/api/projects/${pid}/workflow/standard`, {
      steps: { preview: { enabled: false }, build: { effort: 'high' } },
      rounds: { mid: 4 },
    })
    const a = await duplicate(pid, 'A', 'standard')
    const overview = (await call('GET', `/api/projects/${pid}/workflow`)).body
    const copy = entry(overview, a)
    expect(copy.rounds.mid).toBe(4)
    expect(copy.defaultRounds.mid).toBe(1)
    expect(copy.steps.find((s: { id: string }) => s.id === 'preview').enabled).toBe(false)
    expect(copy.steps.find((s: { id: string }) => s.id === 'build').effort).toBe('high')
    expect(copy.tweaked).toBe(false)
    // Changing the copy leaves the preset and a later copy of the copy independent of both.
    await call('PUT', `/api/projects/${pid}/workflow/${a}`, { rounds: { mid: 2 } })
    const b = await duplicate(pid, 'B', a)
    await call('PUT', `/api/projects/${pid}/workflow/${b}`, { rounds: { mid: 3 } })
    const after = (await call('GET', `/api/projects/${pid}/workflow`)).body
    expect([
      entry(after, 'standard').rounds.mid,
      entry(after, a).rounds.mid,
      entry(after, b).rounds.mid,
    ]).toEqual([4, 2, 3])
    expect(entry(after, b).custom).toEqual({ base: 'standard' })
  })

  it('refuses a bad name, a taken one in any casing, a preset’s and an unknown source, saving nothing', async () => {
    const pid = await newProject()
    await duplicate(pid, 'Ours')
    for (const name of ['', '   ', 'x'.repeat(61), 'ours', 'OURS ', 'Light', 'standard', 7]) {
      const res = await call('POST', `/api/projects/${pid}/workflow/custom`, { name, from: 'light' })
      expect(res.status, String(name)).toBe(400)
      expect(res.body.error).toContain('name')
    }
    const bad = await call('POST', `/api/projects/${pid}/workflow/custom`, {
      name: 'Fine',
      from: 'custom-zzzzzzzzzz',
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('from: one of light, standard, thorough, maximum, custom-')
    expect((await call('POST', `/api/projects/${pid}/workflow/custom`, { name: 'Fine' })).status).toBe(400)
    expect((await call('GET', `/api/projects/${pid}/workflow`)).body.presets).toHaveLength(5)
  })

  it('renames a custom workflow, refuses a taken name, and leaves the presets as they are', async () => {
    const pid = await newProject()
    const a = await duplicate(pid, 'Ours')
    const b = await duplicate(pid, 'Theirs')
    const renamed = await call('PATCH', `/api/projects/${pid}/workflow/custom/${a}`, {
      name: ' Ours, renamed ',
    })
    expect(renamed.status).toBe(200)
    expect(entry(renamed.body, a).label).toBe('Ours, renamed')
    // Its own name again (another casing) is allowed; another workflow's is not.
    expect(
      (await call('PATCH', `/api/projects/${pid}/workflow/custom/${a}`, { name: 'OURS, RENAMED' })).status,
    ).toBe(200)
    expect(
      (await call('PATCH', `/api/projects/${pid}/workflow/custom/${a}`, { name: 'theirs' })).status,
    ).toBe(400)
    expect((await call('PATCH', `/api/projects/${pid}/workflow/custom/${a}`, { name: '' })).status).toBe(400)
    expect((await call('PATCH', `/api/projects/${pid}/workflow/custom/${b}`, { name: 'Light' })).status).toBe(
      400,
    )
    for (const preset of ['light', 'standard', 'thorough', 'maximum']) {
      const res = await call('PATCH', `/api/projects/${pid}/workflow/custom/${preset}`, { name: 'Mine' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(`${preset} is one of the four presets: it cannot be renamed`)
    }
    expect(
      (await call('PATCH', `/api/projects/${pid}/workflow/custom/custom-zzzzzzzzzz`, { name: 'x' })).status,
    ).toBe(404)
  })

  it('deletes a custom workflow and never a preset; a project’s other workflows stay', async () => {
    const pid = await newProject()
    const a = await duplicate(pid, 'Ours')
    const b = await duplicate(pid, 'Theirs')
    for (const preset of ['light', 'standard', 'thorough', 'maximum']) {
      const res = await call('DELETE', `/api/projects/${pid}/workflow/custom/${preset}`)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(`${preset} is one of the four presets: it cannot be deleted`)
    }
    const gone = await call('DELETE', `/api/projects/${pid}/workflow/custom/${a}`)
    expect(gone.status).toBe(200)
    expect(gone.body.presets.map((p: { id: string }) => p.id)).toEqual([
      'light',
      'standard',
      'thorough',
      'maximum',
      b,
    ])
    expect((await call('DELETE', `/api/projects/${pid}/workflow/custom/${a}`)).status).toBe(404)
    // An id is never given out again.
    const c = await duplicate(pid, 'Ours')
    expect([a, b]).not.toContain(c)
  })

  it('is refused for a project with no software kind, like every workflow route', async () => {
    const pid = await newProject(['research'])
    const { WORKFLOW_SOFTWARE_ONLY } = await import('./workflow')
    for (const [method, url, body] of [
      ['POST', `/api/projects/${pid}/workflow/custom`, { name: 'x', from: 'light' }],
      ['PATCH', `/api/projects/${pid}/workflow/custom/custom-abcdef0123`, { name: 'x' }],
      ['DELETE', `/api/projects/${pid}/workflow/custom/custom-abcdef0123`, undefined],
    ] as const) {
      const res = await call(method, url, body)
      expect([res.status, res.body.error]).toEqual([400, WORKFLOW_SOFTWARE_ONLY])
    }
  })
})

describe('the steps of a custom workflow', () => {
  it('adds a kind of step it lacks where it belongs, and the graph, the text and the checks follow', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'light')
    const order = await orderOf(pid, w)
    expect(order).not.toContain('tests')
    const added = await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      order: ['claim', 'build', 'tests', ...order.slice(2)],
    })
    expect(added.status).toBe(200)
    expect(entry(added.body, w).order).toEqual(['claim', 'build', 'tests', 'gate', ...order.slice(3)])
    expect(entry(added.body, w).tweaked).toBe(true)
    expect(entry(added.body, 'light').order).not.toContain('tests')
    const text = (await effective(pid, `?preset=${w}&complexity=mid`)).text as string
    expect(text).toContain('## 3. Test-writing pass')
    expect(text).toContain('# Workflow: Ours (a custom workflow of the project, based on Light')
    // A kind that is not one of the 14 is refused with its name.
    const bad = await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      order: [...order.slice(0, -1), 'deploy', 'handoff'],
    })
    expect([bad.status, bad.body.error]).toEqual([
      400,
      'order: "deploy" is not a kind of step the workflow has',
    ])
  })

  it('removes a step with no lock, drops its settings, and refuses a locked one naming it', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'standard')
    await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      order: STANDARD,
      steps: { preview: { enabled: false }, spec: { effort: 'high' } },
    })
    const without = STANDARD.filter((id) => id !== 'preview' && id !== 'spec')
    const ok = await call('PUT', `/api/projects/${pid}/workflow/${w}`, { order: without, steps: {} })
    expect(ok.status).toBe(200)
    expect(entry(ok.body, w).order).toEqual(without)
    expect(entry(ok.body, w).tweaks.steps).toBeUndefined()
    for (const locked of ['claim', 'build', 'gate', 'intent', 'push', 'pr', 'summary', 'handoff']) {
      const res = await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
        order: without.filter((id) => id !== locked),
      })
      expect(res.status, locked).toBe(400)
      expect(entry((await call('GET', `/api/projects/${pid}/workflow`)).body, w).order).toEqual(without)
    }
    expect(
      (
        await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
          order: without.filter((id) => id !== 'build'),
        })
      ).body.error,
    ).toBe('build is locked: it cannot be removed')
    // A switch on a step it does not have is refused; a body with no order keeps the list.
    const off = await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      steps: { preview: { enabled: false } },
    })
    expect([off.status, off.body.error]).toEqual([400, 'steps: preview is not a step of the Ours workflow'])
    const rounds = await call('PUT', `/api/projects/${pid}/workflow/${w}`, { rounds: { mid: 2 } })
    expect(entry(rounds.body, w).order).toEqual(without)
  })

  it('takes every tweak of the presets: order, switch, effort, Team agent per node, rounds', async () => {
    const pid = await newProject()
    const { body } = await call('POST', `/api/projects/${pid}/agents`, {
      name: 'Maker',
      instructions: 'Make.',
    })
    expect(body.id).toBeTruthy()
    await call('POST', `/api/projects/${pid}/agents`, { name: 'Sharp', instructions: 'Hunt.' })
    const w = await duplicate(pid, 'Ours', 'thorough')
    const order = await orderOf(pid, w)
    const moved = [...order]
    ;[moved[moved.indexOf('preview')], moved[moved.indexOf('review')]] = [
      moved[moved.indexOf('review')]!,
      moved[moved.indexOf('preview')]!,
    ]
    const saved = await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      order: moved,
      steps: { build: { effort: 'low' }, ci: { enabled: false } },
      agents: { build: 'maker', 'review.hunt-a': 'Sharp' },
      rounds: { mid: 5, low: 1 },
    })
    expect(saved.status).toBe(200)
    const e = entry(saved.body, w)
    expect(e.order).toEqual(moved)
    expect(e.rounds.mid).toBe(5)
    expect(e.tweaks.agents).toEqual({ build: 'Maker', 'review.hunt-a': 'Sharp' })
    expect(e.steps.find((s: { id: string }) => s.id === 'ci').enabled).toBe(false)
    // The page's own rules apply: an unknown Team agent, a locked step off, a move the order refuses, rounds out of range.
    for (const body of [
      { agents: { build: 'Nobody' } },
      { steps: { build: { enabled: false } } },
      { order: [order[0], order[2], order[1], ...order.slice(3)] },
      { rounds: { mid: 13 } },
      { agents: { review: 'Maker' } },
    ])
      expect(
        (await call('PUT', `/api/projects/${pid}/workflow/${w}`, body)).status,
        JSON.stringify(body),
      ).toBe(400)
    // The presets are not touched by any of it.
    expect(entry(saved.body, 'thorough').tweaked).toBe(false)
  })

  it('refuses a Team agent on a review phase once the review is removed', async () => {
    const pid = await newProject()
    await call('POST', `/api/projects/${pid}/agents`, { name: 'Sharp', instructions: 'Hunt.' })
    const w = await duplicate(pid, 'Ours', 'standard')
    const without = STANDARD.filter((id) => id !== 'review')
    const res = await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      order: without,
      agents: { 'review.hunt-a': 'Sharp' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('no review step')
    // A pick saved while it had one is dropped with the step.
    await call('PUT', `/api/projects/${pid}/workflow/${w}`, { agents: { 'review.hunt-a': 'Sharp' } })
    const dropped = await call('PUT', `/api/projects/${pid}/workflow/${w}`, { order: without, agents: {} })
    expect(entry(dropped.body, w).tweaks.agents).toBeUndefined()
  })

  it('resets a custom workflow to how it was made, name included, and a preset to what ships', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'standard')
    const made = entry((await call('GET', `/api/projects/${pid}/workflow`)).body, w)
    await call('PATCH', `/api/projects/${pid}/workflow/custom/${w}`, { name: 'Renamed' })
    await call('PUT', `/api/projects/${pid}/workflow/${w}`, {
      order: STANDARD.filter((id) => id !== 'ci'),
      rounds: { mid: 6 },
    })
    expect(entry((await call('GET', `/api/projects/${pid}/workflow`)).body, w).tweaked).toBe(true)
    const reset = await call('DELETE', `/api/projects/${pid}/workflow/${w}`)
    expect(reset.status).toBe(200)
    const back = entry(reset.body, w)
    expect([back.order, back.rounds, back.tweaked, back.label]).toEqual([
      made.order,
      made.rounds,
      false,
      'Renamed',
    ])
    expect((await call('DELETE', `/api/projects/${pid}/workflow/light`)).status).toBe(200)
    expect((await call('DELETE', `/api/projects/${pid}/workflow/custom-zzzzzzzzzz`)).status).toBe(400)
  })
})

describe('using a custom workflow', () => {
  it('becomes the project’s workflow, and the project’s row and the overview say so', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'maximum')
    const set = await call('PUT', `/api/projects/${pid}/workflow`, { preset: w })
    expect(set.status).toBe(200)
    expect([set.body.active, set.body.fellBack]).toEqual([w, null])
    expect((await call('GET', `/api/projects/${pid}`)).body.workflowPreset).toBe(w)
    expect((await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'custom-zzzzzzzzzz' })).status).toBe(
      400,
    )
    const t = ticket(pid, 'mid')
    const served = await effective(pid, `?ticketId=${t.id}`)
    expect([served.preset, served.source, served.base, served.custom, served.label]).toEqual([
      w,
      'project',
      'maximum',
      true,
      'Ours',
    ])
  })

  it('is named on a ticket over REST and MCP, and an id of another project or a made-up one is a 400', async () => {
    const pid = await newProject()
    const other = await newProject()
    const w = await duplicate(pid, 'Ours', 'light')
    const foreign = await duplicate(other, 'Foreign', 'light')
    const made = await call('POST', `/api/projects/${pid}/tickets`, { title: 'a', workflowPreset: w })
    expect([made.status, made.body.workflowPreset]).toEqual([201, w])
    const plain = (await call('POST', `/api/projects/${pid}/tickets`, { title: 'b' })).body
    expect((await call('PATCH', `/api/tickets/${plain.id}`, { workflowPreset: w })).body.workflowPreset).toBe(
      w,
    )
    for (const bad of [foreign, 'custom-zzzzzzzzzz', 'mega']) {
      const patch = await call('PATCH', `/api/tickets/${plain.id}`, { workflowPreset: bad })
      expect(patch.status, bad).toBe(400)
      expect(patch.body.error).toContain(`workflowPreset: one of light, standard, thorough, maximum, ${w}`)
      expect(
        (await call('POST', `/api/projects/${pid}/tickets`, { title: 'c', workflowPreset: bad })).status,
      ).toBe(400)
    }
    expect(
      (await tool('update_ticket', { ticketId: plain.id, workflowPreset: null })).workflowPreset,
    ).toBeNull()
    expect((await tool('update_ticket', { ticketId: plain.id, workflowPreset: w })).workflowPreset).toBe(w)
    expect(
      (await tool('create_ticket', { projectId: pid, title: 'd', workflowPreset: w })).workflowPreset,
    ).toBe(w)
    expect((await tool('update_ticket', { ticketId: plain.id, workflowPreset: foreign })).error).toBeTruthy()
    // A lane copies its parent's.
    const lane = (
      await call('POST', `/api/projects/${pid}/tickets`, { title: 'lane', parentId: made.body.id })
    ).body
    expect(lane.workflowPreset).toBe(w)
    // get_project lists the project's own workflows for an agent to name.
    const project = await tool('get_project', { projectId: pid })
    expect(project.workflowCustom.map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([
      [w, 'Ours'],
    ])
    expect(
      (await tool('get_project', { projectId: other })).workflowCustom.map((c: { id: string }) => c.id),
    ).toEqual([foreign])
  })

  it('is served by get_workflow like a preset, over MCP and REST alike', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'thorough')
    const t = ticket(pid, 'high', { workflowPreset: w })
    const rest = (await call('GET', `/api/projects/${pid}/workflow/effective?ticketId=${t.id}`)).body
    expect(await tool('get_workflow', { projectId: pid, ticketId: t.id })).toEqual(rest)
    expect([rest.preset, rest.source, rest.projectPreset, rest.fellBack]).toEqual([
      w,
      'ticket',
      'standard',
      null,
    ])
    const preset = (
      await call('GET', `/api/projects/${pid}/workflow/effective?preset=thorough&complexity=high`)
    ).body
    expect(rest.steps.map((s: { id: string }) => s.id)).toEqual(preset.steps.map((s: { id: string }) => s.id))
    expect(rest.steps.find((s: { id: string }) => s.id === 'review').review.runs).toEqual(
      preset.steps.find((s: { id: string }) => s.id === 'review').review.runs,
    )
    expect(rest.text).toContain(
      '# Workflow: Ours (a custom workflow of the project, based on Thorough: its review and wording are that preset',
    )
    expect(rest.text).toContain("set on the ticket; the project's workflow is Standard")
    expect(
      (await call('GET', `/api/projects/${pid}/workflow/effective?preset=custom-zzzzzzzzzz`)).status,
    ).toBe(400)
  })
})

describe('get_workflow across custom workflows', () => {
  const bases = ['light', 'standard', 'thorough', 'maximum'] as const
  const levels = ['low', 'mid', 'high', 'max'] as const

  for (const base of bases) {
    it(`serves a ${base}-based workflow with a step added, a step removed and no review, at every complexity`, async () => {
      const pid = await newProject()
      const kept = await duplicate(pid, 'Kept', base)
      const tweaked = await duplicate(pid, 'Tweaked', base)
      const tweakedOrder = await orderOf(pid, tweaked)
      const added = tweakedOrder.includes('tests')
        ? tweakedOrder.filter((id) => id !== 'preview')
        : [
            'claim',
            ...(tweakedOrder.includes('spec') ? ['spec'] : []),
            'build',
            'tests',
            ...tweakedOrder.slice(tweakedOrder.indexOf('build') + 1),
          ]
      expect((await call('PUT', `/api/projects/${pid}/workflow/${tweaked}`, { order: added })).status).toBe(
        200,
      )
      const bare = await duplicate(pid, 'Bare', base)
      const noReview = (await orderOf(pid, bare)).filter((id) => id !== 'review')
      expect((await call('PUT', `/api/projects/${pid}/workflow/${bare}`, { order: noReview })).status).toBe(
        200,
      )

      for (const level of levels) {
        const preset = await effective(pid, `?preset=${base}&complexity=${level}`)
        const same = await effective(pid, `?preset=${kept}&complexity=${level}`)
        expect(same.steps).toEqual(preset.steps)
        expect(same.rounds).toEqual(preset.rounds)
        // The text differs from the preset's only in its heading line.
        expect(same.text.split('\n').slice(1).join('\n')).toBe(preset.text.split('\n').slice(1).join('\n'))

        const mine = await effective(pid, `?preset=${tweaked}&complexity=${level}`)
        expect(ids(mine.steps)).toEqual(
          added
            .filter((id) => !(level === 'low' && ['spec', 'spec2', 'tests'].includes(id)))
            .filter((id) => {
              const step = mine.steps.find((s: { id: string }) => s.id === id)
              return step && !step.skipped
            }),
        )
        expect(mine.steps.map((s: { id: string }) => s.id)).toEqual(added)
        expect(mine.text).toContain('Test-writing pass')

        const none = await effective(pid, `?preset=${bare}&complexity=${level}`)
        expect(none.steps.map((s: { id: string }) => s.id)).toEqual(noReview)
        expect(none.flow.review).toBe(false)
        expect(flat(none.text)).toContain('Review: none.')
        expect(none.text).not.toContain('Pass to /feature-review')
      }
      // With a ticket of its own, the same.
      const t = ticket(pid, 'high', { workflowPreset: bare })
      const served = await effective(pid, `?ticketId=${t.id}`)
      expect(served.steps.map((s: { id: string }) => s.id)).toEqual(noReview)
      expect(served.complexity).toBe('high')
    })
  }

  it('checks a ticket’s review phases against its custom workflow, and not at all without the review', async () => {
    const pid = await newProject()
    const { reviewPhaseRuns } = await import('#/lib/workflow')
    const { ticketWorkflow } = await import('./workflow')
    const thorough = await duplicate(pid, 'Deep', 'thorough')
    const t = ticket(pid, 'mid', { workflowPreset: thorough })
    const needed = () => reviewPhaseRuns(ticketWorkflow({ id: t.id, projectId: pid, complexity: 'mid' }))
    expect(needed().find((p) => p.phase === 'hunt')!.expected).toBe(3)
    const light = await duplicate(pid, 'Quick', 'light')
    features.updateTicket(t.id, { workflowPreset: light }, HUMAN)
    expect(needed()).toEqual([{ phase: 'hunt', expected: 1 }])
    const bare = await duplicate(pid, 'Bare', 'standard')
    await call('PUT', `/api/projects/${pid}/workflow/${bare}`, {
      order: STANDARD.filter((id) => id !== 'review'),
    })
    features.updateTicket(t.id, { workflowPreset: bare }, HUMAN)
    expect(needed()).toEqual([])
  })
})

describe('a workflow that was deleted', () => {
  it('falls back to Standard for the project, and the page and get_workflow say so', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'light')
    await call('PUT', `/api/projects/${pid}/workflow`, { preset: w })
    const gone = await call('DELETE', `/api/projects/${pid}/workflow/custom/${w}`)
    expect([gone.body.active, gone.body.fellBack]).toEqual(['standard', { id: w }])
    const t = ticket(pid, 'mid')
    const served = await effective(pid, `?ticketId=${t.id}`)
    expect([served.preset, served.source, served.fellBack]).toEqual([
      'standard',
      'project',
      { id: w, of: 'project' },
    ])
    expect(ids(served.steps)).toEqual(STANDARD)
    // Picking a workflow again clears the notice.
    expect((await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'light' })).body.fellBack).toBeNull()
  })

  it('has a ticket that named it follow the project’s workflow, and says which it named', async () => {
    const pid = await newProject()
    const w = await duplicate(pid, 'Ours', 'light')
    const t = ticket(pid, 'high', { workflowPreset: w })
    expect((await effective(pid, `?ticketId=${t.id}`)).preset).toBe(w)
    await call('PUT', `/api/projects/${pid}/workflow`, { preset: 'thorough' })
    await call('DELETE', `/api/projects/${pid}/workflow/custom/${w}`)
    const served = await effective(pid, `?ticketId=${t.id}`)
    expect([served.preset, served.source, served.fellBack]).toEqual([
      'thorough',
      'project',
      { id: w, of: 'ticket' },
    ])
    // The ticket row still names it, a later workflow does not take it over, and the checks follow the project's.
    expect((await call('GET', `/api/tickets/${t.id}`)).body.workflowPreset).toBe(w)
    await duplicate(pid, 'Ours', 'light')
    expect((await effective(pid, `?ticketId=${t.id}`)).preset).toBe('thorough')
    const { ticketWorkflow } = await import('./workflow')
    expect(ticketWorkflow({ id: t.id, projectId: pid, complexity: 'high' }).preset).toBe('thorough')
    expect((await tool('get_workflow', { projectId: pid, ticketId: t.id })).fellBack).toEqual({
      id: w,
      of: 'ticket',
    })
  })
})
