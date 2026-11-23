import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import {
  effectiveFilter,
  laneFilter,
  NO_FILTER,
  laneNeighbours,
  laneSearch,
  laneStageOrder,
  sortLanes,
  validateLaneSearch,
} from './lanes'

const stages = DEFAULT_STAGES

const lane = (id: number, status: string, tags: string[] = []) => ({ id, status, tags })
const lanes = [
  lane(1, 'todo', ['High']),
  lane(2, 'done', ['Low']),
  lane(3, 'todo', ['Low']),
  lane(4, 'cancelled', ['High']),
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
    })
    expect(effectiveFilter(lanes, laneFilter({ stage: 'todo,bogus' })).stages).toEqual(['todo'])
    expect(laneSearch({ stages: [], tags: ['high'] })).toEqual({
      stage: undefined,
      tag: 'high',
    })
    // "forms" matches no lane, so it does not narrow anything.
    expect(laneNeighbours(lanes, stages, 2, laneFilter({ tag: 'forms' }))).toMatchObject({
      count: 6,
      filtered: false,
    })
  })

  it('ignore a verdict in the URL', () => {
    // Old links may still carry ?verdict=: it filters nothing and adds nothing back to the URL.
    const old = validateLaneSearch({ verdict: 'approved', stage: 'todo' })
    expect(old).toEqual({ stage: 'todo', tag: undefined })
    expect(laneFilter(old)).toEqual({ stages: ['todo'], tags: [] })
    expect(laneFilter(validateLaneSearch({ verdict: 'approved' }))).toEqual(NO_FILTER)
    expect(laneSearch(laneFilter(old))).toEqual({ stage: 'todo', tag: undefined })
    const none = laneFilter(validateLaneSearch({ verdict: 'none' }))
    expect(laneNeighbours(lanes, stages, 1, none)).toMatchObject({ count: 6, filtered: false })
  })
})
