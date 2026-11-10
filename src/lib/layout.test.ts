import { describe, expect, it } from 'vitest'

import {
  LAYOUT_AREAS,
  LAYOUT_ELEMENTS,
  type Layout,
  type SavedLayout,
  allowedAreas,
  defaultLayout,
  inArea,
  mergeLayout,
  moveInLayout,
  sameLayout,
  shownIn,
} from './layout'

const ids = (layout: Layout) => layout.map((it) => it.id)
/** The default layout without some elements: as saved before they were added. */
const without = (...gone: string[]): SavedLayout => defaultLayout().filter((it) => !gone.includes(it.id))

describe('the catalogue', () => {
  it('has each id once, in an area of its own kind, with a label', () => {
    const all = LAYOUT_ELEMENTS.map((e) => e.id)
    expect(new Set(all).size).toBe(all.length)
    for (const e of LAYOUT_ELEMENTS) {
      expect(e.id.startsWith(e.area.split('.')[0]!)).toBe(true)
      expect(e.label).not.toBe('')
    }
  })

  it('lets ticket sections go in either column, and nothing else move area', () => {
    expect(allowedAreas('ticket.lanes')).toEqual(['ticket.main', 'ticket.side'])
    expect(allowedAreas('ticket.details')).toEqual(['ticket.main', 'ticket.side'])
    expect(allowedAreas('nav.gallery')).toEqual(['nav'])
    expect(allowedAreas('overview.next')).toEqual(['overview'])
  })

  it('locks the landing page, the board, the settings page and the deep-link targets of a ticket', () => {
    const locked = LAYOUT_ELEMENTS.filter((e) => 'locked' in e).map((e) => e.id)
    expect(locked).toEqual([
      'nav.overview',
      'nav.features',
      'nav.settings',
      'ticket.instructions',
      'ticket.tasks',
      'ticket.activity',
    ])
  })
})

