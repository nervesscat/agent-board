import { describe, expect, it } from 'vitest'

import { COMPLEXITIES } from './constants'
import {
  WORKFLOW_PRESETS,
  WORKFLOW_PRESET_DEFS,
  WORKFLOW_STEPS,
  WORKFLOW_STEP_IDS,
  addStep,
  addableSteps,
  bindableNodes,
  customNameProblem,
  customOrderProblem,
  customSource,
  isCustomWorkflowId,
  moveStep,
  normalizeTweaks,
  readCustomWorkflows,
  removableStep,
  removeStep,
  resolveWorkflow,
  reviewPhaseRuns,
  validateTweaks,
  type PresetTweak,
  type WorkflowPresetId,
  type WorkflowStepId,
} from './workflow'

/** A custom workflow made as the board makes one: a copy of a preset's order, nothing else changed. */
const copyOf = (base: WorkflowPresetId, tweak: PresetTweak = {}) => {
  const id = 'custom-abcdef0123'
  const order = tweak.order ?? [...WORKFLOW_PRESET_DEFS[base].steps]
  const source = customSource({ id, name: 'Mine', base })
  const kept = normalizeTweaks(source, { ...tweak, order })!
  return { source: customSource({ id, name: 'Mine', base, seed: kept }), tweak: kept }
}

describe('a custom workflow resolves like the preset it was copied from', () => {
  for (const base of WORKFLOW_PRESETS)
    for (const complexity of COMPLEXITIES)
      it(`an unchanged copy of ${base} for a ${complexity} ticket has the same steps, review and checks`, () => {
        const { source, tweak } = copyOf(base)
        const mine = resolveWorkflow(source, tweak, complexity, ['spec'])
        const theirs = resolveWorkflow(base, undefined, complexity, ['spec'])
        expect(mine.steps).toEqual(theirs.steps)
        expect(mine.order).toEqual(theirs.order)
        expect(mine.rounds).toEqual(theirs.rounds)
        expect(mine.flow).toEqual(theirs.flow)
        expect(reviewPhaseRuns(mine)).toEqual(reviewPhaseRuns(theirs))
        expect([mine.preset, mine.base, mine.custom, mine.label, mine.tweaked]).toEqual([
          'custom-abcdef0123',
          base,
          true,
          'Mine',
          false,
        ])
        expect([theirs.preset, theirs.base, theirs.custom]).toEqual([base, base, false])
      })

  it('keeps the tweaks of the copy: a Team agent, an effort, rounds and a switch', () => {
    const { source } = copyOf('standard')
    const tweak = normalizeTweaks(source, {
      order: [...WORKFLOW_PRESET_DEFS.standard.steps],
      steps: { build: { effort: 'high' }, preview: { enabled: false } },
      agents: { build: 'Maker', 'review.hunt-a': 'Sharp' },
      rounds: { mid: 4 },
    })!
    const w = resolveWorkflow(source, tweak, 'mid', ['Maker', 'Sharp'])
    expect(w.tweaked).toBe(true)
    expect(w.steps.find((s) => s.id === 'build')!.effort).toBe('high')
    expect(w.steps.find((s) => s.id === 'build')!.teamAgent?.name).toBe('Maker')
    expect(w.steps.find((s) => s.id === 'preview')!.skipped?.reason).toBe('off')
    expect(w.rounds.mid).toBe(4)
    expect(w.defaultRounds.mid).toBe(1)
    const hunt = w.steps.find((s) => s.id === 'review')!.review!.phases.find((p) => p.id === 'review.hunt-a')
    expect(hunt!.teamAgent?.name).toBe('Sharp')
  })
})

describe('whether a custom workflow differs from how it was made', () => {
  it('does not depend on the order of the keys the settings were saved in', () => {
    const order = [...WORKFLOW_PRESET_DEFS.thorough.steps]
    const made = {
      order,
      steps: { preview: { enabled: false }, ci: { enabled: false }, build: { effort: 'high' as const } },
    }
    const { source } = copyOf('thorough', made)
    const same = {
      order,
      steps: { build: { effort: 'high' as const }, ci: { enabled: false }, preview: { enabled: false } },
    }
    expect(resolveWorkflow(source, normalizeTweaks(source, made), 'mid', []).tweaked).toBe(false)
    expect(resolveWorkflow(source, same, 'mid', []).tweaked).toBe(false)
    // A real difference still shows.
    const other = {
      ...same,
      steps: { ...same.steps, ci: { enabled: false }, preview: { effort: 'low' as const } },
    }
    expect(resolveWorkflow(source, other, 'mid', []).tweaked).toBe(true)
  })
})

