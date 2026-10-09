import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import { columnNeighbours, newTicketStage, type StageLike, stageColumn } from './stages'

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
