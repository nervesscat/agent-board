import { describe, expect, it } from 'vitest'

import { type PaletteItem, groupItems, normalizeQuery, rankItems, scoreItem } from '#/lib/commandPalette'

const ticket = (id: number, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  key: `ticket:${id}`,
  kind: 'ticket',
  title,
  ticketId: id,
  ...extra,
})

const page = (title: string, keywords: string[] = []): PaletteItem => ({
  key: `page:${title}`,
  kind: 'page',
  title,
  keywords,
})

describe('a ticket number', () => {
  it('finds its ticket before a title that only reads like the number', () => {
    const rows = rankItems(
      [ticket(7, 'The 12-column grid'), ticket(12, 'Refactor the search'), ticket(99, 'Unrelated')],
      '#12',
    )
    expect(rows.map((r) => r.ticketId)).toEqual([12, 7])
  })

  it('works with and without the hash, and case does not matter', () => {
    for (const q of ['12', '#12', ' #12 ']) {
      expect(scoreItem(ticket(12, 'Refactor the search'), q)).toBeGreaterThan(
        scoreItem(ticket(7, 'The 12-column grid'), q)!,
      )
    }
    expect(rankItems([page('Overview')], '#12')).toEqual([])
  })

  it('a prefix of an id comes next, then its digits anywhere', () => {
    const exact = scoreItem(ticket(12, 'x'), '12')!
    const prefix = scoreItem(ticket(123, 'x'), '12')!
    const includes = scoreItem(ticket(312, 'x'), '12')!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(includes)
  })

  it('keeps the words after a number as a title match', () => {
    expect(scoreItem(ticket(12, 'Refactor the search'), '#12 search')).not.toBeNull()
    expect(scoreItem(ticket(12, 'Refactor the search'), '#12 deploy')).toBeNull()
  })
})

describe('text matching', () => {
  it('is case-insensitive and ranks a prefix over a word start over a substring', () => {
    const rows = rankItems(
      [page('Set up the board'), page('Board settings'), page('Project board overview'), page('Unrelated')],
      'board',
    )
    expect(rows.map((r) => r.title)).toEqual(['Board settings', 'Project board overview', 'Set up the board'])
  })

  it('is fuzzy: letters in order, with gaps, still match', () => {
    expect(scoreItem(page('Command palette'), 'cmdpal')).not.toBeNull()
    expect(scoreItem(page('Command palette'), 'palcmd')).toBeNull()
  })

  it('looks at keywords and the second line too', () => {
    const item: PaletteItem = {
      key: 'setting:stages',
      kind: 'setting',
      title: 'Stages',
      subtitle: 'The board columns',
      keywords: ['workflow', 'columns'],
    }
    expect(rankItems([item], 'workflow')).toEqual([item])
    expect(rankItems([item], 'columns')).toEqual([item])
  })
})

describe('grouping and ordering', () => {
  it('keeps kind order and counts each group', () => {
    const items = [
      page('Board'),
      ticket(12, 'Refactor the search'),
      { key: 'action:new', kind: 'action', title: 'New ticket' } as PaletteItem,
      page('Daily'),
      { key: 'setting:stages', kind: 'setting', title: 'Stages' } as PaletteItem,
    ]
    const groups = groupItems(rankItems(items, ''))
    expect(groups.map((g) => [g.kind, g.items.length])).toEqual([
      ['ticket', 1],
      ['page', 2],
      ['setting', 1],
      ['action', 1],
    ])
    // No empty group is drawn.
    expect(groupItems(rankItems([page('Board')], '')).map((g) => g.kind)).toEqual(['page'])
  })

  it('an empty query keeps every item, grouped, without filtering', () => {
    const items = [page('Board'), ticket(2, 'A ticket'), page('Daily')]
    expect(rankItems(items, '   ')).toHaveLength(3)
    expect(normalizeQuery('  Daily   Board ')).toBe('daily board')
  })

  it('the group whose best item matches best comes first', () => {
    const items = [
      page('Board', ['stages']),
      { key: 'setting:stages', kind: 'setting', title: 'Stages' } as PaletteItem,
    ]
    const groups = groupItems(rankItems(items, 'stages'))
    expect(groups.map((g) => g.kind)).toEqual(['setting', 'page'])
    expect(groups[0]!.items[0]!.title).toBe('Stages')
  })

  it('drops what does not match', () => {
    expect(rankItems([page('Board'), page('Daily')], 'zzz')).toEqual([])
  })
})
