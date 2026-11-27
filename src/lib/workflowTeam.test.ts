import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMPLEXITIES } from './constants'
/** The presets with a review step: Content has none, so the review's own checks read only these. */
const REVIEWED = WORKFLOW_PRESETS.filter((p) => WORKFLOW_PRESET_DEFS[p].steps.includes('review'))
import {
  WORKFLOW_PRESET_DEFS,
  WORKFLOW_PRESETS,
  bindableNodes,
  defaultTeamAgent,
  normalizeTweaks,
  readProjectTweaks,
  resolveWorkflow,
  teamAgentFor,
  validateTweaks,
  type ResolvedSubStep,
  type WorkflowPresetId,
} from './workflow'

/** Every phase of a resolved review, groups included, in order. */
const flat = (list: readonly ResolvedSubStep[]): ResolvedSubStep[] =>
  list.flatMap((s) => [s, ...flat(s.children)])

const refused = (preset: WorkflowPresetId, input: unknown, team: string[] = ['acme-dev', 'sec-hunter']) => {
  const r = validateTweaks(preset, input, { team })
  return r.ok ? null : r.error
}

describe('the nodes that can name a Team agent (B10)', () => {
  const ids = (preset: WorkflowPresetId) => bindableNodes(preset).map((n) => n.id)

  it("are the steps that start an agent and the review phases with one, never the ticket agent's own, the review step or a group", () => {
    expect(ids('light')).toEqual(['build', 'intent', 'review.reviewer', 'review.fix'])
    expect(ids('standard')).toEqual([
      'spec',
      'build',
      'intent',
      'review.spec',
      'review.env',
      'review.verify',
      'review.hunt-a',
      'review.hunt-b',
      'review.refute',
      'review.merge',
      'review.fix',
    ])
    expect(ids('thorough')).toContain('review.hunt-security')
    expect(ids('thorough')).toContain('review.intent')
    expect(ids('thorough')).toContain('tests')
    expect(ids('maximum')).toContain('spec2')
    for (const kind of ['first', 'second'])
      for (const phase of ['spec', 'env', 'verify', 'hunt-a', 'hunt-b', 'hunt-security', 'refute', 'merge'])
        expect(ids('maximum')).toContain(`review.${kind}.${phase}`)
    for (const preset of WORKFLOW_PRESETS)
      for (const none of [
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
        'review.reconcile',
        'review.first',
        'review.second',
      ])
        expect(ids(preset), `${preset} ${none}`).not.toContain(none)
  })

  it('are exactly the resolved nodes that carry a Team agent', () => {
    for (const preset of REVIEWED) {
      const w = resolveWorkflow(preset, undefined, 'max')
      const review = w.steps.find((s) => s.id === 'review')!.review!
      const withAgent = [
        ...w.steps.filter((s) => s.teamAgent).map((s) => s.id as string),
        ...flat([...review.phases, ...review.between])
          .filter((s) => s.teamAgent)
          .map((s) => s.id),
      ]
      expect(withAgent.sort(), preset).toEqual(
        bindableNodes(preset)
          .map((n) => n.id)
          .sort(),
      )
    }
  })

  it("accepts a pick per phase, and the same phase of Maximum's two reviews separately", () => {
    expect(
      validateTweaks(
        'standard',
        { agents: { 'review.hunt-a': 'sec-hunter', 'review.hunt-b': 'acme-dev' } },
        { team: ['acme-dev', 'sec-hunter'] },
      ),
    ).toEqual({ ok: true, tweak: { agents: { 'review.hunt-a': 'sec-hunter', 'review.hunt-b': 'acme-dev' } } })
    const both = validateTweaks(
      'maximum',
      { agents: { 'review.first.hunt-a': 'sec-hunter', 'review.second.hunt-a': 'acme-dev' } },
      { team: ['acme-dev', 'sec-hunter'] },
    )
    expect(both.ok).toBe(true)
    expect(refused('light', { agents: { 'review.reviewer': 'acme-dev' } })).toBeNull()
    expect(refused('thorough', { agents: { 'review.intent': 'acme-dev' } })).toBeNull()
  })
})

