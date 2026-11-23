import { describe, expect, it } from 'vitest'

import { WORKFLOW_PRESETS, resolveWorkflow, type WorkflowPresetId } from './workflow'
import {
  defaultAgentName,
  findNode,
  graphNodes,
  loopLabel,
  nodeView,
  parallelColumns,
  phaseView,
  roundRows,
  stepView,
  type RoundRow,
} from './workflowGraph'

const resolved = (
  preset: WorkflowPresetId,
  complexity: 'low' | 'mid' | 'high' | 'max' = 'mid',
  tweak?: unknown,
  team: string[] = [],
) => resolveWorkflow(preset, tweak, complexity, team)
const reviewOf = (preset: WorkflowPresetId) => resolved(preset).steps.find((s) => s.id === 'review')!.review!

/** The rows as ids, a parallel row as the list of its ids and a frame as `{frame: rows}`. */
const shape = (rows: readonly RoundRow[]): unknown[] =>
  rows.map((row) =>
    row.kind === 'node'
      ? row.step.id
      : row.kind === 'parallel'
        ? row.steps.map((s) => s.id)
        : { [row.step.id]: shape(row.rows) },
  )

describe('roundRows', () => {
  it('lays Standard out as a column with verify and the two hunts in one row', () => {
    expect(shape(roundRows(reviewOf('standard').phases))).toEqual([
      'review.spec',
      'review.env',
      ['review.verify', 'review.hunt-a', 'review.hunt-b'],
      'review.refute',
      'review.merge',
    ])
  })

  it('puts the security hunt in the same row for Thorough, after which the round-end intent check follows', () => {
    expect(shape(roundRows(reviewOf('thorough').phases))).toEqual([
      'review.spec',
      'review.env',
      ['review.verify', 'review.hunt-a', 'review.hunt-b', 'review.hunt-security'],
      'review.refute',
      'review.merge',
      'review.intent',
    ])
  })

  it('draws Light as one reviewer, with nothing to fork', () => {
    expect(shape(roundRows(reviewOf('light').phases))).toEqual(['review.reviewer'])
  })

  it("draws Maximum's two full reviews as two frames beside each other in the round, never one inside the other", () => {
    const rows = roundRows(reviewOf('maximum').phases)
    expect(rows.map((r) => (r.kind === 'frame' ? r.step.id : r.kind === 'node' ? r.step.id : 'row'))).toEqual(
      ['review.first', 'review.second', 'review.reconcile', 'review.intent'],
    )
    for (const frame of rows.filter((r) => r.kind === 'frame')) {
      expect(frame.kind === 'frame' && frame.rows.some((r) => r.kind === 'frame')).toBe(false)
    }
    const first = rows[0]!
    expect(first.kind === 'frame' && shape(first.rows)).toEqual([
      'review.first.spec',
      'review.first.env',
      ['review.first.verify', 'review.first.hunt-a', 'review.first.hunt-b', 'review.first.hunt-security'],
      'review.first.refute',
      'review.first.merge',
    ])
  })

  it('does not call a group of one parallel', () => {
    const review = reviewOf('standard')
    const verify = review.phases.find((p) => p.id === 'review.verify')!
    expect(shape(roundRows([verify]))).toEqual(['review.verify'])
  })
})

describe('loopLabel', () => {
  it('says the rounds the complexity gets, and that a ticket with none gets none', () => {
    expect(loopLabel(3, 'high')).toBe('3 rounds')
    expect(loopLabel(1, 'mid')).toBe('1 round')
    expect(loopLabel(10, 'max')).toBe('10 rounds')
    expect(loopLabel(0, 'low')).toBe('No review rounds on low')
    expect(loopLabel(0, 'mid')).toBe('No review rounds on mid')
  })
})

