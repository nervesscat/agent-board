import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import type { TicketRow } from '#/lib/api'
import { type TicketsScope, keepSearchRows, nameFirst, ticketsKey, ticketsQuery, ticketsUrl } from './tickets'

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

  it('give a search its own key under its list, and the query in the URL', async () => {
    expect(ticketsKey('3', 'archived', 'a&b')).toEqual(['tickets', '3', 'archived', 'a&b'])
    expect(ticketsUrl('3', 'archived', 'a&b #1')).toBe(
      '/api/projects/3/tickets?parent=root&archived=only&q=a%26b%20%231',
    )
    expect(ticketsUrl('3', 'all', '%')).toBe('/api/projects/3/tickets?q=%25')
    expect(ticketsQuery('3', 'root', '').queryKey).toEqual(ticketsKey('3', 'root'))
    const qc = new QueryClient()
    qc.setQueryData(ticketsKey('3', 'root', 'x'), [])
    await qc.invalidateQueries({ queryKey: ticketsKey('3') })
    expect(qc.getQueryState(ticketsKey('3', 'root', 'x'))?.isInvalidated).toBe(true)
  })

  it('order a search by name matches first', () => {
    const rows: Pick<TicketRow, 'match'>[] = ['post', 'title', 'reply', 'id', 'body'].map((match) => ({
      match: match as TicketRow['match'],
    }))
    expect(rows.sort((a, b) => nameFirst(a) - nameFirst(b)).map((r) => r.match)).toEqual([
      'title',
      'id',
      'post',
      'reply',
      'body',
    ])
  })

  it("keep the last search's rows only for a search of the same list of the same project that found some", () => {
    const rows = [{ id: 1 }] as TicketRow[]
    const after = (queryKey: readonly unknown[], last = rows) =>
      keepSearchRows('3', 'root')(last, { queryKey })
    expect(after(ticketsKey('3', 'root', 'kiwi'))).toBe(rows)
    expect(keepSearchRows(3, 'root')(rows, { queryKey: ticketsKey('3', 'root', 'kiwi') })).toBe(rows)
    // Nothing found: no rows to keep, and no "no match" for a query not answered yet.
    expect(after(ticketsKey('3', 'root', 'zzqq'), [])).toBeUndefined()
    // The unsearched list is not a search.
    expect(after(ticketsKey('3', 'root'))).toBeUndefined()
    // Another list, another project.
    expect(after(ticketsKey('3', 'archived', 'kiwi'))).toBeUndefined()
    expect(after(ticketsKey('4', 'root', 'kiwi'))).toBeUndefined()
    expect(after(ticketsKey('31', 'root', 'kiwi'))).toBeUndefined()
    expect(keepSearchRows('3', 'root')(undefined, undefined)).toBeUndefined()
  })

  it("show no other project's search while a project's loads, though the page stays the same", () => {
    const qc = new QueryClient()
    const search = (projectId: string, q: string) => ({
      ...ticketsQuery(projectId, 'root', q),
      queryFn: () => new Promise<TicketRow[]>(() => {}),
      placeholderData: keepSearchRows(projectId, 'root'),
    })
    qc.setQueryData(ticketsKey('2', 'root', 'orchid'), [{ id: 20 }])
    const found = new QueryObserver<TicketRow[]>(qc, search('2', 'orchid'))
    const stop = found.subscribe(() => {})
    expect(found.getCurrentResult().data).toEqual([{ id: 20 }])
    // Project 1's search while project 2's was the last: no rows until it answers.
    found.setOptions(search('1', 'orchid'))
    expect(found.getCurrentResult()).toMatchObject({ data: undefined, isPlaceholderData: false })
    // In project 2 again, the next search keeps the last one's rows.
    qc.setQueryData(ticketsKey('2', 'root', 'orch'), [{ id: 21 }])
    found.setOptions(search('2', 'orch'))
    found.setOptions(search('2', 'orchids'))
    expect(found.getCurrentResult()).toMatchObject({ data: [{ id: 21 }], isPlaceholderData: true })
    stop()
  })
})