describe('mergeLayout', () => {
  it('gives the defaults for no saved layout', () => {
    expect(mergeLayout(null)).toEqual(defaultLayout())
    expect(mergeLayout(undefined)).toEqual(defaultLayout())
    expect(mergeLayout([])).toEqual(defaultLayout())
    expect(defaultLayout().every((it) => !it.hidden)).toBe(true)
    expect(ids(defaultLayout())).toEqual(LAYOUT_ELEMENTS.map((e) => e.id))
  })

  it('keeps the saved order and visibility of every known element', () => {
    const saved = defaultLayout()
    const nav = inArea(saved, 'nav').reverse()
    nav.find((it) => it.id === 'nav.gallery')!.hidden = true
    const side = inArea(saved, 'ticket.side')
    const main = inArea(saved, 'ticket.main')
    // Details moved to the top of the main column, Lanes hidden.
    const details = side.splice(
      side.findIndex((it) => it.id === 'ticket.details'),
      1,
    )[0]!
    main.unshift({ ...details, area: 'ticket.main' })
    main.find((it) => it.id === 'ticket.lanes')!.hidden = true
    const layout: Layout = [...nav, ...inArea(saved, 'overview').reverse(), ...main, ...side]

    const merged = mergeLayout(layout)
    expect(merged).toEqual(layout)
    expect(shownIn(merged, 'nav')).not.toContain('nav.gallery')
    expect(shownIn(merged, 'nav')[0]).toBe('nav.settings')
    expect(shownIn(merged, 'overview')[0]).toBe('overview.carryingOver')
    expect(shownIn(merged, 'ticket.main')).toEqual([
      'ticket.details',
      'ticket.instructions',
      'ticket.tasks',
      'ticket.timeline',
      'ticket.activity',
    ])
  })

  it('puts an element the saved layout lacks after the one before it in the default order, shown', () => {
    // Saved before Roadmap existed, with Gallery moved first and hidden.
    const saved = [
      { id: 'nav.gallery', area: 'nav', hidden: true },
      ...without('nav.roadmap', 'nav.gallery').filter((it) => it.area === 'nav'),
    ]
    const nav = inArea(mergeLayout(saved), 'nav')
    expect(ids(nav)).toEqual([
      'nav.gallery',
      'nav.overview',
      'nav.prs',
      'nav.features',
      'nav.roadmap',
      'nav.previews',
      'nav.agents',
      'nav.daily',
      'nav.cleanup',
      'nav.repositories',
      'nav.instructions',
      'nav.settings',
    ])
    expect(nav.find((it) => it.id === 'nav.roadmap')!.hidden).toBe(false)
    // The other areas, absent from what was saved, are the defaults.
    expect(inArea(mergeLayout(saved), 'overview')).toEqual(inArea(defaultLayout(), 'overview'))
  })

  it('shows Repositories in a menu saved before it was in the menu, after Cleanup', () => {
    // Saved before the Repositories page moved into the project's menu: Settings first, Daily hidden.
    const saved: SavedLayout = [
      { id: 'nav.settings', area: 'nav' },
      { id: 'nav.overview', area: 'nav' },
      { id: 'nav.prs', area: 'nav' },
      { id: 'nav.features', area: 'nav' },
      { id: 'nav.roadmap', area: 'nav' },
      { id: 'nav.previews', area: 'nav' },
      { id: 'nav.gallery', area: 'nav' },
      { id: 'nav.agents', area: 'nav' },
      { id: 'nav.daily', area: 'nav', hidden: true },
      { id: 'nav.cleanup', area: 'nav' },
    ]
    const merged = mergeLayout(saved)
    expect(shownIn(merged, 'nav')).toEqual([
      'nav.settings',
      'nav.overview',
      'nav.prs',
      'nav.features',
      'nav.roadmap',
      'nav.previews',
      'nav.gallery',
      'nav.agents',
      'nav.cleanup',
      'nav.repositories',
      'nav.instructions',
    ])
    expect(merged.find((it) => it.id === 'nav.repositories')).toEqual({
      id: 'nav.repositories',
      area: 'nav',
      hidden: false,
    })
  })

  it('adds Instructions to a menu saved before the split, before Settings', () => {
    // Every layout saved before the Instructions module existed: Settings is there, Instructions is not.
    const merged = mergeLayout(without('nav.instructions'))
    expect(merged).toEqual(defaultLayout())
    const nav = shownIn(merged, 'nav')
    expect(nav.slice(-2)).toEqual(['nav.instructions', 'nav.settings'])
    expect(inArea(merged, 'nav').find((it) => it.id === 'nav.instructions')!.hidden).toBe(false)
  })

  it('puts a missing element first in its area when nothing before it in the default order is there', () => {
    const saved = without('nav.overview').filter((it) => it.area === 'nav')
    expect(ids(inArea(mergeLayout(saved), 'nav'))[0]).toBe('nav.overview')
    // Needs you comes first by default: missing, it goes first however the rest is ordered.
    const overview = [...inArea(defaultLayout(), 'overview')]
      .reverse()
      .filter((it) => it.id !== 'overview.needsYou')
    expect(ids(inArea(mergeLayout(overview), 'overview'))).toEqual([
      'overview.needsYou',
      'overview.carryingOver',
      'overview.next',
      'overview.doneToday',
      'overview.inProgress',
    ])
  })

  it('skips an element before it that was moved to the other column when placing a missing one', () => {
    // Lanes moved to the side; Activity (after Lanes by default) missing: it goes after Tasks.
    const saved = defaultLayout()
      .filter((it) => it.id !== 'ticket.activity')
      .map((it) => (it.id === 'ticket.lanes' ? { ...it, area: 'ticket.side' as const } : it))
    const merged = mergeLayout(saved)
    expect(ids(inArea(merged, 'ticket.main'))).toEqual([
      'ticket.instructions',
      'ticket.tasks',
      'ticket.timeline',
      'ticket.activity',
    ])
    expect(ids(inArea(merged, 'ticket.side'))).toContain('ticket.lanes')
  })

  it('places several missing elements in their default order', () => {
    const saved = without('ticket.details', 'ticket.branch', 'ticket.workspaces')
    expect(mergeLayout(saved)).toEqual(defaultLayout())
  })

  it('drops ids the catalogue does not have', () => {
    const saved = [{ id: 'nav.gone', area: 'nav', hidden: true }, ...defaultLayout()]
    expect(mergeLayout(saved)).toEqual(defaultLayout())
  })

  it('keeps the first of a repeated id', () => {
    const saved = [
      { id: 'nav.daily', area: 'nav', hidden: true },
      ...defaultLayout(),
      { id: 'nav.daily', area: 'nav', hidden: false },
    ]
    const nav = inArea(mergeLayout(saved), 'nav')
    expect(nav.filter((it) => it.id === 'nav.daily')).toEqual([
      { id: 'nav.daily', area: 'nav', hidden: true },
    ])
    expect(nav[0]!.id).toBe('nav.daily')
    expect(mergeLayout(saved)).toHaveLength(LAYOUT_ELEMENTS.length)
  })

  it('returns an element saved in an area it may not go in to its default one', () => {
    const saved = defaultLayout().map((it) =>
      it.id === 'nav.gallery'
        ? { ...it, area: 'overview' }
        : it.id === 'ticket.tasks'
          ? { ...it, area: 'nowhere' }
          : it.id === 'overview.next'
            ? { ...it, area: 'ticket.side' }
            : it,
    )
    const merged = mergeLayout(saved)
    expect(merged).toEqual(defaultLayout())
    for (const it of merged) expect(allowedAreas(it.id)).toContain(it.area)
  })

  it('shows a locked element saved as hidden', () => {
    const saved = defaultLayout().map((it) => ({ ...it, hidden: true }))
    const merged = mergeLayout(saved)
    const shown = merged.filter((it) => !it.hidden).map((it) => it.id)
    expect(shown).toEqual(LAYOUT_ELEMENTS.filter((e) => 'locked' in e).map((e) => e.id))
  })

  it('lists the areas in order, whatever order they were saved in', () => {
    const saved = [...defaultLayout()].reverse()
    expect(mergeLayout(saved).map((it) => it.area)).toEqual(
      LAYOUT_AREAS.flatMap((a) => inArea(defaultLayout(), a).map(() => a)),
    )
  })
})