describe('graphNodes and findNode', () => {
  it('lists the steps in order, with the review followed by its phases, then the fix pass and the gate', () => {
    const ids = graphNodes(resolved('standard')).map((n) => n.id)
    expect(ids.slice(0, 5)).toEqual(['claim', 'spec', 'build', 'gate', 'review'])
    expect(ids.slice(5, 14)).toEqual([
      'review.spec',
      'review.env',
      'review.verify',
      'review.hunt-a',
      'review.hunt-b',
      'review.refute',
      'review.merge',
      'review.fix',
      'review.gate',
    ])
    expect(ids.slice(14)).toEqual(['preview', 'intent', 'push', 'pr', 'ci', 'summary', 'handoff'])
  })

  it('has every id once, whatever the preset', () => {
    for (const preset of WORKFLOW_PRESETS) {
      const ids = graphNodes(resolved(preset)).map((n) => n.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it("does not list a group of Maximum's reviews as a node of its own, only its phases", () => {
    const ids = graphNodes(resolved('maximum')).map((n) => n.id)
    expect(ids).not.toContain('review.first')
    expect(ids).toContain('review.first.hunt-security')
    expect(ids).toContain('review.second.merge')
    expect(ids).toContain('review.reconcile')
  })

  it('finds a node, and says nothing of one the workflow does not have', () => {
    const light = resolved('light')
    expect(findNode(light, 'build')?.kind).toBe('step')
    expect(findNode(light, 'review.reviewer')?.kind).toBe('phase')
    expect(findNode(light, 'spec')).toBeNull()
    expect(findNode(light, 'review.hunt-a')).toBeNull()
    expect(findNode(light, null)).toBeNull()
  })

  it('gives a step the name of the one after it, for its hand-off', () => {
    const node = findNode(resolved('standard'), 'claim')
    expect(node?.kind === 'step' && node.next).toBe('Spec')
    const last = findNode(resolved('standard'), 'handoff')
    expect(last?.kind === 'step' && last.next).toBeNull()
  })
})

describe('what a node reads as', () => {
  it('names a step by its number, label and agent, with its state', () => {
    const w = resolved('standard')
    expect(stepView(w.steps.find((s) => s.id === 'build')!).name).toBe('3. Build, agent builder, locked')
    expect(stepView(w.steps.find((s) => s.id === 'claim')!).name).toBe('1. Read and claim, agent you, locked')
    expect(stepView(w.steps.find((s) => s.id === 'spec')!).name).toBe(
      '2. Spec, agent spec, skipped on low tickets',
    )
  })

  it('says a step that does not run, and an off one, and takes its number away', () => {
    const low = resolved('standard', 'low')
    expect(stepView(low.steps.find((s) => s.id === 'spec')!).name).toBe('Spec, agent spec, skipped on low')
    const off = resolved('standard', 'mid', { steps: { preview: { enabled: false } } })
    const view = stepView(off.steps.find((s) => s.id === 'preview')!)
    expect(view.name).toContain('off')
    expect(view.name).toContain('changed')
    expect(view.number).toBeNull()
    expect(view.skipped).toBe('Off')
  })

  it('names the Team agent, and says when a pick is not in the Team', () => {
    const picked = resolved('standard', 'mid', { agents: { build: 'acme-dev' } }, ['acme-dev'])
    expect(stepView(picked.steps.find((s) => s.id === 'build')!).name).toBe(
      '3. Build, agent acme-dev, locked, changed',
    )
    const missing = resolved('standard', 'mid', { agents: { build: 'gone' } }, ['builder'])
    const view = stepView(missing.steps.find((s) => s.id === 'build')!)
    expect(view.name).toBe('3. Build, agent builder, locked, agent missing, changed')
    expect(view.team?.missing).toBe(true)
  })

  it('names a phase by its number and marks a picked one as changed', () => {
    const w = resolved('standard', 'mid', { agents: { 'review.hunt-a': 'sec' } }, ['sec', 'hunt'])
    const hunt = graphNodes(w).find((n) => n.id === 'review.hunt-a')!
    expect(nodeView(hunt).name).toBe('5.4 Hunt A, agent sec, changed')
    const verify = phaseView(graphNodes(w).find((n) => n.id === 'review.verify')!.step as never)
    expect(verify.name).toBe('5.3 Verify, agent verify')
    expect(verify.changed).toBeNull()
  })

  it('has the lock reason of a locked step, and none for a step that can be turned off', () => {
    const w = resolved('standard')
    expect(stepView(w.steps.find((s) => s.id === 'build')!).lockReason).toBe(
      'Locked: nothing is delivered without the change being built.',
    )
    expect(stepView(w.steps.find((s) => s.id === 'preview')!).lock).toBeNull()
  })
})

describe('defaultAgentName', () => {
  it('is the Team agent named like the role, else the role itself', () => {
    expect(defaultAgentName('builder', ['Builder', 'acme'])).toBe('Builder')
    expect(defaultAgentName('builder', ['acme'])).toBe('builder')
    expect(defaultAgentName('you', [])).toBe('you')
  })
})

describe('parallelColumns', () => {
  it('is as many columns as there are phases, from two to four', () => {
    expect([2, 3, 4, 5].map(parallelColumns)).toEqual([2, 3, 4, 4])
  })
})
