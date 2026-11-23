import { describe, expect, it } from 'vitest'

import { WORKFLOW_PRESETS, resolveWorkflow } from './workflow'
import { effortText, groupSubSteps, moveReason, roundsText, skipText } from './workflowView'

const step = (workflow: ReturnType<typeof resolveWorkflow>, id: string) =>
  workflow.steps.find((s) => s.id === id)!

describe('how the graph words things', () => {
  it('writes rounds', () => {
    expect(roundsText(0)).toBe('no review rounds')
    expect(roundsText(1)).toBe('1 round')
    expect(roundsText(10)).toBe('10 rounds')
  })

  it('writes an effort chip: an explicit effort as it is, auto with the level it comes to', () => {
    const mid = resolveWorkflow('standard', null, 'mid')
    expect(effortText(step(mid, 'build'))).toBe('Auto: medium')
    expect(effortText(step(mid, 'intent'))).toBe('Low')
    expect(effortText(step(mid, 'gate'))).toBeNull()
    expect(effortText(step(resolveWorkflow('standard', null, null), 'build'))).toBe('Auto')
    expect(effortText(step(resolveWorkflow('maximum', null, 'mid'), 'build'))).toBe('High')
    expect(effortText(step(resolveWorkflow('standard', null, 'max'), 'review'))).toBe('Auto: high')
  })

  it('says why a step is not run', () => {
    const low = resolveWorkflow('standard', null, 'low')
    expect(skipText(step(low, 'spec'))).toBe('Skipped on low')
    expect(skipText(step(low, 'review'))).toBe('Skipped on low')
    expect(skipText(step(low, 'build'))).toBeNull()
    const off = resolveWorkflow('standard', { steps: { ci: { enabled: false } } }, 'mid')
    expect(skipText(step(off, 'ci'))).toBe('Off')
    const none = resolveWorkflow('standard', { rounds: { mid: 0 } }, 'mid')
    expect(skipText(step(none, 'review'))).toBe('No review rounds')
  })

  it('names the steps of a refused move as the graph does', () => {
    expect(moveReason('build must come after spec')).toBe('Build must come after Spec')
    expect(moveReason('claim must stay first')).toBe('Read and claim must stay first')
    expect(moveReason('handoff must stay last')).toBe('Hand-off must stay last')
    expect(moveReason('pr must come after push')).toBe('Pull request must come after Push')
  })

  it('has the reason the board gives for a move that breaks the order, in words the graph can use', () => {
    const w = resolveWorkflow('standard', null, 'mid')
    expect(moveReason(step(w, 'build').moveBlocked.up!)).toBe('Build must come after Spec')
    expect(step(w, 'preview').moveBlocked.up).toBeNull()
  })
})

describe('groupSubSteps', () => {
  const review = (preset: (typeof WORKFLOW_PRESETS)[number]) =>
    step(resolveWorkflow(preset, null, 'mid'), 'review').review!

  it('puts verify and the hunts of Standard side by side, and every other phase on its own', () => {
    const items = groupSubSteps(review('standard').phases)
    expect(items.map((i) => (i.kind === 'single' ? i.step.id : i.steps.map((s) => s.id)))).toEqual([
      'review.spec',
      'review.env',
      ['review.verify', 'review.hunt-a', 'review.hunt-b'],
      'review.refute',
      'review.merge',
    ])
  })

  it('gives Thorough a third hunt in the parallel group, and Light no group at all', () => {
    const thorough = groupSubSteps(review('thorough').phases).find((i) => i.kind === 'parallel')
    expect(thorough?.kind === 'parallel' && thorough.steps.map((s) => s.id)).toEqual([
      'review.verify',
      'review.hunt-a',
      'review.hunt-b',
      'review.hunt-security',
    ])
    expect(groupSubSteps(review('light').phases).map((i) => i.kind)).toEqual(['single'])
  })

  it('leaves a second full review whole: its own phases are inside it, not beside it', () => {
    const items = groupSubSteps(review('maximum').phases)
    expect(items.every((i) => i.kind === 'single')).toBe(true)
    expect(items.map((i) => (i.kind === 'single' ? i.step.id : ''))).toEqual([
      'review.first',
      'review.second',
      'review.reconcile',
      'review.intent',
    ])
  })
})
