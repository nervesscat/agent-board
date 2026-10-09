import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import {
  columnNeighbours,
  mergeAfter,
  newTicketStage,
  placeInColumn,
  positionBy,
  type StageLike,
  stageColumn,
  withPlacement,
} from './stages'

const card = (id: number, status: string, updatedAt: string) => ({ id, status, updatedAt })
const tickets = [
  card(1, 'todo', '2026-10-01T10:00:00Z'),
  card(2, 'in_progress', '2026-10-03T10:00:00Z'),
  card(3, 'todo', '2026-10-04T10:00:00Z'),
  card(4, 'todo', '2026-10-02T10:00:00Z'),
  card(5, 'review', '2026-10-04T11:00:00Z'),
]

describe('stage columns', () => {
  it('hold one stage, last updated first', () => {
    expect(stageColumn(tickets, 'todo').map((t) => t.id)).toEqual([3, 4, 1])
    expect(stageColumn(tickets, 'done')).toEqual([])
  })

  it('keep the given order between tickets updated at the same moment', () => {
    const tied = [card(7, 'todo', '2026-10-01T10:00:00Z'), card(6, 'todo', '2026-10-01T10:00:00Z')]
    expect(stageColumn(tied, 'todo').map((t) => t.id)).toEqual([7, 6])
  })

  it('give the neighbours in the same column', () => {
    const around = columnNeighbours(tickets, 4)!
    expect([around.prev?.id, around.next?.id, around.index, around.count]).toEqual([3, 1, 1, 3])
  })

  it('stop at the ends of the column', () => {
    expect(columnNeighbours(tickets, 3)).toMatchObject({ prev: null, next: { id: 4 }, index: 0 })
    expect(columnNeighbours(tickets, 1)).toMatchObject({ prev: { id: 4 }, next: null, index: 2 })
    expect(columnNeighbours(tickets, 2)).toMatchObject({ prev: null, next: null, index: 0, count: 1 })
  })

  it('follow a ticket into its new stage', () => {
    const moved = tickets.map((t) => (t.id === 4 ? { ...t, status: 'review' } : t))
    expect(columnNeighbours(moved, 4)).toMatchObject({ prev: { id: 5 }, next: null, index: 1, count: 2 })
  })

  it('have nothing for a ticket not in the list', () => {
    expect(columnNeighbours(tickets, 99)).toBeNull()
  })
})