describe('the steps of a custom workflow', () => {
  const standard = [...WORKFLOW_PRESET_DEFS.standard.steps]

  it('offers the kinds it lacks, once each, and removes only steps with no lock', () => {
    expect(addableSteps(standard)).toEqual(['spec2', 'tests'])
    const removable = WORKFLOW_STEP_IDS.filter(removableStep)
    expect(removable).toEqual(['spec', 'spec2', 'tests', 'review', 'preview', 'ci'])
    // The Standard steps that cannot go (a step only Content has is not in its order to remove).
    for (const id of WORKFLOW_STEP_IDS.filter((x) => !removable.includes(x) && standard.includes(x))) {
      expect(WORKFLOW_STEPS[id].lock !== null || WORKFLOW_STEPS[id].pinned !== null).toBe(true)
      const r = removeStep(standard, id)
      expect(r.ok).toBe(false)
      if (!r.ok && id !== 'claim' && id !== 'handoff')
        expect(r.reason).toBe(`${id} is locked: it cannot be removed`)
    }
  })

  it('adds a kind where it belongs and refuses a kind that is not one, or one it has', () => {
    const light = [...WORKFLOW_PRESET_DEFS.light.steps]
    const added = addStep(light, 'tests')
    expect(added).toEqual({
      ok: true,
      order: [
        'claim',
        'build',
        'tests',
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
    })
    expect(addStep(light, 'spec')).toEqual({
      ok: true,
      order: [
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
      ],
    })
    expect(addStep(standard, 'spec')).toEqual({
      ok: false,
      reason: 'spec is already a step of this workflow',
    })
    expect(addStep(standard, 'deploy')).toEqual({
      ok: false,
      reason: '"deploy" is not a kind of step the workflow has',
    })
    // Whatever it adds, the order holds.
    for (const id of addableSteps(light)) {
      const r = addStep(light, id)
      expect(r.ok && customOrderProblem(r.order)).toBe(null)
    }
  })

  it('says what stands in the way when a step has no place in the order', () => {
    // Intent before the Gate: Review and Preview must come before Intent, which cannot happen after the Gate.
    const odd: WorkflowStepId[] = ['claim', 'build', 'intent', 'gate', 'push', 'pr', 'summary', 'handoff']
    const r = addStep(odd, 'review')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('review cannot be added to this order')
    expect(r.reason).toContain('intent must come after')
    // Moving Intent below the Gate makes room.
    const fixed = addStep(['claim', 'build', 'gate', 'intent', 'push', 'pr', 'summary', 'handoff'], 'review')
    expect(fixed.ok).toBe(true)
  })

  it('places a kind after the steps that come before it even when the order was changed', () => {
    const r = addStep(
      ['claim', 'build', 'gate', 'preview', 'review', 'intent', 'push', 'pr', 'summary', 'handoff'],
      'tests',
    )
    expect(r.ok && r.order.slice(0, 4)).toEqual(['claim', 'build', 'tests', 'gate'])
  })

  it('removes a step and removing review leaves a workflow with no review', () => {
    const r = removeStep(standard, 'review')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { source, tweak } = copyOf('standard', { order: r.order })
    const w = resolveWorkflow(source, tweak, 'high', [])
    expect(w.steps.map((s) => s.id)).not.toContain('review')
    expect(w.flow.review).toBe(false)
    expect(w.flow.roundIntent).toBe(false)
    expect(reviewPhaseRuns(w)).toEqual([])
    expect(bindableNodes(source, r.order).some((n) => n.id.startsWith('review.'))).toBe(false)
  })

  it('refuses an order that drops a locked step, repeats one, moves the ends or breaks a dependency', () => {
    expect(customOrderProblem(standard)).toBe(null)
    expect(customOrderProblem(standard.filter((x) => x !== 'build'))).toBe(
      'build is locked: it cannot be removed',
    )
    expect(customOrderProblem(standard.filter((x) => x !== 'intent'))).toBe(
      'intent is locked: it cannot be removed',
    )
    expect(customOrderProblem([...standard.slice(0, -1), 'spec', 'handoff'])).toBe(
      'order: "spec" is listed twice',
    )
    expect(customOrderProblem(['spec', 'claim', ...standard.slice(2)])).toBe('claim must stay first')
    expect(customOrderProblem(['claim', 'build', 'spec', ...standard.slice(3)])).toBe(
      'build must come after spec',
    )
    expect(customOrderProblem([...standard.slice(0, -1).reverse(), 'handoff'])).toBe('claim must stay first')
    expect(customOrderProblem([...standard, 'foo'])).toBe(
      'order: "foo" is not a kind of step the workflow has',
    )
  })

  it('moves a step of a custom workflow with the same refusals as a preset', () => {
    const { source } = copyOf('standard')
    expect(moveStep(source, standard, 'gate', 'up')).toEqual({
      ok: false,
      reason: 'gate must come after build',
    })
    expect(moveStep(source, standard, 'preview', 'down')).toEqual({
      ok: false,
      reason: 'intent must come after preview',
    })
    const up = moveStep(source, standard, 'preview', 'up')
    expect(up.ok && up.order.indexOf('preview')).toBe(standard.indexOf('preview') - 1)
  })
})

describe('validating a custom workflow’s tweak', () => {
  const { source } = copyOf('light')
  const order = [...WORKFLOW_PRESET_DEFS.light.steps]

  it('takes the step list as the order and keeps the stored one when a body leaves it out', () => {
    const added = addStep(order, 'tests')
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const ok = validateTweaks(source, { order: added.order }, {})
    expect(ok.ok && ok.tweak.order).toEqual(added.order)
    const keeps = validateTweaks(source, { rounds: { mid: 2 } }, { order: added.order })
    expect(keeps.ok && keeps.tweak.order).toEqual(added.order)
  })

  it('refuses a step list with a locked step missing and a setting on a step it does not have', () => {
    const bad = validateTweaks(source, { order: order.filter((x) => x !== 'gate') }, {})
    expect(bad).toMatchObject({ ok: false, error: 'gate is locked: it cannot be removed' })
    const off = validateTweaks(source, { steps: { tests: { enabled: false } } }, {})
    expect(off).toMatchObject({ ok: false, error: 'steps: tests is not a step of the Mine workflow' })
    const agent = validateTweaks(
      source,
      { order: order.filter((x) => x !== 'review'), agents: { 'review.reviewer': 'x' } },
      { team: ['x'] },
    )
    expect(agent).toMatchObject({ ok: false })
    expect(!agent.ok && agent.error).toContain('no review step')
  })

  it('drops the settings of a step that was removed when it normalizes', () => {
    const noPreview = order.filter((x) => x !== 'preview')
    const kept = normalizeTweaks(source, {
      order: noPreview,
      steps: { preview: { enabled: false }, intent: { effort: 'high' } },
    })
    expect(kept).toEqual({ order: noPreview, steps: { intent: { effort: 'high' } } })
  })
})

describe('the review rounds of a workflow with no review', () => {
  it('are not kept, and the workflow is not changed for them; adding the review back starts from the preset’s', () => {
    const order = [...WORKFLOW_PRESET_DEFS.standard.steps]
    const without = order.filter((id) => id !== 'review')
    const source = customSource({ id: 'custom-abcdef0123', name: 'Mine', base: 'standard', seed: { order } })
    expect(normalizeTweaks(source, { order: without, rounds: { mid: 4, max: 2 } })).toEqual({
      order: without,
    })
    expect(normalizeTweaks(source, { order, rounds: { mid: 4 } })).toEqual({ order, rounds: { mid: 4 } })
    const w = resolveWorkflow(source, { order: without, rounds: { mid: 4 } }, 'mid')
    expect(w.tweak).toEqual({ order: without })
    expect(w.rounds).toEqual(WORKFLOW_PRESET_DEFS.standard.rounds)
    // Stored with rounds and no review (an older save, or a body from elsewhere) reads the same.
    const back = resolveWorkflow(source, { order, rounds: undefined }, 'mid')
    expect(back.tweaked).toBe(false)
  })
})

describe('naming a custom workflow', () => {
  it('trims, bounds, and refuses a preset’s name or a taken one in any casing', () => {
    expect(customNameProblem('  Our   flow ', [])).toEqual({ ok: true, name: 'Our flow' })
    expect(customNameProblem('   ', [])).toMatchObject({ ok: false })
    expect(customNameProblem(42, [])).toMatchObject({ ok: false })
    expect(customNameProblem('x'.repeat(61), [])).toMatchObject({ ok: false })
    expect(customNameProblem('x'.repeat(60), [])).toMatchObject({ ok: true })
    expect(customNameProblem('standard', [])).toMatchObject({ ok: false })
    expect(customNameProblem('Our flow', [{ name: 'our FLOW' }])).toMatchObject({ ok: false })
  })

  it('takes out what draws nothing before it judges a name, and keeps tabs and line breaks as spaces', () => {
    expect(customNameProblem('\u200b', [])).toMatchObject({ ok: false })
    expect(customNameProblem('\u202e\u2060\ufeff', [])).toMatchObject({ ok: false })
    expect(customNameProblem('standard\u200b', [])).toMatchObject({ ok: false })
    expect(customNameProblem('Our\u200b flow\u0000', [{ name: 'our flow' }])).toMatchObject({ ok: false })
    expect(customNameProblem('Our\u202e flow', [])).toEqual({ ok: true, name: 'Our flow' })
    expect(customNameProblem('Our\tflow\nhere', [])).toEqual({ ok: true, name: 'Our flow here' })
    // The joiners are part of words and emoji sequences, and stay as typed.
    expect(customNameProblem('گردش\u200cکار', [])).toEqual({ ok: true, name: 'گردش\u200cکار' })
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'
    expect(customNameProblem(`Our ${family}`, [])).toEqual({ ok: true, name: `Our ${family}` })
    // The joiners alone draw nothing: they are not a name, and they do not make a name another one.
    expect(customNameProblem('\u200c', [])).toMatchObject({ ok: false })
    expect(customNameProblem('\u200d\u200c \u200d', [])).toMatchObject({ ok: false })
    expect(customNameProblem('My flow\u200d', [{ name: 'My flow' }])).toMatchObject({ ok: false })
    expect(customNameProblem('My flow', [{ name: 'My\u200c flow' }])).toMatchObject({ ok: false })
    expect(customNameProblem('Standard\u200d', [])).toMatchObject({ ok: false })
    // The limit counts the cleaned name.
    expect(customNameProblem(`${'x'.repeat(60)}\u200b`, [])).toMatchObject({ ok: true })
    expect(customNameProblem(`${'x'.repeat(61)}\u200b`, [])).toMatchObject({ ok: false })
  })

  it('knows its ids from the presets’ ids', () => {
    expect(isCustomWorkflowId('custom-abcdef0123')).toBe(true)
    for (const id of [...WORKFLOW_PRESETS, 'custom-', 'custom-ABC', 'x', null, 3])
      expect(isCustomWorkflowId(id)).toBe(false)
  })
})

describe('reading the stored list', () => {
  it('never throws: bad entries are dropped, a stale order reads as the one it was made with', () => {
    expect(readCustomWorkflows(null)).toEqual([])
    expect(readCustomWorkflows('x')).toEqual([])
    const good = copyOf('thorough')
    const stored = [
      { id: 'custom-abcdef0123', name: ' Mine ', base: 'thorough', tweak: good.tweak, seed: good.tweak },
      { id: 'custom-abcdef0123', name: 'Twin', base: 'light' },
      { id: 'light', name: 'Preset id' },
      { id: 'custom-zzzzzz9999', name: '' },
      { id: 'custom-qqqqqq8888', name: 'Odd', base: 'nope', tweak: { order: ['claim', 'handoff'] }, seed: 4 },
      7,
    ]
    const read = readCustomWorkflows(stored)
    expect(read.map((c) => [c.id, c.name, c.base])).toEqual([
      ['custom-abcdef0123', 'Mine', 'thorough'],
      ['custom-qqqqqq8888', 'Odd', 'standard'],
    ])
    expect(read[1]!.tweak.order).toEqual([...WORKFLOW_PRESET_DEFS.standard.steps])
    const w = resolveWorkflow(customSource(read[1]!), read[1]!.tweak, 'mid')
    expect(w.order as WorkflowStepId[]).toEqual([...WORKFLOW_PRESET_DEFS.standard.steps])
  })
})
