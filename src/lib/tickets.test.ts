import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { type TicketsScope, ticketsKey, ticketsUrl } from './tickets'

const scopes: TicketsScope[] = ['root', 'archived', 'all']

describe('ticket list keys', () => {
  it('give each list its own key and URL', () => {
    expect(scopes.map((s) => ticketsKey('3', s))).toEqual([
      ['tickets', '3', 'root'],
      ['tickets', '3', 'archived'],
      ['tickets', '3', 'all'],
    ])
    expect(scopes.map((s) => ticketsUrl('3', s))).toEqual([
      '/api/projects/3/tickets?parent=root',
      '/api/projects/3/tickets?parent=root&archived=only',
      '/api/projects/3/tickets',
    ])
  })

  it('name the project the same whether its id is a string or a number', () => {
    expect(ticketsKey(3)).toEqual(ticketsKey('3'))
    expect(ticketsKey(3, 'all')).toEqual(ticketsKey('3', 'all'))
  })

  it('keep the lists apart in the cache', () => {
    const qc = new QueryClient()
    qc.setQueryData(ticketsKey('3', 'all'), [{ id: 1 }, { id: 2, parentId: 1 }])
    expect(qc.getQueryData(ticketsKey('3', 'root'))).toBeUndefined()
    qc.setQueryData(ticketsKey('3', 'root'), [{ id: 1 }])
    expect(qc.getQueryData(ticketsKey('3', 'all'))).toHaveLength(2)
  })

  it('refresh every list of the project, and only that project, from the prefix', async () => {
    const qc = new QueryClient()
    for (const s of scopes) {
      qc.setQueryData(ticketsKey('3', s), [])
      qc.setQueryData(ticketsKey('4', s), [])
    }
    await qc.invalidateQueries({ queryKey: ticketsKey('3') })
    for (const s of scopes) {
      expect(qc.getQueryState(ticketsKey('3', s))?.isInvalidated).toBe(true)
      expect(qc.getQueryState(ticketsKey('4', s))?.isInvalidated).toBe(false)
    }
  })
})