describe('placed tickets', () => {
  const placed = (id: number, rank: number | null, updatedAt: string, status = 'review') => ({
    id,
    status,
    updatedAt,
    rank,
  })
  // Placed: 11 (rank 2), 12 (rank 1). Unplaced: 13 (newest), 14, 15 (oldest).
  const column = [
    placed(13, null, '2026-10-05T10:00:00Z'),
    placed(11, 2, '2026-10-01T10:00:00Z'),
    placed(14, null, '2026-10-04T10:00:00Z'),
    placed(12, 1, '2026-10-02T10:00:00Z'),
    placed(15, null, '2026-10-03T10:00:00Z'),
    placed(16, 1, '2026-10-06T10:00:00Z', 'todo'),
  ]
  const ids = <T extends { id: number }>(list: T[]) => list.map((t) => t.id)

  it('come first in placed order, then the rest last updated first', () => {
    expect(ids(stageColumn(column, 'review'))).toEqual([12, 11, 13, 14, 15])
  })

  it('stay put when edited: a newer update does not move a placed ticket', () => {
    const edited = column.map((t) => (t.id === 11 ? { ...t, updatedAt: '2026-10-09T10:00:00Z' } : t))
    expect(ids(stageColumn(edited, 'review'))).toEqual([12, 11, 13, 14, 15])
  })

  it('give the neighbours in placed order', () => {
    expect(columnNeighbours(column, 11)).toMatchObject({ prev: { id: 12 }, next: { id: 13 }, index: 1 })
    expect(columnNeighbours(column, 12)).toMatchObject({ prev: null, index: 0, count: 5 })
  })

  /** The column after placing `id` at `position`, as it reads back. */
  const after = (items: typeof column, id: number, position: number) =>
    ids(stageColumn(withPlacement(items, id, position), 'review'))

  it('read back with the ticket at the position asked, the others in their order', () => {
    // Among the unplaced ones: those above it get placed with it, those below stay unplaced.
    expect(after(column, 15, 3)).toEqual([12, 11, 15, 13, 14])
    expect(placeInColumn(column, 15, 3)).toEqual([
      { id: 12, rank: 1 },
      { id: 11, rank: 2 },
      { id: 15, rank: 3 },
    ])
    expect(after(column, 14, 5)).toEqual([12, 11, 13, 15, 14])
    expect(after(column, 12, 2)).toEqual([11, 12, 13, 14, 15])
    expect(after(column, 13, 1)).toEqual([13, 12, 11, 14, 15])
    // Past the end: last.
    expect(after(column, 12, 99)).toEqual([11, 13, 14, 15, 12])
    expect(after(column, 12, 5)).toEqual([11, 13, 14, 15, 12])
  })

  it('work the same in a column nobody arranged', () => {
    const fresh = column.map((t) => ({ ...t, rank: null }))
    expect(ids(stageColumn(fresh, 'review'))).toEqual([13, 14, 15, 12, 11])
    expect(after(fresh, 11, 2)).toEqual([13, 11, 14, 15, 12])
    expect(after(fresh, 13, 4)).toEqual([14, 15, 12, 13, 11])
  })

  it('leave other columns alone, and nothing for a ticket not there', () => {
    expect(placeInColumn(column, 16, 1)).toEqual([{ id: 16, rank: 1 }])
    expect(placeInColumn(column, 99, 1)).toEqual([])
  })

  it('find the position right above or below another card, counted without the moved one', () => {
    const order = stageColumn(column, 'review') // 12, 11, 13, 14, 15
    expect(positionBy(order, 15, 12, 'above')).toBe(1)
    expect(positionBy(order, 12, 13, 'below')).toBe(3)
    expect(positionBy(order, 14, 13, 'above')).toBe(3)
    expect(after(column, 12, positionBy(order, 12, 13, 'below')!)).toEqual([11, 13, 12, 14, 15])
    expect(positionBy(order, 12, 99, 'above')).toBeNull()
  })

  it('flag a card placed above a ticket it needs merged first', () => {
    const needing = (id: number, needs: { id: number; merged: boolean }[]) => ({
      ...placed(id, null, '2026-10-01T10:00:00Z'),
      needs,
    })
    const a = needing(1, [{ id: 2, merged: false }])
    const b = needing(2, [])
    expect(mergeAfter([a, b])).toEqual(new Map([[1, [2]]]))
    expect(mergeAfter([b, a])).toEqual(new Map())
    // Once what it needs is merged, the order no longer matters.
    expect(mergeAfter([{ ...a, needs: [{ id: 2, merged: true }] }, b])).toEqual(new Map())
  })
})

describe('the stage a new ticket starts on', () => {
  const stage = (key: string, kind: StageLike['kind']): StageLike => ({ key, name: key, kind, color: 'gray' })

  it('is Backlog in the default layout, not To do', () => {
    expect(newTicketStage(DEFAULT_STAGES)?.key).toBe('backlog')
  })

  it('is the first open stage in board order, whatever it is called', () => {
    const stages = [
      stage('build', 'active'),
      stage('ideas', 'open'),
      stage('spec', 'open'),
      stage('done', 'done'),
    ]
    expect(newTicketStage(stages)?.key).toBe('ideas')
  })

  it('is the first stage when none is open', () => {
    expect(newTicketStage([stage('build', 'active'), stage('done', 'done')])?.key).toBe('build')
  })

  it('is none until the stages have loaded', () => {
    expect(newTicketStage([])).toBeUndefined()
  })
})
