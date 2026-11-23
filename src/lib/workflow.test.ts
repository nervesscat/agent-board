import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMPLEXITIES, type Complexity } from './constants'
import {
  WORKFLOW_PRESETS,
  WORKFLOW_PRESET_DEFS,
  WORKFLOW_STEPS,
  WORKFLOW_STEP_IDS,
  type PresetTweak,
  type WorkflowPresetId,
  type WorkflowStepId,
  moveStep,
  normalizeTweaks,
  orderProblem,
  readProjectTweaks,
  resolveWorkflow,
  reviewPhaseRuns,
  stepHandoff,
  validateTweaks,
} from './workflow'

const ids = (id: WorkflowPresetId, tweak?: PresetTweak | null, complexity?: Complexity | null) =>
  resolveWorkflow(id, tweak, complexity ?? null)
    .steps.filter((s) => !s.skipped)
    .map((s) => s.id)
const runs = (id: WorkflowPresetId, level: Complexity | null = 'mid', tweak?: PresetTweak) =>
  Object.fromEntries(reviewPhaseRuns(resolveWorkflow(id, tweak, level)).map((p) => [p.phase, p.expected]))
const reviewOf = (id: WorkflowPresetId, level: Complexity | null = 'mid', tweak?: PresetTweak) =>
  resolveWorkflow(id, tweak, level).steps.find((s) => s.id === 'review')!

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

