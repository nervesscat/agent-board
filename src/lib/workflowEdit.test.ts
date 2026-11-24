import { describe, expect, it } from 'vitest'

import { ROUNDS_MAX, normalizeTweaks, resolveWorkflow, validateTweaks, type PresetTweak } from './workflow'
import {
  parseRounds,
  tweakBody,
  withEffort,
  withAgent,
  withEnabled,
  withOrder,
  withRounds,
} from './workflowEdit'

describe('the changes the Workflow page makes to a preset tweak', () => {
  it('switches a step off and back on, leaving nothing of it behind', () => {
    const off = withEnabled(null, 'ci', false)
    expect(off).toEqual({ steps: { ci: { enabled: false } } })
    expect(withEnabled(off, 'ci', true)).toEqual({})
    // The other settings of the step stay when only the switch goes back on.
    const both = withEffort(off, 'spec', 'high')
    expect(withEnabled(both, 'ci', true)).toEqual({ steps: { spec: { effort: 'high' } } })
  })

  it('sets an effort, and the Team agent of a step or a phase, and takes an agent back with null', () => {
    const t1 = withEffort(null, 'build', 'high')
    const t2 = withAgent(t1, 'build', 'acme-dev')
    expect(t2).toEqual({ steps: { build: { effort: 'high' } }, agents: { build: 'acme-dev' } })
    expect(withAgent(t2, 'review.hunt-a', 'sec-hunter').agents).toEqual({
      build: 'acme-dev',
      'review.hunt-a': 'sec-hunter',
    })
    expect(withAgent(t2, 'build', null)).toEqual({ steps: { build: { effort: 'high' } } })
    expect(withAgent(withAgent(null, 'spec', 'x'), 'spec', null)).toEqual({})
    // An effort or a switch saved after a pick leaves the pick (one whose agent left the Team too).
    expect(withEffort(t2, 'spec', 'low').agents).toEqual({ build: 'acme-dev' })
    expect(withEnabled(t2, 'ci', false).agents).toEqual({ build: 'acme-dev' })
    expect(withRounds(t2, 'mid', 2).agents).toEqual({ build: 'acme-dev' })
    expect(withOrder(t2, resolveWorkflow('standard').defaultOrder).agents).toEqual({ build: 'acme-dev' })
  })

  it('sets the rounds of one complexity without touching the others, and the order as a whole', () => {
    const t = withRounds(withRounds(null, 'mid', 2), 'high', 4)
    expect(t).toEqual({ rounds: { mid: 2, high: 4 } })
    const order = resolveWorkflow('standard').defaultOrder
    expect(withOrder(t, order)).toEqual({ rounds: { mid: 2, high: 4 }, order })
  })

  it('never changes the tweak it is given', () => {
    const base: PresetTweak = { steps: { ci: { enabled: false } }, rounds: { mid: 2 } }
    const copy = structuredClone(base)
    withEnabled(base, 'ci', true)
    withEffort(base, 'build', 'low')
    withAgent(base, 'build', 'acme-dev')
    withRounds(base, 'max', 3)
    withOrder(base, ['claim'])
    expect(base).toEqual(copy)
  })

  it('makes a body the board accepts for every change it makes, and one that resolves as asked', () => {
    let tweak: PresetTweak | null = null
    tweak = withEnabled(tweak, 'ci', false)
    tweak = withEffort(tweak, 'build', 'high')
    tweak = withAgent(tweak, 'review.hunt-a', 'sec-hunter')
    tweak = withRounds(tweak, 'mid', 2)
    const body = tweakBody(tweak)
    const checked = validateTweaks('standard', body, { team: ['sec-hunter'] })
    expect(checked.ok).toBe(true)
    const w = resolveWorkflow('standard', body, 'mid', ['sec-hunter'])
    expect(w.steps.find((s) => s.id === 'ci')!.skipped?.reason).toBe('off')
    expect(w.steps.find((s) => s.id === 'build')!.effortLevel).toBe('high')
    const review = w.steps.find((s) => s.id === 'review')!.review!
    expect(review.phases.find((p) => p.id === 'review.hunt-a')!.teamAgent?.name).toBe('sec-hunter')
    expect(w.rounds.mid).toBe(2)
  })

  it('makes an empty body of a tweak with nothing left, which the board reads as the preset as shipped', () => {
    expect(tweakBody({})).toEqual({})
    expect(tweakBody({ steps: {}, agents: {}, rounds: {} })).toEqual({})
    expect(tweakBody({ agents: { build: 'acme-dev' } })).toEqual({ agents: { build: 'acme-dev' } })
    expect(normalizeTweaks('standard', {})).toBeNull()
  })
})

describe('parseRounds', () => {
  it('accepts whole numbers from 0 to the most', () => {
    expect(parseRounds('0')).toEqual({ ok: true, rounds: 0 })
    expect(parseRounds(' 2 ')).toEqual({ ok: true, rounds: 2 })
    expect(parseRounds(String(ROUNDS_MAX))).toEqual({ ok: true, rounds: ROUNDS_MAX })
  })

  it.each(['', '  ', '-1', '1.5', 'two', String(ROUNDS_MAX + 1), '1e1'])(
    'refuses %j, naming the range',
    (text) => {
      const r = parseRounds(text)
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.error).toBe(`Rounds are a whole number from 0 to ${ROUNDS_MAX}`)
    },
  )
})