describe('refusing a pick (B2, B3)', () => {
  it('names a Team agent the project does not have', () => {
    expect(refused('standard', { agents: { build: 'nobody' } })).toBe(
      'agents.build: "nobody" is not one of the project\'s Team agents (add it on the Team page first)',
    )
    expect(refused('standard', { agents: { build: 'nobody' } }, [])).toContain('"nobody"')
    expect(validateTweaks('standard', { agents: { build: 'acme-dev' } }).ok).toBe(false)
  })

  it('refuses a node that runs no agent, a group, a node the preset lacks and an unknown one', () => {
    for (const id of [
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
      expect(refused('standard', { agents: { [id]: 'acme-dev' } }), id).toContain(
        `${id} runs no agent of its own`,
      )
    expect(refused('maximum', { agents: { 'review.reconcile': 'acme-dev' } })).toContain('runs no agent')
    expect(refused('maximum', { agents: { 'review.first': 'acme-dev' } })).toContain('is a group of reviews')
    expect(refused('standard', { agents: { spec2: 'acme-dev' } })).toBe(
      'agents: spec2 is not a step of the Standard workflow',
    )
    expect(refused('standard', { agents: { 'review.first.hunt-a': 'acme-dev' } })).toBe(
      'agents: unknown node "review.first.hunt-a"',
    )
    expect(refused('standard', { agents: { foo: 'acme-dev' } })).toBe('agents: unknown node "foo"')
    expect(refused('standard', { agents: { 'review.nope': 'acme-dev' } })).toContain('unknown node')
  })

  it('refuses a value that is not a name, and an agents that is not an object', () => {
    for (const value of [3, null, true, '', '   ', ['acme-dev'], {}])
      expect(refused('standard', { agents: { build: value } }), JSON.stringify(value)).toContain(
        'agents.build: the name of one of the project',
      )
    for (const agents of ['acme-dev', ['build'], 4])
      expect(refused('standard', { agents })).toBe(
        'agents: an object keyed by node id, each a Team agent name',
      )
  })

  it("matches the Team case-insensitively and keeps the Team's own spelling", () => {
    const r = validateTweaks('standard', { agents: { build: 'ACME-dev ' } }, { team: ['Acme-Dev'] })
    expect(r).toEqual({ ok: true, tweak: { agents: { build: 'Acme-Dev' } } })
  })

  it('lets a pick already saved for the node be sent back after its agent left the Team, and no other', () => {
    const stored = { build: 'gone-agent' }
    expect(
      validateTweaks(
        'standard',
        { agents: { build: 'gone-agent', spec: 'acme-dev' } },
        { team: ['acme-dev'], stored },
      ),
    ).toEqual({ ok: true, tweak: { agents: { build: 'gone-agent', spec: 'acme-dev' } } })
    expect(refused('standard', { agents: { spec: 'gone-agent' } }, ['acme-dev'])).toContain('not one of')
    expect(
      validateTweaks('standard', { agents: { spec: 'gone-agent' } }, { team: ['acme-dev'], stored }).ok,
    ).toBe(false)
  })
})

describe('normalizing the picks (B6)', () => {
  it("drops a pick equal to the role's default, in any casing, and a blank one", () => {
    expect(
      normalizeTweaks('standard', { agents: { 'review.hunt-a': 'Hunt', build: 'builder', spec: ' ' } }),
    ).toBeNull()
    expect(normalizeTweaks('standard', { agents: { 'review.hunt-a': 'hunt', build: 'acme-dev' } })).toEqual({
      agents: { build: 'acme-dev' },
    })
  })

  it('drops a pick for a node that cannot have one', () => {
    expect(
      normalizeTweaks('standard', { agents: { claim: 'a', 'review.first': 'b', spec2: 'c', review: 'd' } }),
    ).toBeNull()
  })

  it('ignores a stored pick under the review step: the reader drops it and the step resolves with no Team agent', () => {
    const saved = { standard: { agents: { review: 'acme-dev', build: 'acme-dev' } } }
    expect(readProjectTweaks(saved)).toEqual({ standard: { agents: { build: 'acme-dev' } } })
    const w = resolveWorkflow('standard', saved.standard, 'mid', ['acme-dev'])
    const review = w.steps.find((s) => s.id === 'review')!
    expect(review.teamAgent).toBeNull()
    expect(review.edited.agent).toBe(false)
    expect(w.tweak).toEqual({ agents: { build: 'acme-dev' } })
  })
})

describe('which Team agent runs a node (B4)', () => {
  it("is the pick, else the agent named like the role, else the role's built-in agent", () => {
    expect(teamAgentFor('builder', 'acme-dev', ['acme-dev', 'builder'])).toEqual({
      name: 'acme-dev',
      source: 'picked',
      picked: 'acme-dev',
      missing: false,
    })
    expect(teamAgentFor('builder', undefined, ['Builder'])).toEqual({
      name: 'Builder',
      source: 'role',
      picked: null,
      missing: false,
    })
    expect(teamAgentFor('builder', undefined, ['acme-dev'])).toEqual({
      name: 'builder',
      source: 'default',
      picked: null,
      missing: false,
    })
    expect(defaultTeamAgent('runner')).toEqual({ name: 'runner', source: 'default' })
  })

  it('runs a pick the Team no longer has as if unset, and says so', () => {
    expect(teamAgentFor('hunt', 'sec-hunter', ['hunt'])).toEqual({
      name: 'hunt',
      source: 'role',
      picked: 'sec-hunter',
      missing: true,
    })
    expect(teamAgentFor('hunt', 'sec-hunter', [])).toEqual({
      name: 'hunt',
      source: 'default',
      picked: 'sec-hunter',
      missing: true,
    })
  })

  it('resolves every node in every preset: default with no Team, by role with one, picked with a pick', () => {
    const roles = ['spec', 'builder', 'runner', 'env', 'verify', 'hunt', 'refute', 'merge', 'intent']
    for (const preset of WORKFLOW_PRESETS) {
      const none = resolveWorkflow(preset, undefined, 'max')
      const team = resolveWorkflow(preset, undefined, 'max', roles)
      for (const node of bindableNodes(preset)) {
        const find = (w: typeof none) => {
          const step = w.steps.find((s) => s.id === node.id)
          if (step) return step.teamAgent
          return flat(
            w.steps.flatMap((s) => (s.review ? [...s.review.phases, ...s.review.between] : [])),
          ).find((s) => s.id === node.id)?.teamAgent
        }
        expect(find(none), `${preset} ${node.id}`).toEqual({
          name: node.agent,
          source: 'default',
          picked: null,
          missing: false,
        })
        expect(find(team)?.source, `${preset} ${node.id}`).toBe('role')
        expect(find(team)?.name).toBe(node.agent)
      }
      // The ticket agent's own steps run no agent, and the review step runs through the Skill: no Team agent.
      for (const id of ['claim', 'gate', 'push', 'handoff', 'review'])
        expect(none.steps.find((s) => s.id === id)?.teamAgent ?? null).toBeNull()
    }
  })

  it('serves a pick on a step and on a phase, and agent stays the role', () => {
    const w = resolveWorkflow(
      'standard',
      { agents: { build: 'acme-dev', 'review.hunt-b': 'sec-hunter' } },
      'high',
      ['acme-dev', 'sec-hunter', 'hunt'],
    )
    const build = w.steps.find((s) => s.id === 'build')!
    expect(build.agent).toBe('builder')
    expect(build.teamAgent).toEqual({
      name: 'acme-dev',
      source: 'picked',
      picked: 'acme-dev',
      missing: false,
    })
    expect(build.edited.agent).toBe(true)
    expect(w.tweak).toEqual({ agents: { build: 'acme-dev', 'review.hunt-b': 'sec-hunter' } })
    const phases = flat(w.steps.find((s) => s.id === 'review')!.review!.phases)
    const hunts = phases.filter((p) => p.phase === 'hunt')
    expect(hunts.map((h) => [h.agent, h.teamAgent?.name, h.teamAgent?.source])).toEqual([
      ['hunt', 'hunt', 'role'],
      ['hunt', 'sec-hunter', 'picked'],
    ])
    expect(w.steps.find((s) => s.id === 'review')!.review!.runs[0]!.agentsArg).toBe(
      'spec,env,verify,hunt,sec-hunter,refute,merge',
    )
  })

  it('keeps a stored pick whose agent is gone, and restores it when the agent is back', () => {
    const tweak = { agents: { build: 'acme-dev' } }
    const gone = resolveWorkflow('standard', tweak, 'mid', ['builder'])
    const build = (w: typeof gone) => w.steps.find((s) => s.id === 'build')!.teamAgent
    expect(build(gone)).toEqual({ name: 'builder', source: 'role', picked: 'acme-dev', missing: true })
    expect(gone.tweak).toEqual(tweak)
    expect(gone.tweaked).toBe(true)
    expect(build(resolveWorkflow('standard', tweak, 'mid', ['builder', 'acme-dev']))?.source).toBe('picked')
    expect(build(resolveWorkflow('standard', tweak, 'mid'))).toMatchObject({
      source: 'default',
      missing: true,
    })
  })

  it('names the agents of each run, one per phases= token', () => {
    for (const preset of REVIEWED)
      for (const level of COMPLEXITIES) {
        const review = resolveWorkflow(preset, undefined, level).steps.find((s) => s.id === 'review')!.review!
        for (const run of review.runs)
          expect(run.agentsArg.split(',').length, `${preset} ${run.id}`).toBe(run.phases.length)
      }
    const max = resolveWorkflow(
      'maximum',
      { agents: { 'review.first.hunt-a': 'sec-hunter', 'review.second.hunt-security': 'acme-dev' } },
      'mid',
      ['sec-hunter', 'acme-dev'],
    )
    const runs = max.steps.find((s) => s.id === 'review')!.review!.runs
    expect(runs.map((r) => r.agentsArg)).toEqual([
      'spec,env,verify,sec-hunter,hunt,hunt,refute,merge',
      'spec,env,verify,hunt,hunt,acme-dev,refute,merge',
    ])
    expect(runs.map((r) => r.phasesArg)).toEqual([
      'spec,env,verify,hunt,hunt,hunt-security,refute,merge',
      'spec,env,verify,hunt,hunt,hunt-security,refute,merge',
    ])
    expect(
      resolveWorkflow('light', undefined, 'mid').steps.find((s) => s.id === 'review')!.review!.runs[0]!
        .agentsArg,
    ).toBe('hunt')
  })

  it('changes neither which steps run nor their order, numbering, rounds or the phases a round needs (B12)', () => {
    const picks = { agents: { build: 'acme-dev', spec: 'gone', 'review.hunt-a': 'sec-hunter' } }
    for (const preset of WORKFLOW_PRESETS)
      for (const level of COMPLEXITIES) {
        const bare = resolveWorkflow(preset, undefined, level)
        const bound = resolveWorkflow(preset, picks, level, ['acme-dev', 'sec-hunter'])
        const shape = (w: typeof bare) => ({
          order: w.order,
          numbered: w.numbered,
          rounds: w.rounds,
          flow: w.flow,
          skipped: w.steps.map((s) => [s.id, s.number, s.skipped?.reason ?? null]),
          perRound: w.steps.find((s) => s.id === 'review')?.review?.perRound,
          phasesArgs: w.steps.find((s) => s.id === 'review')?.review?.runs.map((r) => r.phasesArg),
          agents: w.steps.map((s) => s.agent),
        })
        expect(shape(bound), `${preset} ${level}`).toEqual(shape(bare))
      }
  })
})

describe('a stored pick read back (A8, B7)', () => {
  it('keeps a pick for a node of the preset and drops the rest', () => {
    expect(
      readProjectTweaks({
        standard: {
          agents: { build: 'acme-dev', claim: 'x', 'review.first': 'y', 'review.hunt-a': 'Hunt', spec: 4 },
        },
        light: { agents: { spec: 'acme-dev' } },
      }),
    ).toEqual({ standard: { agents: { build: 'acme-dev' } } })
  })
})

describe('the pure module (B5)', () => {
  it('imports nothing from the server or the database', () => {
    const source = fs.readFileSync(path.resolve('src/lib/workflow.ts'), 'utf8')
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    // The tag rules (`./tags`) are pure too: no server, database or node module.
    expect(imports).toEqual(['./constants', './tags'])
  })
})