describe('the catalogue and the presets (A1)', () => {
  it('has the four presets with a label and a one-line description', () => {
    expect([...WORKFLOW_PRESETS]).toEqual(['light', 'standard', 'thorough', 'maximum'])
    for (const id of WORKFLOW_PRESETS) {
      const p = WORKFLOW_PRESET_DEFS[id]
      expect(p.label).toBe(id[0]!.toUpperCase() + id.slice(1))
      expect(p.description.length).toBeGreaterThan(20)
      expect(p.description).not.toContain('\n')
    }
  })

  it('describes every step with a label, what it does, a default hand-off, an agent, a lock and its ordering', () => {
    expect(Object.keys(WORKFLOW_STEPS).sort()).toEqual([...WORKFLOW_STEP_IDS].sort())
    for (const id of WORKFLOW_STEP_IDS) {
      const s = WORKFLOW_STEPS[id]
      expect(s.id).toBe(id)
      expect(s.label).not.toBe('')
      expect(s.what.length).toBeGreaterThan(30)
      expect(s.handoff.length).toBeGreaterThan(20)
      expect(s.after).toBeInstanceOf(Array)
      expect(typeof s.aboveLow).toBe('boolean')
      // A locked step says why, an unlocked one does not.
      expect(s.lockReason === null).toBe(s.lock === null)
    }
    expect(WORKFLOW_STEP_IDS.filter((id) => WORKFLOW_STEPS[id].lock === 'always')).toEqual([
      'claim',
      'build',
      'gate',
      'push',
      'pr',
      'summary',
      'handoff',
    ])
    expect(WORKFLOW_STEPS.intent.lock).toBe('above-low')
    expect(WORKFLOW_STEPS.review.hasSubSteps).toBe(true)
  })

  it('imports nothing from the server or the database', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'workflow.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"]#\/(server|db)/)
    expect(source).not.toMatch(/from ['"]\.\.?\/.*(server|db)/)
    expect(source).not.toMatch(/from ['"]node:/)
  })

  it('has a procedure file for every step and a variant for each preset review', () => {
    const dir = path.join(import.meta.dirname, '..', 'server', 'skill', 'workflow')
    const files = fs.readdirSync(dir)
    for (const id of WORKFLOW_STEP_IDS) expect(files, id).toContain(`${id}.md`)
    for (const id of ['light', 'thorough', 'maximum']) expect(files).toContain(`review.${id}.md`)
  })
})

describe('Standard is today’s protocol (A2)', () => {
  it('resolves to the twelve steps in order, numbered from 1, with the rounds 0, 1, 3, 10', () => {
    const w = resolveWorkflow('standard', undefined, 'mid')
    expect(w.steps.map((s) => s.id)).toEqual(STANDARD)
    expect(w.steps.map((s) => s.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(w.numbered).toBe(12)
    expect(w.rounds).toEqual({ low: 0, mid: 1, high: 3, max: 10 })
    expect(w.tweaked).toBe(false)
    expect(w.tweak).toBeNull()
  })

  it('gives the review its seven phases in order, verify in parallel with the hunts, and what happens between rounds', () => {
    const review = reviewOf('standard').review!
    expect(review.phases.map((p) => p.id)).toEqual([
      'review.spec',
      'review.env',
      'review.verify',
      'review.hunt-a',
      'review.hunt-b',
      'review.refute',
      'review.merge',
    ])
    expect(review.phases.map((p) => p.number)).toEqual(['5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7'])
    expect(review.phases.map((p) => p.parallel)).toEqual([
      null,
      null,
      'checks',
      'checks',
      'checks',
      null,
      null,
    ])
    expect(review.phases.map((p) => p.agent)).toEqual([
      'spec',
      'env',
      'verify',
      'hunt',
      'hunt',
      'refute',
      'merge',
    ])
    expect(review.between.map((p) => [p.id, p.agent])).toEqual([
      ['review.fix', 'builder'],
      ['review.gate', 'you'],
    ])
    expect(review.runs).toEqual([
      expect.objectContaining({ phasesArg: 'spec,env,verify,hunt,hunt,refute,merge', agentSuffix: null }),
    ])
  })

  it('shows the rounds per complexity: skipped at low, then 1, 3 and 10', () => {
    const rounds = (level: Complexity) => reviewOf('standard', level).review!.rounds
    expect(COMPLEXITIES.map(rounds)).toEqual([0, 1, 3, 10])
    expect(reviewOf('standard', 'mid').skipped).toBeNull()
    expect(reviewOf('standard', 'low').skipped?.reason).toBe('low')
  })

  it('drops the spec and the review for a low ticket and leaves the rest as it is', () => {
    const low = resolveWorkflow('standard', undefined, 'low')
    expect(low.steps.filter((s) => s.skipped).map((s) => s.id)).toEqual(['spec', 'review'])
    expect(low.steps.find((s) => s.id === 'spec')!.skipped).toEqual({
      reason: 'low',
      note: 'skipped: low ticket',
    })
    expect(ids('standard', null, 'low')).toEqual(STANDARD.filter((id) => id !== 'spec' && id !== 'review'))
    expect(low.numbered).toBe(10)
    // The order itself keeps them, so a table of the workflow is still whole.
    expect(low.steps.map((s) => s.id)).toEqual(STANDARD)
    expect(low.steps.find((s) => s.id === 'intent')!.skipped).toBeNull()
  })

  it('with no complexity skips nothing for being low, and says which steps a low ticket drops', () => {
    const w = resolveWorkflow('standard')
    expect(w.complexity).toBeNull()
    expect(w.steps.every((s) => !s.skipped)).toBe(true)
    expect(w.steps.filter((s) => s.skipsOnLow).map((s) => s.id)).toEqual(['spec', 'review'])
    expect(reviewOf('standard', null).review!.rounds).toBeNull()
    expect(reviewOf('standard', null).review!.roundsByComplexity).toEqual({
      low: 0,
      mid: 1,
      high: 3,
      max: 10,
    })
  })

  it('names who runs each step and what its default hand-off is', () => {
    const w = resolveWorkflow('standard', undefined, 'mid')
    expect(w.steps.map((s) => s.agentLabel)).toEqual([
      'you',
      'spec',
      'builder',
      'you',
      '/feature-review',
      'you',
      'intent',
      'you',
      'you',
      'you',
      'you',
      'you',
    ])
    for (const s of w.steps) expect(s.handoff).toBe(WORKFLOW_STEPS[s.id].handoff)
  })
})

describe('Light (A3)', () => {
  it('is the eleven steps with one reviewer and no other review phase', () => {
    expect(ids('light')).toEqual(STANDARD.filter((id) => id !== 'spec'))
    expect(ids('light')).toHaveLength(11)
    const review = reviewOf('light').review!
    expect(review.phases.map((p) => p.id)).toEqual(['review.reviewer'])
    expect(review.runs[0]!.phasesArg).toBe('reviewer')
    expect(runs('light')).toEqual({ hunt: 1 })
    const everything = JSON.stringify(resolveWorkflow('light', undefined, 'high'))
    for (const word of [
      'review.spec',
      'review.env',
      'review.verify',
      'review.hunt-a',
      'review.refute',
      'review.merge',
    ])
      expect(everything).not.toContain(word)
    expect(resolveWorkflow('light').rounds).toEqual({ low: 0, mid: 1, high: 2, max: 3 })
  })
})

describe('Thorough (A4)', () => {
  it('is Standard plus the test-writing pass between the build and the gate', () => {
    const order = ids('thorough')
    expect(order).toHaveLength(13)
    expect(order.filter((id) => id !== 'tests')).toEqual(STANDARD)
    expect(order.indexOf('tests')).toBe(order.indexOf('build') + 1)
  })

  it('adds the security hunt and the intent check to every review round, and one more round above low', () => {
    const standard = reviewOf('standard').review!.phases.map((p) => p.id.replace('review.', ''))
    const thorough = reviewOf('thorough').review!.phases.map((p) => p.id.replace('review.', ''))
    expect(thorough.filter((id) => !standard.includes(id))).toEqual(['hunt-security', 'intent'])
    expect(thorough.indexOf('hunt-security')).toBe(thorough.indexOf('hunt-b') + 1)
    expect(thorough.at(-1)).toBe('intent')
    const a = WORKFLOW_PRESET_DEFS.standard.rounds
    const b = WORKFLOW_PRESET_DEFS.thorough.rounds
    expect(b).toEqual({ low: 0, mid: 2, high: 4, max: 11 })
    for (const level of ['mid', 'high', 'max'] as const) expect(b[level]).toBe(a[level] + 1)
    expect(reviewOf('thorough').review!.runs[0]!.phasesArg).toBe(
      'spec,env,verify,hunt,hunt,hunt-security,refute,merge',
    )
  })
})

describe('Maximum (A5)', () => {
  it('is Thorough plus a second spec after the first, with the rounds 0, 3, 5 and 12', () => {
    const order = ids('maximum')
    expect(order).toHaveLength(14)
    expect(order.filter((id) => id !== 'spec2')).toEqual(ids('thorough'))
    expect(order.indexOf('spec2')).toBe(order.indexOf('spec') + 1)
    expect(resolveWorkflow('maximum').rounds).toEqual({ low: 0, mid: 3, high: 5, max: 12 })
  })

  it('reviews every round twice, by different agents, and reconciles', () => {
    const review = reviewOf('maximum').review!
    expect(review.phases.map((p) => p.id)).toEqual([
      'review.first',
      'review.second',
      'review.reconcile',
      'review.intent',
    ])
    const [first, second] = review.phases
    expect(first!.children.map((p) => p.id.replace('review.first.', ''))).toEqual([
      'spec',
      'env',
      'verify',
      'hunt-a',
      'hunt-b',
      'hunt-security',
      'refute',
      'merge',
    ])
    expect(second!.children).toHaveLength(8)
    expect(first!.children[0]!.number).toBe('7.1.1')
    expect(review.runs.map((r) => r.agentSuffix)).toEqual(['first', 'second'])
    expect(second!.label).toContain('different agent')
  })

  it('runs every agent step at high effort, the intent check at low', () => {
    const w = resolveWorkflow('maximum', undefined, 'mid')
    const agentSteps = w.steps.filter((s) => s.effort !== null)
    expect(agentSteps.map((s) => s.id)).toEqual(['spec', 'spec2', 'build', 'tests', 'review', 'intent'])
    for (const s of agentSteps) expect(s.effortLevel, s.id).toBe(s.id === 'intent' ? 'low' : 'high')
    // Steps the ticket agent does itself have no effort.
    expect(w.steps.find((s) => s.id === 'gate')!.effort).toBeNull()
  })
})

describe('the locks (A6)', () => {
  const locked: WorkflowStepId[] = ['claim', 'build', 'gate', 'push', 'pr', 'summary', 'handoff']

  it.each(locked)('refuses to turn %s off, naming it and saying it is locked', (id) => {
    const r = validateTweaks('standard', { steps: { [id]: { enabled: false } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(`${id} is locked: it cannot be turned off`)
    // A saved one is ignored when the workflow is read.
    const w = resolveWorkflow('standard', { steps: { [id]: { enabled: false } } }, 'mid')
    expect(w.steps.find((s) => s.id === id)!.skipped).toBeNull()
    expect(w.steps.find((s) => s.id === id)!.enabled).toBe(true)
    expect(w.tweaked).toBe(false)
  })

  it('accepts turning the intent check off, and applies it to a low ticket only', () => {
    const tweak = { steps: { intent: { enabled: false } } }
    expect(validateTweaks('standard', tweak).ok).toBe(true)
    for (const level of ['mid', 'high', 'max'] as const) {
      const w = resolveWorkflow('standard', tweak, level)
      expect(w.steps.find((s) => s.id === 'intent')!.skipped, level).toBeNull()
    }
    const low = resolveWorkflow('standard', tweak, 'low')
    expect(low.steps.find((s) => s.id === 'intent')!.skipped?.reason).toBe('off')
    expect(low.numbered).toBe(9)
    expect(resolveWorkflow('standard', tweak).steps.find((s) => s.id === 'intent')!.skipsOnLow).toBe(true)
  })

  it('can turn the unlocked steps off, and numbers the rest without a gap', () => {
    const w = resolveWorkflow(
      'standard',
      { steps: { preview: { enabled: false }, ci: { enabled: false } } },
      'mid',
    )
    const preview = w.steps.find((s) => s.id === 'preview')!
    expect(preview.skipped).toEqual({ reason: 'off', note: 'skipped: turned off on the Workflow page' })
    expect(preview.enabled).toBe(false)
    expect(w.steps.filter((s) => !s.skipped).map((s) => s.number)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    )
    expect(ids('standard', { steps: { review: { enabled: false } } }, 'mid')).not.toContain('review')
  })
})

describe('what a tweak may name (A7)', () => {
  const problem = (id: WorkflowPresetId, input: unknown) => {
    const r = validateTweaks(id, input)
    return r.ok ? null : r.error
  }

  it('rejects an unknown step, in the steps and in the order, naming it', () => {
    expect(problem('standard', { steps: { nope: { enabled: false } } })).toBe('steps: unknown step "nope"')
    expect(problem('standard', { order: [...STANDARD.slice(0, 11), 'nope'] })).toBe(
      'order: unknown step "nope"',
    )
  })

  it('rejects a step the preset does not have', () => {
    expect(problem('standard', { steps: { spec2: { enabled: false } } })).toBe(
      'steps: spec2 is not a step of the Standard workflow',
    )
    expect(problem('standard', { order: [...STANDARD, 'spec2'] })).toBe(
      'order: "spec2" is not a step of the Standard workflow',
    )
    expect(problem('light', { steps: { spec: {} } })).toContain('spec is not a step of the Light workflow')
  })

  it('rejects an unknown key at every level', () => {
    expect(problem('standard', { color: 'red' })).toBe(
      'unknown key "color": a tweak has order, steps, agents and rounds',
    )
    expect(problem('standard', { steps: { build: { agent: 'x' } } })).toContain('unknown key "agent"')
    expect(problem('standard', { rounds: { huge: 1 } })).toContain('unknown complexity "huge"')
    expect(problem('standard', 'text')).toBe('tweaks must be an object')
    expect(problem('standard', [1])).toBe('tweaks must be an object')
  })
})

describe('the order (A8)', () => {
  const swap = (order: string[], a: string, b: string) =>
    order.map((id) => (id === a ? b : id === b ? a : id))
  const without = (order: string[], id: string) => order.filter((x) => x !== id)

  it.each([
    ['swapping the spec and the second spec', 'maximum', (o: string[]) => swap(o, 'spec', 'spec2')],
    ['moving the preview before the review', 'standard', (o: string[]) => swap(o, 'review', 'preview')],
    ['swapping the CI and the summary', 'standard', (o: string[]) => swap(o, 'ci', 'summary')],
  ])('accepts %s', (_, preset, change) => {
    const order = change([...WORKFLOW_PRESET_DEFS[preset as WorkflowPresetId].steps])
    expect(orderProblem(preset as WorkflowPresetId, order)).toBeNull()
    expect(validateTweaks(preset as WorkflowPresetId, { order }).ok).toBe(true)
  })

  it.each([
    ['the build above the spec', (o: string[]) => swap(o, 'spec', 'build'), 'build must come after spec'],
    ['the gate above the build', (o: string[]) => swap(o, 'build', 'gate'), 'gate must come after build'],
    ['the PR above the push', (o: string[]) => swap(o, 'push', 'pr'), 'pr must come after push'],
    [
      'the preview above the gate',
      (o: string[]) => [
        ...o.slice(0, o.indexOf('gate')),
        'preview',
        'gate',
        ...o.slice(o.indexOf('gate') + 1).filter((id) => id !== 'preview'),
      ],
      'preview must come after gate',
    ],
    [
      'the intent check above the review',
      (o: string[]) => swap(o, 'review', 'intent'),
      'intent must come after review',
    ],
    ['the claim off the front', (o: string[]) => swap(o, 'claim', 'spec'), 'claim must stay first'],
    ['the hand-off off the end', (o: string[]) => swap(o, 'handoff', 'summary'), 'handoff must stay last'],
    [
      'a step missing',
      (o: string[]) => without(o, 'ci'),
      'order: it must list every step of the Standard workflow once (missing: ci)',
    ],
    ['a step twice', (o: string[]) => [...o, 'ci'], 'order: "ci" is listed twice'],
  ])('rejects %s, naming the pair', (_, change, message) => {
    const r = validateTweaks('standard', { order: change([...STANDARD]) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(message)
  })

  it('moves a step a place at a time, and says why it cannot', () => {
    const order = [...WORKFLOW_PRESET_DEFS.standard.steps]
    const up = moveStep('standard', order, 'preview', 'up')
    expect(up.ok && up.order.indexOf('preview')).toBe(order.indexOf('preview') - 1)
    expect(moveStep('standard', order, 'build', 'up')).toEqual({
      ok: false,
      reason: 'build must come after spec',
    })
    expect(moveStep('standard', order, 'claim', 'up')).toEqual({
      ok: false,
      reason: 'claim is already first',
    })
    expect(moveStep('standard', order, 'handoff', 'down')).toEqual({
      ok: false,
      reason: 'handoff is already last',
    })
    expect(moveStep('standard', order, 'spec', 'up')).toEqual({ ok: false, reason: 'claim must stay first' })
    expect(moveStep('standard', order, 'summary', 'down')).toEqual({
      ok: false,
      reason: 'handoff must stay last',
    })
  })

  it('hands the tree the reasons: every step says whether it can move up and down', () => {
    const w = resolveWorkflow('standard', undefined, 'mid')
    const by = Object.fromEntries(w.steps.map((s) => [s.id, s.moveBlocked]))
    expect(by.build).toEqual({ up: 'build must come after spec', down: 'gate must come after build' })
    expect(by.claim.up).toBe('claim is already first')
    expect(by.handoff.down).toBe('handoff is already last')
    expect(by.review).toEqual({ up: 'review must come after gate', down: null })
    expect(by.preview.up).toBeNull()
  })

  it('applies a saved order and marks the steps that moved', () => {
    const order = swap([...STANDARD], 'review', 'preview') as WorkflowStepId[]
    const w = resolveWorkflow('standard', { order }, 'mid')
    expect(w.steps.map((s) => s.id)).toEqual(order)
    expect(w.steps.filter((s) => s.edited.moved).map((s) => s.id)).toEqual(['preview', 'review'])
    expect(w.tweaked).toBe(true)
  })
})

describe('the values (A9)', () => {
  const problem = (input: unknown) => {
    const r = validateTweaks('standard', input)
    return r.ok ? null : r.error
  }

  it('accepts the efforts auto, low, medium and high, and nothing else', () => {
    for (const effort of ['auto', 'low', 'medium', 'high'])
      expect(validateTweaks('standard', { steps: { build: { effort } } }).ok, effort).toBe(true)
    expect(problem({ steps: { build: { effort: 'max' } } })).toBe(
      'steps.build.effort: one of auto, low, medium, high',
    )
    expect(problem({ steps: { build: { effort: 3 } } })).toContain('steps.build.effort')
  })

  it('refuses an effort on a step that runs no agent', () => {
    expect(problem({ steps: { gate: { effort: 'high' } } })).toContain('gate runs no agent of its own')
  })

  it('takes rounds as whole numbers from 0 to 12 per complexity', () => {
    for (const n of [0, 1, 12])
      expect(validateTweaks('standard', { rounds: { mid: n } }).ok, String(n)).toBe(true)
    for (const n of [-1, 13, 1.5, '2', null, NaN])
      expect(problem({ rounds: { mid: n } }), String(n)).toBe('rounds.mid: a whole number from 0 to 12')
  })

  it('refuses every key a step has no setting for: an instruction text and a position among them', () => {
    expect(problem({ steps: { build: { instructions: 'x' } } })).toBe(
      'steps.build: unknown key "instructions" (enabled and effort)',
    )
    expect(problem({ steps: { build: { instructions: '' } } })).toContain('unknown key "instructions"')
    expect(problem({ steps: { spec: { effort: 'high', foo: 1 } } })).toContain('unknown key "foo"')
    for (const key of ['x', 'y', 'position'])
      expect(problem({ steps: { spec: { [key]: 1 } } }), key).toContain(`unknown key "${key}"`)
    expect(problem({ x: 1 })).toBe('unknown key "x": a tweak has order, steps, agents and rounds')
    expect(problem({ instructions: 'x' })).toContain('unknown key "instructions"')
    expect(problem({ steps: { build: { enabled: false } } })).toBe('build is locked: it cannot be turned off')
    expect(validateTweaks('standard', { steps: { spec: { effort: 'high' } } }).ok).toBe(true)
  })

  it('reports every problem, the first one as the error', () => {
    const r = validateTweaks('standard', { rounds: { mid: 99 }, steps: { build: { enabled: false }, x: {} } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toHaveLength(3)
      expect(r.error).toBe(r.errors[0])
    }
  })

  it('normalizes away what is the preset default, and to null when nothing is left', () => {
    const tweak: PresetTweak = {
      order: [...WORKFLOW_PRESET_DEFS.standard.steps],
      steps: {
        build: { enabled: true, effort: 'auto' },
        intent: { effort: 'low' },
        spec: { effort: 'high' },
      },
      rounds: { low: 0, mid: 1, high: 4, max: 10 },
    }
    expect(normalizeTweaks('standard', tweak)).toEqual({
      steps: { spec: { effort: 'high' } },
      rounds: { high: 4 },
    })
    expect(normalizeTweaks('standard', { order: [...WORKFLOW_PRESET_DEFS.standard.steps] })).toBeNull()
    expect(normalizeTweaks('standard', {})).toBeNull()
    expect(normalizeTweaks('standard', null)).toBeNull()
    expect(normalizeTweaks('standard', { steps: { build: {} }, rounds: {} })).toBeNull()
    // Maximum's own default effort is not a tweak; auto is.
    expect(normalizeTweaks('maximum', { steps: { build: { effort: 'high' } } })).toBeNull()
    expect(normalizeTweaks('maximum', { steps: { build: { effort: 'auto' } } })).toEqual({
      steps: { build: { effort: 'auto' } },
    })
  })
})

describe('a tweak the catalogue no longer matches (A10)', () => {
  it('resolves to the default workflow and never throws', () => {
    const stale = {
      order: ['claim', 'gone', 'build', 'spec', 'gate'],
      steps: { gone: { enabled: false }, build: { enabled: false, effort: 'bogus' }, ci: 'nope' },
      rounds: { mid: 99, huge: 3 },
      agents: { build: 7, gone: 'x', gate: 'y', 'review.first': 'z' },
      extra: true,
    }
    const w = resolveWorkflow('standard', stale, 'mid')
    expect(w.steps.map((s) => s.id)).toEqual(STANDARD)
    expect(w.rounds).toEqual({ low: 0, mid: 1, high: 3, max: 10 })
    expect(w.tweaked).toBe(false)
    for (const junk of [null, undefined, 3, 'x', [], { steps: 4 }, { order: 'a' }, { rounds: [] }])
      expect(() => resolveWorkflow('standard', junk, 'mid')).not.toThrow()
  })

  it('ignores the unknown ids of an order that is otherwise valid, and keeps the valid parts', () => {
    const order = [
      'claim',
      'spec',
      'build',
      'gate',
      'preview',
      'review',
      'intent',
      'push',
      'pr',
      'ci',
      'summary',
      'handoff',
    ]
    const w = resolveWorkflow(
      'standard',
      {
        order: [...order.slice(0, 4), 'gone', ...order.slice(4), 'retired'],
        steps: { ci: { enabled: false }, retired: {} },
      },
      'mid',
    )
    expect(w.steps.map((s) => s.id)).toEqual(order)
    expect(w.steps.find((s) => s.id === 'ci')!.skipped?.reason).toBe('off')
  })

  it('reads a project’s stored tweaks leniently', () => {
    expect(readProjectTweaks(null)).toEqual({})
    expect(readProjectTweaks('x')).toEqual({})
    expect(
      readProjectTweaks({
        standard: { rounds: { mid: 2, high: 99 } },
        light: { steps: { build: { enabled: false } } },
        gone: {},
      }),
    ).toEqual({ standard: { rounds: { mid: 2 } } })
  })
})

describe('the effort (A11)', () => {
  it('follows the complexity with auto: low, medium, medium, high', () => {
    const levels = COMPLEXITIES.map(
      (level) =>
        resolveWorkflow('standard', undefined, level).steps.find((s) => s.id === 'build')!.effortLevel,
    )
    expect(levels).toEqual(['low', 'medium', 'medium', 'high'])
    expect(resolveWorkflow('standard').steps.find((s) => s.id === 'build')!.effortLevel).toBeNull()
    expect(resolveWorkflow('standard').steps.find((s) => s.id === 'build')!.effort).toBe('auto')
  })

  it('lets an explicit effort win, and keeps the intent check at low in every preset', () => {
    const tweak = { steps: { build: { effort: 'high' as const }, spec: { effort: 'low' as const } } }
    const w = resolveWorkflow('standard', tweak, 'low')
    expect(w.steps.find((s) => s.id === 'build')!.effortLevel).toBe('high')
    expect(w.steps.find((s) => s.id === 'build')!.edited.effort).toBe(true)
    for (const preset of WORKFLOW_PRESETS)
      for (const level of COMPLEXITIES)
        expect(
          resolveWorkflow(preset, undefined, level).steps.find((s) => s.id === 'intent')!.effortLevel,
        ).toBe('low')
    const raised = resolveWorkflow('standard', { steps: { intent: { effort: 'medium' } } }, 'mid')
    expect(raised.steps.find((s) => s.id === 'intent')!.effortLevel).toBe('medium')
  })
})

describe('the phases a round needs (A12)', () => {
  it('counts the runs of each kind per preset', () => {
    expect(runs('standard')).toEqual({ spec: 1, env: 1, verify: 1, hunt: 2, refute: 1, merge: 1 })
    expect(runs('light')).toEqual({ hunt: 1 })
    expect(runs('thorough')).toEqual({ spec: 1, env: 1, verify: 1, hunt: 3, refute: 1, merge: 1 })
    expect(runs('maximum')).toEqual({ spec: 2, env: 2, verify: 2, hunt: 6, refute: 2, merge: 2 })
  })

  it('lists them in the order the cycle runs them', () => {
    expect(reviewPhaseRuns(resolveWorkflow('standard', undefined, 'mid')).map((p) => p.phase)).toEqual([
      'spec',
      'env',
      'verify',
      'hunt',
      'refute',
      'merge',
    ])
  })

  it('is empty for a low ticket, a review switched off and a review with no rounds', () => {
    for (const preset of WORKFLOW_PRESETS) expect(runs(preset, 'low')).toEqual({})
    expect(runs('standard', 'mid', { steps: { review: { enabled: false } } })).toEqual({})
    expect(runs('standard', 'high', { rounds: { high: 0 } })).toEqual({})
  })

  it('follows a review a human gave a low ticket', () => {
    expect(runs('standard', 'low', { rounds: { low: 1 } })).toEqual({
      spec: 1,
      env: 1,
      verify: 1,
      hunt: 2,
      refute: 1,
      merge: 1,
    })
  })
})

describe('what the human edited', () => {
  it('marks the steps, the tweak and the rounds, and keeps the hand-off the preset words', () => {
    const tweak = {
      steps: { build: { effort: 'high' as const }, ci: { enabled: false } },
      agents: { build: 'acme-dev' },
      rounds: { mid: 3 },
    }
    const w = resolveWorkflow('standard', tweak, 'mid', ['acme-dev'])
    const build = w.steps.find((s) => s.id === 'build')!
    expect(build.handoff).toBe(WORKFLOW_STEPS.build.handoff)
    expect(build.edited).toEqual({ enabled: false, effort: true, agent: true, moved: false, any: true })
    expect(w.steps.find((s) => s.id === 'ci')!.edited.enabled).toBe(true)
    expect(w.steps.find((s) => s.id === 'gate')!.edited.any).toBe(false)
    expect(w.rounds.mid).toBe(3)
    expect(w.defaultRounds.mid).toBe(1)
    expect(reviewOf('standard', 'mid', tweak).review!.rounds).toBe(3)
    expect(w.tweak).toEqual({
      steps: { build: { effort: 'high' }, ci: { enabled: false } },
      agents: { build: 'acme-dev' },
      rounds: { mid: 3 },
    })
  })

  it("serves the preset's hand-off wording for every step and never marks one as edited by text (A4, A8)", () => {
    for (const preset of WORKFLOW_PRESETS)
      for (const level of COMPLEXITIES) {
        const w = resolveWorkflow(preset, { steps: { build: { instructions: 'x' } } }, level)
        expect(w.tweaked, `${preset} ${level}`).toBe(false)
        expect(w.tweak).toBeNull()
        for (const step of w.steps) {
          expect(step.handoff.length).toBeGreaterThan(0)
          expect(Object.keys(step.edited).sort()).toEqual(['agent', 'any', 'effort', 'enabled', 'moved'])
          expect(step.handoff).not.toBe('x')
        }
      }
    // The flow variants of the wording still read from the preset, not from a stored value.
    expect(stepHandoff('thorough', 'intent')).toContain('an ordinary round of the budget')
    expect(
      resolveWorkflow('standard', { steps: { build: { instructions: 'x' } } }, 'mid').steps[2]!.handoff,
    ).toBe(WORKFLOW_STEPS.build.handoff)
  })

  it('drops a stored instruction when reading, and keeps what sits beside it (A8)', () => {
    expect(
      readProjectTweaks({
        standard: { steps: { build: { instructions: 'x', effort: 'high' }, spec: { instructions: 'y' } } },
        light: { steps: { intent: { instructions: 'z' } } },
      }),
    ).toEqual({ standard: { steps: { build: { effort: 'high' } } } })
    expect(
      JSON.stringify(
        readProjectTweaks({ standard: { instructions: 'x', steps: { ci: { instructions: 'q' } } } }),
      ),
    ).not.toContain('instructions')
  })

  it('is per preset: a tweak of one leaves the others as shipped', () => {
    const tweak: PresetTweak = { rounds: { mid: 5 } }
    expect(resolveWorkflow('thorough', tweak).rounds.mid).toBe(5)
    expect(resolveWorkflow('thorough').rounds.mid).toBe(2)
  })
})
