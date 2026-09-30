import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import { effectiveFilter, laneFilter, laneNeighbours, laneSearch, laneStageOrder, sortLanes } from './lanes'

const stages = DEFAULT_STAGES

const lane = (id: number, status: string, tags: string[] = [], verdict?: 'approved' | 'disapproved') => ({
  id,
  status,
  tags,
  approvedAt: verdict === 'approved' ? '2026-09-24T10:00:00Z' : null,
  disapprovedAt: verdict === 'disapproved' ? '2026-09-24T10:00:00Z' : null,
})
const lanes = [
  lane(1, 'todo', ['High']),
  lane(2, 'done', ['Low'], 'approved'),
  lane(3, 'todo', ['Low']),
  lane(4, 'cancelled', ['High'], 'disapproved'),
  lane(5, 'review', ['High']),
  lane(6, 'todo', ['high']),
]

describe('lanes', () => {
  it('sort done first, cancelled last, then by id', () => {
    expect(sortLanes(lanes, stages).map((l) => l.id)).toEqual([2, 5, 1, 3, 6, 4])
  })

  it('order custom stages by kind, later ones first within a kind', () => {
    const custom = [
      { key: 'ideas', kind: 'open' as const },
      { key: 'spec', kind: 'open' as const },
      { key: 'build', kind: 'active' as const },
      { key: 'qa', kind: 'review' as const },
      { key: 'ship', kind: 'done' as const },
    ]
    expect(laneStageOrder(custom).map((s) => s.key)).toEqual(['ship', 'qa', 'build', 'spec', 'ideas'])
    const mine = [lane(1, 'ideas'), lane(2, 'gone'), lane(3, 'qa'), lane(4, 'spec')]
    expect(sortLanes(mine, custom).map((l) => l.id)).toEqual([3, 4, 1, 2])
  })

  it('step through the filtered list in that order', () => {
    const f = laneFilter({ tag: 'HIGH' })
    expect(laneNeighbours(lanes, stages, 1, f)).toMatchObject({ index: 1, count: 4, filtered: true })
    expect(laneNeighbours(lanes, stages, 1, f).prev?.id).toBe(5)
    expect(laneNeighbours(lanes, stages, 1, f).next?.id).toBe(6)
    expect(laneNeighbours(lanes, stages, 5, f).prev).toBeNull()
  })

  it('give a lane the filter hides the shown lanes around its place', () => {
    const f = laneFilter({ stage: 'todo', tag: 'high' })
    // Lane 3 is todo but Low: hidden, between 1 and 6.
    expect(laneNeighbours(lanes, stages, 3, f)).toMatchObject({ index: -1, count: 2 })
    expect(laneNeighbours(lanes, stages, 3, f).prev?.id).toBe(1)
    expect(laneNeighbours(lanes, stages, 3, f).next?.id).toBe(6)
  })

  it('round-trip through the URL, ignoring unknown stages and picks nobody has', () => {
    // Stage keys are the project's own, so the URL keeps them all; one no lane is in stops filtering.
    expect(laneFilter({ stage: 'todo,bogus,review', tag: 'High, Forms' })).toEqual({
      stages: ['todo', 'bogus', 'review'],
      tags: ['high', 'forms'],
      verdicts: [],
    })
    expect(effectiveFilter(lanes, laneFilter({ stage: 'todo,bogus' })).stages).toEqual(['todo'])
    expect(laneSearch({ stages: [], tags: ['high'], verdicts: [] })).toEqual({
      stage: undefined,
      tag: 'high',
      verdict: undefined,
    })
    expect(laneFilter({ verdict: 'none,bogus,approved' }).verdicts).toEqual(['none', 'approved'])
    // "forms" matches no lane, so it does not narrow anything.
    expect(laneNeighbours(lanes, stages, 2, laneFilter({ tag: 'forms' }))).toMatchObject({
      count: 6,
      filtered: false,
    })
  })

  it("filter by the human's call: approved, disapproved or none yet", () => {
    const none = laneFilter({ verdict: 'none' })
    expect(laneNeighbours(lanes, stages, 1, none)).toMatchObject({ count: 4, filtered: true })
    expect(laneNeighbours(lanes, stages, 5, laneFilter({ verdict: 'approved,disapproved' }))).toMatchObject({
      index: -1,
      count: 2,
    })
    // Combined with a tag: High lanes nobody has judged yet are 5, 1 and 6.
    const f = laneFilter({ verdict: 'none', tag: 'high' })
    expect(laneNeighbours(lanes, stages, 1, f)).toMatchObject({ index: 1, count: 3 })
  })
})
