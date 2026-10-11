import { describe, expect, it } from 'vitest'

import { DEFAULT_STAGES } from './constants'
import { columnNeighbours, newTicketStage, type StageLike, type StepList, stageColumn } from './stages'

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

  it('start from the column a ticket is in now, without a list carried here', () => {
    const moved = tickets.map((t) => (t.id === 4 ? { ...t, status: 'review' } : t))
    expect(columnNeighbours(moved, 4)).toMatchObject({ prev: { id: 5 }, next: null, index: 1, count: 2 })
    expect(columnNeighbours(moved, 4)?.list).toEqual({ stage: 'review', ids: [5, 4] })
  })

  it('have nothing for a ticket not in the list', () => {
    expect(columnNeighbours(tickets, 99)).toBeNull()
  })
})

describe('a list carried from step to step', () => {
  // A, B, C in progress, in that order in the column (last updated first); D, E elsewhere.
  const [A, B, C, D, E] = [1, 2, 3, 4, 5]
  const board = [
    card(A, 'in_progress', '2026-10-05T10:00:00Z'),
    card(B, 'in_progress', '2026-10-04T10:00:00Z'),
    card(C, 'in_progress', '2026-10-03T10:00:00Z'),
    card(D, 'todo', '2026-10-02T10:00:00Z'),
    card(E, 'review', '2026-10-01T10:00:00Z'),
  ]
  const carried: StepList = { stage: 'in_progress', ids: [A, B, C] }
  const move = (items: typeof board, id: number, status: string, updatedAt = '2026-10-06T10:00:00Z') =>
    items.map((t) => (t.id === id ? { ...t, status, updatedAt } : t))
  const ids = (around: ReturnType<typeof columnNeighbours>) => around?.list.ids

  it('is the column itself while nothing has moved', () => {
    expect(columnNeighbours(board, B, carried)).toMatchObject({
      prev: { id: A },
      next: { id: C },
      index: 1,
      count: 3,
      list: carried,
    })
  })

  it('keeps a ticket that moved to another stage at its place, after the one before it', () => {
    const moved = move(board, B, 'review')
    expect(columnNeighbours(moved, B, carried)).toMatchObject({
      prev: { id: A },
      next: { id: C },
      index: 1,
      count: 3,
      list: carried,
    })
    // From its neighbours too: back from C is the moved B.
    expect(columnNeighbours(moved, C, carried)).toMatchObject({ prev: { id: B }, index: 2, count: 3 })
    expect(columnNeighbours(moved, A, carried)).toMatchObject({ next: { id: B }, index: 0 })
  })

  it('keeps a moved ticket that was first at the start, and moved tickets in a row in their order', () => {
    expect(ids(columnNeighbours(move(board, A, 'done'), B, carried))).toEqual([A, B, C])
    const both = move(move(board, A, 'done'), B, 'review')
    expect(ids(columnNeighbours(both, C, carried))).toEqual([A, B, C])
    expect(columnNeighbours(both, C, carried)).toMatchObject({ prev: { id: B }, index: 2, count: 3 })
  })

  it('keeps any ticket of the list that moved, not only the one shown', () => {
    const moved = move(board, C, 'done')
    expect(columnNeighbours(moved, B, carried)).toMatchObject({ next: { id: C }, index: 1, count: 3 })
  })

  it("follows the column's order for the tickets still in its stage", () => {
    // C updated last: the column now starts with it, and the list follows.
    const reordered = board.map((t) => (t.id === C ? { ...t, updatedAt: '2026-10-06T10:00:00Z' } : t))
    expect(ids(columnNeighbours(reordered, B, carried))).toEqual([C, A, B])
    // A moved one stays after the ticket before it, wherever the column puts that one.
    expect(ids(columnNeighbours(move(reordered, B, 'review'), A, carried))).toEqual([C, A, B])
  })

  it('takes in a ticket that came into the stage, where the column puts it', () => {
    const came = move(board, D, 'in_progress')
    expect(columnNeighbours(came, B, carried)).toMatchObject({
      index: 2,
      count: 4,
      list: { ids: [D, A, B, C] },
    })
    expect(ids(columnNeighbours(move(came, B, 'review'), B, carried))).toEqual([D, A, B, C])
  })

  it('drops a ticket no longer on the board, but not the one shown', () => {
    const gone = board.filter((t) => t.id !== C)
    expect(columnNeighbours(gone, A, carried)).toMatchObject({ count: 2, list: { ids: [A, B] } })
    expect(columnNeighbours(gone, B, carried)).toMatchObject({ next: null, index: 1, count: 2 })
    // The page shown puts its own ticket in the rows, as it has it (archived, say, and in done).
    const shown = [...gone, card(C, 'done', '2026-10-06T10:00:00Z')]
    expect(columnNeighbours(shown, C, carried)).toMatchObject({ prev: { id: B }, index: 2, count: 3 })
  })

  it("is not a ticket's when it does not hold it: then its own column", () => {
    expect(columnNeighbours(board, E, carried)).toMatchObject({
      prev: null,
      next: null,
      count: 1,
      list: { stage: 'review', ids: [E] },
    })
  })

  it("names the list's stage, carried on unchanged from step to step", () => {
    const moved = move(board, B, 'review')
    const onB = columnNeighbours(moved, B, carried)!
    expect(onB.list.stage).toBe('in_progress')
    const onC = columnNeighbours(moved, C, onB.list)!
    expect(onC.list).toEqual(onB.list)
    expect(columnNeighbours(moved, B, onC.list)!.list).toEqual(onB.list)
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
