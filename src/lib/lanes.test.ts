import { describe, expect, it } from 'vitest'

import type { TicketStatus } from './constants'
import { laneFilter, laneNeighbours, laneSearch, sortLanes } from './lanes'

const lane = (id: number, status: TicketStatus, tags: string[] = []) => ({ id, status, tags })
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
    expect(sortLanes(lanes).map((l) => l.id)).toEqual([2, 5, 1, 3, 6, 4])
  })

  it('step through the filtered list in that order', () => {
    const f = laneFilter({ tag: 'HIGH' })
    expect(laneNeighbours(lanes, 1, f)).toMatchObject({ index: 1, count: 4, filtered: true })
    expect(laneNeighbours(lanes, 1, f).prev?.id).toBe(5)
    expect(laneNeighbours(lanes, 1, f).next?.id).toBe(6)
    expect(laneNeighbours(lanes, 5, f).prev).toBeNull()
  })

  it('give a lane the filter hides the shown lanes around its place', () => {
    const f = laneFilter({ stage: 'todo', tag: 'high' })
    // Lane 3 is todo but Low: hidden, between 1 and 6.
    expect(laneNeighbours(lanes, 3, f)).toMatchObject({ index: -1, count: 2 })
    expect(laneNeighbours(lanes, 3, f).prev?.id).toBe(1)
    expect(laneNeighbours(lanes, 3, f).next?.id).toBe(6)
  })

  it('round-trip through the URL, ignoring unknown stages and picks nobody has', () => {
    expect(laneFilter({ stage: 'todo,bogus,review', tag: 'High, Forms' })).toEqual({
      stages: ['todo', 'review'],
      tags: ['high', 'forms'],
    })
    expect(laneSearch({ stages: [], tags: ['high'] })).toEqual({ stage: undefined, tag: 'high' })
    // "forms" matches no lane, so it does not narrow anything.
    expect(laneNeighbours(lanes, 2, laneFilter({ tag: 'forms' }))).toMatchObject({
      count: 6,
      filtered: false,
    })
  })
})