describe('moveInLayout', () => {
  it('moves an element within its area, counting the drop point as the list stands', () => {
    const moved = moveInLayout(defaultLayout(), 'nav.gallery', 'nav', 0)
    expect(shownIn(moved, 'nav').slice(0, 2)).toEqual(['nav.gallery', 'nav.overview'])
    // Down past the next one: the drop point is after it.
    const down = moveInLayout(defaultLayout(), 'nav.overview', 'nav', 2)
    expect(shownIn(down, 'nav').slice(0, 3)).toEqual(['nav.prs', 'nav.overview', 'nav.features'])
    // To the end.
    const end = moveInLayout(defaultLayout(), 'nav.overview', 'nav', inArea(defaultLayout(), 'nav').length)
    expect(shownIn(end, 'nav').at(-1)).toBe('nav.overview')
  })

  it('moves a ticket section to the other column, keeping it hidden or shown', () => {
    const hidden = defaultLayout().map((it) => (it.id === 'ticket.details' ? { ...it, hidden: true } : it))
    const moved = moveInLayout(hidden, 'ticket.details', 'ticket.main', 1)
    expect(ids(inArea(moved, 'ticket.main')).slice(0, 2)).toEqual(['ticket.instructions', 'ticket.details'])
    expect(ids(inArea(moved, 'ticket.side'))).not.toContain('ticket.details')
    expect(moved.find((it) => it.id === 'ticket.details')!.hidden).toBe(true)
    expect(mergeLayout(moved)).toEqual(moved)
  })

  it('leaves the layout as it is for an area the element may not go in', () => {
    const layout = defaultLayout()
    expect(moveInLayout(layout, 'nav.gallery', 'overview', 0)).toBe(layout)
  })
})

describe('sameLayout', () => {
  it('tells a change of order, area or visibility', () => {
    expect(sameLayout(defaultLayout(), defaultLayout())).toBe(true)
    expect(sameLayout(defaultLayout(), moveInLayout(defaultLayout(), 'nav.gallery', 'nav', 0))).toBe(false)
    const hidden = defaultLayout().map((it) => (it.id === 'nav.daily' ? { ...it, hidden: true } : it))
    expect(sameLayout(defaultLayout(), hidden)).toBe(false)
  })
})
